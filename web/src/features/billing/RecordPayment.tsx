import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, openPdf, type Paged } from '../../lib/api';
import { useToast } from '../../lib/ui';
import { date, money } from '../../lib/format';
import { Alert, Button, Dialog, Empty, Field, StatusBadge } from '../../components/ui';
import { MemberPicker, MethodPicker, referenceLabel, referenceRequired, type MemberPick } from '../shared';

export function RecordPaymentDialog({ memberId, memberName, invoiceId, onClose }: { memberId?: string; memberName?: string; invoiceId?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [member, setMember] = useState<MemberPick | null>(memberId ? { id: memberId, full_name: memberName ?? 'Member', member_code: '' } : null);
  const [selected, setSelected] = useState<string | undefined>(invoiceId);
  const [amount, setAmount] = useState<number | ''>('');
  const [method, setMethod] = useState('upi');
  const [reference, setReference] = useState('');
  const [paidAt, setPaidAt] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<{ msg: string; fields: Record<string, string> } | null>(null);
  const [done, setDone] = useState<any>(null);

  const { data: invoices, isLoading } = useQuery({
    queryKey: ['outstanding', member?.id],
    queryFn: () => api.get<Paged<any>>('/invoices', { memberId: member!.id, status: 'outstanding', pageSize: 20 }),
    enabled: !!member,
  });
  useEffect(() => {
    if (!selected && invoices?.data.length === 1) setSelected(invoices.data[0].id);
  }, [invoices, selected]);
  const invoice = invoices?.data.find((i) => i.id === selected);

  const pay = useMutation({
    mutationFn: () =>
      api.post<any>('/payments', {
        invoiceId: selected, amount: Number(amount || invoice?.balance), method, reference: reference || null, notes: notes || null,
        paidAt: paidAt ? new Date(paidAt).toISOString() : null,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries();
      toast('success', `${money(res.amount)} recorded · ${res.receipt_number}`);
      setDone(res);
    },
    onError: (e) => setError(e instanceof ApiError ? { msg: e.message, fields: e.fieldErrors() } : { msg: 'Something went wrong', fields: {} }),
  });

  if (done) {
    return (
      <Dialog open onClose={onClose} title="Payment recorded" footer={<><Button onClick={() => openPdf(`/invoices/${done.invoice_id}/pdf`)}>Print receipt</Button><Button variant="primary" onClick={onClose}>Done</Button></>}>
        <div className="summary-box">
          <div className="line"><span>Receipt</span><b>{done.receipt_number}</b></div>
          <div className="line"><span>Amount</span><b>{money(done.amount, true)}</b></div>
          <div className="line"><span>Invoice status</span><StatusBadge status={done.invoice_status} /></div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} title="Record payment" sub="For money collected at the gym — cash, UPI, card or bank transfer."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!invoice} loading={pay.isPending} onClick={() => { setError(null); pay.mutate(); }}>
        Record {money(Number(amount || invoice?.balance || 0))}
      </Button></>}>
      <div className="form">
        {error && <Alert>{error.msg}</Alert>}
        <Field label="Member"><MemberPicker value={member} onChange={(m) => { setMember(m); setSelected(undefined); }} /></Field>
        {member && (
          <Field label="Outstanding invoice">
            {isLoading ? <div className="faint">Loading…</div> : !invoices?.data.length ? (
              <Empty title="Nothing outstanding">This member has no unpaid invoices. To take money for a new plan, use “Sell or renew membership”.</Empty>
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                {invoices.data.map((i) => (
                  <button key={i.id} type="button" className={`plan-option ${selected === i.id ? 'on' : ''}`} onClick={() => { setSelected(i.id); setAmount(''); }}>
                    <div className="row between"><span className="pn">{i.invoice_number}</span><StatusBadge status={i.status} /></div>
                    <div className="pd">{i.description} · {date(i.issue_date)}</div>
                    <div className="row between" style={{ marginTop: 4 }}><span className="faint">Total {money(i.total)}</span><span className="pp">{money(i.balance, true)} due</span></div>
                  </button>
                ))}
              </div>
            )}
          </Field>
        )}
        {invoice && (
          <>
            <MethodPicker value={method} onChange={setMethod} />
            <div className="form-grid">
              <Field label="Amount" error={error?.fields.amount} hint={`Balance ${money(invoice.balance, true)}`}>
                <div className="input-prefix"><span>₹</span><input className="input num" type="number" value={amount} placeholder={String(invoice.balance)} onChange={(e) => setAmount(e.target.value === '' ? '' : Number(e.target.value))} /></div>
              </Field>
              <Field label={referenceLabel(method)} hint={referenceRequired(method) ? 'Required' : 'Optional'}>
                <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
              </Field>
              <Field label="Received at" hint="Leave empty for now">
                <input className="input" type="datetime-local" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
              </Field>
              <Field label="Notes"><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
