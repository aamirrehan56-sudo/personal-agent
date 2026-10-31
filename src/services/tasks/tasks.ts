import { z } from 'zod';
import type { Db } from '../../db/pool.js';
import { addDays, addMonths, dayOfWeek, isValidIsoDate, localDate, startOfWeek } from '../../lib/time.js';

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export const RECURRENCES = ['daily', 'weekdays', 'weekly', 'fortnightly', 'monthly'] as const;
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

const isoDate = z.string().refine(isValidIsoDate, 'Must be a real date in YYYY-MM-DD format');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:MM (24 hour)');

export const taskInput = z.object({
  title: z.string().trim().min(1).max(300),
  notes: z.string().max(5000).optional(),
  priority: z.enum(PRIORITIES).optional(),
  due_date: isoDate.nullable().optional(),
  due_time: hhmm.nullable().optional(),
  estimate_min: z.number().int().min(1).max(1440).nullable().optional(),
  recurrence: z.enum(RECURRENCES).nullable().optional(),
  is_habit: z.boolean().optional(),
});
export type TaskInput = z.infer<typeof taskInput>;

export const taskPatch = taskInput.partial().extend({
  status: z.enum(['todo', 'done', 'cancelled']).optional(),
});
export type TaskPatch = z.infer<typeof taskPatch>;

export interface Task {
  id: number;
  title: string;
  notes: string;
  priority: (typeof PRIORITIES)[number];
  status: 'todo' | 'done' | 'cancelled';
  due_date: string | null;
  due_time: string | null;
  estimate_min: number | null;
  recurrence: (typeof RECURRENCES)[number] | null;
  is_habit: boolean;
  completed_at: string | null;
  created_by: 'user' | 'agent';
  created_at: string;
}

const COLS = `id, title, notes, priority, status, due_date, to_char(due_time, 'HH24:MI') AS due_time, estimate_min,
  recurrence, is_habit, completed_at, created_by, created_at`;

export function sortByPriority<T extends Pick<Task, 'priority' | 'due_date' | 'due_time'>>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) =>
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    || (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999')
    || (a.due_time ?? '99').localeCompare(b.due_time ?? '99'));
}

/** Next due date for a recurring task. */
export function nextOccurrence(dueDate: string, rule: (typeof RECURRENCES)[number]): string {
  switch (rule) {
    case 'daily': return addDays(dueDate, 1);
    case 'weekly': return addDays(dueDate, 7);
    case 'fortnightly': return addDays(dueDate, 14);
    case 'monthly': return addMonths(dueDate, 1);
    case 'weekdays': {
      let d = addDays(dueDate, 1);
      while (dayOfWeek(d) === 0 || dayOfWeek(d) === 6) d = addDays(d, 1);
      return d;
    }
  }
}

export class TaskService {
  constructor(private db: Db, private tz: string) {}

  today(now = new Date()) { return localDate(now, this.tz); }

  async create(userId: number, input: TaskInput, createdBy: 'user' | 'agent' = 'user'): Promise<Task> {
    const t = taskInput.parse(input);
    const due = t.due_date ?? (t.recurrence ? this.today() : null);
    const { rows } = await this.db.query<Task>(
      `INSERT INTO tasks (user_id, title, notes, priority, due_date, due_time, estimate_min, recurrence, is_habit, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${COLS}`,
      [userId, t.title, t.notes ?? '', t.priority ?? 'medium', due, t.due_time ?? null, t.estimate_min ?? null,
        t.recurrence ?? null, t.is_habit ?? false, createdBy],
    );
    return rows[0];
  }

  async get(userId: number, id: number): Promise<Task | null> {
    const { rows } = await this.db.query<Task>(`SELECT ${COLS} FROM tasks WHERE user_id=$1 AND id=$2`, [userId, id]);
    return rows[0] ?? null;
  }

  async list(userId: number, f: { status?: 'todo' | 'done' | 'cancelled' | 'all'; from?: string; to?: string; overdue?: boolean; search?: string } = {}): Promise<Task[]> {
    const where = ['user_id = $1'];
    const args: unknown[] = [userId];
    const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
    if (f.status && f.status !== 'all') add('status = ?', f.status);
    if (f.from) add('due_date >= ?', f.from);
    if (f.to) add('due_date <= ?', f.to);
    if (f.overdue) { add('due_date < ?', this.today()); where.push(`status = 'todo'`); }
    if (f.search) add('title ILIKE ?', `%${f.search}%`);
    const { rows } = await this.db.query<Task>(
      `SELECT ${COLS} FROM tasks WHERE ${where.join(' AND ')}
       ORDER BY due_date NULLS LAST, due_time NULLS LAST,
         CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, id
       LIMIT 500`, args);
    return rows;
  }

