import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, CreditCard, FileDown, Plus, Printer, Receipt, RotateCcw, Search } from 'lucide-react';
import { api, ApiError, openPdf, type Paged } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced, useToast } from '../../lib/ui';
import { date, dateTime, METHOD_LABEL, money, SERVICE_LABEL } from '../../lib/format';
import { Alert, Button, Dialog, Empty, Field, Method, Pagination, Person, Skeleton, StatusBadge } from '../../components/ui';
import { useActions } from '../actions';
import { MemberPicker, MethodPicker, type MemberPick } from '../shared';
import { RefundDialog } from '../business/common';

function useListParams() {
  const [params, setParams] = useSearchParams();
  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };
  return [params, update] as const;
}

// --------------------------------------------------------------- payments --

function VoidDialog({ payment, onClose }: { payment: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/payments/${payment.id}/void`, { reason }),
    onSuccess: () => { qc.invalidateQueries(); toast('success', `${payment.receipt_number} voided`); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Failed'),
  });
  return (
    <Dialog open onClose={onClose} title={`Void ${payment.receipt_number}?`} sub={`${money(payment.amount)} from ${payment.member_name}`}
      footer={<><Button onClick={onClose}>Keep payment</Button><Button variant="danger" loading={m.isPending} onClick={() => m.mutate()}>Void payment</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <Alert tone="warning">The invoice balance goes back up. If nothing remains paid, the membership on it returns to “payment pending”.</Alert>
        <Field label="Reason" hint="Required — recorded in the audit log"><input className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Entered twice by mistake" /></Field>
      </div>
    </Dialog>
  );
}

export function PaymentsPage() {
  const [params, update] = useListParams();
  const navigate = useNavigate();
  const actions = useActions();
  const { can } = useAuth();
  const [search, setSearch] = useState(params.get('search') ?? '');
  const [voiding, setVoiding] = useState<any>(null);
  const term = useDebounced(search.trim());
  const q = { search: term, method: params.get('method') ?? '', from: params.get('from') ?? '', to: params.get('to') ?? '', page: Number(params.get('page') ?? 1), pageSize: 25 };
  const { data } = useQuery({ queryKey: ['payments', q], queryFn: () => api.get<Paged<any> & { summary: { totalAmount: number } }>('/payments', q), placeholderData: keepPreviousData });
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Payments</h1><div className="sub">Every rupee collected at the desk — cash, UPI, card and bank transfer.</div></div>
        <div className="actions">{can('payments.create') && <Button variant="primary" icon={<CreditCard />} onClick={() => actions.recordPayment()}>Record payment</Button>}</div>
      </div>
      <section className="card">
        <div className="toolbar">
          <div className="search-box"><Search /><input value={search} onChange={(e) => { setSearch(e.target.value); update({ search: e.target.value || null }); }} placeholder="Member, receipt, invoice or UPI ref" /></div>
          <div className="chips">
            <button className={`chip ${!q.method ? 'on' : ''}`} onClick={() => update({ method: null })}>All methods</button>
            {Object.entries(METHOD_LABEL).map(([k, v]) => <button key={k} className={`chip ${q.method === k ? 'on' : ''}`} onClick={() => update({ method: k })}>{v}</button>)}
          </div>
          <div style={{ flex: 1 }} />
          <input className="input" type="date" style={{ width: 150 }} value={q.from} onChange={(e) => update({ from: e.target.value || null })} aria-label="From" />
          <span className="faint">–</span>
          <input className="input" type="date" style={{ width: 150 }} value={q.to} onChange={(e) => update({ to: e.target.value || null })} aria-label="To" />
        </div>
        {data && <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--border)' }} className="muted">Total collected in view: <b className="num" style={{ color: 'var(--text)' }}>{money(data.summary.totalAmount, true)}</b></div>}
        <div className="table-wrap">
          {!data ? <div style={{ padding: 20 }}><Skeleton h={400} /></div> : !data.data.length ? <Empty icon={<CreditCard size={20} />} title="No payments match" /> : (
            <table className="tbl">
              <thead><tr><th>Receipt</th><th>Member</th><th className="hide-sm">Invoice</th><th>Service</th><th className="r">Amount</th><th>Method</th><th className="hide-sm">Reference</th><th className="hide-sm">Collected by</th><th>Date</th><th>Status</th>{can('payments.void') && <th />}</tr></thead>
              <tbody>{data.data.map((p) => (
                <tr key={p.id} className={`clickable ${p.status === 'voided' ? 'void' : ''}`} onClick={() => navigate(`/invoices/${p.invoice_id}`)}>
                  <td style={{ fontWeight: 700 }}>{p.receipt_number}</td>
                  <td><Person name={p.member_name} detail={p.member_code ?? 'Walk-in'} size="sm" /></td>
                  <td className="muted hide-sm">{p.invoice_number}</td>
                  <td className="muted">{(p.services ?? '').split(',').map((s: string) => SERVICE_LABEL[s] ?? s).join(', ')}</td>
                  <td className="r amount">{money(p.amount, true)}</td>
                  <td><Method method={p.method} /></td>
                  <td className="muted num hide-sm">{p.reference ?? '—'}</td>
                  <td className="muted hide-sm">{p.collected_by_name}</td>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{dateTime(p.paid_at)}</td>
                  <td><StatusBadge status={p.status} /></td>
                  {can('payments.void') && <td onClick={(e) => e.stopPropagation()}>{p.status === 'recorded' && <Button size="sm" variant="ghost" icon={<Ban />} onClick={() => setVoiding(p)} aria-label="Void" title="Void payment" />}</td>}
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
        {data && data.pagination.total > 0 && <Pagination {...data.pagination} onPage={(p) => update({ page: String(p) })} />}
      </section>
      {voiding && <VoidDialog payment={voiding} onClose={() => setVoiding(null)} />}
    </div>
  );
}

// --------------------------------------------------------------- invoices --

function ChargeDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [member, setMember] = useState<MemberPick | null>(null);
  const [item, setItem] = useState({ itemType: 'pt', description: '', quantity: 1, unitPrice: 0, discount: 0, taxRate: 18 });
  const [collect, setCollect] = useState(true);
  const [method, setMethod] = useState('upi');
  const [reference, setReference] = useState('');
  const [error, setError] = useState('');
  const total = Math.round((item.unitPrice * item.quantity - item.discount) * (1 + item.taxRate / 100) * 100) / 100;
  const m = useMutation({
    mutationFn: () => api.post<any>('/invoices', { memberId: member!.id, items: [item], payment: collect ? { amount: total, method, reference: reference || null } : null }),
    onSuccess: (r) => { qc.invalidateQueries(); toast('success', `Invoice ${r.invoice.invoice_number} created`); onClose(); navigate(`/invoices/${r.invoice.id}`); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Failed'),
  });
  return (
    <Dialog open onClose={onClose} title="New charge" sub="Bill a PT pack, class pack, merchandise or other service."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!member || !item.description || total <= 0} loading={m.isPending} onClick={() => m.mutate()}>Create invoice</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <Field label="Member"><MemberPicker value={member} onChange={setMember} /></Field>
        <div className="form-grid">
          <Field label="Type"><select className="select" value={item.itemType} onChange={(e) => setItem({ ...item, itemType: e.target.value })}>
            {['pt', 'class', 'product', 'event', 'other'].map((t) => <option key={t} value={t}>{SERVICE_LABEL[t]}</option>)}
          </select></Field>
          <Field label="Description"><input className="input" value={item.description} onChange={(e) => setItem({ ...item, description: e.target.value })} placeholder="e.g. PT pack · 12 sessions" /></Field>
          <Field label="Unit price"><div className="input-prefix"><span>₹</span><input className="input num" type="number" value={item.unitPrice} onChange={(e) => setItem({ ...item, unitPrice: Number(e.target.value) })} /></div></Field>
          <Field label="Quantity"><input className="input num" type="number" min={1} value={item.quantity} onChange={(e) => setItem({ ...item, quantity: Number(e.target.value) })} /></Field>
          <Field label="Discount"><div className="input-prefix"><span>₹</span><input className="input num" type="number" value={item.discount} onChange={(e) => setItem({ ...item, discount: Number(e.target.value) })} /></div></Field>
          <Field label="GST %"><input className="input num" type="number" value={item.taxRate} onChange={(e) => setItem({ ...item, taxRate: Number(e.target.value) })} /></Field>
        </div>
        <div className="summary-box"><div className="line total"><span>Total</span><span>{money(total, true)}</span></div></div>
        <label className="check"><input type="checkbox" checked={collect} onChange={(e) => setCollect(e.target.checked)} />Collect full payment now</label>
        {collect && <><MethodPicker value={method} onChange={setMethod} /><Field label="Reference"><input className="input" value={reference} onChange={(e) => setReference(e.target.value)} /></Field></>}
      </div>
    </Dialog>
  );
}

export function InvoicesPage() {
  const [params, update] = useListParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [search, setSearch] = useState(params.get('search') ?? '');
  const [charge, setCharge] = useState(false);
  const term = useDebounced(search.trim());
  const q = { search: term, status: params.get('status') ?? '', page: Number(params.get('page') ?? 1), pageSize: 25 };
  const { data } = useQuery({ queryKey: ['invoices', q], queryFn: () => api.get<Paged<any>>('/invoices', q), placeholderData: keepPreviousData });
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Invoices</h1><div className="sub">GST invoices for memberships and services. Print or download any invoice as PDF.</div></div>
        <div className="actions">{can('payments.create') && <Button variant="primary" icon={<Plus />} onClick={() => setCharge(true)}>New charge</Button>}</div>
      </div>
      <section className="card">
        <div className="toolbar">
          <div className="search-box"><Search /><input value={search} onChange={(e) => { setSearch(e.target.value); update({ search: e.target.value || null }); }} placeholder="Invoice number, member or ID" /></div>
          <div className="chips">
            {[['', 'All'], ['outstanding', 'Outstanding'], ['paid', 'Paid'], ['partially_paid', 'Partially paid'], ['pending', 'Pending'], ['void', 'Void']].map(([k, l]) => (
              <button key={k} className={`chip ${q.status === k ? 'on' : ''}`} onClick={() => update({ status: k || null })}>{l}</button>
            ))}
          </div>
        </div>
        <div className="table-wrap">
          {!data ? <div style={{ padding: 20 }}><Skeleton h={400} /></div> : !data.data.length ? <Empty icon={<Receipt size={20} />} title="No invoices match" /> : (
            <table className="tbl">
              <thead><tr><th>Invoice</th><th>Member</th><th>Description</th><th>Issued</th><th className="r">Total</th><th className="r">Paid</th><th className="r">Balance</th><th>Status</th><th /></tr></thead>
              <tbody>{data.data.map((i) => (
                <tr key={i.id} className="clickable" onClick={() => navigate(`/invoices/${i.id}`)}>
                  <td style={{ fontWeight: 700 }}>{i.invoice_number}</td>
                  <td><Person name={i.member_name} detail={i.member_code ?? 'Walk-in'} size="sm" /></td>
                  <td className="muted" style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.description}</td>
                  <td className="muted">{date(i.issue_date)}</td>
                  <td className="r amount">{money(i.total, true)}</td>
                  <td className="r num muted">{money(i.amount_paid, true)}</td>
                  <td className="r amount" style={{ color: i.balance > 0 && i.status !== 'void' ? 'var(--warning)' : 'var(--text-3)' }}>{i.balance > 0 && i.status !== 'void' ? money(i.balance, true) : '—'}</td>
                  <td><StatusBadge status={i.status} label={i.status === 'pending' ? 'Unpaid' : undefined} /></td>
                  <td onClick={(e) => e.stopPropagation()}><Button size="sm" variant="ghost" icon={<FileDown />} onClick={() => openPdf(`/invoices/${i.id}/pdf`)} aria-label="Download PDF" /></td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
        {data && data.pagination.total > 0 && <Pagination {...data.pagination} onPage={(p) => update({ page: String(p) })} />}
      </section>
      {charge && <ChargeDialog onClose={() => setCharge(false)} />}
    </div>
  );
}

export function InvoiceDetail() {
  const { id } = useParams();
  const actions = useActions();
  const { can } = useAuth();
  const [refunding, setRefunding] = useState(false);
  const { data, error } = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<any>(`/invoices/${id}`) });
  if (error) return <div className="page"><Empty title="Invoice not found" /></div>;
  if (!data) return <div className="page"><Skeleton h={500} /></div>;
  const { invoice: inv, items, payments, org, branch, member, refunds = [] } = data;
  const balance = inv.total - inv.amount_paid;
  const returnable = can('pos.refund') && inv.amount_paid > inv.amount_refunded && items.some((i: any) => i.product_id && i.quantity > i.returned_qty);
  return (
    <div className="page" style={{ maxWidth: 920 }}>
      <div className="row between no-print">
        <Link to="/invoices" className="btn ghost sm"><ArrowLeft />Invoices</Link>
        <div className="row">
          {balance > 0 && can('payments.create') && ['pending', 'partially_paid'].includes(inv.status) && (
            member.id
              ? <Button variant="primary" icon={<CreditCard />} onClick={() => actions.recordPayment({ memberId: member.id, memberName: member.full_name, invoiceId: inv.id })}>Collect {money(balance)}</Button>
              : null
          )}
          {returnable && <Button icon={<RotateCcw />} onClick={() => setRefunding(true)}>Return items</Button>}
          <Button icon={<Printer />} onClick={() => window.print()}>Print</Button>
          <Button icon={<FileDown />} onClick={() => openPdf(`/invoices/${inv.id}/pdf`)}>PDF</Button>
        </div>
      </div>
      <div className="invoice-paper">
        <div className="bar" />
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{org.name}</div>
            <div className="muted" style={{ marginTop: 4 }}>{branch.name} · {branch.address}</div>
            {org.gstin && <div className="muted">GSTIN {org.gstin}</div>}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontWeight: 800, letterSpacing: '0.12em', color: '#A67D4C', fontSize: 12 }}>TAX INVOICE</div>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{inv.invoice_number}</div>
            <div className="muted">Issued {date(inv.issue_date)}</div>
          </div>
        </div>
        <div className="row between" style={{ marginTop: 28, alignItems: 'flex-start' }}>
          <div>
            <div className="muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em' }}>BILLED TO</div>
            {member.id ? <Link to={`/members/${member.id}`} style={{ fontWeight: 800, fontSize: 15 }}>{member.full_name}</Link> : <div style={{ fontWeight: 800, fontSize: 15 }}>{member.full_name}</div>}
            <div className="muted">{[member.member_code ?? 'Walk-in customer', member.phone, member.email].filter(Boolean).join(' · ')}</div>
          </div>
          <StatusBadge status={inv.status} label={inv.status === 'pending' ? 'Unpaid' : undefined} />
        </div>
        <table>
          <thead><tr><th>DESCRIPTION</th><th className="r">QTY</th><th className="r">PRICE</th><th className="r">DISCOUNT</th><th className="r">GST</th><th className="r">AMOUNT</th></tr></thead>
          <tbody>{items.map((it: any) => (
            <tr key={it.id}><td>{it.description}{it.returned_qty > 0 && <span className="faint"> · {it.returned_qty} returned</span>}</td><td className="r">{it.quantity}</td><td className="r">{money(it.unit_price, true)}</td><td className="r">{it.discount ? money(it.discount, true) : '—'}</td><td className="r">{money(it.tax, true)}</td><td className="r" style={{ fontWeight: 700 }}>{money(it.amount, true)}</td></tr>
          ))}</tbody>
        </table>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <div style={{ width: 280, display: 'grid', gap: 6 }}>
            <div className="row between"><span className="muted">Subtotal</span><span>{money(inv.subtotal, true)}</span></div>
            {!!inv.discount && <div className="row between"><span className="muted">Discount</span><span>− {money(inv.discount, true)}</span></div>}
            <div className="row between"><span className="muted">GST</span><span>{money(inv.tax, true)}</span></div>
            {inv.points_discount > 0 && <div className="row between"><span className="muted">Loyalty ({inv.points_redeemed} pts)</span><span>− {money(inv.points_discount, true)}</span></div>}
            <div className="row between" style={{ fontWeight: 800, fontSize: 16, borderTop: '1px solid #E6DED6', paddingTop: 8 }}><span>Total</span><span>{money(inv.total, true)}</span></div>
            <div className="row between"><span className="muted">Paid</span><span>{money(inv.amount_paid, true)}</span></div>
            {inv.amount_refunded > 0 && <div className="row between"><span className="muted">Refunded</span><span>− {money(inv.amount_refunded, true)}</span></div>}
            <div className="row between" style={{ fontWeight: 800 }}><span>Balance due</span><span>{money(balance, true)}</span></div>
          </div>
        </div>
        {payments.length > 0 && (
          <>
            <div className="muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', marginTop: 28 }}>PAYMENTS</div>
            <table style={{ marginTop: 6 }}><tbody>{payments.map((p: any) => (
              <tr key={p.id} style={{ opacity: p.status === 'voided' ? 0.5 : 1 }}>
                <td>{p.receipt_number}{p.status === 'voided' && ' (voided)'}</td><td className="muted">{dateTime(p.paid_at)}</td><td>{METHOD_LABEL[p.method]}{p.reference ? ` · ${p.reference}` : ''}</td>
                <td className="muted">by {p.collected_by_name}</td><td className="r" style={{ fontWeight: 700 }}>{money(p.amount, true)}</td>
              </tr>
            ))}</tbody></table>
          </>
        )}
        {refunds.length > 0 && (
          <>
            <div className="muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', marginTop: 28 }}>REFUNDS</div>
            <table style={{ marginTop: 6 }}><tbody>{refunds.map((r: any) => (
              <tr key={r.id}><td>{r.refund_number}</td><td className="muted">{dateTime(r.created_at)}</td><td>{METHOD_LABEL[r.method]} · {r.reason}{r.restocked ? ' · restocked' : ''}</td>
                <td className="muted">by {r.refunded_by_name}</td><td className="r" style={{ fontWeight: 700 }}>− {money(r.amount, true)}</td></tr>
            ))}</tbody></table>
          </>
        )}
        <div className="muted" style={{ marginTop: 32, fontSize: 11.5, textAlign: 'center' }}>Payments are collected at the gym. This is a computer-generated invoice.</div>
      </div>
      {payments.some((p: any) => p.status === 'voided' && p.void_reason) && (
        <Alert tone="info">Voided: {payments.filter((p: any) => p.void_reason).map((p: any) => `${p.receipt_number} — ${p.void_reason}`).join('; ')}</Alert>
      )}
      {refunding && <RefundDialog sale={{ ...inv, items }} onClose={() => setRefunding(false)} />}
    </div>
  );
}
