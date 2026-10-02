import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Apple, ClipboardList, Dumbbell, Pencil, Plus, Search, Users } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced, useToast } from '../../lib/ui';
import { date, relative, today } from '../../lib/format';
import { Alert, Button, Card, Dialog, Empty, Field, Person, Skeleton, Tabs } from '../../components/ui';
import { AssessmentDialog, AssignPlanDialog, CATEGORY_LABEL, DIET_LABEL, GOAL_LABEL, LEVEL_LABEL, PLAN_STATUS_TONE } from './common';

function Overview({ kind }: { kind: 'workout' | 'nutrition' | 'assessment' }) {
  const { me } = useAuth();
  const [mine, setMine] = useState(me?.role_key === 'trainer' || me?.role_key === 'nutritionist');
  const [assign, setAssign] = useState<{ memberId: string; memberName: string } | null>(null);
  const [assess, setAssess] = useState<{ memberId: string; memberName: string } | null>(null);
  const { data } = useQuery({ queryKey: ['fitness-overview', mine], queryFn: () => api.get<any>('/fitness/overview', { mine: mine || undefined }) });
  if (!data) return <Skeleton h={200} />;
  return (
    <div className="stack">
      <div className="row between wrap">
        <div className="chips"><button className={`chip ${!mine ? 'on' : ''}`} onClick={() => setMine(false)}>Whole branch</button><button className={`chip ${mine ? 'on' : ''}`} onClick={() => setMine(true)}>My clients</button></div>
      </div>
      <div className="grid g-4">
        <section className="card kpi hero"><div className="label">Active members</div><div className="value">{data.active_members}</div><div className="compare">{mine ? 'assigned to you' : 'in scope'}</div></section>
        <section className="card kpi"><div className="label">On a workout plan</div><div className="value">{data.with_workout}</div><div className="compare">{data.active_members ? Math.round((data.with_workout / data.active_members) * 100) : 0}% coverage · {data.adherence}% sessions logged</div></section>
        <section className="card kpi"><div className="label">On a nutrition plan</div><div className="value">{data.with_nutrition}</div><div className="compare">{data.active_members ? Math.round((data.with_nutrition / data.active_members) * 100) : 0}% coverage</div></section>
        <section className="card kpi"><div className="label">Assessments due</div><div className="value" style={{ color: data.assessments_due ? 'var(--warning)' : undefined }}>{data.assessments_due}</div><div className="compare">none in the last interval</div></section>
      </div>
      <div className="grid g-2">
        {kind !== 'assessment' ? (
          <Card title="Active members without a workout plan" icon={<Users />} sub="Most frequent visitors first — they’ll benefit most">
            {!data.needsPlan.length ? <Empty title="Everyone has a plan" /> : (
              <div className="stack" style={{ gap: 6 }}>{data.needsPlan.map((m: any) => (
                <div key={m.id} className="fu-row">
                  <div style={{ flex: 1, minWidth: 0 }}><Link to={`/members/${m.id}?tab=workout`}><Person name={m.full_name} detail={`${m.visits_30d} visits / 30d · ${m.primary_goal ? GOAL_LABEL[m.primary_goal] : 'no goal set'}`} size="sm" /></Link></div>
                  <Button size="sm" onClick={() => setAssign({ memberId: m.id, memberName: m.full_name })}>Assign</Button>
                </div>
              ))}</div>
            )}
          </Card>
        ) : null}
        <Card title="Assessments due" icon={<ClipboardList />} sub="No assessment within the gym’s re-test interval">
          {!data.assessmentsDue.length ? <Empty title="All caught up" /> : (
            <div className="stack" style={{ gap: 6 }}>{data.assessmentsDue.map((m: any) => (
              <div key={m.id} className="fu-row">
                <div style={{ flex: 1, minWidth: 0 }}><Link to={`/members/${m.id}?tab=fitness`}><Person name={m.full_name} detail={m.assessed_on ? `Last ${relative(m.assessed_on)}` : 'Never assessed'} size="sm" /></Link></div>
                <Button size="sm" onClick={() => setAssess({ memberId: m.id, memberName: m.full_name })}>Record</Button>
              </div>
            ))}</div>
          )}
        </Card>
        {kind !== 'assessment' && data.endingSoon.length > 0 && (
          <Card title="Plans ending or overdue" icon={<Activity />} sub="Renew or replace before members lose their programme">
            <div className="stack" style={{ gap: 6 }}>{data.endingSoon.map((p: any) => (
              <Link key={p.id} to={`/workouts/plans/${p.id}`} className="fu-row"><div style={{ flex: 1 }}><b>{p.full_name}</b><div className="faint" style={{ fontSize: 12 }}>{p.name}</div></div>{p.ends_on < today() ? <span className="badge danger">Ended {date(p.ends_on)}</span> : <span className="badge warning">Ends {date(p.ends_on)}</span>}</Link>
            ))}</div>
          </Card>
        )}
      </div>
      {assign && <AssignPlanDialog kind="workout" {...assign} onClose={() => setAssign(null)} />}
      {assess && <AssessmentDialog {...assess} onClose={() => setAssess(null)} />}
    </div>
  );
}

