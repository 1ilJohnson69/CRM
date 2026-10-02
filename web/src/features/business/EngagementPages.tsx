import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Award, Check, Coins, Gift, HandHeart, Plus, Search, Settings2, Sparkles, Trophy, UserPlus, Users, X } from 'lucide-react';
import { api, ApiError, type Paged } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced, useToast } from '../../lib/ui';
import { date, dateTime, money, number, relative } from '../../lib/format';
import { Alert, Button, Card, Dialog, Empty, Field, Pagination, Person, Skeleton } from '../../components/ui';
import { Bars } from '../../components/charts';
import { MemberPicker, type MemberPick } from '../shared';
import { REASON_LABEL, REFERRAL_TONE } from './common';

const errMsg = (e: unknown) => (e instanceof ApiError ? (Array.isArray(e.details) ? `${(e.details as any)[0].path ?? ''} ${(e.details as any)[0].message}`.trim() : e.message) : 'Something went wrong');
const pts = (n: number) => `${n > 0 ? '+' : ''}${number(n)}`;

export function AwardPointsDialog({ member, onClose }: { member?: MemberPick | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [m, setM] = useState<MemberPick | null>(member ?? null);
  const [reason, setReason] = useState<'event' | 'challenge' | 'manual'>('event');
  const [points, setPoints] = useState<number | ''>('');
  const [deduct, setDeduct] = useState(false);
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: () => api.post('/loyalty/award', { memberId: m!.id, points: (deduct ? -1 : 1) * Number(points), reason, description }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['loyalty'] }); qc.invalidateQueries({ queryKey: ['loyalty-member'] }); toast('success', 'Points updated'); onClose(); },
    onError: (e) => setError(errMsg(e)),
  });
  return (
    <Dialog open onClose={onClose} title="Award or adjust points" sub="For events, challenges and goodwill. Purchases, renewals, referrals and visit milestones award themselves."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!m || !points || description.trim().length < 3} loading={save.isPending} onClick={() => { setError(''); save.mutate(); }}>{deduct ? 'Deduct' : 'Award'} {points || ''} points</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <Field label="Member"><MemberPicker value={m} onChange={setM} /></Field>
        <Field label="For">
          <div className="chips">{(['event', 'challenge', 'manual'] as const).map((r) => <button type="button" key={r} className={`chip ${reason === r ? 'on' : ''}`} onClick={() => { setReason(r); if (r !== 'manual') setDeduct(false); }}>{r === 'manual' ? 'Correction' : REASON_LABEL[r]}</button>)}</div>
        </Field>
        <div className="form-grid">
          <Field label="Points"><input className="input num" type="number" min={1} value={points} onChange={(e) => setPoints(e.target.value === '' ? '' : Math.abs(Number(e.target.value)))} /></Field>
          {reason === 'manual' && <Field label="Direction"><select className="select" value={deduct ? 'd' : 'a'} onChange={(e) => setDeduct(e.target.value === 'd')}><option value="a">Add</option><option value="d">Deduct</option></select></Field>}
        </div>
        <Field label="Description" hint="Shown to the member in their app"><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Forge Anniversary 5K — finisher" /></Field>
      </div>
    </Dialog>
  );
}

export function ReferralDialog({ referrer, onClose }: { referrer?: MemberPick | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [m, setM] = useState<MemberPick | null>(referrer ?? null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: () => api.post('/referrals', { referrerMemberId: m!.id, name, phone, notes: notes || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['referrals'] }); qc.invalidateQueries({ queryKey: ['loyalty-member'] }); toast('success', `${name} added to the pipeline as a referral`); onClose(); },
    onError: (e) => setError(errMsg(e)),
  });
  return (
    <Dialog open onClose={onClose} title="Record a referral" sub="Creates a lead in the sales pipeline with a first call due within the hour. The reward is issued once the friend joins and pays."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!m || name.trim().length < 2 || phone.trim().length < 10} loading={save.isPending} onClick={() => { setError(''); save.mutate(); }}>Add referral</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <Field label="Referred by"><MemberPicker value={m} onChange={setM} /></Field>
        <div className="form-grid">
          <Field label="Friend’s name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Phone"><input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" /></Field>
        </div>
        <Field label="Notes"><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Interested in morning batch, wants PT…" /></Field>
      </div>
    </Dialog>
  );
}

