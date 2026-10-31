import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Db } from '../src/db/pool.js';
import { FinanceService, payoffEstimate, advanceDue } from '../src/services/finance/finance.js';
import { categorise } from '../src/services/finance/categories.js';
import { importCsv, parseAuDate, previewCsv } from '../src/services/finance/importer.js';
import { parseCsv } from '../src/lib/csv.js';
import { parseMoney, toMonthly, toWeekly } from '../src/lib/money.js';
import { addDays, localDate, startOfWeek } from '../src/lib/time.js';
import { freshDb, makeUser } from './helpers.js';

let db: Db; let fin: FinanceService; let uid: number;
const today = localDate();

before(async () => { db = await freshDb(); fin = new FinanceService(db, 'Australia/Melbourne'); uid = await makeUser(db); });
after(async () => { await db.end(); });
beforeEach(async () => { await db.query('DELETE FROM transactions; DELETE FROM bills; DELETE FROM budgets; DELETE FROM debts; DELETE FROM finance_settings; DELETE FROM category_rules;'); });

test('money parsing in AUD formats', () => {
  assert.equal(parseMoney('$1,234.56'), 123456);
  assert.equal(parseMoney('-45.5'), -4550);
  assert.equal(parseMoney('(12.00)'), -1200);
  assert.equal(parseMoney('20.00 DR'), -2000);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney('1.234'), null);
  assert.equal(toWeekly(52000, 'yearly'), 1000);
  assert.equal(toMonthly(10000, 'fortnightly'), 21667);
});

test('Australian dates are day-first', () => {
  assert.equal(parseAuDate('05/11/2026'), '2026-11-05');
  assert.equal(parseAuDate('5/11/26'), '2026-11-05');
  assert.equal(parseAuDate('31 Oct 2026'), '2026-10-31');
  assert.equal(parseAuDate('2026-10-31'), '2026-10-31');
  assert.equal(parseAuDate('31/02/2026'), null);
});

test('CSV parser handles quotes and commas', () => {
  assert.deepEqual(parseCsv('a,"b, c","d ""q"""\n1,2,3\n'), [['a', 'b, c', 'd "q"'], ['1', '2', '3']]);
});

test('automatic categories for common Australian merchants', () => {
  assert.equal(categorise('WOOLWORTHS 1234 MELBOURNE', -8550), 'Groceries');
  assert.equal(categorise('UBER *EATS HELP.UBER.COM', -3200), 'Eating out');
  assert.equal(categorise('UBER *TRIP', -1800), 'Transport');
  assert.equal(categorise('NETFLIX.COM', -1899), 'Subscriptions');
  assert.equal(categorise('AGL SALES PTY LTD', -21000), 'Bills & Utilities');
  assert.equal(categorise('SALARY ACME PTY LTD', 250000), 'Income');
  assert.equal(categorise('Transfer to Savings', -50000), 'Savings & Transfers');
  assert.equal(categorise('Mystery shop', -1000), 'Other');
  assert.equal(categorise('Refund from somewhere', 1000), 'Income');
  assert.equal(categorise('Joe Bloggs Plumbing', -15000, [{ pattern: 'joe bloggs', category: 'Bills & Utilities' }]), 'Bills & Utilities');
});

test('CommBank-style CSV (no header) previews, imports and never duplicates', async () => {
  const csv = '31/10/2026,-85.50,"WOOLWORTHS 1234 MELBOURNE",1000.00\n30/10/2026,+2500.00,"SALARY ACME PTY LTD",1085.50\n30/10/2026,-5.00,"CAFE NERO",-1414.50\n30/10/2026,-5.00,"CAFE NERO",-1419.50\nbad,row,here,x\n';
  const p = previewCsv(csv);
  assert.equal(p.guess.hasHeader, false);
  assert.equal(p.guess.date, 0);
  assert.equal(p.guess.amount, 1);
  assert.equal(p.guess.description, 2);
  const mapping = { hasHeader: false, date: 0, amount: 1, description: 2 };
  const r1 = await importCsv(fin, uid, csv, mapping);
  assert.equal(r1.imported, 4); // two identical coffees are both kept
  assert.equal(r1.errors.length, 1);
  const r2 = await importCsv(fin, uid, csv, mapping);
  assert.equal(r2.imported, 0);
  assert.equal(r2.duplicates, 4);
  const txs = await fin.listTransactions(uid);
  assert.equal(txs.find((t) => t.description.startsWith('WOOLWORTHS')).category, 'Groceries');
});

test('CSV with header and separate debit/credit columns', async () => {
  const csv = 'Date,Description,Debit,Credit,Balance\n01/11/2026,Coles Richmond,45.20,,100\n02/11/2026,Pay ACME,,1200.00,1300\n';
  const p = previewCsv(csv);
  assert.equal(p.guess.hasHeader, true);
  assert.equal(p.guess.debit, 2);
  assert.equal(p.guess.credit, 3);
  const r = await importCsv(fin, uid, csv, p.guess as any);
  assert.equal(r.imported, 2);
  const s = await fin.summary(uid, '2026-11-01', '2026-11-30');
  assert.equal(s.income_cents, 120000);
  assert.equal(s.expenses_cents, 4520);
});

