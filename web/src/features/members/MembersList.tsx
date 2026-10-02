import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search, UserPlus, Users } from 'lucide-react';
import { api, type Paged } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced } from '../../lib/ui';
import { date, daysLabel, money, relative } from '../../lib/format';
import { Button, Empty, Pagination, Person, Skeleton, StatusBadge } from '../../components/ui';
import { useActions } from '../actions';

const FILTERS = [
  { key: '', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'expiring_soon', label: 'Expiring soon' },
  { key: 'expired', label: 'Expired' },
  { key: 'frozen', label: 'Frozen' },
  { key: 'pending', label: 'Payment pending' },
  { key: 'cancelled', label: 'Cancelled' },
];

export function MembersList() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const actions = useActions();
  const [search, setSearch] = useState(params.get('search') ?? '');
  const term = useDebounced(search.trim());
  const status = params.get('status') ?? '';
  const outstanding = params.get('outstanding') === 'true';
  const sort = params.get('sort') ?? 'joined';
  const page = Number(params.get('page') ?? 1);
  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const { data, isLoading } = useQuery({
    queryKey: ['members', term, status, outstanding, sort, page],
    queryFn: () => api.get<Paged<any>>('/members', { search: term, status, outstanding: outstanding || undefined, sort, page, pageSize: 25 }),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Members</h1><div className="sub">One profile per person — the same record the member app reads.</div></div>
        <div className="actions">{can('members.write') && <Button variant="primary" icon={<UserPlus />} onClick={actions.addMember}>Add member</Button>}</div>
      </div>
      <section className="card">
        <div className="toolbar">
          <div className="search-box">
            <Search />
            <input value={search} onChange={(e) => { setSearch(e.target.value); update({ search: e.target.value || null }); }} placeholder="Name, phone, email or member ID" />
          </div>
          <div className="chips">
            {FILTERS.map((f) => <button key={f.key} className={`chip ${status === f.key ? 'on' : ''}`} onClick={() => update({ status: f.key || null })}>{f.label}</button>)}
            <button className={`chip ${outstanding ? 'on' : ''}`} onClick={() => update({ outstanding: outstanding ? null : 'true' })}>Has dues</button>
          </div>
          <div style={{ flex: 1 }} />
          <select className="select" style={{ width: 170 }} value={sort} onChange={(e) => update({ sort: e.target.value })} aria-label="Sort">
            <option value="joined">Newest first</option><option value="name">Name A–Z</option><option value="expiry">Expiry soonest</option>
          </select>
        </div>
        <div className="table-wrap">
          {isLoading ? <div style={{ padding: 20 }}><Skeleton h={400} /></div> : !data?.data.length ? (
            <Empty icon={<Users size={20} />} title="No members match">Try a different search or filter.</Empty>
          ) : (
            <table className="tbl">
              <thead><tr><th>Member</th><th>Phone</th><th>Plan</th><th>Status</th><th>Expiry</th><th className="r">Dues</th><th className="r hide-sm">Lifetime value</th><th className="hide-sm">Last visit</th><th className="hide-sm">Branch</th><th className="hide-sm">Joined</th></tr></thead>
              <tbody>
                {data.data.map((m) => (
                  <tr key={m.id} className="clickable" onClick={() => navigate(`/members/${m.id}`)}>
                    <td><Person name={m.full_name} detail={m.member_code} /></td>
                    <td className="muted num">{m.phone}</td>
                    <td>{m.plan_name ?? <span className="faint">—</span>}</td>
                    <td><StatusBadge status={m.status} /></td>
                    <td>{m.end_date ? <><div>{date(m.end_date)}</div><div className="faint" style={{ fontSize: 12 }}>{daysLabel(m.days_remaining)}</div></> : '—'}</td>
                    <td className="r amount" style={{ color: m.outstanding > 0 ? 'var(--warning)' : 'var(--text-3)' }}>{m.outstanding > 0 ? money(m.outstanding) : '—'}</td>
                    <td className="r num hide-sm">{money(m.lifetime_value)}</td>
                    <td className="muted hide-sm" style={{ whiteSpace: 'nowrap' }}>{m.last_visit_at ? relative(m.last_visit_at) : 'Never'}</td>
                    <td className="muted hide-sm">{m.branch_name}</td>
                    <td className="muted hide-sm">{date(m.join_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {data && data.pagination.total > 0 && <Pagination {...data.pagination} onPage={(p) => update({ page: String(p) })} />}
      </section>
    </div>
  );
}
