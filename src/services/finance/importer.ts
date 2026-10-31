import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseCsv } from '../../lib/csv.js';
import { parseMoney } from '../../lib/money.js';
import { isValidIsoDate } from '../../lib/time.js';
import type { FinanceService } from './finance.js';

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

/** Australian bank dates: 31/10/2026, 31/10/26, 31-10-2026, 2026-10-31, 31 Oct 2026. Day comes first (never US order). */
export function parseAuDate(s: string): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return norm(m[1], m[2], m[3]);
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) return norm(m[3].length === 2 ? `20${m[3]}` : m[3], m[2], m[1]);
  m = t.match(/^(\d{1,2})[ -]([A-Za-z]{3})[A-Za-z]*[ -](\d{2,4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return norm(m[3].length === 2 ? `20${m[3]}` : m[3], MONTHS[m[2].toLowerCase()], m[1]);
  return null;
}
function norm(y: string, mo: string, d: string) {
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return isValidIsoDate(iso) ? iso : null;
}

export const mappingSchema = z.object({
  hasHeader: z.boolean(),
  date: z.number().int().min(0),
  description: z.number().int().min(0),
  amount: z.number().int().min(0).optional(),     // one signed amount column
  debit: z.number().int().min(0).optional(),      // or separate debit / credit columns
  credit: z.number().int().min(0).optional(),
  invert: z.boolean().optional(),                 // for banks that show spending as positive numbers
}).refine((m) => m.amount !== undefined || m.debit !== undefined || m.credit !== undefined, 'Choose an amount column, or debit/credit columns');
export type Mapping = z.infer<typeof mappingSchema>;

/** Looks at the file and guesses which column is which. You confirm it before anything is saved. */
export function previewCsv(text: string) {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error('The file is empty.');
  const first = rows[0];
  const hasHeader = first.every((c) => parseMoney(c) === null && parseAuDate(c) === null) && first.some((c) => /[a-z]/i.test(c));
  const header = hasHeader ? first : first.map((_, i) => `Column ${i + 1}`);
  const data = hasHeader ? rows.slice(1) : rows;
  const sample = data.slice(0, 8);
  const find = (re: RegExp) => header.findIndex((h) => re.test(h));
  // A column "looks like" dates or amounts when most sample rows (60%+) parse that way. Odd rows are tolerated.
  const mostly = (i: number, ok: (v: string) => boolean) => sample.length > 0 && sample.filter((r) => r[i] !== undefined && r[i] !== '' && ok(r[i])).length >= Math.ceil(sample.length * 0.6);
  const guess: Partial<Mapping> & { hasHeader: boolean } = { hasHeader };
  // Date: header name, else the first column whose values parse as dates.
  guess.date = hasHeader && find(/date/i) >= 0 ? find(/date/i) : header.findIndex((_, i) => mostly(i, (v) => parseAuDate(v) !== null));
  const debit = find(/debit|withdraw|money out|paid out/i); const credit = find(/credit|deposit|money in|paid in/i);
  const amount = find(/^amount$|amount|value/i);
  if (hasHeader && debit >= 0 && credit >= 0 && amount < 0) { guess.debit = debit; guess.credit = credit; }
  else if (amount >= 0) guess.amount = amount;
  else {
    // No header (e.g. CommBank: Date, Amount, Description, Balance): first numeric column after the date.
    const idx = header.findIndex((_, i) => i !== guess.date && mostly(i, (v) => parseMoney(v) !== null));
    if (idx >= 0) guess.amount = idx;
  }
  const textCol = (() => {
    const named = find(/desc|narrative|details|transaction|merchant|payee|particulars|memo/i);
    if (hasHeader && named >= 0 && named !== guess.amount) return named;
    let best = -1, bestLen = 0;
    header.forEach((_, i) => {
      if (i === guess.date || i === guess.amount || i === guess.debit || i === guess.credit) return;
      const len = sample.reduce((s, r) => s + (r[i] && parseMoney(r[i]) === null ? r[i].length : 0), 0);
      if (len > bestLen) { best = i; bestLen = len; }
    });
    return best;
  })();
  guess.description = textCol;
  return { header, sample, total_rows: data.length, guess };
}

export interface ImportResult { imported: number; duplicates: number; errors: { row: number; error: string }[] }

/** Imports rows using a confirmed column mapping. Re-importing the same file adds nothing twice. */
export async function importCsv(finance: FinanceService, userId: number, text: string, mappingInput: Mapping): Promise<ImportResult> {
  const mapping = mappingSchema.parse(mappingInput);
  const rows = parseCsv(text);
  const data = mapping.hasHeader ? rows.slice(1) : rows;
  const seen = new Map<string, number>();
  const result: ImportResult = { imported: 0, duplicates: 0, errors: [] };
  for (let i = 0; i < data.length; i++) {
    const r = data[i];
    const lineNo = i + 1 + (mapping.hasHeader ? 1 : 0);
    const date = parseAuDate(r[mapping.date] ?? '');
    const description = (r[mapping.description] ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    let amount: number | null = null;
    if (mapping.amount !== undefined) amount = parseMoney(r[mapping.amount] ?? '');
    else {
      const d = mapping.debit !== undefined && r[mapping.debit] ? parseMoney(r[mapping.debit]) : null;
      const c = mapping.credit !== undefined && r[mapping.credit] ? parseMoney(r[mapping.credit]) : null;
      if (d !== null && d !== 0) amount = -Math.abs(d);
      else if (c !== null && c !== 0) amount = Math.abs(c);
    }
    if (amount !== null && mapping.invert) amount = -amount;
    if (!date) { result.errors.push({ row: lineNo, error: `Unreadable date "${r[mapping.date] ?? ''}"` }); continue; }
    if (amount === null || amount === 0) { result.errors.push({ row: lineNo, error: 'Missing or zero amount' }); continue; }
    if (!description) { result.errors.push({ row: lineNo, error: 'Missing description' }); continue; }
    // Identical rows on the same day (two $5 coffees) are kept apart by counting occurrences.
    const base = `${date}|${amount}|${description.toLowerCase()}`;
    const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
    const hash = createHash('sha256').update(`${base}|${n}`).digest('hex').slice(0, 32);
    const tx = await finance.addTransaction(userId, { date, amount_cents: amount, description }, 'csv', hash);
    if (tx) result.imported++; else result.duplicates++;
  }
  return result;
}
