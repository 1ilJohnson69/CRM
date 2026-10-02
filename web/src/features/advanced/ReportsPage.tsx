import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { api, downloadFile } from '../../lib/api';
import { useToast } from '../../lib/ui';
import { date, METHOD_LABEL, money, moneyShort, number, SERVICE_LABEL, today } from '../../lib/format';
import { Button, Card, Empty, Segmented, Skeleton, Tabs } from '../../components/ui';
import { Bars, Heatmap, MetricLine } from '../../components/charts';

type Report = 'revenue' | 'membership' | 'sales' | 'attendance' | 'financial';
const shift = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
const PRESETS: { key: string; label: string; range: () => [string, string] }[] = [
  { key: '30d', label: '30 days', range: () => [shift(today(), -29), today()] },
  { key: '90d', label: '90 days', range: () => [shift(today(), -89), today()] },
  { key: 'ytd', label: 'This year', range: () => [`${today().slice(0, 4)}-01-01`, today()] },
  { key: '12m', label: '12 months', range: () => [shift(today(), -364), today()] },
];
const pct = (a: number, b: number) => (b ? Math.round(((a - b) / Math.abs(b)) * 100) : null);

function ExportButton({ report, table, from, to }: { report: Report; table: string; from: string; to: string }) {
  const toast = useToast();
  return <Button size="sm" variant="ghost" icon={<Download />} aria-label="Export CSV" title="Export CSV"
    onClick={() => downloadFile(`/reports/${report}`, { from, to, format: 'csv', table }).catch((e) => toast('error', e.message))}>CSV</Button>;
}

function Table({ cols, rows, empty = 'No data in this range' }: { cols: [string, string, ((v: any, r: any) => ReactNode)?, boolean?][]; rows: any[]; empty?: string }) {
  if (!rows?.length) return <Empty title={empty} />;
  return (
    <div className="table-wrap" style={{ marginTop: 6 }}><table className="tbl">
      <thead><tr>{cols.map(([k, l, , right]) => <th key={k} className={right ? 'r' : ''}>{l}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{cols.map(([k, , fmt, right]) => <td key={k} className={right ? 'r num' : ''}>{fmt ? fmt(r[k], r) : r[k] ?? '—'}</td>)}</tr>)}</tbody>
    </table></div>
  );
}

function Kpi({ label, value, compare, hero }: { label: string; value: ReactNode; compare?: ReactNode; hero?: boolean }) {
  return <section className={`card kpi ${hero ? 'hero' : ''}`}><div className="label">{label}</div><div className="value">{value}</div>{compare && <div className="compare">{compare}</div>}</section>;
}

const Share = ({ rows, k, v, label, fmt }: { rows: any[]; k: string; v: string; label: (x: string) => string; fmt: (n: number) => string }) => {
  const total = rows.reduce((s, r) => s + Number(r[v]), 0) || 1;
  const max = Math.max(1, ...rows.map((r) => Number(r[v])));
  return (
    <div className="stack" style={{ gap: 10 }}>{rows.map((r) => (
      <div key={r[k]} className="pnl-row" style={{ gridTemplateColumns: '120px minmax(0,1fr) 130px' }}>
        <span className="muted">{label(r[k])}</span>
        <div className="share-bar"><i style={{ width: `${(Number(r[v]) / max) * 100}%` }} /></div>
        <span className="num" style={{ textAlign: 'right' }}><b>{fmt(Number(r[v]))}</b> <span className="faint">{Math.round((Number(r[v]) / total) * 100)}%</span></span>
      </div>
    ))}</div>
  );
};

