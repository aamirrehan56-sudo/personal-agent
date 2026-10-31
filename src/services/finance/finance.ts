import { z } from 'zod';
import type { Db } from '../../db/pool.js';
import { addDays, addMonths, isValidIsoDate, localDate, startOfWeek } from '../../lib/time.js';
import { toMonthly, toWeekly } from '../../lib/money.js';
import { CATEGORIES, COMMITTED_CATEGORIES, DISCRETIONARY_CATEGORIES, categorise, kindFor, type UserRule } from './categories.js';

const isoDate = z.string().refine(isValidIsoDate, 'Must be a real date in YYYY-MM-DD format');
const cents = z.number().int();
const category = z.enum(CATEGORIES);

export const transactionInput = z.object({
  date: isoDate,
  amount_cents: cents.refine((v) => v !== 0, 'Amount cannot be zero').describe('Positive = money in, negative = money out, in cents (e.g. -4550 = $45.50 spent)'),
  description: z.string().trim().min(1).max(300),
  category: category.optional().describe('Leave empty to categorise automatically'),
  notes: z.string().max(1000).optional(),
});
export type TransactionInput = z.infer<typeof transactionInput>;

export const budgetInput = z.object({
  category,
  period: z.enum(['weekly', 'monthly']),
  amount_cents: cents.positive(),
});

export const BILL_FREQUENCIES = ['weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly', 'once'] as const;
export const billInput = z.object({
  name: z.string().trim().min(1).max(120),
  amount_cents: cents.positive(),
  frequency: z.enum(BILL_FREQUENCIES),
  next_due: isoDate,
  category: category.optional(),
  is_subscription: z.boolean().optional(),
  remind_days_before: z.number().int().min(0).max(30).optional(),
});

export const debtInput = z.object({
  name: z.string().trim().min(1).max(120),
  balance_cents: cents.min(0),
  interest_rate: z.number().min(0).max(100).describe('Yearly interest rate in %, e.g. 19.99'),
  min_payment_cents: cents.min(0),
  payment_frequency: z.enum(['weekly', 'fortnightly', 'monthly']),
});

export const incomeInput = z.object({
  income_cents: cents.min(0).describe('Take-home pay per period, in cents'),
  income_frequency: z.enum(['weekly', 'fortnightly', 'monthly']),
});

const TX_COLS = 'id, date, amount_cents, description, category, kind, notes, source, created_at';

export function advanceDue(date: string, frequency: string): string | null {
  switch (frequency) {
    case 'weekly': return addDays(date, 7);
    case 'fortnightly': return addDays(date, 14);
    case 'monthly': return addMonths(date, 1);
    case 'quarterly': return addMonths(date, 3);
    case 'yearly': return addMonths(date, 12);
    default: return null;
  }
}

/** Months to pay off a debt at a fixed monthly payment, and total interest. null = never (payment too low). */
export function payoffEstimate(balanceCents: number, ratePct: number, monthlyPaymentCents: number) {
  if (balanceCents <= 0) return { months: 0, interest_cents: 0 };
  let bal = balanceCents; let interest = 0;
  const r = ratePct / 100 / 12;
  for (let m = 1; m <= 600; m++) {
    const i = Math.round(bal * r);
    if (monthlyPaymentCents <= i) return null;
    interest += i;
    bal = bal + i - monthlyPaymentCents;
    if (bal <= 0) return { months: m, interest_cents: interest };
  }
  return null;
}

function monthRange(date: string) {
  const from = `${date.slice(0, 7)}-01`;
  return { from, to: addDays(addMonths(from, 1), -1) };
}

export class FinanceService {
  constructor(private db: Db, private tz: string) {}

  today() { return localDate(new Date(), this.tz); }

  // ---------- transactions ----------
  async rules(userId: number): Promise<(UserRule & { id: number })[]> {
    const { rows } = await this.db.query('SELECT id, pattern, category FROM category_rules WHERE user_id=$1 ORDER BY length(pattern) DESC', [userId]);
    return rows;
  }

