import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Smartphone } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/ui';
import { money } from '../../lib/format';
import { Alert, Button, Dialog, Field } from '../../components/ui';
import { MethodPicker, referenceLabel, referenceRequired } from '../shared';

export function CredentialsCard({ login, password }: { login: string; password: string }) {
  const toast = useToast();
  const copy = () => {
    navigator.clipboard?.writeText(`Login: ${login}\nTemporary password: ${password}`).then(() => toast('success', 'Copied to clipboard'));
  };
  return (
    <div className="credential-box stack" style={{ gap: 10 }}>
      <div className="row"><Smartphone size={16} className="faint" /><b>Member app credentials</b></div>
      <div className="kv" style={{ gridTemplateColumns: '130px 1fr' }}>
        <dt>Login</dt><dd>{login}</dd>
        <dt>Temporary password</dt><dd className="pw gold-text">{password}</dd>
      </div>
      <div className="faint" style={{ fontSize: 12.5 }}>Shown only once. The member will be asked to set a new password on first sign-in.</div>
      <div><Button size="sm" icon={<Copy />} onClick={copy}>Copy</Button></div>
    </div>
  );
}

const blank = {
  fullName: '', phone: '', email: '', dateOfBirth: '', gender: '', address: '', emergencyContactName: '', emergencyContactPhone: '',
  source: 'Walk-in', notes: '', branchId: '', assignedStaffId: '',
};

