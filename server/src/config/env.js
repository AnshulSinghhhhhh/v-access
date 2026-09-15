// All configuration comes from environment variables. Nothing secret is
// hardcoded here. See /server/.env.example for the full list and docs.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '..', '.env');

// Minimal .env loader (no external dependency). Values already present in
// process.env (e.g. set by the shell or a host platform) are never overridden.
function loadDotEnv(file) {
  if (!existsSync(file)) return;
  const content = readFileSync(file, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(envPath);

function required(name, fallbackForDev) {
  const v = process.env[name];
  if (v) return v;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return fallbackForDev;
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),

  // Signing secret for session tokens (HMAC). MUST be set in production.
  sessionSecret: required(
    'SESSION_SECRET',
    'dev-only-insecure-secret-change-me'
  ),
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 12),

  // Only these email domains may register as students.
  allowedEmailDomains: (process.env.VIT_EMAIL_DOMAINS || 'vitstudent.ac.in')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),

  otpTtlMinutes: Number(process.env.OTP_TTL_MINUTES || 10),
  otpLength: Number(process.env.OTP_LENGTH || 6),

  // Rate limiting
  rateLimit: {
    windowMinutes: Number(process.env.RATE_LIMIT_WINDOW_MINUTES || 15),
    maxLoginAttempts: Number(process.env.RATE_LIMIT_MAX_LOGIN || 8),
    maxOtpAttempts: Number(process.env.RATE_LIMIT_MAX_OTP || 5),
    maxRegisterAttempts: Number(process.env.RATE_LIMIT_MAX_REGISTER || 5),
    // Content-creation endpoints: protects against a single account
    // spamming, since these are otherwise reachable by any authenticated
    // student with no per-action limit at all.
    maxPostCreate: Number(process.env.RATE_LIMIT_MAX_POST_CREATE || 15),
    maxCommentCreate: Number(process.env.RATE_LIMIT_MAX_COMMENT_CREATE || 30),
    maxReportSubmit: Number(process.env.RATE_LIMIT_MAX_REPORT_SUBMIT || 10),
    maxReviewSubmit: Number(process.env.RATE_LIMIT_MAX_REVIEW_SUBMIT || 10),
    maxNoteUpload: Number(process.env.RATE_LIMIT_MAX_NOTE_UPLOAD || 10),
    maxFacultyCreate: Number(process.env.RATE_LIMIT_MAX_FACULTY_CREATE || 5),
  },

  // Database file location (legacy SQLite mode — kept for local dev if
  // DATABASE_URL is not set).
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'vaccess.db'),

  // Postgres connection string (Neon, Supabase, etc). When set, the app
  // uses Postgres instead of the local SQLite file — see db.js.
  databaseUrl: process.env.DATABASE_URL || '',

  // Email service (see lib/email.js). Defaults to a console transport so
  // the app runs with zero external services in development. To send real
  // email, set EMAIL_TRANSPORT=smtp and the SMTP_* variables below.
  email: {
    transport: process.env.EMAIL_TRANSPORT || 'console',
    fromAddress: process.env.EMAIL_FROM || 'no-reply@vaccess.vit.local',
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: Number(process.env.SMTP_PORT || 587),
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
  },

  // Live campus map: OpenStreetMap's own embed endpoint is used directly
  // (see web/js/campus.js), which needs no API key or provider config —
  // this is why there's no MAP_PROVIDER/MAP_API_KEY here. Coordinates
  // themselves live in campus_locations.latitude/longitude, not env vars.

  // File storage abstraction for Notes Hub (later stage).
  storage: {
    driver: process.env.STORAGE_DRIVER || 'local',
    localDir: process.env.STORAGE_LOCAL_DIR || path.join(__dirname, '..', '..', 'data', 'uploads'),
    maxDocumentBytes: Number(process.env.NOTES_MAX_FILE_MB || 15) * 1024 * 1024,
    // Videos/audio arrive as base64 inside a JSON request body (no
    // multipart parsing in this app), which inflates size by ~4/3 — kept
    // under the router's 25MB body cap the same way document uploads are.
    maxMediaBytes: Number(process.env.SOCIAL_MAX_MEDIA_MB || 15) * 1024 * 1024,
  },

  webOrigin: process.env.WEB_ORIGIN || 'http://localhost:4000',
};
