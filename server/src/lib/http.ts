import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export function paged<T>(rows: (T & { total_count?: number })[], page: number, pageSize: number) {
  const total = rows[0]?.total_count ?? 0;
  return {
    data: rows.map(({ total_count, ...rest }) => rest),
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
}

export const uuid = z.string().uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date (YYYY-MM-DD)');
export const money = z.coerce.number().min(0).multipleOf(0.01);

export const round2 = (n: number) => Math.round(n * 100) / 100;

export function addToDate(date: string, unit: 'day' | 'month', value: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (unit === 'day') d.setUTCDate(d.getUTCDate() + value);
  else {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + value);
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, lastDay));
  }
  return d.toISOString().slice(0, 10);
}

export const TIMEZONE = process.env.TZ_ORG ?? 'Asia/Kolkata';

export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
