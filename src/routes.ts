import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db/pool.js';
import { requireUser } from './auth/auth.js';
import { audit, listAudit } from './services/audit/audit.js';
import { TaskService, taskInput, taskPatch } from './services/tasks/tasks.js';
import { MemoryService, SensitiveDataError, memoryInput } from './services/memory/memory.js';
import { Agent, AgentNotConfiguredError, toDisplay } from './services/ai/agent.js';
import { decidePending, listPending } from './services/ai/executor.js';
import { getPermissions, setMode } from './services/ai/permissions.js';
import type { ToolContext } from './services/ai/tools.js';
import type { FinanceService } from './services/finance/finance.js';
import { GoalError, type GoalService } from './services/goals/goals.js';
import { registerFinanceRoutes } from './services/finance/routes.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

export function registerRoutes(app: FastifyInstance, db: Db, deps: { tasks: TaskService; memory: MemoryService; finance: FinanceService; goals: GoalService; agent: Agent; model: string }) {
  const { tasks, memory, finance, goals, agent } = deps;
  const ctx = (userId: number): ToolContext => ({ userId, tasks, memory, finance, goals });

  app.register(async (api) => {
    api.addHook('preHandler', requireUser);

    // Turn validation errors into friendly 400 responses.
    api.setErrorHandler((err, _req, reply) => {
      if (err instanceof z.ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      if (err instanceof GoalError) return reply.code(400).send({ error: err.message });
      if (err instanceof SensitiveDataError) return reply.code(400).send({ error: err.message });
      if (err instanceof AgentNotConfiguredError) return reply.code(503).send({ error: err.message });
      const status = (err as { statusCode?: number }).statusCode;
      if (status && status >= 400 && status < 500) return reply.code(status).send({ error: (err as Error).message });
      api.log.error(err);
      return reply.code(500).send({ error: 'Something went wrong on the server. Check the server log.' });
    });

    api.get('/api/me', async (req) => {
      const { rows } = await db.query('SELECT id, email, display_name, created_at FROM users WHERE id=$1', [req.userId]);
      return { ...rows[0], ai_configured: agent.configured, ai_model: deps.model };
    });

    // ---- Home briefing (built from real data only) ----
    api.get('/api/home', async (req) => {
      const overview = await tasks.overview(req.userId!);
      const pending = (await listPending(db, req.userId!)).filter((p) => p.status === 'pending');
      const goalList = (await goals.list(req.userId!)).filter((g) => g.status === 'active' || g.status === 'achieved')
        .map(({ contributions, progress, ...g }) => g);
      return {
        overview, pending_approvals: pending, week: await tasks.weeklyReport(req.userId!),
        safe_to_spend: await finance.safeToSpend(req.userId!, await goals.weeklyTargets(req.userId!)),
        upcoming_bills: await finance.upcomingBills(req.userId!, 7),
        goals: goalList,
      };
    });

    // ---- Tasks ----
    api.get('/api/tasks', async (req) => {
      const q = z.object({
        status: z.enum(['todo', 'done', 'cancelled', 'all']).optional(),
        from: z.string().optional(), to: z.string().optional(),
        overdue: z.coerce.boolean().optional(), search: z.string().optional(),
      }).parse(req.query);
      return tasks.list(req.userId!, q);
    });
    api.get('/api/tasks/overview', async (req) => tasks.overview(req.userId!, z.object({ date: z.string().optional() }).parse(req.query).date));
    api.get('/api/tasks/weekly-report', async (req) => tasks.weeklyReport(req.userId!, z.object({ date: z.string().optional() }).parse(req.query).date));
    api.post('/api/tasks', async (req, reply) => {
      const t = await tasks.create(req.userId!, taskInput.parse(req.body));
      await audit(db, req.userId!, 'user', 'task.created', { id: t.id });
      return reply.code(201).send(t);
    });
    api.patch('/api/tasks/:id', async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const t = await tasks.update(req.userId!, id, taskPatch.parse(req.body));
      return t ?? reply.code(404).send({ error: 'Task not found' });
    });
    api.post('/api/tasks/:id/complete', async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const r = await tasks.complete(req.userId!, id);
      return r.task ? r : reply.code(404).send({ error: 'Task not found' });
    });
    api.delete('/api/tasks/:id', async (req, reply) => {
      const { id } = idParam.parse(req.params);
      if (!(await tasks.remove(req.userId!, id))) return reply.code(404).send({ error: 'Task not found' });
      await audit(db, req.userId!, 'user', 'task.deleted', { id });
      return { ok: true };
    });

    registerFinanceRoutes(api, db, finance, goals);

    // ---- Memory ----
    api.get('/api/memory', async (req) => memory.list(req.userId!));
    api.get('/api/memory/export', async (req, reply) => {
      const items = await memory.list(req.userId!);
      await audit(db, req.userId!, 'user', 'memory.exported', { count: items.length });
      reply.header('Content-Disposition', 'attachment; filename="agent-memory.json"');
      return { exported_at: new Date().toISOString(), items };
    });
    api.post('/api/memory', async (req, reply) => reply.code(201).send(await memory.upsert(req.userId!, memoryInput.parse(req.body))));
    api.put('/api/memory/:id', async (req, reply) => {
      const { id } = idParam.parse(req.params);
      return (await memory.update(req.userId!, id, memoryInput.parse(req.body))) ?? reply.code(404).send({ error: 'Not found' });
    });
    api.delete('/api/memory/:id', async (req, reply) => {
      const { id } = idParam.parse(req.params);
      if (!(await memory.remove(req.userId!, id))) return reply.code(404).send({ error: 'Not found' });
      await audit(db, req.userId!, 'user', 'memory.deleted', { id });
      return { ok: true };
    });
    api.delete('/api/memory', async (req) => {
      const n = await memory.removeAll(req.userId!);
      await audit(db, req.userId!, 'user', 'memory.deleted_all', { count: n });
      return { deleted: n };
    });

    // ---- AI chat ----
    api.get('/api/conversations', async (req) => {
      const { rows } = await db.query('SELECT id, title, updated_at FROM conversations WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 50', [req.userId]);
      return rows;
    });
    api.get('/api/conversations/:id', async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const c = await db.query('SELECT id, title FROM conversations WHERE id=$1 AND user_id=$2', [id, req.userId]);
      if (!c.rows[0]) return reply.code(404).send({ error: 'Not found' });
      const m = await db.query('SELECT id, role, content, created_at FROM chat_messages WHERE conversation_id=$1 ORDER BY id', [id]);
      return { ...c.rows[0], messages: toDisplay(m.rows), pending: await listPending(db, req.userId!, id) };
    });
    api.delete('/api/conversations/:id', async (req) => {
      const { id } = idParam.parse(req.params);
      await db.query('DELETE FROM conversations WHERE id=$1 AND user_id=$2', [id, req.userId]);
      return { ok: true };
    });
    api.post('/api/chat', async (req) => {
      const body = z.object({ message: z.string().trim().min(1).max(8000), conversationId: z.number().int().optional() }).parse(req.body);
      return agent.chat(ctx(req.userId!), body.message, body.conversationId);
    });

    // ---- Approvals ----
    api.get('/api/approvals', async (req) => listPending(db, req.userId!));
    api.post('/api/approvals/:id', async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const { approve } = z.object({ approve: z.boolean() }).parse(req.body);
      return (await decidePending(db, ctx(req.userId!), id, approve)) ?? reply.code(404).send({ error: 'No pending action with that id' });
    });

    // ---- Settings: permissions & audit ----
    api.get('/api/permissions', async (req) => getPermissions(db, req.userId!));
    api.put('/api/permissions/:tool', async (req, reply) => {
      const { tool } = z.object({ tool: z.string() }).parse(req.params);
      const { mode } = z.object({ mode: z.enum(['allow', 'approve', 'deny']) }).parse(req.body);
      try {
        await setMode(db, req.userId!, tool, mode);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      await audit(db, req.userId!, 'user', 'permission.changed', { tool, mode });
      return getPermissions(db, req.userId!);
    });
    api.get('/api/audit', async (req) => listAudit(db, req.userId!, 200));
  });
}
