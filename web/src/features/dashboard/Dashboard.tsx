import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle, Ban, CalendarClock, CalendarPlus, CheckCircle2, Clock, Contact, CreditCard, Hourglass, IndianRupee, LineChart, Phone,
  PieChart, RefreshCw, ScanLine, Snowflake, TrendingUp, UserPlus, Users, Wallet, XCircle, Activity as ActivityIcon, Receipt, Award, MessageCircle,
} from 'lucide-react';
import { api, type Paged } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useCountUp } from '../../lib/ui';
import { date, dateShort, daysLabel, money, moneyShort, number, relative, SERVICE_LABEL } from '../../lib/format';
import { Avatar, Button, Card, Empty, Method, Person, Segmented, Skeleton, StatusBadge, Trend } from '../../components/ui';
import { Donut, Sparkline, StackedArea } from '../../components/charts';
import { useActions } from '../actions';

interface Summary {
  activeMembers: { value: number; frozen: number; change: number; series: number[] };
  revenue: { value: number; change: number; today: number; todayCount: number; series: number[] };
  newMembers: { value: number; change: number; series: number[] };
  renewalsDue: { value: number; today: number; atStake: number };
  outstanding: { value: number; invoices: number };
}

function CountUp({ value, format }: { value: number; format: (n: number) => string }) {
  const v = useCountUp(value);
  return <>{format(v)}</>;
}

function Kpi({ label, icon, value, format, trend, compare, spark, hero, to }: {
  label: string; icon: ReactNode; value: number; format: (n: number) => string; trend?: ReactNode; compare: ReactNode; spark?: ReactNode; hero?: boolean; to?: string;
}) {
  const inner = (
    <>
      <div className="label">{icon}{label}</div>
      <div className="value"><CountUp value={value} format={format} /></div>
      <div className="meta">
        <div className="stack" style={{ gap: 4 }}>
          {trend}
          <span className="compare">{compare}</span>
        </div>
        {spark}
      </div>
    </>
  );
  return to ? <Link to={to} className={`card kpi ${hero ? 'hero' : ''}`}>{inner}</Link> : <div className={`card kpi ${hero ? 'hero' : ''}`}>{inner}</div>;
}

function KpiRow() {
  const { data } = useQuery({ queryKey: ['dash', 'summary'], queryFn: () => api.get<Summary>('/dashboard/summary') });
  if (!data) return <div className="kpi-row">{Array.from({ length: 5 }, (_, i) => <div key={i} className="card kpi"><Skeleton h={12} w={110} /><Skeleton h={30} w={130} /><Skeleton h={28} /></div>)}</div>;
  return (
    <div className="kpi-row">
      <Kpi hero label="Active members" icon={<Users />} value={data.activeMembers.value} format={(n) => number(Math.round(n))}
        trend={<Trend value={data.activeMembers.change} />} compare="vs 4 weeks ago" to="/members?status=active"
        spark={<Sparkline values={data.activeMembers.series} color="var(--gold-2)" />} />
      <Kpi label="Revenue · 30 days" icon={<IndianRupee />} value={data.revenue.value} format={moneyShort}
        trend={<Trend value={data.revenue.change} />} compare={`${moneyShort(data.revenue.today)} today`} to="/payments"
        spark={<Sparkline values={data.revenue.series} variant="bars" width={92} />} />
      <Kpi label="New members" icon={<UserPlus />} value={data.newMembers.value} format={(n) => number(Math.round(n))}
        trend={<Trend value={data.newMembers.change} />} compare="this month vs last" to="/members?sort=joined"
        spark={<Sparkline values={data.newMembers.series} />} />
      <Kpi label="Renewals due" icon={<RefreshCw />} value={data.renewalsDue.value} format={(n) => number(Math.round(n))}
        trend={data.renewalsDue.today ? <span className="badge warning"><Hourglass />{data.renewalsDue.today} today</span> : <span className="badge neutral">None today</span>}
        compare={`next 7 days · ${moneyShort(data.renewalsDue.atStake)} at stake`} to="/?focus=renewals" />
      <Kpi label="Outstanding" icon={<Wallet />} value={data.outstanding.value} format={moneyShort}
        trend={<span className="badge warning"><Receipt />{data.outstanding.invoices} invoices</span>} compare="pending collection" to="/invoices?status=outstanding" />
    </div>
  );
}

