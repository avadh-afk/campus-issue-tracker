const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');
const { STATUSES, PRIORITIES, TRANSITIONS, canTransition, suggest, similarity } = require('./lib');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) { console.error('Set JWT_SECRET'); process.exit(1); }
fs.mkdirSync('uploads', { recursive: true });

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

const hits = new Map(); // tiny in-memory rate limiter
const limit = (max, ms = 60000) => (req, res, next) => {
  const k = req.ip + req.path, t = Date.now();
  const a = (hits.get(k) || []).filter(x => t - x < ms);
  if (a.length >= max) return bad(res, 'Too many requests, please slow down', 429);
  a.push(t); hits.set(k, a); next();
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
const tokenFor = u => jwt.sign({ id: u.id }, SECRET, { expiresIn: '7d' });
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, department_id: u.department_id });
const auth = (req, res, next) => {
  try {
    const p = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET);
    req.user = get('SELECT id,name,email,role,department_id FROM users WHERE id=?', p.id); // role always read from DB
  } catch { req.user = null; }
  req.user ? next() : bad(res, 'Please log in', 401);
};
const roles = (...r) => (req, res, next) => r.includes(req.user.role) ? next() : bad(res, 'Not allowed', 403);

const upload = multer({
  storage: multer.diskStorage({
    destination: 'uploads',
    filename: (req, f, cb) => cb(null, crypto.randomUUID() + path.extname(f.originalname).toLowerCase().replace(/[^.a-z0-9]/g, ''))
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, f, cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(f.mimetype))
});

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
app.use(express.json({ limit: '100kb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

app.post('/api/signup', limit(10), (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !/^\S+@\S+\.\S+$/.test(email || '') || (password || '').length < 6)
    return bad(res, 'Name, a valid email and a 6+ character password are required');
  try {
    const r = run('INSERT INTO users(name,email,password) VALUES(?,?,?)', String(name).slice(0, 80), email.toLowerCase(), bcrypt.hashSync(password, 10));
    const u = get('SELECT * FROM users WHERE id=?', Number(r.lastInsertRowid));
    res.json({ token: tokenFor(u), user: publicUser(u) });
  } catch { bad(res, 'Email already registered'); }
});

app.post('/api/login', limit(10), (req, res) => {
  const u = get('SELECT * FROM users WHERE email=?', String(req.body.email || '').toLowerCase());
  if (!u || !bcrypt.compareSync(req.body.password || '', u.password)) return bad(res, 'Invalid email or password', 401);
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
  const size = Math.min(+q.limit || 20, 200), page = Math.max(1, +q.page || 1);
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

app.post('/api/issues', auth, roles('student'), limit(10), upload.single('photo'), (req, res) => {
  const b = req.body, title = (b.title || '').trim(), description = (b.description || '').trim();
  if (title.length < 5 || title.length > 120) return bad(res, 'Title must be 5-120 characters');
  if (description.length < 10 || description.length > 2000) return bad(res, 'Description must be 10-2000 characters');
  const cat = get('SELECT * FROM categories WHERE id=?', +b.category_id);
  const loc = get('SELECT id FROM locations WHERE id=?', +b.location_id);
  if (!cat) return bad(res, 'Choose a valid category');
  if (!loc) return bad(res, 'Choose a valid location');
  const lat = b.lat !== undefined && b.lat !== '' ? Number(b.lat) : null, lng = b.lng !== undefined && b.lng !== '' ? Number(b.lng) : null;
  if ((lat !== null && !isFinite(lat)) || (lng !== null && !isFinite(lng))) return bad(res, 'Invalid map coordinates');
  const priority = suggest(title + ' ' + description).priority; // system-suggested; staff can change it
  const r = run(`INSERT INTO issues(code,user_id,title,description,category_id,location_id,room,lat,lng,photo,priority,anonymous,due_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, 'tmp-' + crypto.randomUUID(), req.user.id, title, description, cat.id, loc.id,
    (b.room || '').slice(0, 60) || null, lat, lng, req.file ? req.file.filename : null, priority,
    b.anonymous === '1' || b.anonymous === 'true' ? 1 : 0, dueFor(priority, now()));
  const id = Number(r.lastInsertRowid), code = `CIT-${new Date().getFullYear()}-${String(id).padStart(4, '0')}`;
  run('UPDATE issues SET code=? WHERE id=?', code, id);
  run('INSERT INTO status_history(issue_id,from_status,to_status,changed_by,note) VALUES(?,?,?,?,?)', id, null, 'Submitted', req.user.id, 'Issue reported');
  all("SELECT id FROM users WHERE role='admin' OR (role='staff' AND department_id=?)", cat.department_id)
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
  const i = get(ISSUE_SQL + ' WHERE i.id=?', +req.params.id), s = get("SELECT * FROM users WHERE id=? AND role='staff'", +req.body.staff_id);
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
  res.json(all('SELECT id,name,email,role,department_id,created_at FROM users ORDER BY role, name')));

app.patch('/api/users/:id', auth, roles('admin'), (req, res) => {
  const u = get('SELECT * FROM users WHERE id=?', +req.params.id);
  if (!u) return bad(res, 'User not found', 404);
  if (u.id === req.user.id) return bad(res, 'You cannot change your own role');
  const role = req.body.role, dept = req.body.department_id ? +req.body.department_id : null;
  if (!['student', 'staff', 'admin'].includes(role)) return bad(res, 'Invalid role');
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
app.post('/api/locations', auth, roles('admin'), addNamed('location', (r, n) =>
  run('INSERT INTO locations(name,lat,lng) VALUES(?,?,?)', n, isFinite(+r.body.lat) && r.body.lat !== '' ? +r.body.lat : null, isFinite(+r.body.lng) && r.body.lng !== '' ? +r.body.lng : null)));

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
  const staffFor = i => i.assigned_to ? [{ id: i.assigned_to }] : all("SELECT id FROM users WHERE role='staff' AND department_id=?", i.department_id);
  for (const i of all(base + ' AND i.due_at<? AND i.escalated=0', t)) {
    run('UPDATE issues SET escalated=1 WHERE id=?', i.id);
    [...all("SELECT id FROM users WHERE role='admin'"), ...staffFor(i)].forEach(u => notify(u.id, `OVERDUE: ${i.code} passed its deadline and was escalated`, i.id));
    audit(null, 'sla_escalation', i.code);
  }
  for (const i of all(base + ' AND i.due_at BETWEEN ? AND ? AND i.warned=0', t, soon)) {
    run('UPDATE issues SET warned=1 WHERE id=?', i.id);
    staffFor(i).forEach(u => notify(u.id, `Deadline approaching for ${i.code}`, i.id));
  }
}
setInterval(slaJob, 60000); slaJob();

app.use('/api', (req, res) => bad(res, 'Not found', 404));
app.use((err, req, res, next) => { console.error(err.message); bad(res, 'Something went wrong', 500); }); // no stack traces to the client

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CampusFix running on http://localhost:${PORT}`));
