import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/pool.js';
import { freshDb, testApp, H } from './helpers.js';

let db: Db; let app: FastifyInstance; let cookie = '';

before(async () => { db = await freshDb(); app = await testApp(db); });
after(async () => { await app.close(); await db.end(); });

const call = (method: string, url: string, payload?: unknown, withCookie = true) =>
  app.inject({ method: method as any, url, payload: payload as any, headers: { ...H, ...(withCookie && cookie ? { cookie } : {}) } });

test('first-run setup requires the setup code and a strong password', async () => {
  assert.equal((await call('GET', '/api/auth/status')).json().needsSetup, true);
  let r = await call('POST', '/api/auth/setup', { setupCode: 'wrong', email: 'me@example.com', password: 'a-very-long-password' });
  assert.equal(r.statusCode, 403);
  r = await call('POST', '/api/auth/setup', { setupCode: 'setup-123', email: 'me@example.com', password: 'short' });
  assert.equal(r.statusCode, 400);
  r = await call('POST', '/api/auth/setup', { setupCode: 'setup-123', email: 'Me@Example.com', password: 'a-very-long-password', displayName: 'Aamir' });
  assert.equal(r.statusCode, 200);
  const set = String(r.headers['set-cookie']);
  assert.match(set, /HttpOnly/i);
  assert.match(set, /SameSite=Strict/i);
  cookie = set.split(';')[0];
  // A second account cannot be created.
  r = await call('POST', '/api/auth/setup', { setupCode: 'setup-123', email: 'x@example.com', password: 'a-very-long-password' }, false);
  assert.equal(r.statusCode, 409);
});

test('API requires login', async () => {
  assert.equal((await call('GET', '/api/tasks', undefined, false)).statusCode, 401);
  assert.equal((await call('GET', '/api/me')).json().display_name, 'Aamir');
});

test('login, wrong password and rate limiting', async () => {
  const bad = await call('POST', '/api/auth/login', { email: 'me@example.com', password: 'nope' }, false);
  assert.equal(bad.statusCode, 401);
  const ok = await call('POST', '/api/auth/login', { email: 'me@example.com', password: 'a-very-long-password' }, false);
  assert.equal(ok.statusCode, 200);
  for (let i = 0; i < 5; i++) await call('POST', '/api/auth/login', { email: 'me@example.com', password: 'nope' }, false);
  const blocked = await call('POST', '/api/auth/login', { email: 'me@example.com', password: 'a-very-long-password' }, false);
  assert.equal(blocked.statusCode, 429);
});

test('state-changing requests without the CSRF header are rejected', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/tasks', payload: { title: 'x' }, headers: { cookie } });
  assert.equal(r.statusCode, 403);
});

test('task API end to end', async () => {
  let r = await call('POST', '/api/tasks', { title: 'Buy groceries', priority: 'high' });
  assert.equal(r.statusCode, 201);
  const id = r.json().id;
  r = await call('POST', '/api/tasks', { title: '' });
  assert.equal(r.statusCode, 400);
  r = await call('POST', `/api/tasks/${id}/complete`);
  assert.equal(r.json().task.status, 'done');
  r = await call('GET', '/api/tasks?status=done');
  assert.equal(r.json().length, 1);
  r = await call('GET', '/api/home');
  assert.equal(r.statusCode, 200);
  assert.ok(Array.isArray(r.json().overview.due_today));
  r = await call('DELETE', `/api/tasks/${id}`);
  assert.equal(r.statusCode, 200);
  assert.equal((await call('DELETE', `/api/tasks/${id}`)).statusCode, 404);
});

test('memory: save, refuse sensitive data, export, delete', async () => {
  let r = await call('POST', '/api/memory', { category: 'preference', key: 'deep work', value: 'Mornings 8-11' });
  assert.equal(r.statusCode, 201);
  r = await call('POST', '/api/memory', { category: 'other', key: 'card', value: '4111 1111 1111 1111' });
  assert.equal(r.statusCode, 400);
  r = await call('GET', '/api/memory/export');
  assert.equal(r.json().items.length, 1);
  assert.match(String(r.headers['content-disposition']), /attachment/);
  r = await call('DELETE', '/api/memory');
  assert.equal(r.json().deleted, 1);
});

test('permissions can be changed and are audited', async () => {
  let r = await call('PUT', '/api/permissions/create_task', { mode: 'approve' });
  assert.equal(r.json().find((p: any) => p.tool === 'create_task').mode, 'approve');
  r = await call('PUT', '/api/permissions/not_a_tool', { mode: 'allow' });
  assert.equal(r.statusCode, 400);
  r = await call('GET', '/api/audit');
  assert.ok(r.json().some((a: any) => a.action === 'permission.changed'));
});

test('chat says clearly when the AI is not configured', async () => {
  const r = await call('POST', '/api/chat', { message: 'hello' });
  assert.equal(r.statusCode, 503);
  assert.match(r.json().error, /ANTHROPIC_API_KEY/);
});

test('logout ends the session', async () => {
  await call('POST', '/api/auth/logout');
  assert.equal((await call('GET', '/api/me')).statusCode, 401);
});

test('dashboard page is served with security headers', async () => {
  const r = await app.inject({ method: 'GET', url: '/' });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /Personal Agent/);
  assert.match(String(r.headers['content-security-policy']), /script-src|default-src 'self'/);
  assert.equal(r.headers['x-frame-options'], 'DENY');
});
