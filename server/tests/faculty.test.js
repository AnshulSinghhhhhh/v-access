import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpDir = mkdtempSync(path.join(tmpdir(), 'vaccess-faculty-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';
// Raised so review-submission rate limiting (tested separately in
// security.test.js) doesn't interfere with the many functional cases here.
process.env.RATE_LIMIT_MAX_REVIEW_SUBMIT = '100';
process.env.RATE_LIMIT_MAX_FACULTY_CREATE = '100';

const { getDb, closeDb } = await import('../src/db/db.js');
const facultyService = await import('../src/modules/faculty/faculty.service.js');

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const STUDENT_A = 1;
const STUDENT_B = 2;
const ADMIN_ID = 3;
let facultyId;

{
  const db = getDb();
  const studentRoleId = db.prepare('SELECT id FROM roles WHERE name = ?').get('student').id;
  const adminRoleId = db.prepare('SELECT id FROM roles WHERE name = ?').get('admin').id;
  db.prepare('INSERT INTO users (id, full_name, email, password_hash, role_id, is_verified) VALUES (?, ?, ?, ?, ?, 1)')
    .run(STUDENT_A, 'Student A', 'a@vitstudent.ac.in', 'x', studentRoleId);
  db.prepare('INSERT INTO users (id, full_name, email, password_hash, role_id, is_verified) VALUES (?, ?, ?, ?, ?, 1)')
    .run(STUDENT_B, 'Student B', 'b@vitstudent.ac.in', 'x', studentRoleId);
  db.prepare('INSERT INTO users (id, full_name, email, password_hash, role_id, is_verified) VALUES (?, ?, ?, ?, ?, 1)')
    .run(ADMIN_ID, 'The Admin', 'admin@vitstudent.ac.in', 'x', adminRoleId);

  const result = facultyService.createFaculty(ADMIN_ID, {
    fullName: 'Dr. Test Faculty',
    department: 'School of Computer Science',
    designation: 'Professor',
    bio: 'Test bio',
  });
  facultyId = result.id;
}

test('a newly created faculty member has no rating yet', () => {
  const detail = facultyService.getFacultyDetail(facultyId);
  assert.equal(detail.averageRating, null);
  assert.equal(detail.reviewCount, 0);
  assert.equal(detail.reviews.length, 0);
});

test('submitReview rejects an out-of-range rating', () => {
  assert.throws(() => facultyService.submitReview(STUDENT_A, facultyId, { rating: 6 }));
  assert.throws(() => facultyService.submitReview(STUDENT_A, facultyId, { rating: 0 }));
});

let reviewAId;

test('a pending review is not visible in faculty detail until approved', () => {
  const submitted = facultyService.submitReview(STUDENT_A, facultyId, {
    rating: 5,
    reviewText: 'Excellent teacher, very clear explanations.',
    isAnonymous: false,
  });
  reviewAId = submitted.id;
  assert.equal(submitted.status, 'pending');

  const detail = facultyService.getFacultyDetail(facultyId);
  assert.equal(detail.reviewCount, 0, 'pending reviews must not count toward the public average');
  assert.equal(detail.reviews.length, 0, 'pending reviews must not be publicly visible');
});

test('the same student cannot submit a second review for the same faculty member', () => {
  assert.throws(
    () => facultyService.submitReview(STUDENT_A, facultyId, { rating: 3 }),
    /already submitted/i
  );
});

test('a different student CAN submit their own review for the same faculty member', () => {
  const submitted = facultyService.submitReview(STUDENT_B, facultyId, {
    rating: 3,
    reviewText: 'Decent, but pace was fast.',
    isAnonymous: true,
  });
  assert.ok(submitted.id);
});

test('admin sees both reviews in the pending moderation queue, with real identity even for anonymous ones', () => {
  const pending = facultyService.listPendingReviews();
  assert.equal(pending.length, 2);
  const anonymousOne = pending.find((r) => r.isAnonymous);
  assert.equal(anonymousOne.submittedBy, 'Student B', 'moderators must see who submitted it, even if anonymous to other students');
});

test('approving a review makes it publicly visible and folds it into the average, respecting anonymity', () => {
  facultyService.moderateReview(ADMIN_ID, reviewAId, 'approved');
  const detail = facultyService.getFacultyDetail(facultyId);
  assert.equal(detail.reviewCount, 1);
  assert.equal(detail.averageRating, 5);
  assert.equal(detail.reviews[0].reviewerName, 'Student A');
});

test('rejecting a review keeps it out of the public list and average permanently', () => {
  const pending = facultyService.listPendingReviews();
  const reviewB = pending[0];
  facultyService.moderateReview(ADMIN_ID, reviewB.id, 'rejected');

  const detail = facultyService.getFacultyDetail(facultyId);
  assert.equal(detail.reviewCount, 1, 'rejected review must not count');
  assert.equal(detail.reviews.length, 1);
});

test('an anonymous approved review hides the reviewer name from students', () => {
  // Re-submit as student B is blocked (already has one, now rejected but
  // still exists) — instead verify anonymity via a fresh faculty + review.
  const f2 = facultyService.createFaculty(STUDENT_A, { fullName: 'Dr. Anon Test', department: 'CS' });
  const submitted = facultyService.submitReview(STUDENT_B, f2.id, {
    rating: 4,
    reviewText: 'Good course overall.',
    isAnonymous: true,
  });
  facultyService.moderateReview(ADMIN_ID, submitted.id, 'approved');
  const detail = facultyService.getFacultyDetail(f2.id);
  assert.equal(detail.reviews[0].reviewerName, 'Anonymous student');
});

test('removeReview deletes a review regardless of status (moderation removal)', () => {
  const before = facultyService.getFacultyDetail(facultyId);
  assert.equal(before.reviewCount, 1);
  facultyService.removeReview(ADMIN_ID, reviewAId);
  const after1 = facultyService.getFacultyDetail(facultyId);
  assert.equal(after1.reviewCount, 0);
  assert.equal(after1.reviews.length, 0);
});

test('listFaculty search filters by name or department', () => {
  const byName = facultyService.listFaculty({ search: 'Test Faculty' });
  assert.ok(byName.some((f) => f.id === facultyId));
  const byDept = facultyService.listFaculty({ search: 'computer science' });
  assert.ok(byDept.length > 0);
});

test('deleteFaculty cascades and removes associated reviews', () => {
  const f3 = facultyService.createFaculty(STUDENT_A, { fullName: 'Dr. Temp', department: 'CS' });
  facultyService.submitReview(STUDENT_B, f3.id, { rating: 5 });
  facultyService.deleteFaculty(f3.id);
  assert.throws(() => facultyService.getFacultyDetail(f3.id), /not found/i);
});

test('a student (non-admin) can add a new faculty member', () => {
  const created = facultyService.createFaculty(STUDENT_A, {
    fullName: 'Dr. Student Added',
    department: 'School of Mechanical Engineering',
  });
  const detail = facultyService.getFacultyDetail(created.id);
  assert.equal(detail.fullName, 'Dr. Student Added');
});

test('createFaculty rejects a duplicate name + department pair', () => {
  facultyService.createFaculty(STUDENT_A, { fullName: 'Dr. Duplicate Test', department: 'Physics' });
  assert.throws(
    () => facultyService.createFaculty(STUDENT_B, { fullName: 'dr. duplicate test', department: 'physics' }),
    /already exists/i
  );
});
