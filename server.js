const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  console.error('Set JWT_SECRET to a strong random value of at least 32 characters.');
  process.exit(1);
}
const SECRET = process.env.JWT_SECRET || 'dev-only-secret-do-not-use-in-production';
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'));
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = require('./db');
const { STATUSES, PRIORITIES, TRANSITIONS, canTransition, suggest, similarity } = require('./lib');

// ---------- helpers ----------
const fmtDate = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const now = () => fmtDate(Date.now());
const get = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const CLOSED = "('Resolved','Rejected')";

function dueFor(priority, fromStr) {
  const row = get('SELECT hours FROM sla_policies WHERE priority=?', priority);
  return fmtDate(new Date(fromStr.replace(' ', 'T') + 'Z').getTime() + (row ? row.hours : 72) * 3600e3);
}
function notify(userId, message, issueId) {
  if (userId) run('INSERT INTO notifications(user_id,message,issue_id) VALUES(?,?,?)', userId, message, issueId || null);
}
const audit = (userId, action, detail) => run('INSERT INTO audit_logs(user_id,action,detail) VALUES(?,?,?)', userId, action, detail || null);

// Small per-process fixed-window limiter for this single-instance project.
// Render's proxy IP is trusted one hop below; use a shared limiter if scaling to multiple instances.
const hits = new Map();
let lastRateLimitSweep = 0;
const limit = (max, ms = 60000) => (req, res, next) => {
  const routePath = req.route?.path || req.path;
  const key = `${req.ip}:${req.baseUrl}${routePath}`;
  const t = Date.now();
  let bucket = hits.get(key);
  if (!bucket || bucket.resetAt <= t) bucket = { count: 0, resetAt: t + ms };
  if (bucket.count >= max) {
    res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - t) / 1000))));
    return bad(res, 'Too many requests, please slow down', 429);
  }
  bucket.count += 1;
  hits.set(key, bucket);
  // Prevent unbounded growth from unique IP/path combinations.
  if (hits.size > 5000 && t - lastRateLimitSweep > 30000) {
    lastRateLimitSweep = t;
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
  }
  next();
};

const ISSUE_SQL = `SELECT i.*, c.name AS category, c.department_id AS department_id, d.name AS department,
  l.name AS location, l.lat AS loc_lat, l.lng AS loc_lng, u.name AS reporter_name, s.name AS assignee_name,
  (SELECT COUNT(*) FROM votes v WHERE v.issue_id=i.id) AS votes
  FROM issues i JOIN users u ON u.id=i.user_id
  LEFT JOIN categories c ON c.id=i.category_id LEFT JOIN departments d ON d.id=c.department_id
  LEFT JOIN locations l ON l.id=i.location_id LEFT JOIN users s ON s.id=i.assigned_to`;

// What a given viewer is allowed to see. Anonymous reporters are hidden from everyone but themselves.
function shape(i, viewer) {
  const mine = i.user_id === viewer.id;
  const o = { ...i, mine, reporter: i.anonymous && !mine ? 'Anonymous' : i.reporter_name,
    voted: !!get('SELECT 1 FROM votes WHERE issue_id=? AND user_id=?', i.id, viewer.id),
    overdue: !!i.due_at && !['Resolved', 'Rejected'].includes(i.status) && i.due_at < now() };
  if (o.lat == null) { o.lat = i.loc_lat; o.lng = i.loc_lng; }
  if (i.anonymous && !mine) { o.lat = i.loc_lat; o.lng = i.loc_lng; } // building-level only
  delete o.user_id; delete o.reporter_name; delete o.loc_lat; delete o.loc_lng;
  return o;
}

