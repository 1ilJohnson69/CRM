import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Copy, Download, Filter, Lock, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { api, ApiError, branchScope, session, type Paged } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced, useToast } from '../../lib/ui';
import { date, daysLabel, money, moneyShort, number } from '../../lib/format';
import { Alert, Button, Card, Dialog, Empty, Field, Pagination, Person, Skeleton, StatusBadge } from '../../components/ui';

const STATUS_OPTIONS = ['active', 'expiring_soon', 'expired', 'frozen', 'pending', 'cancelled'];
const STATUS_LABEL: Record<string, string> = { active: 'Active', expiring_soon: 'Expiring soon', expired: 'Expired', frozen: 'Frozen', pending: 'Payment pending', cancelled: 'Cancelled' };

/** Plain-language summary of a rule set, shown on cards. */
export function describeRules(r: Record<string, any>, plans: any[] = []) {
  const out: string[] = [];
  if (r.statuses?.length) out.push(r.statuses.map((s: string) => STATUS_LABEL[s] ?? s).join(' or '));
  if (r.expiresWithinDays !== undefined) out.push(`expires within ${r.expiresWithinDays} days`);
  if (r.expiredWithinDays !== undefined) out.push(`expired in last ${r.expiredWithinDays} days`);
  if (r.joinedWithinDays !== undefined) out.push(`joined in last ${r.joinedWithinDays} days`);
  if (r.lifetimeValueMin !== undefined) out.push(`paid ≥ ${moneyShort(r.lifetimeValueMin)} lifetime`);
  if (r.lifetimeValueMax !== undefined) out.push(`paid ≤ ${moneyShort(r.lifetimeValueMax)} lifetime`);
  if (r.hasOutstanding !== undefined) out.push(r.hasOutstanding ? 'has dues' : 'no dues');
  if (r.hasPersonalTraining !== undefined) out.push(r.hasPersonalTraining ? 'PT member' : 'no PT');
  if (r.hasClassAccess !== undefined) out.push(r.hasClassAccess ? 'class access' : 'no class access');
  if (r.referredSomeone !== undefined) out.push(r.referredSomeone ? 'referred someone' : 'never referred');
  if (r.noContactDays !== undefined) out.push(`not contacted in ${r.noContactDays} days`);
  if (r.planIds?.length) out.push(`on ${r.planIds.map((id: string) => plans.find((p) => p.id === id)?.name ?? 'plan').join(' / ')}`);
  if (r.genders?.length) out.push(r.genders.join(' / '));
  if (r.sources?.length) out.push(`via ${r.sources.join(' / ')}`);
  if (r.ageMin !== undefined || r.ageMax !== undefined) out.push(`age ${r.ageMin ?? 0}–${r.ageMax ?? '∞'}`);
  if (r.birthdayThisMonth) out.push('birthday this month');
  return out.length ? out.join(' · ') : 'All members';
}

