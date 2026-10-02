import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Plus, Ticket } from 'lucide-react';
import { api, ApiError, type Paged } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/ui';
import { date, money, number } from '../../lib/format';
import { Alert, Button, Dialog, Empty, Field, Pagination, Person, Skeleton, StatusBadge, Tabs } from '../../components/ui';
import { useActions } from '../actions';

function PlanDialog({ plan, onClose }: { plan?: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const [f, setF] = useState(() => ({
    name: plan?.name ?? '', description: plan?.description ?? '', durationUnit: plan?.duration_unit ?? 'month', durationValue: plan?.duration_value ?? 1,
    price: plan?.price ?? 0, taxRate: plan?.tax_rate ?? 18, benefits: (plan?.benefits ?? []).join('\n'), classAccess: plan?.class_access ?? false,
    ptAccess: plan?.pt_access ?? false, freezeDaysAllowed: plan?.freeze_days_allowed ?? 0, guestPasses: plan?.guest_passes ?? 0,
    maxDiscountPct: plan?.max_discount_pct ?? 10, allBranches: plan?.all_branches ?? true, branchIds: (plan?.branch_ids ?? []) as string[], status: plan?.status ?? 'active',
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, benefits: f.benefits.split('\n').map((s: string) => s.trim()).filter(Boolean) };
      return plan ? api.put(`/plans/${plan.id}`, body) : api.post('/plans', body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['plans'] }); toast('success', plan ? 'Plan updated' : 'Plan created'); onClose(); },
    onError: (e) => e instanceof ApiError && setErrors({ ...e.fieldErrors(), _: e.message }),
  });
  return (
    <Dialog open onClose={onClose} variant="drawer" title={plan ? `Edit ${plan.name}` : 'New membership plan'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save plan</Button></>}>
      <div className="form">
        {errors._ && <Alert>{errors._}</Alert>}
        {plan && <Alert tone="info">Price changes apply to new sales only. Existing memberships keep the price they were sold at.</Alert>}
        <div className="form-grid">
          <Field label="Name" error={errors.name} className="full"><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Duration">
            <div className="row"><input className="input num" type="number" min={1} value={f.durationValue} onChange={(e) => set('durationValue', Number(e.target.value))} />
              <select className="select" value={f.durationUnit} onChange={(e) => set('durationUnit', e.target.value)}><option value="month">months</option><option value="day">days</option></select></div>
          </Field>
          <Field label="Price (before tax)" error={errors.price}><div className="input-prefix"><span>₹</span><input className="input num" type="number" min={0} value={f.price} onChange={(e) => set('price', Number(e.target.value))} /></div></Field>
          <Field label="GST %"><input className="input num" type="number" min={0} max={40} value={f.taxRate} onChange={(e) => set('taxRate', Number(e.target.value))} /></Field>
          <Field label="Max staff discount %" hint="Higher discounts need a manager"><input className="input num" type="number" min={0} max={100} value={f.maxDiscountPct} onChange={(e) => set('maxDiscountPct', Number(e.target.value))} /></Field>
          <Field label="Freeze days allowed"><input className="input num" type="number" min={0} value={f.freezeDaysAllowed} onChange={(e) => set('freezeDaysAllowed', Number(e.target.value))} /></Field>
          <Field label="Guest passes"><input className="input num" type="number" min={0} value={f.guestPasses} onChange={(e) => set('guestPasses', Number(e.target.value))} /></Field>
          <Field label="Benefits" hint="One per line" className="full"><textarea className="textarea" value={f.benefits} onChange={(e) => set('benefits', e.target.value)} /></Field>
          <Field label="Description" className="full"><input className="input" value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={f.classAccess} onChange={(e) => set('classAccess', e.target.checked)} />Includes group classes</label>
        <label className="check"><input type="checkbox" checked={f.ptAccess} onChange={(e) => set('ptAccess', e.target.checked)} />Includes personal training</label>
        <label className="check"><input type="checkbox" checked={f.allBranches} onChange={(e) => set('allBranches', e.target.checked)} />Available at all branches</label>
        {!f.allBranches && (
          <div className="chips">{me?.branches.map((b) => (
            <button type="button" key={b.id} className={`chip ${f.branchIds.includes(b.id) ? 'on' : ''}`}
              onClick={() => set('branchIds', f.branchIds.includes(b.id) ? f.branchIds.filter((x) => x !== b.id) : [...f.branchIds, b.id])}>{b.name}</button>
          ))}</div>
        )}
        <label className="check"><input type="checkbox" checked={f.status === 'archived'} onChange={(e) => set('status', e.target.checked ? 'archived' : 'active')} />Archived (hidden from new sales)</label>
      </div>
    </Dialog>
  );
}

