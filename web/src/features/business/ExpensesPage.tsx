import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, FileText, Landmark, Paperclip, PieChart, Plus, Receipt, Search, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { api, ApiError, branchScope, openPdf, session, type Paged } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced, useToast } from '../../lib/ui';
import { date, money, moneyShort, today } from '../../lib/format';
import { Alert, Button, Card, Dialog, Empty, Field, Method, Pagination, Segmented, Skeleton, Tabs } from '../../components/ui';
import { MetricLine } from '../../components/charts';
import { MethodPicker, referenceLabel, referenceRequired } from '../shared';

const monthLabel = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });

export async function uploadReceipt(expenseId: string, file: File) {
  const res = await fetch(`/api/expenses/${expenseId}/receipt`, {
    method: 'POST', body: file,
    headers: { Authorization: `Bearer ${session.get()?.accessToken}`, 'X-Branch-Id': branchScope.get(), 'Content-Type': file.type || 'application/octet-stream' },
  });
  if (!res.ok) throw new ApiError(res.status, 'upload', (await res.json().catch(() => ({}))).error?.message ?? 'Upload failed');
}

function ExpenseDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const scoped = branchScope.get();
  const { data: cats } = useQuery({ queryKey: ['expense-categories'], queryFn: () => api.get<any[]>('/expenses/categories') });
  const { data: suppliers } = useQuery({ queryKey: ['suppliers'], queryFn: () => api.get<any[]>('/inventory/suppliers').catch(() => []) });
  const [f, setF] = useState({ branchId: scoped !== 'all' ? scoped : me?.branches[0]?.id ?? '', categoryId: '', amount: '' as number | '', expenseDate: today(), vendor: '', supplierId: '', description: '' });
  const [method, setMethod] = useState('upi');
  const [reference, setReference] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const save = useMutation({
    mutationFn: async () => {
      const row = await api.post<any>('/expenses', { ...f, supplierId: f.supplierId || null, vendor: f.vendor || null, method, reference: reference || null });
      if (file) await uploadReceipt(row.id, file).catch((e) => { toast('error', `Saved, but the receipt didn't upload: ${e.message}`); });
      return row;
    },
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['expenses'] }); qc.invalidateQueries({ queryKey: ['expense-categories'] }); toast('success', `${r.expense_number} recorded`); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? (Array.isArray(e.details) ? `${(e.details as any)[0].path}: ${(e.details as any)[0].message}` : e.message) : 'Failed'),
  });
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog open variant="drawer" onClose={onClose} title="Record expense" sub="Money paid out of the gym. Salaries are recorded from each employee’s profile."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.categoryId || !f.amount} loading={save.isPending} onClick={() => { setError(''); save.mutate(); }}>Save {f.amount ? money(Number(f.amount)) : ''}</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <Field label="Category">
          <div className="chips">{cats?.filter((c) => c.is_active && c.key !== 'salaries').map((c) => <button type="button" key={c.id} className={`chip ${f.categoryId === c.id ? 'on' : ''}`} onClick={() => setF({ ...f, categoryId: c.id })}>{c.name}</button>)}</div>
        </Field>
        <div className="form-grid">
          <Field label="Amount (₹)"><input className="input num" type="number" min={1} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value === '' ? '' : Number(e.target.value) })} autoFocus /></Field>
          <Field label="Date"><input className="input" type="date" max={today()} value={f.expenseDate} onChange={set('expenseDate')} /></Field>
          {(me?.branches.length ?? 0) > 1 && <Field label="Branch"><select className="select" value={f.branchId} onChange={set('branchId')}>{me!.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>}
          <Field label="Paid to"><input className="input" value={f.vendor} onChange={set('vendor')} placeholder="Vendor or person" list="supplier-list" /></Field>
          <datalist id="supplier-list">{suppliers?.map((s) => <option key={s.id} value={s.name} />)}</datalist>
        </div>
        <Field label="Paid via"><MethodPicker value={method} onChange={setMethod} /></Field>
        {method !== 'cash' && <Field label={referenceLabel(method)}><input className="input" value={reference} onChange={(e) => setReference(e.target.value)} required={referenceRequired(method)} /></Field>}
        <Field label="Description"><textarea className="textarea" value={f.description} onChange={set('description')} placeholder="What was this for?" /></Field>
        <Field label="Receipt" hint="Photo or PDF of the bill · max 8 MB">
          <div className="row">
            <Button type="button" size="sm" icon={<Paperclip />} onClick={() => fileRef.current?.click()}>{file ? 'Change file' : 'Attach'}</Button>
            {file && <span className="faint" style={{ fontSize: 13 }}>{file.name}</span>}
            <input ref={fileRef} type="file" hidden accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
        </Field>
      </div>
    </Dialog>
  );
}

