const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = path.resolve(process.env.DB_FILE || path.join(__dirname, 'campusfix.db'));
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS departments(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS categories(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL,
  department_id INTEGER NOT NULL REFERENCES departments(id));
CREATE TABLE IF NOT EXISTS locations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, lat REAL, lng REAL);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK(role IN ('student','staff','admin')),
  department_id INTEGER REFERENCES departments(id), is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  auth_version INTEGER NOT NULL DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS issues(
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, description TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id), location_id INTEGER REFERENCES locations(id),
  room TEXT, lat REAL, lng REAL, photo TEXT,
  priority TEXT NOT NULL DEFAULT 'Medium', status TEXT NOT NULL DEFAULT 'Submitted',
  anonymous INTEGER NOT NULL DEFAULT 0, assigned_to INTEGER REFERENCES users(id),
  due_at DATETIME, escalated INTEGER DEFAULT 0, warned INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, resolved_at DATETIME);
CREATE TABLE IF NOT EXISTS status_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  from_status TEXT, to_status TEXT NOT NULL, changed_by INTEGER REFERENCES users(id), note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS comments(
  id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS votes(
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id), PRIMARY KEY(issue_id, user_id));
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL, issue_id INTEGER, is_read INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS feedback(
  issue_id INTEGER PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), comment TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sla_policies(priority TEXT PRIMARY KEY, hours INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT NOT NULL, detail TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_user ON issues(user_id);
CREATE INDEX IF NOT EXISTS idx_issues_due ON issues(due_at);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);
`);

// Schema migration for databases created before account deactivation was introduced.
const userColumns = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!userColumns.includes('is_active')) {
  db.exec('ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
}
if (!userColumns.includes('auth_version')) {
  db.exec('ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1');
}

// Seed reference data on an empty database. Coordinates are starter examples and must be
// replaced with verified campus coordinates before CampusFix is used for real reporting.
if (!db.prepare('SELECT 1 FROM departments LIMIT 1').get()) {
  const dept = n => Number(db.prepare('INSERT INTO departments(name) VALUES(?)').run(n).lastInsertRowid);
  const D = {};
  ['IT Support', 'Electrical', 'Maintenance', 'Housekeeping', 'Plumbing', 'Hostel Administration', 'Library', 'Security']
    .forEach(n => D[n] = dept(n));
  const cats = [
    ['Wi-Fi and Internet', 'IT Support'], ['Electricity and Lighting', 'Electrical'],
    ['Classrooms and Laboratories', 'Maintenance'], ['Washrooms and Sanitation', 'Housekeeping'],
    ['Water Supply and Leakage', 'Plumbing'], ['Hostel and Accommodation', 'Hostel Administration'],
    ['Furniture and Equipment', 'Maintenance'], ['Roads, Parking and Transport', 'Maintenance'],
    ['Library Facilities', 'Library'], ['Cleanliness and Waste', 'Housekeeping'],
    ['Safety and Accessibility', 'Security'], ['Other', 'Maintenance']
  ];
  cats.forEach(([n, d]) => db.prepare('INSERT INTO categories(name,department_id) VALUES(?,?)').run(n, D[d]));
  // Do not assign fabricated building-level pins. Configure real coordinates in Admin > Manage.
  ['Main Building', 'Library', 'Computer Lab Block', 'Hostel A', 'Hostel B', 'Cafeteria', 'Sports Complex', 'Parking Area']
    .forEach(name => db.prepare('INSERT INTO locations(name,lat,lng) VALUES(?,NULL,NULL)').run(name));
  [['Critical', 4], ['High', 24], ['Medium', 72], ['Low', 168]]
    .forEach(p => db.prepare('INSERT INTO sla_policies(priority,hours) VALUES(?,?)').run(...p));
}

// Clear only the exact placeholder coordinates from older builds; preserve coordinates an admin has edited.
const OLD_SAMPLE_COORDINATES = [
  ['Main Building', 22.3039, 70.8022], ['Library', 22.3045, 70.8030], ['Computer Lab Block', 22.3033, 70.8038],
  ['Hostel A', 22.3052, 70.8010], ['Hostel B', 22.3056, 70.8018], ['Cafeteria', 22.3041, 70.8045],
  ['Sports Complex', 22.3025, 70.8050], ['Parking Area', 22.3030, 70.8008]
];
for (const [name, lat, lng] of OLD_SAMPLE_COORDINATES) {
  db.prepare('UPDATE locations SET lat=NULL,lng=NULL WHERE name=? AND lat=? AND lng=?').run(name, lat, lng);
}

const DEMO_ACCOUNTS = [
  { name: 'Admin', email: 'admin@campusfix.com', password: 'admin123', role: 'admin' },
  { name: 'IT Staff', email: 'it.staff@campusfix.com', password: 'staff123', role: 'staff', department: 'IT Support' },
  { name: 'Maintenance Staff', email: 'maint.staff@campusfix.com', password: 'staff123', role: 'staff', department: 'Maintenance' },
  { name: 'Demo Student', email: 'student@campusfix.com', password: 'student123', role: 'student' }
];

// On production, invalidate any known starter credentials left by an older deployment.
// Account rows remain in place so historical issue/audit foreign keys are preserved.
if (process.env.NODE_ENV === 'production') {
  for (const demo of DEMO_ACCOUNTS) {
    const account = db.prepare('SELECT id,password,is_active FROM users WHERE email=?').get(demo.email);
    if (account && account.is_active && bcrypt.compareSync(demo.password, account.password)) {
      const impossiblePassword = crypto.randomBytes(48).toString('hex');
      db.prepare('UPDATE users SET password=?, is_active=0, auth_version=auth_version+1 WHERE id=?')
        .run(bcrypt.hashSync(impossiblePassword, 10), account.id);
      console.warn(`Disabled unsafe starter account in production: ${demo.email}`);
    }
  }
} else if (process.env.SEED_DEMO_USERS !== 'false' && !db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  // Demo credentials are created only for an empty non-production development database.
  const departments = Object.fromEntries(db.prepare('SELECT id,name FROM departments').all().map(d => [d.name, d.id]));
  const user = (n, e, pw, r, d) => db.prepare(
    'INSERT INTO users(name,email,password,role,department_id) VALUES(?,?,?,?,?)'
  ).run(n, e, bcrypt.hashSync(pw, 10), r, d || null);
  user('Admin', 'admin@campusfix.com', 'admin123', 'admin');
  user('IT Staff', 'it.staff@campusfix.com', 'staff123', 'staff', departments['IT Support']);
  user('Maintenance Staff', 'maint.staff@campusfix.com', 'staff123', 'staff', departments.Maintenance);
  user('Demo Student', 'student@campusfix.com', 'student123', 'student');
}

// One-time production admin bootstrap. Set ADMIN_EMAIL and ADMIN_PASSWORD as secret env vars
// before starting a fresh production database. Existing active admins are never overwritten.
if (process.env.NODE_ENV === 'production') {
  const rawEmail = process.env.ADMIN_EMAIL;
  const rawPassword = process.env.ADMIN_PASSWORD;
  if (rawEmail || rawPassword) {
    const email = String(rawEmail || '').trim().toLowerCase();
    const password = String(rawPassword || '');
    const name = String(process.env.ADMIN_NAME || 'CampusFix Administrator').trim().slice(0, 80);
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254 || password.length < 16) {
      throw new Error('Admin bootstrap requires a valid ADMIN_EMAIL and an ADMIN_PASSWORD of at least 16 characters.');
    }
    const activeAdmin = db.prepare("SELECT 1 FROM users WHERE role='admin' AND is_active=1 LIMIT 1").get();
    if (!activeAdmin) {
      const existing = db.prepare('SELECT * FROM users WHERE email=?').get(email);
      if (existing) {
        const wasDisabledDemo = DEMO_ACCOUNTS.some(a => a.email === email) && existing.is_active === 0;
        if (wasDisabledDemo || bcrypt.compareSync(password, existing.password)) {
          db.prepare("UPDATE users SET name=?,password=?,role='admin',department_id=NULL,is_active=1,auth_version=auth_version+1 WHERE id=?")
            .run(name || 'CampusFix Administrator', bcrypt.hashSync(password, 12), existing.id);
          console.log(`Configured production administrator: ${email}`);
        } else {
          throw new Error('ADMIN_EMAIL already belongs to an account. Use that account password or choose a new administrator email.');
        }
      } else {
        db.prepare("INSERT INTO users(name,email,password,role,is_active) VALUES(?,?,?,'admin',1)")
          .run(name || 'CampusFix Administrator', email, bcrypt.hashSync(password, 12));
        console.log(`Created production administrator: ${email}`);
      }
    }
  } else if (!db.prepare("SELECT 1 FROM users WHERE role='admin' AND is_active=1 LIMIT 1").get()) {
    console.warn('No active administrator exists. Set ADMIN_EMAIL and ADMIN_PASSWORD to bootstrap one securely.');
  }
}

module.exports = db;
