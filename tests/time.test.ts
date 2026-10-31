import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, addMonths, formatAud, formatAuDate, isValidIsoDate, localDate, localTime, startOfWeek } from '../src/lib/time.js';
import { nextOccurrence, sortByPriority } from '../src/services/tasks/tasks.js';

test('local date uses Melbourne time, not UTC', () => {
  // 31 Oct 2026 14:30 UTC is 1 Nov 2026 01:30 in Melbourne (AEDT, UTC+11).
  const d = new Date('2026-10-31T14:30:00Z');
  assert.equal(localDate(d), '2026-11-01');
  assert.equal(localTime(d), '01:30');
});

test('calendar maths', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(startOfWeek('2026-11-01'), '2026-10-26'); // Sunday -> previous Monday
  assert.equal(startOfWeek('2026-10-26'), '2026-10-26');
  assert.ok(isValidIsoDate('2026-02-28'));
  assert.ok(!isValidIsoDate('2026-02-30'));
  assert.ok(!isValidIsoDate('6/11/2026'));
});

test('Australian formatting', () => {
  assert.equal(formatAud(123456), '$1,234.56');
  assert.match(formatAuDate('2026-11-06'), /Fri.*6 Nov.*2026/);
});

test('recurrence rules', () => {
  assert.equal(nextOccurrence('2026-11-06', 'daily'), '2026-11-07');
  assert.equal(nextOccurrence('2026-11-06', 'weekdays'), '2026-11-09'); // Fri -> Mon
  assert.equal(nextOccurrence('2026-11-06', 'weekly'), '2026-11-13');
  assert.equal(nextOccurrence('2026-11-06', 'fortnightly'), '2026-11-20');
  assert.equal(nextOccurrence('2026-01-31', 'monthly'), '2026-02-28');
});

test('priority sort: urgent first, then earliest due', () => {
  const sorted = sortByPriority([
    { priority: 'low', due_date: '2026-11-01', due_time: null },
    { priority: 'high', due_date: '2026-11-05', due_time: null },
    { priority: 'urgent', due_date: null, due_time: null },
    { priority: 'high', due_date: '2026-11-02', due_time: null },
  ] as const as any[]);
  assert.deepEqual(sorted.map((t) => `${t.priority}:${t.due_date}`), ['urgent:null', 'high:2026-11-02', 'high:2026-11-05', 'low:2026-11-01']);
});
