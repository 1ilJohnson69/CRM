import { useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, Gift, Minus, Package, Plus, Printer, Receipt, RotateCcw, Search, ShoppingBag, Trash2, User, UserPlus, X } from 'lucide-react';
import { api, ApiError, branchScope, openPdf, type Paged } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced, useToast } from '../../lib/ui';
import { dateTime, METHOD_LABEL, money, today } from '../../lib/format';
import { Alert, Button, Card, Dialog, Empty, Method, Pagination, Person, Skeleton, Tabs } from '../../components/ui';
import { MemberPicker, MethodPicker, referenceLabel, referenceRequired, type MemberPick } from '../shared';
import { CATEGORY_LABEL, RefundDialog } from './common';

interface Product { id: string; sku: string; barcode: string | null; name: string; category: string; brand: string; selling_price: number; tax_rate: number; track_stock: boolean; low_stock_threshold: number; stock: number }
interface Line { product: Product; quantity: number; discount: number }
interface Tender { method: string; amount: number | ''; reference: string }

const lineTotal = (l: Line) => {
  const net = l.product.selling_price * l.quantity - l.discount;
  return net + (net * l.product.tax_rate) / 100;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

function useBranchPick() {
  const { me } = useAuth();
  const scoped = branchScope.get();
  const mine = me?.branches ?? [];
  const [branchId, setBranchId] = useState<string>(scoped !== 'all' ? scoped : mine.length === 1 ? mine[0].id : '');
  return { branchId, setBranchId, branches: mine, fixed: scoped !== 'all' || mine.length === 1 };
}

function Register() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const { branchId, setBranchId, branches, fixed } = useBranchPick();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [cart, setCart] = useState<Line[]>([]);
  const [mode, setMode] = useState<'member' | 'walkin'>('walkin');
  const [member, setMember] = useState<MemberPick | null>(null);
  const [walkName, setWalkName] = useState('');
  const [walkPhone, setWalkPhone] = useState('');
  const [points, setPoints] = useState<number | ''>('');
  const [tenders, setTenders] = useState<Tender[]>([{ method: 'upi', amount: '', reference: '' }]);
  const [cashGiven, setCashGiven] = useState<number | ''>('');
  const [onAccount, setOnAccount] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<any>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const term = useDebounced(q.trim(), 150);

  const { data: catalog } = useQuery({
    queryKey: ['pos-catalog', branchId],
    queryFn: () => api.get<Product[]>('/pos/catalog', { branchId }),
    enabled: !!branchId,
  });
  const { data: loyalty } = useQuery({ queryKey: ['loyalty-member', member?.id], queryFn: () => api.get<any>(`/loyalty/members/${member!.id}`), enabled: !!member });

  const shown = useMemo(() => {
    const t = term.toLowerCase();
    return (catalog ?? []).filter((p) => (!cat || p.category === cat) && (!t || p.name.toLowerCase().includes(t) || p.sku.toLowerCase().includes(t) || p.barcode === term || (p.brand ?? '').toLowerCase().includes(t)));
  }, [catalog, term, cat]);

  const inCart = (id: string) => cart.find((l) => l.product.id === id)?.quantity ?? 0;
  const add = (p: Product) => {
    if (p.track_stock && inCart(p.id) >= p.stock) { toast('error', `Only ${p.stock} × ${p.name} in stock`); return; }
    setCart((c) => (c.some((l) => l.product.id === p.id) ? c.map((l) => (l.product.id === p.id ? { ...l, quantity: l.quantity + 1 } : l)) : [...c, { product: p, quantity: 1, discount: 0 }]));
  };
  const setQty = (id: string, n: number) => setCart((c) => c.flatMap((l) => (l.product.id !== id ? [l] : n <= 0 ? [] : [{ ...l, quantity: l.product.track_stock ? Math.min(n, l.product.stock) : n }])));
  // A barcode scanner types the code and presses Enter.
  const onScan = () => {
    const code = q.trim();
    const hit = catalog?.find((p) => p.barcode === code || p.sku.toLowerCase() === code.toLowerCase()) ?? (shown.length === 1 ? shown[0] : null);
    if (hit) { add(hit); setQ(''); }
  };

  const subtotal = r2(cart.reduce((s, l) => s + lineTotal(l), 0));
  const settings = loyalty?.settings;
  const maxPoints = settings && member ? Math.min(loyalty.balance, Math.floor((subtotal * settings.maxRedeemPct) / 100 / settings.pointValue)) : 0;
  const pts = mode === 'member' && points ? Number(points) : 0;
  const pointsOff = settings ? r2(pts * settings.pointValue) : 0;
  const total = r2(Math.max(0, subtotal - pointsOff));
  const tendered = r2(tenders.reduce((s, t) => s + (t.amount === '' ? 0 : Number(t.amount)), 0));
  // With one tender and no amount typed, it covers the whole bill.
  const effective = tenders.length === 1 && tenders[0].amount === '' && !onAccount ? [{ ...tenders[0], amount: total }] : tenders;
  const paying = r2(effective.reduce((s, t) => s + (t.amount === '' ? 0 : Number(t.amount)), 0));
  const due = r2(total - paying);
  const cashTender = effective.find((t) => t.method === 'cash');
  const change = cashTender && cashGiven !== '' ? r2(Number(cashGiven) - Number(cashTender.amount || 0)) : null;

  const sale = useMutation({
    mutationFn: () => api.post<any>('/pos/sales', {
      branchId,
      memberId: mode === 'member' ? member?.id : null,
      customer: mode === 'walkin' ? { name: walkName.trim(), phone: walkPhone.trim() || null } : null,
      items: cart.map((l) => ({ productId: l.product.id, quantity: l.quantity, discount: l.discount })),
      redeemPoints: pts,
      payments: total === 0 ? [] : effective.filter((t) => Number(t.amount) > 0).map((t) => ({ method: t.method, amount: Number(t.amount), reference: t.reference || null })),
      onAccount,
    }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['pos-catalog'] });
      qc.invalidateQueries({ queryKey: ['pos-summary'] });
      qc.invalidateQueries({ queryKey: ['pos-sales'] });
      setDone({ ...r, change });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Sale failed'),
  });
  const reset = () => {
    setCart([]); setMember(null); setWalkName(''); setWalkPhone(''); setPoints(''); setTenders([{ method: 'upi', amount: '', reference: '' }]);
    setCashGiven(''); setOnAccount(false); setError(''); setDone(null); setMode('walkin');
    setTimeout(() => searchRef.current?.focus(), 50);
  };
  const missingRef = effective.some((t) => referenceRequired(t.method) && Number(t.amount) > 0 && !t.reference.trim());
  const customerOk = mode === 'member' ? !!member : walkName.trim().length >= 2;
  const canCharge = cart.length > 0 && customerOk && !missingRef && (onAccount ? due >= 0 : Math.abs(due) < 0.01) && !!branchId;

  if (!branchId) {
    return (
      <Card><div className="stack" style={{ maxWidth: 360 }}>
        <b>Which branch are you selling from?</b>
        <div className="chips">{branches.map((b: any) => <button key={b.id} className="chip" onClick={() => setBranchId(b.id)}>{b.name}</button>)}</div>
      </div></Card>
    );
  }

  return (
    <div className="pos">
      <section className="card pos-catalog">
        <div className="toolbar">
          <div className="search-box" style={{ flex: 1, width: 'auto' }}>
            <Search />
            <input ref={searchRef} autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onScan()}
              placeholder="Scan a barcode or search products" aria-label="Search products" />
          </div>
          {!fixed && <select className="select" style={{ width: 170 }} value={branchId} onChange={(e) => { setBranchId(e.target.value); setCart([]); }} aria-label="Branch">{branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>}
        </div>
        <div className="chips" style={{ padding: '10px 20px 0' }}>
          <button className={`chip ${!cat ? 'on' : ''}`} onClick={() => setCat('')}>All</button>
          {Object.entries(CATEGORY_LABEL).map(([k, l]) => <button key={k} className={`chip ${cat === k ? 'on' : ''}`} onClick={() => setCat(k)}>{l}</button>)}
        </div>
        <div className="product-grid">
          {!catalog ? Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} h={104} />) : !shown.length ? <Empty title="No products match" /> : shown.map((p) => {
            const left = p.track_stock ? p.stock - inCart(p.id) : null;
            return (
              <button key={p.id} className={`product-tile ${left === 0 ? 'out' : ''}`} onClick={() => add(p)} disabled={left === 0}>
                <span className="cat">{CATEGORY_LABEL[p.category]}</span>
                <span className="nm">{p.name}</span>
                <span className="row between" style={{ width: '100%', marginTop: 'auto' }}>
                  <b className="num">{money(p.selling_price)}</b>
                  {left === null ? <span className="faint" style={{ fontSize: 11 }}>service</span>
                    : <span className={`stock ${left === 0 ? 'zero' : left <= p.low_stock_threshold ? 'low' : ''}`}>{left === 0 ? 'Out' : `${left} left`}</span>}
                </span>
                {inCart(p.id) > 0 && <span className="in-cart num">{inCart(p.id)}</span>}
              </button>
            );
          })}
        </div>
      </section>

      <section className="card pos-cart">
        <div className="pos-cart-head">
          <div className="cust-toggle" role="tablist" aria-label="Customer type">
            <button role="tab" aria-selected={mode === 'walkin'} className={mode === 'walkin' ? 'on' : ''} onClick={() => { setMode('walkin'); setPoints(''); setOnAccount(false); }}><UserPlus />Walk-in</button>
            <button role="tab" aria-selected={mode === 'member'} className={mode === 'member' ? 'on' : ''} onClick={() => setMode('member')}><User />Member</button>
          </div>
          {mode === 'member' ? <MemberPicker value={member} onChange={(m) => { setMember(m); setPoints(''); }} /> : (
            <div className="row" style={{ gap: 6 }}>
              <input className="input" placeholder="Customer name" value={walkName} onChange={(e) => setWalkName(e.target.value)} aria-label="Customer name" />
              <input className="input" placeholder="Phone (optional)" value={walkPhone} onChange={(e) => setWalkPhone(e.target.value)} style={{ width: 150 }} aria-label="Customer phone" />
            </div>
          )}
          {member && loyalty && (
            <div className="row between faint" style={{ fontSize: 12.5 }}>
              <span><Gift size={13} style={{ verticalAlign: -2 }} /> <b style={{ color: 'var(--text)' }}>{loyalty.balance.toLocaleString('en-IN')}</b> points · worth {money(loyalty.value)}</span>
              <Link to={`/members/${member.id}`} className="faint">Profile</Link>
            </div>
          )}
        </div>

        <div className="pos-lines">
          {!cart.length ? <Empty icon={<ShoppingBag />} title="Cart is empty">Tap a product or scan its barcode.</Empty> : cart.map((l) => (
            <div key={l.product.id} className="cart-line">
              <div style={{ minWidth: 0 }}>
                <div className="nm">{l.product.name}</div>
                <div className="faint" style={{ fontSize: 12 }}>{money(l.product.selling_price)} · GST {l.product.tax_rate}%{l.discount ? ` · −${money(l.discount)}` : ''}</div>
              </div>
              <div className="stepper">
                <button type="button" aria-label={`One fewer ${l.product.name}`} onClick={() => setQty(l.product.id, l.quantity - 1)}>{l.quantity === 1 ? <Trash2 size={13} /> : <Minus size={13} />}</button>
                <span className="num">{l.quantity}</span>
                <button type="button" aria-label={`One more ${l.product.name}`} onClick={() => add(l.product)}><Plus size={13} /></button>
              </div>
              <b className="num" style={{ minWidth: 72, textAlign: 'right' }}>{money(lineTotal(l), true)}</b>
            </div>
          ))}
        </div>

        {cart.length > 0 && (
          <div className="pos-pay">
            {member && settings?.enabled && loyalty.balance >= settings.minRedeem && (
              <div className="row between">
                <span className="muted" style={{ fontSize: 13 }}>Redeem points <span className="faint">(max {maxPoints.toLocaleString('en-IN')})</span></span>
                <div className="row" style={{ gap: 6 }}>
                  <input className="input num" type="number" min={0} max={maxPoints} step={50} style={{ width: 96, height: 32 }} value={points}
                    onChange={(e) => setPoints(e.target.value === '' ? '' : Math.max(0, Math.min(maxPoints, Number(e.target.value))))} aria-label="Points to redeem" />
                  <Button size="sm" variant="ghost" onClick={() => setPoints(maxPoints >= settings.minRedeem ? Math.floor(maxPoints / 50) * 50 : '')}>Max</Button>
                </div>
              </div>
            )}
            <div className="summary-box">
              <div className="line"><span>Items incl. GST</span><span>{money(subtotal, true)}</span></div>
              {pointsOff > 0 && <div className="line"><span>Points ({pts})</span><span>− {money(pointsOff, true)}</span></div>}
              <div className="line total"><span>Total</span><span>{money(total, true)}</span></div>
            </div>
            {total > 0 && (
              <div className="stack" style={{ gap: 8 }}>
                {tenders.map((t, i) => (
                  <div key={i} className="tender">
                    <MethodPicker value={t.method} onChange={(m) => setTenders(tenders.map((x, j) => (j === i ? { ...x, method: m } : x)))} />
                    <div className="row" style={{ gap: 6 }}>
                      <input className="input num" type="number" min={0} step="0.01" placeholder={tenders.length === 1 && !onAccount ? total.toFixed(2) : 'Amount'} value={t.amount}
                        onChange={(e) => setTenders(tenders.map((x, j) => (j === i ? { ...x, amount: e.target.value === '' ? '' : Number(e.target.value) } : x)))} aria-label="Amount" />
                      {t.method !== 'cash' && <input className="input" placeholder={referenceLabel(t.method)} value={t.reference}
                        onChange={(e) => setTenders(tenders.map((x, j) => (j === i ? { ...x, reference: e.target.value } : x)))} aria-label={referenceLabel(t.method)} />}
                      {tenders.length > 1 && <button className="icon-btn" style={{ width: 34, height: 34, flexShrink: 0 }} aria-label="Remove payment" onClick={() => setTenders(tenders.filter((_, j) => j !== i))}><X /></button>}
                    </div>
                  </div>
                ))}
                <div className="row between wrap">
                  {tenders.length < 3 && <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setTenders([...tenders.map((t) => (t.amount === '' ? { ...t, amount: r2(total - tendered) } : t)), { method: 'cash', amount: '', reference: '' }])}>Split payment</Button>}
                  {mode === 'member' && member && can('payments.create') && <label className="check" style={{ fontSize: 13 }}><input type="checkbox" checked={onAccount} onChange={(e) => setOnAccount(e.target.checked)} />Leave balance on account</label>}
                </div>
                {cashTender && (
                  <div className="row between">
                    <span className="muted" style={{ fontSize: 13 }}><Banknote size={14} style={{ verticalAlign: -2 }} /> Cash received</span>
                    <div className="row" style={{ gap: 10 }}>
                      <input className="input num" type="number" style={{ width: 110, height: 32 }} value={cashGiven} onChange={(e) => setCashGiven(e.target.value === '' ? '' : Number(e.target.value))} aria-label="Cash received" />
                      {change !== null && <b className="num" style={{ color: change < 0 ? 'var(--danger)' : 'var(--success)' }}>{change < 0 ? `${money(-change, true)} short` : `Change ${money(change, true)}`}</b>}
                    </div>
                  </div>
                )}
                {Math.abs(due) >= 0.01 && <div className="faint" style={{ fontSize: 12.5, color: due < 0 ? 'var(--danger)' : onAccount ? 'var(--warning)' : undefined }}>
                  {due < 0 ? `Payments exceed the total by ${money(-due, true)}` : onAccount ? `${money(due, true)} goes on ${member?.full_name}'s account` : `${money(due, true)} still to allocate`}
                </div>}
              </div>
            )}
            {error && <Alert>{error}</Alert>}
            <Button variant="primary" className="charge" disabled={!canCharge} loading={sale.isPending} onClick={() => { setError(''); sale.mutate(); }}>
              {total === 0 ? 'Complete with points' : `Charge ${money(onAccount ? paying : total, true)}`}
            </Button>
            <button className="btn ghost sm" style={{ alignSelf: 'center' }} onClick={reset}>Clear sale</button>
          </div>
        )}
      </section>

      {done && (
        <Dialog open onClose={reset} title="Sale complete" sub={done.invoice.invoice_number}
          footer={<><Button icon={<Printer />} onClick={() => openPdf(`/invoices/${done.invoice.id}/pdf`)}>Print receipt</Button><Button variant="primary" onClick={reset}>New sale</Button></>}>
          <div className="summary-box">
            <div className="line"><span>Total</span><b>{money(done.invoice.total, true)}</b></div>
            {done.invoice.points_redeemed > 0 && <div className="line"><span>Points redeemed</span><b>{done.invoice.points_redeemed} (−{money(done.invoice.points_discount, true)})</b></div>}
            {done.payments.map((p: any) => <div key={p.id} className="line"><span>{METHOD_LABEL[p.method]} · {p.receipt_number}</span><b>{money(p.amount, true)}</b></div>)}
            {done.invoice.total > done.invoice.amount_paid && <div className="line"><span>On account</span><b style={{ color: 'var(--warning)' }}>{money(done.invoice.total - done.invoice.amount_paid, true)}</b></div>}
            {done.change > 0 && <div className="line total"><span>Change to give</span><span>{money(done.change, true)}</span></div>}
          </div>
        </Dialog>
      )}
    </div>
  );
}

