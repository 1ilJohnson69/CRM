import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bell, CalendarClock, Copy, IndianRupee, Mail, Megaphone, MessageCircle, Plus, Send, Smartphone, Target, Users, X } from 'lucide-react';
import { api, ApiError, type Paged } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced, useToast } from '../../lib/ui';
import { date, dateTime, money, number } from '../../lib/format';
import { Alert, Button, Card, Dialog, Empty, Field, Pagination, Person, Skeleton, Tabs } from '../../components/ui';
import { Bars } from '../../components/charts';

export const CAMPAIGN_TYPE: Record<string, string> = {
  membership_promotion: 'Membership promotion', renewal: 'Renewal', referral: 'Referral', festival_offer: 'Festival offer', birthday: 'Birthday', reactivation: 'Reactivation', lead: 'Lead nurture',
};
const STATUS_TONE: Record<string, string> = { draft: 'neutral', scheduled: 'info', sending: 'warning', sent: 'success', cancelled: 'danger' };
export const CHANNEL_META: Record<string, { label: string; icon: ReactNode }> = {
  whatsapp: { label: 'WhatsApp', icon: <MessageCircle size={14} /> }, sms: { label: 'SMS', icon: <Smartphone size={14} /> },
  email: { label: 'Email', icon: <Mail size={14} /> }, push: { label: 'App push', icon: <Bell size={14} /> },
};
const PLACEHOLDERS = ['first_name', 'plan', 'expiry_date', 'gym', 'branch', 'offer_code', 'offer_valid_until', 'referral_code', 'points'];
const errMsg = (e: unknown) => (e instanceof ApiError ? (Array.isArray(e.details) ? `${(e.details as any)[0].path ?? ''} ${(e.details as any)[0].message}`.trim() : e.message) : 'Something went wrong');
const audienceLabel = (a: any, meta?: any) =>
  a.kind === 'preset' ? meta?.presets.find((p: any) => p.key === a.key)?.label ?? a.key
    : a.kind === 'segment' ? `Segment: ${meta?.segments.find((s: any) => s.id === a.segmentId)?.name ?? '…'}`
      : `Leads · ${a.stages.map((s: string) => s.replace('_', ' ')).join(', ')}`;

