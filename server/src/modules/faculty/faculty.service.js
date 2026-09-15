import { getDb } from '../../db/db.js';
import { ValidationError, requireString } from '../../lib/validate.js';
import { logAudit } from '../../lib/audit.js';
import { checkRateLimit, recordAttempt } from '../../lib/ratelimit.js';

function notFound(message) {
  const err = new ValidationError(message, 'id');
  err.status = 404;
  return err;
}

// --- Read: search, list, detail (any authenticated user) -----------------

export async function listFaculty({ search } = {}) {
  const db = await getDb();
  let rows;
  if (search) {
    const like = `%${search.toLowerCase()}%`;
    rows = await db
      .prepare(
        `SELECT * FROM faculty
         WHERE LOWER(full_name) LIKE ? OR LOWER(department) LIKE ?
         ORDER BY full_name`
      )
      .all(like, like);
  } else {
    rows = await db.prepare('SELECT * FROM faculty ORDER BY full_name').all();
  }

  const statsStmt = db.prepare(
    `SELECT AVG(rating) AS avg_rating, COUNT(*) AS review_count
     FROM reviews WHERE faculty_id = ? AND status = 'approved'`
  );

  const out = [];
  for (const f of rows) {
    const stats = await statsStmt.get(f.id);
    out.push(formatFaculty(f, stats));
  }
  return out;
}

export async function getFacultyDetail(facultyId) {
  const db = await getDb();
  const faculty = await db.prepare('SELECT * FROM faculty WHERE id = ?').get(facultyId);
  if (!faculty) throw notFound('Faculty member not found.');

  const stats = await db
    .prepare(
      `SELECT AVG(rating) AS avg_rating, COUNT(*) AS review_count
       FROM reviews WHERE faculty_id = ? AND status = 'approved'`
    )
    .get(facultyId);

  const reviewRows = await db
    .prepare(
      `SELECT reviews.*, users.full_name AS reviewer_name
       FROM reviews
       JOIN users ON users.id = reviews.student_id
       WHERE reviews.faculty_id = ? AND reviews.status = 'approved'
       ORDER BY reviews.created_at DESC`
    )
    .all(facultyId);

  return {
    ...formatFaculty(faculty, stats),
    bio: faculty.bio,
    email: faculty.email,
    reviews: reviewRows.map(formatReview),
  };
}

// Tells the student whether they've already reviewed this faculty member,
// and with what — lets the frontend show "you already reviewed this" instead
// of a bare form, without exposing other students' unapproved reviews.
export async function getMyReviewForFaculty(studentId, facultyId) {
  const db = await getDb();
  const row = await db
    .prepare('SELECT * FROM reviews WHERE faculty_id = ? AND student_id = ?')
    .get(facultyId, studentId);
  return row ? formatReview({ ...row, reviewer_name: null }) : null;
}

function formatFaculty(f, stats) {
  return {
    id: f.id,
    fullName: f.full_name,
    department: f.department,
    designation: f.designation,
    averageRating: stats.avg_rating ? Math.round(stats.avg_rating * 10) / 10 : null,
    reviewCount: Number(stats.review_count),
  };
}

function formatReview(r) {
  return {
    id: r.id,
    rating: r.rating,
    reviewText: r.review_text,
    isAnonymous: !!r.is_anonymous,
    status: r.status,
    createdAt: r.created_at,
    reviewerName: r.is_anonymous ? 'Anonymous student' : r.reviewer_name,
  };
}

// --- Student: submit a review ---------------------------------------------

export async function submitReview(studentId, facultyId, { rating, reviewText, isAnonymous }) {
  await checkRateLimit(String(studentId), 'review_submit');
  await recordAttempt(String(studentId), 'review_submit');

  const db = await getDb();
  const faculty = await db.prepare('SELECT id FROM faculty WHERE id = ?').get(facultyId);
  if (!faculty) throw notFound('Faculty member not found.');

  const numericRating = Number(rating);
  if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
    throw new ValidationError('Rating must be a whole number from 1 to 5.', 'rating');
  }
  const cleanText = reviewText
    ? requireString(reviewText, 'reviewText', { min: 1, max: 2000 })
    : null;

  try {
    const result = await db
      .prepare(
        `INSERT INTO reviews (faculty_id, student_id, rating, review_text, is_anonymous, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`
      )
      .run(facultyId, studentId, numericRating, cleanText, isAnonymous ? 1 : 0);
    await logAudit({ actorId: studentId, action: 'review.submit', targetType: 'review', targetId: Number(result.lastInsertRowid) });
    return { id: Number(result.lastInsertRowid), status: 'pending' };
  } catch (err) {
    if (err.code === '23505') {
      // REQ-12, enforced at the database level (reviews.UNIQUE(faculty_id, student_id))
      // as well as here — this catch is the application-level half of that rule.
      throw new ValidationError('You have already submitted a review for this faculty member.', 'rating');
    }
    throw err;
  }
}

