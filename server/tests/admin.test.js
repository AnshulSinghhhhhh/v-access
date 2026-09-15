import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpDir = mkdtempSync(path.join(tmpdir(), 'vaccess-admin-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

const { getDb, closeDb } = await import('../src/db/db.js');
const adminService = await import('../src/modules/admin/admin.service.js');
const { generateSessionToken, hashToken } = await import('../src/lib/tokens.js');
const { resolveSession } = await import('../src/modules/auth/auth.service.js');
const facultyService = await import('../src/modules/faculty/faculty.service.js');

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const ADMIN_ID = 1;
const ADMIN_2_ID = 2;
const STUDENT_ID = 3;
const STUDENT_2_ID = 4;

{
  const db = getDb();
  const studentRoleId = db.prepare('SELECT id FROM roles WHERE name = ?').get('student').id;
  const adminRoleId = db.prepare('SELECT id FROM roles WHERE name = ?').get('admin').id;
  db.prepare('INSERT INTO users (id, full_name, email, password_hash, role_id, is_verified) VALUES (?, ?, ?, ?, ?, 1)')
    .run(ADMIN_ID, 'Admin One', 'admin1@vitstudent.ac.in', 'x', adminRoleId);
  db.prepare('INSERT INTO users (id, full_name, email, password_hash, role_id, is_verified) VALUES (?, ?, ?, ?, ?, 1)')
    .run(ADMIN_2_ID, 'Admin Two', 'admin2@vitstudent.ac.in', 'x', adminRoleId);
  db.prepare('INSERT INTO users (id, full_name, email, password_hash, role_id, is_verified) VALUES (?, ?, ?, ?, ?, 1)')
    .run(STUDENT_ID, 'Student One', 'student1@vitstudent.ac.in', 'x', studentRoleId);
  db.prepare('INSERT INTO users (id, full_name, email, password_hash, role_id, is_verified) VALUES (?, ?, ?, ?, ?, 1)')
    .run(STUDENT_2_ID, 'Student Two', 'student2@vitstudent.ac.in', 'x', studentRoleId);

  // Faculty + a pending review, so stats have real non-zero numbers to check.
  const facultyResult = db.prepare('INSERT INTO faculty (full_name, department) VALUES (?, ?)').run('Dr. Stats Test', 'CS');
  db.prepare(`INSERT INTO reviews (faculty_id, student_id, rating, status) VALUES (?, ?, 5, 'pending')`)
    .run(Number(facultyResult.lastInsertRowid), STUDENT_ID);

  // A post and a pending report on it.
  const postResult = db.prepare(`INSERT INTO posts (author_id, content, status) VALUES (?, ?, 'active')`).run(STUDENT_ID, 'Hello');
  db.prepare(`INSERT INTO reports (post_id, reported_by, reason, status) VALUES (?, ?, 'spam', 'pending')`)
    .run(Number(postResult.lastInsertRowid), STUDENT_2_ID);

  // A note.
  db.prepare(
    `INSERT INTO notes (uploaded_by, file_name, subject, file_type, file_size, storage_ref) VALUES (?, ?, ?, 'pdf', 100, 'x.pdf')`
  ).run(STUDENT_ID, 'notes.pdf', 'Test Subject');
}

test('getStats reflects real counts across every module', () => {
  const stats = adminService.getStats();
  assert.equal(stats.totalStudents, 2);
  assert.equal(stats.totalFaculty, 1);
  assert.equal(stats.totalReviews, 1);
  assert.equal(stats.pendingReviews, 1);
  assert.equal(stats.totalPosts, 1);
  assert.equal(stats.reportedPosts, 1);
  assert.equal(stats.totalNotes, 1);
});

test('getStats pendingReviews drops once a review is approved, without changing totalReviews', () => {
  const pending = facultyService.listPendingReviews();
  facultyService.moderateReview(ADMIN_ID, pending[0].id, 'approved');
  const stats = adminService.getStats();
  assert.equal(stats.totalReviews, 1);
  assert.equal(stats.pendingReviews, 0);
});

test('listUsers finds by search and filters by role', () => {
  const bySearch = adminService.listUsers({ search: 'Student One' });
  assert.ok(bySearch.some((u) => u.id === STUDENT_ID));

  const admins = adminService.listUsers({ role: 'admin' });
  assert.equal(admins.length, 2);
  assert.ok(admins.every((u) => u.role === 'admin'));
});

test('an admin cannot suspend their own account', () => {
  assert.throws(() => adminService.updateUser(ADMIN_ID, ADMIN_ID, { isActive: false }), /cannot suspend your own/i);
});

test('an admin cannot change their own role', () => {
  assert.throws(() => adminService.updateUser(ADMIN_ID, ADMIN_ID, { role: 'student' }), /cannot change your own role/i);
});

test('suspending a different user works and immediately revokes their live sessions', () => {
  // Give the student a live session directly (bypassing login, since this
  // test only needs a valid session row to prove revocation happens).
  const db = getDb();
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  db.prepare('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(STUDENT_2_ID, hashToken(token), expiresAt);

  assert.ok(resolveSession(token), 'session should resolve before suspension');

  const updated = adminService.updateUser(ADMIN_ID, STUDENT_2_ID, { isActive: false });
  assert.equal(updated.isActive, false);

  assert.equal(resolveSession(token), null, 'session must be revoked immediately upon suspension');
});

test('reactivating a suspended user works', () => {
  const updated = adminService.updateUser(ADMIN_ID, STUDENT_2_ID, { isActive: true });
  assert.equal(updated.isActive, true);
});

test('promoting a student to admin and back works, and a different admin CAN change it', () => {
  const promoted = adminService.updateUser(ADMIN_ID, STUDENT_ID, { role: 'admin' });
  assert.equal(promoted.role, 'admin');

  const demoted = adminService.updateUser(ADMIN_2_ID, STUDENT_ID, { role: 'student' });
  assert.equal(demoted.role, 'student');
});

test('updateUser rejects an invalid role value', () => {
  assert.throws(() => adminService.updateUser(ADMIN_ID, STUDENT_ID, { role: 'superuser' }));
});

test('updateUser on a nonexistent user throws not-found', () => {
  assert.throws(() => adminService.updateUser(ADMIN_ID, 999999, { isActive: false }), /not found/i);
});

test('audit logs capture real actions from other modules (e.g. review moderation) with actor names resolved', () => {
  const result = adminService.listAuditLogs({ limit: 100 });
  const reviewApproval = result.logs.find((l) => l.action === 'review.approved');
  assert.ok(reviewApproval, 'expected a review.approved entry written by the faculty module earlier in this test file');
  assert.equal(reviewApproval.actorName, 'Admin One');
});

test('audit log pagination returns a working cursor with no overlap', () => {
  // Generate enough entries to exceed a small page size.
  for (let i = 0; i < 5; i++) {
    adminService.updateUser(ADMIN_ID, STUDENT_2_ID, { isActive: i % 2 === 0 });
  }
  const firstPage = adminService.listAuditLogs({ limit: 3 });
  assert.equal(firstPage.logs.length, 3);
  assert.ok(firstPage.nextCursor);

  const secondPage = adminService.listAuditLogs({ limit: 3, before: firstPage.nextCursor });
  const firstIds = new Set(firstPage.logs.map((l) => l.id));
  assert.ok(secondPage.logs.every((l) => !firstIds.has(l.id)));
});