function Revenue({ d, from, to }: { d: any; from: string; to: string }) {
  const change = pct(d.totals.net, d.totals.previousNet);
  return (
    <div className="stack">
      <div className="grid g-4">
        <Kpi hero label="Net revenue" value={money(d.totals.net)} compare={change === null ? 'no previous data' : `${change >= 0 ? '+' : ''}${change}% vs previous ${d.bucket === 'day' ? 'period' : 'equal period'}`} />
        <Kpi label="Collected" value={money(d.totals.gross)} compare={`${number(d.totals.payments)} payments`} />
        <Kpi label="Refunds" value={money(d.totals.refunds)} compare="returned to customers" />
        <Kpi label="Average per day" value={money(d.totals.avgPerDay)} />
      </div>
      <Card title="Net revenue" sub={`per ${d.bucket}`}><MetricLine points={d.trend.map((t: any) => ({ date: t.date, value: Number(t.revenue) }))} format={moneyShort} better="up" height={220} /></Card>
      <div className="grid g-2">
        <Card title="By service" actions={<ExportButton report="revenue" table="byService" from={from} to={to} />}><Share rows={d.byService} k="service" v="revenue" label={(x) => SERVICE_LABEL[x] ?? x} fmt={(n) => money(n)} /></Card>
        <Card title="By payment method" actions={<ExportButton report="revenue" table="byMethod" from={from} to={to} />}><Share rows={d.byMethod} k="method" v="revenue" label={(x) => METHOD_LABEL[x] ?? x} fmt={(n) => money(n)} /></Card>
      </div>
      <div className="grid g-2">
        <Card title="By branch" bodyClass="" actions={<ExportButton report="revenue" table="byBranch" from={from} to={to} />}>
          <Table rows={d.byBranch} cols={[['branch', 'Branch'], ['payments', 'Payments', number, true], ['refunds', 'Refunds', (v) => money(v), true], ['revenue', 'Collected', (v) => <b>{money(v)}</b>, true]]} />
        </Card>
        <Card title="By employee" sub="Who recorded the collection" bodyClass="" actions={<ExportButton report="revenue" table="byEmployee" from={from} to={to} />}>
          <Table rows={d.byEmployee} cols={[['employee', 'Employee'], ['role', 'Role'], ['payments', 'Payments', number, true], ['collected', 'Collected', (v) => <b>{money(v)}</b>, true]]} />
        </Card>
      </div>
    </div>
  );
}

function Membership({ d, from, to }: { d: any; from: string; to: string }) {
  const c = d.counts;
  const line = (k: string, better: 'up' | 'down' = 'up') => <MetricLine points={d.trend.map((t: any) => ({ date: t.date, value: Number(t[k]) }))} format={(v) => String(Math.round(v))} better={better} height={150} />;
  return (
    <div className="stack">
      <div className="grid g-4">
        <Kpi hero label="Active now" value={number(c.active)} compare={`${c.expiring_soon} expiring soon · ${c.frozen} frozen`} />
        <Kpi label="New members" value={number(c.new)} compare="in this range" />
        <Kpi label="Renewals" value={number(c.renewals)} compare={c.renewalRate != null ? `${c.renewalRate}% of ${c.ended} memberships that ended renewed` : '—'} />
        <Kpi label="Cancelled · frozen" value={`${c.cancelled} · ${c.frozen}`} compare={`${c.plan_changes} plan changes · ${c.expired} currently expired`} />
      </div>
      <div className="grid g-4">
        <Card title="Active members" sub={`end of each ${d.bucket}`}>{line('active')}</Card>
        <Card title="New" sub={`per ${d.bucket}`}>{line('new')}</Card>
        <Card title="Renewals" sub={`per ${d.bucket}`}>{line('renewals')}</Card>
        <Card title="Lapsed" sub="ended without renewing" >{line('expired', 'down')}</Card>
      </div>
      <Card title="Plans sold" bodyClass="" actions={<ExportButton report="membership" table="byPlan" from={from} to={to} />}>
        <Table rows={d.byPlan} cols={[['plan', 'Plan'], ['sold', 'Sold', number, true], ['renewals', 'Of which renewals', number, true], ['value', 'Value', (v) => <b>{money(v)}</b>, true]]} />
      </Card>
    </div>
  );
}