  async update(userId: number, id: number, patch: TaskPatch): Promise<Task | null> {
    const p = taskPatch.parse(patch);
    if (p.status === 'done') return (await this.complete(userId, id)).task;
    const sets: string[] = [];
    const args: unknown[] = [userId, id];
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) continue;
      args.push(v);
      sets.push(`${k} = $${args.length}`);
    }
    if (sets.length === 0) return this.get(userId, id);
    if (p.status === 'todo') sets.push('completed_at = NULL');
    const { rows } = await this.db.query<Task>(
      `UPDATE tasks SET ${sets.join(', ')}, updated_at = now() WHERE user_id=$1 AND id=$2 RETURNING ${COLS}`, args);
    return rows[0] ?? null;
  }

  /** Marks a task done. If it repeats, the next occurrence is created automatically. */
  async complete(userId: number, id: number): Promise<{ task: Task | null; next: Task | null }> {
    const { rows } = await this.db.query<Task>(
      `UPDATE tasks SET status='done', completed_at=now(), updated_at=now()
       WHERE user_id=$1 AND id=$2 AND status <> 'done' RETURNING ${COLS}`, [userId, id]);
    const task = rows[0] ?? (await this.get(userId, id));
    let next: Task | null = null;
    if (rows[0] && task?.recurrence) {
      const base = task.due_date ?? this.today();
      let due = nextOccurrence(base, task.recurrence);
      // If a habit was overdue, jump forward so the next one isn't already in the past.
      while (due < this.today()) due = nextOccurrence(due, task.recurrence);
      const r = await this.db.query<Task>(
        `INSERT INTO tasks (user_id, title, notes, priority, due_date, due_time, estimate_min, recurrence, is_habit, parent_id, created_by)
         SELECT user_id, title, notes, priority, $3, due_time, estimate_min, recurrence, is_habit, id, created_by
         FROM tasks WHERE user_id=$1 AND id=$2 RETURNING ${COLS}`, [userId, id, due]);
      next = r.rows[0];
    }
    return { task, next };
  }

  async remove(userId: number, id: number): Promise<boolean> {
    const r = await this.db.query('DELETE FROM tasks WHERE user_id=$1 AND id=$2', [userId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Everything the dashboard and the agent need to plan a day. */
  async overview(userId: number, date = this.today()) {
    const [dueToday, overdue, upcoming, completedToday, undated] = await Promise.all([
      this.list(userId, { status: 'todo', from: date, to: date }),
      this.db.query<Task>(`SELECT ${COLS} FROM tasks WHERE user_id=$1 AND status='todo' AND due_date < $2 ORDER BY due_date`, [userId, date]).then((r) => r.rows),
      this.list(userId, { status: 'todo', from: addDays(date, 1), to: addDays(date, 7) }),
      this.db.query<Task>(`SELECT ${COLS} FROM tasks WHERE user_id=$1 AND status='done'
        AND (completed_at AT TIME ZONE $3)::date = $2::date ORDER BY completed_at`, [userId, date, this.tz]).then((r) => r.rows),
      this.db.query<Task>(`SELECT ${COLS} FROM tasks WHERE user_id=$1 AND status='todo' AND due_date IS NULL ORDER BY created_at LIMIT 50`, [userId]).then((r) => r.rows),
    ]);
    return {
      date,
      due_today: sortByPriority(dueToday),
      overdue: sortByPriority(overdue),
      upcoming_7_days: upcoming,
      completed_today: completedToday,
      no_due_date: sortByPriority(undated),
    };
  }

  /** Weekly productivity report for the Monday-to-Sunday week containing `date`. */
  async weeklyReport(userId: number, date = this.today()) {
    const from = startOfWeek(date);
    const to = addDays(from, 6);
    const { rows } = await this.db.query<{ planned: string; completed: string; completed_on_time: string; habits_done: string; habits_planned: string }>(
      `SELECT
         count(*) FILTER (WHERE due_date BETWEEN $2 AND $3 AND status <> 'cancelled') AS planned,
         count(*) FILTER (WHERE status='done' AND (completed_at AT TIME ZONE $4)::date BETWEEN $2 AND $3) AS completed,
         count(*) FILTER (WHERE status='done' AND due_date BETWEEN $2 AND $3 AND (completed_at AT TIME ZONE $4)::date <= due_date) AS completed_on_time,
         count(*) FILTER (WHERE is_habit AND status='done' AND (completed_at AT TIME ZONE $4)::date BETWEEN $2 AND $3) AS habits_done,
         count(*) FILTER (WHERE is_habit AND due_date BETWEEN $2 AND $3 AND status <> 'cancelled') AS habits_planned
       FROM tasks WHERE user_id=$1`, [userId, from, to, this.tz]);
    const r = rows[0];
    const daily = await this.db.query<{ day: string; completed: string }>(
      `SELECT to_char((completed_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS day, count(*) AS completed
       FROM tasks WHERE user_id=$1 AND status='done' AND (completed_at AT TIME ZONE $4)::date BETWEEN $2 AND $3
       GROUP BY 1 ORDER BY 1`, [userId, from, to, this.tz]);
    const byDay = Object.fromEntries(daily.rows.map((d) => [d.day, Number(d.completed)]));
    const planned = Number(r.planned);
    return {
      week_start: from,
      week_end: to,
      planned: planned,
      completed: Number(r.completed),
      completed_on_time: Number(r.completed_on_time),
      completion_rate: planned ? Math.round((Number(r.completed_on_time) / planned) * 100) : null,
      habits: { done: Number(r.habits_done), planned: Number(r.habits_planned) },
      completed_by_day: Array.from({ length: 7 }, (_, i) => ({ date: addDays(from, i), completed: byDay[addDays(from, i)] ?? 0 })),
    };
  }
}