// ---------- auth ----------
const tokenFor = u => jwt.sign({ id: u.id, ver: u.auth_version }, SECRET, { expiresIn: '7d' });
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, department_id: u.department_id });
const auth = (req, res, next) => {
  try {
    const p = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET);
    const account = get('SELECT id,name,email,role,department_id,is_active,auth_version FROM users WHERE id=? AND is_active=1', p.id);
    // Versioned tokens allow account deactivation/password reset to revoke earlier sessions.
    req.user = account && Number.isInteger(p.ver) && p.ver === account.auth_version ? account : null;
  } catch { req.user = null; }
  req.user ? next() : bad(res, 'Please log in again', 401);
};
const roles = (...r) => (req, res, next) => r.includes(req.user.role) ? next() : bad(res, 'Not allowed', 403);

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, f, cb) => {
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[f.mimetype];
      cb(null, crypto.randomUUID() + ext);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, f, cb) => {
    if (!/^image\/(jpeg|png|webp)$/.test(f.mimetype)) return cb(new Error('Photo must be JPG, PNG, or WebP.'));
    cb(null, true);
  }
});

const app = express();
app.disable('x-powered-by');
// The app is normally behind Render's HTTPS proxy; trust only the immediate proxy hop.
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self)',
    'Cross-Origin-Opener-Policy': 'same-origin'
  });
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Photos are only served to authenticated users, because issue images may contain sensitive context.
app.get('/uploads/:filename', auth, (req, res) => {
  const filename = String(req.params.filename || '');
  if (!/^[0-9a-f-]{36}\.(?:jpg|png|webp)$/i.test(filename)) return bad(res, 'Photo not found', 404);
  const fullPath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(fullPath)) return bad(res, 'Photo not found', 404);
  res.set('Cache-Control', 'private, no-store');
  res.sendFile(fullPath, err => {
    if (err && !res.headersSent) res.status(err.statusCode || 404).end();
  });
});

app.post('/api/signup', limit(10), (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!name || name.length > 80 || !/^\S+@\S+\.\S+$/.test(email) || email.length > 254 || password.length < 8 || password.length > 128)
    return bad(res, 'Enter a name (up to 80 characters), a valid email, and a password of 8-128 characters');
  try {
    const r = run('INSERT INTO users(name,email,password) VALUES(?,?,?)', name, email, bcrypt.hashSync(password, 12));
    const u = get('SELECT * FROM users WHERE id=?', Number(r.lastInsertRowid));
    res.status(201).json({ token: tokenFor(u), user: publicUser(u) });
  } catch { bad(res, 'Email already registered'); }
});

app.post('/api/login', limit(10), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const u = get('SELECT * FROM users WHERE email=? AND is_active=1', email);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password)) return bad(res, 'Invalid email or password', 401);
  res.json({ token: tokenFor(u), user: publicUser(u) });
});

app.get('/api/meta', auth, (req, res) => res.json({
  departments: all('SELECT * FROM departments ORDER BY name'),
  categories: all('SELECT * FROM categories ORDER BY name'),
  locations: all('SELECT * FROM locations ORDER BY name'),
  statuses: STATUSES, priorities: PRIORITIES, transitions: TRANSITIONS,
  sla: all('SELECT * FROM sla_policies')
}));

// ---------- suggestions + duplicate detection ----------
app.post('/api/suggest', auth, limit(30), (req, res) => {
  const title = String(req.body.title || '').slice(0, 120), description = String(req.body.description || '').slice(0, 2000);
  const text = title + ' ' + description;
  const s = suggest(text);
  const cat = get('SELECT c.id, d.name AS department FROM categories c JOIN departments d ON d.id=c.department_id WHERE c.name=?', s.category);
  const dups = all(ISSUE_SQL + ` WHERE i.status NOT IN ${CLOSED} ORDER BY i.created_at DESC LIMIT 200`)
    .map(i => ({ i, score: similarity(text, i.title + ' ' + i.description) }))
    .filter(x => x.score >= 0.25).sort((a, b) => b.score - a.score).slice(0, 3)
    .map(x => { const o = shape(x.i, req.user); return { id: o.id, code: o.code, title: o.title, status: o.status, location: o.location, votes: o.votes, score: Math.round(x.score * 100) }; });
  res.json({ suggestion: { ...s, category_id: cat ? cat.id : null, department: cat ? cat.department : null }, duplicates: dups });
});