function QuickActions() {
  const actions = useActions();
  const { can } = useAuth();
  const items: { label: string; icon: ReactNode; onClick?: () => void; hint?: string }[] = [
    { label: 'Add member', icon: <UserPlus />, onClick: can('members.write') ? actions.addMember : undefined },
    { label: 'Record payment', icon: <CreditCard />, onClick: can('payments.create') ? () => actions.recordPayment() : undefined },
    { label: 'Renew membership', icon: <RefreshCw />, onClick: can('memberships.manage') ? () => actions.sellMembership() : undefined },
    { label: 'Add lead', icon: <Contact />, hint: 'Lead management arrives in Phase 2' },
    { label: 'Book appointment', icon: <CalendarPlus />, hint: 'Appointments arrive in Phase 3' },
    { label: 'Check-in member', icon: <ScanLine />, hint: 'Attendance arrives in Phase 3' },
  ];
  return (
    <div className="quick-actions">
      {items.map((i) => (
        <button key={i.label} className="qa" disabled={!i.onClick} onClick={i.onClick} title={i.hint}>
          <span className="ic">{i.icon}</span>{i.label}
        </button>
      ))}
    </div>
  );
}

const SERIES = [
  { key: 'membership', label: SERVICE_LABEL.membership, color: 'var(--series-1)' },
  { key: 'pt', label: SERVICE_LABEL.pt, color: 'var(--series-2)' },
  { key: 'class', label: SERVICE_LABEL.class, color: 'var(--series-3)' },
  { key: 'product', label: SERVICE_LABEL.product, color: 'var(--series-4)' },
  { key: 'other', label: SERVICE_LABEL.other, color: 'var(--series-5)' },
];

