import { getDb } from '../../db/db.js';
import { ValidationError, requireString } from '../../lib/validate.js';
import { logAudit } from '../../lib/audit.js';
import { saveImage, deleteImage, saveMedia, deleteMedia, StorageError } from '../../lib/storage.js';
import { checkRateLimit, recordAttempt } from '../../lib/ratelimit.js';

function notFound(message) {
  const err = new ValidationError(message, 'id');
  err.status = 404;
  return err;
}

async function getActivePostOrThrow(postId) {
  const db = await getDb();
  const post = await db.prepare(`SELECT * FROM posts WHERE id = ? AND status = 'active'`).get(postId);
  if (!post) throw notFound('Post not found.');
  return post;
}

function decodeDataUrl(dataUrl, field) {
  if (typeof dataUrl !== 'string') {
    throw new ValidationError('Invalid file data.', field);
  }
  const match = /^data:[\w/+.-]+;base64,([\s\S]+)$/.exec(dataUrl.trim());
  if (!match) {
    throw new ValidationError('File must be a base64 data URL.', field);
  }
  try {
    return Buffer.from(match[1], 'base64');
  } catch {
    throw new ValidationError('Could not decode file data.', field);
  }
}

// --- Feed -------------------------------------------------------------

export async function listFeed(studentId, { before, limit } = {}) {
  const db = await getDb();
  const take = Math.min(Math.max(Number(limit) || 10, 1), 50);

  const baseQuery = `
    SELECT posts.*, users.full_name AS author_name,
      (SELECT COUNT(*) FROM likes WHERE likes.post_id = posts.id) AS like_count,
      (SELECT COUNT(*) FROM comments WHERE comments.post_id = posts.id) AS comment_count,
      EXISTS(SELECT 1 FROM likes WHERE likes.post_id = posts.id AND likes.student_id = ?) AS liked_by_me
    FROM posts
    JOIN users ON users.id = posts.author_id
    WHERE posts.status = 'active' ${before ? 'AND posts.id < ?' : ''}
    ORDER BY posts.id DESC
    LIMIT ?
  `;

  const rows = before
    ? await db.prepare(baseQuery).all(studentId, Number(before), take + 1)
    : await db.prepare(baseQuery).all(studentId, take + 1);

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;

  return {
    posts: page.map(formatPost),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

function formatPost(row) {
  return {
    id: row.id,
    authorId: row.author_id,
    authorName: row.author_name,
    content: row.content,
    imageRef: row.image_ref,
    videoRef: row.video_ref,
    likeCount: Number(row.like_count),
    commentCount: Number(row.comment_count),
    likedByMe: !!row.liked_by_me,
    createdAt: row.created_at,
  };
}

// --- Create -------------------------------------------------------------

export async function createPost(authorId, { content, image, video }) {
  await checkRateLimit(String(authorId), 'post_create');
  await recordAttempt(String(authorId), 'post_create');

  const cleanContent = requireString(content, 'content', { min: 1, max: 3000 });

  if (image?.dataUrl && video?.dataUrl) {
    throw new ValidationError('Attach either an image or a video, not both.', 'image');
  }

  let imageRef = null;
  if (image && image.dataUrl) {
    const buffer = decodeDataUrl(image.dataUrl, 'image');
    try {
      imageRef = saveImage(buffer).storageRef;
    } catch (err) {
      if (err instanceof StorageError) throw new ValidationError(err.message, 'image');
      throw err;
    }
  }

  let videoRef = null;
  if (video && video.dataUrl) {
    const buffer = decodeDataUrl(video.dataUrl, 'video');
    try {
      videoRef = saveMedia(buffer).storageRef;
    } catch (err) {
      if (err instanceof StorageError) throw new ValidationError(err.message, 'video');
      throw err;
    }
  }

  const db = await getDb();
  const result = await db
    .prepare(`INSERT INTO posts (author_id, content, image_ref, video_ref, status) VALUES (?, ?, ?, ?, 'active')`)
    .run(authorId, cleanContent, imageRef, videoRef);
  const postId = Number(result.lastInsertRowid);
  await logAudit({ actorId: authorId, action: 'post.create', targetType: 'post', targetId: postId });
  return { id: postId };
}

// --- Likes (idempotent — duplicate-prevented at the DB level too) --------

async function currentLikeState(postId, studentId) {
  const db = await getDb();
  const likeCount = (await db.prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?').get(postId)).n;
  const likedByMe = !!(await db.prepare('SELECT 1 FROM likes WHERE post_id = ? AND student_id = ?').get(postId, studentId));
  return { likeCount, likedByMe };
}

export async function likePost(studentId, postId) {
  await getActivePostOrThrow(postId);
  const db = await getDb();
  // ON CONFLICT DO NOTHING relies on the same reviews.UNIQUE(post_id, student_id)
  // style constraint on `likes` — a double-click or race condition never
  // produces two rows, and this call never errors either way (REQ: "prevent
  // duplicate likes" without punishing the user for clicking twice).
  await db.prepare('INSERT INTO likes (post_id, student_id) VALUES (?, ?) ON CONFLICT (post_id, student_id) DO NOTHING').run(postId, studentId);
  return currentLikeState(postId, studentId);
}

export async function unlikePost(studentId, postId) {
  await getActivePostOrThrow(postId);
  const db = await getDb();
  await db.prepare('DELETE FROM likes WHERE post_id = ? AND student_id = ?').run(postId, studentId);
  return currentLikeState(postId, studentId);
}

// --- Comments -------------------------------------------------------------

export async function listComments(postId) {
  await getActivePostOrThrow(postId);
  const db = await getDb();
  const rows = await db
    .prepare(
      `SELECT comments.*, users.full_name AS author_name
       FROM comments JOIN users ON users.id = comments.author_id
       WHERE comments.post_id = ?
       ORDER BY comments.created_at ASC
       LIMIT 200`
    )
    .all(postId);
  return rows.map((r) => ({
    id: r.id,
    authorId: r.author_id,
    authorName: r.author_name,
    content: r.content,
    createdAt: r.created_at,
  }));
}

export async function addComment(authorId, postId, { content }) {
  await checkRateLimit(String(authorId), 'comment_create');
  await recordAttempt(String(authorId), 'comment_create');

  await getActivePostOrThrow(postId);
  const cleanContent = requireString(content, 'content', { min: 1, max: 500 });
  const db = await getDb();
  const result = await db
    .prepare('INSERT INTO comments (post_id, author_id, content) VALUES (?, ?, ?)')
    .run(postId, authorId, cleanContent);
  await logAudit({ actorId: authorId, action: 'comment.create', targetType: 'comment', targetId: Number(result.lastInsertRowid) });
  return { id: Number(result.lastInsertRowid) };
}

// --- Reporting --------------------------------------------------------

export async function reportPost(reporterId, postId, { reason }) {
  await checkRateLimit(String(reporterId), 'report_submit');
  await recordAttempt(String(reporterId), 'report_submit');

  await getActivePostOrThrow(postId);
  const cleanReason = requireString(reason, 'reason', { min: 3, max: 300 });
  const db = await getDb();

  const existing = await db
    .prepare(`SELECT id FROM reports WHERE post_id = ? AND reported_by = ? AND status = 'pending'`)
    .get(postId, reporterId);
  if (existing) {
    throw new ValidationError('You already reported this post — it is awaiting review.', 'reason');
  }

  const result = await db
    .prepare('INSERT INTO reports (post_id, reported_by, reason) VALUES (?, ?, ?)')
    .run(postId, reporterId, cleanReason);
  await logAudit({ actorId: reporterId, action: 'post.report', targetType: 'post', targetId: postId });
  return { id: Number(result.lastInsertRowid) };
}

// --- Admin: moderation ----------------------------------------------------

export async function listPendingReports() {
  const db = await getDb();
  const rows = await db
    .prepare(
      `SELECT reports.*, posts.content AS post_content, posts.image_ref AS post_image_ref,
              posts.status AS post_status, author.full_name AS post_author,
              reporter.full_name AS reporter_name
       FROM reports
       JOIN posts ON posts.id = reports.post_id
       JOIN users author ON author.id = posts.author_id
       JOIN users reporter ON reporter.id = reports.reported_by
       WHERE reports.status = 'pending'
       ORDER BY reports.created_at ASC`
    )
    .all();

  return rows.map((r) => ({
    id: r.id,
    postId: r.post_id,
    postContent: r.post_content,
    postImageRef: r.post_image_ref,
    postStatus: r.post_status,
    postAuthor: r.post_author,
    reportedBy: r.reporter_name,
    reason: r.reason,
    createdAt: r.created_at,
  }));
}

export async function moderateReport(adminId, reportId, status) {
  if (!['reviewed', 'dismissed'].includes(status)) {
    throw new ValidationError('Status must be "reviewed" or "dismissed".', 'status');
  }
  const db = await getDb();
  const report = await db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId);
  if (!report) throw notFound('Report not found.');

  await db.prepare('UPDATE reports SET status = ? WHERE id = ?').run(status, reportId);
  await logAudit({ actorId: adminId, action: `report.${status}`, targetType: 'report', targetId: reportId });
  return { id: reportId, status };
}

// Soft-delete: flips status to 'removed' rather than a hard DELETE, so
// likes/comments/report history survive for audit purposes even though the
// post disappears from the feed immediately (listFeed only ever selects
// status = 'active'). Any of its own pending reports are auto-closed since
// removing the post already resolves them. Callable by an admin (moderation)
// or by the post's own author (self-delete) — anyone else is rejected.
export async function removePost(actor, postId) {
  const db = await getDb();
  const post = await db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) throw notFound('Post not found.');

  const isOwner = post.author_id === actor.id;
  const isAdmin = actor.role === 'admin';
  if (!isOwner && !isAdmin) {
    const err = new ValidationError('You can only delete your own posts.', 'id');
    err.status = 403;
    throw err;
  }

  await db.exec('BEGIN');
  try {
    await db.prepare(`UPDATE posts SET status = 'removed' WHERE id = ?`).run(postId);
    await db.prepare(`UPDATE reports SET status = 'reviewed' WHERE post_id = ? AND status = 'pending'`).run(postId);
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }

  deleteImage(post.image_ref); // best-effort; a removed post's image/video is no longer served anywhere
  deleteMedia(post.video_ref);
  await logAudit({ actorId: actor.id, action: 'post.remove', targetType: 'post', targetId: postId });
}
