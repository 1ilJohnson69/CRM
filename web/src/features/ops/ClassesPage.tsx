import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Check, ChevronLeft, ChevronRight, Clock, Pencil, Plus, UserMinus, UserPlus, Users, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/ui';
import { Alert, Button, Dialog, Empty, Field, Person, Skeleton, Tabs } from '../../components/ui';
import { MemberPicker, type MemberPick } from '../shared';
import { timeLabel, WEEKDAYS, ymd } from './common';

const BOOKING_LABEL: Record<string, { label: string; tone: string }> = {
  booked: { label: 'Booked', tone: 'accent' }, waitlisted: { label: 'Waitlist', tone: 'warning' }, attended: { label: 'Attended', tone: 'success' },
  no_show: { label: 'No-show', tone: 'danger' }, cancelled: { label: 'Cancelled', tone: 'neutral' },
};
export const BookingBadge = ({ status }: { status: string }) => <span className={`badge ${BOOKING_LABEL[status]?.tone ?? 'neutral'}`}>{BOOKING_LABEL[status]?.label ?? status}</span>;

function startOfWeek(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

export function CapacityBar({ booked, capacity }: { booked: number; capacity: number }) {
  const pct = Math.min(100, (booked / Math.max(1, capacity)) * 100);
  return <div className="bar-track" style={{ height: 4 }}><div style={{ width: `${pct}%`, background: pct >= 100 ? 'var(--warning)' : undefined }} /></div>;
}

// ------------------------------------------------------------ session drawer --

export function SessionDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [adding, setAdding] = useState<MemberPick | null>(null);
  const [notEligible, setNotEligible] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const { data: s } = useQuery({ queryKey: ['class-session', id], queryFn: () => api.get<any>(`/classes/sessions/${id}`) });
  const refresh = () => qc.invalidateQueries();
  const err = (e: unknown) => toast('error', e instanceof ApiError ? e.message : 'Failed');
  const book = useMutation({
    mutationFn: (v: { memberId: string; override?: boolean }) => api.post<any>(`/classes/sessions/${id}/bookings`, v),
    onSuccess: (r) => { refresh(); setAdding(null); setNotEligible(null); toast('success', r.booking.status === 'waitlisted' ? 'Class is full — added to waitlist' : 'Booked'); },
    onError: (e) => (e instanceof ApiError && e.code === 'not_eligible' ? setNotEligible(e.message) : err(e)),
  });
  const mark = useMutation({ mutationFn: (v: { id: string; status: string }) => api.post(`/classes/bookings/${v.id}/attendance`, { status: v.status }), onSuccess: refresh, onError: err });
  const cancelBooking = useMutation({
    mutationFn: (bid: string) => api.post<any>(`/classes/bookings/${bid}/cancel`),
    onSuccess: (r) => { refresh(); toast('success', r.promoted ? 'Cancelled · next on waitlist moved up' : 'Booking cancelled'); },
    onError: err,
  });
  const cancelClass = useMutation({
    mutationFn: () => api.post<any>(`/classes/sessions/${id}/cancel`, { reason }),
    onSuccess: (r) => { refresh(); setCancelling(false); toast('success', `Class cancelled · ${r.notified} members notified`); },
    onError: err,
  });
  const active = s?.roster.filter((r: any) => r.status !== 'cancelled' && r.status !== 'waitlisted') ?? [];
  const waitlist = s?.roster.filter((r: any) => r.status === 'waitlisted') ?? [];
  const canMark = s && new Date(s.starts_at).getTime() < Date.now() + 30 * 60_000 && s.status !== 'cancelled';
  return (
    <Dialog open variant="drawer" wide onClose={onClose} title={s?.class_name ?? 'Class'}
      sub={s ? `${new Date(s.starts_at).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' })} · ${timeLabel(s.starts_at)}–${timeLabel(s.ends_at)} · ${s.trainer_name ?? 'No trainer'} · ${s.location ?? s.branch_name}` : undefined}
      footer={s && s.status === 'scheduled' && can('classes.manage') && <Button variant="ghost" icon={<Ban />} onClick={() => setCancelling(true)}>Cancel class</Button>}>
      {!s ? <Skeleton h={300} /> : (
        <div className="stack">
          {s.status === 'cancelled' && <div className="alert">Cancelled — {s.cancel_reason}</div>}
          <div className="stat-strip">
            <div><div className="k">Booked</div><div className="v">{s.booked}/{s.capacity}</div></div>
            <div><div className="k">Waitlist</div><div className="v">{s.waitlisted}</div></div>
            <div><div className="k">Attended</div><div className="v">{s.attended}</div></div>
          </div>
          {s.status === 'scheduled' && can('classes.book') && new Date(s.starts_at).getTime() > Date.now() - 15 * 60_000 && (
            <div className="stack" style={{ gap: 8 }}>
              <Field label="Add a member"><MemberPicker value={adding} onChange={(m) => { setAdding(m); setNotEligible(null); }} /></Field>
              {notEligible && <Alert tone="warning">{notEligible}{can('classes.manage') ? ' — you can override as a manager.' : ''}</Alert>}
              {adding && (
                <div className="row">
                  <Button variant="primary" icon={<UserPlus />} loading={book.isPending} onClick={() => book.mutate({ memberId: adding.id })}>{s.booked >= s.capacity ? 'Add to waitlist' : 'Book'}</Button>
                  {notEligible && can('classes.manage') && <Button onClick={() => book.mutate({ memberId: adding.id, override: true })}>Book anyway</Button>}
                </div>
              )}
            </div>
          )}
          <div className="section-label">Roster · {active.length}</div>
          {!active.length ? <div className="faint">No one booked yet.</div> : (
            <div className="stack" style={{ gap: 6 }}>{active.map((r: any) => (
              <div key={r.id} className="fu-row">
                <div style={{ flex: 1, minWidth: 0 }}><Link to={`/members/${r.member_id}`}><Person name={r.full_name} detail={`${r.member_code} · ${r.source === 'app' ? 'booked in app' : 'booked at desk'}`} size="sm" /></Link></div>
                <BookingBadge status={r.status} />
                {canMark && can('classes.book') && (
                  <div className="row" style={{ gap: 4 }}>
                    <Button size="sm" variant={r.status === 'attended' ? 'primary' : undefined} icon={<Check />} aria-label="Attended" title="Attended" onClick={() => mark.mutate({ id: r.id, status: r.status === 'attended' ? 'booked' : 'attended' })} />
                    <Button size="sm" variant={r.status === 'no_show' ? 'danger' : 'ghost'} icon={<X />} aria-label="No-show" title="No-show" onClick={() => mark.mutate({ id: r.id, status: r.status === 'no_show' ? 'booked' : 'no_show' })} />
                  </div>
                )}
                {r.status === 'booked' && !canMark && can('classes.book') && <Button size="sm" variant="ghost" icon={<UserMinus />} aria-label="Cancel booking" title="Cancel booking" onClick={() => cancelBooking.mutate(r.id)} />}
              </div>
            ))}</div>
          )}
          {waitlist.length > 0 && (
            <>
              <div className="section-label">Waitlist · {waitlist.length}</div>
              <div className="stack" style={{ gap: 6 }}>{waitlist.map((r: any) => (
                <div key={r.id} className="fu-row">
                  <span className="fu-ic num">{r.position}</span>
                  <div style={{ flex: 1 }}><Person name={r.full_name} detail={r.member_code} size="sm" /></div>
                  {can('classes.book') && <Button size="sm" variant="ghost" icon={<UserMinus />} aria-label="Remove" onClick={() => cancelBooking.mutate(r.id)} />}
                </div>
              ))}</div>
            </>
          )}
        </div>
      )}
      {cancelling && (
        <Dialog open onClose={() => setCancelling(false)} title="Cancel this class?" sub="Everyone booked or waitlisted is notified in the app."
          footer={<><Button onClick={() => setCancelling(false)}>Back</Button><Button variant="danger" disabled={reason.trim().length < 3} loading={cancelClass.isPending} onClick={() => cancelClass.mutate()}>Cancel class</Button></>}>
          <Field label="Reason"><input className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Trainer unwell" /></Field>
        </Dialog>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------- book dialog --

/** Pick a class for a known member (front desk / profile). */
export function BookClassDialog({ memberId, memberName, onClose }: { memberId: string; memberName: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [error, setError] = useState<{ id: string; msg: string } | null>(null);
  const from = ymd(new Date());
  const to = ymd(new Date(Date.now() + 3 * 86400_000));
  const { data } = useQuery({ queryKey: ['class-sessions', from, to], queryFn: () => api.get<any[]>('/classes/sessions', { from, to }) });
  const upcoming = (data ?? []).filter((s) => s.status === 'scheduled' && new Date(s.starts_at).getTime() > Date.now() - 10 * 60_000);
  const book = useMutation({
    mutationFn: (v: { sessionId: string; override?: boolean }) => api.post<any>(`/classes/sessions/${v.sessionId}/bookings`, { memberId, override: v.override }),
    onSuccess: (r) => { qc.invalidateQueries(); toast('success', r.booking.status === 'waitlisted' ? `${memberName} added to the waitlist` : `${memberName} booked`); onClose(); },
    onError: (e, v) => setError({ id: v.sessionId, msg: e instanceof ApiError ? e.message : 'Failed' }),
  });
  let lastDay = '';
  return (
    <Dialog open onClose={onClose} title={`Book a class for ${memberName}`} sub="Next 3 days at this branch">
      {!data ? <Skeleton h={200} /> : !upcoming.length ? <Empty title="No upcoming classes" /> : (
        <div className="stack" style={{ gap: 6 }}>
          {upcoming.map((s) => {
            const day = new Date(s.starts_at).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' });
            const header = day !== lastDay ? (lastDay = day) : null;
            return (
              <div key={s.id}>
                {header && <div className="section-label" style={{ padding: '8px 0 4px' }}>{header}</div>}
                <div className="fu-row">
                  <span className="num" style={{ width: 64, fontWeight: 700 }}>{timeLabel(s.starts_at)}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <b>{s.class_name}</b> <span className="faint">· {s.trainer_name ?? '—'}</span>
                    <div style={{ marginTop: 4 }}><CapacityBar booked={s.booked} capacity={s.capacity} /></div>
                    {error?.id === s.id && <div className="err" style={{ color: 'var(--danger)', fontSize: 12, marginTop: 4 }}>{error?.msg}</div>}
                  </div>
                  <span className="faint num" style={{ fontSize: 12 }}>{s.booked}/{s.capacity}</span>
                  <Button size="sm" variant="primary" loading={book.isPending && book.variables?.sessionId === s.id} onClick={() => { setError(null); book.mutate({ sessionId: s.id }); }}>{s.booked >= s.capacity ? 'Waitlist' : 'Book'}</Button>
                  {error?.id === s.id && can('classes.manage') && <Button size="sm" onClick={() => book.mutate({ sessionId: s.id, override: true })}>Override</Button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- timetable --

function Timetable({ onOpen }: { onOpen: (id: string) => void }) {
  const [week, setWeek] = useState(() => startOfWeek(new Date()));
  const [trainer, setTrainer] = useState('');
  const days = Array.from({ length: 7 }, (_, i) => new Date(week.getTime() + i * 86400_000));
  const from = ymd(days[0]);
  const to = ymd(days[6]);
  const { data } = useQuery({ queryKey: ['class-sessions', from, to, trainer], queryFn: () => api.get<any[]>('/classes/sessions', { from, to, trainerId: trainer || undefined }), placeholderData: keepPreviousData });
  const { data: staff } = useQuery({ queryKey: ['appt-staff'], queryFn: () => api.get<any[]>('/appointments/staff') });
  const todayKey = ymd(new Date());
  const byDay = useMemo(() => {
    const m: Record<string, any[]> = {};
    for (const s of data ?? []) (m[ymd(new Date(s.starts_at))] ??= []).push(s);
    return m;
  }, [data]);
  const stats = useMemo(() => {
    const list = (data ?? []).filter((s) => s.status !== 'cancelled');
    const cap = list.reduce((a, s) => a + s.capacity, 0);
    const booked = list.reduce((a, s) => a + s.booked, 0);
    return { classes: list.length, fill: cap ? Math.round((booked / cap) * 100) : 0, waitlisted: list.reduce((a, s) => a + s.waitlisted, 0) };
  }, [data]);
  return (
    <div className="stack">
      <div className="row wrap between">
        <div className="row">
          <Button size="sm" icon={<ChevronLeft />} aria-label="Previous week" onClick={() => setWeek(new Date(week.getTime() - 7 * 86400_000))} />
          <Button size="sm" onClick={() => setWeek(startOfWeek(new Date()))}>This week</Button>
          <Button size="sm" icon={<ChevronRight />} aria-label="Next week" onClick={() => setWeek(new Date(week.getTime() + 7 * 86400_000))} />
          <b style={{ marginLeft: 6 }}>{days[0].toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – {days[6].toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</b>
        </div>
        <div className="row">
          <span className="muted" style={{ fontSize: 12.5 }}>{stats.classes} classes · {stats.fill}% full · {stats.waitlisted} waitlisted</span>
          <select className="select" style={{ width: 180 }} value={trainer} onChange={(e) => setTrainer(e.target.value)} aria-label="Trainer">
            <option value="">All trainers</option>{staff?.filter((s) => s.role_key === 'trainer').map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
          </select>
        </div>
      </div>
      <div className="week-grid">
        {days.map((d) => {
          const key = ymd(d);
          return (
            <section key={key} className={`week-col ${key === todayKey ? 'today' : ''}`}>
              <header><b>{WEEKDAYS[d.getDay()]}</b><span className="faint">{d.getDate()}</span></header>
              <div className="week-list">
                {!data ? <Skeleton h={80} /> : (byDay[key] ?? []).map((s) => (
                  <button key={s.id} className={`class-chip ${s.status}`} onClick={() => onOpen(s.id)}>
                    <div className="row between"><span className="num" style={{ fontWeight: 800, fontSize: 12 }}>{timeLabel(s.starts_at)}</span>{s.waitlisted > 0 && <span className="badge warning" style={{ height: 18 }}>+{s.waitlisted}</span>}</div>
                    <div className="cc-name">{s.class_name}</div>
                    <div className="cc-meta">{s.trainer_name ?? '—'}</div>
                    <div className="row between" style={{ marginTop: 6, gap: 6 }}>
                      <div style={{ flex: 1 }}><CapacityBar booked={s.booked} capacity={s.capacity} /></div>
                      <span className="num faint" style={{ fontSize: 11 }}>{s.booked}/{s.capacity}</span>
                    </div>
                  </button>
                ))}
                {data && !(byDay[key] ?? []).length && <div className="board-empty">No classes</div>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

// --------------------------------------------------------------- schedules --

function ScheduleDialog({ schedule, onClose }: { schedule?: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me, branch } = useAuth();
  const { data: types } = useQuery({ queryKey: ['class-types'], queryFn: () => api.get<any[]>('/classes/types') });
  const { data: staff } = useQuery({ queryKey: ['appt-staff'], queryFn: () => api.get<any[]>('/appointments/staff') });
  const [f, setF] = useState(() => ({
    branchId: schedule?.branch_id ?? (branch !== 'all' ? branch : me?.branches[0]?.id ?? ''), classTypeId: schedule?.class_type_id ?? '', trainerId: schedule?.trainer_id ?? '',
    weekdays: (schedule?.weekdays ?? [1, 3, 5]) as number[], startTime: schedule?.start_hhmm ?? '07:00', durationMin: schedule?.duration_min ?? 60,
    capacity: schedule?.capacity ?? 20, location: schedule?.location ?? '', endsOn: schedule?.ends_on ?? '', isActive: schedule?.is_active ?? true,
  }));
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, trainerId: f.trainerId || null, location: f.location || null, endsOn: f.endsOn || null };
      return schedule ? api.put(`/classes/schedules/${schedule.id}`, body) : api.post('/classes/schedules', body);
    },
    onSuccess: () => { qc.invalidateQueries(); toast('success', 'Schedule saved · sessions generated for the next 3 weeks'); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Failed'),
  });
  return (
    <Dialog open variant="drawer" onClose={onClose} title={schedule ? 'Edit schedule' : 'New recurring class'} sub={schedule ? 'Future sessions without bookings are re-planned; booked ones are kept.' : 'Sessions are created automatically three weeks ahead.'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.classTypeId || !f.weekdays.length} loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <div className="form-grid">
          <Field label="Class"><select className="select" value={f.classTypeId} onChange={(e) => {
            const t = types?.find((x) => x.id === e.target.value);
            setF({ ...f, classTypeId: e.target.value, durationMin: t?.default_duration_min ?? f.durationMin, capacity: t?.default_capacity ?? f.capacity });
          }}><option value="">Select</option>{types?.filter((t) => t.is_active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
          <Field label="Branch"><select className="select" value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}>{me?.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
          <Field label="Days" className="full">
            <div className="chips">{[1, 2, 3, 4, 5, 6, 0].map((d) => (
              <button type="button" key={d} className={`chip ${f.weekdays.includes(d) ? 'on' : ''}`} onClick={() => setF({ ...f, weekdays: f.weekdays.includes(d) ? f.weekdays.filter((x) => x !== d) : [...f.weekdays, d] })}>{WEEKDAYS[d]}</button>
            ))}</div>
          </Field>
          <Field label="Start time"><input className="input" type="time" step={900} value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} /></Field>
          <Field label="Duration (min)"><input className="input num" type="number" value={f.durationMin} onChange={(e) => setF({ ...f, durationMin: Number(e.target.value) })} /></Field>
          <Field label="Capacity"><input className="input num" type="number" value={f.capacity} onChange={(e) => setF({ ...f, capacity: Number(e.target.value) })} /></Field>
          <Field label="Trainer"><select className="select" value={f.trainerId} onChange={(e) => setF({ ...f, trainerId: e.target.value })}>
            <option value="">—</option>{staff?.filter((s) => s.role_key === 'trainer').map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
          </select></Field>
          <Field label="Room"><input className="input" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="Studio A" /></Field>
          <Field label="Ends on" hint="Optional"><input className="input" type="date" value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} /></Field>
        </div>
        {schedule && <label className="check"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />Active</label>}
      </div>
    </Dialog>
  );
}

function Schedules() {
  const { can } = useAuth();
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const { data } = useQuery({ queryKey: ['class-schedules'], queryFn: () => api.get<any[]>('/classes/schedules') });
  return (
    <section className="card">
      <div className="toolbar"><span className="muted">Recurring timetable. Changes apply to future, unbooked sessions.</span><div style={{ flex: 1 }} />{can('classes.manage') && <Button variant="primary" icon={<Plus />} onClick={() => setEditing(null)}>New schedule</Button>}</div>
      <div className="table-wrap">
        {!data ? <div style={{ padding: 20 }}><Skeleton h={240} /></div> : !data.length ? <Empty title="No schedules yet" /> : (
          <table className="tbl">
            <thead><tr><th>Class</th><th>Days</th><th>Time</th><th>Trainer</th><th className="r">Capacity</th><th className="hide-sm">Branch</th><th>Status</th>{can('classes.manage') && <th />}</tr></thead>
            <tbody>{data.map((s) => (
              <tr key={s.id} style={{ opacity: s.is_active ? 1 : 0.5 }}>
                <td style={{ fontWeight: 700 }}>{s.class_name}</td>
                <td><div className="chips">{[1, 2, 3, 4, 5, 6, 0].filter((d) => s.weekdays.includes(d)).map((d) => <span key={d} className="badge neutral">{WEEKDAYS[d]}</span>)}</div></td>
                <td className="num">{s.start_hhmm} · {s.duration_min}m</td>
                <td className="muted">{s.trainer_name ?? '—'}</td>
                <td className="r num">{s.capacity}</td>
                <td className="muted hide-sm">{s.branch_name}</td>
                <td>{s.is_active ? <span className="badge success">Active</span> : <span className="badge neutral">Paused</span>}</td>
                {can('classes.manage') && <td><Button size="sm" variant="ghost" icon={<Pencil />} aria-label="Edit" onClick={() => setEditing(s)} /></td>}
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {editing !== undefined && <ScheduleDialog schedule={editing ?? undefined} onClose={() => setEditing(undefined)} />}
    </section>
  );
}

function TypeDialog({ type, onClose }: { type?: any; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: type?.name ?? '', description: type?.description ?? '', category: type?.category ?? '', defaultDurationMin: type?.default_duration_min ?? 60, defaultCapacity: type?.default_capacity ?? 20, requiresClassAccess: type?.requires_class_access ?? true, isActive: type?.is_active ?? true });
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: () => (type ? api.put(`/classes/types/${type.id}`, f) : api.post('/classes/types', f)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['class-types'] }); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Failed'),
  });
  return (
    <Dialog open onClose={onClose} title={type ? `Edit ${type.name}` : 'New class type'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <div className="form-grid">
          <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Category"><input className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="Cardio, Strength…" /></Field>
          <Field label="Default duration (min)"><input className="input num" type="number" value={f.defaultDurationMin} onChange={(e) => setF({ ...f, defaultDurationMin: Number(e.target.value) })} /></Field>
          <Field label="Default capacity"><input className="input num" type="number" value={f.defaultCapacity} onChange={(e) => setF({ ...f, defaultCapacity: Number(e.target.value) })} /></Field>
          <Field label="Description" className="full"><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={f.requiresClassAccess} onChange={(e) => setF({ ...f, requiresClassAccess: e.target.checked })} />Only members whose plan includes classes can book</label>
        <label className="check"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />Active</label>
      </div>
    </Dialog>
  );
}

function Types() {
  const { can } = useAuth();
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const { data } = useQuery({ queryKey: ['class-types'], queryFn: () => api.get<any[]>('/classes/types') });
  return (
    <>
      {can('classes.manage') && <div><Button icon={<Plus />} onClick={() => setEditing(null)}>New class type</Button></div>}
      <div className="grid g-3">{data?.map((t) => (
        <section key={t.id} className="card card-pad stack" style={{ gap: 6, opacity: t.is_active ? 1 : 0.5 }}>
          <div className="row between"><b>{t.name}</b>{can('classes.manage') && <Button size="sm" variant="ghost" icon={<Pencil />} aria-label="Edit" onClick={() => setEditing(t)} />}</div>
          <div className="muted" style={{ fontSize: 13 }}>{t.description}</div>
          <div className="row wrap faint" style={{ fontSize: 12 }}><span><Clock size={12} style={{ verticalAlign: -1 }} /> {t.default_duration_min} min</span><span><Users size={12} style={{ verticalAlign: -1 }} /> {t.default_capacity}</span>{t.category && <span>{t.category}</span>}{!t.requires_class_access && <span className="badge neutral">Open to all members</span>}</div>
        </section>
      ))}</div>
      {editing !== undefined && <TypeDialog type={editing ?? undefined} onClose={() => setEditing(undefined)} />}
    </>
  );
}

export function ClassesPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as 'timetable' | 'schedules' | 'types') ?? 'timetable';
  const open = params.get('session');
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
    setParams(next);
  };
  return (
    <div className="page" style={{ maxWidth: 'none' }}>
      <div className="page-head"><div><h1>Classes</h1><div className="sub">Group class timetable, bookings, waitlists and attendance. Members book from the app under the same rules.</div></div></div>
      <Tabs value={tab} onChange={(t) => set({ tab: t })} tabs={[{ key: 'timetable', label: 'Timetable' }, { key: 'schedules', label: 'Schedules' }, { key: 'types', label: 'Class types' }]} />
      {tab === 'timetable' && <Timetable onOpen={(id) => set({ session: id })} />}
      {tab === 'schedules' && <Schedules />}
      {tab === 'types' && <Types />}
      {open && <SessionDrawer id={open} onClose={() => set({ session: null })} />}
    </div>
  );
}

