import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarDays, Check, CircleSlash, IndianRupee, MapPin, Megaphone, Pencil, Plus, Trophy, UserPlus, Users, X } from 'lucide-react';
import { api, ApiError, branchScope, type Paged } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/ui';
import { dateTime, money } from '../../lib/format';
import { Alert, Button, Card, Dialog, Empty, Field, Pagination, Person, Skeleton, Tabs } from '../../components/ui';
import { MemberPicker, MethodPicker, referenceLabel, referenceRequired, type MemberPick } from '../shared';

export const EVENT_TYPE: Record<string, string> = { workshop: 'Workshop', competition: 'Competition', seminar: 'Seminar', challenge: 'Fitness challenge', special: 'Special event' };
const STATUS_TONE: Record<string, string> = { draft: 'neutral', published: 'success', cancelled: 'danger', completed: 'info' };
const REG_TONE: Record<string, string> = { registered: 'info', waitlisted: 'warning', attended: 'success', no_show: 'danger', cancelled: 'neutral' };
const REG_LABEL: Record<string, string> = { registered: 'Registered', waitlisted: 'Waitlist', attended: 'Attended', no_show: 'No-show', cancelled: 'Cancelled' };
const errMsg = (e: unknown) => (e instanceof ApiError ? (Array.isArray(e.details) ? `${(e.details as any)[0].message}` : e.message) : 'Something went wrong');
const when = (s: string, e: string) => {
  const a = new Date(s), b = new Date(e);
  const day = a.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
  const t = (d: Date) => d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  return `${day} · ${t(a)}–${t(b)}`;
};
const local = (iso?: string | null) => (iso ? new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 16) : '');
const toIso = (v: string) => (v ? new Date(`${v}:00+05:30`).toISOString() : null);

function EventDialog({ event, onClose }: { event?: any; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { me } = useAuth();
  const scoped = branchScope.get();
  const { data: staff } = useQuery({ queryKey: ['appt-staff'], queryFn: () => api.get<any[]>('/appointments/staff') });
  const [f, setF] = useState({
    branchId: event?.branch_id ?? (scoped !== 'all' ? scoped : me?.branches[0]?.id ?? ''), title: event?.title ?? '', type: event?.type ?? 'workshop', description: event?.description ?? '',
    startsAt: local(event?.starts_at), endsAt: local(event?.ends_at), location: event?.location ?? '', capacity: event?.capacity ?? '', price: event?.price ?? 0,
    memberPrice: event?.member_price ?? '', taxRate: event?.tax_rate ?? 18, allowGuests: event?.allow_guests ?? true, registrationClosesAt: local(event?.registration_closes_at),
    attendancePoints: event?.attendance_points ?? 50, hostId: event?.host_id ?? '',
  });
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, startsAt: toIso(f.startsAt), endsAt: toIso(f.endsAt), registrationClosesAt: toIso(f.registrationClosesAt), capacity: f.capacity === '' ? null : Number(f.capacity),
        memberPrice: f.memberPrice === '' ? null : Number(f.memberPrice), hostId: f.hostId || null, description: f.description || null, location: f.location || null };
      return event ? api.put<any>(`/events/${event.id}`, body) : api.post<any>('/events', body);
    },
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['events'] }); qc.invalidateQueries({ queryKey: ['event'] }); onClose(); if (!event) navigate(`/events/${r.id}`); },
    onError: (e) => setError(errMsg(e)),
  });
  return (
    <Dialog open variant="drawer" onClose={onClose} title={event ? `Edit ${event.title}` : 'New event'} sub="Prices are GST-inclusive. Paid registrations raise an invoice like any other sale."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => { setError(''); save.mutate(); }}>{event ? 'Save' : 'Create draft'}</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <Field label="Title"><input className="input" value={f.title} onChange={set('title')} placeholder="Deadlift Technique Workshop" /></Field>
        <Field label="Type"><div className="chips">{Object.entries(EVENT_TYPE).map(([k, l]) => <button type="button" key={k} className={`chip ${f.type === k ? 'on' : ''}`} onClick={() => setF({ ...f, type: k })}>{l}</button>)}</div></Field>
        <div className="form-grid">
          <Field label="Starts"><input className="input" type="datetime-local" value={f.startsAt} onChange={set('startsAt')} /></Field>
          <Field label="Ends"><input className="input" type="datetime-local" value={f.endsAt} onChange={set('endsAt')} /></Field>
          {(me?.branches.length ?? 0) > 1 && <Field label="Branch"><select className="select" value={f.branchId} onChange={set('branchId')}>{me!.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>}
          <Field label="Location"><input className="input" value={f.location} onChange={set('location')} placeholder="Studio 1" /></Field>
          <Field label="Capacity" hint="Blank for unlimited"><input className="input num" type="number" min={1} value={f.capacity} onChange={set('capacity')} /></Field>
          <Field label="Host"><select className="select" value={f.hostId} onChange={set('hostId')}><option value="">—</option>{staff?.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}</select></Field>
          <Field label="Price (₹)" hint="0 for free"><input className="input num" type="number" min={0} value={f.price} onChange={set('price')} /></Field>
          <Field label="Member price (₹)" hint="Optional"><input className="input num" type="number" min={0} value={f.memberPrice} onChange={set('memberPrice')} /></Field>
          <Field label="Registration closes"><input className="input" type="datetime-local" value={f.registrationClosesAt} onChange={set('registrationClosesAt')} /></Field>
          <Field label="Loyalty points for attending"><input className="input num" type="number" min={0} value={f.attendancePoints} onChange={set('attendancePoints')} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={f.allowGuests} onChange={set('allowGuests')} />Open to guests (non-members)</label>
        <Field label="Description" hint="Shown to members in the app"><textarea className="textarea" value={f.description} onChange={set('description')} /></Field>
      </div>
    </Dialog>
  );
}