function Plans() {
  const { can } = useAuth();
  const actions = useActions();
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const { data } = useQuery({ queryKey: ['plans'], queryFn: () => api.get<any[]>('/plans') });
  if (!data) return <Skeleton h={300} />;
  return (
    <>
      <div className="grid g-3">
        {data.map((p) => (
          <section key={p.id} className={`card ${p.name.includes('Elite') ? 'glow' : ''}`} style={{ opacity: p.status === 'archived' ? 0.55 : 1 }}>
            <div className="card-body stack" style={{ gap: 10, paddingTop: 18 }}>
              <div className="row between"><b style={{ fontSize: 16 }}>{p.name}</b>{p.status === 'archived' ? <span className="badge neutral">Archived</span> : <span className="badge success">{number(p.active_members)} active</span>}</div>
              <div><span style={{ fontSize: 26, fontWeight: 800 }} className="num">{money(p.price)}</span><span className="faint"> / {p.duration_value} {p.duration_unit}{p.duration_value > 1 ? 's' : ''} + {p.tax_rate}% GST</span></div>
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'grid', gap: 5 }}>
                {p.benefits.map((b: string) => <li key={b} className="row muted" style={{ fontSize: 13 }}><Check size={14} style={{ color: 'var(--accent)' }} />{b}</li>)}
              </ul>
              <div className="row wrap faint" style={{ fontSize: 12 }}>
                <span>{p.freeze_days_allowed} freeze days</span>·<span>max {p.max_discount_pct}% discount</span>·<span>{p.all_branches ? 'All branches' : `${p.branch_ids.length} branches`}</span>
              </div>
              <div className="row" style={{ marginTop: 4 }}>
                {can('memberships.manage') && p.status === 'active' && <Button size="sm" variant="primary" onClick={() => actions.sellMembership({ planId: p.id })}>Sell</Button>}
                {can('plans.manage') && <Button size="sm" icon={<Pencil />} onClick={() => setEditing(p)}>Edit</Button>}
              </div>
            </div>
          </section>
        ))}
        {can('plans.manage') && (
          <button className="card" style={{ borderStyle: 'dashed', display: 'grid', placeItems: 'center', minHeight: 200, cursor: 'pointer', color: 'var(--text-2)', background: 'transparent' }} onClick={() => setEditing(null)}>
            <span className="row"><Plus size={18} />New plan</span>
          </button>
        )}
      </div>
      {editing !== undefined && <PlanDialog plan={editing ?? undefined} onClose={() => setEditing(undefined)} />}
    </>
  );
}

function SoldList() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const { data } = useQuery({
    queryKey: ['memberships', status, page],
    queryFn: () => api.get<Paged<any>>('/memberships', { status, page, pageSize: 25 }),
    placeholderData: keepPreviousData,
  });
  return (
    <section className="card">
      <div className="toolbar">
        <div className="chips">
          {['', 'active', 'expiring_soon', 'expired', 'frozen', 'pending', 'cancelled'].map((s) => (
            <button key={s} className={`chip ${status === s ? 'on' : ''}`} onClick={() => { setStatus(s); setPage(1); }}>{s ? <StatusBadge status={s} /> : 'All'}</button>
          ))}
        </div>
      </div>
      <div className="table-wrap">
        {!data ? <div style={{ padding: 20 }}><Skeleton h={300} /></div> : !data.data.length ? <Empty icon={<Ticket size={20} />} title="No memberships" /> : (
          <table className="tbl">
            <thead><tr><th>Member</th><th>Plan</th><th>Type</th><th>Period</th><th className="r">Value</th><th>Status</th><th className="hide-sm">Branch</th><th className="hide-sm">Sold</th></tr></thead>
            <tbody>{data.data.map((m) => (
              <tr key={m.id} className="clickable" onClick={() => navigate(`/members/${m.member_id}`)}>
                <td><Person name={m.member_name} detail={m.member_code} size="sm" /></td><td>{m.plan_name}</td>
                <td style={{ textTransform: 'capitalize' }} className="muted">{m.kind}</td>
                <td className="muted">{date(m.start_date)} – {date(m.end_date)}</td>
                <td className="r amount">{money(m.price - m.discount)}</td><td><StatusBadge status={m.status} /></td>
                <td className="muted hide-sm">{m.branch_name}</td><td className="muted hide-sm">{date(m.created_at)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {data && data.pagination.total > 0 && <Pagination {...data.pagination} onPage={setPage} />}
    </section>
  );
}

export function MembershipsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as 'plans' | 'sold') ?? 'plans';
  const actions = useActions();
  const { can } = useAuth();
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Memberships</h1><div className="sub">Plans you sell and every membership sold against them.</div></div>
        <div className="actions">{can('memberships.manage') && <Button variant="primary" icon={<Plus />} onClick={() => actions.sellMembership()}>Sell membership</Button>}</div>
      </div>
      <Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[{ key: 'plans', label: 'Plans' }, { key: 'sold', label: 'Memberships sold' }]} />
      {tab === 'plans' ? <Plans /> : <SoldList />}
    </div>
  );
}
