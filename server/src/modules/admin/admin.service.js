import { getDb } from '../../db/db.js';
import { ValidationError } from '../../lib/validate.js';
import { logAudit } from '../../lib/audit.js';

function notFound(message) {
  const err = new ValidationError(message, 'id');
  err.status = 404;
  return err;
}

async function countOne(sql, ...params) {
  const db = await getDb();
  const row = await db.prepare(sql).get(...params);
  return row.n;
}

// SRS Section 9: total students, total faculty, total reviews, pending
// reviews, total posts, reported posts, total notes.
export async function getStats() {
  const [
    totalStudents,
    totalFaculty,
    totalReviews,
    pendingReviews,
    totalPosts,
    reportedPosts,
    totalNotes,
  ] = await Promise.all([
    countOne(
      `SELECT COUNT(*) AS n FROM users JOIN roles ON roles.id = users.role_id WHERE roles.name = 'student'`
    ),
    countOne('SELECT COUNT(*) AS n FROM faculty'),
    countOne('SELECT COUNT(*) AS n FROM reviews'),
    countOne(`SELECT COUNT(*) AS n FROM reviews WHERE status = 'pending'`),
    countOne(`SELECT COUNT(*) AS n FROM posts WHERE status = 'active'`),
    countOne(`SELECT COUNT(*) AS n FROM reports WHERE status = 'pending'`),
    countOne('SELECT COUNT(*) AS n FROM notes'),
  ]);
  return { totalStudents, totalFaculty, totalReviews, pendingReviews, totalPosts, reportedPosts, totalNotes };
}

// --- Users -----------------------------------------------------------

export async function listUsers({ search, role } = {}) {
  const db = await getDb();
  const clauses = [];
  const params = [];

  if (search) {
    clauses.push('(LOWER(users.full_name) LIKE ? OR LOWER(users.email) LIKE ?)');
    const like = `%${search.toLowerCase()}%`;
    params.push(like, like);
  }
  if (role) {
    clauses.push('roles.name = ?');
    params.push(role);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = await db
    .prepare(
      `SELECT users.id, users.full_name, users.email, users.is_active, users.is_verified,
              users.created_at, roles.name AS role
       FROM users JOIN roles ON roles.id = users.role_id
       ${where}
       ORDER BY users.created_at DESC
       LIMIT 500`
    )
    .all(...params);

  return rows.map(formatUser);
}

function formatUser(r) {
  return {
    id: r.id,
    fullName: r.full_name,
    email: r.email,
    role: r.role,
    isActive: !!r.is_active,
    isVerified: !!r.is_verified,
    createdAt: r.created_at,
  };
}

// Suspending or promoting/demoting is never allowed against the acting
// admin's own account — this is what stops a single careless click from
// locking every admin out of the system.
export async function updateUser(adminUserId, targetUserId, { isActive, role }) {
  if (targetUserId === adminUserId) {
    if (isActive === false) throw new ValidationError('You cannot suspend your own account.', 'isActive');
    if (role !== undefined && role !== 'admin') throw new ValidationError('You cannot change your own role.', 'role');
  }

  const db = await getDb();
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId);
  if (!user) throw notFound('User not found.');

  if (role !== undefined) {
    if (!['student', 'admin'].includes(role)) {
      throw new ValidationError('Role must be "student" or "admin".', 'role');
    }
    const roleRow = await db.prepare('SELECT id FROM roles WHERE name = ?').get(role);
    await db.prepare('UPDATE users SET role_id = ? WHERE id = ?').run(roleRow.id, targetUserId);
  }

  if (isActive !== undefined) {
    await db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, targetUserId);
    if (isActive === false) {
      // Suspension takes effect immediately, not just on the user's next
      // login attempt — every currently-live session is revoked right now.
      await db.prepare(
        `UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE user_id = ? AND revoked_at IS NULL`
      ).run(targetUserId);
    }
  }

  await logAudit({
    actorId: adminUserId,
    action: 'user.update',
    targetType: 'user',
    targetId: targetUserId,
    metadata: { isActive, role },
  });

  const updated = await db
    .prepare(
      `SELECT users.id, users.full_name, users.email, users.is_active, users.is_verified,
              users.created_at, roles.name AS role
       FROM users JOIN roles ON roles.id = users.role_id WHERE users.id = ?`
    )
    .get(targetUserId);
  return formatUser(updated);
}

// --- Audit logs -----------------------------------------------------

export async function listAuditLogs({ before, limit } = {}) {
  const db = await getDb();
  const take = Math.min(Math.max(Number(limit) || 50, 1), 200);

  const baseQuery = `
    SELECT audit_logs.*, users.full_name AS actor_name
    FROM audit_logs
    LEFT JOIN users ON users.id = audit_logs.actor_id
    ${before ? 'WHERE audit_logs.id < ?' : ''}
    ORDER BY audit_logs.id DESC
    LIMIT ?
  `;
  const rows = before
    ? await db.prepare(baseQuery).all(Number(before), take + 1)
    : await db.prepare(baseQuery).all(take + 1);

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;

  return {
    logs: page.map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      actorName: r.actor_name || 'System',
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      createdAt: r.created_at,
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}
