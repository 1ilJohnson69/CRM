import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DoorOpen, LogIn, LogOut, Search } from 'lucide-react';
import { api, ApiError, type Paged } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/ui';
import { number } from '../../lib/format';
import { Button, Card, Empty, Pagination, Segmented, Skeleton, Tabs } from '../../components/ui';
import { Bars, Heatmap } from '../../components/charts';
import { timeLabel, ymd } from './common';

export const METHOD_LABEL: Record<string, string> = { front_desk: 'Front desk', qr: 'QR', member_id: 'Member ID', app: 'App', access_control: 'Gate' };
const hourLabel = (h: number | null) => (h === null ? '—' : `${h === 12 ? 12 : h % 12} ${h < 12 ? 'am' : 'pm'}`);

export function AttendanceAnalytics({ compact }: { compact?: boolean }) {
  const [days, setDays] = useState(30);
  const { data } = useQuery({ queryKey: ['attendance-analytics', days], queryFn: () => api.get<any>('/attendance/analytics', { days }) });
  return (
    <Card title="Attendance analytics" icon={<DoorOpen />} sub="Check-ins by day and the gym’s busiest hours"
      actions={<Segmented value={days} onChange={setDays} options={[{ value: 7, label: 'Week' }, { value: 30, label: 'Month' }, { value: 90, label: '90D' }]} />}>
      {!data ? <Skeleton h={compact ? 280 : 380} /> : (
        <div className="stack">
          <div className="stat-strip" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
            <div><div className="k">Avg / day</div><div className="v">{number(data.averageDaily)}</div></div>
            <div><div className="k">Peak hour</div><div className="v">{hourLabel(data.peakHour)}</div></div>
            <div><div className="k">Total</div><div className="v">{number(data.total)}</div></div>
            <div title={`Active members with no visit in ${data.inactiveAfterDays} days`}>
              <div className="k">Inactive {data.inactiveAfterDays}d+</div>
              <div className="v" style={{ color: data.inactive ? 'var(--warning)' : undefined }}><Link to="/follow-ups">{data.inactive}</Link><span className="faint" style={{ fontSize: 12, fontWeight: 600 }}> / {data.active}</span></div>
            </div>
          </div>
          <Bars data={data.daily.map((d: any) => ({ key: d.date, value: d.visits }))} height={compact ? 150 : 190}
            label={(k, i) => new Date(`${k}T00:00:00`).toLocaleDateString('en-IN', i === -1 ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short' })}
            valueLabel={(v) => `${v} check-ins`} />
          <div className="section-label" style={{ marginTop: 0 }}>Average check-ins by hour</div>
          <Heatmap cells={data.heatmap} />
        </div>
      )}
    </Card>
  );
}

function Live() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const { data } = useQuery({ queryKey: ['attendance-live'], queryFn: () => api.get<any>('/attendance/live'), refetchInterval: 15_000 });
  const out = useMutation({
    mutationFn: (id: string) => api.post(`/attendance/${id}/check-out`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['attendance-live'] }),
    onError: (e) => toast('error', e instanceof ApiError ? e.message : 'Failed'),
  });
  return (
    <div className="stack">
      <div className="grid g-4">
        <section className="card kpi hero"><div className="label">In the gym now</div><div className="value">{data?.inside ?? '—'}</div><div className="compare">checked in within 2 hours</div></section>
        <section className="card kpi"><div className="label">Check-ins today</div><div className="value">{data?.today ?? '—'}</div><div className="compare">{data ? `${data.same_time_last_week} by this time last week` : ''}</div></section>
        <section className="card kpi"><div className="label">Unique members</div><div className="value">{data?.unique_today ?? '—'}</div><div className="compare">today</div></section>
        <section className="card kpi"><div className="label">Denied at entry</div><div className="value" style={{ color: data?.denied_today ? 'var(--danger)' : undefined }}>{data?.denied_today ?? '—'}</div><div className="compare">today</div></section>
      </div>
      <Card title="Today’s check-ins" icon={<LogIn />} bodyClass="" sub="Refreshes every 15 seconds">
        <div className="table-wrap" style={{ marginTop: 6 }}>
          {!data ? <div style={{ padding: 20 }}><Skeleton h={200} /></div> : !data.recent.length ? <Empty title="No check-ins yet today" /> : (
            <table className="tbl">
              <thead><tr><th>Time</th><th>Member</th><th>Plan</th><th>Method</th><th>Result</th><th>Out</th></tr></thead>
              <tbody>{data.recent.map((a: any) => (
                <tr key={a.id}>
                  <td className="num" style={{ fontWeight: 700 }}>{timeLabel(a.checked_in_at)}</td>
                  <td><Link to={`/members/${a.member_id}`} style={{ fontWeight: 700 }}>{a.full_name}</Link><div className="faint" style={{ fontSize: 12 }}>{a.member_code}</div></td>
                  <td className="muted">{a.plan_name ?? '—'}</td>
                  <td className="muted">{METHOD_LABEL[a.method]}</td>
                  <td>{a.status === 'allowed' ? <span className="badge success">Allowed</span> : a.status === 'override' ? <span className="badge warning" title={a.reason}>Override</span> : <span className="badge danger" title={a.reason}>Denied · {a.reason}</span>}</td>
                  <td>{a.status === 'denied' ? '—' : a.checked_out_at ? <span className="muted num">{timeLabel(a.checked_out_at)}</span> : can('attendance.checkin') ? <Button size="sm" variant="ghost" icon={<LogOut />} onClick={() => out.mutate(a.id)}>Out</Button> : <span className="faint">Inside</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  );
}

function Log() {
  const [day, setDay] = useState(ymd(new Date()));
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const { data } = useQuery({ queryKey: ['attendance', day, status, page], queryFn: () => api.get<Paged<any>>('/attendance', { date: day, status: status || undefined, page, pageSize: 40 }), placeholderData: keepPreviousData });
  return (
    <section className="card">
      <div className="toolbar">
        <input className="input" type="date" style={{ width: 170 }} value={day} onChange={(e) => { setDay(e.target.value); setPage(1); }} aria-label="Date" />
        <div className="chips">{[['', 'All'], ['allowed', 'Allowed'], ['override', 'Overrides'], ['denied', 'Denied']].map(([k, l]) => <button key={k} className={`chip ${status === k ? 'on' : ''}`} onClick={() => { setStatus(k); setPage(1); }}>{l}</button>)}</div>
      </div>
      <div className="table-wrap">
        {!data ? <div style={{ padding: 20 }}><Skeleton h={300} /></div> : !data.data.length ? <Empty icon={<Search size={20} />} title="No check-ins on this day" /> : (
          <table className="tbl">
            <thead><tr><th>In</th><th>Out</th><th>Member</th><th>Method</th><th>Result</th><th className="hide-sm">Branch</th><th className="hide-sm">Recorded by</th></tr></thead>
            <tbody>{data.data.map((a) => (
              <tr key={a.id}>
                <td className="num" style={{ fontWeight: 700 }}>{timeLabel(a.checked_in_at)}</td>
                <td className="num muted">{a.checked_out_at ? timeLabel(a.checked_out_at) : '—'}</td>
                <td><Link to={`/members/${a.member_id}`} style={{ fontWeight: 700 }}>{a.member_name}</Link> <span className="faint">{a.member_code}</span></td>
                <td className="muted">{METHOD_LABEL[a.method]}</td>
                <td>{a.status === 'allowed' ? <span className="badge success">Allowed</span> : <span className={`badge ${a.status === 'override' ? 'warning' : 'danger'}`}>{a.status === 'override' ? 'Override' : 'Denied'}</span>}{a.reason && <span className="faint" style={{ fontSize: 12 }}> {a.reason}</span>}</td>
                <td className="muted hide-sm">{a.branch_name}</td>
                <td className="muted hide-sm">{a.recorded_by_name ?? '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {data && data.pagination.total > 40 && <Pagination {...data.pagination} onPage={setPage} />}
    </section>
  );
}

export function StaffClock() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can, me } = useAuth();
  const [day, setDay] = useState(ymd(new Date()));
  const { data } = useQuery({ queryKey: ['staff-attendance', day], queryFn: () => api.get<any[]>('/attendance/staff', { date: day }) });
  const clock = useMutation({
    mutationFn: (v: { userId: string; action: 'in' | 'out' }) => api.post('/attendance/staff/clock', v),
    onSuccess: (_r, v) => { qc.invalidateQueries({ queryKey: ['staff-attendance'] }); toast('success', v.action === 'in' ? 'Clocked in' : 'Clocked out'); },
    onError: (e) => toast('error', e instanceof ApiError ? e.message : 'Failed'),
  });
  const isToday = day === ymd(new Date());
  // One row per staff member per day: the latest shift wins.
  const rows = Object.values((data ?? []).reduce((acc: Record<string, any>, r) => { acc[r.user_id] = acc[r.user_id] && !r.clock_in ? acc[r.user_id] : r; return acc; }, {}));
  return (
    <section className="card">
      <div className="toolbar">
        <input className="input" type="date" style={{ width: 170 }} value={day} onChange={(e) => setDay(e.target.value)} aria-label="Date" />
        <span className="muted">{rows.filter((r: any) => r.clock_in && !r.clock_out).length} on shift now</span>
      </div>
      <div className="table-wrap">
        {!data ? <div style={{ padding: 20 }}><Skeleton h={240} /></div> : (
          <table className="tbl">
            <thead><tr><th>Employee</th><th>Role</th><th>In</th><th>Out</th><th className="r">Hours</th>{isToday && <th />}</tr></thead>
            <tbody>{rows.map((r: any) => (
              <tr key={r.user_id}>
                <td style={{ fontWeight: 700 }}>{r.full_name}</td><td className="muted">{r.role_name}</td>
                <td className="num">{r.clock_in ? timeLabel(r.clock_in) : <span className="faint">—</span>}</td>
                <td className="num">{r.clock_out ? timeLabel(r.clock_out) : r.clock_in ? <span className="badge success">On shift</span> : <span className="faint">—</span>}</td>
                <td className="r num">{r.clock_in ? Number(r.hours).toFixed(1) : '—'}</td>
                {isToday && <td className="r">{(can('staff.attendance') || r.user_id === me?.id) && (
                  r.clock_in && !r.clock_out
                    ? <Button size="sm" icon={<LogOut />} onClick={() => clock.mutate({ userId: r.user_id, action: 'out' })}>Clock out</Button>
                    : !r.clock_in && <Button size="sm" icon={<LogIn />} onClick={() => clock.mutate({ userId: r.user_id, action: 'in' })}>Clock in</Button>
                )}</td>}
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </section>
  );
}

export function AttendancePage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as 'live' | 'log' | 'analytics' | 'staff') ?? 'live';
  return (
    <div className="page">
      <div className="page-head"><div><h1>Attendance</h1><div className="sub">Every entry — desk, QR or app — including denied attempts.</div></div>
        <div className="actions"><Link className="btn primary" to="/front-desk"><DoorOpen />Open front desk</Link></div></div>
      <Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[{ key: 'live', label: 'Today' }, { key: 'log', label: 'Log' }, { key: 'analytics', label: 'Analytics' }, { key: 'staff', label: 'Staff' }]} />
      {tab === 'live' && <Live />}
      {tab === 'log' && <Log />}
      {tab === 'analytics' && <AttendanceAnalytics />}
      {tab === 'staff' && <StaffClock />}
    </div>
  );
}