function Sales({ d, from, to }: { d: any; from: string; to: string }) {
  const f = d.funnel;
  const steps = [['Leads', f.leads], ['Reached trial', f.trials], ['Won', f.won]] as const;
  return (
    <div className="stack">
      <div className="grid g-4">
        <Kpi hero label="Conversion" value={`${f.conversion}%`} compare={`${f.won} won of ${f.leads} leads · ${f.open} still open`} />
        <Kpi label="New leads" value={number(f.leads)} compare={`${f.lost} lost`} />
        <Kpi label="Time to first contact" value={f.avg_hours_to_contact != null ? `${f.avg_hours_to_contact} h` : '—'} compare="average" />
        <Kpi label="Time to close" value={f.avg_days_to_close != null ? `${f.avg_days_to_close} days` : '—'} compare="lead created → member" />
      </div>
      <div className="grid g-dash-1">
        <Card title="Funnel" sub="Leads created in this range">
          <div className="stack" style={{ gap: 12 }}>{steps.map(([l, n]) => (
            <div key={l} className="pnl-row" style={{ gridTemplateColumns: '120px minmax(0,1fr) 110px' }}>
              <span className="muted">{l}</span><div className="share-bar" style={{ height: 14 }}><i style={{ width: `${f.leads ? (n / f.leads) * 100 : 0}%` }} /></div>
              <span className="num" style={{ textAlign: 'right' }}><b>{number(n)}</b> <span className="faint">{f.leads ? Math.round((n / f.leads) * 100) : 0}%</span></span>
            </div>
          ))}</div>
        </Card>
        <div className="stack">
          <Card title="Leads" sub={`per ${d.bucket}`}><MetricLine points={d.trend.map((t: any) => ({ date: t.date, value: t.leads }))} format={(v) => String(Math.round(v))} better="up" height={120} /></Card>
          <Card title="Won" sub={`per ${d.bucket}`}><MetricLine points={d.trend.map((t: any) => ({ date: t.date, value: t.won }))} format={(v) => String(Math.round(v))} better="up" color="var(--series-2)" height={120} /></Card>
        </div>
      </div>
      <Card title="Lead sources" bodyClass="" actions={<ExportButton report="sales" table="bySource" from={from} to={to} />}>
        <Table rows={d.bySource} cols={[['source', 'Source'], ['leads', 'Leads', number, true], ['won', 'Won', number, true], ['conversion', 'Conversion', (v) => (v != null ? `${v}%` : '—'), true], ['revenue', 'Revenue from converts', (v) => <b>{money(v)}</b>, true]]} />
      </Card>
      <div className="grid g-2">
        <Card title="Salespeople" bodyClass="" actions={<ExportButton report="sales" table="bySalesperson" from={from} to={to} />}>
          <Table rows={d.bySalesperson} cols={[['salesperson', 'Name'], ['leads', 'Leads', number, true], ['won', 'Won', number, true], ['memberships_sold', 'Sold', number, true], ['sales_value', 'Sales value', (v) => <b>{money(v)}</b>, true]]} />
        </Card>
        <Card title="Follow-up performance" sub="Tasks due in this range" bodyClass="" actions={<ExportButton report="sales" table="followUps" from={from} to={to} />}>
          <Table rows={d.followUps} cols={[['staff', 'Staff'], ['due', 'Due', number, true], ['done', 'Done', number, true], ['on_time', 'On time', (v, r) => (r.due ? `${Math.round((v / r.due) * 100)}%` : '—'), true], ['overdue', 'Overdue', (v) => <span style={{ color: v ? 'var(--danger)' : undefined }}>{v}</span>, true]]} />
        </Card>
      </div>
    </div>
  );
}

function Attendance({ d, from, to }: { d: any; from: string; to: string }) {
  return (
    <div className="stack">
      <div className="grid g-4">
        <Kpi hero label="Visits" value={number(d.totals.visits)} compare={`${d.totals.perDay} a day`} />
        <Kpi label="Unique members" value={number(d.totals.unique_members)} compare="came at least once" />
        <Kpi label="Denied at the door" value={number(d.totals.denied)} compare={`${d.totals.overrides} manager overrides`} />
        <Kpi label="Inactive members" value={number(d.inactive.length)} compare="active plan, not visiting" />
      </div>
      <div className="grid g-dash-1">
        <Card title="Visits" sub={`per ${d.bucket}`}><MetricLine points={d.trend.map((t: any) => ({ date: t.date, value: t.visits }))} format={(v) => String(Math.round(v))} better="up" height={220} /></Card>
        <Card title="How often active members came" sub="visits per week in this range">
          <Bars data={d.distribution.map((x: any) => ({ key: x.bucket, value: x.members }))} height={220} highlightLast={false} label={(k) => k} valueLabel={(v) => `${v} members`} />
        </Card>
      </div>
      <Card title="Peak hours" sub="Average visits per weekday and hour"><Heatmap cells={d.heat.map((h: any) => ({ dow: h.dow, hour: h.hour, avg: Number(h.avg) }))} /></Card>
      <Card title="Class attendance" bodyClass="" actions={<ExportButton report="attendance" table="classes" from={from} to={to} />}>
        <Table rows={d.classes} cols={[['class', 'Class'], ['sessions', 'Sessions', number, true], ['booked', 'Booked', number, true], ['attended', 'Attended', number, true],
          ['fill_rate', 'Fill rate', (v) => (v != null ? `${v}%` : '—'), true], ['show_rate', 'Show-up', (v) => (v != null ? `${v}%` : '—'), true]]} />
      </Card>
      <Card title="Inactive members" sub="Active membership, no visit within the inactivity window" bodyClass="" actions={<ExportButton report="attendance" table="inactive" from={from} to={to} />}>
        <Table rows={d.inactive.slice(0, 25)} cols={[['member', 'Member'], ['branch', 'Branch'], ['plan', 'Plan'], ['last_visit', 'Last visit', (v) => (v ? date(v) : 'Never')], ['idle_days', 'Days idle', number, true], ['expires', 'Plan ends', (v) => date(v)]]} empty="Everyone’s showing up" />
      </Card>
    </div>
  );
}

