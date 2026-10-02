import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Mail, MessageCircle, MessageSquareText, Phone, StickyNote, Users } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useToast } from '../../lib/ui';
import { Alert, Button, Dialog, Field, Segmented } from '../../components/ui';

// ---------------------------------------------------------------- labels --

export const STAGES = ['new', 'contacted', 'interested', 'trial_booked', 'trial_completed', 'negotiation', 'won', 'lost'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABEL: Record<string, string> = {
  new: 'New', contacted: 'Contacted', interested: 'Interested', trial_booked: 'Trial booked', trial_completed: 'Trial done',
  negotiation: 'Negotiation', won: 'Won', lost: 'Lost',
};
// Open stages step up in accent intensity; closed stages use the reserved status hues.
export const STAGE_COLOR: Record<string, string> = {
  new: 'color-mix(in srgb, var(--accent) 35%, var(--surface-3))',
  contacted: 'color-mix(in srgb, var(--accent) 50%, var(--surface-3))',
  interested: 'color-mix(in srgb, var(--accent) 65%, var(--surface-3))',
  trial_booked: 'color-mix(in srgb, var(--accent) 78%, var(--surface-3))',
  trial_completed: 'color-mix(in srgb, var(--accent) 88%, var(--surface-3))',
  negotiation: 'var(--accent)',
  won: 'var(--success)',
  lost: 'var(--text-3)',
};

export function StageBadge({ stage }: { stage: string }) {
  const tone = stage === 'won' ? 'success' : stage === 'lost' ? 'neutral' : 'accent';
  return <span className={`badge ${tone}`}><i className="pip" style={{ width: 7, height: 7, borderRadius: 99, background: STAGE_COLOR[stage], display: 'inline-block' }} />{STAGE_LABEL[stage] ?? stage}</span>;
}

export const FU_TYPE_LABEL: Record<string, string> = { call: 'Call', whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', in_person: 'In person', other: 'Other' };
export const PURPOSE_LABEL: Record<string, string> = { general: 'General', sales: 'Sales', trial: 'Trial', renewal: 'Renewal', payment: 'Payment', reactivation: 'Win-back', feedback: 'Feedback' };
export const OUTCOME_LABEL: Record<string, string> = {
  connected: 'Connected', no_answer: 'No answer', interested: 'Interested', not_interested: 'Not interested', callback: 'Call back later',
  converted: 'Converted', renewed: 'Renewed', paid: 'Paid', other: 'Other',
};
const CHANNEL_ICON: Record<string, ReactNode> = {
  call: <Phone />, whatsapp: <MessageCircle />, sms: <MessageSquareText />, email: <Mail />, in_person: <Users />, note: <StickyNote />, other: <CalendarClock />,
};
export const channelIcon = (c: string) => CHANNEL_ICON[c] ?? <CalendarClock />;
export const CHANNEL_LABEL: Record<string, string> = { ...FU_TYPE_LABEL, note: 'Note' };

// ------------------------------------------------------------ due presets --

function at(daysFromNow: number, hour: number) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, 0, 0, 0);
  return d;
}
const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export function DuePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const presets = [
    { label: 'In 2 hours', date: new Date(Date.now() + 2 * 3600_000) },
    { label: 'Tomorrow 10am', date: at(1, 10) },
    { label: 'In 3 days', date: at(3, 10) },
    { label: 'Next week', date: at(7, 10) },
  ];
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="chips">
        {presets.map((p) => (
          <button type="button" key={p.label} className={`chip ${value === toLocalInput(p.date) ? 'on' : ''}`} onClick={() => onChange(toLocalInput(p.date))}>{p.label}</button>
        ))}
      </div>
      <input className="input" type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
export const defaultDue = () => toLocalInput(at(1, 10));

// ------------------------------------------------------- contact composer --

export interface ContactTarget { leadId?: string; memberId?: string; name: string; defaultTemplate?: string; purpose?: string }

const CHANNELS = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'call', label: 'Call' },
  { value: 'sms', label: 'SMS' },
  { value: 'email', label: 'Email' },
  { value: 'note', label: 'Note' },
] as const;

/**
 * Compose with a template, hand off to the staff member's WhatsApp/phone/
 * mail app, and log the touchpoint (plus an optional next follow-up).
 */
