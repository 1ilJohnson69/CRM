import { useMemo, useState, type DragEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight, CalendarPlus, Columns3, List, MessageCircle, Pencil, Phone, Plus, RotateCcw, Search, UserCheck, X,
} from 'lucide-react';
import { api, ApiError, type Paged } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced, useToast } from '../../lib/ui';
import { date, dateTime, money, moneyShort, relative } from '../../lib/format';
import { Avatar, Button, Dialog, Empty, Pagination, Person, Segmented, Skeleton } from '../../components/ui';
import {
  channelIcon, CHANNEL_LABEL, CompleteFollowUpDialog, ContactDialog, DueBadge, FollowUpDialog, FU_TYPE_LABEL, OUTCOME_LABEL, PURPOSE_LABEL,
  STAGE_COLOR, STAGE_LABEL, StageBadge, STAGES, type ContactTarget,
} from './common';
import { ConvertLeadDialog, LeadFormDialog, LostDialog } from './LeadForm';

type Column = { stage: string; label: string; count: number; value: number; leads: any[] };

// ------------------------------------------------------------------- card --

function LeadCard({ lead, onOpen, onDragStart, dragging }: { lead: any; onOpen: () => void; onDragStart: (e: DragEvent) => void; dragging: boolean }) {
  return (
    <div className={`lead-card ${dragging ? 'dragging' : ''}`} draggable onDragStart={onDragStart} onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()} aria-label={`${lead.full_name}, ${STAGE_LABEL[lead.stage]}`}>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div className="lc-name">{lead.full_name}</div>
          <div className="lc-meta">{[lead.source_name, lead.plan_name].filter(Boolean).join(' · ') || 'No details yet'}</div>
        </div>
        {lead.potential_value ? <div className="lc-value">{moneyShort(lead.potential_value)}</div> : null}
      </div>
      <div className="row between" style={{ marginTop: 10 }}>
        {lead.stage === 'won' ? <span className="badge success"><UserCheck />Member</span>
          : lead.stage === 'lost' ? <span className="badge neutral" title={lead.lost_reason}>{lead.lost_reason}</span>
            : lead.stage === 'trial_booked' && lead.trial_at ? <span className="badge accent">Trial {dateTime(lead.trial_at)}</span>
              : <DueBadge due={lead.next_follow_up_at} />}
        {lead.assigned_name && <span title={lead.assigned_name}><Avatar name={lead.assigned_name} size="sm" /></span>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ board --

function Board({ columns, onOpen }: { columns: Column[]; onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [drag, setDrag] = useState<{ id: string; from: string } | null>(null);
  const [over, setOver] = useState<{ stage: string; index: number } | null>(null);
  const [pending, setPending] = useState<{ lead: any; stage: 'won' | 'lost'; beforeId?: string | null; afterId?: string | null } | null>(null);
  const byId = useMemo(() => Object.fromEntries(columns.flatMap((c) => c.leads.map((l) => [l.id, l]))), [columns]);

  const move = useMutation({
    mutationFn: (v: { id: string; stage: string; beforeId?: string | null; afterId?: string | null; lostReason?: string }) =>
      api.post(`/leads/${v.id}/move`, { stage: v.stage, beforeId: v.beforeId ?? null, afterId: v.afterId ?? null, lostReason: v.lostReason }),
    // Optimistic: move the card locally so the board feels instant.
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['lead-board'] });
      const snapshots = qc.getQueriesData<Column[]>({ queryKey: ['lead-board'] });
      for (const [key, cols] of snapshots) {
        if (!cols) continue;
        const lead = cols.flatMap((c) => c.leads).find((l) => l.id === v.id);
        if (!lead) continue;
        const next = cols.map((c) => ({ ...c, leads: c.leads.filter((l) => l.id !== v.id) }));
        const target = next.find((c) => c.stage === v.stage)!;
        const idx = v.afterId ? target.leads.findIndex((l) => l.id === v.afterId) : target.leads.length;
        target.leads.splice(idx < 0 ? target.leads.length : idx, 0, { ...lead, stage: v.stage });
        qc.setQueryData(key, next.map((c) => ({ ...c, count: c.leads.length, value: c.leads.reduce((s, l) => s + Number(l.potential_value ?? 0), 0) })));
      }
      return { snapshots };
    },
    onError: (e, _v, ctx) => {
      ctx?.snapshots.forEach(([key, data]) => qc.setQueryData(key, data));
      toast('error', e instanceof ApiError ? e.message : 'Could not move lead');
    },
    onSettled: () => qc.invalidateQueries(),
  });

  const onDrop = (stage: string) => (e: DragEvent) => {
    e.preventDefault();
    const d = drag;
    setDrag(null);
    setOver(null);
    if (!d || !can('leads.write')) return;
    const lead = byId[d.id];
    const col = columns.find((c) => c.stage === stage)!;
    const rest = col.leads.filter((l) => l.id !== d.id);
    const index = Math.min(over?.stage === stage ? over.index : rest.length, rest.length);
    const beforeId = rest[index - 1]?.id ?? null;
    const afterId = rest[index]?.id ?? null;
    if (lead.stage === stage && col.leads.findIndex((l) => l.id === d.id) === index) return;
    if (lead.stage === 'won') return toast('error', 'This lead is already a member');
    if (stage === 'won' || stage === 'lost') return setPending({ lead, stage, beforeId, afterId });
    move.mutate({ id: d.id, stage, beforeId, afterId });
  };

  const indexFromEvent = (e: DragEvent, stage: string) => {
    const list = (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.lead-card:not(.dragging)');
    let index = list.length;
    for (let i = 0; i < list.length; i++) {
      const r = list[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { index = i; break; }
    }
    if (over?.stage !== stage || over.index !== index) setOver({ stage, index });
  };

  return (
    <>
      <div className="board" role="list" aria-label="Sales pipeline">
        {columns.map((c) => (
          <section key={c.stage} className={`board-col ${over?.stage === c.stage ? 'over' : ''} ${c.stage}`}
            onDragOver={(e) => { e.preventDefault(); indexFromEvent(e, c.stage); }}
            onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(null); }}
            onDrop={onDrop(c.stage)}>
            <header>
              <div className="row"><i className="stage-pip" style={{ background: STAGE_COLOR[c.stage] }} /><b>{c.label}</b><span className="faint num">{c.count}</span></div>
              <span className="faint num" style={{ fontSize: 12 }}>{c.value ? moneyShort(c.value) : ''}</span>
            </header>
            <div className="board-list">
              {c.leads.map((l, i) => (
                <div key={l.id}>
                  {over?.stage === c.stage && over.index === i && drag && <div className="drop-marker" />}
                  <LeadCard lead={l} dragging={drag?.id === l.id} onOpen={() => onOpen(l.id)}
                    onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', l.id); setDrag({ id: l.id, from: c.stage }); }} />
                </div>
              ))}
              {over?.stage === c.stage && over.index >= c.leads.filter((l) => l.id !== drag?.id).length && drag && <div className="drop-marker" />}
              {!c.leads.length && <div className="board-empty">{c.stage === 'won' ? 'Drop here to convert' : c.stage === 'lost' ? 'Drop here to close' : 'No leads'}</div>}
            </div>
          </section>
        ))}
      </div>
      {pending?.stage === 'won' && <ConvertLeadDialog lead={pending.lead} onClose={() => setPending(null)} />}
      {pending?.stage === 'lost' && (
        <LostDialog lead={pending.lead} busy={move.isPending} onClose={() => setPending(null)}
          onConfirm={(reason) => { move.mutate({ id: pending.lead.id, stage: 'lost', beforeId: pending.beforeId, afterId: pending.afterId, lostReason: reason }); setPending(null); }} />
      )}
    </>
  );
}

