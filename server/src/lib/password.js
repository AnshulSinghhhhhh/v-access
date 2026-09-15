import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

const KEY_LENGTH = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 }; // OWASP-recommended baseline

// Stored format: scrypt$N$r$p$saltHex$hashHex
export async function hashPassword(plainPassword) {
  const salt = randomBytes(16);
  const derivedKey = await scrypt(plainPassword, salt, KEY_LENGTH, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
}

export async function verifyPassword(plainPassword, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derivedKey = await scrypt(plainPassword, salt, expected.length, {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr),
  });
  if (derivedKey.length !== expected.length) return false;
  return timingSafeEqual(derivedKey, expected);
}

// Minimum password policy, enforced server-side (never trust the client).
export function isPasswordStrongEnough(plainPassword) {
  return (
    typeof plainPassword === 'string' &&
    plainPassword.length >= 8 &&
    /[A-Za-z]/.test(plainPassword) &&
    /[0-9]/.test(plainPassword)
  );
}
