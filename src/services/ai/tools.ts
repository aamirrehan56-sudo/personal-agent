import { z } from 'zod';
import type { TaskService } from '../tasks/tasks.js';
import { RECURRENCES, PRIORITIES, sortByPriority, taskInput, taskPatch } from '../tasks/tasks.js';
import type { MemoryService } from '../memory/memory.js';
import { MEMORY_CATEGORIES, memoryInput } from '../memory/memory.js';
import type { FinanceService } from '../finance/finance.js';
import { billInput, budgetInput, debtInput, incomeInput, transactionInput } from '../finance/finance.js';
import { CATEGORIES } from '../finance/categories.js';
import type { GoalService } from '../goals/goals.js';
import { goalInput, goalPatch } from '../goals/goals.js';
import { aud } from '../../lib/money.js';

export type PermissionMode = 'allow' | 'approve' | 'deny';

export interface ToolContext {
  userId: number;
  tasks: TaskService;
  memory: MemoryService;
  finance: FinanceService;
  goals: GoalService;
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

  // ---------------- Finance (records and analysis only: no tool can move money or pay anything) ----------------
  tool({
    name: 'safe_to_spend',
    description: 'Answer "How much can I safely spend this week?" from real data: weekly income minus bills, debt repayments and savings-goal targets (as weekly amounts), minus flexible spending already this week. Show the breakdown and any warnings.',
    schema: z.object({}),
    defaultMode: 'allow',
    summarize: () => 'Calculate safe-to-spend this week',
    run: async (ctx) => ctx.finance.safeToSpend(ctx.userId, await ctx.goals.weeklyTargets(ctx.userId)),
  }),
  tool({
    name: 'finance_summary',
    description: 'Income, spending, net and spending by category for a date range (transfers excluded).',
    schema: z.object({ from: z.string().describe('YYYY-MM-DD'), to: z.string().describe('YYYY-MM-DD') }),
    defaultMode: 'allow',
    summarize: (i) => `Read finance summary ${i.from} to ${i.to}`,
    run: (ctx, i) => ctx.finance.summary(ctx.userId, i.from, i.to),
  }),
  tool({
    name: 'financial_report',
    description: 'Weekly (Mon-Sun) or monthly report containing a date, compared with the previous period, with daily spending.',
    schema: z.object({ period: z.enum(['week', 'month']), date: z.string().optional() }),
    defaultMode: 'allow',
    summarize: (i) => `Read ${i.period}ly financial report`,
    run: (ctx, i) => ctx.finance.report(ctx.userId, i.period, i.date),
  }),
  tool({
    name: 'spending_insights',
    description: 'Find possibly unnecessary spending in the last 30 days: discretionary categories, top merchants, categories that went up, possible forgotten subscriptions, and budgets that are over.',
    schema: z.object({}),
    defaultMode: 'allow',
    summarize: () => 'Analyse spending',
    run: (ctx) => ctx.finance.insights(ctx.userId),
  }),
  tool({
    name: 'savings_capacity',
    description: 'How much the user can realistically save per month, from real income and spending. Says when there is not enough data.',
    schema: z.object({}),
    defaultMode: 'allow',
    summarize: () => 'Calculate monthly savings capacity',
    run: (ctx) => ctx.finance.savingsCapacity(ctx.userId),
  }),
  tool({
    name: 'list_transactions',
    description: 'List recorded transactions with optional filters. amount_cents: positive = money in, negative = money out.',
    schema: z.object({ from: z.string().optional(), to: z.string().optional(), category: z.enum(CATEGORIES).optional(), search: z.string().max(100).optional(), limit: z.number().int().min(1).max(200).optional() }),
    defaultMode: 'allow',
    summarize: () => 'List transactions',
    run: (ctx, i) => ctx.finance.listTransactions(ctx.userId, { ...i, limit: i.limit ?? 50 }),
  }),
  tool({
    name: 'record_transaction',
    description: 'Record income or an expense the user tells you about (e.g. "I spent $45 on groceries today"). This only records it; it never moves money. Amount in cents, negative for spending.',
    schema: transactionInput,
    defaultMode: 'allow',
    summarize: (i) => `Record ${i.amount_cents < 0 ? 'expense' : 'income'} ${aud(Math.abs(i.amount_cents))} "${i.description}" on ${i.date}`,
    run: (ctx, i) => ctx.finance.addTransaction(ctx.userId, i, 'agent'),
  }),
  tool({
    name: 'recategorise_transaction',
    description: 'Change the category of a transaction. Set remember=true to auto-apply this category to similar future transactions.',
    schema: z.object({ id: z.number().int(), category: z.enum(CATEGORIES), remember: z.boolean().optional() }),
    defaultMode: 'allow',
    summarize: (i) => `Recategorise transaction #${i.id} as ${i.category}${i.remember ? ' (and remember)' : ''}`,
    run: async (ctx, i) => (await ctx.finance.recategorise(ctx.userId, i.id, i.category, i.remember)) ?? { error: 'Transaction not found' },
  }),
  tool({
    name: 'delete_transaction',
    description: 'Delete a recorded transaction.',
    schema: z.object({ id: z.number().int() }),
    defaultMode: 'approve',
    summarize: (i) => `Delete transaction #${i.id}`,
    run: async (ctx, i) => ({ deleted: await ctx.finance.deleteTransaction(ctx.userId, i.id) }),
  }),
  tool({
    name: 'set_income',
    description: "Save the user's usual take-home pay (after tax). Used until there are 4+ weeks of transactions.",
    schema: incomeInput,
    defaultMode: 'allow',
    summarize: (i) => `Set take-home pay to ${aud(i.income_cents)} ${i.income_frequency}`,
    run: (ctx, i) => ctx.finance.setIncome(ctx.userId, i),
  }),
  tool({
    name: 'budget_status',
    description: 'Each budget with amount spent so far this week or month, remaining, and whether it is over.',
    schema: z.object({}),
    defaultMode: 'allow',
    summarize: () => 'Check budgets',
    run: (ctx) => ctx.finance.budgetStatus(ctx.userId),
  }),
  tool({
    name: 'set_budget',
    description: 'Create or change a weekly or monthly budget for a category. Budgets need the user\'s approval before they are saved.',
    schema: budgetInput,
    defaultMode: 'approve',
    summarize: (i) => `Set ${i.period} ${i.category} budget to ${aud(i.amount_cents)}`,
    run: (ctx, i) => ctx.finance.setBudget(ctx.userId, i),
  }),
  tool({
    name: 'list_bills',
    description: 'Recurring bills and subscriptions with next due date, days until due, whether a reminder is due, and weekly/monthly equivalents.',
    schema: z.object({ upcoming_days: z.number().int().min(1).max(366).optional().describe('Only bills due within this many days') }),
    defaultMode: 'allow',
    summarize: () => 'List bills',
    run: (ctx, i) => (i.upcoming_days ? ctx.finance.upcomingBills(ctx.userId, i.upcoming_days) : ctx.finance.listBills(ctx.userId)),
  }),
  tool({
    name: 'add_bill',
    description: 'Track a recurring bill or subscription (e.g. electricity quarterly, Netflix monthly). For tracking and reminders only; it never pays anything.',
    schema: billInput,
    defaultMode: 'allow',
    summarize: (i) => `Track bill "${i.name}" ${aud(i.amount_cents)} ${i.frequency}, next due ${i.next_due}`,
    run: (ctx, i) => ctx.finance.addBill(ctx.userId, i),
  }),
  tool({
    name: 'mark_bill_paid',
    description: 'Record that the USER has paid a bill (you cannot pay it). Moves the due date to the next cycle. record_transaction=true also adds it as an expense.',
    schema: z.object({ id: z.number().int(), paid_date: z.string().optional(), record_transaction: z.boolean().optional() }),
    defaultMode: 'allow',
    summarize: (i) => `Mark bill #${i.id} as paid`,
    run: async (ctx, i) => (await ctx.finance.markBillPaid(ctx.userId, i.id, i)) ?? { error: 'Bill not found' },
  }),
  tool({
    name: 'list_debts',
    description: 'Debts with balance, interest rate, repayments and estimated payoff time and total interest.',
    schema: z.object({}),
    defaultMode: 'allow',
    summarize: () => 'List debts',
    run: (ctx) => ctx.finance.listDebts(ctx.userId),
  }),
  tool({
    name: 'add_debt',
    description: 'Track a debt such as a credit card, car loan or BNPL balance.',
    schema: debtInput,
    defaultMode: 'allow',
    summarize: (i) => `Track debt "${i.name}" ${aud(i.balance_cents)}`,
    run: (ctx, i) => ctx.finance.addDebt(ctx.userId, i),
  }),

