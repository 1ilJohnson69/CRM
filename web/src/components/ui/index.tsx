import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, Ban, Banknote, CheckCircle2, ChevronLeft, ChevronRight, Clock, CreditCard,
  Hourglass, Inbox, Landmark, Loader2, Minus, MoreHorizontal, Smartphone, Snowflake, X, XCircle,
} from 'lucide-react';
import { initials, METHOD_LABEL } from '../../lib/format';

export function Button({
  variant, size, loading, icon, children, className, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger'; size?: 'sm' | 'lg'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button className={clsx('btn', variant, size, className)} disabled={loading || rest.disabled} {...rest}>
      {loading ? <Loader2 className="spin" /> : icon}
      {children}
    </button>
  );
}

export function Card({ title, icon, sub, actions, children, className, bodyClass, glow }: {
  title?: ReactNode; icon?: ReactNode; sub?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; bodyClass?: string; glow?: 'strong' | 'soft';
}) {
  return (
    <section className={clsx('card', glow === 'strong' && 'glow', glow === 'soft' && 'glow-soft', className)}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            <h3>
              {icon && <span className="hicon">{icon}</span>}
              {title}
            </h3>
            {sub && <div className="sub" style={{ marginTop: 2 }}>{sub}</div>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className={bodyClass ?? 'card-body'}>{children}</div>
    </section>
  );
}

// ------------------------------------------------------------ status badge --

const STATUS: Record<string, { label: string; tone: string; icon: ReactNode }> = {
  active: { label: 'Active', tone: 'success', icon: <CheckCircle2 /> },
  expiring_soon: { label: 'Expiring soon', tone: 'warning', icon: <Hourglass /> },
  expired: { label: 'Expired', tone: 'danger', icon: <XCircle /> },
  frozen: { label: 'Frozen', tone: 'info', icon: <Snowflake /> },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: <Ban /> },
  pending: { label: 'Payment pending', tone: 'accent', icon: <Clock /> },
  none: { label: 'No plan', tone: 'neutral', icon: <Minus /> },
  paid: { label: 'Paid', tone: 'success', icon: <CheckCircle2 /> },
  partially_paid: { label: 'Partially paid', tone: 'warning', icon: <Hourglass /> },
  refunded: { label: 'Refunded', tone: 'info', icon: <ArrowDownRight /> },
  void: { label: 'Void', tone: 'neutral', icon: <Ban /> },
  recorded: { label: 'Recorded', tone: 'success', icon: <CheckCircle2 /> },
  voided: { label: 'Voided', tone: 'neutral', icon: <Ban /> },
};
export const statusMeta = (s: string) => STATUS[s] ?? { label: s, tone: 'neutral', icon: null };

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const m = statusMeta(status);
  // Invoice "pending" reads differently from membership "pending".
  return <span className={`badge ${m.tone}`}>{m.icon}{label ?? m.label}</span>;
}

