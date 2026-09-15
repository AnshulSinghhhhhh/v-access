import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Point the app at a throwaway DB before any module imports it, so tests
// never touch the real development database.
const tmpDir = mkdtempSync(path.join(tmpdir(), 'vaccess-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';
process.env.VIT_EMAIL_DOMAINS = 'vitstudent.ac.in';
process.env.RATE_LIMIT_MAX_LOGIN = '3';
process.env.RATE_LIMIT_MAX_OTP = '3';
process.env.RATE_LIMIT_MAX_REGISTER = '10';

const authService = await import('../src/modules/auth/auth.service.js');
const { getDb, closeDb } = await import('../src/db/db.js');
const { resolveSession } = authService;

function getLatestOtp(email) {
  const db = getDb();
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  return db
    .prepare(
      `SELECT * FROM email_verifications WHERE user_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(user.id);
}

// The service hashes the OTP before storing it, so tests capture the
// plaintext code the same way a developer running this locally would see
// it: from the dev email transport's console output.
const originalConsoleLog = console.log;
let capturedLog = '';
console.log = (...args) => {
  capturedLog += args.join(' ') + '\n';
  originalConsoleLog(...args);
};

after(() => {
  console.log = originalConsoleLog;
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function extractOtpFromLog() {
  const match = capturedLog.match(/verification code is (\d+)/);
  return match ? match[1] : null;
}

test('registration rejects a non-VIT email domain', async () => {
  await assert.rejects(
    () => authService.register(
      { fullName: 'Test Student', email: 'test@gmail.com', password: 'Passw0rd!' },
      '127.0.0.1'
    ),
    /ValidationError|VIT email/
  );
});

test('registration rejects a weak password', async () => {
  await assert.rejects(
    () => authService.register(
      { fullName: 'Test Student', email: 'weakpw@vitstudent.ac.in', password: '123' },
      '127.0.0.2'
    )
  );
});

test('full flow: register -> verify OTP -> login -> access protected route -> logout', async () => {
  capturedLog = '';
  const email = 'jane.doe2026@vitstudent.ac.in';
  const reg = await authService.register(
    { fullName: 'Jane Doe', email, password: 'Passw0rd1' },
    '127.0.0.3'
  );
  assert.equal(reg.email, email);

  const otp = extractOtpFromLog();
  assert.ok(otp, 'OTP should have been generated and logged by the dev email transport');

  // Wrong OTP is rejected.
  await assert.rejects(() =>
    authService.verifyOtp({ email, otp: '000000' }, '127.0.0.3')
  );

  // Correct OTP succeeds.
  const verifyResult = await authService.verifyOtp({ email, otp }, '127.0.0.3');
  assert.match(verifyResult.message, /verified/i);

  // Login before verification would have failed; now it should succeed.
  const loginResult = await authService.login(
    { email, password: 'Passw0rd1' },
    { ip: '127.0.0.3', userAgent: 'node-test' }
  );
  assert.ok(loginResult.token);
  assert.equal(loginResult.user.email, email);
  assert.equal(loginResult.user.role, 'student');

  // The issued token resolves to the same user (this is the auth middleware's boundary).
  const resolved = resolveSession(loginResult.token);
  assert.equal(resolved.email, email);

  // Wrong password is rejected with a generic message (no user enumeration).
  await assert.rejects(() =>
    authService.login({ email, password: 'wrong-password' }, { ip: '127.0.0.3' })
  );

  // Logout revokes the session.
  authService.logout(loginResult.token);
  const afterLogout = resolveSession(loginResult.token);
  assert.equal(afterLogout, null);
});

test('login before email verification is rejected', async () => {
  capturedLog = '';
  const email = 'unverified2026@vitstudent.ac.in';
  await authService.register(
    { fullName: 'Unverified User', email, password: 'Passw0rd1' },
    '127.0.0.4'
  );
  await assert.rejects(() =>
    authService.login({ email, password: 'Passw0rd1' }, { ip: '127.0.0.4' })
  );
});

test('rate limiting blocks excessive login attempts', async () => {
  const email = 'ratelimited2026@vitstudent.ac.in';
  await authService.register(
    { fullName: 'Rate Limited', email, password: 'Passw0rd1' },
    '127.0.0.5'
  );
  let sawRateLimitError = false;
  for (let i = 0; i < 6; i++) {
    try {
      await authService.login(
        { email, password: 'wrong-password' },
        { ip: '127.0.0.5' }
      );
    } catch (err) {
      if (err.name === 'RateLimitError') sawRateLimitError = true;
    }
  }
  assert.ok(sawRateLimitError, 'expected rate limiting to trigger after repeated failed attempts');
});

test('password reset: full flow changes the password, revokes existing sessions, and old password stops working', async () => {
  capturedLog = '';
  const email = 'resetflow2026@vitstudent.ac.in';
  const reg = await authService.register(
    { fullName: 'Reset Flow', email, password: 'OldPassw0rd' },
    '127.0.0.10'
  );
  await authService.verifyOtp({ email, otp: extractOtpFromLog() }, '127.0.0.10');

  // Establish a live session before the reset, to prove it gets revoked.
  const loginResult = await authService.login(
    { email, password: 'OldPassw0rd' },
    { ip: '127.0.0.10' }
  );
  assert.ok(resolveSession(loginResult.token));

  capturedLog = '';
  const requestResult = await authService.requestPasswordReset({ email }, '127.0.0.11');
  assert.match(requestResult.message, /if that account exists/i);
  const resetOtp = extractOtpFromLog();
  assert.ok(resetOtp, 'a password_reset OTP should have been sent');

  await authService.resetPassword({ email, otp: resetOtp, newPassword: 'NewPassw0rd1' }, '127.0.0.11');

  // The pre-reset session must no longer resolve.
  assert.equal(resolveSession(loginResult.token), null, 'existing sessions must be revoked on password reset');

  // Old password no longer works; new password does.
  await assert.rejects(() =>
    authService.login({ email, password: 'OldPassw0rd' }, { ip: '127.0.0.11' })
  );
  const newLogin = await authService.login({ email, password: 'NewPassw0rd1' }, { ip: '127.0.0.11' });
  assert.ok(newLogin.token);
});

test('password reset does not reveal whether an account exists', async () => {
  const result = await authService.requestPasswordReset(
    { email: 'doesnotexist2026@vitstudent.ac.in' },
    '127.0.0.12'
  );
  assert.match(result.message, /if that account exists/i);
});

test('password reset rejects a weak new password', async () => {
  capturedLog = '';
  const email = 'weakresetpw2026@vitstudent.ac.in';
  await authService.register({ fullName: 'Weak Reset', email, password: 'Passw0rd1' }, '127.0.0.13');
  await authService.verifyOtp({ email, otp: extractOtpFromLog() }, '127.0.0.13');

  capturedLog = '';
  await authService.requestPasswordReset({ email }, '127.0.0.14');
  const otp = extractOtpFromLog();

  await assert.rejects(() =>
    authService.resetPassword({ email, otp, newPassword: '123' }, '127.0.0.14')
  );
});

test('password reset rejects an incorrect code', async () => {
  capturedLog = '';
  const email = 'wrongresetcode2026@vitstudent.ac.in';
  await authService.register({ fullName: 'Wrong Code', email, password: 'Passw0rd1' }, '127.0.0.15');
  await authService.verifyOtp({ email, otp: extractOtpFromLog() }, '127.0.0.15');

  await authService.requestPasswordReset({ email }, '127.0.0.16');
  await assert.rejects(() =>
    authService.resetPassword({ email, otp: '000000', newPassword: 'NewPassw0rd1' }, '127.0.0.16')
  );
});