function CampaignEditor({ campaign, onClose }: { campaign?: any; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { me } = useAuth();
  const { data: meta } = useQuery({ queryKey: ['campaign-meta'], queryFn: () => api.get<any>('/campaigns/meta') });
  const [f, setF] = useState({
    name: campaign?.name ?? '', type: campaign?.type ?? 'membership_promotion', audience: campaign?.audience ?? { kind: 'preset', key: 'expiring' },
    branchIds: campaign?.branch_ids ?? me?.branches.map((b) => b.id) ?? [], channels: campaign?.channels ?? ['whatsapp', 'push'], subject: campaign?.subject ?? '',
    body: campaign?.body ?? 'Hi {{first_name}}, ', offerCode: campaign?.offer_code ?? '', offerValidUntil: campaign?.offer_valid_until ?? '', attributionDays: campaign?.attribution_days ?? 14,
  });
  const [when, setWhen] = useState<'now' | 'later' | 'draft'>('draft');
  const [at, setAt] = useState('');
  const [error, setError] = useState('');
  const debounced = useDebounced(JSON.stringify({ audience: f.audience, channels: f.channels, branchIds: f.branchIds }), 300);
  const { data: reach, isFetching } = useQuery({ queryKey: ['campaign-reach', debounced], queryFn: () => api.post<any>('/campaigns/preview', JSON.parse(debounced)), enabled: f.channels.length > 0 && f.branchIds.length > 0 });
  const toggle = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const save = useMutation({
    mutationFn: async () => {
      const body = { ...f, subject: f.subject || null, offerCode: f.offerCode || null, offerValidUntil: f.offerValidUntil || null };
      const id = campaign ? (await api.put(`/campaigns/${campaign.id}`, body), campaign.id) : (await api.post<any>('/campaigns', body)).id;
      if (when === 'now') return { id, sent: await api.post<any>(`/campaigns/${id}/send`) };
      if (when === 'later') await api.post(`/campaigns/${id}/schedule`, { at: new Date(`${at}:00+05:30`).toISOString() });
      return { id };
    },
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ['campaigns'] });
      toast('success', r.sent ? `Sent to ${r.sent.audience} people · ${r.sent.queued} messages` : when === 'later' ? 'Scheduled' : 'Draft saved');
      onClose(); navigate(`/marketing/${r.id}`);
    },
    onError: (e) => setError(errMsg(e)),
  });
  const insert = (p: string) => setF({ ...f, body: `${f.body}{{${p}}}` });
  return (
    <Dialog open variant="drawer" wide onClose={onClose} title={campaign ? `Edit ${campaign.name}` : 'New campaign'} sub="Promotional: members who opted out are skipped automatically."
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon={when === 'now' ? <Send /> : when === 'later' ? <CalendarClock /> : undefined} disabled={!f.name || f.body.length < 5 || !f.channels.length || (when === 'later' && !at)} loading={save.isPending}
          onClick={() => { setError(''); if (when !== 'now' || confirm(`Send to ${reach?.audience ?? 'the audience'} people now?`)) save.mutate(); }}>
          {when === 'now' ? 'Send now' : when === 'later' ? 'Schedule' : 'Save draft'}</Button>
      </>}>
      <div className="grid g-dash-1" style={{ alignItems: 'start' }}>
        <div className="form">
          {error && <Alert>{error}</Alert>}
          <div className="form-grid">
            <Field label="Campaign name" className="full"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Diwali offer · 20% off annual plans" /></Field>
            <Field label="Type"><select className="select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{Object.entries(CAMPAIGN_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="Measure results for" hint="Payments within this window count as conversions"><select className="select" value={f.attributionDays} onChange={(e) => setF({ ...f, attributionDays: Number(e.target.value) })}>{[7, 14, 30].map((d) => <option key={d} value={d}>{d} days</option>)}</select></Field>
          </div>
          <div className="section-label">Audience</div>
          <div className="cust-toggle" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            {[['preset', 'Ready-made'], ['segment', 'Saved segment'], ['leads', 'Leads']].map(([k, l]) => (
              <button key={k} type="button" className={f.audience.kind === k ? 'on' : ''} onClick={() => setF({ ...f, audience: k === 'preset' ? { kind: 'preset', key: 'expiring' } : k === 'segment' ? { kind: 'segment', segmentId: meta?.segments[0]?.id } : { kind: 'leads', stages: ['new', 'contacted', 'interested'] } })}>{l}</button>
            ))}
          </div>
          {f.audience.kind === 'preset' && <div className="chips">{meta?.presets.map((p: any) => <button type="button" key={p.key} className={`chip ${f.audience.key === p.key ? 'on' : ''}`} onClick={() => setF({ ...f, audience: { kind: 'preset', key: p.key } })}>{p.label}</button>)}</div>}
          {f.audience.kind === 'segment' && <select className="select" value={f.audience.segmentId} onChange={(e) => setF({ ...f, audience: { kind: 'segment', segmentId: e.target.value } })}>{meta?.segments.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
          {f.audience.kind === 'leads' && <div className="chips">{meta?.stages.map((s: string) => <button type="button" key={s} className={`chip ${f.audience.stages.includes(s) ? 'on' : ''}`}
            onClick={() => setF({ ...f, audience: { ...f.audience, stages: toggle(f.audience.stages, s).length ? toggle(f.audience.stages, s) : f.audience.stages } })} style={{ textTransform: 'capitalize' }}>{s.replace('_', ' ')}</button>)}</div>}
          {(me?.branches.length ?? 0) > 1 && <div className="chips">{me!.branches.map((b) => <button type="button" key={b.id} className={`chip ${f.branchIds.includes(b.id) ? 'on' : ''}`} onClick={() => setF({ ...f, branchIds: toggle(f.branchIds, b.id) })}>{b.name}</button>)}</div>}
          <div className="section-label">Channels</div>
          <div className="chips">{Object.entries(CHANNEL_META).map(([k, m]) => <button type="button" key={k} className={`chip ${f.channels.includes(k) ? 'on' : ''}`} onClick={() => setF({ ...f, channels: toggle(f.channels, k) })}>{m.icon}{m.label}</button>)}</div>
          <div className="section-label">Message</div>
          {f.channels.includes('email') && <Field label="Email subject"><input className="input" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>}
          <Field label="Body" hint={<span>Insert: {PLACEHOLDERS.map((p) => <button key={p} type="button" className="linkish" onClick={() => insert(p)}>{p}</button>)}</span>}>
            <textarea className="textarea" rows={5} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
          </Field>
          <div className="form-grid">
            <Field label="Offer code (optional)"><input className="input" value={f.offerCode} onChange={(e) => setF({ ...f, offerCode: e.target.value.toUpperCase() })} placeholder="DIWALI20" /></Field>
            <Field label="Offer valid until"><input className="input" type="date" value={f.offerValidUntil ?? ''} onChange={(e) => setF({ ...f, offerValidUntil: e.target.value })} /></Field>
          </div>
          <div className="section-label">When</div>
          <div className="cust-toggle" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            {[['draft', 'Save as draft'], ['later', 'Schedule'], ['now', 'Send now']].map(([k, l]) => <button key={k} type="button" className={when === k ? 'on' : ''} onClick={() => setWhen(k as any)}>{l}</button>)}
          </div>
          {when === 'later' && <Field label="Send at (IST)"><input className="input" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>}
        </div>
        <div className="stack" style={{ position: 'sticky', top: 0 }}>
          <Card title="Reach" icon={<Target />} sub={isFetching ? 'Counting…' : audienceLabel(f.audience, meta)}>
            {!reach ? <Skeleton h={120} /> : (
              <div className="stack" style={{ gap: 8 }}>
                <div className="row between"><span className="muted">In audience</span><b className="num" style={{ fontSize: 20 }}>{number(reach.audience)}</b></div>
                {reach.optedOut > 0 && <div className="row between faint" style={{ fontSize: 12.5 }}><span>Opted out (skipped)</span><span className="num">{reach.optedOut}</span></div>}
                {reach.byChannel.map((c: any) => (
                  <div key={c.channel} className="row between" style={{ fontSize: 13 }}>
                    <span className="row" style={{ gap: 6 }}>{CHANNEL_META[c.channel].icon}{CHANNEL_META[c.channel].label}</span>
                    <span className="num" style={{ textAlign: 'right' }}><b>{c.reachable}</b>{!c.connected && <div style={{ fontSize: 11, color: 'var(--warning)' }}>manual send</div>}</span>
                  </div>
                ))}
                {reach.byChannel.some((c: any) => !c.connected) && <div className="faint" style={{ fontSize: 12 }}>No gateway connected for some channels — those messages wait in Communication › Outbox for staff to send.</div>}
              </div>
            )}
          </Card>
          <Card title="Preview" icon={<MessageCircle />}>
            <div className="bubble">{f.body.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_: string, k: string) => ({ first_name: 'Priya', plan: 'Quarterly', expiry_date: '12 Oct 2026', gym: 'Forge Fitness', branch: 'Indiranagar', offer_code: f.offerCode || 'CODE', offer_valid_until: f.offerValidUntil ? date(f.offerValidUntil) : '—', referral_code: 'A1B2C3D', points: '1,240' } as Record<string, string>)[k] ?? '')}</div>
          </Card>
        </div>
      </div>
    </Dialog>
  );
}