function MemberPlans({ kind }: { kind: 'workout' | 'nutrition' }) {
  const [mine, setMine] = useState(false);
  const [status, setStatus] = useState('active');
  const base = kind === 'workout' ? '/fitness/workout-plans' : '/fitness/nutrition-plans';
  const { data } = useQuery({ queryKey: [kind, 'plans', mine, status], queryFn: () => api.get<any[]>(base, { staffId: mine ? 'me' : undefined, status }) });
  const navigate = useNavigate();
  return (
    <section className="card">
      <div className="toolbar">
        <div className="chips">{['active', 'completed', 'archived'].map((s) => <button key={s} className={`chip ${status === s ? 'on' : ''}`} onClick={() => setStatus(s)} style={{ textTransform: 'capitalize' }}>{s}</button>)}</div>
        <div style={{ flex: 1 }} />
        <button className={`chip ${mine ? 'on' : ''}`} onClick={() => setMine(!mine)}>Mine</button>
      </div>
      <div className="table-wrap">
        {!data ? <div style={{ padding: 20 }}><Skeleton h={300} /></div> : !data.length ? <Empty title="No plans here" /> : (
          <table className="tbl">
            <thead><tr><th>Member</th><th>Plan</th>{kind === 'workout' ? <><th>Days/wk</th><th>Logged 14d</th><th>Last session</th></> : <><th>Calories</th><th>Protein</th><th>Diet</th></>}<th>{kind === 'workout' ? 'Trainer' : 'Nutritionist'}</th><th>Started</th><th>Status</th></tr></thead>
            <tbody>{data.map((p) => (
              <tr key={p.id} className="clickable" onClick={() => navigate(`/${kind === 'workout' ? 'workouts' : 'nutrition'}/plans/${p.id}`)}>
                <td><Person name={p.member_name} detail={p.member_code} size="sm" /></td>
                <td style={{ fontWeight: 700 }}>{p.name}</td>
                {kind === 'workout' ? (
                  <>
                    <td className="num">{p.days_per_week ?? p.day_count}</td>
                    <td className="num">{p.logs_14d} <span className="faint">/ {(p.days_per_week ?? p.day_count) * 2}</span></td>
                    <td className="muted">{p.last_logged_on ? relative(p.last_logged_on) : <span style={{ color: 'var(--warning)' }}>Never</span>}</td>
                  </>
                ) : (
                  <><td className="num">{p.calorie_target ?? '—'}</td><td className="num">{p.protein_g ? `${p.protein_g} g` : '—'}</td><td className="muted">{DIET_LABEL[p.diet_type] ?? '—'}</td></>
                )}
                <td className="muted">{p.staff_name ?? '—'}</td>
                <td className="muted">{date(p.starts_on)}</td>
                <td><span className={`badge ${PLAN_STATUS_TONE[p.status]}`}>{p.status}</span></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function Templates({ kind }: { kind: 'workout' | 'nutrition' }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const base = kind === 'workout' ? '/fitness/workout-plans' : '/fitness/nutrition-plans';
  const [assign, setAssign] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: [kind, 'templates'], queryFn: () => api.get<any[]>(base, { templates: true }) });
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>(base, { plan: kind === 'workout' ? { name: 'New workout template', days: [{ name: 'Day 1', exercises: [] }] } : { name: 'New nutrition template', meals: [{ name: 'Breakfast', time: '08:00', items: [] }] } }),
    onSuccess: (r) => navigate(`/${kind === 'workout' ? 'workouts' : 'nutrition'}/plans/${r.id}`),
    onError: (e) => toast('error', e instanceof ApiError ? e.message : 'Failed'),
  });
  const manage = can(kind === 'workout' ? 'workouts.manage' : 'nutrition.manage');
  return (
    <>
      {manage && <div><Button icon={<Plus />} loading={create.isPending} onClick={() => create.mutate()}>New template</Button></div>}
      <div className="grid g-3">{data?.map((t) => (
        <section key={t.id} className="card card-pad stack" style={{ gap: 8 }}>
          <div className="row between"><b style={{ fontSize: 15 }}>{t.name}</b><Link to={`/${kind === 'workout' ? 'workouts' : 'nutrition'}/plans/${t.id}`} className="btn ghost sm" aria-label="Open"><Pencil /></Link></div>
          <div className="muted" style={{ fontSize: 13 }}>
            {kind === 'workout' ? `${t.goal ?? '—'} · ${LEVEL_LABEL[t.level] ?? '—'} · ${t.day_count} days/week · ${t.duration_weeks ?? '—'} weeks` : `${t.goal ?? '—'} · ${t.calorie_target ?? '—'} kcal · P ${t.protein_g ?? '—'} / C ${t.carbs_g ?? '—'} / F ${t.fat_g ?? '—'} g`}
          </div>
          <div className="row between"><span className="faint" style={{ fontSize: 12 }}>{t.active_assignments} members on it</span>{manage && <Button size="sm" variant="primary" onClick={() => setAssign(t.id)}>Assign</Button>}</div>
        </section>
      ))}</div>
      {assign && <AssignPlanDialog kind={kind} templateId={assign} onClose={() => setAssign(null)} />}
    </>
  );
}

function ExerciseDialog({ exercise, onClose }: { exercise?: any; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: exercise?.name ?? '', category: exercise?.category ?? 'strength', muscleGroup: exercise?.muscle_group ?? '', equipment: exercise?.equipment ?? '', instructions: exercise?.instructions ?? '', videoUrl: exercise?.video_url ?? '', isActive: exercise?.is_active ?? true });
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: () => (exercise ? api.put(`/fitness/exercises/${exercise.id}`, f) : api.post('/fitness/exercises', f)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['exercises'] }); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? (Array.isArray(e.details) ? (e.details as any)[0].message : e.message) : 'Failed'),
  });
  return (
    <Dialog open onClose={onClose} title={exercise ? `Edit ${exercise.name}` : 'New exercise'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <div className="form-grid">
          <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Category"><select className="select" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{Object.entries(CATEGORY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Muscles"><input className="input" value={f.muscleGroup} onChange={(e) => setF({ ...f, muscleGroup: e.target.value })} /></Field>
          <Field label="Equipment"><input className="input" value={f.equipment} onChange={(e) => setF({ ...f, equipment: e.target.value })} /></Field>
          <Field label="How to" className="full"><textarea className="textarea" value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} /></Field>
          <Field label="Demo video (https link)" className="full"><input className="input" value={f.videoUrl} onChange={(e) => setF({ ...f, videoUrl: e.target.value })} placeholder="https://…" /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />Active</label>
      </div>
    </Dialog>
  );
}