export function ContactDialog({ target, onClose }: { target: ContactTarget; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [channel, setChannel] = useState<string>('whatsapp');
  const [templateKey, setTemplateKey] = useState(target.defaultTemplate ?? '');
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  const [outcome, setOutcome] = useState('connected');
  const [scheduleNext, setScheduleNext] = useState(false);
  const [next, setNext] = useState({ type: 'call', dueAt: defaultDue() });
  const [error, setError] = useState('');
  const audience = target.leadId ? 'lead' : 'member';

  const { data: templates } = useQuery({ queryKey: ['templates'], queryFn: () => api.get<{ data: any[] }>('/templates') });
  const options = useMemo(
    () => (templates?.data ?? []).filter((t) => t.is_active && (t.audience === 'any' || t.audience === audience) && (t.channel === 'any' || t.channel === channel)),
    [templates, audience, channel],
  );
  const params = target.leadId ? { leadId: target.leadId } : { memberId: target.memberId };
  const { data: composed } = useQuery({
    queryKey: ['compose', params, templateKey, channel],
    queryFn: () => api.get<any>('/templates/compose', { ...params, templateKey: templateKey || undefined, channel }),
  });
  useEffect(() => {
    if (composed) {
      setBody(composed.body);
      setSubject(composed.subject);
    }
  }, [composed]);

  const isMessage = ['whatsapp', 'sms', 'email'].includes(channel);
  const link = (() => {
    if (!composed) return null;
    const enc = encodeURIComponent(body);
    if (channel === 'whatsapp' && composed.links.whatsapp) return `${composed.links.whatsapp.split('?')[0]}${body ? `?text=${enc}` : ''}`;
    if (channel === 'sms' && composed.links.sms) return `${composed.links.sms.split('?')[0]}${body ? `?body=${enc}` : ''}`;
    if (channel === 'email' && composed.links.email) return `mailto:${composed.to.email}?subject=${encodeURIComponent(subject)}&body=${enc}`;
    if (channel === 'call') return composed.links.call;
    return null;
  })();
  const missing = composed && ((channel === 'email' && !composed.to.email) || (channel !== 'email' && channel !== 'note' && !composed.to.phone));

  const log = useMutation({
    mutationFn: () =>
      api.post('/communications', {
        ...params,
        channel,
        direction: channel === 'note' ? 'internal' : 'outbound',
        templateKey: isMessage ? templateKey || null : null,
        subject: channel === 'email' ? subject : null,
        body: body || null,
        outcome: channel === 'call' ? outcome : null,
        followUp: scheduleNext ? { type: next.type, dueAt: new Date(next.dueAt).toISOString(), purpose: target.purpose ?? (target.leadId ? 'sales' : 'general') } : null,
      }),
    onSuccess: () => {
      qc.invalidateQueries();
      toast('success', channel === 'note' ? 'Note saved' : `${CHANNEL_LABEL[channel]} logged for ${target.name}`);
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not log'),
  });

  const primaryLabel = channel === 'whatsapp' ? 'Open WhatsApp & log' : channel === 'sms' ? 'Open SMS & log' : channel === 'email' ? 'Open email & log' : channel === 'call' ? 'Log call' : 'Save note';
  const submit = () => {
    if (link && isMessage) window.open(link, '_blank', 'noopener');
    log.mutate();
  };

  return (
    <Dialog open onClose={onClose} title={`Contact ${target.name}`} sub={composed ? [composed.to.phone, composed.to.email].filter(Boolean).join(' · ') : undefined}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!!missing && channel !== 'call'} loading={log.isPending} onClick={submit}>{primaryLabel}</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <Segmented value={channel} onChange={(c) => { setChannel(c); setTemplateKey(c === 'whatsapp' || c === 'sms' || c === 'email' ? templateKey : ''); }} options={CHANNELS.map((c) => ({ value: c.value, label: c.label }))} />
        {missing && <Alert tone="warning">No {channel === 'email' ? 'email address' : 'phone number'} on file.</Alert>}
        {isMessage && (
          <Field label="Template">
            <select className="select" value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}>
              <option value="">Write your own</option>
              {options.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
            </select>
          </Field>
        )}
        {channel === 'email' && <Field label="Subject"><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>}
        {channel === 'call' && (
          <>
            {link && <a className="btn" href={link}><Phone />Call {composed?.to.phone}</a>}
            <Field label="Outcome">
              <select className="select" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                {['connected', 'no_answer', 'interested', 'not_interested', 'callback'].map((o) => <option key={o} value={o}>{OUTCOME_LABEL[o]}</option>)}
              </select>
            </Field>
          </>
        )}
        <Field label={isMessage ? 'Message' : 'Notes'} hint={isMessage ? 'Sent from your own app — the CRM keeps a copy.' : undefined}>
          <textarea className="textarea" style={{ minHeight: isMessage ? 120 : 80 }} value={body} onChange={(e) => setBody(e.target.value)} placeholder={channel === 'call' ? 'What did you discuss?' : ''} />
        </Field>
        {channel !== 'note' && (
          <label className="check"><input type="checkbox" checked={scheduleNext} onChange={(e) => setScheduleNext(e.target.checked)} />Schedule a follow-up</label>
        )}
        {scheduleNext && (
          <div className="form-grid">
            <Field label="Type"><select className="select" value={next.type} onChange={(e) => setNext({ ...next, type: e.target.value })}>
              {Object.entries(FU_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></Field>
            <Field label="When" className="full"><DuePicker value={next.dueAt} onChange={(v) => setNext({ ...next, dueAt: v })} /></Field>
          </div>
        )}
      </div>
    </Dialog>
  );
}

// -------------------------------------------------------------- follow-ups --

export function FollowUpDialog({ target, onClose }: { target: ContactTarget; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ type: 'call', purpose: target.purpose ?? (target.leadId ? 'sales' : 'general'), dueAt: defaultDue(), notes: '', assignedTo: '' });
  const [error, setError] = useState('');
  const { data: staff } = useQuery({ queryKey: ['staff-min'], queryFn: () => api.get<any>('/admin/staff', { pageSize: 100 }), retry: false });
  const m = useMutation({
    mutationFn: () => api.post('/follow-ups', {
      leadId: target.leadId ?? null, memberId: target.memberId ?? null, type: f.type, purpose: f.purpose,
      dueAt: new Date(f.dueAt).toISOString(), notes: f.notes || null, assignedTo: f.assignedTo || null,
    }),
    onSuccess: () => { qc.invalidateQueries(); toast('success', 'Follow-up scheduled'); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Failed'),
  });
  return (
    <Dialog open onClose={onClose} title="Schedule follow-up" sub={target.name}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Schedule</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <div className="form-grid">
          <Field label="Type"><select className="select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            {Object.entries(FU_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></Field>
          <Field label="Purpose"><select className="select" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })}>
            {Object.entries(PURPOSE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></Field>
          <Field label="When" className="full"><DuePicker value={f.dueAt} onChange={(v) => setF({ ...f, dueAt: v })} /></Field>
          {staff && (
            <Field label="Assign to" className="full"><select className="select" value={f.assignedTo} onChange={(e) => setF({ ...f, assignedTo: e.target.value })}>
              <option value="">Default (owner of this record)</option>
              {staff.data.filter((s: any) => s.is_active).map((s: any) => <option key={s.id} value={s.id}>{s.full_name} · {s.role_name}</option>)}
            </select></Field>
          )}
          <Field label="Notes" className="full"><textarea className="textarea" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        </div>
      </div>
    </Dialog>
  );
}

export function CompleteFollowUpDialog({ followUp, onClose }: { followUp: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [outcome, setOutcome] = useState(followUp.purpose === 'renewal' ? 'connected' : 'connected');
  const [notes, setNotes] = useState('');
  const [scheduleNext, setScheduleNext] = useState(false);
  const [next, setNext] = useState({ type: followUp.type, dueAt: defaultDue() });
  const [error, setError] = useState('');
  useEffect(() => {
    if (['no_answer', 'callback'].includes(outcome)) setScheduleNext(true);
  }, [outcome]);
  const m = useMutation({
    mutationFn: () => api.post(`/follow-ups/${followUp.id}/complete`, {
      outcome, notes: notes || null, next: scheduleNext ? { type: next.type, dueAt: new Date(next.dueAt).toISOString() } : null,
    }),
    onSuccess: () => { qc.invalidateQueries(); toast('success', scheduleNext ? 'Done · next follow-up scheduled' : 'Follow-up completed'); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Failed'),
  });
  const outcomes = followUp.member_id
    ? ['connected', 'no_answer', 'callback', 'renewed', 'paid', 'not_interested', 'other']
    : ['connected', 'no_answer', 'interested', 'callback', 'not_interested', 'other'];
  return (
    <Dialog open onClose={onClose} title="Complete follow-up" sub={`${FU_TYPE_LABEL[followUp.type]} · ${followUp.subject_name ?? ''}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Complete</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        {followUp.notes && <Alert tone="info">{followUp.notes}</Alert>}
        <Field label="Outcome">
          <div className="chips">{outcomes.map((o) => <button type="button" key={o} className={`chip ${outcome === o ? 'on' : ''}`} onClick={() => setOutcome(o)}>{OUTCOME_LABEL[o]}</button>)}</div>
        </Field>
        <Field label="Notes"><textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What happened?" /></Field>
        <label className="check"><input type="checkbox" checked={scheduleNext} onChange={(e) => setScheduleNext(e.target.checked)} />Schedule the next follow-up</label>
        {scheduleNext && (
          <div className="form-grid">
            <Field label="Type"><select className="select" value={next.type} onChange={(e) => setNext({ ...next, type: e.target.value })}>
              {Object.entries(FU_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></Field>
            <Field label="When" className="full"><DuePicker value={next.dueAt} onChange={(v) => setNext({ ...next, dueAt: v })} /></Field>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** "Overdue 2d" / "Today 4:30 pm" / "Fri 10:00 am" with tone. */
export function dueLabel(due: string) {
  const d = new Date(due);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  if (d < startToday) {
    const days = Math.ceil((startToday.getTime() - d.getTime()) / 86400000);
    return { text: `Overdue ${days}d`, tone: 'danger' };
  }
  const diffDays = Math.floor((d.getTime() - startToday.getTime()) / 86400000);
  if (diffDays === 0) return { text: d < now ? `Due ${time}` : `Today ${time}`, tone: d < now ? 'danger' : 'warning' };
  if (diffDays === 1) return { text: `Tomorrow ${time}`, tone: 'neutral' };
  return { text: d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }), tone: 'neutral' };
}

export function DueBadge({ due }: { due: string | null | undefined }) {
  if (!due) return <span className="badge neutral">No follow-up</span>;
  const { text, tone } = dueLabel(due);
  return <span className={`badge ${tone}`}><CalendarClock />{text}</span>;
}
