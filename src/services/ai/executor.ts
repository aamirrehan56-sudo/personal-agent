import type { Db } from '../../db/pool.js';
import { audit } from '../audit/audit.js';
import { getMode } from './permissions.js';
import { TOOL_MAP, type ToolContext } from './tools.js';

export type ToolOutcome =
  | { status: 'ok'; result: unknown; summary: string }
  | { status: 'error'; error: string; summary: string }
  | { status: 'denied'; summary: string }
  | { status: 'pending_approval'; pendingActionId: number; summary: string };

/**
 * Every tool call from the AI goes through here. It validates the input, checks your
 * permission setting, then either runs it, blocks it, or queues it for your approval.
 */
export async function executeToolCall(db: Db, ctx: ToolContext, name: string, rawInput: unknown, conversationId: number | null): Promise<ToolOutcome> {
  const def = TOOL_MAP.get(name);
  if (!def) return { status: 'error', error: `Unknown tool "${name}"`, summary: name };

  const parsed = def.schema.safeParse(rawInput);
  if (!parsed.success) {
    const error = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    return { status: 'error', error: `Invalid input: ${error}`, summary: name };
  }
  const input = parsed.data;
  const summary = def.summarize(input);
  const mode = await getMode(db, ctx.userId, name);

  if (mode === 'deny') {
    await audit(db, ctx.userId, 'agent', 'tool.denied', { tool: name, input });
    return { status: 'denied', summary };
  }
  if (mode === 'approve') {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO pending_actions (user_id, conversation_id, tool_name, input, summary) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [ctx.userId, conversationId, name, JSON.stringify(input), summary]);
    await audit(db, ctx.userId, 'agent', 'tool.approval_requested', { tool: name, input, pending_action_id: rows[0].id });
    return { status: 'pending_approval', pendingActionId: rows[0].id, summary };
  }
  return runNow(db, ctx, name, input, summary, 'agent');
}

async function runNow(db: Db, ctx: ToolContext, name: string, input: unknown, summary: string, actor: 'agent' | 'user'): Promise<ToolOutcome> {
  const def = TOOL_MAP.get(name)!;
  try {
    const result = await def.run(ctx, input);
    await audit(db, ctx.userId, actor, 'tool.executed', { tool: name, input });
    return { status: 'ok', result, summary };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await audit(db, ctx.userId, actor, 'tool.failed', { tool: name, input, error });
    return { status: 'error', error, summary };
  }
}

export async function listPending(db: Db, userId: number, conversationId?: number) {
  const { rows } = await db.query(
    `SELECT id, conversation_id, tool_name, input, summary, status, result, created_at, decided_at FROM pending_actions
     WHERE user_id=$1 AND ($2::int IS NULL OR conversation_id=$2) ORDER BY id DESC LIMIT 100`, [userId, conversationId ?? null]);
  return rows;
}

/** You approve or reject a queued action. Approval runs it exactly once. */
export async function decidePending(db: Db, ctx: ToolContext, id: number, approve: boolean) {
  const { rows } = await db.query<{ id: number; tool_name: string; input: unknown; summary: string }>(
    `UPDATE pending_actions SET status = $3, decided_at = now()
     WHERE user_id=$1 AND id=$2 AND status='pending' RETURNING id, tool_name, input, summary`,
    [ctx.userId, id, approve ? 'approved' : 'rejected']);
  const action = rows[0];
  if (!action) return null;
  if (!approve) {
    await audit(db, ctx.userId, 'user', 'tool.rejected', { tool: action.tool_name, pending_action_id: id });
    return { id, status: 'rejected' as const };
  }
  await audit(db, ctx.userId, 'user', 'tool.approved', { tool: action.tool_name, pending_action_id: id });
  const outcome = await runNow(db, ctx, action.tool_name, action.input, action.summary, 'user');
  const status = outcome.status === 'ok' ? 'approved' : 'failed';
  const result = outcome.status === 'ok' ? outcome.result : { error: outcome.status === 'error' ? outcome.error : outcome.status };
  await db.query('UPDATE pending_actions SET status=$2, result=$3 WHERE id=$1', [id, status, JSON.stringify(result ?? null)]);
  return { id, status, result };
}
