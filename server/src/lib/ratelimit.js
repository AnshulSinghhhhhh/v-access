import { getDb } from '../db/db.js';
import { env } from '../config/env.js';

export class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitError';
    this.status = 429;
  }
}

// Sliding-window limiter: counts attempts for `identifier`+`kind` within the
// configured window and throws once the limit is hit. Call recordAttempt()
// after checking, regardless of whether the attempt succeeds, so repeated
// failures (e.g. password guessing) are throttled.
export async function checkRateLimit(identifier, kind) {
  const db = await getDb();
  const windowStart = new Date(
    Date.now() - env.rateLimit.windowMinutes * 60 * 1000
  ).toISOString();

  const { count } = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM auth_attempts
       WHERE identifier = ? AND kind = ? AND created_at >= ?`
    )
    .get(identifier, kind, windowStart);

  const limits = {
    login: env.rateLimit.maxLoginAttempts,
    register: env.rateLimit.maxRegisterAttempts,
    otp: env.rateLimit.maxOtpAttempts,
    post_create: env.rateLimit.maxPostCreate,
    comment_create: env.rateLimit.maxCommentCreate,
    report_submit: env.rateLimit.maxReportSubmit,
    review_submit: env.rateLimit.maxReviewSubmit,
    note_upload: env.rateLimit.maxNoteUpload,
    faculty_create: env.rateLimit.maxFacultyCreate,
  };
  const limit = limits[kind] ?? 10;

  if (count >= limit) {
    throw new RateLimitError(
      `Too many attempts. Try again in a few minutes.`
    );
  }
}

export async function recordAttempt(identifier, kind) {
  const db = await getDb();
  await db.prepare('INSERT INTO auth_attempts (identifier, kind) VALUES (?, ?)').run(
    identifier,
    kind
  );
}
