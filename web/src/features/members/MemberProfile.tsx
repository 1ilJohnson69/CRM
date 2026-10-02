import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, CalendarClock, CalendarPlus, DoorOpen, Dumbbell, Users, CreditCard, FileDown, KeyRound, MessageCircle, Pencil, Phone, RefreshCw, Smartphone, Snowflake, Sun, XCircle, Contact,
} from 'lucide-react';
import { api, ApiError, openPdf, type Paged } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/ui';
import { date, dateTime, daysLabel, money, relative } from '../../lib/format';
import { Alert, Avatar, Button, Card, Dialog, Empty, Field, Method, Skeleton, StatusBadge, Tabs } from '../../components/ui';
import { useActions } from '../actions';
import { CredentialsCard } from './MemberForm';
import { channelIcon, CHANNEL_LABEL, CompleteFollowUpDialog, OUTCOME_LABEL } from '../crm/common';
import { FollowUpRow } from '../crm/FollowUpsPage';
import { BookClassDialog, BookingBadge } from '../ops/ClassesPage';
import { PackageProgress, PkgBadge } from '../ops/PtPage';
import { FitnessTab, NutritionTab, WorkoutTab } from '../fitness/MemberFitness';
import { LoyaltyTab } from '../business/EngagementPages';
import { AppointmentActions, AppointmentDialog, APPT_LABEL, APPT_STATUS_LABEL, APPT_STATUS_TONE, SellPtDialog } from '../ops/common';

type Tab = 'overview' | 'membership' | 'fitness' | 'workout' | 'nutrition' | 'loyalty' | 'attendance' | 'classes' | 'pt' | 'appointments' | 'payments' | 'invoices' | 'followups' | 'communication' | 'app' | 'activity';