function RulesDialog({ settings, onClose }: { settings: any; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState(settings);
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: () => api.put('/loyalty/settings', f),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['loyalty'] }); onClose(); },
    onError: (e) => setError(errMsg(e)),
  });
  const num = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value === '' ? '' : Number(e.target.value) });
  return (
    <Dialog open variant="drawer" onClose={onClose} title="Loyalty rules" sub="Changes apply to points earned from now on; existing balances are kept."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => { setError(''); save.mutate(); }}>Save rules</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <label className="check"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />Loyalty programme is on</label>
        <div className="section-label">Earning</div>
        <div className="form-grid">
          <Field label="Points per ₹100 paid"><input className="input num" type="number" step="0.5" min={0} value={f.pointsPer100} onChange={num('pointsPer100')} /></Field>
          <Field label="Renewal bonus"><input className="input num" type="number" min={0} value={f.renewalPoints} onChange={num('renewalPoints')} /></Field>
          <Field label="Referral reward (referrer)"><input className="input num" type="number" min={0} value={f.referralPoints} onChange={num('referralPoints')} /></Field>
          <Field label="Welcome bonus (friend)"><input className="input num" type="number" min={0} value={f.refereePoints} onChange={num('refereePoints')} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={f.autoRewardReferrals} onChange={(e) => setF({ ...f, autoRewardReferrals: e.target.checked })} />Reward referrals automatically when the friend’s first membership is paid</label>
        <div className="section-label">Visit milestones</div>
        <div className="milestones">
          {f.milestones.map((m: any, i: number) => (
            <div key={i} className="milestone-row">
              <Field label="Visits"><input className="input num" type="number" min={1} value={m.visits} onChange={(e) => setF({ ...f, milestones: f.milestones.map((x: any, j: number) => (j === i ? { ...x, visits: Number(e.target.value) } : x)) })} /></Field>
              <Field label="Points"><input className="input num" type="number" min={1} value={m.points} onChange={(e) => setF({ ...f, milestones: f.milestones.map((x: any, j: number) => (j === i ? { ...x, points: Number(e.target.value) } : x)) })} /></Field>
              <button className="icon-btn" style={{ width: 36, height: 36 }} aria-label="Remove milestone" onClick={() => setF({ ...f, milestones: f.milestones.filter((_: any, j: number) => j !== i) })}><X /></button>
            </div>
          ))}
          {f.milestones.length < 12 && <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setF({ ...f, milestones: [...f.milestones, { visits: (f.milestones.at(-1)?.visits ?? 0) + 50, points: 100 }] })}>Add milestone</Button>}
        </div>
        <div className="section-label">Redeeming</div>
        <div className="form-grid">
          <Field label="Value of 1 point (₹)"><input className="input num" type="number" step="0.05" min={0.01} value={f.pointValue} onChange={num('pointValue')} /></Field>
          <Field label="Minimum to redeem"><input className="input num" type="number" min={0} value={f.minRedeem} onChange={num('minRedeem')} /></Field>
          <Field label="Max % of a bill" className="full"><input className="input num" type="number" min={0} max={100} value={f.maxRedeemPct} onChange={num('maxRedeemPct')} /></Field>
        </div>
        <Alert tone="info">Members redeem at the POS. At these rules, {number(f.minRedeem)} points = {money(f.minRedeem * f.pointValue)} off, up to {f.maxRedeemPct}% of a bill.</Alert>
      </div>
    </Dialog>
  );
}

