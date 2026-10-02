import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Bell, Building2, ChevronDown, CreditCard, KeyRound, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw,
  Search, Sun, UserPlus, Users, Receipt, UserCog, AlertTriangle, CheckCheck,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced, useTheme } from '../../lib/ui';
import { relative } from '../../lib/format';
import { Avatar, Popover, StatusBadge } from '../ui';
import { NAV } from './nav';
import { Actions, useActions } from '../../features/actions';

export function Logo() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="logo-gold" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#A67D4C" /><stop offset=".5" stopColor="#CFA56D" /><stop offset="1" stopColor="#ECD19E" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="#0C0708" stroke="rgba(236,209,158,.18)" />
      <path d="M9 7h14l-2.4 4.2H13.6v3.3h6.2L17.6 18.3h-4V25H9z" fill="url(#logo-gold)" />
    </svg>
  );
}

function Sidebar() {
  const { can } = useAuth();
  return (
    <aside className="sidebar">
      <div className="brand">
        <Logo />
        <div className="brand-name"><span className="gold-text">FORGE</span><small>Gym OS</small></div>
      </div>
      <nav className="nav" aria-label="Main">
        {NAV.map((g) => {
          const items = g.items.filter((i) => i.phase || !i.perm || can(i.perm));
          if (!items.length) return null;
          return (
            <div className="nav-group" key={g.group ?? 'root'}>
              {g.group && <div className="nav-group-label">{g.group}</div>}
              {items.map((i) =>
                i.phase ? (
                  <NavLink key={i.to} to={i.to} className={({ isActive }) => clsx('nav-item disabled', isActive && 'active')} title={`${i.label} — planned for phase ${i.phase}`}>
                    <i.icon /><span>{i.label}</span><em className="soon">P{i.phase}</em>
                  </NavLink>
                ) : (
                  <NavLink key={i.to} to={i.to} end={i.to === '/'} className={({ isActive }) => clsx('nav-item', isActive && 'active')} title={i.label}>
                    <i.icon /><span>{i.label}</span>
                  </NavLink>
                ),
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

type SearchResult = { members: any[]; invoices: any[]; payments: any[]; staff: any[] };

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const term = useDebounced(q.trim(), 200);
  const { data } = useQuery({ queryKey: ['search', term], queryFn: () => api.get<SearchResult>('/search', { q: term }), enabled: term.length >= 2 });

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const flat = [
    ...(data?.members ?? []).map((r) => ({ ...r, group: 'Members', to: `/members/${r.id}`, icon: <Users size={15} /> })),
    ...(data?.invoices ?? []).map((r) => ({ ...r, group: 'Invoices', to: `/invoices/${r.id}`, icon: <Receipt size={15} /> })),
    ...(data?.payments ?? []).map((r) => ({ ...r, group: 'Payments', to: `/invoices/${r.invoice_id}`, icon: <CreditCard size={15} /> })),
    ...(data?.staff ?? []).map((r) => ({ ...r, group: 'Employees', to: `/admin/employees?focus=${r.id}`, icon: <UserCog size={15} /> })),
  ];
  const go = (to: string) => {
    navigate(to);
    setOpen(false);
    setQ('');
    input.current?.blur();
  };

  return (
    <div className="search-box">
      <Search />
      <input
        ref={input} value={q} placeholder="Search members, phone, invoice, UPI ref…" aria-label="Global search"
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(flat.length - 1, a + 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          if (e.key === 'Enter' && flat[active]) go(flat[active].to);
          if (e.key === 'Escape') input.current?.blur();
        }}
      />
      <kbd>⌘K</kbd>
      {open && term.length >= 2 && data && (
        <div className="search-results">
          {flat.length === 0 && <div className="empty" style={{ padding: 20 }}>No matches for “{term}”</div>}
          {flat.map((r, i) => (
            <div key={r.group + r.id}>
              {(i === 0 || flat[i - 1].group !== r.group) && <div className="search-group">{r.group}</div>}
              <button className={clsx('search-item', i === active && 'active')} onMouseDown={() => go(r.to)} onMouseEnter={() => setActive(i)}>
                <span className="faint">{r.icon}</span>
                <span style={{ flex: 1, minWidth: 0 }}><div className="t">{r.title}</div><div className="s">{r.subtitle}</div></span>
                {r.status && r.group === 'Members' && <StatusBadge status={r.status} />}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ data: any[]; unread: number }>('/notifications'),
    refetchInterval: 60_000,
  });
  const markAll = async () => {
    await api.post('/notifications/read');
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  return (
    <Popover
      width={400}
      trigger={(_, toggle) => (
        <button className="icon-btn" onClick={toggle} aria-label={`Notifications${data?.unread ? `, ${data.unread} unread` : ''}`}>
          <Bell />
          {!!data?.unread && <span className="dot">{data.unread > 9 ? '9+' : data.unread}</span>}
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="row between" style={{ padding: '6px 8px 8px' }}>
            <b>Notifications</b>
            <button className="btn ghost sm" onClick={markAll}><CheckCheck />Mark all read</button>
          </div>
          <div className="notif-list">
            {!data?.data.length && <div className="empty">You're all caught up.</div>}
            {data?.data.map((n) => (
              <div
                key={n.id} className={clsx('notif', n.priority === 'high' && 'high', !n.read_at && 'unread')} role="button" tabIndex={0}
                onClick={() => { close(); if (n.type === 'renewals.digest') navigate('/?focus=renewals'); }}
              >
                <div className="ic">{n.priority === 'high' ? <AlertTriangle /> : <RefreshCw />}</div>
                <div>
                  <div className="title">{n.title}</div>
                  {n.body && <div className="body">{n.body}</div>}
                  <div className="time">{relative(n.created_at)}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Popover>
  );
}

function QuickAdd() {
  const actions = useActions();
  const { can } = useAuth();
  return (
    <Popover
      trigger={(_, toggle) => <button className="btn primary" onClick={toggle}><Plus /><span className="hide-sm">New</span><ChevronDown /></button>}
    >
      {(close) => (
        <>
          {can('members.write') && <button className="menu-item" onClick={() => { close(); actions.addMember(); }}><UserPlus />Add member</button>}
          {can('payments.create') && <button className="menu-item" onClick={() => { close(); actions.recordPayment(); }}><CreditCard />Record payment</button>}
          {can('memberships.manage') && <button className="menu-item" onClick={() => { close(); actions.sellMembership(); }}><RefreshCw />Renew / sell membership</button>}
        </>
      )}
    </Popover>
  );
}

function Topbar({ onMenu, collapsed, onCollapse }: { onMenu: () => void; collapsed: boolean; onCollapse: () => void }) {
  const { me, logout, branch, setBranch } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  if (!me) return null;
  return (
    <header className="topbar">
      <button className="icon-btn show-md" onClick={onMenu} aria-label="Open menu"><Menu /></button>
      <button className="icon-btn hide-md" onClick={onCollapse} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
        {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
      </button>
      <GlobalSearch />
      <div className="spacer" />
      {me.branches.length > 1 && (
        <label className="select-pill hide-sm" title="Branch">
          <Building2 />
          <select value={branch} onChange={(e) => setBranch(e.target.value)} aria-label="Branch">
            {(me.all_branches || me.branches.length > 1) && <option value="all">All branches</option>}
            {me.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <ChevronDown className="chev" />
        </label>
      )}
      <QuickAdd />
      <Notifications />
      <button className="icon-btn" onClick={toggle} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>{theme === 'dark' ? <Sun /> : <Moon />}</button>
      <Popover
        trigger={(_, t) => (
          <button className="profile-btn" onClick={t}>
            <Avatar name={me.full_name} gold />
            <span className="who"><b>{me.full_name}</b><small>{me.role_name}</small></span>
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="menu-label">{me.organization.name}</div>
            <button className="menu-item" onClick={() => { close(); navigate('/account'); }}><KeyRound />Change password</button>
            <div className="menu-sep" />
            <button className="menu-item" onClick={() => { close(); logout(); }}><LogOut />Sign out</button>
          </>
        )}
      </Popover>
    </header>
  );
}

export function Shell() {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('forge.sidebar') === 'collapsed'; } catch { return false; }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMobileOpen(false), [location.pathname]);
  const toggleCollapse = () => setCollapsed((c) => {
    try { localStorage.setItem('forge.sidebar', c ? 'open' : 'collapsed'); } catch { /* ignore */ }
    return !c;
  });
  return (
    <Actions>
      <div className={clsx('shell', collapsed && 'collapsed', mobileOpen && 'mobile-open')}>
        <Sidebar />
        {mobileOpen && <div className="overlay" style={{ zIndex: 25 }} onClick={() => setMobileOpen(false)} />}
        <div className="main">
          <Topbar onMenu={() => setMobileOpen(true)} collapsed={collapsed} onCollapse={toggleCollapse} />
          <Outlet />
        </div>
      </div>
    </Actions>
  );
}
