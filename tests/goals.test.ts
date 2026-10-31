import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Db } from '../src/db/pool.js';
import { FinanceService } from '../src/services/finance/finance.js';
import { GoalService, planGoal } from '../src/services/goals/goals.js';
import { addDays, addMonths, localDate } from '../src/lib/time.js';
import { freshDb, makeUser } from './helpers.js';

let db: Db; let goals: GoalService; let fin: FinanceService; let uid: number;
const today = localDate();

before(async () => { db = await freshDb(); fin = new FinanceService(db, 'Australia/Melbourne'); goals = new GoalService(db, fin, 'Australia/Melbourne'); uid = await makeUser(db); });
after(async () => { await db.end(); });
beforeEach(async () => { await db.query('DELETE FROM goals; DELETE FROM transactions; DELETE FROM finance_settings; DELETE FROM bills;'); });

test('weekly and monthly targets for "$10,000 in six months"', () => {
  const p = planGoal({ target_cents: 1000000, start_date: '2026-10-31', target_date: '2027-04-30' }, 0, 0, '2026-10-31');
  assert.equal(p.status, 'on_track');
  assert.equal(p.days_left, 181);
  assert.equal(p.required_weekly_cents, Math.ceil(1000000 / (181 / 7))); // ≈ $386.74
  assert.ok(p.required_monthly_cents! > 165000 && p.required_monthly_cents! < 170000); // ≈ $1,682
});

test('falling behind is detected', () => {
  // Halfway through the time but only 10% saved.
  const p = planGoal({ target_cents: 1000000, start_date: '2026-01-01', target_date: '2026-12-31' }, 100000, 0, '2026-07-02');
  assert.equal(p.status, 'behind');
  assert.ok(p.behind_by_cents! > 350000);
  const ahead = planGoal({ target_cents: 1000000, start_date: '2026-01-01', target_date: '2026-12-31' }, 900000, 0, '2026-07-02');
  assert.equal(ahead.status, 'ahead');
});

test('contributions update progress and fire milestones once', async () => {
  const g = await goals.create(uid, { name: 'Emergency fund', kind: 'emergency_fund', target_cents: 400000, target_date: addMonths(today, 6), starting_amount_cents: 50000 });
  assert.equal(g!.plan.saved_cents, 50000);
  const r1 = await goals.contribute(uid, g!.id, 60000);
  assert.deepEqual(r1!.milestones_reached, [25]);
  const r2 = await goals.contribute(uid, g!.id, 10000);
  assert.deepEqual(r2!.milestones_reached, []);
  const r3 = await goals.contribute(uid, g!.id, 300000);
  assert.deepEqual(r3!.milestones_reached, [50, 75, 100]);
  assert.equal(r3!.goal!.status, 'achieved');
  assert.equal(r3!.goal!.progress.at(-1)!.saved_cents, 420000);
});

test('target date in the past is rejected', async () => {
  await assert.rejects(() => goals.create(uid, { name: 'x', target_cents: 1000, target_date: addDays(today, -1) }), /future/);
});

test('advice uses real data: comfortable, not realistic, realistic date and cutbacks', async () => {
  await fin.setIncome(uid, { income_cents: 400000, income_frequency: 'monthly' }); // $4,000/month, no history yet
  await fin.addBill(uid, { name: 'Rent', amount_cents: 200000, frequency: 'monthly', next_due: addDays(today, 5), category: 'Rent & Mortgage' });
  const easy = await goals.create(uid, { name: 'Holiday', target_cents: 300000, target_date: addMonths(today, 12) });
  const a1 = await goals.advice(uid, easy!.id);
  assert.equal(a1!.savings_capacity_monthly_cents, 200000);
  assert.equal(a1!.feasibility, 'comfortable');

  const hard = await goals.create(uid, { name: 'Save $10k fast', target_cents: 1000000, target_date: addMonths(today, 3) });
  const a2 = await goals.advice(uid, hard!.id);
  assert.equal(a2!.feasibility, 'not_realistic');
  assert.ok(a2!.monthly_gap_cents > 0);
  assert.ok(a2!.realistic_target_date! > addMonths(today, 3));
  assert.equal(a2!.other_goals_monthly_cents, easy!.plan.required_monthly_cents);
});

test('advice says what is missing when there is no data', async () => {
  const g = await goals.create(uid, { name: 'House deposit', kind: 'house_deposit', target_cents: 8000000, target_date: addMonths(today, 36) });
  const a = await goals.advice(uid, g!.id);
  assert.equal(a!.feasibility, 'unknown');
  assert.equal(a!.savings_capacity_monthly_cents, null);
});

test('weekly targets feed safe-to-spend', async () => {
  await goals.create(uid, { name: 'A', target_cents: 70000, target_date: addDays(today, 70) });
  const w = await goals.weeklyTargets(uid);
  assert.equal(w, 7000);
});
