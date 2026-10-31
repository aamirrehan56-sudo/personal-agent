// Date helpers that always work in the user's local timezone (Australia/Melbourne by default).
// Dates are stored as plain 'YYYY-MM-DD' calendar dates so daylight saving never shifts them.

export const DEFAULT_TZ = 'Australia/Melbourne';

function parts(date: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-AU', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'long',
  });
  const out: Record<string, string> = {};
  for (const p of f.formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** Today's local date as YYYY-MM-DD. */
export function localDate(now: Date = new Date(), tz = DEFAULT_TZ): string {
  const p = parts(now, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Local time as HH:MM (24h). */
export function localTime(now: Date = new Date(), tz = DEFAULT_TZ): string {
  const p = parts(now, tz);
  return `${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

export function localWeekday(now: Date = new Date(), tz = DEFAULT_TZ): string {
  return parts(now, tz).weekday;
}

/** Adds days to a YYYY-MM-DD date (pure calendar maths, no timezone involved). */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addMonths(isoDate: string, months: number): string {
  const [y, m, day] = isoDate.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday, for a YYYY-MM-DD date. */
export function dayOfWeek(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

/** Monday of the week containing the date (Australian weeks start on Monday). */
export function startOfWeek(isoDate: string): string {
  const dow = dayOfWeek(isoDate);
  return addDays(isoDate, dow === 0 ? -6 : 1 - dow);
}

export function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Formats YYYY-MM-DD as an Australian date, e.g. "Fri 6 Nov 2026". */
export function formatAuDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(d);
}

/** Formats a number of cents as AUD, e.g. 123456 -> "$1,234.56". */
export function formatAud(cents: number): string {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(cents / 100);
}
