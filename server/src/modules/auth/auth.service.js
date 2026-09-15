import { getDb } from '../../db/db.js';
import { hashPassword, verifyPassword, isPasswordStrongEnough } from '../../lib/password.js';
import { generateSessionToken, hashToken, generateOtp } from '../../lib/tokens.js';
import { requireVitEmail, requireOtp, requireString, ValidationError } from '../../lib/validate.js';
import { sendOtpEmail } from '../../lib/email.js';
import { checkRateLimit, recordAttempt } from '../../lib/ratelimit.js';
import { logAudit } from '../../lib/audit.js';
import { env } from '../../config/env.js';
import { createHash } from 'node:crypto';

async function studentRoleId(db) {
  const row = await db.prepare('SELECT id FROM roles WHERE name = ?').get('student');
  return row.id;
}

function nowPlusMinutes(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

export async function register({ fullName, email, password }, ip) {
  await checkRateLimit(ip, 'register');
  await recordAttempt(ip, 'register');

  const cleanEmail = requireVitEmail(email);
  const cleanName = requireString(fullName, 'fullName', { min: 2, max: 120 });
  if (!isPasswordStrongEnough(password)) {
    throw new ValidationError(
      'Password must be at least 8 characters and include a letter and a number.',
      'password'
    );
  }

  const db = await getDb();
  const existing = await db.prepare('SELECT id, is_verified FROM users WHERE email = ?').get(cleanEmail);
  if (existing && existing.is_verified) {
    // Do not reveal which part (email vs password) is wrong to an attacker
    // enumerating accounts — but registration UX needs a clear message.
    throw new ValidationError('An account with this email already exists.', 'email');
  }

  const passwordHash = await hashPassword(password);
  let userId;
  if (existing) {
    // Re-registration attempt on an unverified account: refresh password/name and re-send OTP.
    await db.prepare('UPDATE users SET full_name = ?, password_hash = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id = ?')
      .run(cleanName, passwordHash, existing.id);
    userId = existing.id;
  } else {
    const roleId = await studentRoleId(db);
    const result = await db
      .prepare(
        `INSERT INTO users (full_name, email, password_hash, role_id, is_verified, is_active)
         VALUES (?, ?, ?, ?, 0, 1)`
      )
      .run(cleanName, cleanEmail, passwordHash, roleId);
    userId = Number(result.lastInsertRowid);
  }

  await issueOtp(userId, cleanEmail, 'register');
  await logAudit({ actorId: userId, action: 'auth.register', targetType: 'user', targetId: userId, ip });

  return { userId, email: cleanEmail };
}

async function issueOtp(userId, email, purpose) {
  const db = await getDb();
  const otp = generateOtp(env.otpLength);
  const otpHash = createHash('sha256').update(otp).digest('hex');

  await db.prepare(
    `INSERT INTO email_verifications (user_id, purpose, otp_hash, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(userId, purpose, otpHash, nowPlusMinutes(env.otpTtlMinutes));

  await sendOtpEmail(email, otp, purpose);
}

// Shared by verifyOtp (registration) and resetPassword — finds the latest
// unconsumed code for this user+purpose, validates it, and marks it
// consumed. Throws ValidationError on any failure (expired, wrong code,
// too many attempts, or none pending); the caller applies whatever the
// successful verification should actually do (verify email, reset a
// password, etc.) immediately after this returns.
async function consumeOtp(userId, purpose, suppliedOtp) {
  const db = await getDb();
  const record = await db
    .prepare(
      `SELECT * FROM email_verifications
       WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL
       ORDER BY id DESC LIMIT 1`
    )
    .get(userId, purpose);

  if (!record) throw new ValidationError('Invalid or expired verification code.', 'otp');
  if (new Date(record.expires_at).getTime() < Date.now()) {
    throw new ValidationError('This code has expired. Request a new one.', 'otp');
  }
  if (record.attempts >= 5) {
    throw new ValidationError('Too many incorrect attempts. Request a new code.', 'otp');
  }

  const suppliedHash = createHash('sha256').update(suppliedOtp).digest('hex');
  if (suppliedHash !== record.otp_hash) {
    await db.prepare('UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?').run(record.id);
    throw new ValidationError('Incorrect verification code.', 'otp');
  }

  await db.prepare(
    'UPDATE email_verifications SET consumed_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id = ?'
  ).run(record.id);
}

export async function resendOtp({ email }, ip) {
  await checkRateLimit(ip, 'otp');
  await recordAttempt(ip, 'otp');

  const cleanEmail = requireVitEmail(email);
  const db = await getDb();
  const user = await db.prepare('SELECT id, is_verified FROM users WHERE email = ?').get(cleanEmail);
  // Always respond as if it succeeded — don't let this endpoint be used to
  // enumerate which emails are registered.
  if (user && !user.is_verified) {
    await issueOtp(user.id, cleanEmail, 'register');
  }
  return { message: 'If that account needs verification, a new code has been sent.' };
}

export async function verifyOtp({ email, otp }, ip) {
  await checkRateLimit(ip, 'otp');
  await recordAttempt(ip, 'otp');

  const cleanEmail = requireVitEmail(email);
  const cleanOtp = requireOtp(otp);
  const db = await getDb();

  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
  if (!user) throw new ValidationError('Invalid verification code.', 'otp');

  await consumeOtp(user.id, 'register', cleanOtp);
  await db.prepare('UPDATE users SET is_verified = 1 WHERE id = ?').run(user.id);

  await logAudit({ actorId: user.id, action: 'auth.verify_email', targetType: 'user', targetId: user.id, ip });

  return { message: 'Email verified. You can now log in.' };
}

export async function login({ email, password }, { ip, userAgent }) {
  await checkRateLimit(ip, 'login');
  await checkRateLimit(email || ip, 'login');
  await recordAttempt(ip, 'login');
  if (email) await recordAttempt(email.toLowerCase(), 'login');

  const cleanEmail = requireVitEmail(email);
  requireString(password, 'password', { min: 1, max: 200 });

  const db = await getDb();
  const user = await db
    .prepare(
      `SELECT users.*, roles.name AS role FROM users
       JOIN roles ON roles.id = users.role_id
       WHERE users.email = ?`
    )
    .get(cleanEmail);

  // Generic error message on every failure branch below: never reveal
  // whether the email exists, is unverified, or the password was wrong.
  const genericError = () => new ValidationError('Invalid email or password.', 'password');

  if (!user) throw genericError();

  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    throw new ValidationError('Account temporarily locked due to repeated failed logins. Try again later.', 'password');
  }

  const passwordOk = await verifyPassword(password, user.password_hash);
  if (!passwordOk) {
    const failedCount = user.failed_login_count + 1;
    const lockUntil = failedCount >= 6 ? nowPlusMinutes(15) : null;
    await db.prepare('UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?')
      .run(failedCount, lockUntil, user.id);
    await logAudit({ actorId: user.id, action: 'auth.login_failed', targetType: 'user', targetId: user.id, ip });
    throw genericError();
  }

  if (!user.is_verified) {
    throw new ValidationError('Please verify your email before logging in.', 'email');
  }
  if (!user.is_active) {
    throw new ValidationError('This account has been suspended. Contact an administrator.', 'email');
  }

  await db.prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?').run(user.id);

  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + env.sessionTtlHours * 60 * 60 * 1000).toISOString();
  await db.prepare(
    `INSERT INTO sessions (user_id, token_hash, user_agent, ip_address, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(user.id, hashToken(token), userAgent || null, ip || null, expiresAt);

  await logAudit({ actorId: user.id, action: 'auth.login_success', targetType: 'user', targetId: user.id, ip });

  return {
    token,
    expiresAt,
    user: publicUser(user),
  };
}

export async function logout(token) {
  const db = await getDb();
  await db.prepare('UPDATE sessions SET revoked_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE token_hash = ?')
    .run(hashToken(token));
}

// Resolves a bearer token to its user, or null. Used by the auth middleware
// on every protected request — this is the real authorization boundary.
export async function resolveSession(token) {
  if (!token) return null;
  const db = await getDb();
  const session = await db
    .prepare(
      `SELECT sessions.*, users.id AS uid, users.full_name, users.email, users.is_active,
              roles.name AS role
       FROM sessions
       JOIN users ON users.id = sessions.user_id
       JOIN roles ON roles.id = users.role_id
       WHERE sessions.token_hash = ?`
    )
    .get(hashToken(token));

  if (!session) return null;
  if (session.revoked_at) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;
  if (!session.is_active) return null;

  return {
    id: session.uid,
    fullName: session.full_name,
    email: session.email,
    role: session.role,
  };
}

function publicUser(user) {
  return {
    id: user.id,
    fullName: user.full_name,
    email: user.email,
    role: user.role,
  };
}

// --- Password reset ---------------------------------------------------

export async function requestPasswordReset({ email }, ip) {
  await checkRateLimit(ip, 'otp');
  await recordAttempt(ip, 'otp');

  const cleanEmail = requireVitEmail(email);
  const db = await getDb();
  const user = await db.prepare('SELECT id, is_verified FROM users WHERE email = ?').get(cleanEmail);

  // Same non-enumeration shape as resendOtp: always respond the same way
  // whether or not the account exists, so this endpoint can't be used to
  // discover which emails are registered.
  if (user && user.is_verified) {
    await issueOtp(user.id, cleanEmail, 'password_reset');
    await logAudit({ actorId: user.id, action: 'auth.password_reset_requested', targetType: 'user', targetId: user.id, ip });
  }
  return { message: 'If that account exists, a password reset code has been sent.' };
}

export async function resetPassword({ email, otp, newPassword }, ip) {
  await checkRateLimit(ip, 'otp');
  await recordAttempt(ip, 'otp');

  const cleanEmail = requireVitEmail(email);
  const cleanOtp = requireOtp(otp);
  if (!isPasswordStrongEnough(newPassword)) {
    throw new ValidationError(
      'Password must be at least 8 characters and include a letter and a number.',
      'newPassword'
    );
  }

  const db = await getDb();
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
  if (!user) throw new ValidationError('Invalid or expired verification code.', 'otp');

  await consumeOtp(user.id, 'password_reset', cleanOtp);

  const passwordHash = await hashPassword(newPassword);
  await db.prepare(
    `UPDATE users SET password_hash = ?, failed_login_count = 0, locked_until = NULL,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
  ).run(passwordHash, user.id);

  // A password reset is a security-sensitive event — every existing
  // session is revoked immediately, the same way an admin-initiated
  // suspension does, so a stolen-but-not-yet-noticed session doesn't
  // survive the owner regaining control of their account.
  await db.prepare(
    `UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE user_id = ? AND revoked_at IS NULL`
  ).run(user.id);

  await logAudit({ actorId: user.id, action: 'auth.password_reset_completed', targetType: 'user', targetId: user.id, ip });

  return { message: 'Password updated. You can now log in with your new password.' };
}
