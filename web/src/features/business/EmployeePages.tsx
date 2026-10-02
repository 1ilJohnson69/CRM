import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Banknote, Clock, IdCard, Pencil, Plus, TrendingUp } from 'lucide-react';
import { api, ApiError, branchScope } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/ui';
import { date, dateTime, money, relative, today } from '../../lib/format';
import { Alert, Avatar, Badge, Button, Card, Dialog, Empty, Field, Method, Skeleton } from '../../components/ui';
import { MetricLine } from '../../components/charts';
import { MethodPicker, referenceLabel, referenceRequired } from '../shared';

const SALARY_TYPE: Record<string, string> = { monthly: 'per month', hourly: 'per hour', per_session: 'per session' };
const thisMonth = () => today().slice(0, 7);
const prevMonth = () => { const d = new Date(`${thisMonth()}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };
const monthName = (m: string) => new Date(`${m.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** The metrics that matter differ by role; show the ones the person's work produces. */
function metricsFor(p: any) {
  const all = [
    { k: 'collected', label: 'Collected', fmt: (v: number) => money(v) },
    { k: 'new_sales', label: 'New memberships' }, { k: 'renewals', label: 'Renewals' }, { k: 'pos_sales', label: 'Shop sales', fmt: (v: number) => money(v) },
    { k: 'leads_won', label: 'Leads won' }, { k: 'followups_done', label: 'Follow-ups done' },
    { k: 'pt_sessions', label: 'PT sessions' }, { k: 'classes_taught', label: 'Classes taught' }, { k: 'class_attendees', label: 'Class attendees' },
    { k: 'assessments', label: 'Assessments' }, { k: 'days_present', label: 'Days present' }, { k: 'hours', label: 'Hours on shift' },
  ];
  return all.filter((m) => Number(p[m.k]) > 0 || ['days_present', 'hours'].includes(m.k));
}

export function PerformanceTable() {
  const [month, setMonth] = useState(thisMonth());
  const { data } = useQuery({ queryKey: ['performance', month], queryFn: () => api.get<any[]>('/employees/performance', { month }) });
  return (
    <section className="card">
      <div className="toolbar">
        <input type="month" className="input" style={{ width: 180 }} value={month} max={thisMonth()} onChange={(e) => setMonth(e.target.value || thisMonth())} aria-label="Month" />
        <span className="faint" style={{ fontSize: 12.5 }}>Computed from the records each person creates — nothing extra to log.</span>
      </div>
      <div className="table-wrap">
        {!data ? <div style={{ padding: 20 }}><Skeleton h={300} /></div> : (
          <table className="tbl">
            <thead><tr><th>Employee</th><th className="r">Collected</th><th className="r">New</th><th className="r">Renewals</th><th className="r">Shop</th><th className="r">Leads won</th><th className="r">PT</th><th className="r">Classes</th><th className="r">Assess.</th><th className="r">Days</th><th className="r">Hours</th></tr></thead>
            <tbody>{data.map((p) => (
              <tr key={p.id}>
                <td><Link to={`/admin/employees/${p.id}`} className="row"><Avatar name={p.full_name} size="sm" /><span><b>{p.full_name}</b><div className="faint" style={{ fontSize: 12 }}>{p.role_name}</div></span></Link></td>
                <td className="r amount">{p.collected ? money(p.collected) : <span className="faint">—</span>}</td>
                {['new_sales', 'renewals'].map((k) => <td key={k} className="r num">{p[k] || <span className="faint">—</span>}</td>)}
                <td className="r num">{p.pos_sales ? money(p.pos_sales) : <span className="faint">—</span>}</td>
                {['leads_won', 'pt_sessions', 'classes_taught', 'assessments', 'days_present'].map((k) => <td key={k} className="r num">{p[k] || <span className="faint">—</span>}</td>)}
                <td className="r num">{Number(p.hours) || <span className="faint">—</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function HrDialog({ e, onClose }: { e: any; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    emergencyContact: e.emergency_contact ?? '', address: e.address ?? '', notes: e.notes ?? '',
    salary: e.salary ?? '', salaryType: e.salary_type ?? 'monthly', commissionPct: e.commission_pct ?? '',
  });
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: () => api.put(`/employees/${e.id}/hr`, e.salaryAccess
      ? { ...f, salary: f.salary === '' ? null : Number(f.salary), commissionPct: f.commissionPct === '' ? null : Number(f.commissionPct) }
      : { emergencyContact: f.emergencyContact, address: f.address, notes: f.notes }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['employee', e.id] }); onClose(); },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed'),
  });
  const set = (k: keyof typeof f) => (ev: any) => setF({ ...f, [k]: ev.target.value });
  return (
    <Dialog open variant="drawer" onClose={onClose} title={`HR details · ${e.full_name}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        {e.salaryAccess && (
          <>
            <div className="section-label">Pay</div>
            <div className="form-grid">
              <Field label="Salary (₹)"><input className="input num" type="number" min={0} value={f.salary} onChange={set('salary')} /></Field>
              <Field label="Basis"><select className="select" value={f.salaryType} onChange={set('salaryType')}>{Object.entries(SALARY_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
              <Field label="Commission %" hint="On PT / sales, for reference"><input className="input num" type="number" min={0} max={100} value={f.commissionPct} onChange={set('commissionPct')} /></Field>
            </div>
          </>
        )}
        <div className="section-label">Personal</div>
        <Field label="Emergency contact"><input className="input" value={f.emergencyContact} onChange={set('emergencyContact')} placeholder="Name · relation · phone" /></Field>
        <Field label="Address"><textarea className="textarea" value={f.address} onChange={set('address')} /></Field>
        <Field label="Notes"><textarea className="textarea" value={f.notes} onChange={set('notes')} /></Field>
      </div>
    </Dialog>
  );
}

function SalaryDialog({ e, onClose }: { e: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const scoped = branchScope.get();
  const branchOptions = e.all_branches ? null : e.branches;
  const { me } = useAuth();
  const options = branchOptions?.length ? branchOptions : me?.branches ?? [];
  const paidMonths = new Set((e.payouts ?? []).filter((p: any) => p.status === 'recorded').map((p: any) => p.salary_month.slice(0, 7)));
  const [month, setMonth] = useState(paidMonths.has(prevMonth()) ? thisMonth() : prevMonth());
  const [amount, setAmount] = useState<number | ''>(e.salary_type === 'monthly' ? e.salary ?? '' : '');
  const [branchId, setBranchId] = useState(scoped !== 'all' && options.some((b: any) => b.id === scoped) ? scoped : options[0]?.id ?? '');
  const [method, setMethod] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: () => api.post(`/employees/${e.id}/salary`, { month, amount, branchId, method, reference: reference || null, notes: notes || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['employee', e.id] }); qc.invalidateQueries({ queryKey: ['expenses'] }); toast('success', `Salary for ${monthName(month)} recorded`); onClose(); },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed'),
  });
  return (
    <Dialog open onClose={onClose} title={`Pay salary · ${e.full_name}`} sub="Recorded as a Salaries expense for the month — one payout per month."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!amount || !branchId} loading={save.isPending} onClick={() => { setError(''); save.mutate(); }}>Record {amount ? money(Number(amount)) : ''}</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <div className="form-grid">
          <Field label="For month" hint={paidMonths.has(month) ? 'Already paid' : undefined}><input className="input" type="month" max={thisMonth()} value={month} onChange={(ev) => setMonth(ev.target.value)} /></Field>
          <Field label="Amount (₹)" hint={e.salary ? `Salary ${money(e.salary)} ${SALARY_TYPE[e.salary_type]}` : undefined}><input className="input num" type="number" min={1} value={amount} onChange={(ev) => setAmount(ev.target.value === '' ? '' : Number(ev.target.value))} /></Field>
          {options.length > 1 && <Field label="Charged to branch" className="full"><select className="select" value={branchId} onChange={(ev) => setBranchId(ev.target.value)}>{options.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>}
        </div>
        <Field label="Paid via"><MethodPicker value={method} onChange={setMethod} /></Field>
        {method !== 'cash' && <Field label={referenceLabel(method)}><input className="input" value={reference} onChange={(ev) => setReference(ev.target.value)} required={referenceRequired(method)} /></Field>}
        <Field label="Note"><input className="input" value={notes} onChange={(ev) => setNotes(ev.target.value)} placeholder="Incl. PT incentive, advance adjusted…" /></Field>
      </div>
    </Dialog>
  );
}

export function EmployeeDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const [hr, setHr] = useState(false);
  const [pay, setPay] = useState(false);
  const { data: e, error } = useQuery({ queryKey: ['employee', id], queryFn: () => api.get<any>(`/employees/${id}`) });
  if (error) return <div className="page"><Empty title="Employee not found"><Link to="/admin/employees" className="btn">Back to employees</Link></Empty></div>;
  if (!e) return <div className="page"><Skeleton h={140} /><Skeleton h={320} /></div>;
  const p = e.performance;
  const metrics = metricsFor(p);
  const trendKeys = [
    { k: 'collected', label: 'Collected', fmt: (v: number) => money(v) }, { k: 'pt_sessions', label: 'PT sessions', fmt: (v: number) => String(Math.round(v)) },
    { k: 'classes', label: 'Classes taught', fmt: (v: number) => String(Math.round(v)) }, { k: 'hours', label: 'Hours on shift', fmt: (v: number) => String(Math.round(v)) },
  ].filter((t) => e.trend.some((r: any) => Number(r[t.k]) > 0));
  return (
    <div className="page">
      <Link to="/admin/employees" className="btn ghost sm" style={{ alignSelf: 'flex-start' }}><ArrowLeft />Employees</Link>
      <section className="card glow">
        <div className="profile-hero">
          <Avatar name={e.full_name} size="lg" />
          <div className="who">
            <div className="row wrap"><h1>{e.full_name}</h1>{e.is_active ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}</div>
            <div className="muted" style={{ marginTop: 3 }}>{e.designation ?? e.role_name} · {e.all_branches ? 'All branches' : e.branches.map((b: any) => b.name).join(', ')}{e.joining_date ? ` · joined ${date(e.joining_date)}` : ''}</div>
            <div className="row wrap" style={{ marginTop: 12 }}>
              {can('staff.manage') && <Button size="sm" icon={<Pencil />} onClick={() => setHr(true)}>HR details</Button>}
              {e.salaryAccess && can('expenses.manage') && <Button size="sm" variant="primary" icon={<Banknote />} onClick={() => setPay(true)}>Pay salary</Button>}
              {e.phone && <a className="btn sm" href={`tel:${e.phone}`}>{e.phone}</a>}
            </div>
          </div>
          <div className="facts">
            <div className="fact"><div className="k">Role</div><div className="v">{e.role_name}</div></div>
            {e.salaryAccess && <div className="fact"><div className="k">Salary</div><div className="v">{e.salary ? money(e.salary) : '—'}</div><div className="faint" style={{ fontSize: 12 }}>{e.salary ? SALARY_TYPE[e.salary_type] : ''}{e.commission_pct ? ` · ${e.commission_pct}% commission` : ''}</div></div>}
            <div className="fact"><div className="k">This month</div><div className="v">{p.days_present} days</div><div className="faint" style={{ fontSize: 12 }}>{p.hours} hours on shift</div></div>
            <div className="fact"><div className="k">Last sign-in</div><div className="v">{e.last_login_at ? relative(e.last_login_at) : 'Never'}</div></div>
          </div>
        </div>
      </section>

      <Card title={`Performance · ${monthName(thisMonth())}`} icon={<TrendingUp />} sub="From collections, sales, sessions, classes, assessments and shifts">
        <div className="metric-tiles">{metrics.map((m) => (
          <div key={m.k} className="metric-tile"><div className="k">{m.label}</div><div className="v">{m.fmt ? m.fmt(Number(p[m.k])) : Number(p[m.k])}</div></div>
        ))}</div>
      </Card>
      {trendKeys.length > 0 && (
        <div className="grid g-4">{trendKeys.map((t) => (
          <Card key={t.k} title={t.label} sub="complete months"><MetricLine points={e.trend.slice(0, -1).map((r: any) => ({ date: r.date, value: Number(r[t.k]) }))} format={t.fmt} better="up" height={130} /></Card>
        ))}</div>
      )}

      <div className="grid g-2">
        <Card title="Shifts" icon={<Clock />} sub="Clock-ins at the front desk" bodyClass="">
          {!e.attendance.length ? <Empty title="No shifts recorded" /> : (
            <div className="table-wrap" style={{ marginTop: 6, maxHeight: 360, overflowY: 'auto' }}><table className="tbl"><tbody>{e.attendance.map((a: any) => (
              <tr key={a.id}><td>{dateTime(a.clock_in)}</td><td className="muted">{a.clock_out ? `→ ${new Date(a.clock_out).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : <Badge tone="success">On shift</Badge>}</td><td className="muted">{a.branch_name}</td><td className="r num">{a.hours} h</td></tr>
            ))}</tbody></table></div>
          )}
        </Card>
        {e.salaryAccess ? (
          <Card title="Salary payouts" icon={<Banknote />} bodyClass="" actions={can('expenses.manage') && <Button size="sm" icon={<Plus />} onClick={() => setPay(true)}>Pay</Button>}>
            {!e.payouts?.length ? <Empty title="No payouts recorded" /> : (
              <div className="table-wrap" style={{ marginTop: 6 }}><table className="tbl"><tbody>{e.payouts.map((s: any) => (
                <tr key={s.id} className={s.status === 'voided' ? 'void' : ''}>
                  <td><b>{monthName(s.salary_month)}</b><div className="faint" style={{ fontSize: 12 }}>{s.expense_number} · paid {date(s.expense_date)}</div></td>
                  <td><Method method={s.method} /></td><td className="muted">{s.branch_name}</td><td className="r amount">{money(s.amount, true)}</td>
                </tr>
              ))}</tbody></table></div>
            )}
          </Card>
        ) : (
          <Card title="Details" icon={<IdCard />}>
            <dl className="kv" style={{ gridTemplateColumns: '140px 1fr' }}>
              <dt>Email</dt><dd>{e.email}</dd><dt>Phone</dt><dd>{e.phone}</dd>
              <dt>Emergency contact</dt><dd>{e.emergency_contact ?? '—'}</dd>
            </dl>
          </Card>
        )}
      </div>
      {e.salaryAccess && (
        <Card title="Details" icon={<IdCard />}>
          <dl className="kv" style={{ gridTemplateColumns: '160px 1fr' }}>
            <dt>Email</dt><dd>{e.email}</dd><dt>Phone</dt><dd>{e.phone}</dd>
            <dt>Emergency contact</dt><dd>{e.emergency_contact ?? '—'}</dd><dt>Address</dt><dd>{e.address ?? '—'}</dd>
            {e.notes && <><dt>Notes</dt><dd>{e.notes}</dd></>}
          </dl>
        </Card>
      )}
      {hr && <HrDialog e={e} onClose={() => setHr(false)} />}
      {pay && <SalaryDialog e={e} onClose={() => setPay(false)} />}
    </div>
  );
}