function LoyaltyOverview() {
  const { can } = useAuth();
  const [award, setAward] = useState(false);
  const [rules, setRules] = useState(false);
  const [page, setPage] = useState(1);
  const { data } = useQuery({ queryKey: ['loyalty', 'summary'], queryFn: () => api.get<any>('/loyalty/summary') });
  const { data: tx } = useQuery({ queryKey: ['loyalty', 'tx', page], queryFn: () => api.get<Paged<any>>('/loyalty/transactions', { page, pageSize: 20 }) });
  if (!data) return <Skeleton h={400} />;
  const s = data.settings;
  const maxReason = Math.max(1, ...data.byReason.map((r: any) => r.points));
  return (
    <div className="stack">
      {!s.enabled && <Alert tone="warning">The loyalty programme is switched off — members don’t earn or redeem points.</Alert>}
      <div className="grid g-4">
        <section className="card kpi hero"><div className="label"><Coins />Points outstanding</div><div className="value">{number(data.outstanding)}</div><div className="compare">worth {money(data.liability)} in discounts</div></section>
        <section className="card kpi"><div className="label"><Users />Members with points</div><div className="value">{number(data.members_with_points)}</div><div className="compare">in scope</div></section>
        <section className="card kpi"><div className="label"><Sparkles />Earned · 30 days</div><div className="value">{number(data.earned_30d)}</div><div className="compare">all sources</div></section>
        <section className="card kpi"><div className="label"><Gift />Redeemed · 30 days</div><div className="value">{number(data.redeemed_30d)}</div><div className="compare">{money(data.redeemed_30d * s.pointValue)} off bills</div></section>
      </div>
      <div className="grid g-dash-1">
        <Card title="Points earned per week" icon={<Sparkles />} sub="Last 12 weeks">
          <Bars data={data.trend.map((t: any) => ({ key: t.date, value: t.value }))} height={190} label={(k) => new Date(k).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} valueLabel={(v) => `${number(v)} points`} />
        </Card>
        <Card title="How members earn" icon={<Award />} sub="Last 90 days"
          actions={can('loyalty.manage') && <Button size="sm" variant="ghost" icon={<Settings2 />} onClick={() => setRules(true)}>Rules</Button>}>
          <div className="stack" style={{ gap: 10 }}>{data.byReason.map((r: any) => (
            <div key={r.reason} className="pnl-row" style={{ gridTemplateColumns: '120px minmax(0,1fr) 70px' }}>
              <span className="muted">{REASON_LABEL[r.reason]}</span>
              <div className="share-bar"><i style={{ width: `${(r.points / maxReason) * 100}%` }} /></div>
              <b className="num" style={{ textAlign: 'right' }}>{number(r.points)}</b>
            </div>
          ))}</div>
          <div className="faint" style={{ fontSize: 12.5, marginTop: 12 }}>
            {s.pointsPer100} pt per ₹100 · renewal +{s.renewalPoints} · referral +{s.referralPoints} / friend +{s.refereePoints} · 1 pt = {money(s.pointValue, true)}
          </div>
        </Card>
      </div>
      <div className="grid g-dash-2">
        <Card title="Recent activity" icon={<Coins />} bodyClass=""
          actions={can('loyalty.manage') && <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setAward(true)}>Award points</Button>}>
          <div className="table-wrap" style={{ marginTop: 6 }}>
            {!tx ? <div style={{ padding: 20 }}><Skeleton h={200} /></div> : (
              <table className="tbl"><tbody>{tx.data.map((t) => (
                <tr key={t.id}>
                  <td><Link to={`/members/${t.member_id}?tab=loyalty`}><Person name={t.member_name} detail={t.member_code} size="sm" /></Link></td>
                  <td><span className="badge neutral">{REASON_LABEL[t.reason]}</span><div className="faint" style={{ fontSize: 12, marginTop: 2 }}>{t.description}</div></td>
                  <td className="muted hide-sm" style={{ whiteSpace: 'nowrap' }}>{relative(t.created_at)}</td>
                  <td className={`r num ${t.points > 0 ? 'qty-in' : 'qty-out'}`}>{pts(t.points)}</td>
                </tr>
              ))}</tbody></table>
            )}
          </div>
          {tx && <Pagination page={tx.pagination.page} totalPages={tx.pagination.totalPages} total={tx.pagination.total} onPage={setPage} />}
        </Card>
        <Card title="Top balances" icon={<Trophy />}>
          <div className="stack" style={{ gap: 8 }}>{data.top.map((m: any, i: number) => (
            <Link key={m.id} to={`/members/${m.id}?tab=loyalty`} className="row between">
              <span className="row"><span className="faint num" style={{ width: 18 }}>{i + 1}</span><Person name={m.full_name} detail={`${number(m.earned)} earned · ${number(m.redeemed)} redeemed`} size="sm" /></span>
              <b className="num">{number(m.balance)}</b>
            </Link>
          ))}</div>
        </Card>
      </div>
      {award && <AwardPointsDialog onClose={() => setAward(false)} />}
      {rules && <RulesDialog settings={s} onClose={() => setRules(false)} />}
    </div>
  );
}

