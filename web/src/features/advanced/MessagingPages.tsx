import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, Clock, ExternalLink, Mail, MessageCircle, Pencil, Play, Plus, PlugZap, RotateCcw, Smartphone, Trash2, Workflow, X, Zap } from 'lucide-react';
import { api, ApiError, type Paged } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/ui';
import { dateTime, relative } from '../../lib/format';
import { Alert, Button, Card, Dialog, Empty, Field, Pagination, Person, Skeleton } from '../../components/ui';
import { MemberPicker, type MemberPick } from '../shared';

const CH: Record<string, { label: string; icon: ReactNode }> = {
  whatsapp: { label: 'WhatsApp', icon: <MessageCircle size={15} /> }, sms: { label: 'SMS', icon: <Smartphone size={15} /> },
  email: { label: 'Email', icon: <Mail size={15} /> }, push: { label: 'App push', icon: <Bell size={15} /> },
};
const errMsg = (e: unknown) => (e instanceof ApiError ? (Array.isArray(e.details) ? `${(e.details as any)[0].path ?? ''} ${(e.details as any)[0].message}`.trim() : e.message) : 'Something went wrong');

const openLink = (m: any) => {
  if (m.channel === 'whatsapp') {
    const d = (m.recipient ?? '').replace(/\D/g, '');
    return `https://wa.me/${d.length === 10 ? `91${d}` : d}?text=${encodeURIComponent(m.body)}`;
  }
  if (m.channel === 'sms') return `sms:${m.recipient}?body=${encodeURIComponent(m.body)}`;
  return `mailto:${m.recipient}?subject=${encodeURIComponent(m.subject ?? '')}&body=${encodeURIComponent(m.body)}`;
};