function RevenueOverview() {
  const [days, setDays] = useState(30);
  const [hidden, setHidden] = useState<string[]>([]);
  const { data } = useQuery({ queryKey: ['dash', 'revenue', days], queryFn: () => api.get<any>('/dashboard/revenue', { days }) });
  // Only series that carry money in this window; color stays bound to the series, never its rank.
  const present = SERIES.filter((s) => data?.byService.find((b: any) => b.key === s.key)?.value > 0);
  const shown = present.filter((s) => !hidden.includes(s.key));
  const monthly = data?.bucket === 'month';
  return (
    <Card title="Revenue overview" icon={<LineChart />} glow="soft" sub="Collected payments, split by service"
      actions={<Segmented value={days} onChange={setDays} options={[{ value: 7, label: '7D' }, { value: 30, label: '30D' }, { value: 90, label: '90D' }, { value: 365, label: '12M' }]} />}>
      <div className="stat-strip" style={{ marginBottom: 14 }}>
        <div><div className="k">Total revenue</div><div className="v">{data ? money(data.total) : '—'}</div></div>
        <div><div className="k">Avg / day</div><div className="v">{data ? money(data.averageDaily) : '—'}</div></div>
        <div><div className="k">Growth</div><div className="v">{data ? <Trend value={data.growth} /> : '—'}<span className="faint" style={{ fontSize: 11, fontWeight: 600, marginLeft: 6 }}>vs prior {days === 365 ? '12M' : `${days}D`}</span></div></div>
      </div>
      {!data ? <Skeleton h={260} /> : (
        <>
          <StackedArea
            data={data.series} series={shown} height={250}
            xLabel={(r) => monthly ? date(String(r.date), { month: 'short' }) : dateShort(String(r.date))}
            tooltipTitle={(r) => monthly ? date(String(r.date), { month: 'long', year: 'numeric' }) : date(String(r.date), { weekday: 'short', day: 'numeric', month: 'short' })}
            yFormat={moneyShort} valueFormat={(n) => money(n)}
          />
          <div className="legend" style={{ marginTop: 10 }}>
            {present.map((s) => {
              const v = data.byService.find((b: any) => b.key === s.key).value;
              return (
                <button key={s.key} className={hidden.includes(s.key) ? 'off' : ''} aria-pressed={!hidden.includes(s.key)}
                  onClick={() => setHidden((h) => (h.includes(s.key) ? h.filter((x) => x !== s.key) : [...h, s.key]))}>
                  <i style={{ background: s.color }} />{s.label} <b className="num" style={{ color: 'var(--text)' }}>{moneyShort(v)}</b>
                </button>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
}

const HEALTH: Record<string, { label: string; color: string; icon: ReactNode }> = {
  active: { label: 'Active', color: 'var(--success)', icon: <CheckCircle2 /> },
  expiring_soon: { label: 'Expiring soon', color: 'var(--warning)', icon: <Hourglass /> },
  expired: { label: 'Expired', color: 'var(--danger)', icon: <XCircle /> },
  frozen: { label: 'Frozen', color: 'var(--info)', icon: <Snowflake /> },
  cancelled: { label: 'Cancelled', color: 'var(--text-3)', icon: <Ban /> },
  pending: { label: 'Payment pending', color: 'var(--accent)', icon: <Clock /> },
};

function MembershipHealth() {
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ['dash', 'health'], queryFn: () => api.get<{ status: string; count: number }[]>('/dashboard/membership-health') });
  const total = data?.reduce((s, r) => s + r.count, 0) ?? 0;
  const active = data ? data.filter((r) => r.status === 'active' || r.status === 'expiring_soon').reduce((s, r) => s + r.count, 0) : 0;
  return (
    <Card title="Membership health" icon={<PieChart />} sub="Click a status to open those members">
      {!data ? <Skeleton h={300} /> : (
        <div className="stack" style={{ alignItems: 'center' }}>
          <Donut
            segments={data.filter((r) => HEALTH[r.status]).map((r) => ({ key: r.status, value: r.count, color: HEALTH[r.status].color, label: HEALTH[r.status].label }))}
            center={<div><div className="num" style={{ fontSize: 26, fontWeight: 800 }}>{number(active)}</div><div className="faint" style={{ fontSize: 12, fontWeight: 600 }}>members in good standing</div></div>}
          />
          <div className="health-list" style={{ width: '100%' }}>
            {data.filter((r) => HEALTH[r.status]).map((r) => (
              <button key={r.status} className="health-row" onClick={() => navigate(`/members?status=${r.status}`)}>
                <span className="lbl" style={{ color: 'var(--text)' }}><span style={{ color: HEALTH[r.status].color, display: 'flex' }}>{HEALTH[r.status].icon}</span>{HEALTH[r.status].label}</span>
                <span className="cnt">{number(r.count)}</span>
                <span className="pc">{total ? Math.round((r.count / total) * 100) : 0}%</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

const BUCKETS = [
  { key: 'today', label: 'Expires today', color: 'var(--danger)' },
  { key: 'in3', label: 'In 3 days', color: 'var(--warning)' },
  { key: 'in7', label: 'In 7 days', color: 'var(--accent)' },
  { key: 'expired', label: 'Expired (30d)', color: 'var(--text-3)' },
];

function Attention() {
  const actions = useActions();
  const { can } = useAuth();
  const [params] = useSearchParams();
  const ref = useRef<HTMLDivElement>(null);
  const { data } = useQuery({ queryKey: ['dash', 'attention'], queryFn: () => api.get<any[]>('/dashboard/attention') });
  const counts = useMemo(() => Object.fromEntries(BUCKETS.map((b) => [b.key, data?.filter((r) => r.bucket === b.key).length ?? 0])), [data]);
  const [bucket, setBucket] = useState<string | null>(null);
  const active = bucket ?? BUCKETS.find((b) => counts[b.key] > 0)?.key ?? 'today';
  const rows = (data ?? []).filter((r) => r.bucket === active);
  useEffect(() => {
    if (params.get('focus') === 'renewals') ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [params]);

  return (
    <div ref={ref} style={{ scrollMarginTop: 80, minWidth: 0 }}>
      <Card title="Memberships requiring attention" icon={<AlertCircle />} bodyClass="" sub="Members to contact and renew before they lapse">
        <div style={{ padding: '14px 20px 10px' }} className="bucket-tabs">
          {BUCKETS.map((b) => (
            <button key={b.key} className={`bucket ${active === b.key ? 'on' : ''}`} onClick={() => setBucket(b.key)}>
              <span className="pip" style={{ background: b.color }} />{b.label}<b>{counts[b.key]}</b>
            </button>
          ))}
        </div>
        <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
          {!data ? <div style={{ padding: 20 }}><Skeleton h={180} /></div> : rows.length === 0 ? (
            <Empty icon={<CheckCircle2 size={20} />} title="Nothing here">No memberships in this window. Nice work.</Empty>
          ) : (
            <table className="tbl">
              <thead><tr><th>Member</th><th>Membership</th><th>Expiry</th><th className="r">Renewal</th><th className="hide-sm">Assigned</th><th className="r">Action</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.member_id}>
                    <td><Link to={`/members/${r.member_id}`}><Person name={r.full_name} detail={r.member_code} /></Link></td>
                    <td>{r.plan_name}</td>
                    <td><div style={{ fontWeight: 700 }}>{daysLabel(r.days_remaining)}</div><div className="faint" style={{ fontSize: 12 }}>{date(r.end_date)}</div></td>
                    <td className="r amount">{money(r.renewal_amount)}</td>
                    <td className="hide-sm muted">{r.assigned_staff ?? '—'}</td>
                    <td className="r">
                      <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                        <a className="btn ghost sm" href={`tel:${r.phone}`} title={`Call ${r.phone}`} aria-label={`Call ${r.full_name}`}><Phone /></a>
                        <a className="btn ghost sm" href={`https://wa.me/${r.phone.replace(/\D/g, '')}?text=${encodeURIComponent(`Hi ${r.full_name.split(' ')[0]}, your ${r.plan_name} membership ${r.days_remaining < 0 ? 'expired' : 'expires'} on ${date(r.end_date)}. Renew at the front desk to keep training without a break!`)}`} target="_blank" rel="noreferrer" title="WhatsApp" aria-label={`WhatsApp ${r.full_name}`}><MessageCircle /></a>
                        {can('memberships.manage') && (
                          <Button size="sm" variant="primary" onClick={() => actions.sellMembership({ memberId: r.member_id, memberName: r.full_name, planId: r.plan_id })}>Renew</Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  );
}

const ACTIVITY_ICON: Record<string, { icon: ReactNode; cls: string }> = {
  payment: { icon: <IndianRupee />, cls: 'pay' },
  membership: { icon: <RefreshCw />, cls: 'ms' },
  member: { icon: <UserPlus />, cls: '' },
};

function ActivityFeed() {
  const { data } = useQuery({ queryKey: ['dash', 'activity'], queryFn: () => api.get<any[]>('/dashboard/activity'), refetchInterval: 30_000 });
  return (
    <Card title="Live activity" icon={<ActivityIcon />} actions={<Link className="btn ghost sm" to="/admin/audit">View all</Link>}>
      {!data ? <Skeleton h={300} /> : (
        <div className="feed" style={{ maxHeight: 420, overflowY: 'auto' }}>
          {data.map((a) => {
            const meta = a.action.includes('frozen') ? { icon: <Snowflake />, cls: 'warn' } : a.action.includes('voided') || a.action.includes('cancelled') ? { icon: <Ban />, cls: 'warn' } : ACTIVITY_ICON[a.entity_type] ?? { icon: <ActivityIcon />, cls: '' };
            return (
              <div className="feed-item" key={a.id}>
                <div className={`ic ${meta.cls}`}>{meta.icon}</div>
                <div><div className="txt">{a.summary}</div><div className="when">{relative(a.created_at)}{a.actor ? ` · ${a.actor}` : ''}</div></div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function RecentPayments() {
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ['dash', 'payments'], queryFn: () => api.get<Paged<any>>('/payments', { pageSize: 8 }) });
  return (
    <Card title="Recent payments" icon={<CreditCard />} bodyClass="" actions={<Link className="btn ghost sm" to="/payments">All payments</Link>}>
      <div className="table-wrap" style={{ marginTop: 8 }}>
        {!data ? <div style={{ padding: 20 }}><Skeleton h={240} /></div> : (
          <table className="tbl">
            <thead><tr><th>Member</th><th className="hide-sm">Invoice</th><th className="r">Amount</th><th>Method</th><th className="hide-sm">Collected by</th><th>When</th><th>Status</th></tr></thead>
            <tbody>
              {data.data.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => navigate(`/invoices/${p.invoice_id}`)}>
                  <td><Person name={p.member_name} detail={SERVICE_LABEL[p.services?.split(',')[0]] ?? 'Service'} size="sm" /></td>
                  <td className="hide-sm muted num" style={{ whiteSpace: 'nowrap' }}>{p.invoice_number}</td>
                  <td className="r amount">{money(p.amount)}</td>
                  <td><Method method={p.method} /></td>
                  <td className="hide-sm muted">{p.collected_by_name}</td>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{relative(p.paid_at)}</td>
                  <td><StatusBadge status={p.invoice_status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}

function StaffPerformance() {
  const { data } = useQuery({ queryKey: ['dash', 'staff'], queryFn: () => api.get<any[]>('/dashboard/staff') });
  const max = Math.max(1, ...(data ?? []).map((s) => s.collected));
  return (
    <Card title="Team this month" icon={<Award />} sub="Collections and memberships sold">
      {!data ? <Skeleton h={240} /> : data.length === 0 ? <Empty title="No sales yet this month" /> : (
        <div className="stack" style={{ gap: 14 }}>
          {data.map((s) => (
            <div key={s.id} className="stack" style={{ gap: 6 }}>
              <div className="row between">
                <span className="person"><Avatar name={s.full_name} size="sm" /><span><span className="n">{s.full_name}</span> <span className="faint" style={{ fontSize: 12 }}>· {s.role_name}</span></span></span>
                <b className="num">{money(s.collected)}</b>
              </div>
              <div className="bar-track"><div style={{ width: `${(s.collected / max) * 100}%` }} /></div>
              <div className="row faint" style={{ fontSize: 12, gap: 14 }}>
                <span>{s.collections} collections</span><span>{s.new_sales} new</span><span>{s.renewals} renewals</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export function Dashboard() {
  const { me } = useAuth();
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{greet}, {me?.full_name.split(' ')[0]}</h1>
          <div className="sub">{date(new Date().toISOString(), { weekday: 'long', day: 'numeric', month: 'long' })} · Here’s what’s happening and what needs you today.</div>
        </div>
        <div className="actions"><Link to="/members?status=expiring_soon" className="btn"><CalendarClock />Expiring soon</Link><Link to="/invoices?status=outstanding" className="btn"><TrendingUp />Collections</Link></div>
      </div>
      <KpiRow />
      <QuickActions />
      <div className="grid g-dash-1"><RevenueOverview /><MembershipHealth /></div>
      <div className="grid g-dash-3"><Attention /><ActivityFeed /></div>
      <div className="grid g-dash-2"><RecentPayments /><StaffPerformance /></div>
    </div>
  );
}
