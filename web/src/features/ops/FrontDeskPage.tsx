import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock, CalendarPlus, CheckCircle2, Contact, CreditCard, DoorOpen, Dumbbell, LogOut, QrCode, RefreshCw, ScanLine, ShieldAlert, UserPlus, Users, XCircle,
} from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/ui';
import { date, daysLabel, money, relative } from '../../lib/format';
import { Alert, Avatar, Button, Card, Dialog, Empty, Field, Skeleton, StatusBadge } from '../../components/ui';
import { useActions } from '../actions';
import { BookClassDialog, CapacityBar } from './ClassesPage';
import { AppointmentActions, AppointmentDialog, APPT_LABEL, SellPtDialog, timeLabel, type AppointmentPreset } from './common';

type Result = { member: any; allowed: boolean; reason: string; status?: string; duplicate?: boolean; checkedIn: boolean; at?: string };

function MemberVerdict({ r, onOverride, onCheckIn, busy }: { r: Result; onOverride: () => void; onCheckIn: () => void; busy: boolean }) {
  const { can } = useAuth();
  const actions = useActions();
  const [bookClass, setBookClass] = useState(false);
  const [booking, setBooking] = useState<AppointmentPreset | null>(null);
  const [sellPt, setSellPt] = useState(false);
  const m = r.member;
  const ok = r.allowed;
  return (
    <div className="stack">
      <div className={`verdict ${ok ? 'ok' : 'no'}`}>
        <Avatar name={m.full_name} size="lg" />
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="big">{ok ? <CheckCircle2 /> : <XCircle />}{ok ? (r.checkedIn ? (r.duplicate ? 'Already checked in' : r.status === 'override' ? 'Allowed (override)' : 'Checked in') : 'Entry allowed') : 'Entry denied'}</div>
          <div style={{ fontSize: 18, fontWeight: 800, marginTop: 4 }}>{m.full_name} <span className="faint" style={{ fontSize: 13, fontWeight: 600 }}>{m.member_code}</span></div>
          <div className="muted" style={{ marginTop: 2 }}>{ok ? (r.checkedIn && r.at ? `at ${timeLabel(r.at)}` : '') : r.reason}</div>
        </div>
        <div className="row wrap">
          {!r.checkedIn && ok && can('attendance.checkin') && <Button variant="primary" size="lg" icon={<DoorOpen />} loading={busy} onClick={onCheckIn}>Check in</Button>}
          {!ok && can('attendance.override') && <Button icon={<ShieldAlert />} onClick={onOverride}>Allow anyway</Button>}
        </div>
      </div>
      <div className="grid g-4">
        <div className="summary-box"><span className="faint" style={{ fontSize: 11, fontWeight: 700 }}>MEMBERSHIP</span><b>{m.plan_name ?? 'No plan'}</b><StatusBadge status={m.status} /></div>
        <div className="summary-box"><span className="faint" style={{ fontSize: 11, fontWeight: 700 }}>EXPIRES</span><b>{m.end_date ? date(m.end_date) : '—'}</b><span className="muted" style={{ fontSize: 12 }}>{m.end_date ? daysLabel(m.days_remaining) : ''}</span></div>
        <div className="summary-box"><span className="faint" style={{ fontSize: 11, fontWeight: 700 }}>DUES</span><b style={{ color: m.outstanding > 0 ? 'var(--warning)' : undefined }}>{money(m.outstanding)}</b><span className="muted" style={{ fontSize: 12 }}>{m.outstanding > 0 ? 'collect at desk' : 'all clear'}</span></div>
        <div className="summary-box"><span className="faint" style={{ fontSize: 11, fontWeight: 700 }}>LAST VISIT</span><b>{m.last_visit_at ? relative(m.last_visit_at) : 'Never'}</b><span className="muted" style={{ fontSize: 12 }}>{m.visits_30d} visits in 30 days</span></div>
      </div>
      <div className="row wrap">
        {can('payments.create') && m.outstanding > 0 && <Button variant="primary" icon={<CreditCard />} onClick={() => actions.recordPayment({ memberId: m.id, memberName: m.full_name })}>Collect {money(m.outstanding)}</Button>}
        {can('memberships.manage') && <Button icon={<RefreshCw />} onClick={() => actions.sellMembership({ memberId: m.id, memberName: m.full_name })}>{['expired', 'expiring_soon', 'none', 'cancelled'].includes(m.status) ? 'Renew membership' : 'Sell / change plan'}</Button>}
        {can('classes.book') && <Button icon={<Users />} onClick={() => setBookClass(true)}>Book class</Button>}
        {can('appointments.manage') && <Button icon={<CalendarPlus />} onClick={() => setBooking({ memberId: m.id, memberName: m.full_name, type: 'pt' })}>Book PT / appointment</Button>}
        {can('pt.sell') && <Button icon={<Dumbbell />} onClick={() => setSellPt(true)}>Sell PT</Button>}
        <Link className="btn ghost" to={`/members/${m.id}`}>Open profile</Link>
      </div>
      {bookClass && <BookClassDialog memberId={m.id} memberName={m.full_name} onClose={() => setBookClass(false)} />}
      {booking && <AppointmentDialog preset={booking} onClose={() => setBooking(null)} />}
      {sellPt && <SellPtDialog memberId={m.id} memberName={m.full_name} onClose={() => setSellPt(false)} />}
    </div>
  );
}

