import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/ui';
import { date, dateTime, money } from '../../lib/format';
import { Alert, Avatar, Button, Dialog, Empty, Field, Person, Skeleton, Tabs } from '../../components/ui';
import { AppointmentDialog, SellPtDialog, WEEKDAYS, type AppointmentPreset } from './common';

const PKG_TONE: Record<string, [string, string]> = {
  active: ['success', 'Active'], pending: ['accent', 'Payment pending'], exhausted: ['neutral', 'All used'], expired: ['danger', 'Expired'], cancelled: ['neutral', 'Cancelled'],
};
export const PkgBadge = ({ status }: { status: string }) => <span className={`badge ${PKG_TONE[status]?.[0] ?? 'neutral'}`}>{PKG_TONE[status]?.[1] ?? status}</span>;

export function PackageProgress({ used, booked, total }: { used: number; booked: number; total: number }) {
  return (
    <div className="pkg-progress" title={`${used} used · ${booked} booked · ${total - used - booked} left to book`}>
      {Array.from({ length: Math.min(total, 36) }, (_, i) => <i key={i} className={i < used ? 'used' : i < used + booked ? 'booked' : ''} />)}
    </div>
  );
}

function Clients() {
  const { can, me } = useAuth();
  const [status, setStatus] = useState('active');
  const [mine, setMine] = useState(me?.role_key === 'trainer');
  const [book, setBook] = useState<AppointmentPreset | null>(null);
  const { data } = useQuery({ queryKey: ['pt-clients', status, mine], queryFn: () => api.get<any[]>('/pt/member-packages', { status, trainerId: mine ? 'me' : undefined }) });
  return (
    <section className="card">
      <div className="toolbar">
        <div className="chips">{['active', 'pending', 'exhausted', 'expired', 'all'].map((s) => <button key={s} className={`chip ${status === s ? 'on' : ''}`} onClick={() => setStatus(s)}>{s === 'all' ? 'All' : PKG_TONE[s][1]}</button>)}</div>
        <div style={{ flex: 1 }} />
        <button className={`chip ${mine ? 'on' : ''}`} onClick={() => setMine(!mine)}>My clients</button>
      </div>
      <div className="table-wrap">
        {!data ? <div style={{ padding: 20 }}><Skeleton h={300} /></div> : !data.length ? <Empty title="No PT clients here" /> : (
          <table className="tbl">
            <thead><tr><th>Member</th><th>Package</th><th style={{ width: 200 }}>Sessions</th><th>Trainer</th><th>Next session</th><th>Expires</th><th>Status</th>{can('appointments.manage') && <th />}</tr></thead>
            <tbody>{data.map((p) => (
              <tr key={p.id}>
                <td><Link to={`/members/${p.member_id}`}><Person name={p.member_name} detail={p.member_code} size="sm" /></Link></td>
                <td>{p.package_name}</td>
                <td><PackageProgress used={p.sessions_used} booked={p.sessions_booked} total={p.sessions_total} /><div className="faint num" style={{ fontSize: 11.5, marginTop: 3 }}>{p.sessions_used}/{p.sessions_total} used · {p.sessions_booked} booked</div></td>
                <td className="muted">{p.trainer_name ?? '—'}</td>
                <td className="muted">{p.next_session_at ? dateTime(p.next_session_at) : p.effective_status === 'active' ? <span style={{ color: 'var(--warning)' }}>Not booked</span> : '—'}</td>
                <td className="muted">{date(p.expires_on)}</td>
                <td><PkgBadge status={p.effective_status} /></td>
                {can('appointments.manage') && <td>{p.effective_status === 'active' && p.sessions_remaining - p.sessions_booked > 0 && (
                  <Button size="sm" icon={<CalendarPlus />} onClick={() => setBook({ type: 'pt', memberId: p.member_id, memberName: p.member_name, memberPtPackageId: p.id, staffId: p.trainer_id ?? undefined })}>Book</Button>
                )}</td>}
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {book && <AppointmentDialog preset={book} onClose={() => setBook(null)} />}
    </section>
  );
}

function PackageDialog({ pkg, onClose }: { pkg?: any; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: pkg?.name ?? '', description: pkg?.description ?? '', sessions: pkg?.sessions ?? 12, validityDays: pkg?.validity_days ?? 60, price: pkg?.price ?? 0, taxRate: pkg?.tax_rate ?? 18, status: pkg?.status ?? 'active' });
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: () => (pkg ? api.put(`/pt/packages/${pkg.id}`, f) : api.post('/pt/packages', f)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pt-catalog'] }); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Failed'),
  });
  return (
    <Dialog open onClose={onClose} title={pkg ? `Edit ${pkg.name}` : 'New PT package'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <div className="form-grid">
          <Field label="Name" className="full"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Sessions"><input className="input num" type="number" value={f.sessions} onChange={(e) => setF({ ...f, sessions: Number(e.target.value) })} /></Field>
          <Field label="Valid for (days)"><input className="input num" type="number" value={f.validityDays} onChange={(e) => setF({ ...f, validityDays: Number(e.target.value) })} /></Field>
          <Field label="Price (before tax)"><div className="input-prefix"><span>₹</span><input className="input num" type="number" value={f.price} onChange={(e) => setF({ ...f, price: Number(e.target.value) })} /></div></Field>
          <Field label="GST %"><input className="input num" type="number" value={f.taxRate} onChange={(e) => setF({ ...f, taxRate: Number(e.target.value) })} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={f.status === 'archived'} onChange={(e) => setF({ ...f, status: e.target.checked ? 'archived' : 'active' })} />Archived</label>
      </div>
    </Dialog>
  );
}

function Catalog() {
  const { can } = useAuth();
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const { data } = useQuery({ queryKey: ['pt-catalog'], queryFn: () => api.get<any[]>('/pt/packages') });
  return (
    <>
      {can('pt.manage') && <div><Button icon={<Plus />} onClick={() => setEditing(null)}>New package</Button></div>}
      <div className="grid g-4">{data?.map((p) => (
        <section key={p.id} className="card card-pad stack" style={{ gap: 6, opacity: p.status === 'active' ? 1 : 0.5 }}>
          <div className="row between"><b>{p.name}</b>{can('pt.manage') && <Button size="sm" variant="ghost" icon={<Pencil />} aria-label="Edit" onClick={() => setEditing(p)} />}</div>
          <div className="num" style={{ fontSize: 24, fontWeight: 800 }}>{money(p.price)}</div>
          <div className="muted" style={{ fontSize: 12.5 }}>{p.sessions} sessions · {money(p.price / p.sessions)}/session · valid {p.validity_days} days</div>
          <div className="faint" style={{ fontSize: 12 }}>{p.active_clients} active clients</div>
        </section>
      ))}</div>
      {editing !== undefined && <PackageDialog pkg={editing ?? undefined} onClose={() => setEditing(undefined)} />}
    </>
  );
}

function AvailabilityDialog({ trainer, onClose }: { trainer: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const [specialties, setSpecialties] = useState((trainer.specialties ?? []).join(', '));
  const [bio, setBio] = useState(trainer.bio ?? '');
  const [rows, setRows] = useState<{ branchId: string; weekday: number; start: string; end: string }[]>(
    trainer.availability.map((a: any) => ({ branchId: a.branch_id, weekday: a.weekday, start: a.start, end: a.end })),
  );
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: () => api.put(`/pt/trainers/${trainer.id}`, { specialties: specialties.split(',').map((s: string) => s.trim()).filter(Boolean), bio: bio || null, isBookable: true, availability: rows }),
    onSuccess: () => { qc.invalidateQueries(); toast('success', 'Profile saved'); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.details && Array.isArray(e.details) ? (e.details as any)[0].message : e.message : 'Failed'),
  });
  const branch = me?.branches[0]?.id ?? '';
  return (
    <Dialog open variant="drawer" onClose={onClose} title={trainer.full_name} sub="Specialties and weekly working hours. Appointments outside these hours ask for confirmation."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <Field label="Specialties" hint="Comma separated"><input className="input" value={specialties} onChange={(e) => setSpecialties(e.target.value)} /></Field>
        <Field label="Bio"><textarea className="textarea" value={bio} onChange={(e) => setBio(e.target.value)} /></Field>
        <div className="section-label">Weekly hours</div>
        {rows.map((r, i) => (
          <div key={i} className="row" style={{ gap: 6 }}>
            <select className="select" style={{ width: 90 }} value={r.weekday} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, weekday: Number(e.target.value) } : x)))}>{WEEKDAYS.map((d, k) => <option key={k} value={k}>{d}</option>)}</select>
            <input className="input" type="time" step={900} value={r.start} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} />
            <span className="faint">–</span>
            <input className="input" type="time" step={900} value={r.end} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} />
            <select className="select" style={{ width: 150 }} value={r.branchId} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, branchId: e.target.value } : x)))}>{me?.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
            <Button size="sm" variant="ghost" icon={<Trash2 />} aria-label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))} />
          </div>
        ))}
        <div><Button size="sm" icon={<Plus />} onClick={() => setRows([...rows, { branchId: rows.at(-1)?.branchId ?? branch, weekday: ((rows.at(-1)?.weekday ?? 0) + 1) % 7, start: '06:00', end: '12:00' }])}>Add hours</Button></div>
      </div>
    </Dialog>
  );
}

