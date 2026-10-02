import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarPlus, Dumbbell } from 'lucide-react';
import { api, ApiError, openPdf } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/ui';
import { money } from '../../lib/format';
import { Alert, Button, Dialog, Field, StatusBadge } from '../../components/ui';
import { MemberPicker, MethodPicker, referenceLabel, referenceRequired, type MemberPick } from '../shared';

export const APPT_TYPES = ['pt', 'assessment', 'nutrition', 'trial', 'consultation', 'other'] as const;
export const APPT_LABEL: Record<string, string> = {
  pt: 'PT session', nutrition: 'Nutrition consult', assessment: 'Fitness assessment', trial: 'Trial session', consultation: 'Consultation', other: 'Other',
};
export const APPT_DURATION: Record<string, number> = { pt: 60, nutrition: 40, assessment: 45, trial: 45, consultation: 30, other: 30 };
export const APPT_STATUS_TONE: Record<string, string> = { scheduled: 'accent', completed: 'success', no_show: 'danger', cancelled: 'neutral' };
export const APPT_STATUS_LABEL: Record<string, string> = { scheduled: 'Scheduled', completed: 'Completed', no_show: 'No-show', cancelled: 'Cancelled' };
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
export const ymd = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
export const timeLabel = (d: string | Date) => new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

export function nextSlot(hour = 10) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d;
}

export interface AppointmentPreset {
  memberId?: string; memberName?: string; leadId?: string; leadName?: string; type?: string; staffId?: string; startsAt?: Date; memberPtPackageId?: string;
}

