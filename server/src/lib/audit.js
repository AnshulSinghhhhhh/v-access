import { getDb } from '../db/db.js';

export async function logAudit({ actorId = null, action, targetType = null, targetId = null, metadata = null, ip = null }) {
  const db = await getDb();
  await db.prepare(
    `INSERT INTO audit_logs (actor_id, action, target_type, target_id, metadata, ip_address)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(actorId, action, targetType, targetId, metadata ? JSON.stringify(metadata) : null, ip);
}