test('recategorise with remember creates a rule for future transactions', async () => {
  const t = await fin.addTransaction(uid, { date: today, amount_cents: -3000, description: 'BOB SMITH TUTORING 8891' });
  assert.equal(t.category, 'Other');
  await fin.recategorise(uid, t.id, 'Education', true);
  const t2 = await fin.addTransaction(uid, { date: today, amount_cents: -3000, description: 'Bob Smith Tutoring 9999' });
  assert.equal(t2.category, 'Education');
});

test('transfers are not counted as income or spending', async () => {
  await fin.addTransaction(uid, { date: today, amount_cents: -50000, description: 'Transfer to savings' });
  await fin.addTransaction(uid, { date: today, amount_cents: -2000, description: 'Coles' });
  const s = await fin.summary(uid, today, today);
  assert.equal(s.expenses_cents, 2000);
  assert.equal(s.income_cents, 0);
});

test('budgets track spending this week and flag overspending', async () => {
  await fin.setBudget(uid, { category: 'Eating out', period: 'weekly', amount_cents: 5000 });
  await fin.addTransaction(uid, { date: today, amount_cents: -6000, description: 'Guzman y Gomez' });
  const [b] = await fin.budgetStatus(uid);
  assert.equal(b.spent_cents, 6000);
  assert.equal(b.over_budget, true);
  assert.equal(b.remaining_cents, -1000);
});

test('bills: reminders, weekly equivalents and marking paid', async () => {
  const bill = await fin.addBill(uid, { name: 'Electricity', amount_cents: 39000, frequency: 'quarterly', next_due: addDays(today, 2), remind_days_before: 3 });
  const [b] = await fin.listBills(uid);
  assert.equal(b.reminder_due, true);
  assert.equal(b.weekly_equivalent_cents, 3000);
  const r = await fin.markBillPaid(uid, bill.id, { record_transaction: true });
  assert.equal(r!.bill.next_due, advanceDue(addDays(today, 2), 'quarterly'));
  assert.equal(r!.transaction.amount_cents, -39000);
  assert.equal(r!.transaction.category, 'Bills & Utilities');
  const once = await fin.addBill(uid, { name: 'Rego', amount_cents: 80000, frequency: 'once', next_due: today });
  const r2 = await fin.markBillPaid(uid, once.id);
  assert.equal(r2!.bill.active, false);
});

test('debt payoff estimate', () => {
  const e = payoffEstimate(500000, 20, 25000); // $5,000 at 20% paying $250/month
  assert.ok(e && e.months > 20 && e.months < 26, `months=${e?.months}`);
  assert.ok(e!.interest_cents > 90000 && e!.interest_cents < 130000);
  assert.equal(payoffEstimate(500000, 20, 5000), null); // $50 doesn't cover ~$83 interest
});

test('safe to spend: income minus commitments minus flexible spending this week', async () => {
  await fin.setIncome(uid, { income_cents: 200000, income_frequency: 'fortnightly' }); // $1,000/week
  await fin.addBill(uid, { name: 'Rent', amount_cents: 200000, frequency: 'monthly', next_due: addDays(today, 10), category: 'Rent & Mortgage' }); // ~$461.54/wk
  await fin.addDebt(uid, { name: 'Credit card', balance_cents: 300000, interest_rate: 20, min_payment_cents: 10000, payment_frequency: 'weekly' });
  await fin.addTransaction(uid, { date: startOfWeek(today), amount_cents: -7000, description: 'Coles' });
  await fin.addTransaction(uid, { date: startOfWeek(today), amount_cents: -200000, description: 'Rent payment' }); // committed: not counted again
  const s = await fin.safeToSpend(uid, 15000, today);
  assert.equal(s.weekly_income_cents, 100000);
  assert.equal(s.bills_weekly_cents, 46154);
  assert.equal(s.debt_repayments_weekly_cents, 10000);
  assert.equal(s.flexible_spent_this_week_cents, 7000);
  assert.equal(s.safe_to_spend_cents, 100000 - 46154 - 10000 - 15000 - 7000);
  assert.equal(s.income_source, 'stated income');
});

test('safe to spend warns instead of guessing when there is no income data', async () => {
  const s = await fin.safeToSpend(uid, 0, today);
  assert.equal(s.safe_to_spend_cents, 0);
  assert.ok(s.warnings.some((w) => /No income/.test(w)));
});

test('savings capacity uses real averages once there are 4+ weeks of data', async () => {
  for (let d = 1; d <= 60; d++) {
    const date = addDays(today, -d);
    if (d % 14 === 0) await fin.addTransaction(uid, { date, amount_cents: 280000, description: 'Salary' });
    await fin.addTransaction(uid, { date, amount_cents: -10000, description: 'Coles' });
  }
  const c = await fin.savingsCapacity(uid);
  assert.equal(c.reliable, true);
  assert.ok(c.monthly_income_cents! > 500000 && c.monthly_income_cents! < 700000);
  assert.equal(c.monthly_spending_cents, Math.round((10000 * 30.4375)));
  const ins = await fin.insights(uid);
  assert.ok(Array.isArray(ins.possible_subscriptions));
  const rep = await fin.report(uid, 'week', today);
  assert.equal(rep.daily_spending.length, 7);
});