function RegisterDialog({ event, onClose }: { event: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [mode, setMode] = useState<'member' | 'guest'>('member');
  const [member, setMember] = useState<MemberPick | null>(null);
  const [guest, setGuest] = useState({ name: '', phone: '' });
  const [collect, setCollect] = useState(true);
  const [method, setMethod] = useState('upi');
  const [reference, setReference] = useState('');
  const [error, setError] = useState('');
  const fee = Number(mode === 'member' && event.member_price != null ? event.member_price : event.price);
  const full = event.capacity != null && event.registered >= event.capacity;
  const save = useMutation({
    mutationFn: () => api.post<any>(`/events/${event.id}/registrations`, {
      memberId: mode === 'member' ? member?.id : null, guest: mode === 'guest' ? { name: guest.name, phone: guest.phone || null } : null,
      payment: fee > 0 && !full && collect && can('payments.create') ? { amount: fee, method, reference: reference || null } : null,
    }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['event', event.id] }); qc.invalidateQueries({ queryKey: ['events'] }); toast('success', r.waitlisted ? 'Added to the waitlist' : 'Registered'); onClose(); },
    onError: (e) => setError(errMsg(e)),
  });
  return (
    <Dialog open onClose={onClose} title={`Register for ${event.title}`} sub={full ? 'The event is full — new registrations join the waitlist.' : event.capacity ? `${event.capacity - event.registered} spots left` : 'Unlimited spots'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={mode === 'member' ? !member : guest.name.trim().length < 2} loading={save.isPending} onClick={() => { setError(''); save.mutate(); }}>
        {full ? 'Add to waitlist' : fee > 0 && collect ? `Register & collect ${money(fee)}` : 'Register'}</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        {event.allow_guests && <div className="cust-toggle" role="tablist"><button role="tab" className={mode === 'member' ? 'on' : ''} onClick={() => setMode('member')}>Member</button><button role="tab" className={mode === 'guest' ? 'on' : ''} onClick={() => setMode('guest')}>Guest</button></div>}
        {mode === 'member' ? <Field label="Member"><MemberPicker value={member} onChange={setMember} /></Field> : (
          <div className="form-grid">
            <Field label="Guest name"><input className="input" value={guest.name} onChange={(e) => setGuest({ ...guest, name: e.target.value })} /></Field>
            <Field label="Phone"><input className="input" value={guest.phone} onChange={(e) => setGuest({ ...guest, phone: e.target.value })} /></Field>
          </div>
        )}
        {fee > 0 && !full && (
          <>
            <div className="summary-box"><div className="line"><span>Fee ({mode === 'member' && event.member_price != null ? 'member price' : 'standard'}, incl. GST)</span><b>{money(fee, true)}</b></div></div>
            {can('payments.create') && <label className="check"><input type="checkbox" checked={collect} onChange={(e) => setCollect(e.target.checked)} />Collect payment now</label>}
            {collect && can('payments.create') && <>
              <Field label="Paid via"><MethodPicker value={method} onChange={setMethod} /></Field>
              {method !== 'cash' && <Field label={referenceLabel(method)}><input className="input" value={reference} onChange={(e) => setReference(e.target.value)} required={referenceRequired(method)} /></Field>}
            </>}
            {!collect && <div className="faint" style={{ fontSize: 12.5 }}>An unpaid invoice is raised — collect it later from Payments.</div>}
          </>
        )}
      </div>
    </Dialog>
  );
}

