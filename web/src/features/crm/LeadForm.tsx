import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, UserCheck } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/ui';
import { money } from '../../lib/format';
import { Alert, Button, Dialog, Field, StatusBadge } from '../../components/ui';
import { MemberPicker, MethodPicker, referenceLabel, referenceRequired, type MemberPick } from '../shared';
import { CredentialsCard } from '../members/MemberForm';
import { DuePicker, StageBadge } from './common';

const GOALS = ['Fat loss', 'Muscle gain', 'General fitness', 'Strength', 'Marathon prep', 'Post-injury rehab', 'Flexibility & mobility', 'Wedding prep'];

export function LeadFormDialog({ lead, onClose, onCreated }: { lead?: any; onClose: () => void; onCreated?: (id: string) => void }) {
  const { me, branch } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [f, setF] = useState(() => ({
    fullName: lead?.full_name ?? '', phone: lead?.phone ?? '', email: lead?.email ?? '', gender: lead?.gender ?? '',
    branchId: lead?.branch_id ?? (branch !== 'all' ? branch : me?.branches[0]?.id ?? ''), sourceId: lead?.source_id ?? '',
    interestedPlanId: lead?.interested_plan_id ?? '', interestedService: lead?.interested_service ?? 'Gym membership',
    budget: lead?.budget ?? '', goal: lead?.goal ?? '', expectedValue: lead?.expected_value ?? '', assignedTo: lead?.assigned_to ?? me?.id ?? '',
    notes: lead?.notes ?? '',
  }));
  const [referrer, setReferrer] = useState<MemberPick | null>(lead?.referred_by_member_id ? { id: lead.referred_by_member_id, full_name: lead.referred_by_name, member_code: lead.referred_by_code } : null);
  const [firstFollowUp, setFirstFollowUp] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dups, setDups] = useState<{ leads: any[]; members: any[] } | null>(null);
  const { data: sources } = useQuery({ queryKey: ['lead-sources'], queryFn: () => api.get<any[]>('/leads/sources') });
  const { data: plans } = useQuery({ queryKey: ['plans'], queryFn: () => api.get<any[]>('/plans') });
  const { data: staff } = useQuery({ queryKey: ['staff-min'], queryFn: () => api.get<any>('/admin/staff', { pageSize: 100 }), retry: false });
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const isReferral = sources?.find((s) => s.id === f.sourceId)?.name === 'Referral';

  const save = useMutation({
    mutationFn: (allowDuplicate: boolean) => {
      const body = {
        fullName: f.fullName, phone: f.phone || null, email: f.email || null, gender: f.gender || null, branchId: f.branchId,
        sourceId: f.sourceId || null, interestedPlanId: f.interestedPlanId || null, interestedService: f.interestedService || null,
        budget: f.budget === '' ? null : Number(f.budget), goal: f.goal || null, expectedValue: f.expectedValue === '' ? null : Number(f.expectedValue),
        assignedTo: f.assignedTo || null, notes: f.notes || null, referredByMemberId: isReferral ? referrer?.id ?? null : null,
      };
      return lead
        ? api.patch(`/leads/${lead.id}`, body)
        : api.post<any>('/leads', { ...body, allowDuplicate, firstFollowUpAt: firstFollowUp ? new Date(firstFollowUp).toISOString() : null });
    },
    onSuccess: (res: any) => {
      qc.invalidateQueries();
      toast('success', lead ? 'Lead updated' : `${f.fullName} added to the pipeline`);
      onClose();
      if (!lead && res?.id) onCreated?.(res.id);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'possible_duplicate') setDups(e.details as any);
      else if (e instanceof ApiError) setErrors({ ...e.fieldErrors(), _: e.message });
    },
  });

  return (
    <Dialog open variant="drawer" onClose={onClose} title={lead ? 'Edit lead' : 'Add lead'} sub={lead ? undefined : 'A first call is scheduled automatically within the hour.'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => { setErrors({}); setDups(null); save.mutate(false); }}>{lead ? 'Save' : 'Add lead'}</Button></>}>
      <div className="form">
        {errors._ && <Alert>{errors._}</Alert>}
        {dups && (
          <div className="summary-box" style={{ borderColor: 'var(--warning)' }}>
            <div className="row" style={{ color: 'var(--warning)', fontWeight: 700 }}><AlertTriangle size={16} />This person may already exist</div>
            {dups.members.map((m) => (
              <div key={m.id} className="row between"><span>Member · <b>{m.full_name}</b> {m.member_code}</span><span className="row"><StatusBadge status={m.status} /><Button size="sm" onClick={() => { onClose(); navigate(`/members/${m.id}`); }}>Open</Button></span></div>
            ))}
            {dups.leads.map((l) => (
              <div key={l.id} className="row between"><span>Lead · <b>{l.full_name}</b></span><span className="row"><StageBadge stage={l.stage} /><Button size="sm" onClick={() => { onClose(); navigate(`/leads?lead=${l.id}`); }}>Open</Button></span></div>
            ))}
            <div><Button size="sm" onClick={() => save.mutate(true)}>Add anyway</Button></div>
          </div>
        )}
        <div className="form-grid">
          <Field label="Full name" error={errors.fullName} className="full"><input className="input" autoFocus value={f.fullName} onChange={set('fullName')} /></Field>
          <Field label="Phone" error={errors.phone}><input className="input" inputMode="tel" value={f.phone} onChange={set('phone')} placeholder="+91 98450 00000" /></Field>
          <Field label="Email" error={errors.email}><input className="input" type="email" value={f.email} onChange={set('email')} /></Field>
          <Field label="Source">
            <select className="select" value={f.sourceId} onChange={set('sourceId')}>
              <option value="">—</option>{sources?.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Branch">
            <select className="select" value={f.branchId} onChange={set('branchId')}>{me?.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          </Field>
          {isReferral && <Field label="Referred by member" className="full"><MemberPicker value={referrer} onChange={setReferrer} /></Field>}
          <Field label="Interested plan">
            <select className="select" value={f.interestedPlanId} onChange={set('interestedPlanId')}>
              <option value="">Not sure yet</option>{plans?.filter((p) => p.status === 'active').map((p) => <option key={p.id} value={p.id}>{p.name} · {money(p.price)}</option>)}
            </select>
          </Field>
          <Field label="Interested in">
            <select className="select" value={f.interestedService} onChange={set('interestedService')}>
              {['Gym membership', 'Personal training', 'Group classes', 'Nutrition', 'Corporate plan'].map((s) => <option key={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Goal"><select className="select" value={f.goal} onChange={set('goal')}><option value="">—</option>{GOALS.map((g) => <option key={g}>{g}</option>)}</select></Field>
          <Field label="Budget"><div className="input-prefix"><span>₹</span><input className="input num" type="number" value={f.budget} onChange={set('budget')} /></div></Field>
          <Field label="Assigned to" className="full">
            <select className="select" value={f.assignedTo} onChange={set('assignedTo')}>
              {!staff && <option value={me?.id}>{me?.full_name}</option>}
              {staff?.data.filter((s: any) => s.is_active).map((s: any) => <option key={s.id} value={s.id}>{s.full_name} · {s.role_name}</option>)}
            </select>
          </Field>
          {!lead && <Field label="First follow-up" hint="Leave empty to call within the hour" className="full"><DuePicker value={firstFollowUp} onChange={setFirstFollowUp} /></Field>}
          <Field label="Notes" className="full"><textarea className="textarea" value={f.notes} onChange={set('notes')} /></Field>
        </div>
      </div>
    </Dialog>
  );
}

/** Lead → member, optionally selling the first plan and collecting payment. */
export function ConvertLeadDialog({ lead, onClose }: { lead: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [existing, setExisting] = useState<MemberPick | null>(null);
  const [f, setF] = useState({ fullName: lead.full_name, phone: lead.phone ?? '', email: lead.email ?? '' });
  const [issueApp, setIssueApp] = useState(true);
  const [sell, setSell] = useState(can('memberships.manage'));
  const [planId, setPlanId] = useState(lead.interested_plan_id ?? '');
  const [discount, setDiscount] = useState(0);
  const [collect, setCollect] = useState(can('payments.create'));
  const [amount, setAmount] = useState<number | ''>('');
  const [method, setMethod] = useState('upi');
  const [reference, setReference] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState<any>(null);
  const { data: plans } = useQuery({ queryKey: ['plans'], queryFn: () => api.get<any[]>('/plans') });
  const plan = plans?.find((p) => p.id === planId);
  const total = plan ? Math.round((plan.price - discount) * (1 + plan.tax_rate / 100) * 100) / 100 : 0;

  const m = useMutation({
    mutationFn: () =>
      api.post<any>(`/leads/${lead.id}/convert`, mode === 'existing' ? { existingMemberId: existing!.id } : {
        fullName: f.fullName, phone: f.phone, email: f.email || null, issueAppAccess: issueApp,
        membership: sell && plan ? { planId, discount, payment: collect && Number(amount || total) > 0 ? { amount: Number(amount || total), method, reference: reference || null } : null } : null,
      }),
    onSuccess: (r) => {
      qc.invalidateQueries();
      toast('success', `${lead.full_name} is now a member`);
      if (r.credentials || r.sale) setDone(r);
      else { onClose(); navigate(`/members/${r.memberId}`); }
    },
    onError: (e) => setError(e instanceof ApiError ? (e.details && Array.isArray(e.details) ? (e.details as any)[0]?.message ?? e.message : e.message) : 'Failed'),
  });

  if (done) {
    return (
      <Dialog open onClose={onClose} title="Converted to member" sub={`${done.member.member_code} · ${lead.full_name}`}
        footer={<><Button onClick={onClose}>Close</Button><Button variant="primary" onClick={() => { onClose(); navigate(`/members/${done.memberId}`); }}>Open profile</Button></>}>
        <div className="stack">
          {done.sale && (
            <div className="summary-box">
              <div className="line"><span>Membership</span><StatusBadge status={done.sale.membership.status} /></div>
              <div className="line"><span>Invoice</span><b>{done.sale.invoice.invoice_number}</b></div>
              <div className="line total"><span>Balance due</span><span>{money(done.sale.invoice.total - done.sale.invoice.amount_paid, true)}</span></div>
            </div>
          )}
          {done.credentials && <CredentialsCard login={done.credentials.login} password={done.credentials.temporaryPassword} />}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} title={`Convert ${lead.full_name}`} sub="Creates the member record the CRM and member app share, and closes the deal as Won."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={<UserCheck />} disabled={mode === 'existing' && !existing} loading={m.isPending} onClick={() => { setError(''); m.mutate(); }}>
        {mode === 'new' && sell && plan && collect ? `Convert & collect ${money(Number(amount || total))}` : 'Convert'}
      </Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <div className="chips">
          <button type="button" className={`chip ${mode === 'new' ? 'on' : ''}`} onClick={() => setMode('new')}>New member</button>
          <button type="button" className={`chip ${mode === 'existing' ? 'on' : ''}`} onClick={() => setMode('existing')}>Already a member</button>
        </div>
        {mode === 'existing' ? (
          <Field label="Link to member" hint="Use when this person re-joined or was registered at the desk"><MemberPicker value={existing} onChange={setExisting} /></Field>
        ) : (
          <>
            <div className="form-grid">
              <Field label="Full name" className="full"><input className="input" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
              <Field label="Phone"><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
              <Field label="Email"><input className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            </div>
            <label className="check"><input type="checkbox" checked={issueApp} onChange={(e) => setIssueApp(e.target.checked)} />Issue member app login</label>
            {can('memberships.manage') && <label className="check"><input type="checkbox" checked={sell} onChange={(e) => setSell(e.target.checked)} />Sell a membership now</label>}
            {sell && (
              <>
                <div className="plan-options">
                  {plans?.filter((p) => p.status === 'active').map((p) => (
                    <button type="button" key={p.id} className={`plan-option ${planId === p.id ? 'on' : ''}`} onClick={() => { setPlanId(p.id); setAmount(''); }}>
                      <div className="pn">{p.name}</div><div className="pp">{money(p.price)}</div>
                      <div className="pd">{p.duration_value} {p.duration_unit}{p.duration_value > 1 ? 's' : ''}{p.id === lead.interested_plan_id ? ' · interested' : ''}</div>
                    </button>
                  ))}
                </div>
                {plan && (
                  <>
                    <Field label="Discount" hint={`Up to ${plan.max_discount_pct}% without manager approval`}>
                      <div className="input-prefix"><span>₹</span><input className="input num" type="number" min={0} value={discount} onChange={(e) => setDiscount(Number(e.target.value))} /></div>
                    </Field>
                    <div className="summary-box"><div className="line total"><span>Total incl. GST</span><span>{money(total, true)}</span></div></div>
                    {can('payments.create') && <label className="check"><input type="checkbox" checked={collect} onChange={(e) => setCollect(e.target.checked)} />Collect payment now</label>}
                    {collect && (
                      <>
                        <MethodPicker value={method} onChange={setMethod} />
                        <div className="form-grid">
                          <Field label="Amount"><div className="input-prefix"><span>₹</span><input className="input num" type="number" value={amount} placeholder={String(total)} onChange={(e) => setAmount(e.target.value === '' ? '' : Number(e.target.value))} /></div></Field>
                          <Field label={referenceLabel(method)} hint={referenceRequired(method) ? 'Required' : 'Optional'}><input className="input" value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
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

export function LostDialog({ lead, onConfirm, onClose, busy }: { lead: any; onConfirm: (reason: string) => void; onClose: () => void; busy?: boolean }) {
  const [reason, setReason] = useState('');
  const reasons = ['Too expensive', 'Joined another gym', 'Location not convenient', 'Not ready yet', 'No response after 5 attempts', 'Timing doesn’t suit'];
  return (
    <Dialog open onClose={onClose} title={`Mark ${lead.full_name} as lost?`} sub="Open follow-ups are closed. You can reopen the lead later."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" disabled={reason.trim().length < 2} loading={busy} onClick={() => onConfirm(reason.trim())}>Mark lost</Button></>}>
      <div className="form">
        <div className="chips">{reasons.map((r) => <button type="button" key={r} className={`chip ${reason === r ? 'on' : ''}`} onClick={() => setReason(r)}>{r}</button>)}</div>
        <Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Or type a reason" /></Field>
      </div>
    </Dialog>
  );
}