// ---------- issues ----------
app.get('/api/issues', auth, (req, res) => {
  const q = req.query; let sql = ISSUE_SQL + ' WHERE 1=1'; const p = [];
  if (q.status) { sql += ' AND i.status=?'; p.push(q.status); }
  if (q.category) { sql += ' AND i.category_id=?'; p.push(+q.category); }
  if (q.location) { sql += ' AND i.location_id=?'; p.push(+q.location); }
  if (q.priority) { sql += ' AND i.priority=?'; p.push(q.priority); }
  if (q.mine) { sql += ' AND i.user_id=?'; p.push(req.user.id); }
  if (q.dept === 'mine') { sql += ' AND c.department_id=?'; p.push(req.user.department_id || -1); }
  if (q.assigned === 'me') { sql += ' AND i.assigned_to=?'; p.push(req.user.id); }
  if (q.overdue) { sql += ` AND i.due_at<? AND i.status NOT IN ${CLOSED}`; p.push(now()); }
  if (q.q) { const l = '%' + String(q.q).slice(0, 80) + '%'; sql += ' AND (i.title LIKE ? OR i.description LIKE ? OR i.code LIKE ?)'; p.push(l, l, l); }
  sql += q.sort === 'votes' ? ' ORDER BY votes DESC, i.created_at DESC' : ' ORDER BY i.created_at DESC';
  const requestedSize = Math.trunc(Number(q.limit) || 20);
  const size = Math.min(Math.max(requestedSize, 1), 200);
  const requestedPage = Math.trunc(Number(q.page) || 1);
  const page = Math.min(Math.max(requestedPage, 1), 1000000);
  sql += ' LIMIT ? OFFSET ?'; p.push(size, (page - 1) * size);
  res.json(all(sql, ...p).map(i => shape(i, req.user)));
});

app.get('/api/issues/:id', auth, (req, res) => {
  const i = get(ISSUE_SQL + ' WHERE i.id=?', +req.params.id);
  if (!i) return bad(res, 'Issue not found', 404);
  const o = shape(i, req.user), hideReporter = i.anonymous && !o.mine;
  o.history = all(`SELECT h.from_status, h.to_status, h.note, h.created_at, u.name AS by_name, u.role AS by_role
    FROM status_history h LEFT JOIN users u ON u.id=h.changed_by WHERE h.issue_id=? ORDER BY h.id`, i.id)
    .map(h => ({ ...h, by_name: h.by_role === 'student' && hideReporter ? 'Anonymous' : h.by_name }));
  o.comments = all(`SELECT c.id, c.user_id, c.body, c.created_at, u.name, u.role FROM comments c JOIN users u ON u.id=c.user_id
    WHERE c.issue_id=? ORDER BY c.id`, i.id)
    .map(c => ({ id: c.id, body: c.body, created_at: c.created_at, role: c.role, name: c.user_id === i.user_id && hideReporter ? 'Anonymous' : c.name }));
  o.feedback = get('SELECT rating, comment FROM feedback WHERE issue_id=?', i.id) || null;
  res.json(o);
});