function Library() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const term = useDebounced(q.trim());
  const { data } = useQuery({ queryKey: ['exercises', term, cat, 'all'], queryFn: () => api.get<any[]>('/fitness/exercises', { search: term || undefined, category: cat || undefined, all: true }) });
  return (
    <section className="card">
      <div className="toolbar">
        <div className="search-box"><Search /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, muscle or equipment" /></div>
        <div className="chips"><button className={`chip ${!cat ? 'on' : ''}`} onClick={() => setCat('')}>All</button>{Object.entries(CATEGORY_LABEL).map(([k, l]) => <button key={k} className={`chip ${cat === k ? 'on' : ''}`} onClick={() => setCat(k)}>{l}</button>)}</div>
        <div style={{ flex: 1 }} />
        {can('workouts.manage') && <Button variant="primary" icon={<Plus />} onClick={() => setEditing(null)}>New exercise</Button>}
      </div>
      <div className="table-wrap">
        {!data ? <div style={{ padding: 20 }}><Skeleton h={300} /></div> : (
          <table className="tbl">
            <thead><tr><th>Exercise</th><th>Category</th><th>Muscles</th><th>Equipment</th><th className="r">In plans</th>{can('workouts.manage') && <th />}</tr></thead>
            <tbody>{data.map((e) => (
              <tr key={e.id} style={{ opacity: e.is_active ? 1 : 0.5 }}>
                <td><b>{e.name}</b>{e.instructions && <div className="faint" style={{ fontSize: 12, maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.instructions}</div>}</td>
                <td><span className="badge neutral">{CATEGORY_LABEL[e.category]}</span></td><td className="muted">{e.muscle_group}</td><td className="muted">{e.equipment}</td>
                <td className="r num">{e.used_in}</td>
                {can('workouts.manage') && <td><Button size="sm" variant="ghost" icon={<Pencil />} aria-label="Edit" onClick={() => setEditing(e)} /></td>}
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {editing !== undefined && <ExerciseDialog exercise={editing ?? undefined} onClose={() => setEditing(undefined)} />}
    </section>
  );
}

export function WorkoutsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'overview';
  const [assign, setAssign] = useState(false);
  const { can } = useAuth();
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Workouts</h1><div className="sub">Build programmes once as templates, tailor them per member. Members follow and log them in the app.</div></div>
        <div className="actions">{can('workouts.manage') && <Button variant="primary" icon={<Dumbbell />} onClick={() => setAssign(true)}>Assign plan</Button>}</div>
      </div>
      <Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[{ key: 'overview', label: 'Overview' }, { key: 'plans', label: 'Member plans' }, { key: 'templates', label: 'Templates' }, { key: 'library', label: 'Exercise library' }]} />
      {tab === 'overview' && <Overview kind="workout" />}
      {tab === 'plans' && <MemberPlans kind="workout" />}
      {tab === 'templates' && <Templates kind="workout" />}
      {tab === 'library' && <Library />}
      {assign && <AssignPlanDialog kind="workout" onClose={() => setAssign(false)} />}
    </div>
  );
}

export function NutritionPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'plans';
  const [assign, setAssign] = useState(false);
  const { can } = useAuth();
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Nutrition</h1><div className="sub">Meal plans with calorie and macro targets. Members see their plan in the app.</div></div>
        <div className="actions">{can('nutrition.manage') && <Button variant="primary" icon={<Apple />} onClick={() => setAssign(true)}>Assign plan</Button>}</div>
      </div>
      <Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[{ key: 'plans', label: 'Member plans' }, { key: 'templates', label: 'Templates' }]} />
      {tab === 'plans' && <MemberPlans kind="nutrition" />}
      {tab === 'templates' && <Templates kind="nutrition" />}
      {assign && <AssignPlanDialog kind="nutrition" onClose={() => setAssign(false)} />}
    </div>
  );
}

