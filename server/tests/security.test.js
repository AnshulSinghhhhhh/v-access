import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildMinimalPdf, buildRandomBytes } from './helpers/fixtures.js';

const tmpDir = mkdtempSync(path.join(tmpdir(), 'vaccess-security-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.STORAGE_LOCAL_DIR = path.join(tmpDir, 'uploads');
process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://example-test.local';
process.env.RATE_LIMIT_MAX_POST_CREATE = '3'; // deliberately low, to actually exercise the limit below

const { buildServer } = await import('../src/app.js');
const { getDb, closeDb } = await import('../src/db/db.js');

let server;
let baseUrl;

before(async () => {
  getDb();
  server = buildServer();
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function apiFetch(pathname, { method = 'GET', token, body, headers = {}, ip } = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(ip ? { 'X-Forwarded-For': ip } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON response, e.g. a file download */ }
  return { status: res.status, headers: res.headers, data };
}

let registerIpCounter = 0;
async function registerVerifiedStudent(emailPrefix) {
  registerIpCounter += 1;
  // Each call gets its own simulated source IP (via X-Forwarded-For) so the
  // registration/login rate limiters (keyed by IP) never interfere across
  // unrelated tests in this file — the rate limiters themselves are
  // exercised deliberately in their own tests below.
  const ip = `10.0.${registerIpCounter}.1`;
  const email = `${emailPrefix}@vitstudent.ac.in`;
  await apiFetch('/api/auth/register', {
    method: 'POST',
    ip,
    body: { fullName: 'Security Test', email, password: 'Passw0rd1' },
  });
  const db = getDb();
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  // Verify directly via DB rather than parsing console output over HTTP —
  // the OTP flow itself is already covered end-to-end in auth.test.js.
  db.prepare('UPDATE users SET is_verified = 1 WHERE id = ?').run(user.id);
  const login = await apiFetch('/api/auth/login', { method: 'POST', ip, body: { email, password: 'Passw0rd1' } });
  return { token: login.data.token, userId: user.id, email };
}

// --- Unauthorized API access ---------------------------------------------

test('SRS 14/Security: protected endpoints reject requests with no token', async () => {
  const endpoints = [
    ['/api/dashboard/summary', 'GET'],
    ['/api/timetable', 'GET'],
    ['/api/faculty', 'GET'],
    ['/api/social/posts', 'GET'],
    ['/api/notes', 'GET'],
    ['/api/campus/blocks', 'GET'],
    ['/api/admin/stats', 'GET'],
  ];
  for (const [endpoint, method] of endpoints) {
    const res = await apiFetch(endpoint, { method });
    assert.equal(res.status, 401, `${method} ${endpoint} should require authentication`);
  }
});

test('SRS 14/Security: a garbage or expired-looking token is rejected the same as no token', async () => {
  const res = await apiFetch('/api/dashboard/summary', { token: 'not-a-real-token' });
  assert.equal(res.status, 401);
});

test('SRS 14/Security: a token becomes invalid immediately after logout', async () => {
  const { token } = await registerVerifiedStudent('logout-boundary');
  assert.equal((await apiFetch('/api/dashboard/summary', { token })).status, 200);
  await apiFetch('/api/auth/logout', { method: 'POST', token });
  assert.equal((await apiFetch('/api/dashboard/summary', { token })).status, 401);
});

// --- Student attempting Admin API -----------------------------------------

test('SRS 14/Security: a student token is rejected by every admin-only endpoint', async () => {
  const { token } = await registerVerifiedStudent('student-vs-admin');
  const adminEndpoints = [
    ['/api/admin/stats', 'GET'],
    ['/api/admin/users', 'GET'],
    ['/api/admin/audit-logs', 'GET'],
    ['/api/faculty/999999', 'PATCH'],
    ['/api/faculty/999999', 'DELETE'],
    ['/api/faculty-reviews/pending', 'GET'],
    ['/api/social/reports', 'GET'],
    ['/api/campus/blocks', 'POST'],
  ];
  for (const [endpoint, method] of adminEndpoints) {
    const res = await apiFetch(endpoint, { method, token, body: method === 'PATCH' ? {} : undefined });
    assert.equal(res.status, 403, `student hitting ${method} ${endpoint} should be forbidden, not silently allowed`);
  }
});

// Adding a faculty member is intentionally open to any authenticated
// student (like submitting a review) — only editing/removing an existing
// record stays admin-only, covered above.
test('SRS 14/Security: a student CAN add a new faculty member (not admin-only)', async () => {
  const { token } = await registerVerifiedStudent('student-add-faculty');
  const res = await apiFetch('/api/faculty', {
    method: 'POST',
    token,
    body: { fullName: 'Dr. Security Test Add', department: 'Security Test Dept' },
  });
  assert.equal(res.status, 201);
});

test('SRS 14/Security: an admin token is accepted by the same endpoints a student was rejected from', async () => {
  const db = getDb();
  const adminRoleId = db.prepare('SELECT id FROM roles WHERE name = ?').get('admin').id;
  const { hashPassword } = await import('../src/lib/password.js');
  const passwordHash = await hashPassword('AdminPassw0rd1');
  db.prepare(
    `INSERT INTO users (full_name, email, password_hash, role_id, is_verified) VALUES (?, ?, ?, ?, 1)`
  ).run('Security Admin', 'securityadmin@vitstudent.ac.in', passwordHash, adminRoleId);
  const login = await apiFetch('/api/auth/login', {
    method: 'POST',
    body: { email: 'securityadmin@vitstudent.ac.in', password: 'AdminPassw0rd1' },
  });
  const adminToken = login.data.token;

  const res = await apiFetch('/api/admin/stats', { token: adminToken });
  assert.equal(res.status, 200);
});

// --- Invalid input --------------------------------------------------------

test('SRS 14/Security: malformed JSON body is rejected with 400, not a crash', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not valid json',
  });
  assert.equal(res.status, 400);
});

test('SRS 14/Security: missing required fields return a clear validation error, not a 500', async () => {
  const { token } = await registerVerifiedStudent('invalid-input-check');
  const res = await apiFetch('/api/social/posts', { method: 'POST', token, body: {} });
  assert.equal(res.status, 422);
  assert.ok(res.data.error);
});

test('SRS 14/Security: an out-of-range value is rejected server-side even though the frontend would normally stop it first', async () => {
  const { token } = await registerVerifiedStudent('rating-boundary');
  const db = getDb();
  const facultyId = Number(
    db.prepare('INSERT INTO faculty (full_name, department) VALUES (?, ?)').run('Sec Test Faculty', 'CS').lastInsertRowid
  );
  const res = await apiFetch(`/api/faculty/${facultyId}/reviews`, {
    method: 'POST',
    token,
    body: { rating: 99 },
  });
  assert.equal(res.status, 422);
});

// --- Rate limiting ----------------------------------------------------

test('SRS 14/Security: a write endpoint enforces its configured rate limit over real HTTP', async () => {
  const { token } = await registerVerifiedStudent('ratelimit-http-check');
  // RATE_LIMIT_MAX_POST_CREATE was set to 3 for this file specifically.
  let sawRateLimit = false;
  for (let i = 0; i < 5; i++) {
    const res = await apiFetch('/api/social/posts', { method: 'POST', token, body: { content: `post ${i}` } });
    if (res.status === 429) sawRateLimit = true;
  }
  assert.ok(sawRateLimit, 'expected a 429 after exceeding the configured post-creation rate limit');
});

test('SRS 14/Security: rate limiting is per-account, not global — a different student is unaffected', async () => {
  const { token } = await registerVerifiedStudent('ratelimit-isolation-check');
  const res = await apiFetch('/api/social/posts', { method: 'POST', token, body: { content: 'should still work' } });
  assert.equal(res.status, 201, "a fresh account's own rate-limit budget must not be affected by another account's usage");
});

// --- File upload abuse ---------------------------------------------------

test('SRS 14/Security: an oversized file is rejected server-side regardless of client-side checks', async () => {
  const { token } = await registerVerifiedStudent('oversized-upload-check');
  // Larger than MAX_DOCUMENT_BYTES (default 15MB) — construct a real PDF
  // header followed by padding so it would pass type detection and must be
  // rejected on size alone.
  const oversized = Buffer.concat([buildMinimalPdf(), Buffer.alloc(16 * 1024 * 1024, 0x41)]);
  const dataUrl = `data:application/pdf;base64,${oversized.toString('base64')}`;
  const res = await apiFetch('/api/notes', {
    method: 'POST',
    token,
    body: { fileName: 'huge.pdf', subject: 'Test', file: { dataUrl } },
  });
  assert.equal(res.status, 422);
  assert.match(res.data.error, /smaller than/i);
});

test('SRS 14/Security: a non-document masquerading as a PDF is rejected by real content inspection', async () => {
  const { token } = await registerVerifiedStudent('fake-pdf-check');
  const fake = buildRandomBytes(256);
  const dataUrl = `data:application/pdf;base64,${fake.toString('base64')}`;
  const res = await apiFetch('/api/notes', {
    method: 'POST',
    token,
    body: { fileName: 'definitely-a-pdf.pdf', subject: 'Test', file: { dataUrl } },
  });
  assert.equal(res.status, 422);
  assert.match(res.data.error, /unsupported/i);
});

test('SRS 14/Security: an oversized JSON body is rejected before it can be processed at all', async () => {
  const res = await fetch(`${baseUrl}/api/social/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'x'.repeat(30 * 1024 * 1024) }), // exceeds the 25MB router cap
  });
  assert.equal(res.status, 413);
});

// --- Security headers & CORS (supports the above, verified directly) -----

test('security headers are present on every response, including error responses', async () => {
  const res = await apiFetch('/api/dashboard/summary'); // will 401, headers should still be set
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp.includes("script-src 'self'"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  // The one deliberate, narrow frame-src grant (live campus map embed) —
  // and script-src stays exactly 'self', nothing broader.
  assert.ok(csp.includes('frame-src https://www.openstreetmap.org'));
  const scriptSrcDirective = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'));
  assert.equal(scriptSrcDirective, "script-src 'self'", 'script-src must not have grown beyond self');
  assert.ok(res.headers.get('permissions-policy'));
});

test('CORS: the configured WEB_ORIGIN is reflected, but an arbitrary origin is not', async () => {
  const allowed = await fetch(`${baseUrl}/api/health`, { headers: { Origin: 'http://example-test.local' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://example-test.local');

  const disallowed = await fetch(`${baseUrl}/api/health`, { headers: { Origin: 'http://attacker.evil' } });
  assert.equal(disallowed.headers.get('access-control-allow-origin'), null);
});

test('CORS: Access-Control-Allow-Credentials is not sent — auth here is a bearer token, not an ambient cookie', async () => {
  const res = await fetch(`${baseUrl}/api/health`, { headers: { Origin: 'http://example-test.local' } });
  assert.equal(res.headers.get('access-control-allow-credentials'), null);
});