export function MemberFormDialog({ edit, onClose }: { edit?: any; onClose: () => void }) {
  const { me, can, branch } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [f, setF] = useState(() =>
    edit
      ? {
          ...blank, fullName: edit.full_name, phone: edit.phone ?? '', email: edit.email ?? '', dateOfBirth: edit.date_of_birth ?? '', gender: edit.gender ?? '',
          address: edit.address ?? '', emergencyContactName: edit.emergency_contact_name ?? '', emergencyContactPhone: edit.emergency_contact_phone ?? '',
          source: edit.source ?? '', notes: edit.notes ?? '', branchId: edit.branch_id, assignedStaffId: edit.assigned_staff_id ?? '',
        }
      : { ...blank, branchId: branch !== 'all' ? branch : me?.branches[0]?.id ?? '' },
  );
  const [issueApp, setIssueApp] = useState(true);
  const [sell, setSell] = useState(!edit && can('memberships.manage'));
  const [planId, setPlanId] = useState('');
  const [discount, setDiscount] = useState(0);
  const [collect, setCollect] = useState(can('payments.create'));
  const [amount, setAmount] = useState<number | ''>('');
  const [method, setMethod] = useState('upi');
  const [reference, setReference] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ id: string; credentials: { login: string; temporaryPassword: string } | null } | null>(null);

  const { data: plans } = useQuery({ queryKey: ['plans'], queryFn: () => api.get<any[]>('/plans'), enabled: sell });
  const { data: staff } = useQuery({ queryKey: ['staff-min'], queryFn: () => api.get<any>('/admin/staff', { pageSize: 100 }), enabled: can('staff.read') });
  const activePlans = (plans ?? []).filter((p) => p.status === 'active');
  const plan = activePlans.find((p) => p.id === planId);
  const total = plan ? Math.round((plan.price - discount) * (1 + plan.tax_rate / 100) * 100) / 100 : 0;
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: async () => {
      const profile = {
        fullName: f.fullName, phone: f.phone, email: f.email || null, dateOfBirth: f.dateOfBirth || null, gender: f.gender || null,
        address: f.address || null, emergencyContactName: f.emergencyContactName || null, emergencyContactPhone: f.emergencyContactPhone || null,
        source: f.source || null, notes: f.notes || null, assignedStaffId: f.assignedStaffId || null,
      };
      if (edit) return api.patch<any>(`/members/${edit.id}`, { ...profile, branchId: f.branchId });
      return api.post<any>('/members', {
        ...profile, branchId: f.branchId, issueAppAccess: issueApp,
        membership: sell && plan ? {
          planId, discount,
          payment: collect && Number(amount || total) > 0 ? { amount: Number(amount || total), method, reference: reference || null } : null,
        } : null,
      });
    },
    onSuccess: (res) => {
      qc.invalidateQueries();
      if (edit) {
        toast('success', 'Member updated');
        onClose();
      } else {
        toast('success', `${f.fullName} registered as ${res.member.member_code}`);
        setDone({ id: res.member.id, credentials: res.credentials });
      }
    },
    onError: (e) => {
      if (e instanceof ApiError) setErrors({ ...e.fieldErrors(), _: e.message });
    },
  });

  if (done) {
    return (
      <Dialog open onClose={onClose} title="Member registered" sub={`${f.fullName} is set up.`}
        footer={<><Button onClick={onClose}>Close</Button><Button variant="primary" onClick={() => { onClose(); navigate(`/members/${done.id}`); }}>Open profile</Button></>}>
        {done.credentials ? <CredentialsCard login={done.credentials.login} password={done.credentials.temporaryPassword} /> : <Alert tone="info">No app access was issued. You can issue credentials from the profile later.</Alert>}
      </Dialog>
    );
  }

  return (
    <Dialog open variant="drawer" onClose={onClose} title={edit ? 'Edit member' : 'Add member'} sub={edit ? edit.member_code : 'Register a new member and optionally sell a plan.'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => { setErrors({}); save.mutate(); }}>{edit ? 'Save changes' : 'Register member'}</Button></>}>
      <div className="form">
        {errors._ && <Alert>{errors._}</Alert>}
        <div className="section-label">Profile</div>
        <div className="form-grid">
          <Field label="Full name" error={errors.fullName} className="full"><input className="input" value={f.fullName} onChange={set('fullName')} autoFocus /></Field>
          <Field label="Phone" error={errors.phone}><input className="input" value={f.phone} onChange={set('phone')} placeholder="+91 98450 00000" inputMode="tel" /></Field>
          <Field label="Email" error={errors.email}><input className="input" value={f.email} onChange={set('email')} type="email" /></Field>
          <Field label="Date of birth"><input className="input" type="date" value={f.dateOfBirth} onChange={set('dateOfBirth')} /></Field>
          <Field label="Gender">
            <select className="select" value={f.gender} onChange={set('gender')}>
              <option value="">—</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option>
            </select>
          </Field>
          <Field label="Branch">
            <select className="select" value={f.branchId} onChange={set('branchId')}>
              {me?.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="Assigned staff">
            <select className="select" value={f.assignedStaffId} onChange={set('assignedStaffId')}>
              <option value="">Unassigned</option>
              {staff?.data.filter((s: any) => s.is_active).map((s: any) => <option key={s.id} value={s.id}>{s.full_name} · {s.role_name}</option>)}
            </select>
          </Field>
          <Field label="Address" className="full"><input className="input" value={f.address} onChange={set('address')} /></Field>
          <Field label="Emergency contact"><input className="input" value={f.emergencyContactName} onChange={set('emergencyContactName')} placeholder="Name" /></Field>
          <Field label="Emergency phone"><input className="input" value={f.emergencyContactPhone} onChange={set('emergencyContactPhone')} inputMode="tel" /></Field>
          <Field label="How did they hear about us?">
            <select className="select" value={f.source} onChange={set('source')}>
              {['Walk-in', 'Instagram', 'Referral', 'Website', 'Google', 'Corporate tie-up', 'Other'].map((s) => <option key={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Notes" className="full"><textarea className="textarea" value={f.notes} onChange={set('notes')} /></Field>
        </div>

        {!edit && (
          <>
            <label className="check"><input type="checkbox" checked={issueApp} onChange={(e) => setIssueApp(e.target.checked)} /><KeyRound size={15} className="faint" />Issue member app login</label>
            {can('memberships.manage') && (
              <label className="check"><input type="checkbox" checked={sell} onChange={(e) => setSell(e.target.checked)} />Sell a membership now</label>
            )}
            {sell && (
              <>
                <div className="section-label">Membership</div>
                <div className="plan-options">
                  {activePlans.map((p) => (
                    <button type="button" key={p.id} className={`plan-option ${planId === p.id ? 'on' : ''}`} onClick={() => { setPlanId(p.id); setDiscount(0); setAmount(''); }}>
                      <div className="pn">{p.name}</div>
                      <div className="pp">{money(p.price)}</div>
                      <div className="pd">{p.duration_value} {p.duration_unit}{p.duration_value > 1 ? 's' : ''} · +{p.tax_rate}% GST</div>
                    </button>
                  ))}
                </div>
                {plan && (
                  <>
                    <Field label="Discount" hint={`Up to ${plan.max_discount_pct}% without manager approval`}>
                      <div className="input-prefix"><span>₹</span><input className="input num" type="number" min={0} value={discount} onChange={(e) => setDiscount(Number(e.target.value))} /></div>
                    </Field>
                    <div className="summary-box">
                      <div className="line"><span>{plan.name}</span><span>{money(plan.price, true)}</span></div>
                      {!!discount && <div className="line"><span>Discount</span><span>− {money(discount, true)}</span></div>}
                      <div className="line"><span>GST {plan.tax_rate}%</span><span>{money(((plan.price - discount) * plan.tax_rate) / 100, true)}</span></div>
                      <div className="line total"><span>Total</span><span>{money(total, true)}</span></div>
                    </div>
                    {can('payments.create') && (
                      <label className="check"><input type="checkbox" checked={collect} onChange={(e) => setCollect(e.target.checked)} />Collect payment now</label>
                    )}
                    {collect && (
                      <>
                        <MethodPicker value={method} onChange={setMethod} />
                        <div className="form-grid">
                          <Field label="Amount received" hint="Leave as total for full payment">
                            <div className="input-prefix"><span>₹</span><input className="input num" type="number" value={amount} placeholder={String(total)} onChange={(e) => setAmount(e.target.value === '' ? '' : Number(e.target.value))} /></div>
                          </Field>
                          <Field label={referenceLabel(method)} hint={referenceRequired(method) ? 'Required' : 'Optional'}>
                            <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
                          </Field>
                        </div>
                      </>
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