  async addTransaction(userId: number, input: TransactionInput, source: 'manual' | 'csv' | 'agent' | 'bill' = 'manual', importHash: string | null = null) {
    const t = transactionInput.parse(input);
    const cat = t.category ?? categorise(t.description, t.amount_cents, await this.rules(userId));
    const { rows } = await this.db.query(
      `INSERT INTO transactions (user_id, date, amount_cents, description, category, kind, notes, source, import_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (user_id, import_hash) DO NOTHING RETURNING ${TX_COLS}`,
      [userId, t.date, t.amount_cents, t.description, cat, kindFor(t.amount_cents, cat), t.notes ?? '', source, importHash]);
    return rows[0] ?? null; // null = duplicate import row
  }

  async listTransactions(userId: number, f: { from?: string; to?: string; category?: string; search?: string; limit?: number } = {}) {
    const where = ['user_id = $1']; const args: unknown[] = [userId];
    const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
    if (f.from) add('date >= ?', f.from);
    if (f.to) add('date <= ?', f.to);
    if (f.category) add('category = ?', f.category);
    if (f.search) add('description ILIKE ?', `%${f.search}%`);
    args.push(Math.min(f.limit ?? 500, 2000));
    const { rows } = await this.db.query(`SELECT ${TX_COLS} FROM transactions WHERE ${where.join(' AND ')} ORDER BY date DESC, id DESC LIMIT $${args.length}`, args);
    return rows;
  }

  /** Changes a transaction's category. With `remember`, future transactions like it get the same category. */
  async recategorise(userId: number, id: number, newCategory: string, remember = false) {
    const cat = category.parse(newCategory);
    const { rows } = await this.db.query(
      `UPDATE transactions SET category=$3, kind = CASE WHEN $3='Savings & Transfers' THEN 'transfer' WHEN amount_cents > 0 THEN 'income' ELSE 'expense' END
       WHERE user_id=$1 AND id=$2 RETURNING ${TX_COLS}`, [userId, id, cat]);
    const tx = rows[0];
    if (tx && remember) {
      const pattern = String(tx.description).toLowerCase().replace(/\d{3,}.*$/, '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (pattern.length >= 2) {
        await this.db.query(`INSERT INTO category_rules (user_id, pattern, category) VALUES ($1,$2,$3)
          ON CONFLICT (user_id, pattern) DO UPDATE SET category=EXCLUDED.category`, [userId, pattern, cat]);
      }
    }
    return tx ?? null;
  }

