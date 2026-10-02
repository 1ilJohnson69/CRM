import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, Copy, Dumbbell, Plus, Search, Trash2, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced, useToast } from '../../lib/ui';
import { date, relative } from '../../lib/format';
import { Alert, Button, Card, Dialog, Empty, Field, Skeleton } from '../../components/ui';
import { CATEGORY_LABEL, LEVEL_LABEL, PLAN_STATUS_TONE } from './common';

interface ExRow { exerciseId: string; name: string; meta: string; sets: number; reps: string; weight: string; restSeconds: number | ''; notes: string }
interface DayRow { id?: string; name: string; focus: string; exercises: ExRow[] }

export function ExercisePicker({ onPick, onClose }: { onPick: (e: any) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const term = useDebounced(q.trim(), 150);
  const { data } = useQuery({ queryKey: ['exercises', term, cat], queryFn: () => api.get<any[]>('/fitness/exercises', { search: term || undefined, category: cat || undefined }) });
  return (
    <Dialog open onClose={onClose} title="Add exercise">
      <div className="stack">
        <div className="search-box" style={{ width: '100%' }}><Search /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Squat, chest, dumbbell…" style={{ paddingRight: 12 }} /></div>
        <div className="chips">
          <button className={`chip ${!cat ? 'on' : ''}`} onClick={() => setCat('')}>All</button>
          {Object.entries(CATEGORY_LABEL).map(([k, l]) => <button key={k} className={`chip ${cat === k ? 'on' : ''}`} onClick={() => setCat(k)}>{l}</button>)}
        </div>
        <div className="stack" style={{ gap: 2, maxHeight: 420, overflowY: 'auto' }}>
          {data?.map((e) => (
            <button key={e.id} className="search-item" onClick={() => onPick(e)}>
              <span className="fu-ic"><Dumbbell /></span>
              <span style={{ flex: 1 }}><div className="t">{e.name}</div><div className="s">{CATEGORY_LABEL[e.category]} · {e.muscle_group ?? '—'} · {e.equipment ?? '—'}</div></span>
            </button>
          ))}
          {data && !data.length && <Empty title="No exercises match" />}
        </div>
      </div>
    </Dialog>
  );
}

function toRows(plan: any): DayRow[] {
  return plan.days.map((d: any) => ({
    id: d.id, name: d.name, focus: d.focus ?? '',
    exercises: d.exercises.map((e: any) => ({ exerciseId: e.exercise_id, name: e.exercise_name, meta: `${e.muscle_group ?? ''} · ${e.equipment ?? ''}`, sets: e.sets, reps: e.reps, weight: e.weight ?? '', restSeconds: e.rest_seconds ?? '', notes: e.notes ?? '' })),
  }));
}

export function WorkoutEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const canEdit = can('workouts.manage');
  const { data: plan, error } = useQuery({ queryKey: ['workout-plan', id], queryFn: () => api.get<any>(`/fitness/workout-plans/${id}`) });
  const { data: staff } = useQuery({ queryKey: ['appt-staff'], queryFn: () => api.get<any[]>('/appointments/staff') });
  const [head, setHead] = useState<any>(null);
  const [days, setDays] = useState<DayRow[]>([]);
  const [picker, setPicker] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState('');
  const [templateName, setTemplateName] = useState<string | null>(null);

  useEffect(() => {
    if (!plan) return;
    setHead({ name: plan.name, goal: plan.goal ?? '', level: plan.level ?? '', durationWeeks: plan.duration_weeks ?? '', trainerId: plan.trainer_id ?? '', startsOn: plan.starts_on ?? '', endsOn: plan.ends_on ?? '', notes: plan.notes ?? '' });
    setDays(toRows(plan));
    setDirty(false);
  }, [plan]);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const editDays = (fn: (d: DayRow[]) => DayRow[]) => { setDays((d) => fn(structuredClone(d))); setDirty(true); };
  const save = useMutation({
    mutationFn: () => api.put(`/fitness/workout-plans/${id}`, {
      name: head.name, goal: head.goal || null, level: head.level || null, durationWeeks: head.durationWeeks === '' ? null : Number(head.durationWeeks),
      daysPerWeek: days.length, trainerId: head.trainerId || null, startsOn: head.startsOn || null, endsOn: head.endsOn || null, notes: head.notes || null,
      days: days.map((d) => ({ id: d.id ?? null, name: d.name, focus: d.focus || null, exercises: d.exercises.map((e) => ({ exerciseId: e.exerciseId, sets: e.sets, reps: e.reps, weight: e.weight || null, restSeconds: e.restSeconds === '' ? null : Number(e.restSeconds), notes: e.notes || null })) })),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['workout-plan', id] }); qc.invalidateQueries({ queryKey: ['workout'] }); setDirty(false); toast('success', plan?.member_id ? 'Plan saved · member notified' : 'Template saved'); },
    onError: (e) => setErr(e instanceof ApiError ? (Array.isArray(e.details) ? `${(e.details as any)[0].path}: ${(e.details as any)[0].message}` : e.message) : 'Failed'),
  });
  const asTemplate = useMutation({
    mutationFn: (name: string) => api.post<{ id: string }>(`/fitness/workout-plans/${id}/save-as-template`, { name }),
    onSuccess: (r) => { toast('success', 'Saved as template'); setTemplateName(null); navigate(`/workouts/plans/${r.id}`); },
  });
  const setStatus = useMutation({ mutationFn: (status: string) => api.post(`/fitness/workout-plans/${id}/status`, { status }), onSuccess: () => qc.invalidateQueries() });

  const adherence = useMemo(() => {
    if (!plan?.logs || !plan.days_per_week) return null;
    const recent = plan.logs.filter((l: any) => Date.parse(l.performed_on) > Date.now() - 28 * 86400_000).length;
    return { recent, pct: Math.min(100, Math.round((recent / (plan.days_per_week * 4)) * 100)) };
  }, [plan]);

  if (error) return <div className="page"><Empty title="Plan not found" /></div>;
  if (!plan || !head) return <div className="page"><Skeleton h={500} /></div>;
  const closed = !plan.is_template && ['completed', 'archived'].includes(plan.status);
  const editable = canEdit && !closed;

  return (
    <div className="page">
      <div className="row between wrap">
        <Link to={plan.member_id ? `/members/${plan.member_id}?tab=workout` : '/workouts?tab=templates'} className="btn ghost sm"><ArrowLeft />{plan.member_id ? plan.member_name : 'Templates'}</Link>
        <div className="row">
          {!plan.is_template && <span className={`badge ${PLAN_STATUS_TONE[plan.status]}`}>{plan.status}</span>}
          {plan.template_name && <span className="faint" style={{ fontSize: 12 }}>from “{plan.template_name}”</span>}
          {canEdit && <Button size="sm" icon={<Copy />} onClick={() => setTemplateName(`${plan.name} (template)`)}>Save as template</Button>}
          {canEdit && !plan.is_template && plan.status === 'active' && <Button size="sm" onClick={() => setStatus.mutate('completed')}>Mark completed</Button>}
        </div>
      </div>
      {closed && <Alert tone="info">This plan is {plan.status}. To change a member's programme, assign a new plan.</Alert>}
      <Card>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
          <Field label="Plan name" className="full"><input className="input" disabled={!editable} value={head.name} onChange={(e) => { setHead({ ...head, name: e.target.value }); setDirty(true); }} /></Field>
          <Field label="Goal"><input className="input" disabled={!editable} value={head.goal} onChange={(e) => { setHead({ ...head, goal: e.target.value }); setDirty(true); }} /></Field>
          <Field label="Level"><select className="select" disabled={!editable} value={head.level} onChange={(e) => { setHead({ ...head, level: e.target.value }); setDirty(true); }}><option value="">—</option>{Object.entries(LEVEL_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Weeks"><input className="input num" type="number" min={1} max={52} disabled={!editable} value={head.durationWeeks} onChange={(e) => { setHead({ ...head, durationWeeks: e.target.value }); setDirty(true); }} /></Field>
          <Field label="Trainer"><select className="select" disabled={!editable} value={head.trainerId} onChange={(e) => { setHead({ ...head, trainerId: e.target.value }); setDirty(true); }}><option value="">—</option>{staff?.filter((s) => s.role_key === 'trainer').map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}</select></Field>
          {!plan.is_template && <Field label="Starts"><input className="input" type="date" disabled={!editable} value={head.startsOn} onChange={(e) => { setHead({ ...head, startsOn: e.target.value }); setDirty(true); }} /></Field>}
          {!plan.is_template && <Field label="Ends"><input className="input" type="date" disabled={!editable} value={head.endsOn} onChange={(e) => { setHead({ ...head, endsOn: e.target.value }); setDirty(true); }} /></Field>}
          <Field label="Coaching notes" className="full"><textarea className="textarea" style={{ minHeight: 56 }} disabled={!editable} value={head.notes} onChange={(e) => { setHead({ ...head, notes: e.target.value }); setDirty(true); }} placeholder="Progression rules, cues, warm-up…" /></Field>
        </div>
      </Card>
      {adherence && (
        <div className="grid g-3">
          <div className="summary-box"><span className="faint" style={{ fontSize: 11, fontWeight: 700 }}>SESSIONS · LAST 4 WEEKS</span><b className="num" style={{ fontSize: 20 }}>{adherence.recent} <span className="faint" style={{ fontSize: 13 }}>of {plan.days_per_week * 4} planned</span></b><div className="bar-track"><div style={{ width: `${adherence.pct}%` }} /></div></div>
          <div className="summary-box"><span className="faint" style={{ fontSize: 11, fontWeight: 700 }}>LAST LOGGED</span><b>{plan.logs[0] ? relative(plan.logs[0].performed_on) : 'Never'}</b><span className="muted" style={{ fontSize: 12 }}>{plan.logs[0]?.day_name ?? ''}</span></div>
          <div className="summary-box"><span className="faint" style={{ fontSize: 11, fontWeight: 700 }}>RUNS</span><b>{date(plan.starts_on)} – {date(plan.ends_on)}</b><span className="muted" style={{ fontSize: 12 }}>{plan.duration_weeks ?? '—'} weeks</span></div>
        </div>
      )}
      {err && <Alert>{err}</Alert>}
      {days.map((d, di) => (
        <section key={di} className="editor-day">
          <header>
            <span className="badge accent">Day {di + 1}</span>
            <input className="input" style={{ width: 200 }} disabled={!editable} value={d.name} onChange={(e) => editDays((x) => { x[di].name = e.target.value; return x; })} aria-label="Day name" />
            <input className="input" style={{ width: 220 }} disabled={!editable} value={d.focus} placeholder="Focus (e.g. Push)" onChange={(e) => editDays((x) => { x[di].focus = e.target.value; return x; })} aria-label="Focus" />
            <div style={{ flex: 1 }} />
            {editable && days.length > 1 && <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => editDays((x) => x.filter((_, i) => i !== di))}>Remove day</Button>}
          </header>
          {d.exercises.length > 0 && <div className="ex-row head"><span>#</span><span>Exercise</span><span>Sets</span><span>Reps</span><span>Weight</span><span>Rest (s)</span><span>Notes</span><span /></div>}
          {d.exercises.map((e, ei) => (
            <div key={ei} className="ex-row">
              <span className="faint num">{ei + 1}</span>
              <div className="ex-name">{e.name}<small>{e.meta}</small></div>
              <input className="input num" type="number" min={1} max={20} disabled={!editable} value={e.sets} onChange={(ev) => editDays((x) => { x[di].exercises[ei].sets = Number(ev.target.value); return x; })} aria-label="Sets" />
              <input className="input" disabled={!editable} value={e.reps} onChange={(ev) => editDays((x) => { x[di].exercises[ei].reps = ev.target.value; return x; })} aria-label="Reps" />
              <input className="input" disabled={!editable} value={e.weight} placeholder="—" onChange={(ev) => editDays((x) => { x[di].exercises[ei].weight = ev.target.value; return x; })} aria-label="Weight" />
              <input className="input num" type="number" min={0} max={900} step={15} disabled={!editable} value={e.restSeconds} onChange={(ev) => editDays((x) => { x[di].exercises[ei].restSeconds = ev.target.value === '' ? '' : Number(ev.target.value); return x; })} aria-label="Rest seconds" />
              <input className="input" disabled={!editable} value={e.notes} placeholder="Cue…" onChange={(ev) => editDays((x) => { x[di].exercises[ei].notes = ev.target.value; return x; })} aria-label="Notes" />
              {editable ? (
                <div className="row" style={{ gap: 2 }}>
                  <Button size="sm" variant="ghost" icon={<ArrowUp />} aria-label="Move up" disabled={ei === 0} onClick={() => editDays((x) => { const l = x[di].exercises; [l[ei - 1], l[ei]] = [l[ei], l[ei - 1]]; return x; })} />
                  <Button size="sm" variant="ghost" icon={<ArrowDown />} aria-label="Move down" disabled={ei === d.exercises.length - 1} onClick={() => editDays((x) => { const l = x[di].exercises; [l[ei + 1], l[ei]] = [l[ei], l[ei + 1]]; return x; })} />
                  <Button size="sm" variant="ghost" icon={<X />} aria-label="Remove" onClick={() => editDays((x) => { x[di].exercises.splice(ei, 1); return x; })} />
                </div>
              ) : <span />}
            </div>
          ))}
          {!d.exercises.length && <div className="faint" style={{ padding: '14px' }}>No exercises yet.</div>}
          {editable && <div style={{ padding: '10px 14px' }}><Button size="sm" icon={<Plus />} onClick={() => setPicker(di)}>Add exercise</Button></div>}
        </section>
      ))}
      {editable && days.length < 7 && <div><Button icon={<Plus />} onClick={() => editDays((x) => [...x, { name: `Day ${x.length + 1}`, focus: '', exercises: [] }])}>Add day</Button></div>}
      {plan.logs && (
        <Card title="Workout log" icon={<Dumbbell />} sub="Logged by the member in the app, or by a trainer" bodyClass="">
          {!plan.logs.length ? <Empty title="No sessions logged yet" /> : (
            <div className="table-wrap" style={{ marginTop: 6 }}><table className="tbl"><tbody>{plan.logs.map((l: any) => (
              <tr key={l.id}><td style={{ whiteSpace: 'nowrap' }}>{date(l.performed_on)}</td><td style={{ fontWeight: 700 }}>{l.day_name ?? '—'}</td><td className="muted num">{l.duration_min ? `${l.duration_min} min` : ''}{l.rpe ? ` · RPE ${l.rpe}` : ''}</td>
                <td className="muted">{l.entries?.length ? l.entries.map((e: any) => `${e.exercise} ${e.sets.map((s: any) => `${s.reps}${s.weightKg ? `×${s.weightKg}` : ''}`).join('/')}`).join(' · ') : l.notes ?? ''}</td>
                <td className="faint">{l.source === 'app' ? 'App' : l.logged_by_name}</td></tr>
            ))}</tbody></table></div>
          )}
        </Card>
      )}
      {editable && dirty && (
        <div className="sticky-save">
          <span className="muted" style={{ alignSelf: 'center', marginRight: 'auto' }}>Unsaved changes</span>
          <Button onClick={() => { setDays(toRows(plan)); setDirty(false); }}>Discard</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => { setErr(''); save.mutate(); }}>Save plan</Button>
        </div>
      )}
      {picker !== null && <ExercisePicker onClose={() => setPicker(null)} onPick={(e) => { editDays((x) => { x[picker].exercises.push({ exerciseId: e.id, name: e.name, meta: `${e.muscle_group ?? ''} · ${e.equipment ?? ''}`, sets: 3, reps: e.category === 'cardio' ? '10 min' : '10', weight: '', restSeconds: e.category === 'strength' ? 90 : 45, notes: '' }); return x; }); setPicker(null); }} />}
      {templateName !== null && (
        <Dialog open onClose={() => setTemplateName(null)} title="Save as template" footer={<><Button onClick={() => setTemplateName(null)}>Cancel</Button><Button variant="primary" loading={asTemplate.isPending} onClick={() => asTemplate.mutate(templateName)}>Save</Button></>}>
          <Field label="Template name"><input className="input" autoFocus value={templateName} onChange={(e) => setTemplateName(e.target.value)} /></Field>
        </Dialog>
      )}
    </div>
  );
}
