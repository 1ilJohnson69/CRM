import { useMemo, useState, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime } from '../../lib/format';
import { Button, Dialog, Segmented, Skeleton } from '../../components/ui';
import { AppointmentActions, AppointmentDialog, APPT_LABEL, APPT_STATUS_LABEL, APPT_STATUS_TONE, timeLabel, WEEKDAYS, ymd, type AppointmentPreset } from './common';

const START_H = 6;
const END_H = 22;
const PX = 52; // pixels per hour
type View = 'day' | 'week' | 'month';

function startOfWeek(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000);

/** Assigns overlapping events to side-by-side lanes. */
function layout(events: any[]) {
  const sorted = [...events].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const lanes: number[] = [];
  const placed = sorted.map((e) => {
    const s = Date.parse(e.starts_at);
    let lane = lanes.findIndex((end) => end <= s);
    if (lane < 0) { lane = lanes.length; lanes.push(0); }
    lanes[lane] = Date.parse(e.ends_at);
    return { e, lane };
  });
  return placed.map((p) => ({ ...p, lanes: Math.max(1, lanes.length) }));
}

function topFor(iso: string) {
  const d = new Date(iso);
  return (d.getHours() + d.getMinutes() / 60 - START_H) * PX;
}

function TimeGrid({ columns, onSlot, onOpen }: {
  columns: { key: string; label: string; today?: boolean; date: Date; staffId?: string; events: any[]; busy?: any[] }[];
  onSlot: (date: Date, staffId?: string) => void; onOpen: (a: any) => void;
}) {
  const hours = Array.from({ length: END_H - START_H }, (_, i) => START_H + i);
  const height = (END_H - START_H) * PX;
  const now = new Date();
  const click = (col: (typeof columns)[number]) => (e: MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const y = e.nativeEvent.offsetY;
    const minutes = Math.floor((y / PX) * 4) * 15 + START_H * 60;
    const d = new Date(col.date);
    d.setHours(0, minutes, 0, 0);
    onSlot(d, col.staffId);
  };
  return (
    <div className="cal" style={{ gridTemplateColumns: `52px repeat(${columns.length}, minmax(120px, 1fr))` }}>
      <div className="cal-head" />
      {columns.map((c) => <div key={c.key} className={`cal-head ${c.today ? 'today' : ''}`}>{c.label}</div>)}
      <div className="cal-hours" style={{ height }}>{hours.map((h) => <span key={h} className="cal-hour" style={{ top: (h - START_H) * PX }}>{h === 12 ? '12 pm' : h > 12 ? `${h - 12} pm` : `${h} am`}</span>)}</div>
      {columns.map((c) => (
        <div key={c.key} className="cal-col" style={{ height }} onClick={click(c)} title="Click an empty slot to book">
          {hours.map((h) => <div key={h} className="cal-line" style={{ top: (h - START_H) * PX }} />)}
          {c.today && now.getHours() >= START_H && now.getHours() < END_H && <div className="cal-now" style={{ top: topFor(now.toISOString()) }} />}
          {layout([...c.events.filter((e) => e.status !== 'cancelled'), ...(c.busy ?? []).map((b, i) => ({ ...b, id: `busy${i}`, busy: true }))]).map(({ e, lane, lanes }) => {
            const style = { top: topFor(e.starts_at), height: Math.max(22, ((Date.parse(e.ends_at) - Date.parse(e.starts_at)) / 3600_000) * PX - 2), left: `calc(${(lane / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)` };
            return e.busy ? (
              <div key={e.id} className="cal-ev class" style={style}><b>{e.title}</b><span>Class</span></div>
            ) : (
              <button key={e.id} className={`cal-ev t-${e.type} s-${e.status}`} onClick={() => onOpen(e)} style={style}>
                <b>{timeLabel(e.starts_at)} {e.client_name}</b>
                <span>{APPT_LABEL[e.type]}{c.staffId ? '' : e.staff_name ? ` · ${e.staff_name}` : ''}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function AppointmentDetail({ appt, onClose }: { appt: any; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title={`${APPT_LABEL[appt.type]} · ${appt.client_name}`} sub={`${dateTime(appt.starts_at)} – ${timeLabel(appt.ends_at)}`}>
      <div className="stack">
        <dl className="kv" style={{ gridTemplateColumns: '120px 1fr' }}>
          <dt>Status</dt><dd><span className={`badge ${APPT_STATUS_TONE[appt.status]}`}>{APPT_STATUS_LABEL[appt.status]}</span></dd>
          <dt>{appt.lead_id ? 'Lead' : 'Member'}</dt><dd>{appt.lead_id ? <Link to={`/leads?lead=${appt.lead_id}`} onClick={onClose} style={{ textDecoration: 'underline' }}>{appt.client_name}</Link> : <Link to={`/members/${appt.member_id}`} onClick={onClose} style={{ textDecoration: 'underline' }}>{appt.client_name}</Link>} · {appt.client_phone}</dd>
          <dt>With</dt><dd>{appt.staff_name ?? 'Unassigned'}</dd>
          {appt.package_name && <><dt>Package</dt><dd>{appt.package_name} · {appt.sessions_used}/{appt.sessions_total} used</dd></>}
          {appt.location && <><dt>Location</dt><dd>{appt.location}</dd></>}
          {appt.notes && <><dt>Notes</dt><dd>{appt.notes}</dd></>}
          {appt.outcome_notes && <><dt>Outcome</dt><dd>{appt.outcome_notes}</dd></>}
          {appt.cancel_reason && <><dt>Cancelled</dt><dd>{appt.cancel_reason}</dd></>}
        </dl>
        <AppointmentActions appt={appt} onDone={onClose} />
      </div>
    </Dialog>
  );
}

export function AppointmentsPage() {
  const { can, me } = useAuth();
  const [view, setView] = useState<View>(() => (window.innerWidth < 900 ? 'day' : 'week'));
  const [anchor, setAnchor] = useState(() => new Date());
  const [staffFilter, setStaffFilter] = useState(me?.role_key === 'trainer' || me?.role_key === 'nutritionist' ? 'me' : '');
  const [typeFilter, setTypeFilter] = useState('');
  const [booking, setBooking] = useState<AppointmentPreset | null>(null);
  const [open, setOpen] = useState<any>(null);

  const range = useMemo(() => {
    if (view === 'day') { const d = new Date(anchor); d.setHours(0, 0, 0, 0); return { from: d, to: d }; }
    if (view === 'week') { const s = startOfWeek(anchor); return { from: s, to: addDays(s, 6) }; }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const s = startOfWeek(first);
    return { from: s, to: addDays(s, 41) };
  }, [view, anchor]);
  const params = { from: ymd(range.from), to: ymd(range.to), staffId: staffFilter && staffFilter !== 'me' ? staffFilter : undefined, mine: staffFilter === 'me' || undefined, type: typeFilter || undefined };
  const { data } = useQuery({ queryKey: ['appointments', params], queryFn: () => api.get<any[]>('/appointments', params), placeholderData: keepPreviousData });
  const { data: staff } = useQuery({ queryKey: ['appt-staff'], queryFn: () => api.get<any[]>('/appointments/staff') });
  const { data: classes } = useQuery({
    queryKey: ['class-sessions', params.from, params.to, 'cal'],
    queryFn: () => api.get<any[]>('/classes/sessions', { from: params.from, to: params.to }),
    enabled: view === 'day' && can('classes.read'),
  });

  const step = (dir: number) => setAnchor((a) => (view === 'day' ? addDays(a, dir) : view === 'week' ? addDays(a, 7 * dir) : new Date(a.getFullYear(), a.getMonth() + dir, 1)));
  const todayKey = ymd(new Date());
  const events = (data ?? []).filter((a) => a.status !== 'cancelled');
  const title = view === 'day'
    ? range.from.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })
    : view === 'week' ? `${range.from.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${range.to.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`
      : anchor.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  let body;
  if (!data) body = <Skeleton h={500} />;
  else if (view === 'week') {
    const cols = Array.from({ length: 7 }, (_, i) => {
      const d = addDays(range.from, i);
      return { key: ymd(d), date: d, today: ymd(d) === todayKey, label: `${WEEKDAYS[d.getDay()]} ${d.getDate()}`, events: events.filter((e) => ymd(new Date(e.starts_at)) === ymd(d)) };
    });
    body = <TimeGrid columns={cols} onOpen={setOpen} onSlot={(d) => can('appointments.manage') && setBooking({ startsAt: d, staffId: staffFilter && staffFilter !== 'me' ? staffFilter : staffFilter === 'me' ? me?.id : undefined })} />;
  } else if (view === 'day') {
    // One column per person who has something today (plus filter), so desks can see who's free.
    const people = (staff ?? []).filter((s) => s.is_bookable && (staffFilter ? (staffFilter === 'me' ? s.id === me?.id : s.id === staffFilter) : events.some((e) => e.staff_id === s.id) || s.role_key === 'trainer'));
    const cols = people.map((s) => ({
      key: s.id, staffId: s.id, date: range.from, today: ymd(range.from) === todayKey, label: s.full_name,
      events: events.filter((e) => e.staff_id === s.id),
      busy: (classes ?? []).filter((c) => c.trainer_id === s.id && c.status !== 'cancelled').map((c) => ({ starts_at: c.starts_at, ends_at: c.ends_at, title: c.class_name })),
    }));
    const unassigned = events.filter((e) => !e.staff_id);
    if (unassigned.length) cols.push({ key: 'none', staffId: undefined as any, date: range.from, today: false, label: 'Unassigned', events: unassigned, busy: [] });
    body = <TimeGrid columns={cols} onOpen={setOpen} onSlot={(d, staffId) => can('appointments.manage') && setBooking({ startsAt: d, staffId })} />;
  } else {
    body = (
      <div className="month">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="faint" style={{ fontSize: 11.5, fontWeight: 700, padding: '0 4px' }}>{d}</div>)}
        {Array.from({ length: 42 }, (_, i) => {
          const d = addDays(range.from, i);
          const list = events.filter((e) => ymd(new Date(e.starts_at)) === ymd(d));
          return (
            <button key={i} className={`month-cell ${d.getMonth() !== anchor.getMonth() ? 'other' : ''} ${ymd(d) === todayKey ? 'today' : ''}`} onClick={() => { setAnchor(d); setView('day'); }}>
              <div className="row between"><span className="mc-d">{d.getDate()}</span>{list.length > 0 && <span className="faint num" style={{ fontSize: 11 }}>{list.length}</span>}</div>
              {list.slice(0, 3).map((e) => <span key={e.id} className="mc-e">{timeLabel(e.starts_at)} {e.client_name}</span>)}
              {list.length > 3 && <span className="mc-e faint">+{list.length - 3} more</span>}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="page" style={{ maxWidth: 'none' }}>
      <div className="page-head">
        <div><h1>Appointments</h1><div className="sub">PT sessions, assessments, nutrition consults and trials in one calendar. Click an empty slot to book.</div></div>
        <div className="actions">{can('appointments.manage') && <Button variant="primary" icon={<Plus />} onClick={() => setBooking({})}>Book appointment</Button>}</div>
      </div>
      <div className="row wrap between">
        <div className="row">
          <Button size="sm" icon={<ChevronLeft />} aria-label="Previous" onClick={() => step(-1)} />
          <Button size="sm" onClick={() => setAnchor(new Date())}>Today</Button>
          <Button size="sm" icon={<ChevronRight />} aria-label="Next" onClick={() => step(1)} />
          <b style={{ marginLeft: 6 }}>{title}</b>
        </div>
        <div className="row wrap">
          <select className="select" style={{ width: 190 }} value={staffFilter} onChange={(e) => setStaffFilter(e.target.value)} aria-label="Staff">
            <option value="">Everyone</option><option value="me">My calendar</option>
            {staff?.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
          </select>
          <select className="select" style={{ width: 170 }} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Type">
            <option value="">All types</option>{Object.entries(APPT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <Segmented value={view} onChange={setView} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} />
        </div>
      </div>
      <div className="type-legend">
        {[['pt', 'var(--series-1)'], ['assessment', 'var(--series-2)'], ['trial', 'var(--series-3)'], ['nutrition', 'var(--series-4)'], ['consultation', 'var(--series-5)']].map(([k, c]) => <span key={k}><i style={{ background: c }} />{APPT_LABEL[k]}</span>)}
        <span className="faint">{events.length} in view</span>
      </div>
      {body}
      {booking && <AppointmentDialog preset={booking} onClose={() => setBooking(null)} />}
      {open && <AppointmentDetail appt={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