function hasValidImageSignature(filePath, mime) {
  let fd;
  try {
    const header = Buffer.alloc(12);
    fd = fs.openSync(filePath, 'r');
    const count = fs.readSync(fd, header, 0, header.length, 0);
    const b = header.subarray(0, count);
    if (mime === 'image/jpeg') return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    if (mime === 'image/png') return b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
    if (mime === 'image/webp') return b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
    return false;
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function removeUpload(file) {
  if (file?.path) { try { fs.rmSync(file.path, { force: true }); } catch { /* best-effort cleanup */ } }
}

app.post('/api/issues', auth, roles('student'), limit(10), upload.single('photo'), (req, res) => {
  const reject = (message, status = 400) => { removeUpload(req.file); return bad(res, message, status); };
  const b = req.body, title = String(b.title || '').trim(), description = String(b.description || '').trim();
  if (req.file && !hasValidImageSignature(req.file.path, req.file.mimetype)) return reject('Uploaded file is not a valid JPG, PNG, or WebP image');
  if (title.length < 5 || title.length > 120) return reject('Title must be 5-120 characters');
  if (description.length < 10 || description.length > 2000) return reject('Description must be 10-2000 characters');
  const cat = get('SELECT * FROM categories WHERE id=?', Number(b.category_id));
  const loc = get('SELECT id FROM locations WHERE id=?', Number(b.location_id));
  if (!cat) return reject('Choose a valid category');
  if (!loc) return reject('Choose a valid location');
  const hasLat = b.lat !== undefined && b.lat !== '', hasLng = b.lng !== undefined && b.lng !== '';
  const lat = hasLat ? Number(b.lat) : null, lng = hasLng ? Number(b.lng) : null;
  if (hasLat !== hasLng) return reject('Provide both map coordinates, or leave both empty');
  if ((lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) ||
      (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180))) return reject('Invalid map coordinates');
  const priority = suggest(title + ' ' + description).priority; // system-suggested; staff can change it
  const r = run(`INSERT INTO issues(code,user_id,title,description,category_id,location_id,room,lat,lng,photo,priority,anonymous,due_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, 'tmp-' + crypto.randomUUID(), req.user.id, title, description, cat.id, loc.id,
    (b.room || '').slice(0, 60) || null, lat, lng, req.file ? req.file.filename : null, priority,
    b.anonymous === '1' || b.anonymous === 'true' ? 1 : 0, dueFor(priority, now()));
  const id = Number(r.lastInsertRowid), code = `CIT-${new Date().getFullYear()}-${String(id).padStart(4, '0')}`;
  run('UPDATE issues SET code=? WHERE id=?', code, id);
  run('INSERT INTO status_history(issue_id,from_status,to_status,changed_by,note) VALUES(?,?,?,?,?)', id, null, 'Submitted', req.user.id, 'Issue reported');
  all("SELECT id FROM users WHERE is_active=1 AND (role='admin' OR (role='staff' AND department_id=?))", cat.department_id)
    .forEach(u => notify(u.id, `New ${priority} issue ${code} (${cat.name})`, id));
  res.json({ id, code, priority });
});

app.post('/api/issues/:id/vote', auth, (req, res) => {
  const i = get('SELECT id FROM issues WHERE id=?', +req.params.id);
  if (!i) return bad(res, 'Issue not found', 404);
  const had = get('SELECT 1 FROM votes WHERE issue_id=? AND user_id=?', i.id, req.user.id);
  if (had) run('DELETE FROM votes WHERE issue_id=? AND user_id=?', i.id, req.user.id);
  else run('INSERT INTO votes(issue_id,user_id) VALUES(?,?)', i.id, req.user.id); // PRIMARY KEY blocks duplicates
  res.json({ voted: !had, votes: get('SELECT COUNT(*) n FROM votes WHERE issue_id=?', i.id).n });
});

app.post('/api/issues/:id/comments', auth, limit(30), (req, res) => {
  const i = get('SELECT * FROM issues WHERE id=?', +req.params.id), body = (req.body.body || '').trim();
  if (!i) return bad(res, 'Issue not found', 404);
  if (body.length < 1 || body.length > 1000) return bad(res, 'Comment must be 1-1000 characters');
  run('INSERT INTO comments(issue_id,user_id,body) VALUES(?,?,?)', i.id, req.user.id, body);
  if (i.user_id !== req.user.id) notify(i.user_id, `New comment on ${i.code}`, i.id);
  if (i.assigned_to && i.assigned_to !== req.user.id) notify(i.assigned_to, `New comment on ${i.code}`, i.id);
  res.json({ ok: true });
});

function setStatus(i, to, userId, note) {
  const t = now();
  run('UPDATE issues SET status=?, updated_at=?, resolved_at=? WHERE id=?', to, t, to === 'Resolved' ? t : null, i.id);
  if (to === 'Reopened') run('UPDATE issues SET escalated=0, warned=0, due_at=? WHERE id=?', dueFor(i.priority, t), i.id);
  run('INSERT INTO status_history(issue_id,from_status,to_status,changed_by,note) VALUES(?,?,?,?,?)', i.id, i.status, to, userId, note || null);
  if (i.user_id !== userId) notify(i.user_id, `${i.code} is now "${to}"`, i.id);
  if (i.assigned_to && i.assigned_to !== userId && ['Reopened', 'Resolved'].includes(to)) notify(i.assigned_to, `${i.code} is now "${to}"`, i.id);
}

function checkMove(u, i, to, note) {
  if (!STATUSES.includes(to)) return [400, 'Unknown status'];
  if (!canTransition(i.status, to)) return [400, `Cannot move from "${i.status}" to "${to}"`];
  if (u.role === 'student') {
    if (i.user_id !== u.id) return [403, 'This is not your issue'];
    if (!['Resolved', 'Reopened'].includes(to)) return [403, 'Students can only confirm or reopen'];
  } else if (u.role === 'staff') {
    if (i.department_id !== u.department_id) return [403, 'This issue belongs to another department'];
    if (to === 'Resolved') return [403, 'Only the reporter or an admin can mark an issue resolved'];
  }
  if (to === 'Assigned' && !i.assigned_to) return [400, 'Assign a staff member first'];
  if (['Rejected', 'Awaiting Student Confirmation', 'Reopened'].includes(to) && note.length < 5) return [400, 'A note of at least 5 characters is required'];
  return null;
}

app.post('/api/issues/:id/status', auth, (req, res) => {
  const i = get(ISSUE_SQL + ' WHERE i.id=?', +req.params.id);
  if (!i) return bad(res, 'Issue not found', 404);
  const note = (req.body.note || '').trim().slice(0, 1000), err = checkMove(req.user, i, req.body.status, note);
  if (err) return bad(res, err[1], err[0]);
  setStatus(i, req.body.status, req.user.id, note);
  res.json({ ok: true });
});

app.post('/api/issues/:id/assign', auth, roles('admin'), (req, res) => {
  const i = get(ISSUE_SQL + ' WHERE i.id=?', +req.params.id), s = get("SELECT * FROM users WHERE id=? AND role='staff' AND is_active=1", +req.body.staff_id);
  if (!i) return bad(res, 'Issue not found', 404);
  if (!s) return bad(res, 'Choose a valid staff member');
  if (['Resolved', 'Rejected'].includes(i.status)) return bad(res, 'Reopen the issue before assigning');
  run('UPDATE issues SET assigned_to=? WHERE id=?', s.id, i.id);
  i.assigned_to = s.id;
  if (i.status === 'Submitted') { setStatus(i, 'Under Review', req.user.id, 'Reviewed by admin'); i.status = 'Under Review'; }
  if (['Under Review', 'Reopened'].includes(i.status)) setStatus(i, 'Assigned', req.user.id, `Assigned to ${s.name}`);
  notify(s.id, `You were assigned ${i.code}`, i.id);
  audit(req.user.id, 'assign', `${i.code} -> ${s.name}`);
  res.json({ ok: true });
});

app.post('/api/issues/:id/priority', auth, roles('staff', 'admin'), (req, res) => {
  const i = get(ISSUE_SQL + ' WHERE i.id=?', +req.params.id);
  if (!i) return bad(res, 'Issue not found', 404);
  if (!PRIORITIES.includes(req.body.priority)) return bad(res, 'Invalid priority');
  if (req.user.role === 'staff' && i.department_id !== req.user.department_id) return bad(res, 'This issue belongs to another department', 403);
  run('UPDATE issues SET priority=?, due_at=?, escalated=0, warned=0, updated_at=? WHERE id=?', req.body.priority, dueFor(req.body.priority, i.created_at), now(), i.id);
  audit(req.user.id, 'priority_change', `${i.code}: ${i.priority} -> ${req.body.priority}`);
  res.json({ ok: true });
});

app.post('/api/issues/:id/feedback', auth, (req, res) => {
  const i = get('SELECT * FROM issues WHERE id=?', +req.params.id), rating = +req.body.rating;
  if (!i || i.user_id !== req.user.id) return bad(res, 'Issue not found', 404);
  if (i.status !== 'Resolved') return bad(res, 'Feedback is possible only after resolution');
  if (!(rating >= 1 && rating <= 5)) return bad(res, 'Rating must be 1-5');
  if (get('SELECT 1 FROM feedback WHERE issue_id=?', i.id)) return bad(res, 'Feedback already submitted');
  run('INSERT INTO feedback(issue_id,rating,comment) VALUES(?,?,?)', i.id, rating, String(req.body.comment || '').slice(0, 500) || null);
  res.json({ ok: true });
});

// ---------- notifications ----------
app.get('/api/notifications', auth, (req, res) => res.json({
  items: all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50', req.user.id),
  unread: get('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND is_read=0', req.user.id).n
}));
app.post('/api/notifications/read', auth, (req, res) => { run('UPDATE notifications SET is_read=1 WHERE user_id=?', req.user.id); res.json({ ok: true }); });

// ---------- dashboards (all numbers computed from real data) ----------
app.get('/api/dashboard', auth, (req, res) => {
  const u = req.user, n = (sql, ...p) => get(sql, ...p).n, open = `status NOT IN ${CLOSED}`;
  if (u.role === 'student') {
    const w = 'user_id=?';
    return res.json({ role: 'student',
      total: n(`SELECT COUNT(*) n FROM issues WHERE ${w}`, u.id),
      inProgress: n(`SELECT COUNT(*) n FROM issues WHERE ${w} AND status IN ('Under Review','Assigned','In Progress')`, u.id),
      awaiting: n(`SELECT COUNT(*) n FROM issues WHERE ${w} AND status='Awaiting Student Confirmation'`, u.id),
      resolved: n(`SELECT COUNT(*) n FROM issues WHERE ${w} AND status='Resolved'`, u.id),
      reopened: n(`SELECT COUNT(*) n FROM issues WHERE ${w} AND status='Reopened'`, u.id),
      recent: all(ISSUE_SQL + ' WHERE i.user_id=? ORDER BY i.updated_at DESC LIMIT 5', u.id).map(i => shape(i, u)) });
  }
  if (u.role === 'staff') {
    const w = 'category_id IN (SELECT id FROM categories WHERE department_id=?)', d = u.department_id || -1, t = now();
    return res.json({ role: 'staff',
      newIssues: n(`SELECT COUNT(*) n FROM issues WHERE ${w} AND status IN ('Submitted','Under Review')`, d),
      active: n(`SELECT COUNT(*) n FROM issues WHERE ${w} AND status IN ('Assigned','In Progress','Reopened')`, d),
      urgent: n(`SELECT COUNT(*) n FROM issues WHERE ${w} AND ${open} AND priority IN ('Critical','High')`, d),
      overdue: n(`SELECT COUNT(*) n FROM issues WHERE ${w} AND ${open} AND due_at<?`, d, t),
      dueSoon: n(`SELECT COUNT(*) n FROM issues WHERE ${w} AND ${open} AND due_at BETWEEN ? AND ?`, d, t, fmtDate(Date.now() + 24 * 3600e3)),
      resolved: n(`SELECT COUNT(*) n FROM issues WHERE ${w} AND status='Resolved'`, d),
      workload: all(`SELECT u.name AS label, COUNT(*) AS n FROM issues i JOIN users u ON u.id=i.assigned_to
        WHERE i.category_id IN (SELECT id FROM categories WHERE department_id=?) AND i.status NOT IN ${CLOSED} GROUP BY u.id`, d) });
  }
  const total = n('SELECT COUNT(*) n FROM issues'), resolved = n("SELECT COUNT(*) n FROM issues WHERE status='Resolved'");
  const avg = get('SELECT AVG((julianday(resolved_at)-julianday(created_at))*24) h FROM issues WHERE resolved_at IS NOT NULL').h;
  res.json({ role: 'admin', total, resolved,
    open: n(`SELECT COUNT(*) n FROM issues WHERE ${open}`),
    inProgress: n("SELECT COUNT(*) n FROM issues WHERE status IN ('Assigned','In Progress')"),
    overdue: n(`SELECT COUNT(*) n FROM issues WHERE ${open} AND due_at<?`, now()),
    avgResolutionHours: avg == null ? null : Math.round(avg * 10) / 10,
    resolutionRate: total ? Math.round(resolved * 100 / total) : 0,
    avgRating: get('SELECT AVG(rating) r FROM feedback').r,
    byCategory: all('SELECT c.name AS label, COUNT(*) AS n FROM issues i JOIN categories c ON c.id=i.category_id GROUP BY c.id ORDER BY n DESC'),
    byLocation: all('SELECT l.name AS label, COUNT(*) AS n FROM issues i JOIN locations l ON l.id=i.location_id GROUP BY l.id ORDER BY n DESC'),
    byDepartment: all(`SELECT d.name AS label, COUNT(*) AS n, SUM(i.status='Resolved') AS resolved FROM issues i
      JOIN categories c ON c.id=i.category_id JOIN departments d ON d.id=c.department_id GROUP BY d.id ORDER BY n DESC`),
    trend: all("SELECT date(created_at) AS label, COUNT(*) AS n FROM issues WHERE created_at>=date('now','-30 day') GROUP BY date(created_at) ORDER BY label") });
});

// ---------- administration ----------
app.get('/api/users', auth, roles('admin'), (req, res) =>
  res.json(all('SELECT id,name,email,role,department_id,created_at FROM users WHERE is_active=1 ORDER BY role, name')));

app.patch('/api/users/:id', auth, roles('admin'), (req, res) => {
  const u = get('SELECT * FROM users WHERE id=?', +req.params.id);
  if (!u) return bad(res, 'User not found', 404);
  if (u.id === req.user.id) return bad(res, 'You cannot change your own role');
  const role = req.body.role, dept = req.body.department_id ? +req.body.department_id : null;
  if (!['student', 'staff', 'admin'].includes(role)) return bad(res, 'Invalid role');
  if (u.role === 'admin' && role !== 'admin' && get("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND is_active=1").n <= 1)
    return bad(res, 'Promote another administrator before changing the last active admin role');
  if (dept && !get('SELECT 1 FROM departments WHERE id=?', dept)) return bad(res, 'Invalid department');
  if (role === 'staff' && !dept) return bad(res, 'Staff must belong to a department');
  run('UPDATE users SET role=?, department_id=? WHERE id=?', role, role === 'staff' ? dept : null, u.id);
  audit(req.user.id, 'user_update', `${u.email}: ${u.role} -> ${role}`);
  res.json({ ok: true });
});

const addNamed = (table, extra) => (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) return bad(res, 'Name is required');
  try { extra(req, name); audit(req.user.id, 'create_' + table, name); res.json({ ok: true }); }
  catch (e) { bad(res, e.message.includes('UNIQUE') ? 'Already exists' : 'Invalid data'); }
};
app.post('/api/departments', auth, roles('admin'), addNamed('department', (r, n) => run('INSERT INTO departments(name) VALUES(?)', n)));
app.post('/api/categories', auth, roles('admin'), addNamed('category', (r, n) => run('INSERT INTO categories(name,department_id) VALUES(?,?)', n, +r.body.department_id)));
app.post('/api/locations', auth, roles('admin'), (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const latText = req.body.lat === undefined ? '' : String(req.body.lat).trim();
  const lngText = req.body.lng === undefined ? '' : String(req.body.lng).trim();
  if (!name) return bad(res, 'Location name is required');
  if ((latText === '') !== (lngText === '')) return bad(res, 'Provide both latitude and longitude, or leave both empty');
  const lat = latText === '' ? null : Number(latText), lng = lngText === '' ? null : Number(lngText);
  if (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) return bad(res, 'Latitude must be between -90 and 90');
  if (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180)) return bad(res, 'Longitude must be between -180 and 180');
  try {
    run('INSERT INTO locations(name,lat,lng) VALUES(?,?,?)', name, lat, lng);
    audit(req.user.id, 'create_location', `${name} (${lat ?? 'no pin'}, ${lng ?? 'no pin'})`);
    res.status(201).json({ ok: true });
  } catch (e) { return bad(res, e.message.includes('UNIQUE') ? 'Location already exists' : 'Invalid location'); }
});

app.patch('/api/locations/:id', auth, roles('admin'), (req, res) => {
  const location = get('SELECT * FROM locations WHERE id=?', Number(req.params.id));
  if (!location) return bad(res, 'Location not found', 404);
  const latText = req.body.lat === undefined ? '' : String(req.body.lat).trim();
  const lngText = req.body.lng === undefined ? '' : String(req.body.lng).trim();
  if ((latText === '') !== (lngText === '')) return bad(res, 'Provide both latitude and longitude, or leave both empty');
  const lat = latText === '' ? null : Number(latText), lng = lngText === '' ? null : Number(lngText);
  if (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) return bad(res, 'Latitude must be between -90 and 90');
  if (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180)) return bad(res, 'Longitude must be between -180 and 180');
  run('UPDATE locations SET lat=?,lng=? WHERE id=?', lat, lng, location.id);
  audit(req.user.id, 'update_location_coordinates', `${location.name}: ${lat ?? 'no pin'}, ${lng ?? 'no pin'}`);
  res.json({ ok: true });
});

app.put('/api/sla', auth, roles('admin'), (req, res) => {
  for (const p of PRIORITIES) {
    const h = Math.round(+req.body[p]);
    if (!(h >= 1 && h <= 24 * 90)) return bad(res, `Hours for ${p} must be between 1 and 2160`);
    run('UPDATE sla_policies SET hours=? WHERE priority=?', h, p);
  }
  audit(req.user.id, 'sla_update', JSON.stringify(req.body));
  res.json({ ok: true });
});

app.get('/api/audit', auth, roles('admin'), (req, res) =>
  res.json(all('SELECT a.*, u.name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 50')));

app.get('/api/export.csv', auth, roles('admin'), (req, res) => {
  const cell = v => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const rows = all(`SELECT i.code,i.title,c.name AS category,l.name AS location,d.name AS department,i.priority,i.status,i.created_at,i.resolved_at
    FROM issues i LEFT JOIN categories c ON c.id=i.category_id LEFT JOIN locations l ON l.id=i.location_id
    LEFT JOIN departments d ON d.id=c.department_id ORDER BY i.id`); // reporter identity is deliberately excluded
  const cols = ['code', 'title', 'category', 'location', 'department', 'priority', 'status', 'created_at', 'resolved_at'];
  res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=issues.csv' });
  res.send([cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n'));
});

// ---------- SLA background job: warn before the deadline, escalate after it ----------
function slaJob() {
  const t = now(), soon = fmtDate(Date.now() + 2 * 3600e3);
  const base = `SELECT i.id, i.code, i.assigned_to, c.department_id FROM issues i LEFT JOIN categories c ON c.id=i.category_id
    WHERE i.status NOT IN ('Resolved','Rejected','Awaiting Student Confirmation')`;
  const staffFor = i => i.assigned_to ? all("SELECT id FROM users WHERE id=? AND role='staff' AND is_active=1", i.assigned_to) : all("SELECT id FROM users WHERE role='staff' AND is_active=1 AND department_id=?", i.department_id);
  for (const i of all(base + ' AND i.due_at<? AND i.escalated=0', t)) {
    run('UPDATE issues SET escalated=1 WHERE id=?', i.id);
    [...all("SELECT id FROM users WHERE role='admin' AND is_active=1"), ...staffFor(i)].forEach(u => notify(u.id, `OVERDUE: ${i.code} passed its deadline and was escalated`, i.id));
    audit(null, 'sla_escalation', i.code);
  }
  for (const i of all(base + ' AND i.due_at BETWEEN ? AND ? AND i.warned=0', t, soon)) {
    run('UPDATE issues SET warned=1 WHERE id=?', i.id);
    staffFor(i).forEach(u => notify(u.id, `Deadline approaching for ${i.code}`, i.id));
  }
}
setInterval(slaJob, 60000); slaJob();

app.use('/api', (req, res) => bad(res, 'Not found', 404));
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Photo must be 5 MB or smaller' : 'Invalid photo upload';
    return bad(res, message, 400);
  }
  if (err?.message === 'Photo must be JPG, PNG, or WebP.') return bad(res, err.message, 400);
  if (err?.type === 'entity.too.large') return bad(res, 'Request body is too large', 413);
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) return bad(res, 'Invalid JSON body', 400);
  console.error(err?.message || err);
  bad(res, 'Something went wrong', 500);
}); // Do not expose stack traces to clients.

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CampusFix running on http://localhost:${PORT}`));
