import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowDownToLine, ArrowRightLeft, Boxes, ClipboardCheck, Package, Pencil, Plus, Search, Trash2, TrendingUp, Truck, Warehouse } from 'lucide-react';
import { api, ApiError, branchScope, type Paged } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced, useToast } from '../../lib/ui';
import { dateShort, dateTime, money, number, relative } from '../../lib/format';
import { Alert, Button, Card, Dialog, Empty, Field, Pagination, Skeleton, Tabs } from '../../components/ui';
import { Bars } from '../../components/charts';
import { MethodPicker, referenceLabel, referenceRequired } from '../shared';
import { CATEGORY_LABEL, MOVEMENT_LABEL } from './common';

const errMsg = (e: unknown) => (e instanceof ApiError ? (Array.isArray(e.details) ? `${(e.details as any)[0].path ?? ''} ${(e.details as any)[0].message}`.trim() : e.message) : 'Something went wrong');
const stockState = (p: any) => (!p.track_stock ? null : p.stock === 0 ? 'out' : p.stock <= p.low_stock_threshold ? 'low' : 'ok');

function StockPill({ p }: { p: any }) {
  const st = stockState(p);
  if (!st) return <span className="faint">Not stocked</span>;
  return <span className={`stock-pill ${st}`}><i />{number(p.stock)}{st !== 'ok' && <span className="faint" style={{ fontWeight: 600 }}>{st === 'out' ? ' out' : ` · alert ${p.low_stock_threshold}`}</span>}</span>;
}

