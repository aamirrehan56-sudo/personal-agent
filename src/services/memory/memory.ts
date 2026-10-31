import { z } from 'zod';
import type { Db } from '../../db/pool.js';

export const MEMORY_CATEGORIES = ['preference', 'goal', 'budget', 'bill', 'schedule', 'content_style', 'project', 'other'] as const;

export const memoryInput = z.object({
  category: z.enum(MEMORY_CATEGORIES),
  key: z.string().trim().min(1).max(100),
  value: z.string().trim().min(1).max(2000),
});
export type MemoryInput = z.infer<typeof memoryInput>;

// Things that must never be stored in memory. This is a safety net, not a guarantee.
const SENSITIVE_PATTERNS: [RegExp, string][] = [
  [/\b(?:\d[ -]?){13,19}\b/, 'a card number'],
  [/\bpass(?:word|code)\b\s*[:=]/i, 'a password'],
  [/\b(?:bsb|account\s*(?:no|number))\b\s*[:=]?\s*\d/i, 'bank account details'],
  [/\btfn\b|tax\s*file\s*number/i, 'a tax file number'],
  [/\bsk-ant-[\w-]+/i, 'an API key'],
  [/\bcvv\b|\bcvc\b/i, 'card security codes'],
];

export function findSensitive(text: string): string | null {
  for (const [re, label] of SENSITIVE_PATTERNS) if (re.test(text)) return label;
  return null;
}

export class MemoryService {
  constructor(private db: Db) {}

  async list(userId: number, category?: string) {
    const { rows } = await this.db.query(
      `SELECT id, category, key, value, source, created_at, updated_at FROM memory_items
       WHERE user_id=$1 AND ($2::text IS NULL OR category=$2) ORDER BY category, key`, [userId, category ?? null]);
    return rows;
  }

  /** Creates or updates (by category + key). Refuses obviously sensitive data. */
  async upsert(userId: number, input: MemoryInput, source: 'user' | 'agent' = 'user') {
    const m = memoryInput.parse(input);
    const hit = findSensitive(`${m.key} ${m.value}`);
    if (hit) throw new SensitiveDataError(`Not saved: this looks like ${hit}. Sensitive details are never stored in memory.`);
    const { rows } = await this.db.query(
      `INSERT INTO memory_items (user_id, category, key, value, source) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, category, key) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source, updated_at = now()
       RETURNING id, category, key, value, source, created_at, updated_at`, [userId, m.category, m.key, m.value, source]);
    return rows[0];
  }

  async update(userId: number, id: number, input: MemoryInput) {
    const m = memoryInput.parse(input);
    const hit = findSensitive(`${m.key} ${m.value}`);
    if (hit) throw new SensitiveDataError(`Not saved: this looks like ${hit}.`);
    const { rows } = await this.db.query(
      `UPDATE memory_items SET category=$3, key=$4, value=$5, updated_at=now() WHERE user_id=$1 AND id=$2
       RETURNING id, category, key, value, source, created_at, updated_at`, [userId, id, m.category, m.key, m.value]);
    return rows[0] ?? null;
  }

  async remove(userId: number, id: number): Promise<boolean> {
    const r = await this.db.query('DELETE FROM memory_items WHERE user_id=$1 AND id=$2', [userId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  async removeAll(userId: number): Promise<number> {
    const r = await this.db.query('DELETE FROM memory_items WHERE user_id=$1', [userId]);
    return r.rowCount ?? 0;
  }
}

export class SensitiveDataError extends Error {}
