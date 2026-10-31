import type { Db } from '../../db/pool.js';

export type Actor = 'user' | 'agent' | 'system';

export async function audit(db: Db, userId: number | null, actor: Actor, action: string, detail: object = {}): Promise<void> {
  await db.query('INSERT INTO audit_log (user_id, actor, action, detail) VALUES ($1, $2, $3, $4)', [userId, actor, action, JSON.stringify(detail)]);
}

export async function listAudit(db: Db, userId: number, limit = 100) {
  const { rows } = await db.query(
    'SELECT id, actor, action, detail, created_at FROM audit_log WHERE user_id = $1 ORDER BY id DESC LIMIT $2',
    [userId, Math.min(limit, 500)],
  );
  return rows;
}
