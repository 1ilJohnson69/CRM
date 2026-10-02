import { Fragment, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, KeyRound, Pencil, Plus, Search, ShieldCheck, UserCog } from 'lucide-react';
import { api, ApiError, type Paged } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced, useToast } from '../../lib/ui';
import { date, dateTime, number, relative } from '../../lib/format';
import { Alert, Badge, Button, Card, Dialog, Empty, Field, Pagination, Person, Skeleton } from '../../components/ui';
import { CredentialsCard } from '../members/MemberForm';

// -------------------------------------------------------------- employees --

function EmployeeDialog({ employee, onClose }: { employee?: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const { data: roles } = useQuery({ queryKey: ['roles'], queryFn: () => api.get<any[]>('/admin/roles') });
  const [f, setF] = useState({
    fullName: employee?.full_name ?? '', email: employee?.email ?? '', phone: employee?.phone ?? '', roleId: employee?.role_id ?? '',
    branchIds: (employee?.branches ?? []).map((b: any) => b.id) as string[], designation: employee?.designation ?? '',
    joiningDate: employee?.joining_date ?? '', isActive: employee?.is_active ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [creds, setCreds] = useState<any>(null);
  const role = roles?.find((r) => r.id === f.roleId);
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, joiningDate: f.joiningDate || null, designation: f.designation || null };
      return employee ? api.put(`/admin/staff/${employee.id}`, body) : api.post<any>('/admin/staff', body);
    },
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ['staff'] });
      toast('success', employee ? 'Employee updated' : 'Employee added');
      if (r?.credentials) setCreds(r.credentials);
      else onClose();
    },
    onError: (e) => e instanceof ApiError && setErrors({ ...e.fieldErrors(), _: e.message }),
  });
  if (creds) return <Dialog open onClose={onClose} title="Employee added" footer={<Button variant="primary" onClick={onClose}>Done</Button>}><CredentialsCard login={creds.login} password={creds.temporaryPassword} /></Dialog>;
  return (
    <Dialog open variant="drawer" onClose={onClose} title={employee ? 'Edit employee' : 'Add employee'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => { setErrors({}); save.mutate(); }}>Save</Button></>}>
      <div className="form">
        {errors._ && <Alert>{errors._}</Alert>}
        <div className="form-grid">
          <Field label="Full name" error={errors.fullName} className="full"><input className="input" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
          <Field label="Work email" error={errors.email}><input className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Phone" error={errors.phone}><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label="Role" error={errors.roleId}><select className="select" value={f.roleId} onChange={(e) => setF({ ...f, roleId: e.target.value })}>
            <option value="">Select a role</option>{roles?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select></Field>
          <Field label="Designation"><input className="input" value={f.designation} onChange={(e) => setF({ ...f, designation: e.target.value })} /></Field>
          <Field label="Joining date"><input className="input" type="date" value={f.joiningDate} onChange={(e) => setF({ ...f, joiningDate: e.target.value })} /></Field>
        </div>
        {role && !role.all_branches && (
          <Field label="Branches" hint="This role only sees data for the branches assigned here">
            <div className="chips">{me?.branches.map((b) => (
              <button type="button" key={b.id} className={`chip ${f.branchIds.includes(b.id) ? 'on' : ''}`}
                onClick={() => setF({ ...f, branchIds: f.branchIds.includes(b.id) ? f.branchIds.filter((x) => x !== b.id) : [...f.branchIds, b.id] })}>{b.name}</button>
            ))}</div>
          </Field>
        )}
        {role?.all_branches && <Alert tone="info">{role.name} has access to all branches.</Alert>}
        {employee && <label className="check"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />Active (can sign in)</label>}
      </div>
    </Dialog>
  );
}

