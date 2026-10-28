// Production configuration regression test: starter credentials are absent and photos require auth.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3918;
const BASE = `http://localhost:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'campusfix-production-test-'));
const dbPath = path.join(tmp, 'campusfix.db');
const uploadDir = path.join(tmp, 'uploads');
let server;
let output = '';

const jsonCall = async (url, { token, method = 'GET', body } = {}) => {
  const response = await fetch(BASE + url, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { response, data: await response.json().catch(() => null) };
};

const waitForServer = async () => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`Production test server did not start. Output: ${output}`)), 10000);
  server.stdout.on('data', chunk => {
    output += chunk.toString();
    if (/CampusFix running/.test(output)) { clearTimeout(timeout); resolve(); }
  });
  server.stderr.on('data', chunk => { output += chunk.toString(); });
  server.once('error', error => { clearTimeout(timeout); reject(error); });
  server.once('exit', code => {
    if (!/CampusFix running/.test(output)) { clearTimeout(timeout); reject(new Error(`Server exited (${code}). Output: ${output}`)); }
  });
});

test('production mode uses secure admin bootstrap and protects uploaded photos', async t => {
  t.after(async () => {
    if (server && server.exitCode === null) {
      server.kill();
      await new Promise(resolve => server.once('exit', resolve));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DB_FILE: dbPath,
    UPLOAD_DIR: uploadDir,
    JWT_SECRET: 'unit-test-jwt-secret-must-be-at-least-32-chars',
    ADMIN_EMAIL: 'campusfix-test-admin@example.com',
    ADMIN_PASSWORD: 'a-unique-test-password-that-is-long-enough',
    ADMIN_NAME: 'Test Administrator',
    SEED_DEMO_USERS: 'false'
  };
  server = spawn(process.execPath, ['server.js'], { env, stdio: 'pipe' });
  await waitForServer();

  const defaultLogin = await jsonCall('/api/login', { method: 'POST', body: { email: 'admin@campusfix.com', password: 'admin123' } });
  assert.equal(defaultLogin.response.status, 401, 'the public starter admin credentials must not work in production');

  const adminLogin = await jsonCall('/api/login', { method: 'POST', body: { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD } });
  assert.equal(adminLogin.response.status, 200);
  assert.equal(adminLogin.data.user.role, 'admin');
  const adminToken = adminLogin.data.token;

  const shortPassword = await jsonCall('/api/signup', { method: 'POST', body: { name: 'Test User', email: 'short@example.com', password: '1234567' } });
  assert.equal(shortPassword.response.status, 400, 'signup must reject passwords shorter than 8 characters');

  const signup = await jsonCall('/api/signup', { method: 'POST', body: { name: 'Test Student', email: 'test-student@example.com', password: 'student-password-123' } });
  assert.equal(signup.response.status, 201);
  assert.equal(signup.data.user.role, 'student');

  const form = new FormData();
  form.append('title', 'Broken light in lab');
  form.append('description', 'The light is flickering in the computer lab.');
  form.append('category_id', '1');
  form.append('location_id', '1');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8kcAAAAASUVORK5CYII=', 'base64');
  form.append('photo', new Blob([png], { type: 'image/png' }), 'tiny.png');
  const createdResponse = await fetch(BASE + '/api/issues', { method: 'POST', headers: { Authorization: `Bearer ${signup.data.token}` }, body: form });
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  const detail = await jsonCall(`/api/issues/${created.id}`, { token: signup.data.token });
  assert.match(detail.data.photo, /^[0-9a-f-]{36}\.png$/i);

  const privateImage = await fetch(`${BASE}/uploads/${detail.data.photo}`, { headers: { Authorization: `Bearer ${signup.data.token}` } });
  assert.equal(privateImage.status, 200);
  assert.match(privateImage.headers.get('cache-control') || '', /private/);
  const anonymousImage = await fetch(`${BASE}/uploads/${detail.data.photo}`);
  assert.equal(anonymousImage.status, 401, 'photos must not be directly readable without authentication');

  const invalidLatitude = await jsonCall('/api/locations/1', { token: adminToken, method: 'PATCH', body: { lat: 999, lng: 71 } });
  assert.equal(invalidLatitude.response.status, 400);
  const validCoordinates = await jsonCall('/api/locations/1', { token: adminToken, method: 'PATCH', body: { lat: 22.36758, lng: 70.79573 } });
  assert.equal(validCoordinates.response.status, 200);
});