// --- Admin: faculty management ---------------------------------------------

export async function createFaculty(actorId, { fullName, department, designation, email, bio }) {
  await checkRateLimit(String(actorId), 'faculty_create');
  await recordAttempt(String(actorId), 'faculty_create');

  const cleanName = requireString(fullName, 'fullName', { min: 2, max: 120 });
  const cleanDept = requireString(department, 'department', { min: 2, max: 120 });

  const db = await getDb();
  // Anyone authenticated can add a faculty member (see faculty.routes.js),
  // so guard against accidental/duplicate entries for the same person —
  // case-insensitive match on name + department.
  const duplicate = await db
    .prepare('SELECT id FROM faculty WHERE LOWER(full_name) = LOWER(?) AND LOWER(department) = LOWER(?)')
    .get(cleanName, cleanDept);
  if (duplicate) {
    throw new ValidationError('A faculty member with this name already exists in that department.', 'fullName');
  }

  const result = await db
    .prepare(
      `INSERT INTO faculty (full_name, department, designation, email, bio) VALUES (?, ?, ?, ?, ?)`
    )
    .run(cleanName, cleanDept, designation || null, email || null, bio || null);
  const facultyId = Number(result.lastInsertRowid);
  await logAudit({ actorId, action: 'faculty.create', targetType: 'faculty', targetId: facultyId });
  return { id: facultyId };
}

export async function updateFaculty(facultyId, { fullName, department, designation, email, bio }) {
  const db = await getDb();
  const existing = await db.prepare('SELECT * FROM faculty WHERE id = ?').get(facultyId);
  if (!existing) throw notFound('Faculty member not found.');

  const cleanName = fullName !== undefined ? requireString(fullName, 'fullName', { min: 2, max: 120 }) : existing.full_name;
  const cleanDept = department !== undefined ? requireString(department, 'department', { min: 2, max: 120 }) : existing.department;

  await db.prepare(
    `UPDATE faculty SET full_name = ?, department = ?, designation = ?, email = ?, bio = ? WHERE id = ?`
  ).run(
    cleanName,
    cleanDept,
    designation !== undefined ? designation : existing.designation,
    email !== undefined ? email : existing.email,
    bio !== undefined ? bio : existing.bio,
    facultyId
  );
  return { id: facultyId };
}

export async function deleteFaculty(facultyId) {
  const db = await getDb();
  const existing = await db.prepare('SELECT id FROM faculty WHERE id = ?').get(facultyId);
  if (!existing) throw notFound('Faculty member not found.');
  await db.prepare('DELETE FROM faculty WHERE id = ?').run(facultyId); // cascades to reviews
}

// --- Admin: review moderation ----------------------------------------------

export async function listPendingReviews() {
  const db = await getDb();
  const rows = await db
    .prepare(
      `SELECT reviews.*, faculty.full_name AS faculty_name, users.full_name AS reviewer_name, users.email AS reviewer_email
       FROM reviews
       JOIN faculty ON faculty.id = reviews.faculty_id
       JOIN users ON users.id = reviews.student_id
       WHERE reviews.status = 'pending'
       ORDER BY reviews.created_at ASC`
    )
    .all();

  return rows.map((r) => ({
    id: r.id,
    facultyId: r.faculty_id,
    facultyName: r.faculty_name,
    rating: r.rating,
    reviewText: r.review_text,
    isAnonymous: !!r.is_anonymous,
    // Moderators need to know who submitted it even for an "anonymous"
    // review — anonymity is about what OTHER students see, not accountability.
    submittedBy: r.reviewer_name,
    submittedByEmail: r.reviewer_email,
    createdAt: r.created_at,
  }));
}

export async function moderateReview(adminId, reviewId, status) {
  if (!['approved', 'rejected'].includes(status)) {
    throw new ValidationError('Status must be "approved" or "rejected".', 'status');
  }
  const db = await getDb();
  const review = await db.prepare('SELECT * FROM reviews WHERE id = ?').get(reviewId);
  if (!review) throw notFound('Review not found.');

  await db.prepare('UPDATE reviews SET status = ? WHERE id = ?').run(status, reviewId);
  await logAudit({ actorId: adminId, action: `review.${status}`, targetType: 'review', targetId: reviewId });
  return { id: reviewId, status };
}

export async function removeReview(adminId, reviewId) {
  const db = await getDb();
  const review = await db.prepare('SELECT id FROM reviews WHERE id = ?').get(reviewId);
  if (!review) throw notFound('Review not found.');
  await db.prepare('DELETE FROM reviews WHERE id = ?').run(reviewId);
  await logAudit({ actorId: adminId, action: 'review.remove', targetType: 'review', targetId: reviewId });
}