function ProductDialog({ product, onClose }: { product?: any; onClose: () => void }) {
  const qc = useQueryClient();
  const { me } = useAuth();
  const { data: suppliers } = useQuery({ queryKey: ['suppliers'], queryFn: () => api.get<any[]>('/inventory/suppliers') });
  const scoped = branchScope.get();
  const [f, setF] = useState({
    sku: product?.sku ?? '', barcode: product?.barcode ?? '', name: product?.name ?? '', category: product?.category ?? 'supplements', brand: product?.brand ?? '',
    description: product?.description ?? '', costPrice: product?.cost_price ?? '', sellingPrice: product?.selling_price ?? '', taxRate: product?.tax_rate ?? 18,
    trackStock: product?.track_stock ?? true, lowStockThreshold: product?.low_stock_threshold ?? 5, supplierId: product?.supplier_id ?? '', isActive: product?.is_active ?? true,
    openingStock: '' as number | '', branchId: scoped !== 'all' ? scoped : me?.branches[0]?.id ?? '',
  });
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, supplierId: f.supplierId || null, barcode: f.barcode || null, openingStock: f.openingStock || 0, trackStock: f.category !== 'services' && f.trackStock };
      return product ? api.put(`/inventory/products/${product.id}`, body) : api.post('/inventory/products', body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['inventory'] }); qc.invalidateQueries({ queryKey: ['product'] }); onClose(); },
    onError: (e) => setError(errMsg(e)),
  });
  const margin = Number(f.sellingPrice) > 0 ? Math.round(((Number(f.sellingPrice) - Number(f.costPrice || 0)) / Number(f.sellingPrice)) * 100) : null;
  return (
    <Dialog open variant="drawer" onClose={onClose} title={product ? `Edit ${product.name}` : 'New product'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => { setError(''); save.mutate(); }}>Save</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <Field label="Name"><input className="input" value={f.name} onChange={set('name')} placeholder="Whey Protein 1 kg · Chocolate" /></Field>
        <div className="form-grid">
          <Field label="SKU"><input className="input" value={f.sku} onChange={set('sku')} placeholder="SUP-WHY-CHO" /></Field>
          <Field label="Barcode" hint="Scan into this field"><input className="input" value={f.barcode} onChange={set('barcode')} /></Field>
          <Field label="Category"><select className="select" value={f.category} onChange={set('category')}>{Object.entries(CATEGORY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Brand"><input className="input" value={f.brand} onChange={set('brand')} /></Field>
          <Field label="Cost price (₹)"><input className="input num" type="number" min={0} value={f.costPrice} onChange={set('costPrice')} /></Field>
          <Field label="Selling price (₹)" hint={margin !== null ? `${margin}% margin before GST` : undefined}><input className="input num" type="number" min={0} value={f.sellingPrice} onChange={set('sellingPrice')} /></Field>
          <Field label="GST %"><select className="select" value={f.taxRate} onChange={set('taxRate')}>{[0, 5, 12, 18, 28].map((r) => <option key={r} value={r}>{r}%</option>)}</select></Field>
          <Field label="Supplier"><select className="select" value={f.supplierId} onChange={set('supplierId')}><option value="">—</option>{suppliers?.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        </div>
        {f.category !== 'services' && (
          <>
            <label className="check"><input type="checkbox" checked={f.trackStock} onChange={set('trackStock')} />Track stock for this product</label>
            {f.trackStock && (
              <div className="form-grid">
                <Field label="Low-stock alert at"><input className="input num" type="number" min={0} value={f.lowStockThreshold} onChange={set('lowStockThreshold')} /></Field>
                {!product && <Field label="Opening stock"><input className="input num" type="number" min={0} value={f.openingStock} onChange={set('openingStock')} placeholder="0" /></Field>}
                {!product && Number(f.openingStock) > 0 && (me?.branches.length ?? 0) > 1 && (
                  <Field label="At branch" className="full"><select className="select" value={f.branchId} onChange={set('branchId')}>{me!.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
                )}
              </div>
            )}
          </>
        )}
        <Field label="Description"><textarea className="textarea" value={f.description} onChange={set('description')} /></Field>
        {product && <label className="check"><input type="checkbox" checked={f.isActive} onChange={set('isActive')} />Available for sale</label>}
      </div>
    </Dialog>
  );
}

type MoveKind = 'stock_in' | 'adjustment' | 'damaged' | 'stock_out' | 'transfer';
const MOVE_TITLE: Record<MoveKind, string> = { stock_in: 'Receive stock', adjustment: 'Stock count', damaged: 'Write off damaged', stock_out: 'Remove stock', transfer: 'Transfer to branch' };

export function StockDialog({ product, kind, onClose }: { product: any; kind: MoveKind; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can, me } = useAuth();
  const branches: { branch_id: string; branch_name: string; quantity: number }[] = product.branches;
  const scoped = branchScope.get();
  const [branchId, setBranchId] = useState(scoped !== 'all' ? scoped : branches[0]?.branch_id ?? '');
  const [toBranchId, setToBranchId] = useState(me?.branches.find((b) => b.id !== branchId)?.id ?? '');
  const [qty, setQty] = useState<number | ''>('');
  const [unitCost, setUnitCost] = useState<number | ''>(product.cost_price ?? '');
  const [supplierId, setSupplierId] = useState(product.supplier_id ?? '');
  const [reason, setReason] = useState('');
  const [bookExpense, setBookExpense] = useState(can('expenses.manage'));
  const [method, setMethod] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  const [error, setError] = useState('');
  const { data: suppliers } = useQuery({ queryKey: ['suppliers'], queryFn: () => api.get<any[]>('/inventory/suppliers'), enabled: kind === 'stock_in' });
  const here = branches.find((b) => b.branch_id === branchId)?.quantity ?? 0;
  const save = useMutation({
    mutationFn: () => api.post('/inventory/movements', kind === 'stock_in'
      ? { type: kind, productId: product.id, branchId, quantity: qty, unitCost: unitCost === '' ? null : unitCost, supplierId: supplierId || null, reason: reason || null, expense: bookExpense ? { method, reference: reference || null } : null }
      : kind === 'adjustment' ? { type: kind, productId: product.id, branchId, countedQuantity: qty, reason }
        : kind === 'transfer' ? { type: kind, productId: product.id, branchId, toBranchId, quantity: qty, reason: reason || null }
          : { type: kind, productId: product.id, branchId, quantity: qty, reason }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['inventory'] }); qc.invalidateQueries({ queryKey: ['product', product.id] }); toast('success', `${MOVE_TITLE[kind]} saved`); onClose(); },
    onError: (e) => setError(errMsg(e)),
  });
  const cost = kind === 'stock_in' && qty && unitCost !== '' ? Number(qty) * Number(unitCost) : 0;
  return (
    <Dialog open onClose={onClose} title={`${MOVE_TITLE[kind]} · ${product.name}`} sub={`${here} in stock at the selected branch`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={qty === '' || !branchId} loading={save.isPending} onClick={() => { setError(''); save.mutate(); }}>Save</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        {branches.length > 1 && (
          <Field label={kind === 'transfer' ? 'From branch' : 'Branch'}>
            <select className="select" value={branchId} onChange={(e) => setBranchId(e.target.value)}>{branches.map((b) => <option key={b.branch_id} value={b.branch_id}>{b.branch_name} · {b.quantity} in stock</option>)}</select>
          </Field>
        )}
        {kind === 'transfer' && (
          <Field label="To branch"><select className="select" value={toBranchId} onChange={(e) => setToBranchId(e.target.value)}>{me?.branches.filter((b) => b.id !== branchId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        )}
        <Field label={kind === 'adjustment' ? 'Counted on the shelf' : 'Quantity'} hint={kind === 'adjustment' && qty !== '' ? `${Number(qty) - here >= 0 ? '+' : ''}${Number(qty) - here} against the system` : undefined}>
          <input className="input num" type="number" min={kind === 'adjustment' ? 0 : 1} value={qty} onChange={(e) => setQty(e.target.value === '' ? '' : Number(e.target.value))} autoFocus />
        </Field>
        {kind === 'stock_in' && (
          <>
            <div className="form-grid">
              <Field label="Unit cost (₹)" hint="Updates the product's cost price"><input className="input num" type="number" min={0} value={unitCost} onChange={(e) => setUnitCost(e.target.value === '' ? '' : Number(e.target.value))} /></Field>
              <Field label="Supplier"><select className="select" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}><option value="">—</option>{suppliers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            </div>
            {can('expenses.manage') && <label className="check"><input type="checkbox" checked={bookExpense} onChange={(e) => setBookExpense(e.target.checked)} />Record {cost ? money(cost) : 'the purchase'} as an Inventory expense</label>}
            {bookExpense && (
              <>
                <Field label="Paid via"><MethodPicker value={method} onChange={setMethod} /></Field>
                {method !== 'cash' && <Field label={referenceLabel(method)}><input className="input" value={reference} onChange={(e) => setReference(e.target.value)} required={referenceRequired(method)} /></Field>}
              </>
            )}
          </>
        )}
        <Field label={kind === 'stock_in' || kind === 'transfer' ? 'Note (optional)' : 'Reason'}>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={kind === 'damaged' ? 'Seal broken, expired…' : kind === 'adjustment' ? 'Monthly stock count' : ''} />
        </Field>
      </div>
    </Dialog>
  );
}

function ProductDrawer({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (p: any) => void }) {
  const { can } = useAuth();
  const [move, setMove] = useState<MoveKind | null>(null);
  const { data: p } = useQuery({ queryKey: ['product', id], queryFn: () => api.get<any>(`/inventory/products/${id}`) });
  return (
    <Dialog open variant="drawer" wide onClose={onClose} title={p?.name ?? 'Product'} sub={p ? `${p.sku} · ${CATEGORY_LABEL[p.category]}${p.brand ? ` · ${p.brand}` : ''}` : undefined}>
      {!p ? <Skeleton h={400} /> : (
        <div className="stack">
          <div className="metric-tiles" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
            <div className="metric-tile"><div className="k">Price</div><div className="v">{money(p.selling_price)}</div><div className="d flat">GST {p.tax_rate}%</div></div>
            <div className="metric-tile"><div className="k">Margin</div><div className="v">{p.selling_price ? Math.round(((p.selling_price - p.cost_price) / p.selling_price) * 100) : 0}%</div><div className="d flat">cost {money(p.cost_price)}</div></div>
            <div className="metric-tile"><div className="k">In stock</div><div className="v">{p.track_stock ? number(p.stock) : '—'}</div><div className={`d ${stockState(p) === 'ok' ? 'good' : stockState(p) ? 'bad' : 'flat'}`}>{p.track_stock ? `alert at ${p.low_stock_threshold}` : 'service'}</div></div>
            <div className="metric-tile"><div className="k">Sold · 30 days</div><div className="v">{p.sold_30d}</div><div className="d flat">{p.supplier_name ?? 'no supplier'}</div></div>
          </div>
          {p.track_stock && <div className="branch-stock">{p.branches.map((b: any) => <span key={b.branch_id}>{b.branch_name} <b>{b.quantity}</b></span>)}</div>}
          {can('inventory.manage') && (
            <div className="row wrap">
              {p.track_stock && <>
                <Button variant="primary" size="sm" icon={<ArrowDownToLine />} onClick={() => setMove('stock_in')}>Receive</Button>
                <Button size="sm" icon={<ClipboardCheck />} onClick={() => setMove('adjustment')}>Count</Button>
                <Button size="sm" icon={<Trash2 />} onClick={() => setMove('damaged')}>Write off</Button>
                {p.branches.length > 1 && <Button size="sm" icon={<ArrowRightLeft />} onClick={() => setMove('transfer')}>Transfer</Button>}
              </>}
              <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => onEdit(p)}>Edit</Button>
            </div>
          )}
          <Card title="Units sold per month" icon={<TrendingUp />}>
            <Bars data={p.monthly.map((m: any) => ({ key: m.date, value: m.value }))} height={150} label={(k) => new Date(k).toLocaleDateString('en-IN', { month: 'short' })} valueLabel={(v) => `${v} units`} />
          </Card>
          <Card title="Stock movements" icon={<Boxes />} bodyClass="">
            {!p.movements.length ? <Empty title="No movements yet" /> : (
              <div className="table-wrap" style={{ marginTop: 6, maxHeight: 360, overflowY: 'auto' }}><table className="tbl">
                <thead><tr><th>When</th><th>Type</th><th className="r">Qty</th><th className="r">After</th><th>Branch</th><th>Detail</th></tr></thead>
                <tbody>{p.movements.map((m: any) => (
                  <tr key={m.id}>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>{dateTime(m.created_at)}</td>
                    <td>{MOVEMENT_LABEL[m.type]}</td>
                    <td className={`r num ${m.quantity > 0 ? 'qty-in' : 'qty-out'}`}>{m.quantity > 0 ? '+' : ''}{m.quantity}</td>
                    <td className="r num">{m.balance_after}</td>
                    <td className="muted">{m.branch_name}{m.transfer_branch_name ? ` ${m.type === 'transfer_in' ? '←' : '→'} ${m.transfer_branch_name}` : ''}</td>
                    <td className="muted">{m.invoice_number ?? m.supplier_name ?? m.reason ?? '—'}{m.created_by_name ? ` · ${m.created_by_name}` : ''}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </Card>
        </div>
      )}
      {move && p && <StockDialog product={p} kind={move} onClose={() => setMove(null)} />}
    </Dialog>
  );
}

function Products({ onOpen }: { onOpen: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [stock, setStock] = useState('');
  const [page, setPage] = useState(1);
  const term = useDebounced(q.trim());
  const { data } = useQuery({
    queryKey: ['inventory', 'products', term, cat, stock, page],
    queryFn: () => api.get<Paged<any>>('/inventory/products', { search: term || undefined, category: cat || undefined, stock: stock || undefined, page, pageSize: 25, includeInactive: true }),
  });
  return (
    <section className="card">
      <div className="toolbar">
        <div className="search-box"><Search /><input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Name, SKU, barcode or brand" /></div>
        <select className="select" style={{ width: 160 }} value={cat} onChange={(e) => { setCat(e.target.value); setPage(1); }} aria-label="Category"><option value="">All categories</option>{Object.entries(CATEGORY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <div className="chips">{[['', 'All stock'], ['low', 'Low'], ['out', 'Out']].map(([k, l]) => <button key={k} className={`chip ${stock === k ? 'on' : ''}`} onClick={() => { setStock(k); setPage(1); }}>{l}</button>)}</div>
      </div>
      <div className="table-wrap">
        {!data ? <div style={{ padding: 20 }}><Skeleton h={320} /></div> : !data.data.length ? <Empty title="No products" /> : (
          <table className="tbl">
            <thead><tr><th>Product</th><th>Category</th><th className="r">Price</th><th className="r hide-sm">Margin</th><th>Stock</th><th className="r hide-sm">Sold 30d</th><th className="hide-sm">Supplier</th></tr></thead>
            <tbody>{data.data.map((p) => (
              <tr key={p.id} className="clickable" onClick={() => onOpen(p.id)} style={{ opacity: p.is_active ? 1 : 0.5 }}>
                <td><b>{p.name}</b><div className="faint" style={{ fontSize: 12 }}>{p.sku}{p.is_active ? '' : ' · not for sale'}</div></td>
                <td><span className="badge neutral">{CATEGORY_LABEL[p.category]}</span></td>
                <td className="r amount">{money(p.selling_price)}</td>
                <td className="r num muted hide-sm">{p.selling_price ? Math.round(((p.selling_price - p.cost_price) / p.selling_price) * 100) : 0}%</td>
                <td><StockPill p={p} />{p.track_stock && p.branches.length > 1 && <div className="branch-stock" style={{ marginTop: 2 }}>{p.branches.map((b: any) => <span key={b.branch_id}>{b.branch_name.split(' ')[0]} <b>{b.quantity}</b></span>)}</div>}</td>
                <td className="r num hide-sm">{p.sold_30d}</td>
                <td className="muted hide-sm">{p.supplier_name ?? '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {data && <Pagination page={data.pagination.page} totalPages={data.pagination.totalPages} total={data.pagination.total} onPage={setPage} />}
    </section>
  );
}

function Movements() {
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const { data } = useQuery({ queryKey: ['inventory', 'movements', type, page], queryFn: () => api.get<Paged<any>>('/inventory/movements', { type: type || undefined, page, pageSize: 30 }) });
  return (
    <section className="card">
      <div className="toolbar"><div className="chips">{[['', 'All'], ...Object.entries(MOVEMENT_LABEL)].map(([k, l]) => <button key={k} className={`chip ${type === k ? 'on' : ''}`} onClick={() => { setType(k); setPage(1); }}>{l}</button>)}</div></div>
      <div className="table-wrap">
        {!data ? <div style={{ padding: 20 }}><Skeleton h={320} /></div> : !data.data.length ? <Empty title="No movements" /> : (
          <table className="tbl">
            <thead><tr><th>When</th><th>Product</th><th>Type</th><th className="r">Qty</th><th className="r">Balance</th><th className="hide-sm">Branch</th><th className="hide-sm">Detail</th></tr></thead>
            <tbody>{data.data.map((m) => (
              <tr key={m.id}>
                <td className="muted" style={{ whiteSpace: 'nowrap' }}>{dateTime(m.created_at)}</td>
                <td><b>{m.product_name}</b><div className="faint" style={{ fontSize: 12 }}>{m.sku}</div></td>
                <td>{MOVEMENT_LABEL[m.type]}</td>
                <td className={`r num ${m.quantity > 0 ? 'qty-in' : 'qty-out'}`}>{m.quantity > 0 ? '+' : ''}{m.quantity}</td>
                <td className="r num">{m.balance_after}</td>
                <td className="muted hide-sm">{m.branch_name}{m.transfer_branch_name ? ` ${m.type === 'transfer_in' ? '←' : '→'} ${m.transfer_branch_name}` : ''}</td>
                <td className="muted hide-sm">{m.invoice_number ?? m.supplier_name ?? m.reason ?? '—'} · {m.created_by_name}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {data && <Pagination page={data.pagination.page} totalPages={data.pagination.totalPages} total={data.pagination.total} onPage={setPage} />}
    </section>
  );
}

function SupplierDialog({ supplier, onClose }: { supplier?: any; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: supplier?.name ?? '', contactName: supplier?.contact_name ?? '', phone: supplier?.phone ?? '', email: supplier?.email ?? '', gstin: supplier?.gstin ?? '', notes: supplier?.notes ?? '', isActive: supplier?.is_active ?? true });
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: () => (supplier ? api.put(`/inventory/suppliers/${supplier.id}`, f) : api.post('/inventory/suppliers', f)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['suppliers'] }); onClose(); },
    onError: (e) => setError(errMsg(e)),
  });
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <Dialog open onClose={onClose} title={supplier ? `Edit ${supplier.name}` : 'New supplier'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => { setError(''); save.mutate(); }}>Save</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <div className="form-grid">
          <Field label="Name" className="full"><input className="input" value={f.name} onChange={set('name')} /></Field>
          <Field label="Contact person"><input className="input" value={f.contactName} onChange={set('contactName')} /></Field>
          <Field label="Phone"><input className="input" value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Email"><input className="input" value={f.email} onChange={set('email')} /></Field>
          <Field label="GSTIN"><input className="input" value={f.gstin} onChange={set('gstin')} /></Field>
          <Field label="Notes" className="full"><textarea className="textarea" value={f.notes} onChange={set('notes')} /></Field>
        </div>
        {supplier && <label className="check"><input type="checkbox" checked={f.isActive} onChange={set('isActive')} />Active</label>}
      </div>
    </Dialog>
  );
}

function Suppliers() {
  const { can } = useAuth();
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const { data } = useQuery({ queryKey: ['suppliers'], queryFn: () => api.get<any[]>('/inventory/suppliers') });
  return (
    <section className="card">
      <div className="toolbar"><div style={{ flex: 1 }} />{can('inventory.manage') && <Button variant="primary" icon={<Plus />} onClick={() => setEditing(null)}>New supplier</Button>}</div>
      <div className="table-wrap">
        {!data ? <div style={{ padding: 20 }}><Skeleton h={200} /></div> : !data.length ? <Empty title="No suppliers yet" /> : (
          <table className="tbl">
            <thead><tr><th>Supplier</th><th>Contact</th><th className="r">Products</th><th className="r">Spend · 12 mo</th><th>Last delivery</th>{can('inventory.manage') && <th />}</tr></thead>
            <tbody>{data.map((s) => (
              <tr key={s.id} style={{ opacity: s.is_active ? 1 : 0.5 }}>
                <td><b>{s.name}</b>{s.gstin && <div className="faint" style={{ fontSize: 12 }}>GSTIN {s.gstin}</div>}</td>
                <td className="muted">{[s.contact_name, s.phone, s.email].filter(Boolean).join(' · ') || '—'}</td>
                <td className="r num">{s.products}</td>
                <td className="r amount">{money(s.spend_12m)}</td>
                <td className="muted">{s.last_delivery_at ? relative(s.last_delivery_at) : '—'}</td>
                {can('inventory.manage') && <td><Button size="sm" variant="ghost" icon={<Pencil />} aria-label="Edit" onClick={() => setEditing(s)} /></td>}
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {editing !== undefined && <SupplierDialog supplier={editing ?? undefined} onClose={() => setEditing(undefined)} />}
    </section>
  );
}

function Insights() {
  const { data } = useQuery({ queryKey: ['inventory', 'summary'], queryFn: () => api.get<any>('/inventory/summary') });
  if (!data) return <Skeleton h={300} />;
  const maxRev = Math.max(1, ...data.byCategory.map((c: any) => Number(c.revenue)));
  return (
    <div className="grid g-2">
      <Card title="Category margin · last 30 days" icon={<TrendingUp />} sub="Product revenue against the cost of what was sold">
        {!data.byCategory.length ? <Empty title="No product sales yet" /> : (
          <div className="stack" style={{ gap: 12 }}>{data.byCategory.map((c: any) => (
            <div key={c.category} className="pnl-row">
              <span className="muted">{CATEGORY_LABEL[c.category]}</span>
              <div className="share-bar" title={`${money(c.revenue)} revenue`}><i style={{ width: `${(Number(c.revenue) / maxRev) * 100}%` }} /></div>
              <span className="num" style={{ textAlign: 'right' }}><b>{money(c.revenue)}</b> <span className="faint">{c.revenue > 0 ? Math.round(((c.revenue - c.cost) / c.revenue) * 100) : 0}%</span></span>
            </div>
          ))}</div>
        )}
      </Card>
      <Card title="Best sellers · last 30 days" icon={<Package />}>
        {!data.top.length ? <Empty title="No sales yet" /> : <div className="stack" style={{ gap: 8 }}>{data.top.map((t: any) => (
          <div key={t.id} className="row between"><span>{t.name}</span><span className="faint num">{t.units} sold · <b style={{ color: 'var(--text)' }}>{money(t.revenue)}</b></span></div>
        ))}</div>}
      </Card>
      <Card title="Slow movers" icon={<Warehouse />} sub="In stock but not sold for 60 days — cash sitting on the shelf">
        {!data.slow.length ? <Empty title="Everything is moving" /> : <div className="stack" style={{ gap: 8 }}>{data.slow.map((t: any) => (
          <div key={t.id} className="row between"><span>{t.name}<span className="faint"> · {t.stock} units</span></span><span className="faint num">{money(t.value)} at cost · {t.last_sold_at ? `last sold ${dateShort(t.last_sold_at)}` : 'never sold'}</span></div>
        ))}</div>}
      </Card>
    </div>
  );
}

export function InventoryPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as 'products' | 'movements' | 'suppliers' | 'insights') ?? 'products';
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const { data: sum } = useQuery({ queryKey: ['inventory', 'summary'], queryFn: () => api.get<any>('/inventory/summary') });
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Inventory</h1><div className="sub">Every unit in or out is a ledger entry: deliveries, sales, returns, counts, damage and transfers.</div></div>
        <div className="actions">{can('inventory.manage') && <Button variant="primary" icon={<Plus />} onClick={() => setEditing(null)}>New product</Button>}</div>
      </div>
      <div className="grid g-4">
        <section className="card kpi hero"><div className="label"><Warehouse />Stock value</div><div className="value">{money(sum?.stock_value_cost ?? 0)}</div><div className="compare">at cost · {money(sum?.stock_value_retail ?? 0)} at retail</div></section>
        <section className="card kpi"><div className="label"><Package />Products</div><div className="value">{sum?.products ?? '—'}</div><div className="compare">active in the catalogue</div></section>
        <button className="card kpi" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setParams({ tab: 'products' })}>
          <div className="label"><AlertTriangle />Low stock</div><div className="value" style={{ color: sum?.low ? 'var(--warning)' : undefined }}>{sum?.low ?? '—'}</div><div className="compare">at or below the alert level</div>
        </button>
        <section className="card kpi"><div className="label"><Truck />Out of stock</div><div className="value" style={{ color: sum?.out ? 'var(--danger)' : undefined }}>{sum?.out ?? '—'}</div><div className="compare">can't be sold until received</div></section>
      </div>
      <Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[{ key: 'products', label: 'Products' }, { key: 'movements', label: 'Stock movements' }, { key: 'suppliers', label: 'Suppliers' }, { key: 'insights', label: 'Insights' }]} />
      {tab === 'products' && <Products onOpen={setOpen} />}
      {tab === 'movements' && <Movements />}
      {tab === 'suppliers' && <Suppliers />}
      {tab === 'insights' && <Insights />}
      {open && <ProductDrawer id={open} onClose={() => setOpen(null)} onEdit={(p) => setEditing(p)} />}
      {editing !== undefined && <ProductDialog product={editing ?? undefined} onClose={() => setEditing(undefined)} />}
    </div>
  );
}