function CancelEventDialog({ event, onClose }: { event: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api.post<any>(`/events/${event.id}/cancel`, { reason }),
    onSuccess: (r) => { qc.invalidateQueries(); toast('success', `Cancelled · ${r.cancelled} registrations notified${r.toRefund.length ? ` · ${r.toRefund.length} paid invoices to refund` : ''}`); onClose(); },
  });
  return (
    <Dialog open onClose={onClose} title={`Cancel ${event.title}?`} sub="Registrants are notified in the app. Unpaid invoices are voided; paid ones are listed for refund."
      footer={<><Button onClick={onClose}>Keep event</Button><Button variant="danger" disabled={reason.trim().length < 3} loading={m.isPending} onClick={() => m.mutate()}>Cancel event</Button></>}>
      <Field label="Reason (shown to members)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Coach unwell — we’ll reschedule soon" autoFocus /></Field>
    </Dialog>
  );
}

export function EventDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [filter, setFilter] = useState('active');
  const { data: e, error } = useQuery({ queryKey: ['event', id], queryFn: () => api.get<any>(`/events/${id}`) });
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: any }) => api.post<any>(path, body ?? {}),
    onSuccess: (r, v) => { qc.invalidateQueries({ queryKey: ['event', id] }); qc.invalidateQueries({ queryKey: ['events'] }); if (v.path.endsWith('/publish')) toast('success', r?.announced ? `Published · announced to ${r.announced} members` : 'Published'); },
    onError: (err) => toast('error', errMsg(err)),
  });
  if (error) return <div className="page"><Empty title="Event not found"><Link to="/events" className="btn">Back to events</Link></Empty></div>;
  if (!e) return <div className="page"><Skeleton h={160} /><Skeleton h={360} /></div>;
  const manage = can('events.manage');
  const started = new Date(e.starts_at).getTime() <= Date.now() + 60 * 60_000;
  const shown = e.participants.filter((p: any) => (filter === 'active' ? !['cancelled'].includes(p.status) : filter === 'all' ? true : p.status === filter));
  const pct = e.capacity ? Math.min(100, (e.registered / e.capacity) * 100) : null;
  return (
    <div className="page">
      <Link to="/events" className="btn ghost sm" style={{ alignSelf: 'flex-start' }}><ArrowLeft />Events</Link>
      <section className="card glow">
        <div className="profile-hero">
          <div className="event-badge"><Trophy /></div>
          <div className="who">
            <div className="row wrap"><h1>{e.title}</h1><span className={`badge ${STATUS_TONE[e.status]}`} style={{ textTransform: 'capitalize' }}>{e.status}</span></div>
            <div className="muted" style={{ marginTop: 3 }}>{EVENT_TYPE[e.type]} · {when(e.starts_at, e.ends_at)} · {e.branch_name}{e.location ? ` · ${e.location}` : ''}{e.host_name ? ` · hosted by ${e.host_name}` : ''}</div>
            {e.cancel_reason && <div style={{ color: 'var(--danger)', marginTop: 6 }}>Cancelled: {e.cancel_reason}</div>}
            {manage && (
              <div className="row wrap" style={{ marginTop: 12 }}>
                {e.status === 'draft' && <>
                  <Button size="sm" variant="primary" icon={<Megaphone />} loading={act.isPending} onClick={() => act.mutate({ path: `/events/${e.id}/publish`, body: { announce: true } })}>Publish & announce</Button>
                  <Button size="sm" onClick={() => act.mutate({ path: `/events/${e.id}/publish`, body: { announce: false } })}>Publish quietly</Button>
                </>}
                {e.status === 'published' && <Button size="sm" variant="primary" icon={<UserPlus />} onClick={() => setRegistering(true)}>Register someone</Button>}
                {['draft', 'published'].includes(e.status) && <Button size="sm" icon={<Pencil />} onClick={() => setEditing(true)}>Edit</Button>}
                {e.status === 'published' && started && <Button size="sm" icon={<Check />} onClick={() => act.mutate({ path: `/events/${e.id}/complete` })}>Close event</Button>}
                {['draft', 'published'].includes(e.status) && <Button size="sm" variant="ghost" icon={<CircleSlash />} onClick={() => setCancelling(true)}>Cancel event</Button>}
              </div>
            )}
          </div>
          <div className="facts">
            <div className="fact"><div className="k">Registered</div><div className="v">{e.registered}{e.capacity ? <span className="faint"> / {e.capacity}</span> : ''}</div>
              {pct !== null && <div className="share-bar" style={{ marginTop: 6, width: 110 }}><i style={{ width: `${pct}%` }} /></div>}</div>
            <div className="fact"><div className="k">Waitlist</div><div className="v">{e.waitlisted}</div></div>
            <div className="fact"><div className="k">Attended</div><div className="v">{e.attended}</div></div>
            <div className="fact"><div className="k">Revenue</div><div className="v gold-text">{money(e.revenue)}</div><div className="faint" style={{ fontSize: 12 }}>{Number(e.outstanding) ? `${money(e.outstanding)} unpaid` : Number(e.price) ? `${money(e.price)}${e.member_price != null ? ` · members ${money(e.member_price)}` : ''}` : 'Free'}</div></div>
          </div>
        </div>
      </section>
      {e.description && <Card><p className="muted" style={{ whiteSpace: 'pre-wrap' }}>{e.description}</p></Card>}
      <section className="card">
        <div className="toolbar">
          <b style={{ marginRight: 8 }}>Participants</b>
          <div className="chips">{[['active', 'Active'], ['registered', 'Registered'], ['waitlisted', 'Waitlist'], ['attended', 'Attended'], ['no_show', 'No-show'], ['cancelled', 'Cancelled'], ['all', 'All']].map(([k, l]) => (
            <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{l}</button>))}</div>
          <div style={{ flex: 1 }} />
          {e.attendance_points > 0 && <span className="faint" style={{ fontSize: 12.5 }}>+{e.attendance_points} loyalty points for attending</span>}
        </div>
        <div className="table-wrap">
          {!shown.length ? <Empty icon={<Users />} title="Nobody here yet" /> : (
            <table className="tbl">
              <thead><tr><th>#</th><th>Participant</th><th>Status</th><th className="hide-sm">Registered</th><th>Payment</th>{manage && <th />}</tr></thead>
              <tbody>{shown.map((p: any, i: number) => (
                <tr key={p.id}>
                  <td className="faint num">{i + 1}</td>
                  <td>{p.member_id ? <Link to={`/members/${p.member_id}`}><Person name={p.name} detail={p.member_code} size="sm" /></Link> : <Person name={p.name} detail={`Guest${p.phone ? ` · ${p.phone}` : ''}`} size="sm" />}</td>
                  <td><span className={`badge ${REG_TONE[p.status]}`}>{REG_LABEL[p.status]}</span>{p.source === 'app' && <span className="faint" style={{ fontSize: 11.5 }}> · app</span>}</td>
                  <td className="muted hide-sm" style={{ whiteSpace: 'nowrap' }}>{dateTime(p.created_at)}</td>
                  <td>{!p.invoice_id ? <span className="faint">{p.status === 'waitlisted' && Number(e.price) > 0 ? 'Billed if a spot opens' : Number(e.price) > 0 ? '—' : 'Free'}</span> : <Link to={`/invoices/${p.invoice_id}`} className={`badge ${p.invoice_status === 'paid' ? 'success' : p.invoice_status === 'void' ? 'neutral' : 'warning'}`}>
                    {p.invoice_status === 'paid' ? `Paid ${money(p.total)}` : p.invoice_status === 'void' ? 'Void' : `${money(p.total - p.amount_paid)} due`}</Link>}</td>
                  {manage && <td style={{ whiteSpace: 'nowrap' }}>
                    {['registered', 'attended', 'no_show'].includes(p.status) && started && e.status !== 'cancelled' && (
                      <span className="row" style={{ gap: 4, display: 'inline-flex' }}>
                        <Button size="sm" variant={p.status === 'attended' ? 'primary' : 'ghost'} icon={<Check />} aria-label="Mark attended" onClick={() => act.mutate({ path: `/events/registrations/${p.id}/attendance`, body: { status: 'attended' } })}>Present</Button>
                        <Button size="sm" variant={p.status === 'no_show' ? 'danger' : 'ghost'} onClick={() => act.mutate({ path: `/events/registrations/${p.id}/attendance`, body: { status: 'no_show' } })}>No-show</Button>
                      </span>
                    )}
                    {['registered', 'waitlisted'].includes(p.status) && !started && <Button size="sm" variant="ghost" icon={<X />} aria-label="Cancel registration" onClick={() => confirm(`Cancel ${p.name}'s registration?`) && act.mutate({ path: `/events/registrations/${p.id}/cancel` })} />}
                  </td>}
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </section>
      {editing && <EventDialog event={e} onClose={() => setEditing(false)} />}
      {registering && <RegisterDialog event={e} onClose={() => setRegistering(false)} />}
      {cancelling && <CancelEventDialog event={e} onClose={() => setCancelling(false)} />}
    </div>
  );
}

export function EventsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as 'upcoming' | 'past' | 'drafts') ?? 'upcoming';
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const { data: sum } = useQuery({ queryKey: ['events', 'summary'], queryFn: () => api.get<any>('/events/summary') });
  const { data } = useQuery({
    queryKey: ['events', tab, page],
    queryFn: () => api.get<Paged<any>>('/events', { when: tab === 'past' ? 'past' : tab === 'drafts' ? 'all' : 'upcoming', status: tab === 'drafts' ? 'draft' : undefined, page, pageSize: 24 }),
  });
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Events</h1><div className="sub">Workshops, competitions, seminars and challenges — registration, capacity, attendance and revenue.</div></div>
        <div className="actions">{can('events.manage') && <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>New event</Button>}</div>
      </div>
      <div className="grid g-4">
        <section className="card kpi hero"><div className="label"><CalendarDays />Upcoming</div><div className="value">{sum?.upcoming ?? '—'}</div><div className="compare">published events</div></section>
        <section className="card kpi"><div className="label"><Users />Registrations</div><div className="value">{sum?.upcoming_registrations ?? '—'}</div><div className="compare">for upcoming events</div></section>
        <section className="card kpi"><div className="label"><Check />Show-up rate</div><div className="value">{sum ? `${sum.show_rate}%` : '—'}</div><div className="compare">attended ÷ registered, past events</div></section>
        <section className="card kpi"><div className="label"><IndianRupee />Event revenue</div><div className="value">{money(sum?.revenue_90d ?? 0)}</div><div className="compare">last 90 days</div></section>
      </div>
      <Tabs value={tab} onChange={(t) => { setParams(t === 'upcoming' ? {} : { tab: t }); setPage(1); }} tabs={[{ key: 'upcoming', label: 'Upcoming' }, { key: 'past', label: 'Past' }, { key: 'drafts', label: 'Drafts' }]} />
      {!data ? <Skeleton h={300} /> : !data.data.length ? <Card><Empty icon={<Trophy />} title={tab === 'drafts' ? 'No drafts' : 'No events'}>Create a workshop, challenge or community event.</Empty></Card> : (
        <div className="event-grid">{data.data.map((e) => {
          const pct = e.capacity ? Math.min(100, (e.registered / e.capacity) * 100) : null;
          return (
            <button key={e.id} className="card event-card" onClick={() => navigate(`/events/${e.id}`)}>
              <div className="row between"><span className="faint" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{EVENT_TYPE[e.type]}</span>
                <span className={`badge ${STATUS_TONE[e.status]}`} style={{ textTransform: 'capitalize' }}>{e.status}</span></div>
              <b className="title">{e.title}</b>
              <div className="muted" style={{ fontSize: 13 }}><CalendarDays size={13} style={{ verticalAlign: -2 }} /> {when(e.starts_at, e.ends_at)}</div>
              <div className="faint" style={{ fontSize: 12.5 }}><MapPin size={13} style={{ verticalAlign: -2 }} /> {e.branch_name}{e.location ? ` · ${e.location}` : ''}</div>
              <div style={{ marginTop: 'auto', width: '100%' }}>
                <div className="row between" style={{ fontSize: 12.5 }}>
                  <span><b className="num">{e.registered}</b><span className="faint">{e.capacity ? ` / ${e.capacity}` : ''} registered{e.waitlisted ? ` · ${e.waitlisted} waiting` : ''}{e.status === 'completed' ? ` · ${e.attended} came` : ''}</span></span>
                  <span className="num">{Number(e.price) ? money(e.revenue) : <span className="faint">Free</span>}</span>
                </div>
                {pct !== null && <div className="share-bar" style={{ marginTop: 6 }}><i style={{ width: `${pct}%`, background: pct >= 100 ? 'var(--warning)' : undefined }} /></div>}
              </div>
            </button>
          );
        })}</div>
      )}
      {data && data.pagination.totalPages > 1 && <Pagination page={data.pagination.page} totalPages={data.pagination.totalPages} total={data.pagination.total} onPage={setPage} />}
      {creating && <EventDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
