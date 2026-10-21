const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const db = new DatabaseSync(process.env.DB_FILE || 'campusfix.db');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS departments(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS categories(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL,
  department_id INTEGER NOT NULL REFERENCES departments(id));
CREATE TABLE IF NOT EXISTS locations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, lat REAL, lng REAL);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK(role IN ('student','staff','admin')),
  department_id INTEGER REFERENCES departments(id), created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
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

// ---- Development seed data (runs only on an empty database) ----
if (!db.prepare('SELECT 1 FROM departments').get()) {
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
    ['Safety and Accessibility', 'Security'], ['Other', 'Maintenance']];
  cats.forEach(([n, d]) => db.prepare('INSERT INTO categories(name,department_id) VALUES(?,?)').run(n, D[d]));
  // Sample coordinates near Rajkot. Replace with your real campus buildings.
  [['Main Building', 22.3039, 70.8022], ['Library', 22.3045, 70.8030], ['Computer Lab Block', 22.3033, 70.8038],
   ['Hostel A', 22.3052, 70.8010], ['Hostel B', 22.3056, 70.8018], ['Cafeteria', 22.3041, 70.8045],
   ['Sports Complex', 22.3025, 70.8050], ['Parking Area', 22.3030, 70.8008]]
    .forEach(l => db.prepare('INSERT INTO locations(name,lat,lng) VALUES(?,?,?)').run(...l));
  [['Critical', 4], ['High', 24], ['Medium', 72], ['Low', 168]]
    .forEach(p => db.prepare('INSERT INTO sla_policies(priority,hours) VALUES(?,?)').run(...p));
  const user = (n, e, pw, r, d) => db.prepare('INSERT INTO users(name,email,password,role,department_id) VALUES(?,?,?,?,?)')
    .run(n, e, bcrypt.hashSync(pw, 10), r, d || null);
  user('Admin', 'admin@campusfix.com', 'admin123', 'admin');
  user('IT Staff', 'it.staff@campusfix.com', 'staff123', 'staff', D['IT Support']);
  user('Maintenance Staff', 'maint.staff@campusfix.com', 'staff123', 'staff', D['Maintenance']);
  user('Demo Student', 'student@campusfix.com', 'student123', 'student');
}

module.exports = db;