export function CampaignDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(false);
  const { data: meta } = useQuery({ queryKey: ['campaign-meta'], queryFn: () => api.get<any>('/campaigns/meta') });
  const { data: c, error } = useQuery({ queryKey: ['campaign', id, filter, page], queryFn: () => api.get<any>(`/campaigns/${id}`, { filter, page, pageSize: 25 }) });
  const act = useMutation({
    mutationFn: ({ path }: { path: string }) => api.post<any>(path),
    onSuccess: (r, v) => {
      qc.invalidateQueries({ queryKey: ['campaign'] }); qc.invalidateQueries({ queryKey: ['campaigns'] });
      if (v.path.endsWith('/duplicate')) navigate(`/marketing/${r.id}`);
      else toast('success', v.path.endsWith('/send') ? `Sent · ${r.queued} messages` : r?.stopped ? `${r.stopped} unsent messages stopped` : 'Done');
    },
    onError: (e) => toast('error', errMsg(e)),
  });
  useEffect(() => setPage(1), [filter]);
  if (error) return <div className="page"><Empty title="Campaign not found" /></div>;
  if (!c) return <div className="page"><Skeleton h={160} /><Skeleton h={360} /></div>;
  const manage = can('marketing.manage');
  const convRate = c.reached ? Math.round((c.conversions / c.reached) * 1000) / 10 : 0;
  const chan = Object.keys(CHANNEL_META).map((ch) => {
    const rows = c.byChannel.filter((x: any) => x.channel === ch);
    const n = (st: string) => rows.filter((x: any) => x.status === st).reduce((s: number, x: any) => s + x.n, 0);
    return { ch, total: rows.reduce((s: number, x: any) => s + x.n, 0), sent: n('sent') + n('delivered'), queued: n('queued'), failed: n('failed'), skipped: n('skipped') };
  }).filter((x) => x.total);
  return (
    <div className="page">
      <Link to="/marketing" className="btn ghost sm" style={{ alignSelf: 'flex-start' }}><ArrowLeft />Marketing</Link>
      <div className="page-head">
        <div>
          <div className="row wrap"><h1>{c.name}</h1><span className={`badge ${STATUS_TONE[c.status]}`} style={{ textTransform: 'capitalize' }}>{c.status}</span></div>
          <div className="sub">{CAMPAIGN_TYPE[c.type]} · {audienceLabel(c.audience, meta)} · {c.channels.map((ch: string) => CHANNEL_META[ch].label).join(', ')} · {c.branches.map((b: any) => b.name).join(', ')}
            {c.sent_at ? ` · sent ${dateTime(c.sent_at)}` : c.scheduled_at ? ` · scheduled ${dateTime(c.scheduled_at)}` : ''}</div>
        </div>
        {manage && <div className="actions">
          {['draft', 'scheduled'].includes(c.status) && <><Button icon={<Send />} variant="primary" onClick={() => confirm('Send this campaign now?') && act.mutate({ path: `/campaigns/${c.id}/send` })}>Send now</Button><Button onClick={() => setEditing(true)}>Edit</Button></>}
          {(['draft', 'scheduled'].includes(c.status) || (c.status === 'sent' && c.queued > 0)) && <Button variant="ghost" icon={<X />} onClick={() => confirm(c.status === 'sent' ? 'Stop messages that haven’t gone out yet?' : 'Cancel this campaign?') && act.mutate({ path: `/campaigns/${c.id}/cancel` })}>{c.status === 'sent' ? 'Stop unsent' : 'Cancel'}</Button>}
          <Button variant="ghost" icon={<Copy />} onClick={() => act.mutate({ path: `/campaigns/${c.id}/duplicate` })}>Duplicate</Button>
        </div>}
      </div>
      {c.status === 'sent' ? (
        <>
          <div className="grid g-4">
            <section className="card kpi"><div className="label"><Users />Reached</div><div className="value">{number(c.reached)}</div><div className="compare">{c.skipped} skipped · {c.failed} failed</div></section>
            <section className="card kpi"><div className="label"><Send />Sent</div><div className="value">{number(c.sent)}</div><div className="compare">{c.queued ? `${c.queued} waiting in the outbox` : 'all messages out'}</div></section>
            <section className="card kpi"><div className="label"><Target />Converted</div><div className="value">{number(c.conversions)}</div><div className="compare">{convRate}% paid or joined within {c.attribution_days} days</div></section>
            <section className="card kpi hero"><div className="label"><IndianRupee />Influenced revenue</div><div className="value">{money(c.revenue)}</div><div className="compare">payments by recipients in the window</div></section>
          </div>
          <div className="grid g-dash-1">
            <Card title="Revenue from recipients after sending" icon={<IndianRupee />} sub={`Daily, over the ${c.attribution_days}-day window`}>
              {c.daily.length ? <Bars data={c.daily.map((d: any) => ({ key: d.date, value: Number(d.value) }))} height={180} highlightLast={false} label={(k) => new Date(k).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} valueLabel={(v) => money(v)} /> : <Empty title="No data yet" />}
            </Card>
            <Card title="By channel" icon={<Megaphone />}>
              <div className="stack" style={{ gap: 12 }}>{chan.map((x) => (
                <div key={x.ch}>
                  <div className="row between" style={{ fontSize: 13 }}><span className="row" style={{ gap: 6 }}>{CHANNEL_META[x.ch].icon}<b>{CHANNEL_META[x.ch].label}</b></span><span className="faint num">{x.total}</span></div>
                  <div className="stack-bar" title={`${x.sent} sent · ${x.queued} queued · ${x.failed} failed · ${x.skipped} skipped`}>
                    <i style={{ width: `${(x.sent / x.total) * 100}%`, background: 'var(--series-2)' }} /><i style={{ width: `${(x.queued / x.total) * 100}%`, background: 'var(--series-1)' }} />
                    <i style={{ width: `${(x.failed / x.total) * 100}%`, background: 'var(--series-3)' }} /><i style={{ width: `${(x.skipped / x.total) * 100}%`, background: 'var(--surface-3)' }} />
                  </div>
                  <div className="faint num" style={{ fontSize: 12 }}>{x.sent} sent · {x.queued} queued · {x.failed} failed · {x.skipped} skipped</div>
                </div>
              ))}</div>
            </Card>
          </div>
        </>
      ) : <Alert tone="info">{c.status === 'scheduled' ? `Goes out ${dateTime(c.scheduled_at)}.` : c.status === 'cancelled' ? 'This campaign was cancelled.' : 'Draft — nothing has been sent.'} Results appear here once it’s sent.</Alert>}
      <Card title="Message" icon={<MessageCircle />}>
        {c.subject && <div className="faint" style={{ marginBottom: 6 }}>Subject: {c.subject}</div>}
        <div className="bubble">{c.body}</div>
        {c.offer_code && <div className="faint" style={{ marginTop: 8, fontSize: 13 }}>Offer <span className="code-chip">{c.offer_code}</span>{c.offer_valid_until ? ` · valid till ${date(c.offer_valid_until)}` : ''}</div>}
      </Card>
      {c.status === 'sent' && (
        <section className="card">
          <div className="toolbar"><b style={{ marginRight: 8 }}>Recipients</b>
            <div className="chips">{[['all', 'All'], ['converted', 'Converted'], ['skipped', 'Skipped'], ['failed', 'Failed']].map(([k, l]) => <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{l}</button>)}</div>
          </div>
          <div className="table-wrap">
            {!c.recipients.data.length ? <Empty title="Nobody here" /> : (
              <table className="tbl"><thead><tr><th>Recipient</th><th>Channel</th><th>Status</th><th className="r">Paid after</th></tr></thead>
                <tbody>{c.recipients.data.map((r: any) => (
                  <tr key={r.id}>
                    <td>{r.member_id ? <Link to={`/members/${r.member_id}`}><Person name={r.name} detail={r.member_code} size="sm" /></Link> : <Person name={r.name} detail={`Lead · ${r.lead_stage?.replace('_', ' ')}`} size="sm" />}</td>
                    <td className="muted"><span className="row" style={{ gap: 6 }}>{CHANNEL_META[r.channel].icon}{CHANNEL_META[r.channel].label}</span></td>
                    <td><span className={`badge ${r.status === 'skipped' ? 'neutral' : r.status === 'failed' ? 'danger' : r.status === 'queued' ? 'warning' : 'success'}`}>{r.status}</span>{r.skip_reason && <span className="faint" style={{ fontSize: 12 }}> · {r.skip_reason}</span>}</td>
                    <td className="r amount">{Number(r.paid) > 0 ? money(r.paid) : r.lead_converted ? <span className="badge success">Joined</span> : <span className="faint">—</span>}</td>
                  </tr>
                ))}</tbody></table>
            )}
          </div>
          <Pagination page={c.recipients.pagination.page} totalPages={c.recipients.pagination.totalPages} total={c.recipients.pagination.total} onPage={setPage} />
        </section>
      )}
      {editing && <CampaignEditor campaign={c} onClose={() => setEditing(false)} />}
    </div>
  );
}

