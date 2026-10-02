import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Search } from 'lucide-react';
import { api, ApiError, type Paged } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced, useToast } from '../../lib/ui';
import { dateTime, number } from '../../lib/format';
import { Alert, Badge, Button, Dialog, Empty, Field, Pagination, Skeleton, Tabs } from '../../components/ui';
import { channelIcon, CHANNEL_LABEL, OUTCOME_LABEL } from './common';

function TemplateDialog({ template, placeholders, onClose }: { template?: any; placeholders: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ name: template?.name ?? '', channel: template?.channel ?? 'whatsapp', audience: template?.audience ?? 'member', subject: template?.subject ?? '', body: template?.body ?? '', isActive: template?.is_active ?? true });
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: () => (template ? api.put(`/templates/${template.id}`, { ...f, subject: f.subject || null }) : api.post('/templates', { ...f, subject: f.subject || null })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['templates'] }); toast('success', 'Template saved'); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Failed'),
  });
  return (
    <Dialog open variant="drawer" onClose={onClose} title={template ? 'Edit template' : 'New template'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <div className="form-grid">
          <Field label="Name" className="full"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Channel"><select className="select" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
            <option value="whatsapp">WhatsApp</option><option value="sms">SMS</option><option value="email">Email</option><option value="any">Any channel</option>
          </select></Field>
          <Field label="For"><select className="select" value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })}>
            <option value="member">Members</option><option value="lead">Leads</option><option value="any">Anyone</option>
          </select></Field>
          {(f.channel === 'email' || f.channel === 'any') && <Field label="Email subject" className="full"><input className="input" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>}
          <Field label="Message" className="full" hint={<>Placeholders: {placeholders.map((p) => <code key={p} style={{ marginRight: 6 }}>{`{{${p}}}`}</code>)}</>}>
            <textarea className="textarea" style={{ minHeight: 160 }} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
          </Field>
        </div>
        <label className="check"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />Active</label>
      </div>
    </Dialog>
  );
}

function Templates() {
  const { can } = useAuth();
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const { data } = useQuery({ queryKey: ['templates'], queryFn: () => api.get<{ data: any[]; placeholders: string[] }>('/templates') });
  if (!data) return <Skeleton h={300} />;
  return (
    <>
      <div className="row between">
        <span className="muted">Used by the contact composer everywhere in the CRM. Provider-based sending (WhatsApp Business, SMS, email) plugs into these later.</span>
        {can('templates.manage') && <Button icon={<Plus />} onClick={() => setEditing(null)}>New template</Button>}
      </div>
      <div className="grid g-2">
        {data.data.map((t) => (
          <section key={t.id} className="card card-pad stack" style={{ gap: 8, opacity: t.is_active ? 1 : 0.55 }}>
            <div className="row between">
              <div className="row"><b>{t.name}</b><Badge tone="neutral">{t.channel === 'any' ? 'Any channel' : CHANNEL_LABEL[t.channel]}</Badge><Badge tone="accent">{t.audience === 'any' ? 'Anyone' : t.audience === 'lead' ? 'Leads' : 'Members'}</Badge></div>
              {can('templates.manage') && <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setEditing(t)} aria-label="Edit" />}
            </div>
            <div className="template-body">{t.body}</div>
          </section>
        ))}
      </div>
      {editing !== undefined && <TemplateDialog template={editing ?? undefined} placeholders={data.placeholders} onClose={() => setEditing(undefined)} />}
    </>
  );
}

function Log() {
  const [channel, setChannel] = useState('');
  const [search, setSearch] = useState('');
  const [mine, setMine] = useState(false);
  const [page, setPage] = useState(1);
  const term = useDebounced(search.trim());
  const { data } = useQuery({
    queryKey: ['communications', channel, term, mine, page],
    queryFn: () => api.get<Paged<any>>('/communications', { channel, search: term, loggedBy: mine ? 'me' : undefined, page, pageSize: 30 }),
    placeholderData: keepPreviousData,
  });
  const { data: stats } = useQuery({ queryKey: ['comm-stats'], queryFn: () => api.get<Record<string, number>>('/communications/stats') });
  return (
    <>
      <div className="grid g-4">
        {['call', 'whatsapp', 'sms', 'email'].map((c) => (
          <button key={c} className={`card kpi ${channel === c ? 'selected' : ''}`} onClick={() => { setChannel(channel === c ? '' : c); setPage(1); }}>
            <div className="label">{channelIcon(c)}{CHANNEL_LABEL[c]} · 30 days</div>
            <div className="value">{number(stats?.[c] ?? 0)}</div>
          </button>
        ))}
      </div>
      <section className="card">
        <div className="toolbar">
          <div className="search-box"><Search /><input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Name or message text" /></div>
          <button className={`chip ${!mine ? 'on' : ''}`} onClick={() => setMine(false)}>Everyone</button>
          <button className={`chip ${mine ? 'on' : ''}`} onClick={() => setMine(true)}>Logged by me</button>
        </div>
        <div className="table-wrap">
          {!data ? <div style={{ padding: 20 }}><Skeleton h={300} /></div> : !data.data.length ? <Empty title="No communication logged" /> : (
            <table className="tbl">
              <thead><tr><th>When</th><th>Channel</th><th>With</th><th>Message / notes</th><th>Outcome</th><th className="hide-sm">By</th></tr></thead>
              <tbody>{data.data.map((c) => (
                <tr key={c.id}>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{dateTime(c.created_at)}</td>
                  <td><span className="method">{channelIcon(c.channel)}{CHANNEL_LABEL[c.channel]}</span></td>
                  <td><Link to={c.lead_id ? `/leads?lead=${c.lead_id}` : `/members/${c.member_id}`} style={{ fontWeight: 700 }}>{c.subject_name}</Link><div className="faint" style={{ fontSize: 12 }}>{c.lead_id ? 'Lead' : c.member_code}</div></td>
                  <td style={{ maxWidth: 420 }}><div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.body ?? ''}>{c.template_name && <Badge tone="neutral">{c.template_name}</Badge>} {c.body ?? '—'}</div></td>
                  <td>{c.outcome ? <span className="badge neutral">{OUTCOME_LABEL[c.outcome] ?? c.outcome}</span> : <span className="faint">—</span>}</td>
                  <td className="muted hide-sm">{c.logged_by_name}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
        {data && data.pagination.total > 30 && <Pagination {...data.pagination} onPage={setPage} />}
      </section>
    </>
  );
}

export function CommunicationPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as 'log' | 'templates') ?? 'log';
  return (
    <div className="page">
      <div className="page-head"><div><h1>Communication</h1><div className="sub">Every call, message and note with leads and members, in one log.</div></div></div>
      <Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[{ key: 'log', label: 'Activity log' }, { key: 'templates', label: 'Templates' }]} />
      {tab === 'log' ? <Log /> : <Templates />}
    </div>
  );
}