export function FrontDeskPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const actions = useActions();
  const { me, can, branch, setBranch } = useAuth();
  const input = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState('');
  const [auto, setAuto] = useState(() => { try { return localStorage.getItem('forge.desk.auto') !== 'off'; } catch { return true; } });
  const [result, setResult] = useState<Result | null>(null);
  const [notFound, setNotFound] = useState('');
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState('');
  const [booking, setBooking] = useState<AppointmentPreset | null>(null);
  const [openAppt, setOpenAppt] = useState<any>(null);
  const needsBranch = branch === 'all' && (me?.branches.length ?? 0) > 1;

  useEffect(() => { input.current?.focus(); }, [result]);
  const live = useQuery({ queryKey: ['attendance-live'], queryFn: () => api.get<any>('/attendance/live'), refetchInterval: 15_000, enabled: can('attendance.read') });
  const today = useQuery({ queryKey: ['dash', 'today'], queryFn: () => api.get<any>('/dashboard/today'), refetchInterval: 60_000 });

  const checkIn = useMutation({
    mutationFn: (v: { code?: string; memberId?: string; override?: { reason: string } }) => api.post<any>('/attendance/check-in', v),
    onSuccess: (r) => {
      setResult({ member: r.member, allowed: r.allowed, reason: r.reason, status: r.status, duplicate: r.duplicate, checkedIn: r.allowed, at: r.attendance.checked_in_at });
      setOverride(false); setReason('');
      qc.invalidateQueries({ queryKey: ['attendance-live'] });
    },
    onError: (e, v) => (e instanceof ApiError && e.status === 404 ? setNotFound(v.code ?? '') : toast('error', e instanceof ApiError ? e.message : 'Failed')),
  });
  const lookup = useMutation({
    mutationFn: (c: string) => api.get<any>('/attendance/lookup', { code: c }),
    onSuccess: (r) => setResult({ member: r.member, allowed: r.decision.allowed, reason: r.decision.reason, checkedIn: false }),
    onError: (e, c) => (e instanceof ApiError && e.status === 404 ? setNotFound(c) : toast('error', e instanceof ApiError ? e.message : 'Failed')),
  });
  const out = useMutation({ mutationFn: (id: string) => api.post(`/attendance/${id}/check-out`), onSuccess: () => qc.invalidateQueries({ queryKey: ['attendance-live'] }) });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim();
    if (c.length < 2) return;
    setNotFound('');
    setResult(null);
    if (auto && can('attendance.checkin')) checkIn.mutate({ code: c });
    else lookup.mutate(c);
    setCode('');
  };

  return (
    <div className="page" style={{ maxWidth: 1500 }}>
      <div className="page-head">
        <div><h1>Front desk</h1><div className="sub">Scan a member QR, or type a member ID or phone number and press Enter.</div></div>
        <div className="actions">
          {can('members.write') && <Button icon={<UserPlus />} onClick={actions.addMember}>Register member</Button>}
          {can('leads.write') && <Button icon={<Contact />} onClick={actions.addLead}>Add lead</Button>}
          {can('payments.create') && <Button icon={<CreditCard />} onClick={() => actions.recordPayment()}>Record payment</Button>}
          {can('appointments.manage') && <Button icon={<CalendarPlus />} onClick={() => setBooking({})}>Book appointment</Button>}
        </div>
      </div>
      {needsBranch && (
        <Alert tone="warning">Pick the branch this desk is at:&nbsp;
          {me!.branches.map((b) => <button key={b.id} className="chip" style={{ marginRight: 6 }} onClick={() => setBranch(b.id)}>{b.name}</button>)}
        </Alert>
      )}
      <div className="desk">
        <div className="stack">
          <form className="scan" onSubmit={submit}>
            <ScanLine />
            <input ref={input} value={code} onChange={(e) => setCode(e.target.value)} disabled={needsBranch} placeholder={needsBranch ? 'Choose a branch first' : 'M10234, 98450 12345 or scan QR…'} aria-label="Member ID, phone or QR code" autoComplete="off" />
            <span className="scan-hint">Enter ↵</span>
          </form>
          <div className="row between">
            <label className="check"><input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); try { localStorage.setItem('forge.desk.auto', e.target.checked ? 'on' : 'off'); } catch { /* ignore */ } }} />Check in automatically when allowed</label>
            <span className="faint" style={{ fontSize: 12 }}><QrCode size={12} style={{ verticalAlign: -1 }} /> Member app QR codes refresh every 2 minutes</span>
          </div>
          {notFound && <Alert tone="warning">No member found for “{notFound}”. {can('members.write') && <button className="chip" onClick={actions.addMember}>Register</button>} {can('leads.write') && <button className="chip" onClick={actions.addLead}>Add as lead</button>}</Alert>}
          {(checkIn.isPending || lookup.isPending) && <Skeleton h={160} />}
          {result && (
            <MemberVerdict r={result} busy={checkIn.isPending}
              onCheckIn={() => checkIn.mutate({ memberId: result.member.id })}
              onOverride={() => setOverride(true)} />
          )}
          {!result && !checkIn.isPending && !lookup.isPending && !notFound && (
            <Card><Empty icon={<ScanLine size={20} />} title="Ready for the next member">Entry is checked against membership status, expiry, freezes and home branch.</Empty></Card>
          )}
          <div className="grid g-2">
            <Card title="Today’s classes" icon={<Users />} actions={<Link className="btn ghost sm" to="/classes">Timetable</Link>}>
              {!today.data ? <Skeleton h={160} /> : !today.data.classes.length ? <Empty title="No classes today" /> : (
                <div className="stack" style={{ gap: 6 }}>{today.data.classes.map((c: any) => (
                  <Link key={c.id} to={`/classes?session=${c.id}`} className="fu-row" style={{ opacity: c.status === 'completed' || c.status === 'cancelled' ? 0.55 : 1 }}>
                    <span className="num" style={{ width: 62, fontWeight: 800 }}>{timeLabel(c.starts_at)}</span>
                    <div style={{ flex: 1, minWidth: 0 }}><b>{c.class_name}</b><div className="faint" style={{ fontSize: 12 }}>{c.trainer_name ?? '—'}{c.waitlisted ? ` · ${c.waitlisted} waitlisted` : ''}{c.status === 'cancelled' ? ' · cancelled' : ''}</div><div style={{ marginTop: 4 }}><CapacityBar booked={c.booked} capacity={c.capacity} /></div></div>
                    <span className="faint num" style={{ fontSize: 12 }}>{c.booked}/{c.capacity}</span>
                  </Link>
                ))}</div>
              )}
            </Card>
            <Card title="Today’s appointments" icon={<CalendarClock />} actions={<Link className="btn ghost sm" to="/appointments">Calendar</Link>}>
              {!today.data ? <Skeleton h={160} /> : !today.data.appointments.length ? <Empty title="Nothing booked today" /> : (
                <div className="stack" style={{ gap: 6 }}>{today.data.appointments.map((a: any) => (
                  <button key={a.id} className="fu-row" style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit', opacity: a.status !== 'scheduled' ? 0.55 : 1 }} onClick={() => setOpenAppt(a)}>
                    <span className="num" style={{ width: 62, fontWeight: 800 }}>{timeLabel(a.starts_at)}</span>
                    <div style={{ flex: 1, minWidth: 0 }}><b>{a.client_name}</b><div className="faint" style={{ fontSize: 12 }}>{APPT_LABEL[a.type]}{a.staff_name ? ` · ${a.staff_name}` : ''}</div></div>
                    <span className={`badge ${a.status === 'completed' ? 'success' : a.status === 'no_show' ? 'danger' : 'accent'}`}>{a.status === 'scheduled' ? 'Upcoming' : a.status.replace('_', '-')}</span>
                  </button>
                ))}</div>
              )}
            </Card>
          </div>
        </div>
        {can('attendance.read') && (
          <div className="stack">
            <div className="grid g-2">
              <section className="card kpi hero"><div className="label">In the gym</div><div className="value">{live.data?.inside ?? '—'}</div><div className="compare">right now</div></section>
              <section className="card kpi"><div className="label">Today</div><div className="value">{live.data?.today ?? '—'}</div><div className="compare">{live.data?.denied_today ? `${live.data.denied_today} denied` : 'check-ins'}</div></section>
            </div>
            <Card title="Recent entries" icon={<DoorOpen />}>
              {!live.data ? <Skeleton h={300} /> : !live.data.recent.length ? <Empty title="No one yet today" /> : (
                <div className="stack" style={{ gap: 4, maxHeight: 620, overflowY: 'auto' }}>
                  {live.data.recent.map((a: any) => (
                    <div key={a.id} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                      <span className="num faint" style={{ width: 58, fontSize: 12 }}>{timeLabel(a.checked_in_at)}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <button className="btn ghost sm" style={{ padding: 0, height: 'auto', fontWeight: 700 }} onClick={() => { setNotFound(''); lookup.mutate(a.member_code); }}>{a.full_name}</button>
                        {a.status !== 'allowed' && <div style={{ fontSize: 11.5, color: a.status === 'denied' ? 'var(--danger)' : 'var(--warning)' }}>{a.status === 'denied' ? a.reason : 'Override'}</div>}
                      </span>
                      {a.status === 'denied' ? <XCircle size={16} style={{ color: 'var(--danger)' }} />
                        : a.checked_out_at ? <span className="faint num" style={{ fontSize: 11.5 }}>out {timeLabel(a.checked_out_at)}</span>
                          : can('attendance.checkin') && <Button size="sm" variant="ghost" icon={<LogOut />} aria-label={`Check out ${a.full_name}`} title="Check out" onClick={() => out.mutate(a.id)} />}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}
      </div>
      {override && result && (
        <Dialog open onClose={() => setOverride(false)} title={`Let ${result.member.full_name} in?`} sub={`Entry was denied: ${result.reason}. Overrides are recorded in the audit log.`}
          footer={<><Button onClick={() => setOverride(false)}>Cancel</Button><Button variant="primary" disabled={reason.trim().length < 3} loading={checkIn.isPending} onClick={() => checkIn.mutate({ memberId: result.member.id, override: { reason } })}>Allow entry</Button></>}>
          <Field label="Reason"><input className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Renewing at the desk now" /></Field>
        </Dialog>
      )}
      {booking && <AppointmentDialog preset={booking} onClose={() => setBooking(null)} />}
      {openAppt && (
        <Dialog open onClose={() => setOpenAppt(null)} title={`${APPT_LABEL[openAppt.type]} · ${openAppt.client_name}`} sub={`${timeLabel(openAppt.starts_at)} · ${openAppt.staff_name ?? 'Unassigned'}`}>
          <AppointmentActions appt={openAppt} onDone={() => setOpenAppt(null)} />
          {openAppt.status !== 'scheduled' && <div className="muted">This appointment is {openAppt.status.replace('_', '-')}.</div>}
        </Dialog>
      )}
    </div>
  );
}