  // ---------------- Savings goals ----------------
  tool({
    name: 'list_goals',
    description: 'Savings goals with saved amount, percent, weekly and monthly targets, and status (on_track, behind, ahead, achieved, no_deadline, overdue).',
    schema: z.object({}),
    defaultMode: 'allow',
    summarize: () => 'List savings goals',
    run: async (ctx) => (await ctx.goals.list(ctx.userId)).map(({ contributions, progress, ...g }) => g),
  }),
  tool({
    name: 'create_goal',
    description: 'Create a savings goal, e.g. "Save $10,000 in six months" (target_cents 1000000, target_date six months from today). After creating, call goal_advice to check it is realistic.',
    schema: goalInput,
    defaultMode: 'allow',
    summarize: (i) => `Create goal "${i.name}" ${aud(i.target_cents)}${i.target_date ? ` by ${i.target_date}` : ''}`,
    run: (ctx, i) => ctx.goals.create(ctx.userId, i),
  }),
  tool({
    name: 'update_goal',
    description: 'Change a goal (name, target, date, or status: active, paused, achieved, archived).',
    schema: z.object({ id: z.number().int(), changes: goalPatch }),
    defaultMode: 'allow',
    summarize: (i) => `Update goal #${i.id}: ${Object.keys(i.changes).join(', ')}`,
    run: async (ctx, i) => (await ctx.goals.update(ctx.userId, i.id, i.changes)) ?? { error: 'Goal not found' },
  }),
  tool({
    name: 'add_goal_contribution',
    description: 'Record money the user has put towards a goal (negative if they took some out). Records only; it never moves money.',
    schema: z.object({ goal_id: z.number().int(), amount_cents: z.number().int(), date: z.string().optional(), note: z.string().max(200).optional() }),
    defaultMode: 'allow',
    summarize: (i) => `Record ${aud(i.amount_cents)} towards goal #${i.goal_id}`,
    run: async (ctx, i) => (await ctx.goals.contribute(ctx.userId, i.goal_id, i.amount_cents, i.date, i.note)) ?? { error: 'Goal not found' },
  }),
  tool({
    name: 'goal_advice',
    description: 'Check whether a goal is realistic using real income and spending, how much is available after other goals, a realistic date, and which discretionary categories could be cut.',
    schema: z.object({ id: z.number().int() }),
    defaultMode: 'allow',
    summarize: (i) => `Check goal #${i.id}`,
    run: async (ctx, i) => (await ctx.goals.advice(ctx.userId, i.id)) ?? { error: 'Goal not found' },
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
