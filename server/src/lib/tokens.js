import { randomBytes, createHash, randomInt } from 'node:crypto';

// Opaque bearer tokens (not JWT): the token itself is random and meaningless;
// only its SHA-256 hash is stored server-side in `sessions`. This makes
// logout / revoke-all-sessions immediate, and a stolen DB dump alone cannot
// be replayed as a working session.
export function generateSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

// Numeric OTP, generated with a CSPRNG (not Math.random).
export function generateOtp(length = 6) {
  let otp = '';
  for (let i = 0; i < length; i++) {
    otp += String(randomInt(0, 10));
  }
  return otp;
}
