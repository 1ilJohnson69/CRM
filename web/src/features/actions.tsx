import { createContext, useContext, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { MemberFormDialog } from './members/MemberForm';
import { SellMembershipDialog } from './memberships/SellMembership';
import { RecordPaymentDialog } from './billing/RecordPayment';
import { ContactDialog, FollowUpDialog, type ContactTarget } from './crm/common';
import { LeadFormDialog } from './crm/LeadForm';

interface ActionsValue {
  addMember: () => void;
  editMember: (member: any) => void;
  sellMembership: (opts?: { memberId?: string; memberName?: string; planId?: string; kind?: string }) => void;
  recordPayment: (opts?: { memberId?: string; memberName?: string; invoiceId?: string }) => void;
  addLead: () => void;
  contact: (target: ContactTarget) => void;
  followUp: (target: ContactTarget) => void;
}

const Ctx = createContext<ActionsValue | null>(null);

// Central place for the flows staff run from many screens, so a payment
// recorded from the dashboard and from a profile is the exact same UI.
export function Actions({ children }: { children: ReactNode }) {
  const [member, setMember] = useState<{ open: boolean; edit?: any }>({ open: false });
  const [sale, setSale] = useState<{ open: boolean; opts?: Parameters<ActionsValue['sellMembership']>[0] }>({ open: false });
  const [payment, setPayment] = useState<{ open: boolean; opts?: Parameters<ActionsValue['recordPayment']>[0] }>({ open: false });
  const [lead, setLead] = useState(false);
  const [contact, setContact] = useState<ContactTarget | null>(null);
  const [followUp, setFollowUp] = useState<ContactTarget | null>(null);
  const navigate = useNavigate();

  const value: ActionsValue = {
    addMember: () => setMember({ open: true }),
    editMember: (m) => setMember({ open: true, edit: m }),
    sellMembership: (opts) => setSale({ open: true, opts }),
    recordPayment: (opts) => setPayment({ open: true, opts }),
    addLead: () => setLead(true),
    contact: setContact,
    followUp: setFollowUp,
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      {member.open && <MemberFormDialog edit={member.edit} onClose={() => setMember({ open: false })} />}
      {sale.open && <SellMembershipDialog {...sale.opts} onClose={() => setSale({ open: false })} />}
      {payment.open && <RecordPaymentDialog {...payment.opts} onClose={() => setPayment({ open: false })} />}
      {lead && <LeadFormDialog onClose={() => setLead(false)} onCreated={(id) => navigate(`/leads?lead=${id}`)} />}
      {contact && <ContactDialog target={contact} onClose={() => setContact(null)} />}
      {followUp && <FollowUpDialog target={followUp} onClose={() => setFollowUp(null)} />}
    </Ctx.Provider>
  );
}

export function useActions() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useActions outside Actions');
  return ctx;
}