/** Messages waiting to go out. Without a gateway, staff send each from their own phone and tick it off. */
export function Outbox() {
  const qc = useQueryClient();
  const toast = useToast();
  const [channel, setChannel] = useState('');
  const [status, setStatus] = useState<'queued' | 'failed'>('queued');
  const [page, setPage] = useState(1);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const { data } = useQuery({ queryKey: ['outbox', channel, status, page], queryFn: () => api.get<Paged<any>>('/messaging/outbox', { channel: channel || undefined, status, page, pageSize: 25 }) });
  const act = useMutation({
    mutationFn: ({ path, ids }: { path: string; ids: string[] }) => api.post<any>(`/messaging/outbox/${path}`, { ids }),
    onSuccess: (r, v) => { qc.invalidateQueries({ queryKey: ['outbox'] }); qc.invalidateQueries({ queryKey: ['integrations'] }); setPicked(new Set()); toast('success', `${r.updated} ${v.path === 'mark-sent' ? 'marked sent' : v.path === 'retry' ? 'queued again' : 'discarded'}`); },
  });
  const ids = [...picked];
  return (
    <section className="card">
      <div className="toolbar">
        <div className="chips">{[['', 'All'], ['whatsapp', 'WhatsApp'], ['sms', 'SMS'], ['email', 'Email']].map(([k, l]) => <button key={k} className={`chip ${channel === k ? 'on' : ''}`} onClick={() => { setChannel(k); setPage(1); }}>{l}</button>)}</div>
        <div className="chips">{(['queued', 'failed'] as const).map((k) => <button key={k} className={`chip ${status === k ? 'on' : ''}`} onClick={() => { setStatus(k); setPage(1); setPicked(new Set()); }} style={{ textTransform: 'capitalize' }}>{k}</button>)}</div>
        <div style={{ flex: 1 }} />
        {ids.length > 0 && (status === 'queued'
          ? <><Button size="sm" variant="primary" icon={<CheckCheck />} onClick={() => act.mutate({ path: 'mark-sent', ids })}>Mark {ids.length} sent</Button><Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => confirm(`Discard ${ids.length} messages?`) && act.mutate({ path: 'discard', ids })}>Discard</Button></>
          : <Button size="sm" icon={<RotateCcw />} onClick={() => act.mutate({ path: 'retry', ids })}>Retry {ids.length}</Button>)}
      </div>
      <div className="table-wrap">
        {!data ? <div style={{ padding: 20 }}><Skeleton h={300} /></div> : !data.data.length ? <Empty icon={<CheckCheck />} title={status === 'queued' ? 'Outbox is clear' : 'No failed messages'}>Campaigns and automations queue WhatsApp, SMS and email here.</Empty> : (
          <table className="tbl">
            <thead><tr>
              <th style={{ width: 36 }}><input type="checkbox" aria-label="Select all" checked={data.data.every((m) => picked.has(m.id))} onChange={(e) => setPicked(e.target.checked ? new Set(data.data.map((m) => m.id)) : new Set())} /></th>
              <th>To</th><th>Message</th><th className="hide-sm">From</th><th className="hide-sm">Queued</th><th /></tr></thead>
            <tbody>{data.data.map((m) => (
              <tr key={m.id}>
                <td><input type="checkbox" aria-label="Select" checked={picked.has(m.id)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(m.id); else n.delete(m.id); setPicked(n); }} /></td>
                <td>{m.member_id ? <Link to={`/members/${m.member_id}`}><Person name={m.name} detail={m.recipient} size="sm" /></Link> : <Person name={m.name} detail={m.recipient} size="sm" />}</td>
                <td style={{ maxWidth: 440 }}><span className="row" style={{ gap: 6 }}><span className="faint">{CH[m.channel].icon}</span><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.body}</span></span>
                  {m.error && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{m.error}</div>}</td>
                <td className="muted hide-sm">{m.campaign_name ? `Campaign · ${m.campaign_name}` : m.rule_name ? `Automation · ${m.rule_name}` : 'Staff'}</td>
                <td className="muted hide-sm" style={{ whiteSpace: 'nowrap' }}>{relative(m.created_at)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{status === 'queued' && !m.gateway && <>
                  <a className="btn sm" href={openLink(m)} target="_blank" rel="noreferrer" onClick={() => setTimeout(() => act.mutate({ path: 'mark-sent', ids: [m.id] }), 400)}><ExternalLink />Send</a>
                </>}{m.gateway && status === 'queued' && <span className="faint" style={{ fontSize: 12 }}>Gateway sending…</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {data && <Pagination page={data.pagination.page} totalPages={data.pagination.totalPages} total={data.pagination.total} onPage={setPage} />}
    </section>
  );
}

export function IntegrationsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const { data } = useQuery({ queryKey: ['integrations'], queryFn: () => api.get<any>('/messaging/integrations') });
  const [quiet, setQuiet] = useState<{ quietStart: number; quietEnd: number } | null>(null);
  const [test, setTest] = useState<{ channel: string } | null>(null);
  const [member, setMember] = useState<MemberPick | null>(null);
  const saveQuiet = useMutation({ mutationFn: () => api.put('/messaging/settings', { ...data.settings, ...quiet }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['integrations'] }); setQuiet(null); toast('success', 'Quiet hours saved'); } });
  const sendTest = useMutation({
    mutationFn: () => api.post<any>('/messaging/test', { channel: test!.channel, memberId: member!.id }),
    onSuccess: (r) => { toast(r.status === 'failed' ? 'error' : 'success', r.status === 'queued' ? 'Queued — waiting in the outbox for manual sending' : r.status === 'failed' ? `Failed: ${r.error}` : `Test ${r.status}`); setTest(null); qc.invalidateQueries({ queryKey: ['integrations'] }); },
    onError: (e) => toast('error', errMsg(e)),
  });
  if (!data) return <div className="page"><Skeleton h={400} /></div>;
  const q = quiet ?? data.settings;
  return (
    <div className="page">
      <div className="page-head"><div><h1>Integrations</h1><div className="sub">Messaging channels. Every message — from staff, campaigns or automations — goes through the same outbox.</div></div></div>
      <div className="grid g-4">{data.channels.map((c: any) => (
        <section key={c.channel} className="card card-pad stack" style={{ gap: 10 }}>
          <div className="row between"><b className="row" style={{ gap: 8 }}>{CH[c.channel].icon}{CH[c.channel].label}</b>
            <span className={`badge ${c.connected ? 'success' : 'warning'}`}>{c.mode === 'in_app' ? 'Built in' : c.connected ? 'Connected' : 'Manual'}</span></div>
          <div className="muted" style={{ fontSize: 13 }}>{c.mode === 'in_app' ? 'Delivered instantly to the Forge member app.' : c.connected ? `Sending through ${c.provider}.` : 'No gateway yet — messages wait in the outbox and staff send them from their phone.'}</div>
          <div className="row wrap faint" style={{ fontSize: 12.5, gap: 12 }}><span><b style={{ color: 'var(--text)' }}>{c.sent_7d}</b> sent · 7d</span><span><b style={{ color: c.queued ? 'var(--warning)' : 'var(--text)' }}>{c.queued}</b> waiting</span>{c.failed_7d > 0 && <span style={{ color: 'var(--danger)' }}>{c.failed_7d} failed</span>}</div>
          {can('automations.manage') && <Button size="sm" icon={<PlugZap />} onClick={() => setTest({ channel: c.channel })}>Send a test</Button>}
        </section>
      ))}</div>
      <div className="grid g-2">
        <Card title="Connect a gateway" icon={<PlugZap />} sub="Credentials live in the server environment — they’re never shown in the browser.">
          <div className="stack" style={{ gap: 8, fontSize: 13.5 }}>
            <p className="muted">Any WhatsApp Business, SMS or email provider can be connected through an HTTPS endpoint (directly, or via a small adapter). Set these on the API server and restart it:</p>
            <pre className="code-block">{`MESSAGING_WHATSAPP_URL=https://…\nMESSAGING_WHATSAPP_TOKEN=…\nMESSAGING_WHATSAPP_PROVIDER=Your provider\n# likewise MESSAGING_SMS_* and MESSAGING_EMAIL_*`}</pre>
            <p className="faint" style={{ fontSize: 12.5 }}>The CRM POSTs <code>{'{ channel, to, subject, body, reference }'}</code> with a bearer token, retries failures up to 3 times and records the provider’s message id.</p>
          </div>
        </Card>
        <Card title="Promotional quiet hours" icon={<Clock />} sub="Campaigns and promotional automations wait until morning. Receipts and reminders are never held.">
          <div className="row wrap" style={{ gap: 12 }}>
            <Field label="Hold from"><select className="select" disabled={!can('automations.manage')} value={q.quietStart} onChange={(e) => setQuiet({ ...q, quietStart: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</select></Field>
            <Field label="Until"><select className="select" disabled={!can('automations.manage')} value={q.quietEnd} onChange={(e) => setQuiet({ ...q, quietEnd: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</select></Field>
            {quiet && <Button variant="primary" style={{ alignSelf: 'flex-end' }} loading={saveQuiet.isPending} onClick={() => saveQuiet.mutate()}>Save</Button>}
          </div>
          <div style={{ marginTop: 12 }}><Link to="/communication?tab=outbox" className="btn sm">Open the outbox</Link></div>
        </Card>
      </div>
      {test && (
        <Dialog open onClose={() => setTest(null)} title={`Test ${CH[test.channel].label}`} sub="Goes through the real delivery path to one member."
          footer={<><Button onClick={() => setTest(null)}>Cancel</Button><Button variant="primary" disabled={!member} loading={sendTest.isPending} onClick={() => sendTest.mutate()}>Send test</Button></>}>
          <Field label="Send to"><MemberPicker value={member} onChange={setMember} /></Field>
        </Dialog>
      )}
    </div>
  );
}

// -------------------------------------------------------------- automations --

const ACTION_LABEL: Record<string, string> = { notify_member: 'App notification', send_message: 'Send message', create_follow_up: 'Create follow-up', notify_staff: 'Alert staff', award_points: 'Award points' };
const describeAction = (a: any) =>
  a.type === 'notify_member' ? `App: “${a.title}”` : a.type === 'send_message' ? `${CH[a.channel]?.label} · template ${a.templateKey}` : a.type === 'create_follow_up' ? `${a.followUpType} follow-up (${a.purpose})`
    : a.type === 'notify_staff' ? `Alert staff: “${a.title}”` : `+${a.points} points`;
const PARAM_HELP: Record<string, string> = {
  membership_expiring: 'Days before the end date (comma-separated)', membership_expired: 'Days after the end date (comma-separated)', payment_overdue: 'Days after the invoice was due (comma-separated)',
  member_joined: 'Days after joining (0 = joining day)', member_inactive: 'Days without a visit', lead_uncontacted: 'Hours without contact', event_upcoming: 'Hours before the event',
};

function RuleEditor({ rule, meta, onClose }: { rule?: any; meta: any; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState(() => ({
    name: rule?.name ?? '', description: rule?.description ?? '', trigger: rule?.trigger ?? 'membership_expiring', params: rule?.params ?? { days: [7] },
    actions: rule?.actions ?? [{ type: 'notify_member', title: '', body: '' }], promotional: rule?.promotional ?? false, enabled: rule?.enabled ?? true,
  }));
  const [paramText, setParamText] = useState(() => {
    const p = rule?.params ?? { days: [7] };
    return Array.isArray(p.days) ? p.days.join(', ') : String(p.days ?? p.hours ?? '');
  });
  const [error, setError] = useState('');
  const trig = meta.triggers.find((t: any) => t.key === f.trigger);
  const paramKey = trig?.params[0];
  const listParam = ['membership_expiring', 'membership_expired', 'payment_overdue', 'member_joined'].includes(f.trigger);
  const params = !paramKey ? {} : { [paramKey]: listParam ? paramText.split(/[,\s]+/).filter(Boolean).map(Number) : Number(paramText) };
  const save = useMutation({
    mutationFn: () => (rule ? api.put(`/automations/${rule.id}`, { ...f, params }) : api.post('/automations', { ...f, params })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['automations'] }); onClose(); },
    onError: (e) => setError(errMsg(e)),
  });
  const setAction = (i: number, patch: any) => setF({ ...f, actions: f.actions.map((a: any, j: number) => (j === i ? { ...a, ...patch } : a)) });
  const blank: Record<string, any> = {
    notify_member: { type: 'notify_member', title: '', body: '' }, send_message: { type: 'send_message', channel: 'whatsapp', templateKey: meta.templates[0]?.key },
    create_follow_up: { type: 'create_follow_up', purpose: 'general', followUpType: 'call', note: '' }, notify_staff: { type: 'notify_staff', title: '', body: '', priority: 'normal' },
    award_points: { type: 'award_points', points: 50, description: '' },
  };
  const leadRule = trig?.subject === 'lead';
  return (
    <Dialog open variant="drawer" wide onClose={onClose} title={rule ? `Edit ${rule.name}` : 'New automation'} sub="Runs hourly. Each person is acted on once per occurrence — re-running never doubles up."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => { setError(''); save.mutate(); }}>Save</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <div className="form-grid">
          <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="When"><select className="select" value={f.trigger} disabled={rule?.is_system} onChange={(e) => { setF({ ...f, trigger: e.target.value }); setParamText(e.target.value === 'lead_uncontacted' ? '24' : e.target.value === 'event_upcoming' ? '24' : e.target.value === 'member_inactive' ? '14' : '7'); }}>
            {meta.triggers.map((t: any) => <option key={t.key} value={t.key}>{t.label}</option>)}</select></Field>
          {paramKey && <Field label={PARAM_HELP[f.trigger] ?? paramKey} className="full"><input className="input" value={paramText} onChange={(e) => setParamText(e.target.value)} /></Field>}
          <Field label="Description" className="full"><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        </div>
        <div className="section-label">Then</div>
        <div className="stack" style={{ gap: 10 }}>{f.actions.map((a: any, i: number) => (
          <div key={i} className="action-row">
            <div className="row between"><b style={{ fontSize: 13 }}>{i + 1}. {ACTION_LABEL[a.type]}</b>{f.actions.length > 1 && <button className="icon-btn" style={{ width: 28, height: 28 }} aria-label="Remove action" onClick={() => setF({ ...f, actions: f.actions.filter((_: any, j: number) => j !== i) })}><X /></button>}</div>
            {(a.type === 'notify_member' || a.type === 'notify_staff') && <div className="form-grid">
              <Field label="Title"><input className="input" value={a.title} onChange={(e) => setAction(i, { title: e.target.value })} /></Field>
              {a.type === 'notify_staff' && <Field label="Priority"><select className="select" value={a.priority} onChange={(e) => setAction(i, { priority: e.target.value })}><option value="normal">Normal</option><option value="high">High</option></select></Field>}
              <Field label="Message" className="full"><input className="input" value={a.body ?? ''} onChange={(e) => setAction(i, { body: e.target.value })} /></Field>
            </div>}
            {a.type === 'send_message' && <div className="form-grid">
              <Field label="Channel"><select className="select" value={a.channel} onChange={(e) => setAction(i, { channel: e.target.value })}>{['whatsapp', 'sms', 'email'].map((c) => <option key={c} value={c}>{CH[c].label}</option>)}</select></Field>
              <Field label="Template"><select className="select" value={a.templateKey} onChange={(e) => setAction(i, { templateKey: e.target.value })}>{meta.templates.map((t: any) => <option key={t.key} value={t.key}>{t.name}</option>)}</select></Field>
            </div>}
            {a.type === 'create_follow_up' && <div className="form-grid">
              <Field label="Purpose"><select className="select" value={a.purpose} onChange={(e) => setAction(i, { purpose: e.target.value })}>{['general', 'sales', 'renewal', 'payment', 'reactivation', 'feedback'].map((p) => <option key={p} value={p}>{p}</option>)}</select></Field>
              <Field label="How"><select className="select" value={a.followUpType} onChange={(e) => setAction(i, { followUpType: e.target.value })}>{['call', 'whatsapp', 'sms', 'email', 'in_person'].map((p) => <option key={p} value={p}>{p.replace('_', ' ')}</option>)}</select></Field>
              <Field label="Note" className="full"><input className="input" value={a.note ?? ''} onChange={(e) => setAction(i, { note: e.target.value })} /></Field>
            </div>}
            {a.type === 'award_points' && <div className="form-grid">
              <Field label="Points"><input className="input num" type="number" min={1} value={a.points} onChange={(e) => setAction(i, { points: Number(e.target.value) })} /></Field>
              <Field label="Description"><input className="input" value={a.description} onChange={(e) => setAction(i, { description: e.target.value })} /></Field>
            </div>}
          </div>
        ))}</div>
        {f.actions.length < 5 && <div className="chips">{Object.keys(blank).filter((k) => !leadRule || !['notify_member', 'award_points'].includes(k)).map((k) => <button type="button" key={k} className="chip" onClick={() => setF({ ...f, actions: [...f.actions, blank[k]] })}><Plus size={12} />{ACTION_LABEL[k]}</button>)}</div>}
        <div className="faint" style={{ fontSize: 12.5 }}>Placeholders: {'{{first_name}} {{plan}} {{expiry_date}} {{days_left}} {{amount_due}} {{idle_days}} {{event_title}} {{gym}} {{branch}}'}</div>
        <label className="check"><input type="checkbox" checked={f.promotional} onChange={(e) => setF({ ...f, promotional: e.target.checked })} />Promotional — skip members who opted out and respect quiet hours</label>
        <label className="check"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />On</label>
      </div>
    </Dialog>
  );
}

function RunsDialog({ rule, onClose }: { rule: any; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const { data } = useQuery({ queryKey: ['automation-runs', rule.id, page], queryFn: () => api.get<Paged<any>>(`/automations/${rule.id}/runs`, { page, pageSize: 20 }) });
  return (
    <Dialog open variant="drawer" wide onClose={onClose} title={`${rule.name} · history`} sub="Every firing with what each action did.">
      {!data ? <Skeleton h={300} /> : !data.data.length ? <Empty title="Hasn’t fired yet" /> : (
        <div className="table-wrap"><table className="tbl"><tbody>{data.data.map((r) => (
          <tr key={r.id}>
            <td className="muted" style={{ whiteSpace: 'nowrap' }}>{dateTime(r.created_at)}</td>
            <td>{r.member_id ? <Link to={`/members/${r.member_id}`}><Person name={r.name} detail={r.member_code} size="sm" /></Link> : <Person name={r.name ?? '—'} detail="Lead" size="sm" />}</td>
            <td className="muted" style={{ fontSize: 12.5 }}>{(r.results ?? []).map((x: any, i: number) => <div key={i}>{ACTION_LABEL[x.type]}: {x.skipped ? <span style={{ color: 'var(--warning)' }}>skipped · {x.skipped}</span> : x.reason ? <span style={{ color: 'var(--warning)' }}>{x.reason}</span> : x.status ?? (x.points != null ? `+${x.points}` : 'done')}</div>)}</td>
          </tr>
        ))}</tbody></table></div>
      )}
      {data && <Pagination page={data.pagination.page} totalPages={data.pagination.totalPages} total={data.pagination.total} onPage={setPage} />}
    </Dialog>
  );
}

export function AutomationsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const [runs, setRuns] = useState<any>(null);
  const { data } = useQuery({ queryKey: ['automations'], queryFn: () => api.get<any[]>('/automations') });
  const { data: meta } = useQuery({ queryKey: ['automations', 'meta'], queryFn: () => api.get<any>('/automations/meta') });
  const toggle = useMutation({
    mutationFn: (r: any) => api.put(`/automations/${r.id}`, { name: r.name, description: r.description, trigger: r.trigger, params: r.params, actions: r.actions, promotional: r.promotional, enabled: !r.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automations'] }),
    onError: (e) => toast('error', errMsg(e)),
  });
  const run = useMutation({
    mutationFn: async (r: any) => { const p = await api.post<any>(`/automations/${r.id}/preview`); if (!p.pending) return { ...p, fired: 0, skipped: true }; return api.post<any>(`/automations/${r.id}/run`); },
    onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ['automations'] }); toast('success', r.skipped ? `Nothing new — ${r.matched} match, all already handled` : `Fired for ${r.fired} of ${r.matched}`); },
    onError: (e) => toast('error', errMsg(e)),
  });
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/automations/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['automations'] }) });
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Automations</h1><div className="sub">Rules that turn what happens at the gym into follow-ups, messages and alerts. They run every hour.</div></div>
        <div className="actions"><Link to="/admin/integrations" className="btn"><PlugZap />Integrations</Link><Button variant="primary" icon={<Plus />} disabled={!meta} onClick={() => setEditing(null)}>New automation</Button></div>
      </div>
      {!data ? <Skeleton h={400} /> : (
        <div className="stack" style={{ gap: 10 }}>{data.map((r) => (
          <section key={r.id} className={`card rule-card ${r.enabled ? '' : 'off'}`}>
            <label className="switch" title={r.enabled ? 'On' : 'Off'}><input type="checkbox" checked={r.enabled} onChange={() => toggle.mutate(r)} aria-label={`${r.name} on/off`} /><span /></label>
            <div style={{ minWidth: 0 }}>
              <div className="row wrap" style={{ gap: 8 }}><b>{r.name}</b>{r.promotional && <span className="badge neutral">Promotional</span>}{!r.is_system && <span className="badge accent">Custom</span>}</div>
              <div className="flow">
                <span className="when"><Zap size={13} />{r.trigger_label}: {r.trigger_description}</span>
                {r.actions.map((a: any, i: number) => <span key={i} className="then">→ {describeAction(a)}</span>)}
              </div>
            </div>
            <div className="rule-stats"><b className="num">{r.runs_7d}</b><span className="faint">fired · 7d</span><span className="faint" style={{ fontSize: 11.5 }}>{r.last_fired_at ? `last ${relative(r.last_fired_at)}` : 'not yet'}</span></div>
            <div className="row" style={{ gap: 4 }}>
              <Button size="sm" variant="ghost" icon={<Workflow />} aria-label="History" onClick={() => setRuns(r)} />
              <Button size="sm" variant="ghost" icon={<Play />} aria-label="Run now" disabled={!r.enabled} loading={run.isPending && run.variables?.id === r.id} onClick={() => run.mutate(r)} />
              <Button size="sm" variant="ghost" icon={<Pencil />} aria-label="Edit" disabled={!meta} onClick={() => setEditing(r)} />
              {!r.is_system && <Button size="sm" variant="ghost" icon={<Trash2 />} aria-label="Delete" onClick={() => confirm(`Delete ${r.name}?`) && del.mutate(r.id)} />}
            </div>
          </section>
        ))}</div>
      )}
      {editing !== undefined && meta && <RuleEditor rule={editing ?? undefined} meta={meta} onClose={() => setEditing(undefined)} />}
      {runs && <RunsDialog rule={runs} onClose={() => setRuns(null)} />}
    </div>
  );
}
