import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck2, CheckCircle2, Clock, MessageCircle, Sparkles, XCircle } from 'lucide-react';
import { api, type Paged } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/ui';
import { date, relative } from '../../lib/format';
import { Button, Empty, Pagination, Skeleton, StatusBadge } from '../../components/ui';
import {
  channelIcon, CompleteFollowUpDialog, ContactDialog, DueBadge, dueLabel, FU_TYPE_LABEL, OUTCOME_LABEL, PURPOSE_LABEL, StageBadge, type ContactTarget,
} from './common';

const BUCKETS = [
  { key: 'overdue', label: 'Overdue', tone: 'var(--danger)' },
  { key: 'today', label: 'Today', tone: 'var(--warning)' },
  { key: 'upcoming', label: 'Upcoming', tone: 'var(--accent)' },
  { key: 'done', label: 'Completed', tone: 'var(--success)' },
] as const;

/** One follow-up line, used on this page and in dashboard/profile widgets. */
export function FollowUpRow({ f, onComplete, onContact, compact }: { f: any; onComplete?: () => void; onContact?: () => void; compact?: boolean }) {
  const href = f.lead_id ? `/leads?lead=${f.lead_id}` : `/members/${f.member_id}`;
  if (compact) {
    const due = dueLabel(f.due_at);
    return (
      <div className="fu-row">
        <span className="fu-ic">{channelIcon(f.type)}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Link to={href} style={{ fontWeight: 700, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.subject_name}</Link>
          <div style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ color: `var(--${due.tone === 'neutral' ? 'text-3' : due.tone})`, fontWeight: 700 }}>{due.text}</span>
            <span className="faint"> · {PURPOSE_LABEL[f.purpose]}{f.notes ? ` · ${f.notes}` : ''}</span>
          </div>
        </div>
        {onContact && <Button size="sm" variant="ghost" icon={<MessageCircle />} onClick={onContact} aria-label={`Contact ${f.subject_name}`} />}
        {onComplete && <Button size="sm" onClick={onComplete}>Done</Button>}
      </div>
    );
  }
  return (
    <div className="fu-row">
      <span className="fu-ic">{channelIcon(f.type)}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row wrap" style={{ gap: 6 }}>
          <Link to={href} style={{ fontWeight: 700 }}>{f.subject_name}</Link>
          {f.lead_id ? <StageBadge stage={f.lead_stage} /> : f.member_status && <StatusBadge status={f.member_status} />}
          {!compact && <span className="badge neutral">{PURPOSE_LABEL[f.purpose]}</span>}
          {f.auto_generated && !compact && <span className="badge neutral" title="Created by automation"><Sparkles />Auto</span>}
        </div>
        <div className="faint" style={{ fontSize: 12, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {FU_TYPE_LABEL[f.type]}{f.notes ? ` · ${f.notes}` : ''}{!compact && f.assigned_name ? ` · ${f.assigned_name}` : ''}
          {f.status !== 'pending' && ` · ${f.status === 'done' ? OUTCOME_LABEL[f.outcome] ?? 'Done' : 'Cancelled'}${f.outcome_notes ? ` — ${f.outcome_notes}` : ''}`}
        </div>
      </div>
      {f.status === 'pending' ? (
        <>
          <DueBadge due={f.due_at} />
          {onContact && <Button size="sm" variant="ghost" icon={<MessageCircle />} onClick={onContact} aria-label={`Contact ${f.subject_name}`} />}
          {onComplete && <Button size="sm" icon={<CheckCircle2 />} onClick={onComplete}>Done</Button>}
        </>
      ) : <span className="faint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{relative(f.completed_at)}</span>}
    </div>
  );
}

export function FollowUpsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [bucket, setBucket] = useState<string>('today');
  const [scope, setScope] = useState<'me' | 'all'>('me');
  const [page, setPage] = useState(1);
  const [completing, setCompleting] = useState<any>(null);
  const [contact, setContact] = useState<ContactTarget | null>(null);
  const { data: summary } = useQuery({ queryKey: ['fu-summary', scope], queryFn: () => api.get<any>('/follow-ups/summary', { assignedTo: scope }) });
  const { data } = useQuery({
    queryKey: ['follow-ups', bucket, scope, page],
    queryFn: () => api.get<Paged<any>>('/follow-ups', { bucket, assignedTo: scope, page, pageSize: 30 }),
    placeholderData: keepPreviousData,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/follow-ups/${id}/cancel`),
    onSuccess: () => { qc.invalidateQueries(); toast('success', 'Follow-up cancelled'); },
  });
  const counts: Record<string, number> = { overdue: summary?.overdue ?? 0, today: summary?.today ?? 0, upcoming: summary?.upcoming ?? 0, done: summary?.done_today ?? 0 };

  // Group the list by day for scanability.
  const groups: [string, any[]][] = [];
  for (const f of data?.data ?? []) {
    const key = bucket === 'done' ? date(f.completed_at) : date(f.due_at, { weekday: 'long', day: 'numeric', month: 'short' });
    const last = groups.at(-1);
    if (last && last[0] === key) last[1].push(f);
    else groups.push([key, [f]]);
  }

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Follow-ups</h1><div className="sub">Calls, messages and visits owed to leads and members. Renewal follow-ups are created automatically.</div></div>
        <div className="actions">
          <button className={`chip ${scope === 'me' ? 'on' : ''}`} onClick={() => { setScope('me'); setPage(1); }}>My follow-ups</button>
          <button className={`chip ${scope === 'all' ? 'on' : ''}`} onClick={() => { setScope('all'); setPage(1); }}>Everyone</button>
        </div>
      </div>
      <div className="grid g-4">
        {BUCKETS.map((b) => (
          <button key={b.key} className={`card kpi ${bucket === b.key ? 'selected' : ''}`} onClick={() => { setBucket(b.key); setPage(1); }}>
            <div className="label"><i className="stage-pip" style={{ background: b.tone }} />{b.label}{b.key === 'done' ? ' today' : ''}</div>
            <div className="value">{counts[b.key]}</div>
          </button>
        ))}
      </div>
      <section className="card">
        {!data ? <div style={{ padding: 20 }}><Skeleton h={300} /></div> : !data.data.length ? (
          <Empty icon={bucket === 'done' ? <CalendarCheck2 size={20} /> : <Clock size={20} />} title={bucket === 'overdue' ? 'Nothing overdue' : bucket === 'done' ? 'Nothing completed yet' : 'Nothing scheduled'}>
            {bucket === 'overdue' ? 'You’re on top of everything.' : null}
          </Empty>
        ) : (
          <div style={{ padding: '6px 20px 14px' }}>
            {groups.map(([day, items]) => (
              <div key={day}>
                <div className="section-label" style={{ padding: '14px 0 6px' }}>{day} · {items.length}</div>
                <div className="stack" style={{ gap: 6 }}>
                  {items.map((f) => (
                    <div key={f.id} className="row" style={{ gap: 6 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <FollowUpRow f={f}
                          onComplete={can('followups.manage') ? () => setCompleting(f) : undefined}
                          onContact={can('communications.log') ? () => setContact({ leadId: f.lead_id ?? undefined, memberId: f.member_id ?? undefined, name: f.subject_name, purpose: f.purpose, defaultTemplate: f.purpose === 'renewal' ? (f.member_status === 'expired' ? 'membership_expired' : 'renewal_reminder') : f.lead_id ? 'lead_follow_up' : undefined }) : undefined} />
                      </div>
                      {f.status === 'pending' && can('followups.manage') && <Button size="sm" variant="ghost" icon={<XCircle />} title="Cancel" aria-label="Cancel follow-up" onClick={() => cancel.mutate(f.id)} />}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        {data && data.pagination.total > 30 && <Pagination {...data.pagination} onPage={setPage} />}
      </section>
      {completing && <CompleteFollowUpDialog followUp={completing} onClose={() => setCompleting(null)} />}
      {contact && <ContactDialog target={contact} onClose={() => setContact(null)} />}
    </div>
  );
}