  async deleteTransaction(userId: number, id: number) {
    const r = await this.db.query('DELETE FROM transactions WHERE user_id=$1 AND id=$2', [userId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  async deleteRule(userId: number, id: number) {
    const r = await this.db.query('DELETE FROM category_rules WHERE user_id=$1 AND id=$2', [userId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Income, spending and net for a date range, with spending by category. Transfers are excluded. */
  async summary(userId: number, from: string, to: string) {
    const { rows } = await this.db.query<{ category: string; kind: string; total: string; count: string }>(
      `SELECT category, kind, sum(amount_cents) AS total, count(*) AS count FROM transactions
       WHERE user_id=$1 AND date BETWEEN $2 AND $3 GROUP BY category, kind`, [userId, from, to]);
    let income = 0; let expenses = 0;
    const byCategory: { category: string; spent_cents: number; count: number }[] = [];
    for (const r of rows) {
      const total = Number(r.total);
      if (r.kind === 'income') income += total;
      if (r.kind === 'expense') { expenses += -total; byCategory.push({ category: r.category, spent_cents: -total, count: Number(r.count) }); }
    }
    byCategory.sort((a, b) => b.spent_cents - a.spent_cents);
    return {
      from, to, income_cents: income, expenses_cents: expenses, net_cents: income - expenses,
      savings_rate: income > 0 ? Math.round(((income - expenses) / income) * 100) : null,
      by_category: byCategory,
    };
  }

  // ---------- income, budgets, bills, debts ----------
  async getIncomeSetting(userId: number) {
    const { rows } = await this.db.query('SELECT income_cents, income_frequency FROM finance_settings WHERE user_id=$1', [userId]);
    return rows[0] ?? null;
  }

  async setIncome(userId: number, input: z.infer<typeof incomeInput>) {
    const i = incomeInput.parse(input);
    await this.db.query(`INSERT INTO finance_settings (user_id, income_cents, income_frequency) VALUES ($1,$2,$3)
      ON CONFLICT (user_id) DO UPDATE SET income_cents=EXCLUDED.income_cents, income_frequency=EXCLUDED.income_frequency, updated_at=now()`,
      [userId, i.income_cents, i.income_frequency]);
    return this.getIncomeSetting(userId);
  }

  async setBudget(userId: number, input: z.infer<typeof budgetInput>) {
    const b = budgetInput.parse(input);
    const { rows } = await this.db.query(`INSERT INTO budgets (user_id, category, period, amount_cents) VALUES ($1,$2,$3,$4)
      ON CONFLICT (user_id, category, period) DO UPDATE SET amount_cents=EXCLUDED.amount_cents, updated_at=now()
      RETURNING id, category, period, amount_cents`, [userId, b.category, b.period, b.amount_cents]);
    return rows[0];
  }

  async deleteBudget(userId: number, id: number) {
    const r = await this.db.query('DELETE FROM budgets WHERE user_id=$1 AND id=$2', [userId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Each budget with what has been spent in the current week or month so far. */
  async budgetStatus(userId: number, date = this.today()) {
    const { rows: budgets } = await this.db.query<{ id: number; category: string; period: 'weekly' | 'monthly'; amount_cents: number }>(
      'SELECT id, category, period, amount_cents FROM budgets WHERE user_id=$1 ORDER BY period, category', [userId]);
    const week = { from: startOfWeek(date), to: addDays(startOfWeek(date), 6) };
    const month = monthRange(date);
    const out = [];
    for (const b of budgets) {
      const range = b.period === 'weekly' ? week : month;
      const { rows } = await this.db.query<{ spent: string | null }>(
        `SELECT -sum(amount_cents) AS spent FROM transactions WHERE user_id=$1 AND kind='expense' AND category=$2 AND date BETWEEN $3 AND $4`,
        [userId, b.category, range.from, range.to]);
      const spent = Number(rows[0].spent ?? 0);
      out.push({ ...b, from: range.from, to: range.to, spent_cents: spent, remaining_cents: b.amount_cents - spent,
        percent_used: Math.round((spent / b.amount_cents) * 100), over_budget: spent > b.amount_cents });
    }
    return out;
  }

  async addBill(userId: number, input: z.infer<typeof billInput>) {
    const b = billInput.parse(input);
    const { rows } = await this.db.query(
      `INSERT INTO bills (user_id, name, amount_cents, frequency, next_due, category, is_subscription, remind_days_before)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [userId, b.name, b.amount_cents, b.frequency, b.next_due, b.category ?? (b.is_subscription ? 'Subscriptions' : 'Bills & Utilities'),
        b.is_subscription ?? false, b.remind_days_before ?? 3]);
    return rows[0];
  }

  async updateBill(userId: number, id: number, patch: Partial<z.infer<typeof billInput>> & { active?: boolean }) {
    const p = billInput.partial().extend({ active: z.boolean().optional() }).parse(patch);
    const sets: string[] = []; const args: unknown[] = [userId, id];
    for (const [k, v] of Object.entries(p)) { if (v === undefined) continue; args.push(v); sets.push(`${k}=$${args.length}`); }
    if (!sets.length) return this.getBill(userId, id);
    const { rows } = await this.db.query(`UPDATE bills SET ${sets.join(', ')} WHERE user_id=$1 AND id=$2 RETURNING *`, args);
    return rows[0] ?? null;
  }

  async getBill(userId: number, id: number) {
    const { rows } = await this.db.query('SELECT * FROM bills WHERE user_id=$1 AND id=$2', [userId, id]);
    return rows[0] ?? null;
  }

  async deleteBill(userId: number, id: number) {
    const r = await this.db.query('DELETE FROM bills WHERE user_id=$1 AND id=$2', [userId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  async listBills(userId: number, includeInactive = false) {
    const { rows } = await this.db.query(
      `SELECT * FROM bills WHERE user_id=$1 AND ($2 OR active) ORDER BY active DESC, next_due`, [userId, includeInactive]);
    const today = this.today();
    return rows.map((b) => ({
      ...b,
      days_until_due: Math.round((Date.parse(b.next_due) - Date.parse(today)) / 86400000),
      reminder_due: b.active && b.next_due <= addDays(today, b.remind_days_before),
      overdue: b.active && b.next_due < today,
      weekly_equivalent_cents: toWeekly(b.amount_cents, b.frequency),
      monthly_equivalent_cents: toMonthly(b.amount_cents, b.frequency),
    }));
  }

  async upcomingBills(userId: number, days = 14) {
    const limit = addDays(this.today(), days);
    return (await this.listBills(userId)).filter((b) => b.next_due <= limit);
  }

  /**
   * Records that YOU paid a bill (the app never pays anything). Moves the due date forward and,
   * if asked, adds a matching expense transaction.
   */
  async markBillPaid(userId: number, id: number, opts: { paid_date?: string; record_transaction?: boolean } = {}) {
    const bill = await this.getBill(userId, id);
    if (!bill) return null;
    const paidDate = opts.paid_date ?? this.today();
    const next = advanceDue(bill.next_due, bill.frequency);
    const { rows } = await this.db.query(
      `UPDATE bills SET last_paid=$3, next_due=COALESCE($4, next_due), active = ($4::date IS NOT NULL) WHERE user_id=$1 AND id=$2 RETURNING *`,
      [userId, id, paidDate, next]);
    let transaction = null;
    if (opts.record_transaction) {
      transaction = await this.addTransaction(userId, { date: paidDate, amount_cents: -bill.amount_cents, description: bill.name, category: bill.category }, 'bill');
    }
    return { bill: rows[0], transaction };
  }

  async addDebt(userId: number, input: z.infer<typeof debtInput>) {
    const d = debtInput.parse(input);
    const { rows } = await this.db.query(
      `INSERT INTO debts (user_id, name, balance_cents, interest_rate, min_payment_cents, payment_frequency) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [userId, d.name, d.balance_cents, d.interest_rate, d.min_payment_cents, d.payment_frequency]);
    return (await this.listDebts(userId)).find((x) => x.id === rows[0].id);
  }

  async updateDebt(userId: number, id: number, patch: Partial<z.infer<typeof debtInput>>) {
    const p = debtInput.partial().parse(patch);
    const sets: string[] = []; const args: unknown[] = [userId, id];
    for (const [k, v] of Object.entries(p)) { if (v === undefined) continue; args.push(v); sets.push(`${k}=$${args.length}`); }
    if (sets.length) await this.db.query(`UPDATE debts SET ${sets.join(', ')}, updated_at=now() WHERE user_id=$1 AND id=$2`, args);
    return (await this.listDebts(userId)).find((x) => x.id === id) ?? null;
  }

  async deleteDebt(userId: number, id: number) {
    const r = await this.db.query('DELETE FROM debts WHERE user_id=$1 AND id=$2', [userId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  async listDebts(userId: number) {
    const { rows } = await this.db.query('SELECT id, name, balance_cents, interest_rate::float AS interest_rate, min_payment_cents, payment_frequency, updated_at FROM debts WHERE user_id=$1 ORDER BY interest_rate DESC', [userId]);
    return rows.map((d) => {
      const monthly = toMonthly(d.min_payment_cents, d.payment_frequency);
      const est = payoffEstimate(d.balance_cents, d.interest_rate, monthly);
      return { ...d, monthly_payment_cents: monthly, payoff_months: est?.months ?? null, total_interest_cents: est?.interest_cents ?? null,
        warning: est === null && d.balance_cents > 0 ? 'The minimum payment does not cover the interest, so this debt will not be paid off.' : null };
    });
  }

  // ---------- analysis ----------
  private async dataSpan(userId: number) {
    const { rows } = await this.db.query<{ first: string | null }>(`SELECT to_char(min(date), 'YYYY-MM-DD') AS first FROM transactions WHERE user_id=$1`, [userId]);
    return rows[0].first;
  }

  /**
   * Average weekly and monthly income and spending from real transactions (last 90 days before today),
   * plus the stated income setting. `days_of_data` tells you how reliable the averages are.
   */
  async averages(userId: number) {
    const today = this.today();
    const first = await this.dataSpan(userId);
    const windowStart = addDays(today, -90);
    const from = first && first > windowStart ? first : windowStart;
    const to = addDays(today, -1);
    const days = first ? Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1) : 0;
    const s = days > 0 ? await this.summary(userId, from, to) : null;
    const perDay = (c: number) => (days > 0 ? c / days : 0);
    const setting = await this.getIncomeSetting(userId);
    const statedWeekly = setting?.income_cents != null ? toWeekly(setting.income_cents, setting.income_frequency) : null;
    const observedWeekly = s ? Math.round(perDay(s.income_cents) * 7) : null;
    const reliable = days >= 28;
    return {
      days_of_data: days,
      reliable,
      observed_weekly_income_cents: observedWeekly,
      observed_weekly_expenses_cents: s ? Math.round(perDay(s.expenses_cents) * 7) : null,
      observed_monthly_income_cents: s ? Math.round(perDay(s.income_cents) * 30.4375) : null,
      observed_monthly_expenses_cents: s ? Math.round(perDay(s.expenses_cents) * 30.4375) : null,
      stated_weekly_income_cents: statedWeekly,
      // Prefer real data once there are 4+ weeks of it; otherwise use what you told the app.
      weekly_income_cents: reliable && observedWeekly ? observedWeekly : (statedWeekly ?? observedWeekly ?? 0),
      income_source: reliable && observedWeekly ? 'transactions' : statedWeekly != null ? 'stated income' : observedWeekly ? 'transactions (less than 4 weeks)' : 'none',
    };
  }

  /** How much you could save each month, from real income and spending. null if there is not enough data. */
  async savingsCapacity(userId: number) {
    const a = await this.averages(userId);
    const bills = await this.listBills(userId);
    const debts = await this.listDebts(userId);
    const setting = await this.getIncomeSetting(userId);
    const statedMonthly = setting?.income_cents != null ? toMonthly(setting.income_cents, setting.income_frequency) : null;
    const monthlyIncome = a.reliable ? a.observed_monthly_income_cents! : statedMonthly;
    let monthlySpending: number | null = a.reliable ? a.observed_monthly_expenses_cents! : null;
    let basis = 'average of your transactions over the last ' + a.days_of_data + ' days';
    if (monthlySpending === null && monthlyIncome !== null) {
      // Not enough history: fall back to known commitments only, and say so.
      monthlySpending = bills.reduce((s, b) => s + b.monthly_equivalent_cents, 0) + debts.reduce((s, d) => s + d.monthly_payment_cents, 0);
      basis = 'your stated income minus bills and debt repayments only (add 4+ weeks of transactions for a real figure)';
    }
    if (monthlyIncome === null || monthlySpending === null) {
      return { monthly_cents: null, basis: 'Not enough data. Add your take-home pay or import at least 4 weeks of transactions.', monthly_income_cents: monthlyIncome, monthly_spending_cents: monthlySpending, reliable: false };
    }
    return { monthly_cents: monthlyIncome - monthlySpending, basis, monthly_income_cents: monthlyIncome, monthly_spending_cents: monthlySpending, reliable: a.reliable };
  }

  /**
   * "How much can I safely spend this week?"
   * weekly income − (bills + debt repayments + savings-goal targets, all as weekly amounts) − flexible spending already this week.
   */
  async safeToSpend(userId: number, goalWeeklyTargetsCents = 0, date = this.today()) {
    const weekStart = startOfWeek(date);
    const weekEnd = addDays(weekStart, 6);
    const a = await this.averages(userId);
    const bills = await this.listBills(userId);
    const debts = await this.listDebts(userId);
    const billsWeekly = bills.reduce((s, b) => s + b.weekly_equivalent_cents, 0);
    const debtsWeekly = debts.reduce((s, d) => s + toWeekly(d.min_payment_cents, d.payment_frequency), 0);
    const { rows } = await this.db.query<{ spent: string | null }>(
      `SELECT -sum(amount_cents) AS spent FROM transactions WHERE user_id=$1 AND kind='expense' AND date BETWEEN $2 AND $3 AND NOT (category = ANY($4))`,
      [userId, weekStart, weekEnd, COMMITTED_CATEGORIES]);
    const spent = Number(rows[0].spent ?? 0);
    const available = a.weekly_income_cents - billsWeekly - debtsWeekly - goalWeeklyTargetsCents;
    const left = available - spent;
    const daysLeft = Math.round((Date.parse(weekEnd) - Date.parse(date)) / 86400000) + 1;
    const warnings: string[] = [];
    if (a.income_source === 'none') warnings.push('No income recorded yet. Set your take-home pay in Finance > Overview or import transactions.');
    else if (!a.reliable && a.income_source !== 'stated income') warnings.push(`Only ${a.days_of_data} days of transactions, so income is an early estimate.`);
    if (bills.length === 0) warnings.push('No bills added yet, so regular bills are not set aside.');
    return {
      week_start: weekStart, week_end: weekEnd,
      weekly_income_cents: a.weekly_income_cents, income_source: a.income_source,
      bills_weekly_cents: billsWeekly, debt_repayments_weekly_cents: debtsWeekly, goal_targets_weekly_cents: goalWeeklyTargetsCents,
      flexible_spent_this_week_cents: spent,
      safe_to_spend_cents: Math.max(0, left), shortfall_cents: left < 0 ? -left : 0,
      days_left_in_week: daysLeft, per_day_cents: Math.max(0, Math.floor(left / daysLeft)),
      warnings,
    };
  }

  /** Spending patterns worth a look, using only your real transactions. */
  async insights(userId: number, date = this.today()) {
    const curFrom = addDays(date, -29); const prevFrom = addDays(date, -59); const prevTo = addDays(date, -30);
    const [cur, prev] = await Promise.all([this.summary(userId, curFrom, date), this.summary(userId, prevFrom, prevTo)]);
    const prevMap = new Map(prev.by_category.map((c) => [c.category, c.spent_cents]));
    const increases = cur.by_category
      .map((c) => ({ category: c.category, last_30_days_cents: c.spent_cents, previous_30_days_cents: prevMap.get(c.category) ?? 0 }))
      .filter((c) => c.previous_30_days_cents > 0 && c.last_30_days_cents - c.previous_30_days_cents >= 5000 && c.last_30_days_cents > c.previous_30_days_cents * 1.2)
      .map((c) => ({ ...c, increase_cents: c.last_30_days_cents - c.previous_30_days_cents }));
    const discretionary = cur.by_category.filter((c) => (DISCRETIONARY_CATEGORIES as string[]).includes(c.category));
    const { rows: merchants } = await this.db.query<{ name: string; total: string; count: string }>(
      `SELECT lower(regexp_replace(description, '[0-9#*].*$', '')) AS name, -sum(amount_cents) AS total, count(*) AS count
       FROM transactions WHERE user_id=$1 AND kind='expense' AND date BETWEEN $2 AND $3 AND category = ANY($4)
       GROUP BY 1 ORDER BY 2 DESC LIMIT 5`, [userId, curFrom, date, DISCRETIONARY_CATEGORIES]);
    // Possible subscriptions: same merchant and similar amount charged in 2+ different months, not already listed as a bill.
    const { rows: recurring } = await this.db.query<{ name: string; amount: string; months: string }>(
      `SELECT lower(regexp_replace(description, '[0-9#*].*$', '')) AS name, round(avg(-amount_cents)) AS amount, count(DISTINCT date_trunc('month', date)) AS months
       FROM transactions WHERE user_id=$1 AND kind='expense' AND date >= $2
       GROUP BY 1 HAVING count(DISTINCT date_trunc('month', date)) >= 2 AND stddev_pop(amount_cents) < 100 ORDER BY 2 DESC LIMIT 10`,
      [userId, addDays(date, -120)]);
    const billNames = (await this.listBills(userId)).map((b) => String(b.name).toLowerCase());
    const budgets = await this.budgetStatus(userId, date);
    return {
      period: { from: curFrom, to: date },
      discretionary_last_30_days_cents: discretionary.reduce((s, c) => s + c.spent_cents, 0),
      discretionary_by_category: discretionary,
      top_discretionary_merchants: merchants.map((m) => ({ name: m.name.trim(), spent_cents: Number(m.total), purchases: Number(m.count) })),
      categories_up_vs_previous_30_days: increases,
      possible_subscriptions: recurring
        .filter((r) => r.name.trim() && !billNames.some((b) => b.includes(r.name.trim()) || r.name.trim().includes(b)))
        .map((r) => ({ name: r.name.trim(), typical_amount_cents: Number(r.amount), months_seen: Number(r.months) })),
      over_budget: budgets.filter((b) => b.over_budget),
    };
  }

  /** Weekly or monthly report compared with the previous period. */
  async report(userId: number, period: 'week' | 'month', date = this.today()) {
    let from: string, to: string, prevFrom: string, prevTo: string;
    if (period === 'week') {
      from = startOfWeek(date); to = addDays(from, 6); prevFrom = addDays(from, -7); prevTo = addDays(from, -1);
    } else {
      ({ from, to } = monthRange(date)); const p = monthRange(addMonths(from, -1)); prevFrom = p.from; prevTo = p.to;
    }
    const [cur, prev] = await Promise.all([this.summary(userId, from, to), this.summary(userId, prevFrom, prevTo)]);
    const prevMap = new Map(prev.by_category.map((c) => [c.category, c.spent_cents]));
    const { rows: daily } = await this.db.query<{ day: string; spent: string }>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS day, -sum(amount_cents) AS spent FROM transactions
       WHERE user_id=$1 AND kind='expense' AND date BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 1`, [userId, from, to]);
    const dailyMap = new Map(daily.map((d) => [d.day, Number(d.spent)]));
    const days: { date: string; spent_cents: number }[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push({ date: d, spent_cents: dailyMap.get(d) ?? 0 });
    return {
      period, from, to,
      income_cents: cur.income_cents, expenses_cents: cur.expenses_cents, net_cents: cur.net_cents, savings_rate: cur.savings_rate,
      previous: { from: prevFrom, to: prevTo, income_cents: prev.income_cents, expenses_cents: prev.expenses_cents, net_cents: prev.net_cents },
      by_category: cur.by_category.map((c) => ({ ...c, previous_cents: prevMap.get(c.category) ?? 0 })),
      daily_spending: days,
    };
  }
}
