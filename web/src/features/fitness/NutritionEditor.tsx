import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Copy, Plus, Trash2, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/ui';
import { Alert, Button, Card, Dialog, Empty, Field, Skeleton } from '../../components/ui';
import { DIET_LABEL, PLAN_STATUS_TONE } from './common';

interface Item { food: string; quantity: string; calories: number | ''; proteinG: number | ''; carbsG: number | ''; fatG: number | '' }
interface Meal { name: string; time: string; notes: string; items: Item[] }

const num = (v: number | '' | null | undefined) => (v === '' || v == null ? 0 : Number(v));
export const MACRO_COLORS = { protein: 'var(--series-1)', carbs: 'var(--series-2)', fat: 'var(--series-3)' };

export function sumItems(items: { calories?: any; proteinG?: any; carbsG?: any; fatG?: any; protein_g?: any; carbs_g?: any; fat_g?: any }[]) {
  return items.reduce<{ calories: number; protein: number; carbs: number; fat: number }>(
    (s, i) => ({
      calories: s.calories + num(i.calories),
      protein: s.protein + num(i.proteinG ?? i.protein_g),
      carbs: s.carbs + num(i.carbsG ?? i.carbs_g),
      fat: s.fat + num(i.fatG ?? i.fat_g),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
}

/** Share of energy from each macro (4/4/9 kcal per gram). */
export function MacroSplit({ protein, carbs, fat }: { protein: number; carbs: number; fat: number }) {
  const kcal = protein * 4 + carbs * 4 + fat * 9 || 1;
  const parts = [
    { k: 'Protein', g: protein, pct: (protein * 4) / kcal, c: MACRO_COLORS.protein },
    { k: 'Carbs', g: carbs, pct: (carbs * 4) / kcal, c: MACRO_COLORS.carbs },
    { k: 'Fat', g: fat, pct: (fat * 9) / kcal, c: MACRO_COLORS.fat },
  ];
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="macro-bar" role="img" aria-label={parts.map((p) => `${p.k} ${Math.round(p.pct * 100)}%`).join(', ')}>
        {parts.map((p) => <i key={p.k} style={{ width: `${p.pct * 100}%`, background: p.c }} />)}
      </div>
      <div className="legend">{parts.map((p) => <span key={p.k}><i style={{ background: p.c }} />{p.k} <b className="num" style={{ color: 'var(--text)' }}>{Math.round(p.g)} g</b> <span className="faint">{Math.round(p.pct * 100)}%</span></span>)}</div>
    </div>
  );
}

export function TargetRow({ label, actual, target, unit }: { label: string; actual: number; target: number | null | undefined; unit: string }) {
  const pct = target ? actual / target : 0;
  const off = target ? Math.abs(1 - pct) : 0;
  const color = !target ? 'var(--text-3)' : off <= 0.1 ? 'var(--success)' : off <= 0.2 ? 'var(--warning)' : 'var(--danger)';
  return (
    <div className="target-row">
      <span className="muted">{label}</span>
      <div className="track"><div style={{ width: `${Math.min(100, pct * 100)}%`, background: color }} /></div>
      <span className="num" style={{ textAlign: 'right' }}><b>{Math.round(actual)}</b><span className="faint"> / {target ?? '—'} {unit}</span></span>
    </div>
  );
}

const tags = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

export function NutritionEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const { data: plan, error } = useQuery({ queryKey: ['nutrition-plan', id], queryFn: () => api.get<any>(`/fitness/nutrition-plans/${id}`) });
  const { data: staff } = useQuery({ queryKey: ['appt-staff'], queryFn: () => api.get<any[]>('/appointments/staff') });
  const [head, setHead] = useState<any>(null);
  const [meals, setMeals] = useState<Meal[]>([]);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState('');
  const [templateName, setTemplateName] = useState<string | null>(null);

  const load = (p: any) => {
    setHead({
      name: p.name, goal: p.goal ?? '', calorieTarget: p.calorie_target ?? '', proteinG: p.protein_g ?? '', carbsG: p.carbs_g ?? '', fatG: p.fat_g ?? '', waterL: p.water_l ?? '',
      dietType: p.diet_type ?? '', restrictions: p.restrictions.join(', '), recommendations: p.recommendations.join(', '), avoid: p.avoid.join(', '), notes: p.notes ?? '',
      nutritionistId: p.nutritionist_id ?? '', startsOn: p.starts_on ?? '', endsOn: p.ends_on ?? '',
    });
    setMeals(p.meals.map((m: any) => ({ name: m.name, time: m.time ?? '', notes: m.notes ?? '', items: m.items.map((i: any) => ({ food: i.food, quantity: i.quantity ?? '', calories: i.calories ?? '', proteinG: i.protein_g ?? '', carbsG: i.carbs_g ?? '', fatG: i.fat_g ?? '' })) })));
    setDirty(false);
  };
  useEffect(() => { if (plan) load(plan); }, [plan]);
  const edit = (fn: (m: Meal[]) => Meal[]) => { setMeals((m) => fn(structuredClone(m))); setDirty(true); };
  const setH = (k: string) => (e: { target: { value: string } }) => { setHead({ ...head, [k]: e.target.value }); setDirty(true); };
  const n = (v: any) => (v === '' ? null : Number(v));

  const save = useMutation({
    mutationFn: () => api.put(`/fitness/nutrition-plans/${id}`, {
      name: head.name, goal: head.goal || null, calorieTarget: n(head.calorieTarget), proteinG: n(head.proteinG), carbsG: n(head.carbsG), fatG: n(head.fatG), waterL: n(head.waterL),
      dietType: head.dietType || null, restrictions: tags(head.restrictions), recommendations: tags(head.recommendations), avoid: tags(head.avoid), notes: head.notes || null,
      nutritionistId: head.nutritionistId || null, startsOn: head.startsOn || null, endsOn: head.endsOn || null,
      meals: meals.map((m) => ({ name: m.name, time: m.time || null, notes: m.notes || null, items: m.items.filter((i) => i.food.trim()).map((i) => ({ food: i.food, quantity: i.quantity || null, calories: n(i.calories), proteinG: n(i.proteinG), carbsG: n(i.carbsG), fatG: n(i.fatG) })) })),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['nutrition-plan', id] }); setDirty(false); toast('success', plan?.member_id ? 'Plan saved · member notified' : 'Template saved'); },
    onError: (e) => setErr(e instanceof ApiError ? (Array.isArray(e.details) ? `${(e.details as any)[0].path}: ${(e.details as any)[0].message}` : e.message) : 'Failed'),
  });
  const asTemplate = useMutation({
    mutationFn: (name: string) => api.post<{ id: string }>(`/fitness/nutrition-plans/${id}/save-as-template`, { name }),
    onSuccess: (r) => { toast('success', 'Saved as template'); setTemplateName(null); navigate(`/nutrition/plans/${r.id}`); },
  });

  if (error) return <div className="page"><Empty title="Plan not found" /></div>;
  if (!plan || !head) return <div className="page"><Skeleton h={500} /></div>;
  const closed = !plan.is_template && ['completed', 'archived'].includes(plan.status);
  const editable = can('nutrition.manage') && !closed;
  const total = sumItems(meals.flatMap((m) => m.items));

  return (
    <div className="page">
      <div className="row between wrap">
        <Link to={plan.member_id ? `/members/${plan.member_id}?tab=nutrition` : '/nutrition?tab=templates'} className="btn ghost sm"><ArrowLeft />{plan.member_id ? plan.member_name : 'Templates'}</Link>
        <div className="row">
          {!plan.is_template && <span className={`badge ${PLAN_STATUS_TONE[plan.status]}`}>{plan.status}</span>}
          {plan.template_name && <span className="faint" style={{ fontSize: 12 }}>from “{plan.template_name}”</span>}
          {can('nutrition.manage') && <Button size="sm" icon={<Copy />} onClick={() => setTemplateName(`${plan.name} (template)`)}>Save as template</Button>}
        </div>
      </div>
      {closed && <Alert tone="info">This plan is {plan.status}. Assign a new one to make changes.</Alert>}
      <div className="grid g-dash-1">
        <Card>
          <div className="form-grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
            <Field label="Plan name" className="full"><input className="input" disabled={!editable} value={head.name} onChange={setH('name')} /></Field>
            <Field label="Goal"><input className="input" disabled={!editable} value={head.goal} onChange={setH('goal')} /></Field>
            <Field label="Diet"><select className="select" disabled={!editable} value={head.dietType} onChange={setH('dietType')}><option value="">—</option>{Object.entries(DIET_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="Nutritionist"><select className="select" disabled={!editable} value={head.nutritionistId} onChange={setH('nutritionistId')}><option value="">—</option>{staff?.filter((s) => s.role_key === 'nutritionist').map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}</select></Field>
            <Field label="Water (L/day)"><input className="input num" type="number" step="0.5" disabled={!editable} value={head.waterL} onChange={setH('waterL')} /></Field>
            <Field label="Calories"><input className="input num" type="number" disabled={!editable} value={head.calorieTarget} onChange={setH('calorieTarget')} /></Field>
            <Field label="Protein (g)"><input className="input num" type="number" disabled={!editable} value={head.proteinG} onChange={setH('proteinG')} /></Field>
            <Field label="Carbs (g)"><input className="input num" type="number" disabled={!editable} value={head.carbsG} onChange={setH('carbsG')} /></Field>
            <Field label="Fat (g)"><input className="input num" type="number" disabled={!editable} value={head.fatG} onChange={setH('fatG')} /></Field>
            <Field label="Recommendations" hint="Comma separated" className="full"><input className="input" disabled={!editable} value={head.recommendations} onChange={setH('recommendations')} /></Field>
            <Field label="Avoid" hint="Comma separated" className="full"><input className="input" disabled={!editable} value={head.avoid} onChange={setH('avoid')} /></Field>
            <Field label="Restrictions / allergies" hint="Comma separated" className="full"><input className="input" disabled={!editable} value={head.restrictions} onChange={setH('restrictions')} placeholder="e.g. Lactose intolerant, no peanuts" /></Field>
          </div>
        </Card>
        <Card title="Daily total vs target" sub="Updates as you edit">
          <div className="stack" style={{ gap: 10 }}>
            <TargetRow label="Calories" actual={total.calories} target={n(head.calorieTarget)} unit="kcal" />
            <TargetRow label="Protein" actual={total.protein} target={n(head.proteinG)} unit="g" />
            <TargetRow label="Carbs" actual={total.carbs} target={n(head.carbsG)} unit="g" />
            <TargetRow label="Fat" actual={total.fat} target={n(head.fatG)} unit="g" />
            <div className="section-label">Energy split</div>
            <MacroSplit protein={total.protein} carbs={total.carbs} fat={total.fat} />
            <div className="faint" style={{ fontSize: 12 }}>Green within 10% of target, amber within 20%.</div>
          </div>
        </Card>
      </div>
      {err && <Alert>{err}</Alert>}
      {meals.map((m, mi) => {
        const t = sumItems(m.items);
        return (
          <section key={mi} className="editor-day">
            <header>
              <input className="input" style={{ width: 180 }} disabled={!editable} value={m.name} onChange={(e) => edit((x) => { x[mi].name = e.target.value; return x; })} aria-label="Meal name" />
              <input className="input" style={{ width: 100 }} disabled={!editable} value={m.time} placeholder="08:00" onChange={(e) => edit((x) => { x[mi].time = e.target.value; return x; })} aria-label="Time" />
              <span className="faint num" style={{ fontSize: 12.5 }}>{Math.round(t.calories)} kcal · P {Math.round(t.protein)} · C {Math.round(t.carbs)} · F {Math.round(t.fat)}</span>
              <div style={{ flex: 1 }} />
              {editable && <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => edit((x) => x.filter((_, i) => i !== mi))}>Remove meal</Button>}
            </header>
            {m.items.length > 0 && <div className="item-row head"><span>Food</span><span>Quantity</span><span>kcal</span><span>P (g)</span><span>C (g)</span><span>F (g)</span><span /></div>}
            {m.items.map((it, ii) => (
              <div key={ii} className="item-row">
                {(['food', 'quantity', 'calories', 'proteinG', 'carbsG', 'fatG'] as const).map((k) => (
                  <input key={k} className={`input ${k === 'food' || k === 'quantity' ? '' : 'num'}`} type={k === 'food' || k === 'quantity' ? 'text' : 'number'} step="0.1" disabled={!editable}
                    value={it[k]} aria-label={k} onChange={(e) => edit((x) => { (x[mi].items[ii] as any)[k] = k === 'food' || k === 'quantity' ? e.target.value : e.target.value === '' ? '' : Number(e.target.value); return x; })} />
                ))}
                {editable ? <Button size="sm" variant="ghost" icon={<X />} aria-label="Remove item" onClick={() => edit((x) => { x[mi].items.splice(ii, 1); return x; })} /> : <span />}
              </div>
            ))}
            {editable && <div style={{ padding: '10px 14px' }}><Button size="sm" icon={<Plus />} onClick={() => edit((x) => { x[mi].items.push({ food: '', quantity: '', calories: '', proteinG: '', carbsG: '', fatG: '' }); return x; })}>Add food</Button></div>}
          </section>
        );
      })}
      {editable && <div><Button icon={<Plus />} onClick={() => edit((x) => [...x, { name: `Meal ${x.length + 1}`, time: '', notes: '', items: [] }])}>Add meal</Button></div>}
      {editable && dirty && (
        <div className="sticky-save">
          <span className="muted" style={{ alignSelf: 'center', marginRight: 'auto' }}>Unsaved changes · {Math.round(total.calories)} kcal</span>
          <Button onClick={() => load(plan)}>Discard</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => { setErr(''); save.mutate(); }}>Save plan</Button>
        </div>
      )}
      {templateName !== null && (
        <Dialog open onClose={() => setTemplateName(null)} title="Save as template" footer={<><Button onClick={() => setTemplateName(null)}>Cancel</Button><Button variant="primary" loading={asTemplate.isPending} onClick={() => asTemplate.mutate(templateName)}>Save</Button></>}>
          <Field label="Template name"><input className="input" autoFocus value={templateName} onChange={(e) => setTemplateName(e.target.value)} /></Field>
        </Dialog>
      )}
    </div>
  );
}