function VoidDialog({ expense, onClose }: { expense: any; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/expenses/${expense.id}/void`, { reason }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['expenses'] }); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Failed'),
  });
  return (
    <Dialog open onClose={onClose} title={`Void ${expense.expense_number}?`} sub={`${money(expense.amount)} · ${expense.category_name}. The record stays in the audit trail.`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" disabled={reason.trim().length < 3} loading={m.isPending} onClick={() => m.mutate()}>Void expense</Button></>}>
      <div className="form">{error && <Alert>{error}</Alert>}<Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Entered twice, wrong amount…" autoFocus /></Field></div>
    </Dialog>
  );
}

function ExpenseList() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [status, setStatus] = useState('recorded');
  const [page, setPage] = useState(1);
  const [voiding, setVoiding] = useState<any>(null);
  const [attachFor, setAttachFor] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const term = useDebounced(q.trim());
  const { data: cats } = useQuery({ queryKey: ['expense-categories'], queryFn: () => api.get<any[]>('/expenses/categories') });
  const { data } = useQuery({
    queryKey: ['expenses', term, cat, status, page],
    queryFn: () => api.get<Paged<any> & { summary: { totalAmount: number } }>('/expenses', { search: term || undefined, categoryId: cat || undefined, status: status || undefined, page, pageSize: 25 }),
  });
  return (
    <section className="card">
      <div className="toolbar">
        <div className="search-box"><Search /><input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Vendor, description, EXP no. or reference" /></div>
        <select className="select" style={{ width: 170 }} value={cat} onChange={(e) => { setCat(e.target.value); setPage(1); }} aria-label="Category"><option value="">All categories</option>{cats?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <div className="chips">{[['recorded', 'Recorded'], ['voided', 'Voided'], ['', 'All']].map(([k, l]) => <button key={k} className={`chip ${status === k ? 'on' : ''}`} onClick={() => { setStatus(k); setPage(1); }}>{l}</button>)}</div>
        <div style={{ flex: 1 }} />
        {data && <span className="faint">Total <b className="num" style={{ color: 'var(--text)' }}>{money(data.summary.totalAmount)}</b></span>}
      </div>
      <div className="table-wrap">
        {!data ? <div style={{ padding: 20 }}><Skeleton h={320} /></div> : !data.data.length ? <Empty title="No expenses" /> : (
          <table className="tbl">
            <thead><tr><th>Date</th><th>Expense</th><th>Category</th><th className="r">Amount</th><th>Paid via</th><th className="hide-sm">Branch</th><th /></tr></thead>
            <tbody>{data.data.map((e) => (
              <tr key={e.id} className={e.status === 'voided' ? 'void' : ''}>
                <td className="muted" style={{ whiteSpace: 'nowrap' }}>{date(e.expense_date)}</td>
                <td><b>{e.vendor ?? e.employee_name ?? '—'}</b><div className="faint" style={{ fontSize: 12, maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.expense_number}{e.description ? ` · ${e.description}` : ''}{e.void_reason ? ` · voided: ${e.void_reason}` : ''}</div></td>
                <td><span className="badge neutral">{e.category_name}</span></td>
                <td className="r amount">{money(e.amount, true)}</td>
                <td><Method method={e.method} /></td>
                <td className="muted hide-sm">{e.branch_name}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {e.has_receipt ? <Button size="sm" variant="ghost" icon={<FileText />} aria-label="View receipt" onClick={() => openPdf(`/expenses/${e.id}/receipt`)} />
                    : can('expenses.manage') && e.status === 'recorded' && <Button size="sm" variant="ghost" icon={<Paperclip />} aria-label="Attach receipt" onClick={() => { setAttachFor(e.id); fileRef.current?.click(); }} />}
                  {can('expenses.manage') && e.status === 'recorded' && <Button size="sm" variant="ghost" icon={<Ban />} aria-label="Void" onClick={() => setVoiding(e)} />}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {data && <Pagination page={data.pagination.page} totalPages={data.pagination.totalPages} total={data.pagination.total} onPage={setPage} />}
      <input ref={fileRef} type="file" hidden accept="image/jpeg,image/png,image/webp,application/pdf" onChange={async (ev) => {
        const file = ev.target.files?.[0]; ev.target.value = '';
        if (!file || !attachFor) return;
        try { await uploadReceipt(attachFor, file); toast('success', 'Receipt attached'); qc.invalidateQueries({ queryKey: ['expenses'] }); } catch (err: any) { toast('error', err.message); }
      }} />
      {voiding && <VoidDialog expense={voiding} onClose={() => setVoiding(null)} />}
    </section>
  );
}

function ProfitLoss() {
  const [months, setMonths] = useState(6);
  const { data } = useQuery({ queryKey: ['expenses', 'pnl', months], queryFn: () => api.get<any>('/expenses/pnl', { months }) });
  if (!data) return <Skeleton h={400} />;
  const margin = data.totals.revenue > 0 ? Math.round((data.totals.profit / data.totals.revenue) * 100) : 0;
  const maxCat = Math.max(1, ...data.categories.map((c: any) => Number(c.amount)));
  // The running month is partial; trend lines use complete months only.
  const complete = data.series.slice(0, -1);
  const pts = (k: string) => complete.map((r: any) => ({ date: r.date, value: Number(r[k]) }));
  const fmt = (v: number) => moneyShort(v);
  const productMargin = data.cogs.product_revenue > 0 ? Math.round(((data.cogs.product_revenue - data.cogs.product_cost) / data.cogs.product_revenue) * 100) : null;
  return (
    <div className="stack">
      <div className="row between wrap">
        <Segmented value={months} onChange={setMonths} options={[{ value: 3, label: '3 months' }, { value: 6, label: '6 months' }, { value: 12, label: '12 months' }]} />
        <span className="faint" style={{ fontSize: 12.5 }}>Cash basis: money collected (net of refunds) against money paid out.</span>
      </div>
      <div className="grid g-3">
        <section className="card kpi"><div className="label"><TrendingUp />Revenue</div><div className="value">{money(data.totals.revenue)}</div><div className="compare">collections minus refunds · incl. this month</div></section>
        <section className="card kpi"><div className="label"><TrendingDown />Expenses</div><div className="value">{money(data.totals.expenses)}</div><div className="compare">{data.categories.length} categories</div></section>
        <section className="card kpi hero"><div className="label"><Landmark />Net profit</div><div className="value" style={data.totals.profit < 0 ? { background: 'none', color: 'var(--danger)', WebkitTextFillColor: 'var(--danger)' } : undefined}>{money(data.totals.profit)}</div><div className="compare">{margin}% margin</div></section>
      </div>
      <div className="grid g-3">
        <Card title="Revenue" sub="complete months"><MetricLine points={pts('revenue')} format={fmt} better="up" /></Card>
        <Card title="Expenses" sub="complete months"><MetricLine points={pts('expenses')} format={fmt} color="var(--series-3)" /></Card>
        <Card title="Profit" sub="complete months"><MetricLine points={pts('profit')} format={fmt} target={0} color="var(--series-2)" better="up" /></Card>
      </div>
      <div className="grid g-dash-1">
        <Card title="Where the money goes" icon={<PieChart />} sub={`${months} months`}>
          <div className="stack" style={{ gap: 12 }}>{data.categories.map((c: any) => (
            <div key={c.id} className="pnl-row">
              <span className="muted">{c.name}</span>
              <div className="share-bar"><i style={{ width: `${(Number(c.amount) / maxCat) * 100}%` }} /></div>
              <span className="num" style={{ textAlign: 'right' }}><b>{money(c.amount)}</b> <span className="faint">{Math.round((Number(c.amount) / data.totals.expenses) * 100)}%</span></span>
            </div>
          ))}</div>
        </Card>
        <Card title="Monthly statement" icon={<Receipt />} bodyClass="">
          <div className="table-wrap" style={{ marginTop: 6 }}><table className="tbl">
            <thead><tr><th>Month</th><th className="r">In</th><th className="r">Out</th><th className="r">Net</th></tr></thead>
            <tbody>{[...data.series].reverse().map((r: any) => (
              <tr key={r.date}><td>{monthLabel(r.date)}{r.date === data.series.at(-1).date && <span className="faint"> · to date</span>}</td><td className="r num">{money(r.revenue)}</td><td className="r num muted">{money(r.expenses)}</td>
                <td className="r amount" style={{ color: r.profit < 0 ? 'var(--danger)' : 'var(--success)' }}>{money(r.profit)}</td></tr>
            ))}</tbody>
          </table></div>
          {productMargin !== null && <div className="faint" style={{ fontSize: 12.5, padding: '10px 20px 16px' }}>Shop: {money(data.cogs.product_revenue)} in product sales at {productMargin}% gross margin (cost of goods {money(data.cogs.product_cost)}).</div>}
        </Card>
      </div>
    </div>
  );
}

function Categories() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const { data } = useQuery({ queryKey: ['expense-categories'], queryFn: () => api.get<any[]>('/expenses/categories') });
  const add = useMutation({
    mutationFn: () => api.post('/expenses/categories', { name }),
    onSuccess: () => { setName(''); qc.invalidateQueries({ queryKey: ['expense-categories'] }); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Failed'),
  });
  const toggle = useMutation({
    mutationFn: (c: any) => api.put(`/expenses/categories/${c.id}`, { name: c.name, isActive: !c.is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expense-categories'] }),
  });
  return (
    <section className="card">
      {can('expenses.manage') && (
        <div className="toolbar">
          <input className="input" style={{ width: 260 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="New category, e.g. Insurance" />
          <Button icon={<Plus />} disabled={name.trim().length < 2} loading={add.isPending} onClick={() => { setError(''); add.mutate(); }}>Add</Button>
          {error && <span style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</span>}
        </div>
      )}
      <div className="table-wrap"><table className="tbl">
        <thead><tr><th>Category</th><th className="r">This month</th><th /></tr></thead>
        <tbody>{data?.map((c) => (
          <tr key={c.id} style={{ opacity: c.is_active ? 1 : 0.5 }}>
            <td><b>{c.name}</b>{c.is_system && <span className="faint" style={{ fontSize: 12 }}> · built-in</span>}</td>
            <td className="r amount">{money(c.this_month)}</td>
            <td>{can('expenses.manage') && !c.is_system && <Button size="sm" variant="ghost" onClick={() => toggle.mutate(c)}>{c.is_active ? 'Archive' : 'Restore'}</Button>}</td>
          </tr>
        ))}</tbody>
      </table></div>
    </section>
  );
}

export function ExpensesPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as 'list' | 'pnl' | 'categories') ?? 'list';
  const [adding, setAdding] = useState(false);
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Expenses</h1><div className="sub">Rent, utilities, salaries, stock and everything else paid out — with receipts and profit &amp; loss.</div></div>
        <div className="actions">{can('expenses.manage') && <Button variant="primary" icon={<Wallet />} onClick={() => setAdding(true)}>Record expense</Button>}</div>
      </div>
      <Tabs value={tab} onChange={(t) => setParams(t === 'list' ? {} : { tab: t })} tabs={[{ key: 'list', label: 'Expenses' }, { key: 'pnl', label: 'Profit & loss' }, { key: 'categories', label: 'Categories' }]} />
      {tab === 'list' && <ExpenseList />}
      {tab === 'pnl' && <ProfitLoss />}
      {tab === 'categories' && <Categories />}
      {adding && <ExpenseDialog onClose={() => setAdding(false)} />}
    </div>
  );
}