function Trainers() {
  const { can } = useAuth();
  const [editing, setEditing] = useState<any>(null);
  const { data } = useQuery({ queryKey: ['pt-trainers'], queryFn: () => api.get<any[]>('/pt/trainers') });
  if (!data) return <Skeleton h={240} />;
  return (
    <>
      <div className="grid g-3">{data.map((t) => (
        <section key={t.id} className="card card-pad stack" style={{ gap: 10 }}>
          <div className="row between">
            <span className="person"><Avatar name={t.full_name} /><span><span className="n" style={{ display: 'block' }}>{t.full_name}</span><span className="d">{t.role_name}</span></span></span>
            {can('pt.manage') && <Button size="sm" variant="ghost" icon={<Pencil />} aria-label="Edit profile" onClick={() => setEditing(t)} />}
          </div>
          <div className="chips">{(t.specialties ?? []).map((s: string) => <span key={s} className="badge neutral">{s}</span>)}</div>
          <div className="stat-strip">
            <div><div className="k">Clients</div><div className="v">{t.active_clients}</div></div>
            <div><div className="k">Month</div><div className="v">{t.sessions_month}</div></div>
            <div><div className="k">Next 7d</div><div className="v">{t.upcoming_week}</div></div>
          </div>
          <div className="avail-grid">
            <span />{WEEKDAYS.map((d) => <span key={d} className="faint" style={{ textAlign: 'center' }}>{d[0]}</span>)}
            <span className="faint">Hours</span>
            {WEEKDAYS.map((_, i) => {
              const h = t.availability.filter((a: any) => a.weekday === i).reduce((s: number, a: any) => s + (Number(a.end.slice(0, 2)) - Number(a.start.slice(0, 2))), 0);
              return <span key={i} title={t.availability.filter((a: any) => a.weekday === i).map((a: any) => `${a.start}–${a.end}`).join(', ') || 'Off'} style={{ height: 18, borderRadius: 4, background: h ? `color-mix(in srgb, var(--gold-2) ${Math.min(100, 20 + h * 7)}%, var(--surface-2))` : 'var(--surface-2)' }} />;
            })}
          </div>
          <div className="faint" style={{ fontSize: 12 }}>{Math.round(t.weekly_hours)} h/week · {t.classes_month} classes taught this month{t.no_shows_month ? ` · ${t.no_shows_month} no-shows` : ''}</div>
        </section>
      ))}</div>
      {editing && <AvailabilityDialog trainer={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

export function PtPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as 'clients' | 'catalog' | 'trainers') ?? 'clients';
  const [selling, setSelling] = useState(false);
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Personal training</h1><div className="sub">Packages, session balances and trainer schedules. Sessions are used when an appointment is completed.</div></div>
        <div className="actions">{can('pt.sell') && <Button variant="primary" icon={<Plus />} onClick={() => setSelling(true)}>Sell PT package</Button>}</div>
      </div>
      <Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[{ key: 'clients', label: 'Clients' }, { key: 'catalog', label: 'Packages' }, { key: 'trainers', label: 'Trainers' }]} />
      {tab === 'clients' && <Clients />}
      {tab === 'catalog' && <Catalog />}
      {tab === 'trainers' && <Trainers />}
      {selling && <SellPtDialog onClose={() => setSelling(false)} />}
    </div>
  );
}