export function MarketingPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const { data: meta } = useQuery({ queryKey: ['campaign-meta'], queryFn: () => api.get<any>('/campaigns/meta') });
  const { data: sum } = useQuery({ queryKey: ['campaigns', 'summary'], queryFn: () => api.get<any>('/campaigns/summary') });
  const { data } = useQuery({ queryKey: ['campaigns', status, page], queryFn: () => api.get<Paged<any>>('/campaigns', { status: status || undefined, page, pageSize: 20 }) });
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Marketing</h1><div className="sub">Campaigns to segments and leads on WhatsApp, SMS, email and app push — with results measured in payments, not opens.</div></div>
        <div className="actions">{can('marketing.manage') && <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>New campaign</Button>}</div>
      </div>
      <div className="grid g-4">
        <section className="card kpi hero"><div className="label"><IndianRupee />Influenced revenue</div><div className="value">{money(sum?.revenue ?? 0)}</div><div className="compare">campaigns sent in the last 90 days</div></section>
        <section className="card kpi"><div className="label"><Send />Campaigns sent</div><div className="value">{sum?.sent_90d ?? '—'}</div><div className="compare">{sum?.scheduled ?? 0} scheduled · {sum?.drafts ?? 0} drafts</div></section>
        <section className="card kpi"><div className="label"><Users />People reached</div><div className="value">{number(sum?.reached ?? 0)}</div><div className="compare">last 90 days</div></section>
        <section className="card kpi"><div className="label"><Target />Conversions</div><div className="value">{number(sum?.conversions ?? 0)}</div><div className="compare">{sum?.reached ? `${Math.round((sum.conversions / sum.reached) * 100)}% of reached` : '—'}</div></section>
      </div>
      <Tabs value={status || 'all'} onChange={(t) => { setParams(t === 'all' ? {} : { status: t }); setPage(1); }}
        tabs={[{ key: 'all', label: 'All' }, { key: 'sent', label: 'Sent' }, { key: 'scheduled', label: 'Scheduled' }, { key: 'draft', label: 'Drafts' }]} />
      <section className="card">
        <div className="table-wrap">
          {!data ? <div style={{ padding: 20 }}><Skeleton h={300} /></div> : !data.data.length ? <Empty icon={<Megaphone />} title="No campaigns here" /> : (
            <table className="tbl">
              <thead><tr><th>Campaign</th><th className="hide-sm">Audience</th><th>Channels</th><th>Status</th><th className="r">Reached</th><th className="r">Converted</th><th className="r">Revenue</th></tr></thead>
              <tbody>{data.data.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => navigate(`/marketing/${c.id}`)}>
                  <td><b>{c.name}</b><div className="faint" style={{ fontSize: 12 }}>{CAMPAIGN_TYPE[c.type]} · {c.sent_at ? `sent ${date(c.sent_at)}` : c.scheduled_at ? `scheduled ${dateTime(c.scheduled_at)}` : `created ${date(c.created_at)}`}</div></td>
                  <td className="muted hide-sm">{audienceLabel(c.audience, meta)}</td>
                  <td><span className="row" style={{ gap: 6 }}>{c.channels.map((ch: string) => <span key={ch} title={CHANNEL_META[ch].label} className="faint">{CHANNEL_META[ch].icon}</span>)}</span></td>
                  <td><span className={`badge ${STATUS_TONE[c.status]}`} style={{ textTransform: 'capitalize' }}>{c.status}</span></td>
                  <td className="r num">{c.status === 'sent' ? number(c.reached) : '—'}</td>
                  <td className="r num">{c.status === 'sent' ? <>{c.conversions} <span className="faint">{c.reached ? `${Math.round((c.conversions / c.reached) * 100)}%` : ''}</span></> : '—'}</td>
                  <td className="r amount">{c.status === 'sent' ? money(c.revenue) : '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
        {data && <Pagination page={data.pagination.page} totalPages={data.pagination.totalPages} total={data.pagination.total} onPage={setPage} />}
      </section>
      {creating && <CampaignEditor onClose={() => setCreating(false)} />}
    </div>
  );
}
