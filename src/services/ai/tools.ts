import { z } from 'zod';
import type { TaskService } from '../tasks/tasks.js';
import { RECURRENCES, PRIORITIES, sortByPriority, taskInput, taskPatch } from '../tasks/tasks.js';
import type { MemoryService } from '../memory/memory.js';
import { MEMORY_CATEGORIES, memoryInput } from '../memory/memory.js';

export type PermissionMode = 'allow' | 'approve' | 'deny';

export interface ToolContext {
  userId: number;
  tasks: TaskService;
  memory: MemoryService;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** Default permission when you have not changed it in Settings. */
  defaultMode: PermissionMode;
  /** If true, this tool can never be set to run without approval (e.g. publishing, money). */
  alwaysRequireApproval?: boolean;
  /** Short human-readable description of what a call will do (shown on approval cards). */
  summarize: (input: z.infer<S>) => string;
  run: (ctx: ToolContext, input: z.infer<S>) => Promise<unknown>;
}

function tool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> { return def; }

const listTasksSchema = z.object({
  status: z.enum(['todo', 'done', 'cancelled', 'all']).optional().describe('Defaults to todo'),
  from: z.string().optional().describe('Earliest due date, YYYY-MM-DD'),
  to: z.string().optional().describe('Latest due date, YYYY-MM-DD'),
  overdue: z.boolean().optional().describe('Only unfinished tasks whose due date has passed'),
  search: z.string().max(100).optional().describe('Text to search for in titles'),
  sort: z.enum(['due', 'priority']).optional(),
});

export const TOOLS: ToolDef[] = [
  tool({
    name: 'get_task_overview',
    description: 'Get tasks due on a date (default today), overdue tasks, tasks for the next 7 days, tasks completed that day and tasks with no due date. Use this first when planning a day or reviewing progress.',
    schema: z.object({ date: z.string().optional().describe('YYYY-MM-DD, defaults to today in Melbourne') }),
    defaultMode: 'allow',
    summarize: (i) => `Read task overview for ${i.date ?? 'today'}`,
    run: (ctx, i) => ctx.tasks.overview(ctx.userId, i.date),
  }),
  tool({
    name: 'list_tasks',
    description: 'Search and list tasks with filters.',
    schema: listTasksSchema,
    defaultMode: 'allow',
    summarize: () => 'List tasks',
    run: async (ctx, i) => {
      const rows = await ctx.tasks.list(ctx.userId, { status: i.status ?? 'todo', from: i.from, to: i.to, overdue: i.overdue, search: i.search });
      return i.sort === 'priority' ? sortByPriority(rows) : rows;
    },
  }),
  tool({
    name: 'create_task',
    description: 'Create a task or reminder. Convert relative dates like "next Friday" into an exact YYYY-MM-DD date using the current Melbourne date given in the conversation. Use recurrence for repeating tasks and is_habit for habits.',
    schema: taskInput,
    defaultMode: 'allow',
    summarize: (i) => `Create task "${i.title}"${i.due_date ? ` due ${i.due_date}` : ''}`,
    run: (ctx, i) => ctx.tasks.create(ctx.userId, i, 'agent'),
  }),
  tool({
    name: 'update_task',
    description: 'Change a task: reschedule (due_date/due_time), change priority, rename, add notes, or set status to done/cancelled/todo.',
    schema: z.object({ id: z.number().int(), changes: taskPatch }),
    defaultMode: 'allow',
    summarize: (i) => `Update task #${i.id}: ${Object.keys(i.changes).join(', ')}`,
    run: async (ctx, i) => (await ctx.tasks.update(ctx.userId, i.id, i.changes)) ?? { error: `Task ${i.id} not found` },
  }),
  tool({
    name: 'complete_task',
    description: 'Mark a task as done. Repeating tasks automatically get their next occurrence.',
    schema: z.object({ id: z.number().int() }),
    defaultMode: 'allow',
    summarize: (i) => `Complete task #${i.id}`,
    run: (ctx, i) => ctx.tasks.complete(ctx.userId, i.id),
  }),
  tool({
    name: 'delete_task',
    description: 'Permanently delete a task. Prefer update_task with status "cancelled" unless the user explicitly asks to delete.',
    schema: z.object({ id: z.number().int() }),
    defaultMode: 'approve',
    summarize: (i) => `Permanently delete task #${i.id}`,
    run: async (ctx, i) => ({ deleted: await ctx.tasks.remove(ctx.userId, i.id) }),
  }),
  tool({
    name: 'weekly_productivity_report',
    description: 'Get planned vs completed task counts, on-time completion rate and habit completion for the Monday-Sunday week containing a date.',
    schema: z.object({ date: z.string().optional() }),
    defaultMode: 'allow',
    summarize: () => 'Read weekly productivity report',
    run: (ctx, i) => ctx.tasks.weeklyReport(ctx.userId, i.date),
  }),
  tool({
    name: 'list_memory',
    description: "Read saved long-term memory about the user (preferences, goals, budgets, bills, schedules, content style, projects).",
    schema: z.object({ category: z.enum(MEMORY_CATEGORIES).optional() }),
    defaultMode: 'allow',
    summarize: (i) => `Read memory${i.category ? ` (${i.category})` : ''}`,
    run: (ctx, i) => ctx.memory.list(ctx.userId, i.category),
  }),
  tool({
    name: 'save_memory',
    description: 'Save or update a lasting fact the user wants remembered (e.g. "prefers deep work in the morning"). Only save useful, non-sensitive information. Never save passwords, card numbers, bank account numbers, tax file numbers or ID documents.',
    schema: memoryInput,
    defaultMode: 'allow',
    summarize: (i) => `Remember ${i.category}/${i.key}: "${i.value}"`,
    run: (ctx, i) => ctx.memory.upsert(ctx.userId, i, 'agent'),
  }),
  tool({
    name: 'delete_memory',
    description: 'Delete a saved memory item by id.',
    schema: z.object({ id: z.number().int() }),
    defaultMode: 'approve',
    summarize: (i) => `Delete memory item #${i.id}`,
    run: async (ctx, i) => ({ deleted: await ctx.memory.remove(ctx.userId, i.id) }),
  }),
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** Converts our zod schemas to the JSON Schema the Claude API expects. */
export function toApiTools() {
  return TOOLS.map((t) => {
    const schema = z.toJSONSchema(t.schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
    delete schema.$schema;
    return { name: t.name, description: t.description, input_schema: schema as { type: 'object'; [k: string]: unknown } };
  });
}

export { PRIORITIES, RECURRENCES };