export function LoyaltyPage() {
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Loyalty</h1><div className="sub">Members earn points on payments, renewals, referrals, visit milestones, events and challenges — and redeem them at the POS.</div></div>
      </div>
      <LoyaltyOverview />
    </div>
  );
}

function RejectDialog({ referral, onClose }: { referral: any; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api.post(`/referrals/${referral.id}/reject`, { reason }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['referrals'] }); onClose(); } });
  return (
    <Dialog open onClose={onClose} title={`Reject referral of ${referral.referred_name}?`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" disabled={reason.trim().length < 3} loading={m.isPending} onClick={() => m.mutate()}>Reject</Button></>}>
      <Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Already a lead, duplicate, not interested…" autoFocus /></Field>
    </Dialog>
  );
}

const STATUS_TEXT: Record<string, string> = { pending: 'Lead', joined: 'Joined', verified: 'Verified', rewarded: 'Rewarded', rejected: 'Rejected' };

export function ReferralsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [rejecting, setRejecting] = useState<any>(null);
  const term = useDebounced(q.trim());
  const { data: sum } = useQuery({ queryKey: ['referrals', 'summary'], queryFn: () => api.get<any>('/referrals/summary') });
  const { data } = useQuery({ queryKey: ['referrals', status, term, page], queryFn: () => api.get<Paged<any>>('/referrals', { status: status || undefined, search: term || undefined, page, pageSize: 25 }) });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'verify' | 'reward' }) => api.post(`/referrals/${id}/${action}`, {}),
    onSuccess: (_, v) => { qc.invalidateQueries({ queryKey: ['referrals'] }); toast('success', v.action === 'reward' ? 'Reward issued' : 'Referral verified'); },
    onError: (e) => toast('error', errMsg(e)),
  });
  const conv = sum && sum.last_90 ? Math.round((sum.converted_90 / sum.last_90) * 100) : 0;
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Referrals</h1><div className="sub">Member A refers a friend → the friend joins → the referral is verified on their first paid membership → rewards are issued.</div></div>
        <div className="actions">{can('referrals.manage') && can('leads.write') && <Button variant="primary" icon={<UserPlus />} onClick={() => setAdding(true)}>Record referral</Button>}</div>
      </div>
      <div className="grid g-4">
        <section className="card kpi hero"><div className="label"><HandHeart />Referrals</div><div className="value">{sum?.total ?? '—'}</div><div className="compare">{sum?.last_90 ?? 0} in the last 90 days</div></section>
        <section className="card kpi"><div className="label"><Users />Joined</div><div className="value">{sum ? sum.joined + sum.verified + sum.rewarded : '—'}</div><div className="compare">{conv}% of recent referrals converted</div></section>
        <section className="card kpi"><div className="label"><Check />Awaiting action</div><div className="value" style={{ color: sum?.verified || sum?.joined ? 'var(--warning)' : undefined }}>{sum ? sum.joined + sum.verified : '—'}</div><div className="compare">{sum?.joined ?? 0} unpaid · {sum?.verified ?? 0} to reward</div></section>
        <section className="card kpi"><div className="label"><Gift />Points issued</div><div className="value">{number(sum?.points_issued ?? 0)}</div><div className="compare">to referrers and friends</div></section>
      </div>
      <div className="grid g-dash-1">
        <section className="card">
          <div className="toolbar">
            <div className="search-box"><Search /><input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Friend or referrer" /></div>
            <div className="chips">{['', 'pending', 'joined', 'verified', 'rewarded', 'rejected'].map((k) => (
              <button key={k} className={`chip ${status === k ? 'on' : ''}`} onClick={() => { setParams(k ? { status: k } : {}); setPage(1); }}>{k ? STATUS_TEXT[k] : 'All'}{sum && k ? <span className="c">{sum[k]}</span> : null}</button>
            ))}</div>
          </div>
          <div className="table-wrap">
            {!data ? <div style={{ padding: 20 }}><Skeleton h={300} /></div> : !data.data.length ? <Empty title="No referrals here" /> : (
              <table className="tbl">
                <thead><tr><th>Friend</th><th>Referred by</th><th>Status</th><th className="hide-sm">Since</th><th /></tr></thead>
                <tbody>{data.data.map((r) => (
                  <tr key={r.id}>
                    <td>{r.referred_member_id ? <Link to={`/members/${r.referred_member_id}`}><Person name={r.referred_member_name ?? r.referred_name} detail={r.referred_member_code} size="sm" /></Link>
                      : <Person name={r.referred_name} detail={r.lead_stage ? `Lead · ${r.lead_stage.replace('_', ' ')}` : r.referred_phone} size="sm" />}</td>
                    <td><Link to={`/members/${r.referrer_member_id}?tab=loyalty`}><Person name={r.referrer_name} detail={r.referrer_code} size="sm" /></Link></td>
                    <td><span className={`badge ${REFERRAL_TONE[r.status]}`}>{STATUS_TEXT[r.status]}</span>
                      <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>{r.status === 'rewarded' ? `+${r.reward_points} pts ${date(r.rewarded_at)}` : r.status === 'rejected' ? r.rejected_reason : r.source === 'app' ? 'via member app' : ''}</div></td>
                    <td className="muted hide-sm">{relative(r.created_at)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {can('referrals.manage') && r.status === 'joined' && <Button size="sm" onClick={() => act.mutate({ id: r.id, action: 'verify' })}>Verify</Button>}
                      {can('referrals.manage') && can('loyalty.manage') && r.status === 'verified' && <Button size="sm" variant="primary" icon={<Gift />} onClick={() => act.mutate({ id: r.id, action: 'reward' })}>Reward</Button>}
                      {can('referrals.manage') && ['pending', 'joined', 'verified'].includes(r.status) && <Button size="sm" variant="ghost" icon={<X />} aria-label="Reject" onClick={() => setRejecting(r)} />}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
          {data && <Pagination page={data.pagination.page} totalPages={data.pagination.totalPages} total={data.pagination.total} onPage={setPage} />}
        </section>
        <div className="stack">
          <Card title="Top referrers" icon={<Trophy />}>
            {!sum ? <Skeleton h={200} /> : <div className="stack" style={{ gap: 8 }}>{sum.top.map((m: any) => (
              <Link key={m.id} to={`/members/${m.id}?tab=loyalty`} className="row between">
                <Person name={m.full_name} detail={`${m.referrals} referred · ${m.joined} joined`} size="sm" />
                <span className="faint num">{number(m.points)} pts</span>
              </Link>
            ))}</div>}
          </Card>
          <Card title="Referrals per month" icon={<HandHeart />}>
            {sum && <Bars data={sum.monthly.map((m: any) => ({ key: m.date, value: m.value }))} height={150} label={(k) => new Date(k).toLocaleDateString('en-IN', { month: 'short' })} valueLabel={(v) => `${v} referrals`} />}
          </Card>
        </div>
      </div>
      {adding && <ReferralDialog onClose={() => setAdding(false)} />}
      {rejecting && <RejectDialog referral={rejecting} onClose={() => setRejecting(null)} />}
    </div>
  );
}

/** Member profile tab: balance, referral code, ledger and the friends they've referred. */
export function LoyaltyTab({ m }: { m: any }) {
  const { can } = useAuth();
  const [award, setAward] = useState(false);
  const [refer, setRefer] = useState(false);
  const { data } = useQuery({ queryKey: ['loyalty-member', m.id], queryFn: () => api.get<any>(`/loyalty/members/${m.id}`) });
  if (!data) return <Skeleton h={300} />;
  const pick = { id: m.id, full_name: m.full_name, member_code: m.member_code };
  return (
    <div className="stack">
      <div className="grid g-4">
        <section className="card kpi hero"><div className="label"><Coins />Balance</div><div className="value">{number(data.balance)}</div><div className="compare">worth {money(data.value)} at the POS</div></section>
        <section className="card kpi"><div className="label"><Sparkles />Earned</div><div className="value">{number(data.earned)}</div><div className="compare">lifetime</div></section>
        <section className="card kpi"><div className="label"><Gift />Redeemed</div><div className="value">{number(data.redeemed)}</div><div className="compare">{data.last_activity_at ? `last activity ${relative(data.last_activity_at)}` : 'no activity'}</div></section>
        <section className="card kpi"><div className="label"><HandHeart />Referral code</div><div className="value" style={{ fontSize: 20 }}><span className="code-chip">{data.referralCode}</span></div><div className="compare">{data.referrals.length} referred{data.referredBy ? ` · referred by ${data.referredBy.full_name}` : ''}</div></section>
      </div>
      <div className="grid g-dash-2">
        <Card title="Points history" icon={<Coins />} bodyClass=""
          actions={can('loyalty.manage') && <Button size="sm" icon={<Plus />} onClick={() => setAward(true)}>Award / adjust</Button>}>
          {!data.transactions.length ? <Empty title="No points yet" /> : (
            <div className="table-wrap" style={{ marginTop: 6, maxHeight: 420, overflowY: 'auto' }}><table className="tbl"><tbody>{data.transactions.map((t: any) => (
              <tr key={t.id}>
                <td className="muted" style={{ whiteSpace: 'nowrap' }}>{dateTime(t.created_at)}</td>
                <td><span className="badge neutral">{REASON_LABEL[t.reason]}</span><div className="faint" style={{ fontSize: 12, marginTop: 2 }}>{t.description}</div></td>
                <td className={`r num ${t.points > 0 ? 'qty-in' : 'qty-out'}`}>{pts(t.points)}</td>
              </tr>
            ))}</tbody></table></div>
          )}
        </Card>
        <Card title="Friends referred" icon={<HandHeart />}
          actions={can('referrals.manage') && can('leads.write') && <Button size="sm" icon={<UserPlus />} onClick={() => setRefer(true)}>Add</Button>}>
          {!data.referrals.length ? <Empty title="No referrals yet">Share code <b>{data.referralCode}</b> — they can also refer friends from the app.</Empty> : (
            <div className="stack" style={{ gap: 8 }}>{data.referrals.map((r: any) => (
              <div key={r.id} className="row between">
                {r.referred_member_id ? <Link to={`/members/${r.referred_member_id}`}><Person name={r.referred_member_name ?? r.referred_name} detail={date(r.created_at)} size="sm" /></Link> : <Person name={r.referred_name} detail={date(r.created_at)} size="sm" />}
                <span className={`badge ${REFERRAL_TONE[r.status]}`}>{STATUS_TEXT[r.status]}{r.reward_points ? ` · +${r.reward_points}` : ''}</span>
              </div>
            ))}</div>
          )}
        </Card>
      </div>
      {award && <AwardPointsDialog member={pick} onClose={() => setAward(false)} />}
      {refer && <ReferralDialog referrer={pick} onClose={() => setRefer(false)} />}
    </div>
  );
}