function Today() {
  const { can } = useAuth();
  const [day, setDay] = useState(today());
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [refund, setRefund] = useState<any>(null);
  const term = useDebounced(q.trim());
  const { data: sum } = useQuery({ queryKey: ['pos-summary', day], queryFn: () => api.get<any>('/pos/summary', { date: day }) });
  const { data } = useQuery({ queryKey: ['pos-sales', day, page, term], queryFn: () => api.get<Paged<any>>('/pos/sales', { date: term ? undefined : day, search: term || undefined, page, pageSize: 20 }) });
  const takings = (sum?.methods ?? []).reduce((s: number, m: any) => s + Number(m.amount), 0);
  const refunds = (sum?.refunds ?? []).reduce((s: number, m: any) => s + Number(m.amount), 0);
  return (
    <div className="stack">
      <div className="row between wrap">
        <input type="date" className="input" style={{ width: 170 }} value={day} max={today()} onChange={(e) => { setDay(e.target.value); setPage(1); }} aria-label="Day" />
      </div>
      <div className="grid g-4">
        <section className="card kpi hero"><div className="label"><ShoppingBag />Sales</div><div className="value">{money(sum?.total ?? 0)}</div><div className="compare">{sum?.sales ?? 0} bills · {sum?.units ?? 0} items</div></section>
        <section className="card kpi"><div className="label"><Banknote />Collected</div><div className="value">{money(takings)}</div>
          <div className="compare">{(sum?.methods ?? []).map((m: any) => `${METHOD_LABEL[m.method]} ${money(m.amount)}`).join(' · ') || '—'}</div></section>
        <section className="card kpi"><div className="label"><RotateCcw />Refunds</div><div className="value" style={{ color: refunds ? 'var(--danger)' : undefined }}>{money(refunds)}</div><div className="compare">Net till {money(takings - refunds)}</div></section>
        <section className="card kpi"><div className="label"><Gift />Points redeemed</div><div className="value">{money(sum?.points_discount ?? 0)}</div><div className="compare">{sum?.on_account ? `${money(sum.on_account)} on account` : 'nothing on account'}</div></section>
      </div>
      {!!sum?.methods?.find((m: any) => m.method === 'cash') && (
        <Alert tone="info">Cash in drawer from POS today should be <b>{money(Number(sum.methods.find((m: any) => m.method === 'cash').amount) - Number(sum.refunds.find((r: any) => r.method === 'cash')?.amount ?? 0), true)}</b> (cash sales minus cash refunds).</Alert>
      )}
      <section className="card">
        <div className="toolbar">
          <div className="search-box"><Search /><input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search any day: customer, bill no. or phone" /></div>
        </div>
        <div className="table-wrap">
          {!data ? <div style={{ padding: 20 }}><Skeleton h={240} /></div> : !data.data.length ? <Empty title="No sales" /> : (
            <table className="tbl">
              <thead><tr><th>Bill</th><th>Customer</th><th>Items</th><th className="r">Total</th><th>Paid by</th><th className="hide-sm">Sold by</th><th /></tr></thead>
              <tbody>{data.data.map((s) => (
                <tr key={s.id} className={s.status === 'refunded' ? 'void' : ''}>
                  <td><Link to={`/invoices/${s.id}`} style={{ fontWeight: 700 }}>{s.invoice_number}</Link><div className="faint" style={{ fontSize: 12 }}>{dateTime(s.created_at)}</div></td>
                  <td>{s.walk_in ? <Person name={s.customer_name} detail="Walk-in" size="sm" /> : <Link to={`/members/${s.member_id}`}><Person name={s.customer_name} detail={s.member_code} size="sm" /></Link>}</td>
                  <td className="muted" style={{ maxWidth: 320 }}>{s.items.map((i: any) => `${i.quantity}× ${i.description}${i.returned_qty ? ` (${i.returned_qty} returned)` : ''}`).join(', ')}</td>
                  <td className="r amount">{money(s.total, true)}{s.amount_refunded > 0 && <div style={{ fontSize: 12, color: 'var(--danger)', fontWeight: 600 }}>−{money(s.amount_refunded, true)}</div>}</td>
                  <td>{s.methods ? s.methods.split(',').map((m: string) => <Method key={m} method={m} />) : <span className="badge warning">On account</span>}</td>
                  <td className="muted hide-sm">{s.sold_by_name}</td>
                  <td>{can('pos.refund') && s.status !== 'refunded' && s.amount_paid > s.amount_refunded && <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => setRefund(s)}>Return</Button>}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
        {data && <Pagination page={data.pagination.page} totalPages={data.pagination.totalPages} total={data.pagination.total} onPage={setPage} />}
      </section>
      {sum?.top?.length > 0 && (
        <Card title="Best sellers" icon={<Package />} sub={day === today() ? 'Today' : day}>
          <div className="stack" style={{ gap: 6 }}>{sum.top.map((t: any) => <div key={t.name} className="row between"><span>{t.name}</span><span className="faint num">{t.units} sold · <b style={{ color: 'var(--text)' }}>{money(t.revenue)}</b></span></div>)}</div>
        </Card>
      )}
      {refund && <RefundDialog sale={refund} onClose={() => setRefund(null)} />}
    </div>
  );
}

export function PosPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as 'register' | 'sales') ?? 'register';
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Point of sale</h1><div className="sub">Supplements, merchandise, drinks and services. Stock, revenue and the member’s history update as you sell.</div></div>
        <div className="actions"><Link className="btn" to="/inventory"><Receipt />Inventory</Link></div>
      </div>
      <Tabs value={tab} onChange={(t) => setParams(t === 'register' ? {} : { tab: t })} tabs={[{ key: 'register', label: 'Register' }, { key: 'sales', label: 'Sales & till' }]} />
      {tab === 'register' ? <Register /> : <Today />}
    </div>
  );
}
