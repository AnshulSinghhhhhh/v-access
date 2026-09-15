import { env } from '../config/env.js';

export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.status = 422;
  }
}

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export function isValidEmailFormat(email) {
  return typeof email === 'string' && EMAIL_RE.test(email.trim());
}

// REQ-1 / REQ-3: only valid VIT email domains may register or authenticate.
// Enforced here on the backend — frontend checks are a UX convenience only,
// never the security boundary.
export function isAllowedVitDomain(email) {
  if (!isValidEmailFormat(email)) return false;
  const domain = email.trim().toLowerCase().split('@')[1];
  return env.allowedEmailDomains.includes(domain);
}

export function requireString(value, field, { min = 1, max = 500 } = {}) {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} is required.`, field);
  }
  const trimmed = value.trim();
  if (trimmed.length < min) {
    throw new ValidationError(`${field} is too short.`, field);
  }
  if (trimmed.length > max) {
    throw new ValidationError(`${field} is too long.`, field);
  }
  return trimmed;
}

export function requireVitEmail(value) {
  const email = requireString(value, 'email', { min: 5, max: 254 }).toLowerCase();
  if (!isValidEmailFormat(email)) {
    throw new ValidationError('Enter a valid email address.', 'email');
  }
  if (!isAllowedVitDomain(email)) {
    throw new ValidationError(
      `Registration requires a VIT email address (${env.allowedEmailDomains.join(', ')}).`,
      'email'
    );
  }
  return email;
}

export function requireOtp(value) {
  const otp = requireString(value, 'otp', { min: env.otpLength, max: env.otpLength });
  if (!/^\d+$/.test(otp)) {
    throw new ValidationError('Verification code must be numeric.', 'otp');
  }
  return otp;
}
