import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, openPdf } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/ui';
import { date, money } from '../../lib/format';
import { Alert, Button, Dialog, Field, Segmented, StatusBadge } from '../../components/ui';
import { MemberPicker, MethodPicker, referenceLabel, referenceRequired, type MemberPick } from '../shared';

export function SellMembershipDialog({ memberId, memberName, planId: initialPlan, kind: initialKind, onClose }: {
  memberId?: string; memberName?: string; planId?: string; kind?: string; onClose: () => void;
}) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [member, setMember] = useState<MemberPick | null>(memberId ? { id: memberId, full_name: memberName ?? 'Member', member_code: '' } : null);
  const [planId, setPlanId] = useState(initialPlan ?? '');
  const [kind, setKind] = useState<string>(initialKind ?? 'auto');
  const [discount, setDiscount] = useState(0);
  const [collect, setCollect] = useState(can('payments.create'));
  const [amount, setAmount] = useState<number | ''>('');
  const [method, setMethod] = useState('upi');
  const [reference, setReference] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<any>(null);

  const { data: plans } = useQuery({ queryKey: ['plans'], queryFn: () => api.get<any[]>('/plans') });
  const { data: current } = useQuery({
    queryKey: ['member', member?.id],
    queryFn: () => api.get<any>(`/members/${member!.id}`),
    enabled: !!member,
  });
  const cm = current?.current_membership;
  const running = cm && ['active', 'expiring_soon', 'frozen'].includes(cm.status);
  const plan = plans?.find((p) => p.id === planId);
  const total = plan ? Math.round((plan.price - discount) * (1 + plan.tax_rate / 100) * 100) / 100 : 0;
  const changing = kind === 'upgrade' || kind === 'downgrade';

  const sell = useMutation({
    mutationFn: () =>
      api.post<any>('/memberships', {
        memberId: member!.id, planId, discount,
        kind: kind === 'auto' ? undefined : kind,
        payment: collect && Number(amount || total) > 0 && !changing ? { amount: Number(amount || total), method, reference: reference || null } : null,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries();
      toast('success', `${plan?.name} ${res.membership.kind === 'renewal' ? 'renewal' : 'membership'} created · ${res.invoice.invoice_number}`);
      setResult(res);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Something went wrong'),
  });

  if (result) {
    const balance = result.invoice.total - result.invoice.amount_paid;
    return (
      <Dialog open onClose={onClose} title="Membership created"
        footer={<>
          <Button onClick={() => openPdf(`/invoices/${result.invoice.id}/pdf`)}>Print invoice</Button>
          <Button variant="primary" onClick={onClose}>Done</Button>
        </>}>
        <div className="stack">
          <div className="summary-box">
            <div className="line"><span>Plan</span><b>{plan?.name}</b></div>
            <div className="line"><span>Valid</span><b>{date(result.membership.start_date)} – {date(result.membership.end_date)}</b></div>
            <div className="line"><span>Status</span><StatusBadge status={result.membership.status} /></div>
            <div className="line"><span>Invoice</span><b>{result.invoice.invoice_number}</b></div>
            <div className="line total"><span>Balance due</span><span>{money(balance, true)}</span></div>
          </div>
          {balance > 0 && <Alert tone="warning">{money(balance, true)} is outstanding. {result.membership.status === 'pending' ? 'The membership activates once a payment is recorded.' : ''}</Alert>}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} title="Sell or renew membership" sub="Raises an invoice and, if collected, records the payment in one step."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!member || !plan} loading={sell.isPending} onClick={() => { setError(''); sell.mutate(); }}>
        {collect && !changing ? `Create & collect ${money(Number(amount || total))}` : 'Create membership'}
      </Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <Field label="Member"><MemberPicker value={member} onChange={setMember} /></Field>
        {cm && cm.status !== 'none' && (
          <div className="summary-box">
            <div className="line"><span>Current plan</span><b>{cm.plan_name}</b></div>
            <div className="line"><span>Ends</span><b>{date(cm.end_date)}</b></div>
            <div className="line"><span>Status</span><StatusBadge status={cm.status} /></div>
          </div>
        )}
        {running && (
          <Field label="Type" hint={changing ? 'Starts today. Unused value of the current plan is credited automatically.' : 'Renewals start the day after the current plan ends.'}>
            <Segmented value={kind} onChange={setKind} options={[{ value: 'auto', label: 'Renewal' }, { value: 'upgrade', label: 'Upgrade' }, { value: 'downgrade', label: 'Downgrade' }]} />
          </Field>
        )}
        <div className="plan-options">
          {plans?.filter((p) => p.status === 'active').map((p) => (
            <button type="button" key={p.id} className={`plan-option ${planId === p.id ? 'on' : ''}`} onClick={() => { setPlanId(p.id); setDiscount(0); setAmount(''); }}>
              <div className="pn">{p.name}</div>
              <div className="pp">{money(p.price)}</div>
              <div className="pd">{p.duration_value} {p.duration_unit}{p.duration_value > 1 ? 's' : ''}{p.freeze_days_allowed ? ` · ${p.freeze_days_allowed}d freeze` : ''}</div>
            </button>
          ))}
        </div>
        {plan && (
          <>
            <Field label="Discount" hint={`Up to ${plan.max_discount_pct}% (${money((plan.price * plan.max_discount_pct) / 100)}) without manager approval`}>
              <div className="input-prefix"><span>₹</span><input className="input num" type="number" min={0} value={discount} onChange={(e) => setDiscount(Number(e.target.value))} /></div>
            </Field>
            <div className="summary-box">
              <div className="line"><span>{plan.name}</span><span>{money(plan.price, true)}</span></div>
              {!!discount && <div className="line"><span>Discount</span><span>− {money(discount, true)}</span></div>}
              {changing && <div className="line"><span>Credit from current plan</span><span>calculated on save</span></div>}
              <div className="line"><span>GST {plan.tax_rate}%</span><span>{money(((plan.price - discount) * plan.tax_rate) / 100, true)}</span></div>
              <div className="line total"><span>Total{changing ? ' (before credit)' : ''}</span><span>{money(total, true)}</span></div>
            </div>
            {changing ? (
              <Alert tone="info">Record the payment after saving — the invoice total will include the pro-rated credit.</Alert>
            ) : can('payments.create') && (
              <>
                <label className="check"><input type="checkbox" checked={collect} onChange={(e) => setCollect(e.target.checked)} />Collect payment now</label>
                {collect && (
                  <>
                    <MethodPicker value={method} onChange={setMethod} />
                    <div className="form-grid">
                      <Field label="Amount received" hint="Partial payments are allowed">
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
      </div>
    </Dialog>
  );
}