/** Book (or edit) an appointment with live availability and conflict handling. */
export function AppointmentDialog({ preset, appointment, onClose }: { preset?: AppointmentPreset; appointment?: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const editing = !!appointment;
  const [type, setType] = useState<string>(appointment?.type ?? preset?.type ?? 'pt');
  const [member, setMember] = useState<MemberPick | null>(
    appointment?.member_id ? { id: appointment.member_id, full_name: appointment.client_name, member_code: appointment.member_code ?? '' }
      : preset?.memberId ? { id: preset.memberId, full_name: preset.memberName ?? 'Member', member_code: '' } : null,
  );
  const leadId = appointment?.lead_id ?? preset?.leadId;
  const [staffId, setStaffId] = useState(appointment?.staff_id ?? preset?.staffId ?? '');
  const [startsAt, setStartsAt] = useState(localInput(appointment ? new Date(appointment.starts_at) : preset?.startsAt ?? nextSlot()));
  const [duration, setDuration] = useState(appointment ? Math.round((Date.parse(appointment.ends_at) - Date.parse(appointment.starts_at)) / 60000) : APPT_DURATION[preset?.type ?? 'pt']);
  const [packageId, setPackageId] = useState(appointment?.member_pt_package_id ?? preset?.memberPtPackageId ?? '');
  const [location, setLocation] = useState(appointment?.location ?? '');
  const [notes, setNotes] = useState(appointment?.notes ?? '');
  const [conflicts, setConflicts] = useState<{ message: string }[] | null>(null);
  const [error, setError] = useState('');

  const { data: staff } = useQuery({ queryKey: ['appt-staff'], queryFn: () => api.get<any[]>('/appointments/staff') });
  const { data: packages } = useQuery({
    queryKey: ['pt-packages-of', member?.id],
    queryFn: () => api.get<any[]>('/pt/member-packages', { memberId: member!.id }),
    enabled: !!member && type === 'pt',
  });
  const usable = (packages ?? []).filter((p) => p.effective_status === 'active');
  useEffect(() => {
    if (type === 'pt' && !packageId && usable.length) {
      setPackageId(usable[0].id);
      if (!staffId && usable[0].trainer_id) setStaffId(usable[0].trainer_id);
    }
  }, [type, usable, packageId, staffId]);
  const date = startsAt.slice(0, 10);
  const { data: avail } = useQuery({
    queryKey: ['availability', staffId, date],
    queryFn: () => api.get<{ windows: any[]; busy: any[] }>('/appointments/availability', { staffId, date }),
    enabled: !!staffId && !!date,
  });
  const roleFilter = useMemo(() => (type === 'pt' || type === 'assessment' || type === 'trial' ? ['trainer'] : type === 'nutrition' ? ['nutritionist'] : null), [type]);
  const staffOptions = (staff ?? []).filter((s) => s.is_bookable && (!roleFilter || roleFilter.includes(s.role_key)));
  const pkg = usable.find((p) => p.id === packageId);

  const save = useMutation({
    mutationFn: (force: boolean) => {
      const body = { staffId: staffId || null, startsAt: new Date(startsAt).toISOString(), durationMin: duration, location: location || null, notes: notes || null, force };
      return editing
        ? api.patch(`/appointments/${appointment.id}`, body)
        : api.post('/appointments', { ...body, type, memberId: leadId ? null : member?.id, leadId: leadId ?? null, memberPtPackageId: type === 'pt' ? packageId || null : null });
    },
    onSuccess: () => {
      qc.invalidateQueries();
      toast('success', editing ? 'Appointment updated' : `${APPT_LABEL[type]} booked`);
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'schedule_conflict') setConflicts(e.details as any);
      else setError(e instanceof ApiError ? e.message : 'Failed');
    },
  });
  const submit = (force = false) => { setError(''); setConflicts(null); save.mutate(force); };

  return (
    <Dialog open onClose={onClose} title={editing ? 'Reschedule appointment' : 'Book appointment'} sub={leadId ? `Trial for lead ${preset?.leadName ?? appointment?.client_name ?? ''}` : undefined}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={<CalendarPlus />} loading={save.isPending} disabled={(!member && !leadId) || (type === 'pt' && !packageId)} onClick={() => submit(false)}>{editing ? 'Save' : 'Book'}</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        {conflicts && (
          <div className="summary-box" style={{ borderColor: 'var(--warning)' }}>
            <div className="row" style={{ color: 'var(--warning)', fontWeight: 700 }}><AlertTriangle size={16} />Scheduling conflict</div>
            {conflicts.map((c, i) => <div key={i} className="muted">{c.message}</div>)}
            <div><Button size="sm" onClick={() => submit(true)}>Book anyway</Button></div>
          </div>
        )}
        {!editing && !leadId && (
          <Field label="Type">
            <div className="chips">{APPT_TYPES.filter((t) => t !== 'trial').map((t) => (
              <button type="button" key={t} className={`chip ${type === t ? 'on' : ''}`} onClick={() => { setType(t); setDuration(APPT_DURATION[t]); }}>{APPT_LABEL[t]}</button>
            ))}</div>
          </Field>
        )}
        {!leadId && !editing && <Field label="Member"><MemberPicker value={member} onChange={(m) => { setMember(m); setPackageId(''); }} /></Field>}
        {type === 'pt' && member && !editing && (
          <Field label="PT package">
            {!packages ? <div className="faint">Loading…</div> : !usable.length ? <Alert tone="warning">No active PT package. Sell one first.</Alert> : (
              <div className="stack" style={{ gap: 6 }}>{usable.map((p) => (
                <button type="button" key={p.id} className={`plan-option ${packageId === p.id ? 'on' : ''}`} onClick={() => { setPackageId(p.id); if (p.trainer_id) setStaffId(p.trainer_id); }}>
                  <div className="row between"><span className="pn">{p.package_name}</span><span className="badge accent">{p.sessions_remaining - p.sessions_booked} to book</span></div>
                  <div className="pd">{p.sessions_used}/{p.sessions_total} used · {p.sessions_booked} booked · expires {p.expires_on}{p.trainer_name ? ` · ${p.trainer_name}` : ''}</div>
                </button>
              ))}</div>
            )}
          </Field>
        )}
        <div className="form-grid">
          <Field label="With">
            <select className="select" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
              <option value="">Unassigned</option>
              {staffOptions.map((s) => <option key={s.id} value={s.id}>{s.full_name} · {s.role_name}</option>)}
            </select>
          </Field>
          <Field label="Duration (min)"><input className="input num" type="number" min={10} step={5} value={duration} onChange={(e) => setDuration(Number(e.target.value))} /></Field>
          <Field label="Starts" className="full"><input className="input" type="datetime-local" step={900} value={startsAt} onChange={(e) => setStartsAt(e.target.value)} /></Field>
        </div>
        {staffId && avail && (
          <div className="summary-box" style={{ gap: 4 }}>
            <div className="faint" style={{ fontSize: 12, fontWeight: 700 }}>
              {new Date(date).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' })} · works {avail.windows.length ? avail.windows.map((w) => `${w.start}–${w.end}`).join(', ') : 'no hours set'}
            </div>
            {avail.busy.length ? avail.busy.map((b, i) => <div key={i} style={{ fontSize: 12.5 }} className="muted">Busy {timeLabel(b.starts_at)}–{timeLabel(b.ends_at)} · {b.title}</div>) : <div className="faint" style={{ fontSize: 12.5 }}>Nothing else booked that day.</div>}
          </div>
        )}
        {pkg && <div className="faint" style={{ fontSize: 12.5 }}><Dumbbell size={12} style={{ verticalAlign: -1 }} /> Uses 1 of {pkg.sessions_remaining - pkg.sessions_booked} unbooked sessions when completed (or on a no-show).</div>}
        <div className="form-grid">
          <Field label="Location"><input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. PT floor" /></Field>
          <Field label="Notes"><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
      </div>
    </Dialog>
  );
}

/** Sell a PT package: raises the invoice and optionally records payment. */
export function SellPtDialog({ memberId, memberName, onClose }: { memberId?: string; memberName?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [member, setMember] = useState<MemberPick | null>(memberId ? { id: memberId, full_name: memberName ?? 'Member', member_code: '' } : null);
  const [packageId, setPackageId] = useState('');
  const [trainerId, setTrainerId] = useState('');
  const [discount, setDiscount] = useState(0);
  const [collect, setCollect] = useState(can('payments.create'));
  const [amount, setAmount] = useState<number | ''>('');
  const [method, setMethod] = useState('upi');
  const [reference, setReference] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState<any>(null);
  const { data: packages } = useQuery({ queryKey: ['pt-catalog'], queryFn: () => api.get<any[]>('/pt/packages') });
  const { data: trainers } = useQuery({ queryKey: ['pt-trainers'], queryFn: () => api.get<any[]>('/pt/trainers') });
  const pkg = packages?.find((p) => p.id === packageId);
  const total = pkg ? Math.round((pkg.price - discount) * (1 + pkg.tax_rate / 100) * 100) / 100 : 0;
  const m = useMutation({
    mutationFn: () => api.post<any>('/pt/member-packages', {
      memberId: member!.id, packageId, trainerId: trainerId || null, discount,
      payment: collect && Number(amount || total) > 0 ? { amount: Number(amount || total), method, reference: reference || null } : null,
    }),
    onSuccess: (r) => { qc.invalidateQueries(); toast('success', `${pkg?.name} sold · ${r.invoice.invoice_number}`); setDone(r); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Failed'),
  });
  if (done) {
    return (
      <Dialog open onClose={onClose} title="PT package sold" footer={<><Button onClick={() => openPdf(`/invoices/${done.invoice.id}/pdf`)}>Print invoice</Button><Button variant="primary" onClick={onClose}>Done</Button></>}>
        <div className="summary-box">
          <div className="line"><span>Package</span><b>{done.package.package_name}</b></div>
          <div className="line"><span>Valid until</span><b>{done.package.expires_on}</b></div>
          <div className="line"><span>Status</span><StatusBadge status={done.package.effective_status === 'pending' ? 'pending' : 'active'} /></div>
          <div className="line total"><span>Balance due</span><span>{money(done.invoice.total - done.invoice.amount_paid, true)}</span></div>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog open onClose={onClose} title="Sell PT package" sub="Sessions are counted from completed appointments — never edited by hand."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!member || !pkg} loading={m.isPending} onClick={() => { setError(''); m.mutate(); }}>{collect ? `Sell & collect ${money(Number(amount || total))}` : 'Sell package'}</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <Field label="Member"><MemberPicker value={member} onChange={setMember} /></Field>
        <div className="plan-options">{packages?.filter((p) => p.status === 'active').map((p) => (
          <button type="button" key={p.id} className={`plan-option ${packageId === p.id ? 'on' : ''}`} onClick={() => { setPackageId(p.id); setAmount(''); }}>
            <div className="pn">{p.name}</div><div className="pp">{money(p.price)}</div>
            <div className="pd">{money(p.price / p.sessions)}/session · valid {p.validity_days} days</div>
          </button>
        ))}</div>
        <div className="form-grid">
          <Field label="Trainer"><select className="select" value={trainerId} onChange={(e) => setTrainerId(e.target.value)}>
            <option value="">Assign later</option>{trainers?.filter((t) => t.role_name === 'Trainer').map((t) => <option key={t.id} value={t.id}>{t.full_name} · {t.active_clients} clients</option>)}
          </select></Field>
          <Field label="Discount"><div className="input-prefix"><span>₹</span><input className="input num" type="number" min={0} value={discount} onChange={(e) => setDiscount(Number(e.target.value))} /></div></Field>
        </div>
        {pkg && <div className="summary-box"><div className="line total"><span>Total incl. GST</span><span>{money(total, true)}</span></div></div>}
        {pkg && can('payments.create') && <label className="check"><input type="checkbox" checked={collect} onChange={(e) => setCollect(e.target.checked)} />Collect payment now</label>}
        {pkg && collect && (
          <>
            <MethodPicker value={method} onChange={setMethod} />
            <div className="form-grid">
              <Field label="Amount"><div className="input-prefix"><span>₹</span><input className="input num" type="number" value={amount} placeholder={String(total)} onChange={(e) => setAmount(e.target.value === '' ? '' : Number(e.target.value))} /></div></Field>
              <Field label={referenceLabel(method)} hint={referenceRequired(method) ? 'Required' : 'Optional'}><input className="input" value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** Complete / no-show / cancel an appointment. */
export function AppointmentActions({ appt, onDone }: { appt: any; onDone?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [mode, setMode] = useState<null | 'complete' | 'cancel' | 'edit'>(null);
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState<'completed' | 'no_show'>('completed');
  const [reason, setReason] = useState('');
  const close = useMutation({
    mutationFn: () => (mode === 'cancel' ? api.post(`/appointments/${appt.id}/cancel`, { reason }) : api.post(`/appointments/${appt.id}/complete`, { status, outcomeNotes: notes || null })),
    onSuccess: () => { qc.invalidateQueries(); toast('success', mode === 'cancel' ? 'Appointment cancelled' : status === 'completed' ? 'Marked completed' : 'Marked no-show'); setMode(null); onDone?.(); },
    onError: (e) => toast('error', e instanceof ApiError ? e.message : 'Failed'),
  });
  if (appt.status !== 'scheduled' || !can('appointments.manage')) return null;
  const started = new Date(appt.starts_at).getTime() < Date.now() + 15 * 60_000;
  return (
    <>
      <div className="row wrap" style={{ gap: 6 }}>
        {started && <Button size="sm" variant="primary" onClick={() => setMode('complete')}>Complete</Button>}
        <Button size="sm" onClick={() => setMode('edit')}>Reschedule</Button>
        <Button size="sm" variant="ghost" onClick={() => setMode('cancel')}>Cancel</Button>
      </div>
      {mode === 'edit' && <AppointmentDialog appointment={appt} onClose={() => setMode(null)} />}
      {(mode === 'complete' || mode === 'cancel') && (
        <Dialog open onClose={() => setMode(null)} title={mode === 'cancel' ? 'Cancel appointment' : 'Close appointment'} sub={`${APPT_LABEL[appt.type]} · ${appt.client_name}`}
          footer={<><Button onClick={() => setMode(null)}>Back</Button><Button variant={mode === 'cancel' ? 'danger' : 'primary'} disabled={mode === 'cancel' && reason.trim().length < 2} loading={close.isPending} onClick={() => close.mutate()}>{mode === 'cancel' ? 'Cancel appointment' : 'Save'}</Button></>}>
          <div className="form">
            {mode === 'complete' ? (
              <>
                <div className="chips">
                  <button type="button" className={`chip ${status === 'completed' ? 'on' : ''}`} onClick={() => setStatus('completed')}>Completed</button>
                  <button type="button" className={`chip ${status === 'no_show' ? 'on' : ''}`} onClick={() => setStatus('no_show')}>No-show</button>
                </div>
                {appt.type === 'pt' && <Alert tone="info">{status === 'completed' ? 'Uses one session from the package.' : 'No-shows count as a used session (gym policy).'}</Alert>}
                <Field label={appt.type === 'pt' ? 'Session notes' : 'Notes'}><textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={appt.type === 'pt' ? 'What did you train? Any PRs or concerns?' : ''} /></Field>
              </>
            ) : (
              <Field label="Reason"><input className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Member unwell" /></Field>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
