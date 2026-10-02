import { createContext, useContext, useState, type ReactNode } from 'react';
import { MemberFormDialog } from './members/MemberForm';
import { SellMembershipDialog } from './memberships/SellMembership';
import { RecordPaymentDialog } from './billing/RecordPayment';

interface ActionsValue {
  addMember: () => void;
  editMember: (member: any) => void;
  sellMembership: (opts?: { memberId?: string; memberName?: string; planId?: string; kind?: string }) => void;
  recordPayment: (opts?: { memberId?: string; memberName?: string; invoiceId?: string }) => void;
}

const Ctx = createContext<ActionsValue | null>(null);

// Central place for the flows staff run from many screens, so a payment
// recorded from the dashboard and from a profile is the exact same UI.
export function Actions({ children }: { children: ReactNode }) {
  const [member, setMember] = useState<{ open: boolean; edit?: any }>({ open: false });
  const [sale, setSale] = useState<{ open: boolean; opts?: Parameters<ActionsValue['sellMembership']>[0] }>({ open: false });
  const [payment, setPayment] = useState<{ open: boolean; opts?: Parameters<ActionsValue['recordPayment']>[0] }>({ open: false });

  const value: ActionsValue = {
    addMember: () => setMember({ open: true }),
    editMember: (m) => setMember({ open: true, edit: m }),
    sellMembership: (opts) => setSale({ open: true, opts }),
    recordPayment: (opts) => setPayment({ open: true, opts }),
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      {member.open && <MemberFormDialog edit={member.edit} onClose={() => setMember({ open: false })} />}
      {sale.open && <SellMembershipDialog {...sale.opts} onClose={() => setSale({ open: false })} />}
      {payment.open && <RecordPaymentDialog {...payment.opts} onClose={() => setPayment({ open: false })} />}
    </Ctx.Provider>
  );
}

export function useActions() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useActions outside Actions');
  return ctx;
}