export function EmployeesPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const [reset, setReset] = useState<any>(null);
  const term = useDebounced(search.trim());
  const { data } = useQuery({ queryKey: ['staff', term, page], queryFn: () => api.get<Paged<any>>('/admin/staff', { search: term, page }), placeholderData: keepPreviousData });
  const resetPw = useMutation({
    mutationFn: (id: string) => api.post<any>(`/admin/staff/${id}/reset-password`),
    onSuccess: (r, id) => setReset({ ...r, login: data?.data.find((s) => s.id === id)?.email }),
    onError: (e) => toast('error', e instanceof ApiError ? e.message : 'Failed'),
  });
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Employees</h1><div className="sub">Staff accounts, roles and branch assignments.</div></div>
        <div className="actions">{can('staff.manage') && <Button variant="primary" icon={<Plus />} onClick={() => setEditing(null)}>Add employee</Button>}</div>
      </div>
      <section className="card">
        <div className="toolbar"><div className="search-box"><Search /><input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Name, email or phone" /></div></div>
        <div className="table-wrap">
          {!data ? <div style={{ padding: 20 }}><Skeleton h={300} /></div> : !data.data.length ? <Empty icon={<UserCog size={20} />} title="No employees" /> : (
            <table className="tbl">
              <thead><tr><th>Employee</th><th>Role</th><th>Branches</th><th className="hide-sm">Phone</th><th className="hide-sm">Joined</th><th>Last sign-in</th><th>Status</th>{can('staff.manage') && <th />}</tr></thead>
              <tbody>{data.data.map((s) => (
                <tr key={s.id}>
                  <td><Person name={s.full_name} detail={s.designation ?? s.email} /></td>
                  <td>{s.role_name}</td>
                  <td className="muted">{s.all_branches ? 'All branches' : s.branches.map((b: any) => b.name).join(', ')}</td>
                  <td className="muted num hide-sm">{s.phone}</td>
                  <td className="muted hide-sm">{date(s.joining_date)}</td>
                  <td className="muted">{s.last_login_at ? relative(s.last_login_at) : 'Never'}</td>
                  <td>{s.is_active ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}</td>
                  {can('staff.manage') && <td className="r"><div className="row" style={{ justifyContent: 'flex-end' }}>
                    <Button size="sm" variant="ghost" icon={<KeyRound />} onClick={() => resetPw.mutate(s.id)} title="Reset password" aria-label="Reset password" />
                    <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setEditing(s)} aria-label="Edit" />
                  </div></td>}
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
        {data && data.pagination.total > 0 && <Pagination {...data.pagination} onPage={setPage} />}
      </section>
      {editing !== undefined && <EmployeeDialog employee={editing ?? undefined} onClose={() => setEditing(undefined)} />}
      {reset && <Dialog open onClose={() => setReset(null)} title="Password reset" footer={<Button variant="primary" onClick={() => setReset(null)}>Done</Button>}><CredentialsCard login={reset.login} password={reset.temporaryPassword} /></Dialog>}
    </div>
  );
}

// --------------------------------------------------------------- branches --

function BranchDialog({ branch, onClose }: { branch?: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { refreshMe } = useAuth();
  const [f, setF] = useState({ name: branch?.name ?? '', code: branch?.code ?? '', address: branch?.address ?? '', phone: branch?.phone ?? '', email: branch?.email ?? '', isActive: branch?.is_active ?? true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => (branch ? api.put(`/admin/branches/${branch.id}`, f) : api.post('/admin/branches', f)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['branches'] }); refreshMe(); toast('success', 'Branch saved'); onClose(); },
    onError: (e) => e instanceof ApiError && setErrors({ ...e.fieldErrors(), _: e.message }),
  });
  return (
    <Dialog open onClose={onClose} title={branch ? `Edit ${branch.name}` : 'New branch'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="form">
        {errors._ && <Alert>{errors._}</Alert>}
        <div className="form-grid">
          <Field label="Name" error={errors.name}><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Code" error={errors.code} hint="Short code, e.g. IND"><input className="input" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="Address" className="full"><input className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
          <Field label="Phone"><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label="Email" error={errors.email}><input className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />Active</label>
      </div>
    </Dialog>
  );
}

export function BranchesPage() {
  const { can } = useAuth();
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const { data } = useQuery({ queryKey: ['branches'], queryFn: () => api.get<any[]>('/admin/branches') });
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Branches</h1><div className="sub">Every member, payment and membership belongs to a branch.</div></div>
        <div className="actions">{can('branches.manage') && <Button variant="primary" icon={<Plus />} onClick={() => setEditing(null)}>New branch</Button>}</div>
      </div>
      {!data ? <Skeleton h={200} /> : (
        <div className="grid g-3">
          {data.map((b) => (
            <Card key={b.id} title={b.name} icon={<Building2 />} sub={b.code} glow="soft" actions={can('branches.manage') && <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setEditing(b)} aria-label="Edit" />}>
              <div className="stack" style={{ gap: 12 }}>
                <div className="muted">{b.address ?? 'No address'}<br />{[b.phone, b.email].filter(Boolean).join(' · ')}</div>
                <div className="stat-strip">
                  <div><div className="k">Active</div><div className="v">{number(b.active_members)}</div></div>
                  <div><div className="k">Members</div><div className="v">{number(b.member_count)}</div></div>
                  <div><div className="k">Staff</div><div className="v">{number(b.staff_count)}</div></div>
                </div>
                {!b.is_active && <Badge>Inactive</Badge>}
              </div>
            </Card>
          ))}
        </div>
      )}
      {editing !== undefined && <BranchDialog branch={editing ?? undefined} onClose={() => setEditing(undefined)} />}
    </div>
  );
}

