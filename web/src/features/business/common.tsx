import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { useToast } from '../../lib/ui';
import { money } from '../../lib/format';
import { Alert, Button, Dialog, Field } from '../../components/ui';
import { MethodPicker, referenceLabel, referenceRequired } from '../shared';

export const CATEGORY_LABEL: Record<string, string> = {
  supplements: 'Supplements', merchandise: 'Merchandise', food_beverage: 'Food & drinks', accessories: 'Accessories', services: 'Services',
};
export const MOVEMENT_LABEL: Record<string, string> = {
  stock_in: 'Received', stock_out: 'Stock out', adjustment: 'Count adjustment', damaged: 'Damaged', sold: 'Sold', returned: 'Returned', transfer_in: 'Transfer in', transfer_out: 'Transfer out',
};
export const REFERRAL_TONE: Record<string, string> = { pending: 'neutral', joined: 'info', verified: 'warning', rewarded: 'success', rejected: 'danger' };
export const REASON_LABEL: Record<string, string> = {
  purchase: 'Purchase', renewal: 'Renewal bonus', referral: 'Referral reward', referral_welcome: 'Referral welcome', attendance_milestone: 'Visit milestone',
  event: 'Event', challenge: 'Challenge', manual: 'Adjustment', redemption: 'Redeemed', reversal: 'Reversal',
};

/** Pick lines and quantities from a product sale and refund their share. */
export function RefundDialog({ sale, onClose }: { sale: { id: string; invoice_number: string; items: any[]; amount_paid: number; amount_refunded: number; total: number }; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const returnable = sale.items.filter((i) => i.product_id && i.quantity - i.returned_qty > 0);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [restock, setRestock] = useState(true);
  const [method, setMethod] = useState('cash');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const gross = sale.items.reduce((s, i) => s + Number(i.amount), 0);
  const factor = gross > 0 ? sale.total / gross : 0;
  const estimate = Math.min(
    returnable.reduce((s, i) => s + (Number(i.amount) / i.quantity) * (qty[i.id] ?? 0) * factor, 0),
    sale.amount_paid - sale.amount_refunded,
  );
  const refund = useMutation({
    mutationFn: () => api.post<any>(`/pos/sales/${sale.id}/refund`, {
      items: Object.entries(qty).filter(([, q]) => q > 0).map(([invoiceItemId, quantity]) => ({ invoiceItemId, quantity })),
      restock, method, reference: reference || null, reason,
    }),
    onSuccess: (r) => { qc.invalidateQueries(); toast('success', `${r.refund_number} · ${money(r.amount, true)} refunded`); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Refund failed'),
  });
  const any = Object.values(qty).some((q) => q > 0);
  return (
    <Dialog open onClose={onClose} title={`Return items · ${sale.invoice_number}`} sub="Refunds what the customer paid for the returned units, including GST and any points discount."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!any || reason.trim().length < 3} loading={refund.isPending} onClick={() => { setError(''); refund.mutate(); }}>Refund {money(estimate, true)}</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        {!returnable.length ? <Alert tone="info">Everything on this sale has already been returned.</Alert> : (
          <div className="stack" style={{ gap: 6 }}>{returnable.map((i) => {
            const left = i.quantity - i.returned_qty;
            return (
              <div key={i.id} className="cart-line">
                <div style={{ minWidth: 0 }}><b>{i.description}</b><div className="faint" style={{ fontSize: 12 }}>{left} of {i.quantity} returnable · {money(Number(i.amount) / i.quantity, true)} each</div></div>
                <div className="stepper">
                  <button type="button" aria-label="Fewer" onClick={() => setQty({ ...qty, [i.id]: Math.max(0, (qty[i.id] ?? 0) - 1) })}>−</button>
                  <span className="num">{qty[i.id] ?? 0}</span>
                  <button type="button" aria-label="More" onClick={() => setQty({ ...qty, [i.id]: Math.min(left, (qty[i.id] ?? 0) + 1) })}>+</button>
                </div>
              </div>
            );
          })}</div>
        )}
        <label className="check"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} />Put returned items back into stock (unopened)</label>
        <Field label="Refund via"><MethodPicker value={method} onChange={setMethod} /></Field>
        {method !== 'cash' && <Field label={referenceLabel(method)}><input className="input" value={reference} onChange={(e) => setReference(e.target.value)} required={referenceRequired(method)} /></Field>}
        <Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Wrong flavour, unopened" /></Field>
      </div>
    </Dialog>
  );
}