export function AssessmentsPage() {
  const { can } = useAuth();
  const [recording, setRecording] = useState(false);
  const [mine, setMine] = useState(false);
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ['assessments', mine], queryFn: () => api.get<any[]>('/fitness/assessments', { mine: mine || undefined }) });
  const delta = (a: number | null, b: number | null, unit: string, betterDown = true) => {
    if (a == null || b == null) return null;
    const d = Math.round((a - b) * 10) / 10;
    if (!d) return <span className="faint">±0</span>;
    const good = betterDown ? d < 0 : d > 0;
    return <span style={{ color: good ? 'var(--success)' : 'var(--danger)', fontWeight: 700 }}>{d > 0 ? '+' : ''}{d}{unit}</span>;
  };
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Assessments</h1><div className="sub">Body composition, measurements and fitness tests. Every assessment feeds the member’s progress charts.</div></div>
        <div className="actions">{can('assessments.manage') && <Button variant="primary" icon={<Plus />} onClick={() => setRecording(true)}>Record assessment</Button>}</div>
      </div>
      <Overview kind="assessment" />
      <Card title="Recent assessments" icon={<ClipboardList />} bodyClass="" actions={<button className={`chip ${mine ? 'on' : ''}`} onClick={() => setMine(!mine)}>By me</button>}>
        <div className="table-wrap" style={{ marginTop: 6 }}>
          {!data ? <div style={{ padding: 20 }}><Skeleton h={300} /></div> : !data.length ? <Empty title="No assessments yet" /> : (
            <table className="tbl">
              <thead><tr><th>Date</th><th>Member</th><th className="r">Weight</th><th className="r">Change</th><th className="r">Body fat</th><th className="r">Change</th><th className="r">BMI</th><th className="r">Waist</th><th className="hide-sm">By</th></tr></thead>
              <tbody>{data.map((a) => (
                <tr key={a.id} className="clickable" onClick={() => navigate(`/members/${a.member_id}?tab=fitness`)}>
                  <td className="muted">{date(a.assessed_on)}</td>
                  <td><Person name={a.member_name} detail={a.member_code} size="sm" /></td>
                  <td className="r num">{a.weight_kg ? `${a.weight_kg} kg` : '—'}</td>
                  <td className="r num">{delta(a.weight_kg, a.prev_weight_kg, ' kg')}</td>
                  <td className="r num">{a.body_fat_pct ? `${a.body_fat_pct}%` : '—'}</td>
                  <td className="r num">{delta(a.body_fat_pct, a.prev_body_fat_pct, '%')}</td>
                  <td className="r num">{a.bmi ?? '—'}</td>
                  <td className="r num">{a.waist_cm ? `${a.waist_cm} cm` : '—'}</td>
                  <td className="muted hide-sm">{a.assessed_by_name ?? '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </Card>
      {recording && <AssessmentDialog onClose={() => setRecording(false)} />}
    </div>
  );
}
