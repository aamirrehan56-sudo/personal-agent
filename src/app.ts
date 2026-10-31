import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import type { Db } from './db/pool.js';
import { registerAuth } from './auth/auth.js';
import { registerRoutes } from './routes.js';
import { TaskService } from './services/tasks/tasks.js';
import { MemoryService } from './services/memory/memory.js';
import { Agent, anthropicCreate, type CreateMessage } from './services/ai/agent.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

export async function buildApp(config: Config, db: Db, opts: { createMessage?: CreateMessage | null; logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 1_000_000 });

  // Basic security headers.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'");
  });

  await app.register(cookie);
  registerAuth(app, db, { setupCode: config.setupCode, cookieSecure: config.cookieSecure });

  const create = opts.createMessage !== undefined ? opts.createMessage : (config.anthropicApiKey ? anthropicCreate(config.anthropicApiKey) : null);
  const tasks = new TaskService(db, config.timezone);
  const memory = new MemoryService(db);
  const agent = new Agent(db, create, { model: config.aiModel, effort: config.aiEffort, timezone: config.timezone });
  registerRoutes(app, db, { tasks, memory, agent, model: config.aiModel });

  app.get('/health', async () => {
    await db.query('SELECT 1');
    return { ok: true };
  });

  await app.register(fastifyStatic, { root: PUBLIC_DIR, index: 'index.html' });
  return app;
}
