import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpDir = mkdtempSync(path.join(tmpdir(), 'vaccess-social-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.STORAGE_LOCAL_DIR = path.join(tmpDir, 'uploads');
process.env.NODE_ENV = 'test';
// Raised so post/comment/report rate limiting (tested separately in
// security.test.js) doesn't interfere with the many functional cases here.
process.env.RATE_LIMIT_MAX_POST_CREATE = '100';
process.env.RATE_LIMIT_MAX_COMMENT_CREATE = '100';
process.env.RATE_LIMIT_MAX_REPORT_SUBMIT = '100';
// Small on purpose so the "too large" test doesn't need to allocate a
// real multi-megabyte buffer just to exceed the limit.
process.env.SOCIAL_MAX_MEDIA_MB = '0.05';

const { getDb, closeDb } = await import('../src/db/db.js');
const socialService = await import('../src/modules/social/social.service.js');
const { readImage, readMedia } = await import('../src/lib/storage.js');

function dataUrl(buffer, mime = 'application/octet-stream') {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}
function buildMinimalMp4() {
  // Box size (24) + "ftyp" + "isom" brand + version — isMp4() only checks
  // for the literal "ftyp" bytes at offset 4, so this is enough.
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftyp', 'ascii'),
    Buffer.from('isom', 'ascii'),
    Buffer.from([0, 0, 0, 0]),
  ]);
}
function buildMinimalWebm() {
  return Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00]);
}

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const STUDENT_A = 1;
const STUDENT_B = 2;
const ADMIN_ID = 3;

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
}

// A minimal valid 1x1 PNG, base64-encoded, used to test image upload.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

let postId;

test('createPost stores a text-only post and it appears in the feed', () => {
  const result = socialService.createPost(STUDENT_A, { content: 'Welcome to semester 5!' });
  postId = result.id;
  const feed = socialService.listFeed(STUDENT_A);
  assert.ok(feed.posts.some((p) => p.id === postId));
});

test('createPost with an embedded image saves it to storage and links it', () => {
  const result = socialService.createPost(STUDENT_A, {
    content: 'Check out this diagram',
    image: { dataUrl: `data:image/png;base64,${TINY_PNG_BASE64}` },
  });
  const feed = socialService.listFeed(STUDENT_A);
  const post = feed.posts.find((p) => p.id === result.id);
  assert.ok(post.imageRef);
  const file = readImage(post.imageRef);
  assert.ok(file);
  assert.equal(file.mime, 'image/png');
});

test('createPost rejects data that is not actually a real image, even with an image data URL prefix', () => {
  const fakeImage = Buffer.from('not actually an image').toString('base64');
  assert.throws(() =>
    socialService.createPost(STUDENT_A, {
      content: 'sneaky',
      image: { dataUrl: `data:image/png;base64,${fakeImage}` },
    }),
    /unsupported image type/i
  );
});

test('createPost rejects empty content', () => {
  assert.throws(() => socialService.createPost(STUDENT_A, { content: '' }));
});

test('likePost increments the like count and is idempotent (prevents duplicate likes)', () => {
  const first = socialService.likePost(STUDENT_B, postId);
  assert.equal(first.likeCount, 1);
  assert.equal(first.likedByMe, true);

  // Liking again (double-click, or a direct repeated API call) must not
  // double-count — this is REQ: "prevent duplicate likes".
  const second = socialService.likePost(STUDENT_B, postId);
  assert.equal(second.likeCount, 1);
});

test('a different student liking the same post increments the count independently', () => {
  const result = socialService.likePost(STUDENT_A, postId);
  assert.equal(result.likeCount, 2);
});

test('unlikePost removes only that student\'s like', () => {
  const result = socialService.unlikePost(STUDENT_B, postId);
  assert.equal(result.likeCount, 1);
  assert.equal(result.likedByMe, false);
});

test('addComment and listComments work end to end', () => {
  socialService.addComment(STUDENT_B, postId, { content: 'Nice post!' });
  const comments = socialService.listComments(postId);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].content, 'Nice post!');
  assert.equal(comments[0].authorName, 'Student B');
});

test('addComment rejects empty content', () => {
  assert.throws(() => socialService.addComment(STUDENT_B, postId, { content: '   ' }));
});

test('reportPost records a report and prevents the same student double-reporting while pending', () => {
  const result = socialService.reportPost(STUDENT_B, postId, { reason: 'This looks like spam.' });
  assert.ok(result.id);
  assert.throws(() => socialService.reportPost(STUDENT_B, postId, { reason: 'Still spam.' }), /already reported/i);
});

test('admin sees the pending report in the moderation queue', () => {
  const pending = socialService.listPendingReports();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].postId, postId);
  assert.equal(pending[0].reportedBy, 'Student B');
});

test('dismissing a report removes it from the queue without touching the post', () => {
  const pending = socialService.listPendingReports();
  socialService.moderateReport(ADMIN_ID, pending[0].id, 'dismissed');
  assert.equal(socialService.listPendingReports().length, 0);
  const feed = socialService.listFeed(STUDENT_A);
  assert.ok(feed.posts.some((p) => p.id === postId), 'post should still be in the feed after dismissal');
});

test('removePost soft-deletes: it disappears from the feed but the row is not hard-deleted', () => {
  socialService.removePost({ id: ADMIN_ID, role: 'admin' }, postId);
  const feed = socialService.listFeed(STUDENT_A);
  assert.ok(!feed.posts.some((p) => p.id === postId), 'removed post must not appear in the feed');

  const db = getDb();
  const row = db.prepare('SELECT status FROM posts WHERE id = ?').get(postId);
  assert.equal(row.status, 'removed', 'soft-delete: the row survives for audit purposes');
});

