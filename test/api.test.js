// End-to-end API test: starts the real server on a temporary database.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const PORT = 3917, DB = 'test-temp.db', BASE = `http://localhost:${PORT}`;
let server;

test.before(async () => {
  server = spawn(process.execPath, ['server.js'], { env: { ...process.env, NODE_ENV: 'test', SEED_DEMO_USERS: 'true', PORT, DB_FILE: DB }, stdio: 'pipe' });
  await new Promise((ok, fail) => { server.stdout.on('data', d => /running/.test(d) && ok()); server.on('error', fail); setTimeout(() => fail(new Error('server did not start')), 8000); });
});
test.after(async () => {
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise(resolve => server.once('exit', resolve));
  }
  for (const f of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true });
});

const call = async (path, { token, method = 'GET', body } = {}) => {
  const isForm = body instanceof FormData;
  const r = await fetch(BASE + path, { method, headers: { ...(token && { Authorization: 'Bearer ' + token }), ...(body && !isForm && { 'Content-Type': 'application/json' }) }, body: body && (isForm ? body : JSON.stringify(body)) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const login = async (email, password) => (await call('/api/login', { method: 'POST', body: { email, password } })).data.token;
const form = obj => { const f = new FormData(); Object.entries(obj).forEach(([k, v]) => f.append(k, v)); return f; };

test('auth, roles, issue workflow and permissions', async () => {
  assert.strictEqual((await call('/api/issues')).status, 401);
  assert.strictEqual((await call('/api/login', { method: 'POST', body: { email: 'student@campusfix.com', password: 'nope' } })).status, 401);

  const student = await login('student@campusfix.com', 'student123');
  const it = await login('it.staff@campusfix.com', 'staff123');
  const maint = await login('maint.staff@campusfix.com', 'staff123');
  const admin = await login('admin@campusfix.com', 'admin123');

  assert.strictEqual((await call('/api/users', { token: student })).status, 403);
  assert.strictEqual((await call('/api/issues', { token: student, method: 'POST', body: form({ title: 'x', description: 'short' }) })).status, 400);

  const created = await call('/api/issues', { token: student, method: 'POST', body: form({ title: 'Wi-Fi down in Lab 3', description: 'No internet connection in the computer lab', category_id: 1, location_id: 3 }) });
  assert.strictEqual(created.status, 200);
  const id = created.data.id;

  const v1 = await call(`/api/issues/${id}/vote`, { token: it, method: 'POST' });
  const v2 = await call(`/api/issues/${id}/vote`, { token: it, method: 'POST' });
  assert.strictEqual(v1.data.votes, 1); assert.strictEqual(v2.data.votes, 0); // never counted twice

  assert.strictEqual((await call(`/api/issues/${id}/status`, { token: maint, method: 'POST', body: { status: 'Under Review' } })).status, 403); // other department
  assert.strictEqual((await call(`/api/issues/${id}/assign`, { token: it, method: 'POST', body: { staff_id: 2 } })).status, 403);           // staff cannot assign
  assert.strictEqual((await call(`/api/issues/${id}/assign`, { token: admin, method: 'POST', body: { staff_id: 2 } })).status, 200);
  assert.strictEqual((await call(`/api/issues/${id}/status`, { token: it, method: 'POST', body: { status: 'Resolved' } })).status, 400);
  assert.strictEqual((await call(`/api/issues/${id}/status`, { token: it, method: 'POST', body: { status: 'In Progress' } })).status, 200);

  const detail = await call(`/api/issues/${id}`, { token: student });
  assert.ok(detail.data.history.length >= 4);
  assert.ok((await call('/api/notifications', { token: student })).data.unread >= 1);
});
