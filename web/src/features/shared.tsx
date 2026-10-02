import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { api, type Paged } from '../lib/api';
import { useDebounced } from '../lib/ui';
import { Person, StatusBadge } from '../components/ui';
import { money } from '../lib/format';
import { methodIcon } from '../components/ui';

export interface MemberPick { id: string; full_name: string; member_code: string; phone?: string; status?: string; outstanding?: number; branch_id?: string }

/** Typeahead for choosing a member inside a dialog. */
export function MemberPicker({ value, onChange }: { value: MemberPick | null; onChange: (m: MemberPick | null) => void }) {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 200);
  const { data, isFetching } = useQuery({
    queryKey: ['member-pick', term],
    queryFn: () => api.get<Paged<MemberPick>>('/members', { search: term, pageSize: 6, sort: 'name' }),
    enabled: !value && term.length >= 2,
  });

  if (value) {
    return (
      <div className="summary-box" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Person name={value.full_name} detail={[value.member_code, value.phone].filter(Boolean).join(' · ')} />
        <button className="icon-btn" style={{ width: 30, height: 30 }} onClick={() => onChange(null)} aria-label="Change member"><X /></button>
      </div>
    );
  }
  return (
    <div>
      <div className="search-box" style={{ width: '100%' }}>
        <Search />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, phone or member ID" style={{ paddingRight: 12 }} />
      </div>
      {term.length >= 2 && (
        <div className="stack" style={{ gap: 2, marginTop: 6 }}>
          {isFetching && !data && <div className="faint" style={{ padding: 8 }}>Searching…</div>}
          {data?.data.length === 0 && <div className="faint" style={{ padding: 8 }}>No members found</div>}
          {data?.data.map((m) => (
            <button key={m.id} className="search-item" onClick={() => onChange(m)}>
              <Person name={m.full_name} detail={`${m.member_code} · ${m.phone ?? ''}`} />
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                {!!m.outstanding && <span className="badge warning">{money(m.outstanding)} due</span>}
                {m.status && <StatusBadge status={m.status} />}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export const METHODS = ['upi', 'cash', 'card', 'bank_transfer', 'other'] as const;
const SHORT: Record<string, string> = { upi: 'UPI', cash: 'Cash', card: 'Card', bank_transfer: 'Bank', other: 'Other' };

export function MethodPicker({ value, onChange }: { value: string; onChange: (m: string) => void }) {
  return (
    <div className="method-picker" role="radiogroup" aria-label="Payment method">
      {METHODS.map((m) => (
        <button key={m} type="button" role="radio" aria-checked={value === m} className={value === m ? 'on' : ''} onClick={() => onChange(m)}>
          {methodIcon(m)}{SHORT[m]}
        </button>
      ))}
    </div>
  );
}

export const referenceLabel = (method: string) =>
  method === 'upi' ? 'UPI transaction ID (UTR)' : method === 'bank_transfer' ? 'Bank reference (NEFT/IMPS)' : method === 'card' ? 'POS slip / approval code' : 'Reference';
export const referenceRequired = (method: string) => method === 'upi' || method === 'bank_transfer';