async function downloadCsv(id: string, name: string) {
  const res = await fetch(`/api/segments/${id}/export`, { headers: { Authorization: `Bearer ${session.get()?.accessToken}`, 'X-Branch-Id': branchScope.get() } });
  if (!res.ok) throw new Error('Export failed');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------- builder --

type Rules = Record<string, any>;

function NumberRule({ label, k, rules, setRules, prefix, suffix }: { label: string; k: string; rules: Rules; setRules: (r: Rules) => void; prefix?: string; suffix?: string }) {
  const on = rules[k] !== undefined;
  return (
    <div className="rule">
      <label className="check"><input type="checkbox" checked={on} onChange={(e) => { const r = { ...rules }; if (e.target.checked) r[k] = k.startsWith('lifetime') ? 50000 : 30; else delete r[k]; setRules(r); }} />{label}</label>
      {on && (
        <div className="row" style={{ gap: 6 }}>
          {prefix && <span className="faint">{prefix}</span>}
          <input className="input num" style={{ width: 120 }} type="number" min={0} value={rules[k]} onChange={(e) => setRules({ ...rules, [k]: Number(e.target.value) })} />
          {suffix && <span className="faint">{suffix}</span>}
        </div>
      )}
    </div>
  );
}

function TriRule({ label, k, rules, setRules, yes, no }: { label: string; k: string; rules: Rules; setRules: (r: Rules) => void; yes: string; no: string }) {
  const v = rules[k];
  const set = (val: boolean | undefined) => { const r = { ...rules }; if (val === undefined) delete r[k]; else r[k] = val; setRules(r); };
  return (
    <div className="rule">
      <span style={{ fontWeight: 600 }}>{label}</span>
      <div className="chips">
        <button type="button" className={`chip ${v === undefined ? 'on' : ''}`} onClick={() => set(undefined)}>Any</button>
        <button type="button" className={`chip ${v === true ? 'on' : ''}`} onClick={() => set(true)}>{yes}</button>
        <button type="button" className={`chip ${v === false ? 'on' : ''}`} onClick={() => set(false)}>{no}</button>
      </div>
    </div>
  );
}

export function SegmentBuilder({ segment, onClose }: { segment?: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState(segment && !segment.is_system ? segment.name : segment ? `${segment.name} (copy)` : '');
  const [description, setDescription] = useState(segment?.description ?? '');
  const [rules, setRules] = useState<Rules>(segment?.rules ?? {});
  const [error, setError] = useState('');
  const debounced = useDebounced(rules, 300);
  const { data: plans } = useQuery({ queryKey: ['plans'], queryFn: () => api.get<any[]>('/plans') });
  const { data: preview, isFetching } = useQuery({
    queryKey: ['segment-preview', debounced],
    queryFn: () => api.post<Paged<any>>('/segments/preview', { rules: debounced }),
    placeholderData: keepPreviousData,
  });
  const editing = segment && !segment.is_system;
  const save = useMutation({
    mutationFn: () => (editing ? api.put(`/segments/${segment.id}`, { name, description: description || null, rules }) : api.post<any>('/segments', { name, description: description || null, rules })),
    onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ['segments'] }); toast('success', 'Segment saved'); onClose(); if (!editing && r?.id) navigate(`/segments/${r.id}`); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Failed'),
  });
  const toggleIn = (k: string, v: string) => {
    const cur: string[] = rules[k] ?? [];
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    const r = { ...rules };
    if (next.length) r[k] = next; else delete r[k];
    setRules(r);
  };
  return (
    <Dialog open variant="drawer" wide onClose={onClose} title={editing ? 'Edit segment' : 'New segment'} sub="Segments are live filters — membership changes are reflected instantly."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={name.trim().length < 2} loading={save.isPending} onClick={() => save.mutate()}>Save segment</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <div className="form-grid">
          <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lapsed annual members" /></Field>
          <Field label="Description"><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        </div>
        <div className="summary-box" style={{ position: 'sticky', top: -16, zIndex: 2 }}>
          <div className="row between"><b>{isFetching ? 'Counting…' : `${number(preview?.pagination.total ?? 0)} members match`}</b><span className="faint" style={{ fontSize: 12 }}>{describeRules(rules, plans)}</span></div>
        </div>
        <div className="section-label">Membership</div>
        <div className="rule"><span style={{ fontWeight: 600 }}>Status</span>
          <div className="chips">{STATUS_OPTIONS.map((s) => <button type="button" key={s} className={`chip ${rules.statuses?.includes(s) ? 'on' : ''}`} onClick={() => toggleIn('statuses', s)}>{STATUS_LABEL[s]}</button>)}</div>
        </div>
        <div className="rule"><span style={{ fontWeight: 600 }}>Plan</span>
          <div className="chips">{plans?.map((p) => <button type="button" key={p.id} className={`chip ${rules.planIds?.includes(p.id) ? 'on' : ''}`} onClick={() => toggleIn('planIds', p.id)}>{p.name}</button>)}</div>
        </div>
        <NumberRule label="Membership expires within" k="expiresWithinDays" rules={rules} setRules={setRules} suffix="days" />
        <NumberRule label="Expired in the last" k="expiredWithinDays" rules={rules} setRules={setRules} suffix="days" />
        <NumberRule label="Joined in the last" k="joinedWithinDays" rules={rules} setRules={setRules} suffix="days" />
        <TriRule label="Personal training" k="hasPersonalTraining" rules={rules} setRules={setRules} yes="PT members" no="No PT" />
        <TriRule label="Class access" k="hasClassAccess" rules={rules} setRules={setRules} yes="Has classes" no="No classes" />
        <div className="section-label">Money</div>
        <NumberRule label="Lifetime value at least" k="lifetimeValueMin" rules={rules} setRules={setRules} prefix="₹" />
        <NumberRule label="Lifetime value at most" k="lifetimeValueMax" rules={rules} setRules={setRules} prefix="₹" />
        <TriRule label="Outstanding dues" k="hasOutstanding" rules={rules} setRules={setRules} yes="Has dues" no="No dues" />
        <div className="section-label">Engagement</div>
        <TriRule label="Referred someone who joined" k="referredSomeone" rules={rules} setRules={setRules} yes="Yes" no="No" />
        <NumberRule label="Not contacted in" k="noContactDays" rules={rules} setRules={setRules} suffix="days" />
        <div className="rule"><span style={{ fontWeight: 600 }}>Inactive (no visits)</span><span className="faint" style={{ fontSize: 12 }}>Available once attendance ships in Phase 3</span></div>
        <div className="section-label">Profile</div>
        <div className="rule"><span style={{ fontWeight: 600 }}>Gender</span>
          <div className="chips">{['female', 'male', 'other'].map((g) => <button type="button" key={g} className={`chip ${rules.genders?.includes(g) ? 'on' : ''}`} onClick={() => toggleIn('genders', g)} style={{ textTransform: 'capitalize' }}>{g}</button>)}</div>
        </div>
        <div className="rule"><span style={{ fontWeight: 600 }}>Source</span>
          <div className="chips">{['Walk-in', 'Instagram', 'Referral', 'Website', 'Google', 'Corporate tie-up'].map((s) => <button type="button" key={s} className={`chip ${rules.sources?.includes(s) ? 'on' : ''}`} onClick={() => toggleIn('sources', s)}>{s}</button>)}</div>
        </div>
        <NumberRule label="Age at least" k="ageMin" rules={rules} setRules={setRules} suffix="years" />
        <NumberRule label="Age at most" k="ageMax" rules={rules} setRules={setRules} suffix="years" />
        <label className="check rule"><input type="checkbox" checked={!!rules.birthdayThisMonth} onChange={(e) => { const r = { ...rules }; if (e.target.checked) r.birthdayThisMonth = true; else delete r.birthdayThisMonth; setRules(r); }} />Birthday this month</label>
        {preview && preview.data.length > 0 && (
          <>
            <div className="section-label">Preview</div>
            <div className="stack" style={{ gap: 4 }}>{preview.data.map((m: any) => (
              <div key={m.id} className="row between"><Person name={m.full_name} detail={`${m.member_code} · ${m.plan_name ?? 'No plan'}`} size="sm" /><StatusBadge status={m.status} /></div>
            ))}</div>
          </>
        )}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------- pages --

export function SegmentsPage() {
  const { can } = useAuth();
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const { data } = useQuery({ queryKey: ['segments'], queryFn: () => api.get<any[]>('/segments') });
  const { data: plans } = useQuery({ queryKey: ['plans'], queryFn: () => api.get<any[]>('/plans') });
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Segments</h1><div className="sub">Reusable member filters for outreach, campaigns and reports. Counts are always live.</div></div>
        <div className="actions">{can('segments.manage') && <Button variant="primary" icon={<Plus />} onClick={() => setEditing(null)}>New segment</Button>}</div>
      </div>
      {!data ? <Skeleton h={300} /> : (
        <div className="grid g-3">
          {data.map((s) => (
            <Link key={s.id} to={`/segments/${s.id}`} className="card segment-card">
              <div className="row between"><b style={{ fontSize: 15 }}>{s.name}</b>{s.is_system && <span className="badge neutral" title="Built-in"><Lock />Built-in</span>}</div>
              <div className="muted" style={{ fontSize: 12.5, minHeight: 36 }}>{s.description ?? describeRules(s.rules, plans)}</div>
              <div className="row between" style={{ alignItems: 'flex-end' }}>
                <div><div className="num" style={{ fontSize: 26, fontWeight: 800 }}>{number(s.member_count)}</div><div className="faint" style={{ fontSize: 12 }}>members</div></div>
                {s.outstanding > 0 && <span className="badge warning">{moneyShort(s.outstanding)} due</span>}
              </div>
              <div className="faint" style={{ fontSize: 11.5 }}><Filter size={11} style={{ verticalAlign: -1 }} /> {describeRules(s.rules, plans)}</div>
            </Link>
          ))}
        </div>
      )}
      {editing !== undefined && <SegmentBuilder segment={editing ?? undefined} onClose={() => setEditing(undefined)} />}
    </div>
  );
}

export function SegmentDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<any | null>(null);
  const { data, error } = useQuery({ queryKey: ['segment', id, page], queryFn: () => api.get<any>(`/segments/${id}/members`, { page, pageSize: 25 }), placeholderData: keepPreviousData });
  const { data: plans } = useQuery({ queryKey: ['plans'], queryFn: () => api.get<any[]>('/plans') });
  useEffect(() => setPage(1), [id]);
  const del = useMutation({
    mutationFn: () => api.delete(`/segments/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['segments'] }); toast('success', 'Segment deleted'); navigate('/segments'); },
    onError: (e) => toast('error', e instanceof ApiError ? e.message : 'Failed'),
  });
  if (error) return <div className="page"><Empty title="Segment not found" /></div>;
  if (!data) return <div className="page"><Skeleton h={400} /></div>;
  const s = data.segment;
  return (
    <div className="page">
      <Link to="/segments" className="btn ghost sm" style={{ alignSelf: 'flex-start' }}><ArrowLeft />Segments</Link>
      <Card glow="soft">
        <div className="row between wrap" style={{ gap: 14 }}>
          <div>
            <div className="row"><h1 style={{ fontSize: 22 }}>{s.name}</h1>{s.is_system && <span className="badge neutral"><Lock />Built-in</span>}</div>
            <div className="muted" style={{ marginTop: 4 }}>{s.description}</div>
            <div className="faint" style={{ fontSize: 12.5, marginTop: 6 }}><Filter size={12} style={{ verticalAlign: -1 }} /> {describeRules(s.rules, plans)}</div>
          </div>
          <div className="row wrap">
            <div style={{ textAlign: 'right', marginRight: 10 }}><div className="num gold-text" style={{ fontSize: 28, fontWeight: 800 }}>{number(data.pagination.total)}</div><div className="faint" style={{ fontSize: 12 }}>members</div></div>
            <Link className="btn" to={`/members?segmentId=${s.id}`}><Users />Open in Members</Link>
            <Button icon={<Download />} onClick={() => downloadCsv(s.id, s.name).catch(() => toast('error', 'Export failed'))}>Export CSV</Button>
            {can('segments.manage') && (s.is_system
              ? <Button icon={<Copy />} onClick={() => setEditing(s)}>Duplicate</Button>
              : <><Button icon={<Pencil />} onClick={() => setEditing(s)}>Edit</Button><Button variant="ghost" icon={<Trash2 />} onClick={() => confirm(`Delete “${s.name}”?`) && del.mutate()} aria-label="Delete" /></>)}
          </div>
        </div>
      </Card>
      <section className="card">
        <div className="table-wrap">
          {!data.data.length ? <Empty title="No members match right now" /> : (
            <table className="tbl">
              <thead><tr><th>Member</th><th>Plan</th><th>Status</th><th>Expiry</th><th className="r">Dues</th><th className="r">Lifetime value</th><th className="hide-sm">Branch</th></tr></thead>
              <tbody>{data.data.map((m: any) => (
                <tr key={m.id} className="clickable" onClick={() => navigate(`/members/${m.id}`)}>
                  <td><Person name={m.full_name} detail={`${m.member_code} · ${m.phone ?? ''}`} /></td>
                  <td>{m.plan_name ?? '—'}</td><td><StatusBadge status={m.status} /></td>
                  <td>{m.end_date ? <><div>{date(m.end_date)}</div><div className="faint" style={{ fontSize: 12 }}>{daysLabel(m.days_remaining)}</div></> : '—'}</td>
                  <td className="r amount" style={{ color: m.outstanding > 0 ? 'var(--warning)' : 'var(--text-3)' }}>{m.outstanding > 0 ? money(m.outstanding) : '—'}</td>
                  <td className="r num">{money(m.lifetime_value)}</td><td className="muted hide-sm">{m.branch_name}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
        {data.pagination.total > 25 && <Pagination {...data.pagination} onPage={setPage} />}
      </section>
      {editing && <SegmentBuilder segment={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