// ---------------------------------------------------------- roles matrix --

export function RolesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: roles } = useQuery({ queryKey: ['roles'], queryFn: () => api.get<any[]>('/admin/roles') });
  const { data: perms } = useQuery({ queryKey: ['permissions'], queryFn: () => api.get<any[]>('/admin/permissions') });
  const [draft, setDraft] = useState<Record<string, { permissions: string[]; allBranches: boolean }>>({});
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const save = useMutation({
    mutationFn: async () => {
      for (const [id, d] of Object.entries(draft)) {
        const r = roles!.find((x) => x.id === id);
        await api.put(`/admin/roles/${id}`, { name: r.name, description: r.description, allBranches: d.allBranches, permissions: d.permissions });
      }
    },
    onSuccess: () => { setDraft({}); qc.invalidateQueries({ queryKey: ['roles'] }); toast('success', 'Permissions saved'); },
    onError: (e) => toast('error', e instanceof ApiError ? e.message : 'Failed'),
  });
  const create = useMutation({
    mutationFn: () => api.post('/admin/roles', { name, permissions: ['dashboard.view', 'members.read'], allBranches: false }),
    onSuccess: () => { setCreating(false); setName(''); qc.invalidateQueries({ queryKey: ['roles'] }); toast('success', 'Role created'); },
    onError: (e) => toast('error', e instanceof ApiError ? e.message : 'Failed'),
  });
  if (!roles || !perms) return <div className="page"><Skeleton h={500} /></div>;
  const state = (r: any) => draft[r.id] ?? { permissions: r.permissions, allBranches: r.all_branches };
  const toggle = (r: any, key: string) => {
    const s = state(r);
    setDraft({ ...draft, [r.id]: { ...s, permissions: s.permissions.includes(key) ? s.permissions.filter((p: string) => p !== key) : [...s.permissions, key] } });
  };
  const modules = [...new Set(perms.map((p) => p.module))];
  const dirty = Object.keys(draft).length > 0;
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Roles & permissions</h1><div className="sub">Permissions are enforced by the API, not just hidden in the UI. Super Admin always has full access.</div></div>
        <div className="actions">
          <Button icon={<Plus />} onClick={() => setCreating(true)}>New role</Button>
          <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>Save changes</Button>
        </div>
      </div>
      <section className="card">
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th style={{ minWidth: 260 }}>Permission</th>{roles.map((r) => <th key={r.id} style={{ textAlign: 'center' }}>{r.name}<div className="faint" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 600 }}>{r.user_count} users</div></th>)}</tr></thead>
            <tbody>
              <tr><td style={{ fontWeight: 700 }}>Access to all branches</td>{roles.map((r) => (
                <td key={r.id} style={{ textAlign: 'center' }}><input type="checkbox" className="check" style={{ accentColor: 'var(--gold-2)', width: 16, height: 16 }} disabled={r.key === 'super_admin'} checked={state(r).allBranches} onChange={() => setDraft({ ...draft, [r.id]: { ...state(r), allBranches: !state(r).allBranches } })} /></td>
              ))}</tr>
              {modules.map((mod) => (
                <Fragment key={mod}>
                  <tr><td colSpan={roles.length + 1} className="section-label" style={{ paddingTop: 16 }}>{mod}</td></tr>
                  {perms.filter((p) => p.module === mod).map((p) => (
                    <tr key={p.key}>
                      <td><div style={{ fontWeight: 600 }}>{p.description}</div><div className="faint" style={{ fontSize: 11.5 }}>{p.key}</div></td>
                      {roles.map((r) => (
                        <td key={r.id} style={{ textAlign: 'center' }}>
                          <input type="checkbox" aria-label={`${r.name}: ${p.description}`} style={{ accentColor: 'var(--gold-2)', width: 16, height: 16 }} disabled={r.key === 'super_admin'} checked={state(r).permissions.includes(p.key)} onChange={() => toggle(r, p.key)} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {creating && (
        <Dialog open onClose={() => setCreating(false)} title="New role" footer={<><Button onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" disabled={name.length < 2} loading={create.isPending} onClick={() => create.mutate()}>Create</Button></>}>
          <Field label="Role name" hint="You can tick its permissions in the matrix afterwards"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Floor Supervisor" /></Field>
        </Dialog>
      )}
    </div>
  );
}

// --------------------------------------------------------------- settings --

export function SettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['org'], queryFn: () => api.get<any>('/admin/organization') });
  const [f, setF] = useState<any>(null);
  const v = f ?? (data && { name: data.name, legalName: data.legal_name ?? '', gstin: data.gstin ?? '', invoicePrefix: data.invoice_prefix, expiringSoonDays: data.expiring_soon_days, renewalReminderDays: data.renewal_reminder_days.join(', ') });
  const save = useMutation({
    mutationFn: () => api.put('/admin/organization', { ...v, renewalReminderDays: String(v.renewalReminderDays).split(',').map((s: string) => Number(s.trim())).filter((n: number) => !Number.isNaN(n)) }),
    onSuccess: () => { qc.invalidateQueries(); toast('success', 'Settings saved'); setF(null); },
    onError: (e) => toast('error', e instanceof ApiError ? e.message : 'Failed'),
  });
  if (!v) return <div className="page"><Skeleton h={300} /></div>;
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...v, [k]: e.target.value });
  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <div className="page-head"><div><h1>Settings</h1><div className="sub">Organization-wide configuration.</div></div>
        <div className="actions"><Button variant="primary" disabled={!f} loading={save.isPending} onClick={() => save.mutate()}>Save</Button></div></div>
      <Card title="Organization" icon={<Building2 />}>
        <div className="form-grid">
          <Field label="Gym name"><input className="input" value={v.name} onChange={set('name')} /></Field>
          <Field label="Legal name"><input className="input" value={v.legalName} onChange={set('legalName')} /></Field>
          <Field label="GSTIN"><input className="input" value={v.gstin} onChange={set('gstin')} /></Field>
          <Field label="Invoice prefix" hint="e.g. FRG → FRG-2026-00001"><input className="input" value={v.invoicePrefix} onChange={set('invoicePrefix')} /></Field>
        </div>
      </Card>
      <Card title="Renewals" icon={<ShieldCheck />}>
        <div className="form-grid">
          <Field label="“Expiring soon” window (days)"><input className="input num" type="number" value={v.expiringSoonDays} onChange={set('expiringSoonDays')} /></Field>
          <Field label="Reminder schedule (days before expiry)" hint="Members get an app notification on each of these days"><input className="input" value={v.renewalReminderDays} onChange={set('renewalReminderDays')} /></Field>
        </div>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------- audit logs --

export function AuditPage() {
  const [search, setSearch] = useState('');
  const [entity, setEntity] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const term = useDebounced(search.trim());
  const { data } = useQuery({ queryKey: ['audit', term, entity, page], queryFn: () => api.get<Paged<any>>('/admin/audit-logs', { search: term, entityType: entity, page, pageSize: 30 }), placeholderData: keepPreviousData });
  return (
    <div className="page">
      <div className="page-head"><div><h1>Audit logs</h1><div className="sub">Who changed what, and when. Payments and membership changes keep before/after values.</div></div></div>
      <section className="card">
        <div className="toolbar">
          <div className="search-box"><Search /><input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search actions" /></div>
          <div className="chips">
            {[['', 'All'], ['payment', 'Payments'], ['membership', 'Memberships'], ['member', 'Members'], ['invoice', 'Invoices'], ['user', 'Staff'], ['role', 'Roles']].map(([k, l]) => (
              <button key={k} className={`chip ${entity === k ? 'on' : ''}`} onClick={() => { setEntity(k); setPage(1); }}>{l}</button>
            ))}
          </div>
        </div>
        <div className="table-wrap">
          {!data ? <div style={{ padding: 20 }}><Skeleton h={400} /></div> : !data.data.length ? <Empty title="No entries" /> : (
            <table className="tbl">
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Summary</th><th className="hide-sm">Branch</th></tr></thead>
              <tbody>{data.data.map((a) => (
                <Fragment key={a.id}>
                  <tr className={a.before || a.after ? 'clickable' : ''} onClick={() => setOpen(open === a.id ? null : a.id)}>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>{dateTime(a.created_at)}</td>
                    <td>{a.actor ?? 'System'}</td>
                    <td><code className="faint" style={{ fontSize: 12 }}>{a.action}</code></td>
                    <td>{a.summary}</td>
                    <td className="muted hide-sm">{a.branch_name ?? '—'}</td>
                  </tr>
                  {open === a.id && (a.before || a.after) && (
                    <tr><td colSpan={5} style={{ background: 'var(--surface-2)' }}>
                      <div className="grid g-2">
                        <div><div className="section-label">Before</div><pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>{JSON.stringify(a.before, null, 2) ?? '—'}</pre></div>
                        <div><div className="section-label">After</div><pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>{JSON.stringify(a.after, null, 2) ?? '—'}</pre></div>
                      </div>
                    </td></tr>
                  )}
                </Fragment>
              ))}</tbody>
            </table>
          )}
        </div>
        {data && data.pagination.total > 0 && <Pagination {...data.pagination} onPage={setPage} />}
      </section>
    </div>
  );
}
