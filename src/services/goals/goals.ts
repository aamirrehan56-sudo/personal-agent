import { z } from 'zod';
import type { Db } from '../../db/pool.js';
import { addDays, isValidIsoDate, localDate } from '../../lib/time.js';
import { DISCRETIONARY_CATEGORIES } from '../finance/categories.js';
import type { FinanceService } from '../finance/finance.js';

const isoDate = z.string().refine(isValidIsoDate, 'Must be a real date in YYYY-MM-DD format');
export const GOAL_KINDS = ['savings', 'emergency_fund', 'house_deposit', 'business', 'debt_payoff', 'other'] as const;
export const MILESTONES = [25, 50, 75, 100];

export const goalInput = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(GOAL_KINDS).optional(),
  target_cents: z.number().int().positive(),
  target_date: isoDate.nullable().optional().describe('YYYY-MM-DD deadline, e.g. six months from today'),
  starting_amount_cents: z.number().int().min(0).optional().describe('Amount already saved towards it'),
  notes: z.string().max(1000).optional(),
});

export const goalPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  target_cents: z.number().int().positive().optional(),
  target_date: isoDate.nullable().optional(),
  status: z.enum(['active', 'paused', 'achieved', 'archived']).optional(),
  notes: z.string().max(1000).optional(),
});

const DAYS_PER_MONTH = 30.4375;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

export interface GoalRow { id: number; name: string; kind: string; target_cents: number; start_date: string; target_date: string | null; status: string; notes: string; milestones_hit: number[]; created_at: string }

/**
 * Pure maths for one goal: what is left, the weekly and monthly targets, and whether you're on track.
 * "On track" compares what you've saved with a straight line from the start date to the target date.
 */
export function planGoal(g: Pick<GoalRow, 'target_cents' | 'start_date' | 'target_date'>, savedCents: number, startingCents: number, today: string) {
  const remaining = Math.max(0, g.target_cents - savedCents);
  const percent = Math.min(100, Math.floor((savedCents / g.target_cents) * 100));
  if (remaining === 0) return { saved_cents: savedCents, remaining_cents: 0, percent, status: 'achieved' as const, required_weekly_cents: 0, required_monthly_cents: 0, expected_by_now_cents: g.target_cents, behind_by_cents: 0, days_left: null as number | null };
  if (!g.target_date) return { saved_cents: savedCents, remaining_cents: remaining, percent, status: 'no_deadline' as const, required_weekly_cents: null, required_monthly_cents: null, expected_by_now_cents: null, behind_by_cents: null, days_left: null };
  const daysLeft = daysBetween(today, g.target_date);
  if (daysLeft <= 0) return { saved_cents: savedCents, remaining_cents: remaining, percent, status: 'overdue' as const, required_weekly_cents: remaining, required_monthly_cents: remaining, expected_by_now_cents: g.target_cents, behind_by_cents: remaining, days_left: daysLeft };
  const total = Math.max(1, daysBetween(g.start_date, g.target_date));
  const elapsed = Math.min(total, Math.max(0, daysBetween(g.start_date, today)));
  const expected = Math.round(startingCents + (g.target_cents - startingCents) * (elapsed / total));
  const behind = expected - savedCents;
  const tolerance = Math.max(1000, Math.round(g.target_cents * 0.02)); // $10 or 2%
  const status = behind > tolerance ? 'behind' as const : behind < -tolerance ? 'ahead' as const : 'on_track' as const;
  return {
    saved_cents: savedCents, remaining_cents: remaining, percent, status,
    required_weekly_cents: Math.ceil(remaining / Math.max(1, daysLeft / 7)),
    required_monthly_cents: Math.ceil(remaining / Math.max(1, daysLeft / DAYS_PER_MONTH)),
    expected_by_now_cents: expected, behind_by_cents: Math.max(0, behind), days_left: daysLeft,
  };
}

export class GoalService {
  constructor(private db: Db, private finance: FinanceService, private tz: string) {}

  today() { return localDate(new Date(), this.tz); }

