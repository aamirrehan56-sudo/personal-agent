// Money helpers. All amounts are whole cents (AUD) so 0.1 + 0.2 problems never happen.

/** Parses "$1,234.56", "1234.5", "-45", "(45.00)" into cents. Returns null if it isn't a number. */
export function parseMoney(input: string | number): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : null;
  let s = input.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/\b(DR|debit)\b/i.test(s)) negative = true;
  s = s.replace(/\b(CR|DR|AUD)\b/gi, '').replace(/[$,\s]/g, '');
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d+(\.\d{1,2})?$|^\.\d{1,2}$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return negative ? -cents : cents;
}

/** Converts a per-period amount to its weekly or monthly equivalent. */
const PER_YEAR: Record<string, number> = { weekly: 52, fortnightly: 26, monthly: 12, quarterly: 4, yearly: 1, once: 0 };
export function toWeekly(cents: number, frequency: string): number { return Math.round((cents * (PER_YEAR[frequency] ?? 0)) / 52); }
export function toMonthly(cents: number, frequency: string): number { return Math.round((cents * (PER_YEAR[frequency] ?? 0)) / 12); }

export function aud(cents: number): string {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(cents / 100);
}
