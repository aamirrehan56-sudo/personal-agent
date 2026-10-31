import type { Db } from '../../db/pool.js';
import { TOOLS, TOOL_MAP, type PermissionMode } from './tools.js';

export async function getPermissions(db: Db, userId: number) {
  const { rows } = await db.query<{ tool_name: string; mode: PermissionMode }>(
    'SELECT tool_name, mode FROM tool_permissions WHERE user_id=$1', [userId]);
  const saved = new Map(rows.map((r) => [r.tool_name, r.mode]));
  return TOOLS.map((t) => ({
    tool: t.name,
    description: t.description,
    mode: effectiveMode(t.name, saved.get(t.name)),
    default_mode: t.defaultMode,
    always_require_approval: !!t.alwaysRequireApproval,
  }));
}

function effectiveMode(toolName: string, saved: PermissionMode | undefined): PermissionMode {
  const def = TOOL_MAP.get(toolName);
  if (!def) return 'deny';
  const mode = saved ?? def.defaultMode;
  if (def.alwaysRequireApproval && mode === 'allow') return 'approve';
  return mode;
}

export async function getMode(db: Db, userId: number, toolName: string): Promise<PermissionMode> {
  const { rows } = await db.query<{ mode: PermissionMode }>(
    'SELECT mode FROM tool_permissions WHERE user_id=$1 AND tool_name=$2', [userId, toolName]);
  return effectiveMode(toolName, rows[0]?.mode);
}

export async function setMode(db: Db, userId: number, toolName: string, mode: PermissionMode) {
  const def = TOOL_MAP.get(toolName);
  if (!def) throw new Error(`Unknown tool ${toolName}`);
  if (def.alwaysRequireApproval && mode === 'allow') throw new Error(`${toolName} always requires your approval and cannot be set to allow.`);
  await db.query(
    `INSERT INTO tool_permissions (user_id, tool_name, mode) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, tool_name) DO UPDATE SET mode=EXCLUDED.mode, updated_at=now()`, [userId, toolName, mode]);
}