// ---------------------------------------------------------------- drawer --

function LeadDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const { data: lead, error } = useQuery({ queryKey: ['lead', id], queryFn: () => api.get<any>(`/leads/${id}`) });
  const [dialog, setDialog] = useState<null | 'edit' | 'convert' | 'lost' | 'contact' | 'followup' | { complete: any }>(null);
  const move = useMutation({
    mutationFn: (v: { stage: string; lostReason?: string }) => api.post(`/leads/${id}/move`, v),
    onSuccess: () => { qc.invalidateQueries(); setDialog(null); },
    onError: (e) => toast('error', e instanceof ApiError ? e.message : 'Failed'),
  });
  const reopen = useMutation({ mutationFn: () => api.post(`/leads/${id}/reopen`), onSuccess: () => qc.invalidateQueries() });

  if (error) return <Dialog open variant="drawer" onClose={onClose} title="Lead"><Empty title="Lead not found" /></Dialog>;
  const target: ContactTarget | null = lead ? { leadId: lead.id, name: lead.full_name, defaultTemplate: lead.stage === 'trial_booked' ? 'trial_invite' : 'lead_intro', purpose: 'sales' } : null;
  const open = lead && !['won', 'lost'].includes(lead.stage);
  const nextStage = lead && open ? STAGES[Math.min(STAGES.indexOf(lead.stage) + 1, 5)] : null;

  // Merge stage changes and communications into one timeline.
  const timeline = lead ? [
    ...lead.history.map((h: any) => ({ at: h.changed_at, kind: 'stage', text: h.from_stage ? `Moved ${STAGE_LABEL[h.from_stage]} → ${STAGE_LABEL[h.to_stage]}` : 'Lead created', by: h.changed_by_name })),
    ...lead.communications.map((c: any) => ({ at: c.created_at, kind: c.channel, text: `${CHANNEL_LABEL[c.channel]}${c.outcome ? ` · ${OUTCOME_LABEL[c.outcome] ?? c.outcome}` : ''}${c.body ? ` — ${c.body}` : ''}`, by: c.logged_by_name })),
  ].sort((a, b) => b.at.localeCompare(a.at)) : [];

  return (
    <>
      <Dialog open variant="drawer" onClose={onClose} wide title={lead?.full_name ?? 'Lead'} sub={lead ? [lead.phone, lead.email].filter(Boolean).join(' · ') : undefined}
        footer={lead && (
          <>
            {lead.stage === 'lost' && can('leads.write') && <Button icon={<RotateCcw />} loading={reopen.isPending} onClick={() => reopen.mutate()}>Reopen</Button>}
            {lead.stage === 'won' && <Link className="btn primary" to={`/members/${lead.converted_member_id}`} onClick={onClose}>Open member profile</Link>}
            {open && can('leads.write') && <Button variant="ghost" icon={<X />} onClick={() => setDialog('lost')}>Mark lost</Button>}
            {open && can('leads.write') && nextStage && nextStage !== lead.stage && <Button icon={<ArrowRight />} loading={move.isPending} onClick={() => move.mutate({ stage: nextStage })}>Move to {STAGE_LABEL[nextStage]}</Button>}
            {open && can('leads.write', 'members.write') && <Button variant="primary" icon={<UserCheck />} onClick={() => setDialog('convert')}>Convert to member</Button>}
          </>
        )}>
        {!lead ? <Skeleton h={400} /> : (
          <div className="stack">
            <div className="stage-track">
              {STAGES.slice(0, 7).map((s, i) => {
                const reached = lead.stage === 'won' || (lead.stage !== 'lost' && STAGES.indexOf(lead.stage) >= i);
                return (
                  <button key={s} className={`st ${reached ? 'on' : ''} ${lead.stage === s ? 'current' : ''}`} disabled={!open || s === 'won' || !can('leads.write')}
                    onClick={() => s !== lead.stage && move.mutate({ stage: s })} title={STAGE_LABEL[s]}>
                    <span>{STAGE_LABEL[s]}</span>
                  </button>
                );
              })}
            </div>
            {lead.stage === 'lost' && <div className="alert">Lost — {lead.lost_reason}</div>}
            <div className="row wrap">
              {can('communications.log') && <Button size="sm" icon={<MessageCircle />} onClick={() => setDialog('contact')}>Contact</Button>}
              {lead.phone && <a className="btn sm" href={`tel:${lead.phone}`}><Phone />Call</a>}
              {open && can('followups.manage') && <Button size="sm" icon={<CalendarPlus />} onClick={() => setDialog('followup')}>Follow-up</Button>}
              {can('leads.write') && <Button size="sm" icon={<Pencil />} onClick={() => setDialog('edit')}>Edit</Button>}
            </div>
            <div className="grid g-2">
              <dl className="kv" style={{ gridTemplateColumns: '120px 1fr' }}>
                <dt>Stage</dt><dd><StageBadge stage={lead.stage} /></dd>
                <dt>Source</dt><dd>{lead.source_name ?? '—'}{lead.referred_by_name ? ` · by ${lead.referred_by_name}` : ''}</dd>
                <dt>Interested in</dt><dd>{[lead.plan_name, lead.interested_service].filter(Boolean).join(' · ') || '—'}</dd>
                <dt>Potential</dt><dd>{lead.potential_value ? money(lead.potential_value) : '—'}</dd>
                <dt>Budget</dt><dd>{lead.budget ? money(lead.budget) : '—'}</dd>
              </dl>
              <dl className="kv" style={{ gridTemplateColumns: '120px 1fr' }}>
                <dt>Goal</dt><dd>{lead.goal ?? '—'}</dd>
                <dt>Assigned</dt><dd>{lead.assigned_name ?? '—'}</dd>
                <dt>Trial</dt><dd>{lead.trial_at ? dateTime(lead.trial_at) : '—'}</dd>
                <dt>Created</dt><dd>{date(lead.created_at)}</dd>
                <dt>Last contact</dt><dd>{lead.last_contacted_at ? relative(lead.last_contacted_at) : 'Never'}</dd>
              </dl>
            </div>
            {lead.notes && <div className="summary-box">{lead.notes}</div>}
            <div className="section-label">Follow-ups</div>
            {!lead.follow_ups.length ? <div className="faint">None scheduled.</div> : (
              <div className="stack" style={{ gap: 6 }}>
                {lead.follow_ups.map((f: any) => (
                  <div key={f.id} className="fu-row">
                    <span className="fu-ic">{channelIcon(f.type)}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700 }}>{FU_TYPE_LABEL[f.type]} · {PURPOSE_LABEL[f.purpose]}{f.notes ? <span className="muted" style={{ fontWeight: 500 }}> — {f.notes}</span> : null}</div>
                      <div className="faint" style={{ fontSize: 12 }}>
                        {f.status === 'pending' ? `${f.assigned_name ?? 'Unassigned'}` : `${f.status === 'done' ? OUTCOME_LABEL[f.outcome] ?? 'Done' : 'Cancelled'}${f.outcome_notes ? ` — ${f.outcome_notes}` : ''} · ${f.completed_by_name ?? ''} · ${relative(f.completed_at)}`}
                      </div>
                    </div>
                    {f.status === 'pending' ? <><DueBadge due={f.due_at} />{can('followups.manage') && <Button size="sm" onClick={() => setDialog({ complete: { ...f, subject_name: lead.full_name } })}>Done</Button>}</> : <span className="badge neutral">{f.status}</span>}
                  </div>
                ))}
              </div>
            )}
            <div className="section-label">Timeline</div>
            <div className="feed">
              {timeline.map((t, i) => (
                <div className="feed-item" key={i}>
                  <div className={`ic ${t.kind === 'stage' ? 'ms' : ''}`}>{t.kind === 'stage' ? <ArrowRight /> : channelIcon(t.kind)}</div>
                  <div><div className="txt">{t.text}</div><div className="when">{dateTime(t.at)}{t.by ? ` · ${t.by}` : ''}</div></div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Dialog>
      {lead && dialog === 'edit' && <LeadFormDialog lead={lead} onClose={() => setDialog(null)} />}
      {lead && dialog === 'convert' && <ConvertLeadDialog lead={lead} onClose={() => setDialog(null)} />}
      {lead && dialog === 'lost' && <LostDialog lead={lead} busy={move.isPending} onClose={() => setDialog(null)} onConfirm={(r) => move.mutate({ stage: 'lost', lostReason: r })} />}
      {target && dialog === 'contact' && <ContactDialog target={target} onClose={() => setDialog(null)} />}
      {target && dialog === 'followup' && <FollowUpDialog target={target} onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === 'object' && <CompleteFollowUpDialog followUp={dialog.complete} onClose={() => setDialog(null)} />}
    </>
  );
}

// ------------------------------------------------------------------- list --

function LeadList({ filters, onOpen }: { filters: Record<string, string | undefined>; onOpen: (id: string) => void }) {
  const [stage, setStage] = useState('open');
  const [page, setPage] = useState(1);
  const { data } = useQuery({
    queryKey: ['leads', filters, stage, page],
    queryFn: () => api.get<Paged<any>>('/leads', { ...filters, stage, page, pageSize: 25 }),
    placeholderData: keepPreviousData,
  });
  return (
    <section className="card">
      <div className="toolbar">
        <div className="chips">
          {[['open', 'Open'], ...STAGES.map((s) => [s, STAGE_LABEL[s]])].map(([k, l]) => (
            <button key={k} className={`chip ${stage === k ? 'on' : ''}`} onClick={() => { setStage(k); setPage(1); }}>{l}</button>
          ))}
        </div>
      </div>
      <div className="table-wrap">
        {!data ? <div style={{ padding: 20 }}><Skeleton h={300} /></div> : !data.data.length ? <Empty title="No leads match" /> : (
          <table className="tbl">
            <thead><tr><th>Lead</th><th>Stage</th><th>Source</th><th>Interested in</th><th className="r">Potential</th><th>Next follow-up</th><th className="hide-sm">Owner</th><th className="hide-sm">Created</th></tr></thead>
            <tbody>{data.data.map((l) => (
              <tr key={l.id} className="clickable" onClick={() => onOpen(l.id)}>
                <td><Person name={l.full_name} detail={l.phone ?? l.email} /></td>
                <td><StageBadge stage={l.stage} /></td>
                <td className="muted">{l.source_name ?? '—'}</td>
                <td className="muted">{l.plan_name ?? l.interested_service ?? '—'}</td>
                <td className="r amount">{l.potential_value ? money(l.potential_value) : '—'}</td>
                <td>{['won', 'lost'].includes(l.stage) ? <span className="faint">—</span> : <DueBadge due={l.next_follow_up_at} />}</td>
                <td className="muted hide-sm">{l.assigned_name ?? '—'}</td>
                <td className="muted hide-sm">{relative(l.created_at)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {data && data.pagination.total > 0 && <Pagination {...data.pagination} onPage={setPage} />}
    </section>
  );
}

// ------------------------------------------------------------------- page --

export function LeadsPage() {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const [view, setView] = useState<'board' | 'list'>(() => {
    try { return (localStorage.getItem('forge.leads.view') as 'board' | 'list') ?? 'board'; } catch { return 'board'; }
  });
  const [search, setSearch] = useState('');
  const [mine, setMine] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const [adding, setAdding] = useState(false);
  const term = useDebounced(search.trim());
  const openId = params.get('lead');
  const openLead = (id: string | null) => {
    const next = new URLSearchParams(params);
    id ? next.set('lead', id) : next.delete('lead');
    setParams(next, { replace: !id });
  };
  const filters = { search: term || undefined, assignedTo: mine ? 'me' : undefined, sourceId: sourceId || undefined };
  const { data: columns } = useQuery({ queryKey: ['lead-board', filters], queryFn: () => api.get<Column[]>('/leads/board', filters), enabled: view === 'board', placeholderData: keepPreviousData });
  const { data: sources } = useQuery({ queryKey: ['lead-sources'], queryFn: () => api.get<any[]>('/leads/sources') });
  const openValue = (columns ?? []).filter((c) => !['won', 'lost'].includes(c.stage)).reduce((s, c) => s + c.value, 0);
  const openCount = (columns ?? []).filter((c) => !['won', 'lost'].includes(c.stage)).reduce((s, c) => s + c.count, 0);

  return (
    <div className="page" style={{ maxWidth: view === 'board' ? 'none' : undefined }}>
      <div className="page-head">
        <div>
          <h1>Leads</h1>
          <div className="sub">{view === 'board' && columns ? <>{openCount} open · <b className="num" style={{ color: 'var(--text)' }}>{money(openValue)}</b> potential · drag cards between stages</> : 'Every enquiry, from first contact to member.'}</div>
        </div>
        <div className="actions">
          <Segmented value={view} onChange={(v) => { setView(v); try { localStorage.setItem('forge.leads.view', v); } catch { /* ignore */ } }}
            options={[{ value: 'board', label: 'Board' }, { value: 'list', label: 'List' }]} />
          {can('leads.write') && <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>Add lead</Button>}
        </div>
      </div>
      <div className="row wrap">
        <div className="search-box" style={{ width: 280 }}><Search /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search leads" style={{ paddingRight: 12 }} /></div>
        <button className={`chip ${!mine ? 'on' : ''}`} onClick={() => setMine(false)}>All leads</button>
        <button className={`chip ${mine ? 'on' : ''}`} onClick={() => setMine(true)}>Assigned to me</button>
        <select className="select" style={{ width: 170 }} value={sourceId} onChange={(e) => setSourceId(e.target.value)} aria-label="Source">
          <option value="">All sources</option>{sources?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <span className="faint hide-sm" style={{ marginLeft: 'auto', fontSize: 12 }}>{view === 'board' ? <><Columns3 size={13} style={{ verticalAlign: -2 }} /> Won and lost show the last 30 days</> : <><List size={13} style={{ verticalAlign: -2 }} /> All time</>}</span>
      </div>
      {view === 'board' ? (!columns ? <Skeleton h={480} /> : <Board columns={columns} onOpen={openLead} />) : <LeadList filters={filters} onOpen={openLead} />}
      {openId && <LeadDrawer id={openId} onClose={() => openLead(null)} />}
      {adding && <LeadFormDialog onClose={() => setAdding(false)} onCreated={(id) => openLead(id)} />}
    </div>
  );
}

