import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/pool.js';
import { audit } from '../audit/audit.js';
import { billInput, budgetInput, debtInput, incomeInput, transactionInput, type FinanceService } from './finance.js';
import { CATEGORIES } from './categories.js';
import { importCsv, mappingSchema, previewCsv } from './importer.js';
import { goalInput, goalPatch, type GoalService } from '../goals/goals.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const MAX_CSV = 2_000_000;

/** Finance and Goals API. Registered inside the logged-in API scope. */
export function registerFinanceRoutes(api: FastifyInstance, db: Db, finance: FinanceService, goals: GoalService) {
  const uid = (req: { userId?: number }) => req.userId!;

  api.get('/api/finance/meta', async () => ({ categories: CATEGORIES }));

  api.get('/api/finance/overview', async (req) => {
    const today = finance.today();
    const monthFrom = `${today.slice(0, 7)}-01`;
    const [safe, month, bills, budgets, income, capacity] = await Promise.all([
      goals.weeklyTargets(uid(req)).then((t) => finance.safeToSpend(uid(req), t)),
      finance.report(uid(req), 'month'),
      finance.upcomingBills(uid(req), 14),
      finance.budgetStatus(uid(req)),
      finance.getIncomeSetting(uid(req)),
      finance.savingsCapacity(uid(req)),
    ]);
    return { today, month_from: monthFrom, safe_to_spend: safe, month, upcoming_bills: bills, budgets, income_setting: income, savings_capacity: capacity };
  });

  // Transactions
  api.get('/api/finance/transactions', async (req) => {
    const q = z.object({ from: z.string().optional(), to: z.string().optional(), category: z.string().optional(), search: z.string().optional() }).parse(req.query);
    return finance.listTransactions(uid(req), q);
  });
  api.post('/api/finance/transactions', async (req, reply) => {
    const tx = await finance.addTransaction(uid(req), transactionInput.parse(req.body));
    await audit(db, uid(req), 'user', 'finance.transaction_added', { id: tx?.id });
    return reply.code(201).send(tx);
  });
  api.patch('/api/finance/transactions/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ category: z.enum(CATEGORIES), remember: z.boolean().optional() }).parse(req.body);
    return (await finance.recategorise(uid(req), id, b.category, b.remember)) ?? reply.code(404).send({ error: 'Not found' });
  });
  api.delete('/api/finance/transactions/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    if (!(await finance.deleteTransaction(uid(req), id))) return reply.code(404).send({ error: 'Not found' });
    await audit(db, uid(req), 'user', 'finance.transaction_deleted', { id });
    return { ok: true };
  });
  api.get('/api/finance/rules', async (req) => finance.rules(uid(req)));
  api.delete('/api/finance/rules/:id', async (req) => ({ deleted: await finance.deleteRule(uid(req), idParam.parse(req.params).id) }));

  // CSV import: preview first, then import with the confirmed column mapping.
  api.post('/api/finance/import/preview', async (req, reply) => {
    const { csv } = z.object({ csv: z.string().min(1).max(MAX_CSV) }).parse(req.body);
    try { return previewCsv(csv); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  api.post('/api/finance/import', async (req) => {
    const { csv, mapping } = z.object({ csv: z.string().min(1).max(MAX_CSV), mapping: mappingSchema }).parse(req.body);
    const result = await importCsv(finance, uid(req), csv, mapping);
    await audit(db, uid(req), 'user', 'finance.csv_imported', { imported: result.imported, duplicates: result.duplicates, errors: result.errors.length });
    return result;
  });

  // Income, budgets
  api.put('/api/finance/income', async (req) => {
    const r = await finance.setIncome(uid(req), incomeInput.parse(req.body));
    await audit(db, uid(req), 'user', 'finance.income_set');
    return r;
  });
  api.get('/api/finance/budgets', async (req) => finance.budgetStatus(uid(req)));
  api.put('/api/finance/budgets', async (req) => {
    const b = await finance.setBudget(uid(req), budgetInput.parse(req.body));
    await audit(db, uid(req), 'user', 'finance.budget_set', b);
    return b;
  });
  api.delete('/api/finance/budgets/:id', async (req) => ({ deleted: await finance.deleteBudget(uid(req), idParam.parse(req.params).id) }));

  // Bills
  api.get('/api/finance/bills', async (req) => finance.listBills(uid(req), true));
  api.post('/api/finance/bills', async (req, reply) => reply.code(201).send(await finance.addBill(uid(req), billInput.parse(req.body))));
  api.patch('/api/finance/bills/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    return (await finance.updateBill(uid(req), id, req.body as object)) ?? reply.code(404).send({ error: 'Not found' });
  });
  api.post('/api/finance/bills/:id/paid', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const o = z.object({ paid_date: z.string().optional(), record_transaction: z.boolean().optional() }).parse(req.body ?? {});
    const r = await finance.markBillPaid(uid(req), id, o);
    if (!r) return reply.code(404).send({ error: 'Not found' });
    await audit(db, uid(req), 'user', 'finance.bill_marked_paid', { id });
    return r;
  });
  api.delete('/api/finance/bills/:id', async (req) => ({ deleted: await finance.deleteBill(uid(req), idParam.parse(req.params).id) }));

  // Debts
  api.get('/api/finance/debts', async (req) => finance.listDebts(uid(req)));
  api.post('/api/finance/debts', async (req, reply) => reply.code(201).send(await finance.addDebt(uid(req), debtInput.parse(req.body))));
  api.patch('/api/finance/debts/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    return (await finance.updateDebt(uid(req), id, req.body as object)) ?? reply.code(404).send({ error: 'Not found' });
  });
  api.delete('/api/finance/debts/:id', async (req) => ({ deleted: await finance.deleteDebt(uid(req), idParam.parse(req.params).id) }));

  // Reports and insights
  api.get('/api/finance/report', async (req) => {
    const q = z.object({ period: z.enum(['week', 'month']).default('month'), date: z.string().optional() }).parse(req.query);
    return finance.report(uid(req), q.period, q.date);
  });
  api.get('/api/finance/insights', async (req) => finance.insights(uid(req)));

  // Goals
  api.get('/api/goals', async (req) => goals.list(uid(req), true));
  api.post('/api/goals', async (req, reply) => {
    const g = await goals.create(uid(req), goalInput.parse(req.body));
    await audit(db, uid(req), 'user', 'goal.created', { id: g?.id });
    return reply.code(201).send(g);
  });
  api.patch('/api/goals/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    return (await goals.update(uid(req), id, goalPatch.parse(req.body))) ?? reply.code(404).send({ error: 'Not found' });
  });
  api.delete('/api/goals/:id', async (req) => ({ deleted: await goals.remove(uid(req), idParam.parse(req.params).id) }));
  api.post('/api/goals/:id/contributions', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ amount_cents: z.number().int(), date: z.string().optional(), note: z.string().max(200).optional() }).parse(req.body);
    return (await goals.contribute(uid(req), id, b.amount_cents, b.date, b.note)) ?? reply.code(404).send({ error: 'Not found' });
  });
  api.get('/api/goals/:id/advice', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    return (await goals.advice(uid(req), id)) ?? reply.code(404).send({ error: 'Not found' });
  });
}