test('removePost auto-closes any of its own pending reports', () => {
  const p2 = socialService.createPost(STUDENT_A, { content: 'Another post' });
  socialService.reportPost(STUDENT_B, p2.id, { reason: 'inappropriate' });
  assert.equal(socialService.listPendingReports().length, 1);
  socialService.removePost({ id: ADMIN_ID, role: 'admin' }, p2.id);
  assert.equal(socialService.listPendingReports().length, 0);
});

test('removePost lets the author delete their own post even without admin role', () => {
  const p3 = socialService.createPost(STUDENT_A, { content: 'My own post to delete' });
  socialService.removePost({ id: STUDENT_A, role: 'student' }, p3.id);
  const feed = socialService.listFeed(STUDENT_A);
  assert.ok(!feed.posts.some((p) => p.id === p3.id));
});

test('removePost rejects a student who is neither the author nor an admin', () => {
  const p4 = socialService.createPost(STUDENT_A, { content: 'Not yours to delete' });
  assert.throws(
    () => socialService.removePost({ id: STUDENT_B, role: 'student' }, p4.id),
    /only delete your own posts/i
  );
});

test('actions against a removed post are rejected as not found', () => {
  assert.throws(() => socialService.likePost(STUDENT_A, postId), /not found/i);
  assert.throws(() => socialService.addComment(STUDENT_A, postId, { content: 'too late' }), /not found/i);
});

test('feed pagination returns a nextCursor and respects it', () => {
  // Seed enough posts to exceed a small page size.
  for (let i = 0; i < 5; i++) {
    socialService.createPost(STUDENT_A, { content: `Bulk post ${i}` });
  }
  const firstPage = socialService.listFeed(STUDENT_A, { limit: 2 });
  assert.equal(firstPage.posts.length, 2);
  assert.ok(firstPage.nextCursor);

  const secondPage = socialService.listFeed(STUDENT_A, { limit: 2, before: firstPage.nextCursor });
  assert.equal(secondPage.posts.length, 2);
  // No overlap between pages.
  const firstIds = new Set(firstPage.posts.map((p) => p.id));
  assert.ok(secondPage.posts.every((p) => !firstIds.has(p.id)));
});

// ------------------------------------------------------- Video posts -----

test('createPost with an embedded MP4 video saves it to storage and links it', () => {
  const post = socialService.createPost(STUDENT_A, {
    content: 'Check out this clip',
    video: { dataUrl: dataUrl(buildMinimalMp4(), 'video/mp4') },
  });
  const feed = socialService.listFeed(STUDENT_A, { limit: 50 });
  const found = feed.posts.find((p) => p.id === post.id);
  assert.ok(found.videoRef, 'post should carry a videoRef');
  const file = readMedia(found.videoRef);
  assert.ok(file, 'the video file should actually be on disk under its storage ref');
  assert.equal(file.mime, 'video/mp4');
});

test('createPost with an embedded WebM video saves it to storage and links it', () => {
  const post = socialService.createPost(STUDENT_A, {
    content: 'Recorded with MediaRecorder',
    video: { dataUrl: dataUrl(buildMinimalWebm(), 'video/webm') },
  });
  const feed = socialService.listFeed(STUDENT_A, { limit: 50 });
  const found = feed.posts.find((p) => p.id === post.id);
  const file = readMedia(found.videoRef);
  assert.equal(file.mime, 'video/webm');
});

test('createPost rejects data that is not actually a real video, even with a video data URL prefix', () => {
  const fakeVideo = Buffer.from('this is definitely not a video').toString('base64');
  assert.throws(
    () =>
      socialService.createPost(STUDENT_A, {
        content: 'Sneaky',
        video: { dataUrl: `data:video/mp4;base64,${fakeVideo}` },
      }),
    /unsupported video type/i
  );
});

test('createPost rejects a video over the configured size limit', () => {
  const oversized = Buffer.concat([buildMinimalMp4(), Buffer.alloc(100 * 1024)]); // well past the 0.05MB test limit
  assert.throws(
    () =>
      socialService.createPost(STUDENT_A, {
        content: 'Too big',
        video: { dataUrl: dataUrl(oversized, 'video/mp4') },
      }),
    /smaller than/i
  );
});

test('createPost rejects a post that attaches both an image and a video', () => {
  assert.throws(
    () =>
      socialService.createPost(STUDENT_A, {
        content: 'Both at once',
        image: { dataUrl: `data:image/png;base64,${TINY_PNG_BASE64}` },
        video: { dataUrl: dataUrl(buildMinimalMp4(), 'video/mp4') },
      }),
    /either an image or a video/i
  );
});

test('removePost deletes the stored video file for a post that had one', () => {
  const post = socialService.createPost(STUDENT_A, {
    content: 'Will be deleted',
    video: { dataUrl: dataUrl(buildMinimalMp4(), 'video/mp4') },
  });
  const feed = socialService.listFeed(STUDENT_A, { limit: 50 });
  const videoRef = feed.posts.find((p) => p.id === post.id).videoRef;
  assert.ok(readMedia(videoRef), 'sanity check: file exists before removal');

  socialService.removePost({ id: STUDENT_A, role: 'student' }, post.id);
  assert.equal(readMedia(videoRef), null, 'video file should be deleted along with the post');
});