function MembershipActionDialog({ kind, membership, onClose }: { kind: 'freeze' | 'extend' | 'cancel'; membership: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [days, setDays] = useState(kind === 'freeze' ? 7 : 3);
  const [reason, setReason] = useState('');
  const [override, setOverride] = useState(false);
  const [error, setError] = useState('');
  const left = (membership.freeze_days_allowed ?? 0) - (membership.freeze_days_used ?? 0);
  const m = useMutation({
    mutationFn: () => api.post(`/memberships/${membership.id}/${kind}`, kind === 'cancel' ? { reason } : { days, reason, override }),
    onSuccess: () => {
      qc.invalidateQueries();
      toast('success', kind === 'freeze' ? `Frozen for ${days} days` : kind === 'extend' ? `Extended by ${days} days` : 'Membership cancelled');
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Something went wrong'),
  });
  const titles = { freeze: 'Freeze membership', extend: 'Extend membership', cancel: 'Cancel membership' };
  return (
    <Dialog open onClose={onClose} title={titles[kind]} sub={`${membership.plan_name} · ends ${date(membership.end_date)}`}
      footer={<><Button onClick={onClose}>Back</Button><Button variant={kind === 'cancel' ? 'danger' : 'primary'} loading={m.isPending} onClick={() => { setError(''); m.mutate(); }}>{titles[kind]}</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        {kind === 'freeze' && <Alert tone="info">{left} of {membership.freeze_days_allowed} freeze days left on this plan. The expiry date moves out by the days frozen, and gym access is paused.</Alert>}
        {kind === 'cancel' && <Alert tone="warning">Access stops immediately. Any unpaid invoice for this membership is voided. Refunds are handled separately.</Alert>}
        {kind !== 'cancel' && (
          <Field label="Days"><input className="input num" type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} /></Field>
        )}
        <Field label="Reason" hint="Recorded in the audit log"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus placeholder={kind === 'freeze' ? 'e.g. Travelling for work' : kind === 'extend' ? 'e.g. Compensation for closure on Diwali' : 'e.g. Relocating'} /></Field>
        {kind === 'freeze' && days > left && can('plans.manage') && (
          <label className="check"><input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />Approve beyond the plan's allowance</label>
        )}
      </div>
    </Dialog>
  );
}

function Overview({ m, onTab }: { m: any; onTab: (t: Tab) => void }) {
  const { data: payments } = useQuery({ queryKey: ['payments', { memberId: m.id }], queryFn: () => api.get<Paged<any>>('/payments', { memberId: m.id, pageSize: 5 }) });
  const cm = m.current_membership;
  const total = cm?.start_date ? (Date.parse(cm.end_date) - Date.parse(cm.start_date)) / 86400000 + 1 : 0;
  const used = cm?.start_date ? Math.min(total, Math.max(0, (Date.now() - Date.parse(cm.start_date)) / 86400000)) : 0;
  return (
    <div className="grid g-2">
      <Card title="Current membership" icon={<RefreshCw />} actions={<button className="btn ghost sm" onClick={() => onTab('membership')}>History</button>}>
        {!cm || cm.status === 'none' ? <Empty title="No membership yet" /> : (
          <div className="stack">
            <div className="row between"><div><div style={{ fontSize: 18, fontWeight: 800 }}>{cm.plan_name}</div><div className="muted">{date(cm.start_date)} – {date(cm.end_date)}</div></div><StatusBadge status={cm.status} /></div>
            <div className="bar-track"><div style={{ width: `${total ? (used / total) * 100 : 0}%` }} /></div>
            <div className="row between muted" style={{ fontSize: 12.5 }}><span>{Math.round(used)} of {Math.round(total)} days used</span><span>{cm.days_remaining >= 0 ? `${cm.days_remaining} days left` : `Expired ${-cm.days_remaining} days ago`}</span></div>
            {cm.status === 'frozen' && <Alert tone="info">Frozen until {date(cm.frozen_until)}.</Alert>}
            {cm.has_upcoming && <Alert tone="info">A renewal is already booked to start after this one.</Alert>}
          </div>
        )}
      </Card>
      <Card title="Contact & details" icon={<Phone />} actions={<span className="faint" style={{ fontSize: 12 }}>{m.branch_name}</span>}>
        <dl className="kv">
          <dt>Phone</dt><dd>{m.phone ?? '—'}</dd>
          <dt>Email</dt><dd>{m.email ?? '—'}</dd>
          <dt>Date of birth</dt><dd>{date(m.date_of_birth)}</dd>
          <dt>Address</dt><dd>{m.address ?? '—'}</dd>
          <dt>Emergency</dt><dd>{m.emergency_contact_name ? `${m.emergency_contact_name} · ${m.emergency_contact_phone ?? ''}` : '—'}</dd>
          <dt>Assigned staff</dt><dd>{m.assigned_staff ?? '—'}</dd>
          <dt>Source</dt><dd>{m.source ?? '—'}</dd>
          {m.lead_origin && <><dt>Came in as lead</dt><dd><Link to={`/leads?lead=${m.lead_origin.id}`} style={{ textDecoration: 'underline' }}>{m.lead_origin.source_name ?? 'Lead'} · {date(m.lead_origin.created_at)}</Link>{m.lead_origin.referred_by_name ? <> · referred by <Link to={`/members/${m.lead_origin.referred_by_member_id}`} style={{ textDecoration: 'underline' }}>{m.lead_origin.referred_by_name}</Link></> : null} · converted by {m.lead_origin.assigned_name ?? '—'}</dd></>}
          {m.notes && <><dt>Notes</dt><dd>{m.notes}</dd></>}
        </dl>
      </Card>
      <Card title="Recent payments" icon={<CreditCard />} bodyClass="" actions={<button className="btn ghost sm" onClick={() => onTab('payments')}>All</button>}>
        {!payments ? <div style={{ padding: 20 }}><Skeleton h={120} /></div> : !payments.data.length ? <Empty title="No payments yet" /> : (
          <table className="tbl" style={{ marginTop: 6 }}>
            <tbody>{payments.data.map((p) => (
              <tr key={p.id} className={p.status === 'voided' ? 'void' : ''}><td><div style={{ fontWeight: 600 }}>{p.receipt_number}</div><div className="faint" style={{ fontSize: 12 }}>{dateTime(p.paid_at)}</div></td><td><Method method={p.method} /></td><td className="r amount">{money(p.amount)}</td></tr>
            ))}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function MembershipTab({ m }: { m: any }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const actions = useActions();
  const [dialog, setDialog] = useState<{ kind: 'freeze' | 'extend' | 'cancel'; ms: any } | null>(null);
  const { data } = useQuery({ queryKey: ['member-memberships', m.id], queryFn: () => api.get<any[]>(`/members/${m.id}/memberships`) });
  const unfreeze = useMutation({
    mutationFn: (id: string) => api.post(`/memberships/${id}/unfreeze`),
    onSuccess: () => { qc.invalidateQueries(); toast('success', 'Membership unfrozen'); },
    onError: (e) => toast('error', e instanceof ApiError ? e.message : 'Failed'),
  });
  if (!data) return <Skeleton h={240} />;
  if (!data.length) return <Card><Empty title="No memberships yet">Sell the first plan to get {m.full_name.split(' ')[0]} started.</Empty></Card>;
  return (
    <div className="timeline-ms">
      {data.map((ms) => {
        const isCurrent = ms.id === m.current_membership?.membership_id;
        const open = !['cancelled', 'expired'].includes(ms.effective_status);
        return (
          <div key={ms.id} className={`ms-card ${isCurrent ? 'current' : ''}`}>
            <div>
              <div className="row wrap"><b style={{ fontSize: 15 }}>{ms.plan_name}</b><StatusBadge status={ms.effective_status} /><span className="badge neutral" style={{ textTransform: 'capitalize' }}>{ms.kind}</span>{isCurrent && <span className="badge accent">Current</span>}</div>
              <div className="muted" style={{ marginTop: 4 }}>{date(ms.start_date)} – {date(ms.end_date)} · {money(ms.price - ms.discount)}{ms.discount ? ` (after ${money(ms.discount)} off)` : ''}</div>
              <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
                {ms.invoice_number && <Link to={`/invoices/${ms.invoice_id}`} style={{ textDecoration: 'underline' }}>{ms.invoice_number}</Link>} · sold by {ms.created_by_name ?? '—'} · {ms.freeze_days_used}/{ms.freeze_days_allowed} freeze days used
                {ms.cancel_reason && ` · cancelled: ${ms.cancel_reason}`}
              </div>
            </div>
            {can('memberships.manage') && open && (
              <div className="row wrap" style={{ alignSelf: 'start', justifyContent: 'flex-end' }}>
                {ms.status === 'frozen' ? <Button size="sm" icon={<Sun />} loading={unfreeze.isPending} onClick={() => unfreeze.mutate(ms.id)}>Unfreeze</Button>
                  : ms.status === 'active' && ms.start_date <= new Date().toLocaleDateString('en-CA') && <Button size="sm" icon={<Snowflake />} onClick={() => setDialog({ kind: 'freeze', ms })}>Freeze</Button>}
                <Button size="sm" icon={<CalendarPlus />} onClick={() => setDialog({ kind: 'extend', ms })}>Extend</Button>
                {isCurrent && ms.status === 'active' && <Button size="sm" icon={<RefreshCw />} onClick={() => actions.sellMembership({ memberId: m.id, memberName: m.full_name, kind: 'upgrade' })}>Change plan</Button>}
                <Button size="sm" variant="ghost" icon={<XCircle />} onClick={() => setDialog({ kind: 'cancel', ms })}>Cancel</Button>
              </div>
            )}
          </div>
        );
      })}
      {dialog && <MembershipActionDialog kind={dialog.kind} membership={dialog.ms} onClose={() => setDialog(null)} />}
    </div>
  );
}

function PaymentsTab({ m }: { m: any }) {
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ['payments', { memberId: m.id, all: true }], queryFn: () => api.get<Paged<any>>('/payments', { memberId: m.id, pageSize: 100 }) });
  return (
    <section className="card">
      {!data ? <div style={{ padding: 20 }}><Skeleton h={200} /></div> : !data.data.length ? <Empty title="No payments yet" /> : (
        <div className="table-wrap"><table className="tbl">
          <thead><tr><th>Receipt</th><th>Date</th><th>For</th><th>Method</th><th>Reference</th><th>Collected by</th><th className="r">Amount</th><th>Status</th></tr></thead>
          <tbody>{data.data.map((p) => (
            <tr key={p.id} className={`clickable ${p.status === 'voided' ? 'void' : ''}`} onClick={() => navigate(`/invoices/${p.invoice_id}`)}>
              <td style={{ fontWeight: 700 }}>{p.receipt_number}</td><td className="muted">{dateTime(p.paid_at)}</td><td>{p.description}</td>
              <td><Method method={p.method} /></td><td className="muted num">{p.reference ?? '—'}</td><td className="muted">{p.collected_by_name}</td>
              <td className="r amount">{money(p.amount)}</td><td><StatusBadge status={p.status} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  );
}

function InvoicesTab({ m }: { m: any }) {
  const navigate = useNavigate();
  const actions = useActions();
  const { can } = useAuth();
  const { data } = useQuery({ queryKey: ['invoices', { memberId: m.id }], queryFn: () => api.get<Paged<any>>('/invoices', { memberId: m.id, pageSize: 100 }) });
  return (
    <section className="card">
      {!data ? <div style={{ padding: 20 }}><Skeleton h={200} /></div> : !data.data.length ? <Empty title="No invoices yet" /> : (
        <div className="table-wrap"><table className="tbl">
          <thead><tr><th>Invoice</th><th>Issued</th><th>Description</th><th className="r">Total</th><th className="r">Balance</th><th>Status</th><th className="r" /></tr></thead>
          <tbody>{data.data.map((i) => (
            <tr key={i.id} className="clickable" onClick={() => navigate(`/invoices/${i.id}`)}>
              <td style={{ fontWeight: 700 }}>{i.invoice_number}</td><td className="muted">{date(i.issue_date)}</td><td>{i.description}</td>
              <td className="r amount">{money(i.total)}</td><td className="r amount" style={{ color: i.balance > 0 ? 'var(--warning)' : 'var(--text-3)' }}>{i.balance > 0 ? money(i.balance) : '—'}</td>
              <td><StatusBadge status={i.status} /></td>
              <td className="r" onClick={(e) => e.stopPropagation()}>
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  {i.balance > 0 && can('payments.create') && ['pending', 'partially_paid'].includes(i.status) && <Button size="sm" variant="primary" onClick={() => actions.recordPayment({ memberId: m.id, memberName: m.full_name, invoiceId: i.id })}>Collect</Button>}
                  <Button size="sm" variant="ghost" icon={<FileDown />} onClick={() => openPdf(`/invoices/${i.id}/pdf`)} aria-label="Download PDF" />
                </div>
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  );
}

function AppTab({ m }: { m: any }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [creds, setCreds] = useState<{ login: string; temporaryPassword: string } | null>(null);
  const issue = useMutation({
    mutationFn: () => api.post<{ login: string; temporaryPassword: string }>(`/members/${m.id}/credentials`),
    onSuccess: (r) => { setCreds(r); qc.invalidateQueries({ queryKey: ['member', m.id] }); },
    onError: (e) => toast('error', e instanceof ApiError ? e.message : 'Failed'),
  });
  const toggle = useMutation({
    mutationFn: () => api.patch(`/members/${m.id}/app-access`, { active: !m.app_active }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['member', m.id] }); toast('success', m.app_active ? 'App access disabled' : 'App access enabled'); },
  });
  return (
    <div className="grid g-2">
      <Card title="Member app account" icon={<Smartphone />}>
        <div className="stack">
          <dl className="kv">
            <dt>Login</dt><dd>{m.email ?? m.phone}</dd>
            <dt>Credentials</dt><dd>{m.has_app_access ? (m.must_change_password ? 'Issued · awaiting first sign-in' : 'Set by member') : 'Not issued'}</dd>
            <dt>Account</dt><dd>{m.app_active ? <span className="badge success">Enabled</span> : <span className="badge danger">Disabled</span>}</dd>
            <dt>Last sign-in</dt><dd>{m.last_login_at ? relative(m.last_login_at) : 'Never'}</dd>
            <dt>Gym access</dt><dd><StatusBadge status={m.current_membership?.status ?? 'none'} /></dd>
          </dl>
          {creds && <CredentialsCard login={creds.login} password={creds.temporaryPassword} />}
          {can('members.credentials') && (
            <div className="row wrap">
              <Button icon={<KeyRound />} loading={issue.isPending} onClick={() => issue.mutate()}>{m.has_app_access ? 'Reset password' : 'Issue credentials'}</Button>
              <Button variant={m.app_active ? 'danger' : undefined} loading={toggle.isPending} onClick={() => toggle.mutate()}>{m.app_active ? 'Disable app access' : 'Enable app access'}</Button>
            </div>
          )}
        </div>
      </Card>
      <Card title="Active sessions" icon={<Smartphone />} bodyClass="">
        {!m.app_sessions.length ? <Empty title="No active sessions" /> : (
          <table className="tbl" style={{ marginTop: 6 }}><tbody>{m.app_sessions.map((s: any) => (
            <tr key={s.id}><td><div style={{ fontWeight: 600 }}>{s.client === 'app' ? 'Member app' : 'Web'}</div><div className="faint" style={{ fontSize: 12, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.user_agent ?? 'Unknown device'}</div></td><td className="muted r">{relative(s.last_used_at)}</td></tr>
          ))}</tbody></table>
        )}
      </Card>
    </div>
  );
}

function ActivityTab({ m }: { m: any }) {
  const { data } = useQuery({ queryKey: ['member-activity', m.id], queryFn: () => api.get<any[]>(`/members/${m.id}/activity`) });
  return (
    <Card>
      {!data ? <Skeleton h={200} /> : !data.length ? <Empty title="No activity yet" /> : (
        <div className="feed">{data.map((a) => (
          <div className="feed-item" key={a.id}><div className="ic"><RefreshCw /></div><div><div className="txt">{a.summary}</div><div className="when">{dateTime(a.created_at)} · {a.actor ?? 'System'}</div></div></div>
        ))}</div>
      )}
    </Card>
  );
}

function FollowUpsTab({ m }: { m: any }) {
  const { can } = useAuth();
  const actions = useActions();
  const [completing, setCompleting] = useState<any>(null);
  const { data } = useQuery({ queryKey: ['follow-ups', { memberId: m.id }], queryFn: () => api.get<Paged<any>>('/follow-ups', { memberId: m.id, pageSize: 100 }) });
  return (
    <Card title="Follow-ups" icon={<CalendarClock />} actions={can('followups.manage') && <Button size="sm" icon={<CalendarPlus />} onClick={() => actions.followUp({ memberId: m.id, name: m.full_name })}>Schedule</Button>}>
      {!data ? <Skeleton h={160} /> : !data.data.length ? <Empty title="No follow-ups yet">Renewal follow-ups are created automatically 7 days before expiry.</Empty> : (
        <div className="stack" style={{ gap: 6 }}>{data.data.map((f) => (
          <FollowUpRow key={f.id} f={{ ...f, subject_name: m.full_name }} onComplete={can('followups.manage') ? () => setCompleting({ ...f, subject_name: m.full_name }) : undefined} />
        ))}</div>
      )}
      {completing && <CompleteFollowUpDialog followUp={completing} onClose={() => setCompleting(null)} />}
    </Card>
  );
}

function CommunicationTab({ m }: { m: any }) {
  const { can } = useAuth();
  const actions = useActions();
  const qc = useQueryClient();
  const consent = useMutation({
    mutationFn: (optOut: boolean) => api.post('/messaging/consent', { memberId: m.id, optOut }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['member', m.id] }),
  });
  const { data } = useQuery({ queryKey: ['communications', { memberId: m.id }], queryFn: () => api.get<Paged<any>>('/communications', { memberId: m.id, pageSize: 100 }), enabled: can('communications.log') });
  return (
    <Card title="Communication" icon={<Contact />} sub={m.marketing_opt_out ? 'Opted out of promotional messages — campaigns skip this member' : 'Receives promotional messages'}
      actions={<>
        {can('members.write') && <label className="check" style={{ fontSize: 13 }}><input type="checkbox" checked={!m.marketing_opt_out} disabled={consent.isPending} onChange={(e) => consent.mutate(!e.target.checked)} />Promotions</label>}
        {can('communications.log') && <Button size="sm" variant="primary" icon={<MessageCircle />} onClick={() => actions.contact({ memberId: m.id, name: m.full_name })}>Contact</Button>}
      </>}>
      {!can('communications.log') ? <Empty title="You don't have access to communication logs" /> : !data ? <Skeleton h={160} /> : !data.data.length ? <Empty title="No communication yet" /> : (
        <div className="feed">{data.data.map((c) => (
          <div className="feed-item" key={c.id}>
            <div className="ic">{channelIcon(c.channel)}</div>
            <div>
              <div className="txt"><b>{CHANNEL_LABEL[c.channel]}</b>{c.template_name ? ` · ${c.template_name}` : ''}{c.outcome ? ` · ${OUTCOME_LABEL[c.outcome] ?? c.outcome}` : ''}
                {c.status && c.status !== 'logged' && <span className={`badge ${c.status === 'queued' ? 'warning' : c.status === 'failed' ? 'danger' : 'neutral'}`} style={{ marginLeft: 6 }}>{c.status}</span>}</div>
              {c.body && <div className="muted" style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{c.body}</div>}
              <div className="when">{dateTime(c.created_at)} · {c.logged_by_name}</div>
            </div>
          </div>
        ))}</div>
      )}
    </Card>
  );
}

function AttendanceTab({ m }: { m: any }) {
  const { data } = useQuery({ queryKey: ['attendance', { memberId: m.id }], queryFn: () => api.get<Paged<any>>('/attendance', { memberId: m.id, pageSize: 100 }) });
  // Last 12 weeks as a compact visit calendar.
  const days = Array.from({ length: 84 }, (_, i) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 83 + i); return d; });
  const visited = new Set((data?.data ?? []).filter((a) => a.status !== 'denied').map((a) => new Date(a.checked_in_at).toDateString()));
  return (
    <div className="grid g-2">
      <Card title="Last 12 weeks" icon={<DoorOpen />} sub={`${m.balance?.visits_30d ?? 0} visits in the last 30 days · ${m.balance?.visits_total ?? 0} all time`}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gridAutoFlow: 'column', gridTemplateRows: 'repeat(7, 14px)', gap: 3 }}>
          {days.map((d) => <span key={d.toISOString()} title={`${d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}${visited.has(d.toDateString()) ? ' · visited' : ''}`}
            style={{ borderRadius: 3, background: visited.has(d.toDateString()) ? 'var(--gold-2)' : 'var(--surface-3)' }} />)}
        </div>
      </Card>
      <Card title="Check-ins" icon={<DoorOpen />} bodyClass="">
        {!data ? <div style={{ padding: 20 }}><Skeleton h={200} /></div> : !data.data.length ? <Empty title="No visits yet" /> : (
          <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto', marginTop: 6 }}><table className="tbl"><tbody>{data.data.map((a) => (
            <tr key={a.id}><td>{dateTime(a.checked_in_at)}</td><td className="muted">{a.checked_out_at ? `out ${new Date(a.checked_out_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}` : ''}</td>
              <td>{a.status === 'allowed' ? <span className="badge success">Allowed</span> : <span className={`badge ${a.status === 'override' ? 'warning' : 'danger'}`} title={a.reason}>{a.status === 'override' ? 'Override' : 'Denied'}</span>}</td><td className="muted">{a.branch_name}</td></tr>
          ))}</tbody></table></div>
        )}
      </Card>
    </div>
  );
}

function ClassesTab({ m }: { m: any }) {
  const { can } = useAuth();
  const [booking, setBooking] = useState(false);
  const { data } = useQuery({ queryKey: ['member-classes', m.id], queryFn: () => api.get<any[]>(`/members/${m.id}/classes`) });
  return (
    <Card title="Class bookings" icon={<Users />} actions={can('classes.book') && <Button size="sm" icon={<CalendarPlus />} onClick={() => setBooking(true)}>Book class</Button>} bodyClass="">
      {!data ? <div style={{ padding: 20 }}><Skeleton h={200} /></div> : !data.length ? <Empty title="No class bookings yet" /> : (
        <div className="table-wrap" style={{ marginTop: 6 }}><table className="tbl">
          <thead><tr><th>Class</th><th>When</th><th>Trainer</th><th>Status</th><th>Booked via</th></tr></thead>
          <tbody>{data.map((b) => (
            <tr key={b.id}><td style={{ fontWeight: 700 }}><Link to={`/classes?session=${b.session_id}`}>{b.class_name}</Link></td><td className="muted">{dateTime(b.starts_at)}</td><td className="muted">{b.trainer_name ?? '—'}</td><td><BookingBadge status={b.status} /></td><td className="muted">{b.source === 'app' ? 'App' : 'Desk'}</td></tr>
          ))}</tbody>
        </table></div>
      )}
      {booking && <BookClassDialog memberId={m.id} memberName={m.full_name} onClose={() => setBooking(false)} />}
    </Card>
  );
}

function PtTab({ m }: { m: any }) {
  const { can } = useAuth();
  const [selling, setSelling] = useState(false);
  const [booking, setBooking] = useState<any>(null);
  const { data } = useQuery({ queryKey: ['pt-packages-of', m.id], queryFn: () => api.get<any[]>('/pt/member-packages', { memberId: m.id }) });
  const { data: sessions } = useQuery({ queryKey: ['appointments', { memberId: m.id, type: 'pt' }], queryFn: () => api.get<any[]>('/appointments', { memberId: m.id, type: 'pt', limit: 60 }) });
  return (
    <div className="stack">
      <Card title="PT packages" icon={<Dumbbell />} actions={can('pt.sell') && <Button size="sm" variant="primary" icon={<Dumbbell />} onClick={() => setSelling(true)}>Sell PT package</Button>}>
        {!data ? <Skeleton h={120} /> : !data.length ? <Empty title="No PT packages" /> : (
          <div className="stack" style={{ gap: 8 }}>{data.map((p) => (
            <div key={p.id} className="ms-card">
              <div>
                <div className="row wrap"><b>{p.package_name}</b><PkgBadge status={p.effective_status} /></div>
                <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>{p.trainer_name ?? 'No trainer'} · {date(p.starts_on)} – {date(p.expires_on)}</div>
              </div>
              {p.effective_status === 'active' && can('appointments.manage') && p.sessions_remaining - p.sessions_booked > 0 && (
                <Button size="sm" icon={<CalendarPlus />} onClick={() => setBooking({ type: 'pt', memberId: m.id, memberName: m.full_name, memberPtPackageId: p.id, staffId: p.trainer_id ?? undefined })}>Book session</Button>
              )}
              <div className="progress"><PackageProgress used={p.sessions_used} booked={p.sessions_booked} total={p.sessions_total} /><div className="faint num" style={{ fontSize: 12, marginTop: 4 }}>{p.sessions_used} used · {p.sessions_booked} booked · {Math.max(0, p.sessions_remaining - p.sessions_booked)} left to book</div></div>
            </div>
          ))}</div>
        )}
      </Card>
      <Card title="Sessions" icon={<CalendarClock />} bodyClass="">
        {!sessions ? <div style={{ padding: 20 }}><Skeleton h={160} /></div> : !sessions.length ? <Empty title="No PT sessions yet" /> : (
          <div className="table-wrap" style={{ marginTop: 6 }}><table className="tbl">
            <tbody>{sessions.map((a) => (
              <tr key={a.id}><td className="muted" style={{ whiteSpace: 'nowrap' }}>{dateTime(a.starts_at)}</td><td>{a.staff_name ?? '—'}</td>
                <td><span className={`badge ${APPT_STATUS_TONE[a.status]}`}>{APPT_STATUS_LABEL[a.status]}</span></td>
                <td className="muted" style={{ maxWidth: 320 }}>{a.outcome_notes ?? a.notes ?? ''}</td><td className="r"><AppointmentActions appt={a} /></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {selling && <SellPtDialog memberId={m.id} memberName={m.full_name} onClose={() => setSelling(false)} />}
      {booking && <AppointmentDialog preset={booking} onClose={() => setBooking(null)} />}
    </div>
  );
}

function AppointmentsTab({ m }: { m: any }) {
  const { can } = useAuth();
  const [booking, setBooking] = useState(false);
  const { data } = useQuery({ queryKey: ['appointments', { memberId: m.id }], queryFn: () => api.get<any[]>('/appointments', { memberId: m.id, limit: 100 }) });
  return (
    <Card title="Appointments" icon={<CalendarClock />} actions={can('appointments.manage') && <Button size="sm" icon={<CalendarPlus />} onClick={() => setBooking(true)}>Book</Button>} bodyClass="">
      {!data ? <div style={{ padding: 20 }}><Skeleton h={200} /></div> : !data.length ? <Empty title="No appointments yet" /> : (
        <div className="table-wrap" style={{ marginTop: 6 }}><table className="tbl">
          <thead><tr><th>When</th><th>Type</th><th>With</th><th>Status</th><th>Notes</th><th /></tr></thead>
          <tbody>{data.map((a) => (
            <tr key={a.id}><td className="muted" style={{ whiteSpace: 'nowrap' }}>{dateTime(a.starts_at)}</td><td style={{ fontWeight: 700 }}>{APPT_LABEL[a.type]}</td><td className="muted">{a.staff_name ?? '—'}</td>
              <td><span className={`badge ${APPT_STATUS_TONE[a.status]}`}>{APPT_STATUS_LABEL[a.status]}</span></td><td className="muted">{a.outcome_notes ?? a.notes ?? ''}</td><td className="r"><AppointmentActions appt={a} /></td></tr>
          ))}</tbody>
        </table></div>
      )}
      {booking && <AppointmentDialog preset={{ memberId: m.id, memberName: m.full_name, type: 'assessment' }} onClose={() => setBooking(false)} />}
    </Card>
  );
}

export function MemberProfile() {
  const { id } = useParams();
  const { can } = useAuth();
  const actions = useActions();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'overview';
  const setTab = (t: Tab) => setParams(t === 'overview' ? {} : { tab: t }, { replace: true });
  const { data: m, error } = useQuery({ queryKey: ['member', id], queryFn: () => api.get<any>(`/members/${id}`) });
  if (error) return <div className="page"><Empty title="Member not found"><Link to="/members" className="btn">Back to members</Link></Empty></div>;
  if (!m) return <div className="page"><Skeleton h={120} /><Skeleton h={320} /></div>;
  const cm = m.current_membership;
  const due = m.balance?.outstanding ?? 0;
  return (
    <div className="page">
      <Link to="/members" className="btn ghost sm" style={{ alignSelf: 'flex-start' }}><ArrowLeft />Members</Link>
      <section className="card glow">
        <div className="profile-hero">
          <Avatar name={m.full_name} size="lg" />
          <div className="who">
            <div className="row wrap"><h1>{m.full_name}</h1><StatusBadge status={cm?.status ?? 'none'} /></div>
            <div className="muted" style={{ marginTop: 3 }}>{m.member_code} · {m.branch_name} · member since {date(m.join_date)}</div>
            <div className="row wrap" style={{ marginTop: 12 }}>
              {can('payments.create') && <Button variant="primary" size="sm" icon={<CreditCard />} onClick={() => actions.recordPayment({ memberId: m.id, memberName: m.full_name })}>Record payment</Button>}
              {can('memberships.manage') && <Button size="sm" icon={<RefreshCw />} onClick={() => actions.sellMembership({ memberId: m.id, memberName: m.full_name, planId: cm?.plan_id })}>{cm && cm.status !== 'none' ? 'Renew' : 'Sell membership'}</Button>}
              {can('memberships.manage') && cm?.status === 'active' && <Button size="sm" icon={<Snowflake />} onClick={() => setTab('membership')}>Freeze</Button>}
              {can('members.write') && <Button size="sm" icon={<Pencil />} onClick={() => actions.editMember(m)}>Edit</Button>}
              {can('communications.log') && <Button size="sm" icon={<MessageCircle />} onClick={() => actions.contact({ memberId: m.id, name: m.full_name, defaultTemplate: cm?.status === 'expired' ? 'membership_expired' : cm?.status === 'expiring_soon' ? 'renewal_reminder' : undefined })}>Contact</Button>}
              {m.phone && <a className="btn sm" href={`tel:${m.phone}`}><Phone />Call</a>}
              {can('followups.manage') && <Button size="sm" icon={<CalendarClock />} onClick={() => actions.followUp({ memberId: m.id, name: m.full_name })}>Follow-up</Button>}
            </div>
          </div>
          <div className="facts">
            <div className="fact"><div className="k">Expiry</div><div className="v">{cm?.end_date ? date(cm.end_date) : '—'}</div><div className="faint" style={{ fontSize: 12 }}>{cm?.end_date ? daysLabel(cm.days_remaining) : ''}</div></div>
            <div className="fact"><div className="k">Outstanding</div><div className="v" style={{ color: due > 0 ? 'var(--warning)' : undefined }}>{money(due)}</div></div>
            <div className="fact"><div className="k">Lifetime value</div><div className="v gold-text">{money(m.balance?.lifetime_value)}</div></div>
            <div className="fact"><div className="k">Last visit</div><div className="v">{m.balance?.last_visit_at ? relative(m.balance.last_visit_at) : 'Never'}</div><div className="faint" style={{ fontSize: 12 }}>{m.balance?.visits_30d ?? 0} visits / 30d</div></div>
          </div>
        </div>
      </section>
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { key: 'overview', label: 'Overview' }, { key: 'membership', label: 'Membership' }, { key: 'attendance', label: 'Attendance' },
        ...(can('assessments.read') ? [{ key: 'fitness' as Tab, label: 'Fitness' }] : []), ...(can('workouts.read') ? [{ key: 'workout' as Tab, label: 'Workout' }] : []), ...(can('nutrition.read') ? [{ key: 'nutrition' as Tab, label: 'Nutrition' }] : []),
        { key: 'classes', label: 'Classes' }, { key: 'pt', label: 'PT' }, { key: 'appointments', label: 'Appointments' }, { key: 'payments', label: 'Payments' },
        { key: 'invoices', label: 'Invoices' }, { key: 'loyalty', label: 'Loyalty' }, { key: 'followups', label: 'Follow-ups' }, { key: 'communication', label: 'Communication' },
        { key: 'app', label: 'App account' }, { key: 'activity', label: 'Activity' },
      ]} />
      {tab === 'overview' && <Overview m={m} onTab={setTab} />}
      {tab === 'membership' && <MembershipTab m={m} />}
      {tab === 'fitness' && <FitnessTab m={m} />}
      {tab === 'workout' && <WorkoutTab m={m} />}
      {tab === 'nutrition' && <NutritionTab m={m} />}
      {tab === 'loyalty' && <LoyaltyTab m={m} />}
      {tab === 'payments' && <PaymentsTab m={m} />}
      {tab === 'invoices' && <InvoicesTab m={m} />}
      {tab === 'attendance' && <AttendanceTab m={m} />}
      {tab === 'classes' && <ClassesTab m={m} />}
      {tab === 'pt' && <PtTab m={m} />}
      {tab === 'appointments' && <AppointmentsTab m={m} />}
      {tab === 'followups' && <FollowUpsTab m={m} />}
      {tab === 'communication' && <CommunicationTab m={m} />}
      {tab === 'app' && <AppTab m={m} />}
      {tab === 'activity' && <ActivityTab m={m} />}
    </div>
  );
}

