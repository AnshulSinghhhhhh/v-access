import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildMinimalPdf } from './helpers/fixtures.js';

const tmpDir = mkdtempSync(path.join(tmpdir(), 'vaccess-integration-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.STORAGE_LOCAL_DIR = path.join(tmpDir, 'uploads');
process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://example-test.local';

const { buildServer } = await import('../src/app.js');
const { getDb, closeDb } = await import('../src/db/db.js');
const { hashPassword } = await import('../src/lib/password.js');

let server;
let baseUrl;

before(async () => {
  getDb();
  server = buildServer();
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function apiFetch(pathname, { method = 'GET', token, body, ip } = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(ip ? { 'X-Forwarded-For': ip } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* binary/non-JSON body */ }
  return { status: res.status, data, raw: res };
}

async function registerAndLogin(prefix, ip) {
  const email = `${prefix}@vitstudent.ac.in`;
  await apiFetch('/api/auth/register', { method: 'POST', ip, body: { fullName: prefix, email, password: 'Passw0rd1' } });
  const db = getDb();
  db.prepare('UPDATE users SET is_verified = 1 WHERE email = ?').run(email);
  const login = await apiFetch('/api/auth/login', { method: 'POST', ip, body: { email, password: 'Passw0rd1' } });
  const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  return { token: login.data.token, userId, email };
}

async function makeAdmin(prefix) {
  const db = getDb();
  const adminRoleId = db.prepare('SELECT id FROM roles WHERE name = ?').get('admin').id;
  const email = `${prefix}@vitstudent.ac.in`;
  const passwordHash = await hashPassword('Passw0rd1');
  const result = db
    .prepare('INSERT INTO users (full_name, email, password_hash, role_id, is_verified) VALUES (?, ?, ?, ?, 1)')
    .run(prefix, email, passwordHash, adminRoleId);
  const login = await apiFetch('/api/auth/login', { method: 'POST', body: { email, password: 'Passw0rd1' } });
  return { token: login.data.token, userId: Number(result.lastInsertRowid) };
}

// ---------------------------------------------------------------------
// One coherent session touching every module, over real HTTP, in the
// order a student would actually use them — this is deliberately NOT
// testing any single module in depth (the ~110 other tests do that); it's
// testing that they compose correctly when wired together end to end.
// ---------------------------------------------------------------------
test('full cross-module journey: register through admin oversight, all over real HTTP', async () => {
  const student = await registerAndLogin('integration-student', '10.1.0.1');

  // Dashboard reflects a brand-new account.
  const dash = await apiFetch('/api/dashboard/summary', { token: student.token });
  assert.equal(dash.status, 200);
  assert.equal(dash.data.stats.savedTimetables, 0);

  // Timetable Designer: seed one course with two non-conflicting sections,
  // generate, and save.
  const db = getDb();
  const courseId = Number(
    db.prepare('INSERT INTO courses (code, title, credits) VALUES (?, ?, ?)').run('INTG101', 'Integration Course', 3).lastInsertRowid
  );
  db.prepare('INSERT INTO course_slots (course_id, slot_code, day_of_week, start_time, end_time, venue) VALUES (?, ?, ?, ?, ?, ?)')
    .run(courseId, 'A1', 1, '09:00', '09:50', 'Room 1');

  const generated = await apiFetch('/api/timetable/generate', {
    method: 'POST',
    token: student.token,
    body: { selections: [{ courseId, acceptableSlotCodes: ['A1'] }], preferences: {} },
  });
  assert.equal(generated.status, 200);
  assert.equal(generated.data.combinations.length, 1);

  const saved = await apiFetch('/api/timetable', {
    method: 'POST',
    token: student.token,
    body: { name: 'My Integration Timetable', entries: [{ courseId, slotCode: 'A1' }] },
  });
  assert.equal(saved.status, 201);

  // Faculty Review: a student adds a brand-new faculty member themselves
  // (not seeded by an admin), then immediately submits a review for them —
  // this is the actual student-facing flow now that adding faculty isn't
  // admin-only.
  const addedFaculty = await apiFetch('/api/faculty', {
    method: 'POST',
    token: student.token,
    body: { fullName: 'Dr. Student Added Integration', department: 'Integration Dept' },
  });
  assert.equal(addedFaculty.status, 201, 'a student should be able to add a faculty member directly');
  const facultyId = addedFaculty.data.id;
  const review = await apiFetch(`/api/faculty/${facultyId}/reviews`, {
    method: 'POST',
    token: student.token,
    body: { rating: 5, reviewText: 'Great course.' },
  });
  assert.equal(review.status, 201);

  // Social Page: create a post, like it, comment on it.
  const post = await apiFetch('/api/social/posts', { method: 'POST', token: student.token, body: { content: 'Hello from integration test' } });
  assert.equal(post.status, 201);
  const like = await apiFetch(`/api/social/posts/${post.data.id}/like`, { method: 'POST', token: student.token });
  assert.equal(like.data.likeCount, 1);
  const comment = await apiFetch(`/api/social/posts/${post.data.id}/comments`, { method: 'POST', token: student.token, body: { content: 'Nice!' } });
  assert.equal(comment.status, 201);

  // Social Page: a post with a video attachment, fetched back over real
  // HTTP through the authenticated media route, then deleted by its own
  // author (not an admin) — the self-delete path added alongside video.
  const fakeMp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp', 'ascii'), Buffer.from('isom', 'ascii'), Buffer.from([0, 0, 0, 0])]);
  const videoPost = await apiFetch('/api/social/posts', {
    method: 'POST',
    token: student.token,
    body: { content: 'A clip', video: { dataUrl: `data:video/mp4;base64,${fakeMp4.toString('base64')}` } },
  });
  assert.equal(videoPost.status, 201);
  const feedWithVideo = await apiFetch('/api/social/posts?limit=5', { token: student.token });
  const videoRef = feedWithVideo.data.posts.find((p) => p.id === videoPost.data.id).videoRef;
  assert.ok(videoRef, 'video post should carry a videoRef in the feed response');
  const mediaRes = await fetch(`${baseUrl}/api/social/media/${videoRef}`, { headers: { Authorization: `Bearer ${student.token}` } });
  assert.equal(mediaRes.status, 200);
  assert.equal(mediaRes.headers.get('content-type'), 'video/mp4');
  const selfDelete = await apiFetch(`/api/social/posts/${videoPost.data.id}`, { method: 'DELETE', token: student.token });
  assert.equal(selfDelete.status, 200, 'the post author should be able to delete their own post without admin rights');

  // Notes Hub: upload a real PDF, then download it and confirm exact bytes.
  const pdfBuffer = buildMinimalPdf();
  const upload = await apiFetch('/api/notes', {
    method: 'POST',
    token: student.token,
    body: { fileName: 'integration-notes.pdf', subject: 'Integration', file: { dataUrl: `data:application/pdf;base64,${pdfBuffer.toString('base64')}` } },
  });
  assert.equal(upload.status, 201);
  const downloadRes = await fetch(`${baseUrl}/api/notes/${upload.data.id}/download`, {
    headers: { Authorization: `Bearer ${student.token}` },
  });
  const downloadedBytes = Buffer.from(await downloadRes.arrayBuffer());
  assert.ok(downloadedBytes.equals(pdfBuffer), 'downloaded file must be byte-identical to what was uploaded');

  // Find My Class: seed a zone/range and confirm the student can look it up.
  const zoneId = Number(db.prepare('INSERT INTO campus_locations (name) VALUES (?)').run('Integration Block').lastInsertRowid);
  db.prepare('INSERT INTO campus_room_ranges (location_id, floor, range_start, range_end) VALUES (?, ?, ?, ?)')
    .run(zoneId, '3', 10, 20);
  const roomSearch = await apiFetch('/api/campus/search?q=PRP+315', { token: student.token });
  assert.equal(roomSearch.data.matches[0].locationName, 'Integration Block');

  // Now the admin's view: an admin should see this student's activity
  // reflected in cross-module stats and the audit log, and should be able
  // to moderate the review the student just submitted.
  const admin = await makeAdmin('integration-admin');

  const stats = await apiFetch('/api/admin/stats', { token: admin.token });
  assert.equal(stats.status, 200);
  assert.ok(stats.data.stats.totalReviews >= 1);
  assert.ok(stats.data.stats.totalPosts >= 1);
  assert.ok(stats.data.stats.totalNotes >= 1);

  const pending = await apiFetch('/api/faculty-reviews/pending', { token: admin.token });
  const ourReview = pending.data.reviews.find((r) => r.facultyId === facultyId);
  assert.ok(ourReview, 'the review submitted earlier in this journey should appear in the moderation queue');
  const moderated = await apiFetch(`/api/faculty-reviews/${ourReview.id}`, { method: 'PATCH', token: admin.token, body: { status: 'approved' } });
  assert.equal(moderated.status, 200);

  const facultyDetail = await apiFetch(`/api/faculty/${facultyId}`, { token: student.token });
  assert.equal(facultyDetail.data.faculty.reviewCount, 1, 'the approved review should now count toward the public average');

  const dashAfterApproval = await apiFetch('/api/dashboard/summary', { token: student.token });
  const topEntry = dashAfterApproval.data.topRatedFaculty.find((f) => f.id === facultyId);
  assert.ok(topEntry, 'the newly approved review should surface the faculty member on the dashboard');
  assert.equal(topEntry.avgRating, 5);
  assert.equal(topEntry.reviewCount, 1);

  const auditLogs = await apiFetch('/api/admin/audit-logs?limit=200', { token: admin.token });
  const actions = auditLogs.data.logs.map((l) => l.action);
  for (const expected of ['auth.register', 'timetable.save', 'review.submit', 'post.create', 'comment.create', 'note.upload', 'review.approved']) {
    assert.ok(actions.includes(expected), `expected an audit log entry for "${expected}" from this session`);
  }
});

// ------------------------------------------------------ Concurrency -----

test('concurrency: parallel likes from different students on the same post never lose or duplicate a like', async () => {
  const author = await registerAndLogin('concurrency-author', '10.2.0.1');
  const post = await apiFetch('/api/social/posts', { method: 'POST', token: author.token, body: { content: 'Concurrency target post' } });

  const likers = await Promise.all(
    Array.from({ length: 8 }, (_, i) => registerAndLogin(`concurrency-liker-${i}`, `10.2.1.${i + 1}`))
  );

  const results = await Promise.all(
    likers.map((liker) => apiFetch(`/api/social/posts/${post.data.id}/like`, { method: 'POST', token: liker.token }))
  );
  assert.ok(results.every((r) => r.status === 200));

  const finalState = await apiFetch(`/api/social/posts/${post.data.id}/like`, { method: 'POST', token: author.token });
  // author's own like makes it 9 total; the point is no likes were lost or
  // double-counted among the 8 concurrent ones.
  assert.equal(finalState.data.likeCount, 9);

  const db = getDb();
  const rawCount = db.prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?').get(post.data.id).n;
  assert.equal(rawCount, 9, 'no duplicate or lost rows under concurrent inserts');
});

test('concurrency: a burst of requests past the rate limit never lets more through than configured', async () => {
  // Use a fresh env override for just this test's actor by relying on the
  // default limits (post_create defaults reasonably high in other test
  // files, but this file never overrode it, so the real default applies:
  // env.js's default is 15). Fire well past that concurrently.
  const student = await registerAndLogin('concurrency-ratelimit', '10.2.2.1');
  const attempts = 25;
  const results = await Promise.all(
    Array.from({ length: attempts }, (_, i) =>
      apiFetch('/api/social/posts', { method: 'POST', token: student.token, body: { content: `burst ${i}` } })
    )
  );
  const succeeded = results.filter((r) => r.status === 201).length;
  const rateLimited = results.filter((r) => r.status === 429).length;

  assert.equal(succeeded + rateLimited, attempts, 'every request should be accounted for as either accepted or rate-limited');
  assert.ok(succeeded <= 15, `expected at most the configured limit (15) to succeed even under concurrent load, got ${succeeded}`);
  assert.ok(rateLimited > 0, 'expected the burst to actually exceed the limit and trigger 429s');

  const db = getDb();
  const actualPostCount = db.prepare('SELECT COUNT(*) AS n FROM posts WHERE author_id = ?').get(student.userId).n;
  assert.equal(actualPostCount, succeeded, 'the number of posts actually persisted must match the number of 201 responses exactly');
});