function Financial({ d, from, to }: { d: any; from: string; to: string }) {
  const t = d.totals;
  const line = (k: string, color?: string, better: 'up' | 'down' = 'up') => <MetricLine points={d.trend.map((x: any) => ({ date: x.date, value: Number(x[k]) }))} format={moneyShort} color={color} better={better} height={150} />;
  return (
    <div className="stack">
      <div className="grid g-4">
        <Kpi hero label="Net revenue" value={money(t.netRevenue)} compare={`${money(t.revenue)} collected − ${money(t.refunds)} refunded`} />
        {t.expenses != null ? <Kpi label="Expenses" value={money(t.expenses)} compare={`Profit ${money(t.profit)}`} /> : <Kpi label="GST billed" value={money(t.gstBilled)} />}
        <Kpi label="Outstanding" value={<span style={{ color: t.outstanding ? 'var(--warning)' : undefined }}>{money(t.outstanding)}</span>} compare="unpaid invoices, all time" />
        <Kpi label="Refunds" value={money(t.refunds)} compare={`${d.refunds.length} in this range`} />
      </div>
      <div className={`grid ${t.expenses != null ? 'g-3' : 'g-2'}`}>
        <Card title="Net revenue" sub={`per ${d.bucket}`}>{line('revenue')}</Card>
        {t.expenses != null && <Card title="Expenses" sub={`per ${d.bucket}`}>{line('expenses', 'var(--series-3)', 'down')}</Card>}
        {t.expenses != null ? <Card title="Profit" sub={`per ${d.bucket}`}>{line('profit', 'var(--series-2)')}</Card> : <Card title="Refunds" sub={`per ${d.bucket}`}>{line('refunds', 'var(--series-3)', 'down')}</Card>}
      </div>
      <div className="grid g-dash-2">
        <Card title="Outstanding by age" sub="How long unpaid invoices have been due" bodyClass="" actions={<ExportButton report="financial" table="aging" from={from} to={to} />}>
          <Table rows={d.aging} cols={[['bucket', 'Overdue'], ['invoices', 'Invoices', number, true], ['amount', 'Amount', (v) => <b>{money(v)}</b>, true]]} empty="Nothing outstanding" />
        </Card>
        <Card title="Refunds" bodyClass="" actions={<ExportButton report="financial" table="refunds" from={from} to={to} />}>
          <Table rows={d.refunds.slice(0, 12)} cols={[['date', 'Date', (v) => date(v)], ['customer', 'Customer'], ['reason', 'Reason'], ['amount', 'Amount', (v) => <b>{money(v)}</b>, true]]} empty="No refunds" />
        </Card>
      </div>
    </div>
  );
}

export function ReportsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('report') as Report) ?? 'revenue';
  const [preset, setPreset] = useState('90d');
  const [custom, setCustom] = useState<[string, string]>(PRESETS[1].range());
  const [from, to] = preset === 'custom' ? custom : PRESETS.find((p) => p.key === preset)!.range();
  const { data, isFetching, error } = useQuery({ queryKey: ['report', tab, from, to], queryFn: () => api.get<any>(`/reports/${tab}`, { from, to }), placeholderData: (prev) => (prev && (prev as any).__tab === tab ? prev : undefined), select: (d) => ({ ...d, __tab: tab }) });
  const views: Record<Report, (p: any) => ReactNode> = { revenue: Revenue, membership: Membership, sales: Sales, attendance: Attendance, financial: Financial };
  const View = views[tab];
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Reports</h1><div className="sub">Revenue, membership, sales, attendance and finance — for the branches selected at the top. Every table exports to CSV.</div></div>
        <div className="actions row wrap" style={{ alignItems: 'center' }}>
          <Segmented value={preset} onChange={setPreset} options={[...PRESETS.map((p) => ({ value: p.key, label: p.label })), { value: 'custom', label: 'Custom' }]} />
          {preset === 'custom' && <>
            <input type="date" className="input" style={{ width: 150 }} value={custom[0]} max={custom[1]} onChange={(e) => setCustom([e.target.value, custom[1]])} aria-label="From" />
            <input type="date" className="input" style={{ width: 150 }} value={custom[1]} max={today()} onChange={(e) => setCustom([custom[0], e.target.value])} aria-label="To" />
          </>}
        </div>
      </div>
      <Tabs value={tab} onChange={(t) => setParams({ report: t })} tabs={[{ key: 'revenue', label: 'Revenue' }, { key: 'membership', label: 'Membership' }, { key: 'sales', label: 'Sales' }, { key: 'attendance', label: 'Attendance' }, { key: 'financial', label: 'Financial' }]} />
      <div className="faint" style={{ fontSize: 12.5, marginTop: -6 }}>{date(from)} – {date(to)}{isFetching ? ' · updating…' : ''}</div>
      {error ? <Card><Empty title="Couldn’t load this report">{(error as Error).message}</Empty></Card> : !data || data.__tab !== tab ? <Skeleton h={500} /> : <View d={data} from={from} to={to} />}
    </div>
  );
}