export function Badge({ tone = 'neutral', children }: { tone?: string; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

const METHOD_ICON: Record<string, ReactNode> = {
  cash: <Banknote />, upi: <Smartphone />, card: <CreditCard />, bank_transfer: <Landmark />, other: <MoreHorizontal />,
};
export const methodIcon = (m: string) => METHOD_ICON[m];
export function Method({ method }: { method: string }) {
  return <span className="method">{METHOD_ICON[method]}{METHOD_LABEL[method] ?? method}</span>;
}

export function Trend({ value, suffix = '%', invert }: { value: number; suffix?: string; invert?: boolean }) {
  const dir = Math.abs(value) < 0.05 ? 'flat' : value > 0 ? 'up' : 'down';
  const good = invert ? (dir === 'up' ? 'down' : dir === 'down' ? 'up' : 'flat') : dir;
  return (
    <span className={`trend ${good}`}>
      {dir === 'up' ? <ArrowUpRight /> : dir === 'down' ? <ArrowDownRight /> : <Minus />}
      {Math.abs(value).toFixed(1)}{suffix}
    </span>
  );
}

export function Avatar({ name, size, gold }: { name: string; size?: 'sm' | 'lg'; gold?: boolean }) {
  // Stable tint per person so lists are scannable without being colorful.
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  const style = gold ? undefined : { background: `color-mix(in srgb, hsl(${h} 35% 45%) 22%, var(--surface-3))` };
  return <span className={clsx('avatar', size, gold && 'gold')} style={style} aria-hidden>{initials(name)}</span>;
}

export function Person({ name, detail, size }: { name: string; detail?: ReactNode; size?: 'sm' | 'lg' }) {
  return (
    <span className="person">
      <Avatar name={name} size={size} />
      <span style={{ minWidth: 0 }}>
        <span className="n" style={{ display: 'block' }}>{name}</span>
        {detail && <span className="d">{detail}</span>}
      </span>
    </span>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="ic">{icon ?? <Inbox size={20} />}</div>
      <b>{title}</b>
      {children && <div style={{ maxWidth: 360 }}>{children}</div>}
    </div>
  );
}

export function Skeleton({ h = 16, w = '100%', r }: { h?: number; w?: number | string; r?: number }) {
  return <div className="skeleton" style={{ height: h, width: w, borderRadius: r }} />;
}

export function Pagination({ page, totalPages, total, onPage }: { page: number; totalPages: number; total: number; onPage: (p: number) => void }) {
  return (
    <div className="pager">
      <span className="num">{total.toLocaleString('en-IN')} results</span>
      <div className="row">
        <span className="num hide-sm">Page {page} of {totalPages}</span>
        <Button size="sm" icon={<ChevronLeft />} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page" />
        <Button size="sm" icon={<ChevronRight />} disabled={page >= totalPages} onClick={() => onPage(page + 1)} aria-label="Next page" />
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: string; disabled?: boolean; hint?: string }[]; value: T; onChange: (k: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key} className={clsx(value === t.key && 'on')} disabled={t.disabled} title={t.hint} onClick={() => onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string | number>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={String(o.value)} role="radio" aria-checked={o.value === value} className={clsx(o.value === value && 'on')} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------- modal / drawer --

// Stacked dialogs (a contact modal over a lead drawer): Escape closes only the top one.
const escapeStack: symbol[] = [];
function useEscape(onClose: () => void, active = true) {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    if (!active) return;
    const id = Symbol();
    escapeStack.push(id);
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && escapeStack.at(-1) === id) {
        e.stopPropagation();
        latest.current();
      }
    };
    window.addEventListener('keydown', h);
    return () => {
      window.removeEventListener('keydown', h);
      escapeStack.splice(escapeStack.indexOf(id), 1);
    };
  }, [active]);
}

export function Dialog({ open, onClose, title, sub, children, footer, variant = 'modal', wide }: {
  open: boolean; onClose: () => void; title: ReactNode; sub?: ReactNode; children: ReactNode; footer?: ReactNode; variant?: 'modal' | 'drawer'; wide?: boolean;
}) {
  useEscape(onClose, open);
  if (!open) return null;
  return createPortal(
    <>
      <div className="overlay" onClick={onClose} />
      <div className={clsx(variant, wide && 'wide')} role="dialog" aria-modal="true">
        <div className="dialog-head">
          <div>
            <h2>{title}</h2>
            {sub && <div className="sub">{sub}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X /></button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </>,
    document.body,
  );
}

export function Field({ label, error, hint, children, className }: { label: string; error?: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('field', className)}>
      <label>{label}</label>
      {children}
      {error ? <span className="err">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Popover({ trigger, children, align = 'right', width }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; width?: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  useEscape(() => setOpen(false), open);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div className="popover" style={{ [align]: 0, top: 46, width }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function Alert({ tone, children }: { tone?: 'info' | 'warning'; children: ReactNode }) {
  return <div className={clsx('alert', tone)} role="alert">{tone === 'warning' && <AlertTriangle size={14} style={{ verticalAlign: -2, marginRight: 6 }} />}{children}</div>;
}
