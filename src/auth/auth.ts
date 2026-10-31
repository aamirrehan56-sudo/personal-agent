import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto.js';
import { audit } from '../services/audit/audit.js';

export const SESSION_COOKIE = 'pa_session';
const SESSION_DAYS = 14;

declare module 'fastify' {
  interface FastifyRequest { userId?: number }
}

const passwordSchema = z.string().min(12, 'Password must be at least 12 characters').max(200);

/** Very small in-memory limiter: max 5 failed logins per 15 minutes per IP. */
class LoginLimiter {
  private fails = new Map<string, number[]>();
  blocked(ip: string) {
    const recent = (this.fails.get(ip) ?? []).filter((t) => Date.now() - t < 15 * 60_000);
    this.fails.set(ip, recent);
    return recent.length >= 5;
  }
  fail(ip: string) { this.fails.set(ip, [...(this.fails.get(ip) ?? []), Date.now()]); }
  reset(ip: string) { this.fails.delete(ip); }
}

export async function userCount(db: Db) {
  const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM users');
  return Number(rows[0].n);
}

async function startSession(db: Db, reply: FastifyReply, req: FastifyRequest, userId: number, secure: boolean) {
  const token = randomToken();
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, user_agent, expires_at) VALUES ($1,$2,$3, now() + interval '${SESSION_DAYS} days')`,
    [userId, sha256(token), String(req.headers['user-agent'] ?? '').slice(0, 200)]);
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: SESSION_DAYS * 86400,
  });
}

export function registerAuth(app: FastifyInstance, db: Db, opts: { setupCode: string; cookieSecure: boolean }) {
  const limiter = new LoginLimiter();

  // Attach the logged-in user (if any) to every request.
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const { rows } = await db.query<{ user_id: number }>(
      'SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at > now()', [sha256(token)]);
    if (rows[0]) req.userId = rows[0].user_id;
  });

  // CSRF protection: state-changing API calls must come from our own page (custom header + SameSite cookie).
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'personal-agent') {
      return reply.code(403).send({ error: 'Missing X-Requested-With header' });
    }
  });

  app.get('/api/auth/status', async (req) => ({
    needsSetup: (await userCount(db)) === 0,
    loggedIn: !!req.userId,
  }));

  app.post('/api/auth/setup', async (req, reply) => {
    const body = z.object({
      setupCode: z.string(), email: z.string().email(), password: passwordSchema, displayName: z.string().trim().min(1).max(60).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0].message });
    if ((await userCount(db)) > 0) return reply.code(409).send({ error: 'Account already exists. Please log in.' });
    if (body.data.setupCode !== opts.setupCode) return reply.code(403).send({ error: 'Setup code is incorrect (see SETUP_CODE in .env).' });
    const { rows } = await db.query<{ id: number }>(
      'INSERT INTO users (email, display_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
      [body.data.email.toLowerCase(), body.data.displayName ?? 'Me', await hashPassword(body.data.password)]);
    await audit(db, rows[0].id, 'user', 'auth.account_created');
    await startSession(db, reply, req, rows[0].id, opts.cookieSecure);
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const ip = req.ip;
    if (limiter.blocked(ip)) return reply.code(429).send({ error: 'Too many failed attempts. Try again in 15 minutes.' });
    const body = z.object({ email: z.string(), password: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Email and password are required' });
    const { rows } = await db.query<{ id: number; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE email=$1', [body.data.email.toLowerCase()]);
    const user = rows[0];
    if (!user || !(await verifyPassword(body.data.password, user.password_hash))) {
      limiter.fail(ip);
      await audit(db, user?.id ?? null, 'user', 'auth.login_failed', { ip });
      return reply.code(401).send({ error: 'Incorrect email or password' });
    }
    limiter.reset(ip);
    await startSession(db, reply, req, user.id, opts.cookieSecure);
    await audit(db, user.id, 'user', 'auth.login', { ip });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await db.query('DELETE FROM sessions WHERE token_hash=$1', [sha256(token)]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/change-password', { preHandler: requireUser }, async (req, reply) => {
    const body = z.object({ current: z.string(), next: passwordSchema }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0].message });
    const { rows } = await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=$1', [req.userId]);
    if (!(await verifyPassword(body.data.current, rows[0].password_hash))) return reply.code(401).send({ error: 'Current password is incorrect' });
    await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [req.userId, await hashPassword(body.data.next)]);
    // Sign out every other device.
    await db.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash <> $2', [req.userId, sha256(req.cookies[SESSION_COOKIE]!)]);
    await audit(db, req.userId!, 'user', 'auth.password_changed');
    return { ok: true };
  });

  app.get('/api/auth/sessions', { preHandler: requireUser }, async (req) => {
    const { rows } = await db.query(
      `SELECT id, user_agent, created_at, expires_at, token_hash = $2 AS current FROM sessions
       WHERE user_id=$1 AND expires_at > now() ORDER BY created_at DESC`, [req.userId, sha256(req.cookies[SESSION_COOKIE]!)]);
    return rows;
  });

  app.post('/api/auth/sessions/revoke-others', { preHandler: requireUser }, async (req) => {
    const r = await db.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash <> $2', [req.userId, sha256(req.cookies[SESSION_COOKIE]!)]);
    await audit(db, req.userId!, 'user', 'auth.sessions_revoked', { count: r.rowCount });
    return { revoked: r.rowCount };
  });
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  if (!req.userId) return reply.code(401).send({ error: 'Please log in' });
}
