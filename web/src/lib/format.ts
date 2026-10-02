const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const money = (n: number | null | undefined, exact = false) => {
  const v = Number(n ?? 0);
  if (exact) return inr2.format(v);
  return inr.format(Math.round(v));
};

/** Indian short scale: ₹18.42L, ₹1.2Cr. */
export function moneyShort(n: number | null | undefined) {
  const v = Number(n ?? 0);
  const abs = Math.abs(v);
  if (abs >= 1e7) return `₹${(v / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `₹${(v / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `₹${(v / 1e3).toFixed(1)}K`;
  return `₹${Math.round(v)}`;
}

export const number = (n: number | null | undefined) => new Intl.NumberFormat('en-IN').format(Number(n ?? 0));

const asDate = (d: string) => new Date(d.length === 10 ? `${d}T00:00:00` : d);

export function date(d: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' }) {
  if (!d) return '—';
  return asDate(d).toLocaleDateString('en-IN', opts);
}
export const dateShort = (d: string | null | undefined) => date(d, { day: '2-digit', month: 'short' });
export const dateTime = (d: string | null | undefined) =>
  d ? asDate(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';

export function relative(d: string | null | undefined) {
  if (!d) return '—';
  const diff = (Date.now() - asDate(d).getTime()) / 1000;
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)}d ago`;
  return date(d);
}

export function daysLabel(days: number | null | undefined) {
  if (days === null || days === undefined) return '—';
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return days > 0 ? `In ${days} days` : `${-days} days ago`;
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

export const today = () => new Date().toLocaleDateString('en-CA');

export const METHOD_LABEL: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', bank_transfer: 'Bank transfer', other: 'Other' };
export const SERVICE_LABEL: Record<string, string> = { membership: 'Membership', pt: 'Personal training', class: 'Classes', product: 'Products', event: 'Events', other: 'Other' };