  async create(userId: number, input: z.infer<typeof goalInput>) {
    const g = goalInput.parse(input);
    const today = this.today();
    if (g.target_date && g.target_date <= today) throw new GoalError('The target date must be in the future.');
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO goals (user_id, name, kind, target_cents, start_date, target_date, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [userId, g.name, g.kind ?? 'savings', g.target_cents, today, g.target_date ?? null, g.notes ?? '']);
    if (g.starting_amount_cents) {
      await this.db.query('INSERT INTO goal_contributions (goal_id, date, amount_cents, note) VALUES ($1,$2,$3,$4)', [rows[0].id, today, g.starting_amount_cents, 'Starting amount']);
    }
    return this.get(userId, rows[0].id);
  }

  async update(userId: number, id: number, patch: z.infer<typeof goalPatch>) {
    const p = goalPatch.parse(patch);
    const sets: string[] = []; const args: unknown[] = [userId, id];
    for (const [k, v] of Object.entries(p)) { if (v === undefined) continue; args.push(v); sets.push(`${k}=$${args.length}`); }
    if (sets.length) await this.db.query(`UPDATE goals SET ${sets.join(', ')} WHERE user_id=$1 AND id=$2`, args);
    return this.get(userId, id);
  }

  async remove(userId: number, id: number) {
    const r = await this.db.query('DELETE FROM goals WHERE user_id=$1 AND id=$2', [userId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Records money you moved towards a goal (or took out, if negative). Returns any milestone just reached. */
  async contribute(userId: number, goalId: number, amountCents: number, date?: string, note = '') {
    const goal = await this.row(userId, goalId);
    if (!goal) return null;
    if (!Number.isInteger(amountCents) || amountCents === 0) throw new GoalError('Amount must be a non-zero number of cents.');
    const d = date ?? this.today();
    if (!isValidIsoDate(d)) throw new GoalError('Date must be YYYY-MM-DD.');
    await this.db.query('INSERT INTO goal_contributions (goal_id, date, amount_cents, note) VALUES ($1,$2,$3,$4)', [goalId, d, amountCents, note.slice(0, 200)]);
    const saved = await this.saved(goalId);
    const pct = (saved / goal.target_cents) * 100;
    const newly = MILESTONES.filter((m) => pct >= m && !goal.milestones_hit.includes(m));
    if (newly.length) {
      await this.db.query(`UPDATE goals SET milestones_hit = milestones_hit || $2::int[], status = CASE WHEN $3 THEN 'achieved' ELSE status END WHERE id=$1`,
        [goalId, newly, newly.includes(100)]);
    }
    return { goal: await this.get(userId, goalId), milestones_reached: newly };
  }

  private async row(userId: number, id: number): Promise<GoalRow | null> {
    const { rows } = await this.db.query<GoalRow>('SELECT * FROM goals WHERE user_id=$1 AND id=$2', [userId, id]);
    return rows[0] ?? null;
  }

  private async saved(goalId: number) {
    const { rows } = await this.db.query<{ s: string | null }>('SELECT sum(amount_cents) AS s FROM goal_contributions WHERE goal_id=$1', [goalId]);
    return Number(rows[0].s ?? 0);
  }

  async get(userId: number, id: number) {
    const g = await this.row(userId, id);
    if (!g) return null;
    const { rows: contribs } = await this.db.query<{ id: number; date: string; amount_cents: number; note: string }>(
      'SELECT id, date, amount_cents, note FROM goal_contributions WHERE goal_id=$1 ORDER BY date, id', [id]);
    const saved = contribs.reduce((s, c) => s + c.amount_cents, 0);
    const starting = contribs.filter((c) => c.date === g.start_date && c.note === 'Starting amount').reduce((s, c) => s + c.amount_cents, 0);
    let running = 0;
    const progress = contribs.map((c) => ({ date: c.date, saved_cents: (running += c.amount_cents) }));
    return { ...g, plan: planGoal(g, saved, starting, this.today()), contributions: contribs.slice(-50).reverse(), progress };
  }

  async list(userId: number, includeArchived = false) {
    const { rows } = await this.db.query<{ id: number }>(
      `SELECT id FROM goals WHERE user_id=$1 AND ($2 OR status <> 'archived') ORDER BY status = 'active' DESC, target_date NULLS LAST, id`, [userId, includeArchived]);
    const goals = [];
    for (const r of rows) goals.push((await this.get(userId, r.id))!);
    return goals;
  }

  /** Total weekly amount your active goals need. Used by "safe to spend". */
  async weeklyTargets(userId: number) {
    const goals = await this.list(userId);
    return goals.filter((g) => g.status === 'active').reduce((s, g) => s + (g.plan.required_weekly_cents ?? 0), 0);
  }

  /**
   * Is the goal realistic given your real income and spending, and what could you change?
   * Every number comes from your data; if there isn't enough data, it says so instead of guessing.
   */
  async advice(userId: number, id: number) {
    const goal = await this.get(userId, id);
    if (!goal) return null;
    const capacity = await this.finance.savingsCapacity(userId);
    const others = (await this.list(userId)).filter((g) => g.id !== id && g.status === 'active')
      .reduce((s, g) => s + (g.plan.required_monthly_cents ?? 0), 0);
    const availableMonthly = capacity.monthly_cents === null ? null : capacity.monthly_cents - others;
    const need = goal.plan.required_monthly_cents;
    const suggestions: string[] = [];
    let feasibility: 'achieved' | 'comfortable' | 'tight' | 'not_realistic' | 'unknown' = 'unknown';
    let realisticDate: string | null = null;
    let monthlyGap = 0;
    if (goal.plan.status === 'achieved') feasibility = 'achieved';
    else if (availableMonthly === null) suggestions.push('Add your take-home pay or import at least 4 weeks of transactions so I can check whether this goal is realistic.');
    else if (need === null) {
      if (availableMonthly > 0) realisticDate = addDays(this.today(), Math.ceil((goal.plan.remaining_cents / availableMonthly) * DAYS_PER_MONTH));
      suggestions.push('Set a target date so I can work out weekly and monthly targets.');
    } else {
      if (availableMonthly <= 0) feasibility = 'not_realistic';
      else if (need <= availableMonthly * 0.8) feasibility = 'comfortable';
      else if (need <= availableMonthly) feasibility = 'tight';
      else feasibility = 'not_realistic';
      if (availableMonthly > 0) realisticDate = addDays(this.today(), Math.ceil((goal.plan.remaining_cents / availableMonthly) * DAYS_PER_MONTH));
      monthlyGap = Math.max(0, need - availableMonthly);
    }
    let cutbacks: { category: string; monthly_average_cents: number; suggested_cut_cents: number }[] = [];
    if (monthlyGap > 0 || goal.plan.status === 'behind') {
      const today = this.today();
      const s = await this.finance.summary(userId, addDays(today, -90), today);
      const span = Math.min(90, Math.max(30, capacity.reliable ? 90 : 30));
      cutbacks = s.by_category.filter((c) => (DISCRETIONARY_CATEGORIES as string[]).includes(c.category))
        .map((c) => {
          const monthly = Math.round((c.spent_cents / span) * DAYS_PER_MONTH);
          return { category: c.category, monthly_average_cents: monthly, suggested_cut_cents: Math.round(monthly * 0.25) };
        })
        .filter((c) => c.monthly_average_cents >= 2000)
        .slice(0, 4);
    }
    return {
      goal_id: id, name: goal.name, plan: goal.plan,
      savings_capacity_monthly_cents: capacity.monthly_cents, capacity_basis: capacity.basis,
      other_goals_monthly_cents: others, available_for_this_goal_monthly_cents: availableMonthly,
      feasibility, monthly_gap_cents: monthlyGap, realistic_target_date: realisticDate,
      possible_cutbacks: cutbacks, suggestions,
    };
  }
}

export class GoalError extends Error {}
