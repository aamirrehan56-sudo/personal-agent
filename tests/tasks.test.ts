import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Db } from '../src/db/pool.js';
import { TaskService } from '../src/services/tasks/tasks.js';
import { localDate, addDays } from '../src/lib/time.js';
import { freshDb, makeUser } from './helpers.js';

let db: Db; let svc: TaskService; let uid: number; let other: number;
const today = localDate();

before(async () => { db = await freshDb(); svc = new TaskService(db, 'Australia/Melbourne'); uid = await makeUser(db); other = await makeUser(db, 'other@example.com'); });
after(async () => { await db.end(); });

test('create, list, update and delete a task', async () => {
  const t = await svc.create(uid, { title: 'Pay electricity', due_date: today, due_time: '09:30', priority: 'high' });
  assert.equal(t.title, 'Pay electricity');
  assert.equal(t.due_date, today);
  assert.equal(t.due_time, '09:30');
  assert.equal((await svc.list(uid, { status: 'todo' })).length, 1);
  const u = await svc.update(uid, t.id, { due_date: addDays(today, 1), priority: 'urgent' });
  assert.equal(u?.due_date, addDays(today, 1));
  assert.equal(u?.priority, 'urgent');
  assert.equal(await svc.remove(uid, t.id), true);
  assert.equal(await svc.get(uid, t.id), null);
});

test('validation rejects bad data', async () => {
  await assert.rejects(() => svc.create(uid, { title: '' }));
  await assert.rejects(() => svc.create(uid, { title: 'x', due_date: '2026-02-30' }));
  await assert.rejects(() => svc.create(uid, { title: 'x', priority: 'super' as any }));
});

test('users cannot see or change each other\'s tasks', async () => {
  const t = await svc.create(other, { title: 'Private' });
  assert.equal(await svc.get(uid, t.id), null);
  assert.equal(await svc.update(uid, t.id, { title: 'hacked' }), null);
  assert.equal(await svc.remove(uid, t.id), false);
  assert.equal((await svc.get(other, t.id))?.title, 'Private');
});

test('completing a recurring task schedules the next one', async () => {
  const t = await svc.create(uid, { title: 'Gym', recurrence: 'daily', is_habit: true, due_date: today });
  const r = await svc.complete(uid, t.id);
  assert.equal(r.task?.status, 'done');
  assert.equal(r.next?.due_date, addDays(today, 1));
  assert.equal(r.next?.is_habit, true);
  // Completing again does not create duplicates.
  const again = await svc.complete(uid, t.id);
  assert.equal(again.next, null);
});

test('overdue recurring task skips forward to a future date', async () => {
  const t = await svc.create(uid, { title: 'Water plants', recurrence: 'weekly', due_date: addDays(today, -20) });
  const r = await svc.complete(uid, t.id);
  assert.ok(r.next!.due_date! >= today);
});

test('overview groups today, overdue, upcoming and completed', async () => {
  await svc.create(uid, { title: 'Late thing', due_date: addDays(today, -2), priority: 'low' });
  await svc.create(uid, { title: 'Today urgent', due_date: today, priority: 'urgent' });
  await svc.create(uid, { title: 'Today low', due_date: today, priority: 'low' });
  await svc.create(uid, { title: 'Next week', due_date: addDays(today, 3) });
  const o = await svc.overview(uid);
  assert.deepEqual(o.due_today.map((t) => t.title), ['Today urgent', 'Today low']);
  assert.ok(o.overdue.some((t) => t.title === 'Late thing'));
  assert.ok(o.upcoming_7_days.some((t) => t.title === 'Next week'));
  assert.ok(o.completed_today.some((t) => t.title === 'Gym'));
});

test('weekly report counts completed tasks', async () => {
  const r = await svc.weeklyReport(uid);
  assert.equal(r.completed_by_day.length, 7);
  assert.ok(r.completed >= 2);
  assert.equal(r.completed_by_day.reduce((s, d) => s + d.completed, 0), r.completed);
});
