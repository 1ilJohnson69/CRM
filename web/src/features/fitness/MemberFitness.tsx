import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Apple, Camera, ClipboardList, Dumbbell, Pencil, Plus, Target, Trash2 } from 'lucide-react';
import { api, ApiError, branchScope, session } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/ui';
import { date, relative } from '../../lib/format';
import { Button, Card, Dialog, Empty, Skeleton } from '../../components/ui';
import { MetricLine } from '../../components/charts';
import { AssessmentDialog, AssignPlanDialog, AuthImage, DIET_LABEL, FitnessProfileDialog, GOAL_LABEL, LEVEL_LABEL } from './common';
import { MacroSplit, TargetRow } from './NutritionEditor';

const TILES: [string, string, string, boolean][] = [
  ['weight_kg', 'Weight', ' kg', true], ['body_fat_pct', 'Body fat', '%', true], ['bmi', 'BMI', '', true],
  ['muscle_mass_kg', 'Muscle', ' kg', false], ['waist_cm', 'Waist', ' cm', true], ['pushups', 'Push-ups', '', false],
];

function Tile({ label, unit, latest, first, betterDown }: { label: string; unit: string; latest: any; first: any; betterDown: boolean }) {
  if (latest == null) return <div className="metric-tile"><div className="k">{label}</div><div className="v faint">—</div></div>;
  const d = first != null ? Math.round((Number(latest) - Number(first)) * 10) / 10 : 0;
  const tone = !d ? 'flat' : (betterDown ? d < 0 : d > 0) ? 'good' : 'bad';
  return (
    <div className="metric-tile">
      <div className="k">{label}</div>
      <div className="v">{latest}{unit}</div>
      <div className={`d ${tone}`}>{d ? `${d > 0 ? '+' : ''}${d}${unit} since start` : 'no change yet'}</div>
    </div>
  );
}

function Photos({ memberId, photos, canManage }: { memberId: string; photos: any[]; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [angle, setAngle] = useState('front');
  const [compare, setCompare] = useState(false);
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const res = await fetch(`/api/fitness/members/${memberId}/photos?angle=${angle}`, {
        method: 'POST', body: file,
        headers: { Authorization: `Bearer ${session.get()?.accessToken}`, 'X-Branch-Id': branchScope.get(), 'Content-Type': file.type || 'application/octet-stream' },
      });
      if (!res.ok) throw new ApiError(res.status, 'upload', (await res.json().catch(() => ({}))).error?.message ?? 'Upload failed');
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['fitness-summary', memberId] }); toast('success', 'Photo added'); },
    onError: (e) => toast('error', e instanceof ApiError ? e.message : 'Upload failed'),
  });
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/fitness/photos/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['fitness-summary', memberId] }) });
  const fronts = photos.filter((p) => p.angle === 'front');
  return (
    <Card title="Progress photos" icon={<Camera />} sub="Private to the member and their coaches"
      actions={<>{fronts.length >= 2 && <Button size="sm" onClick={() => setCompare(true)}>Compare first vs latest</Button>}{canManage && <select className="select" style={{ width: 110, height: 30 }} value={angle} onChange={(e) => setAngle(e.target.value)} aria-label="Angle">{['front', 'side', 'back'].map((a) => <option key={a}>{a}</option>)}</select>}</>}>
      <div className="photo-grid">
        {canManage && (
          <button className="upload-drop" onClick={() => input.current?.click()} disabled={upload.isPending}>
            <span><Plus size={20} /><br />{upload.isPending ? 'Uploading…' : `Add ${angle} photo`}<br /><span className="faint">JPEG, PNG or WebP · max 6 MB</span></span>
            <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} />
          </button>
        )}
        {photos.map((p) => (
          <div key={p.id} className="photo">
            <AuthImage src={`/fitness/photos/${p.id}`} alt={`${p.angle} on ${p.taken_on}`} />
            <div className="cap">{date(p.taken_on)} · {p.angle}</div>
            {canManage && <button className="icon-btn del" style={{ width: 28, height: 28 }} aria-label="Delete photo" onClick={() => confirm('Delete this photo?') && del.mutate(p.id)}><Trash2 /></button>}
          </div>
        ))}
        {!photos.length && !canManage && <Empty title="No photos yet" />}
      </div>
      {compare && (
        <Dialog open wide onClose={() => setCompare(false)} title="Before and after" sub={`${date(fronts.at(-1).taken_on)} → ${date(fronts[0].taken_on)}`}>
          <div className="grid g-2">
            <div className="photo"><AuthImage src={`/fitness/photos/${fronts.at(-1).id}`} alt="First" /><div className="cap">{date(fronts.at(-1).taken_on)}</div></div>
            <div className="photo"><AuthImage src={`/fitness/photos/${fronts[0].id}`} alt="Latest" /><div className="cap">{date(fronts[0].taken_on)}</div></div>
          </div>
        </Dialog>
      )}
    </Card>
  );
}

export function FitnessTab({ m }: { m: any }) {
  const { can } = useAuth();
  const [recording, setRecording] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [profile, setProfile] = useState(false);
  const { data } = useQuery({ queryKey: ['fitness-summary', m.id], queryFn: () => api.get<any>(`/fitness/members/${m.id}/summary`), enabled: can('assessments.read') });
  if (!can('assessments.read')) return <Card><Empty title="You don't have access to fitness data" /></Card>;
  if (!data) return <Skeleton h={400} />;
  const series = (k: string) => [...data.assessments].reverse().filter((a: any) => a[k] != null).map((a: any) => ({ date: a.assessed_on, value: Number(a[k]) }));
  const p = data.profile;
  const latest = data.latest;
  const first = data.first;
  const goalDown = p?.primary_goal !== 'muscle_gain';
  return (
    <div className="stack">
      <div className="grid g-dash-1">
        <Card title="Progress" icon={<ClipboardList />} sub={latest ? `Last assessed ${relative(latest.assessed_on)} · ${data.assessments.length} assessments` : 'No assessments yet'}
          actions={can('assessments.manage') && <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setRecording(true)}>Record assessment</Button>}>
          {!latest ? <Empty title="Record a baseline to start tracking progress" /> : (
            <div className="stack">
              <div className="metric-tiles">{TILES.map(([k, l, u, down]) => <Tile key={k} label={l} unit={u} latest={latest[k]} first={first?.[k]} betterDown={k === 'weight_kg' ? goalDown : down} />)}</div>
              <div className="faint" style={{ fontSize: 12.5 }}>
                {latest.bmr ? <>Resting energy (BMR, Mifflin–St Jeor): <b className="num" style={{ color: 'var(--text)' }}>{latest.bmr} kcal/day</b> · </> : null}
                {latest.resting_hr ? <>Resting HR {latest.resting_hr} bpm · </> : null}
                {latest.bp_systolic ? <>BP {latest.bp_systolic}/{latest.bp_diastolic} · </> : null}
                {latest.plank_seconds ? <>Plank {latest.plank_seconds}s</> : null}
              </div>
            </div>
          )}
        </Card>
        <Card title="Goal & coaching" icon={<Target />} actions={['assessments.manage', 'workouts.manage', 'nutrition.manage'].some((x) => can(x)) && <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setProfile(true)} aria-label="Edit" />}>
          {!p ? <Empty title="No fitness profile yet">Set a goal and assign a coach.</Empty> : (
            <dl className="kv" style={{ gridTemplateColumns: '120px 1fr' }}>
              <dt>Goal</dt><dd>{GOAL_LABEL[p.primary_goal] ?? '—'}{p.target_weight_kg ? ` · target ${p.target_weight_kg} kg` : ''}</dd>
              <dt>Level</dt><dd>{LEVEL_LABEL[p.experience_level] ?? '—'}{p.training_days_per_week ? ` · ${p.training_days_per_week} days/week` : ''}</dd>
              <dt>Diet</dt><dd>{DIET_LABEL[p.dietary_preference] ?? '—'}</dd>
              <dt>Trainer</dt><dd>{p.trainer_name ?? '—'}</dd>
              <dt>Nutritionist</dt><dd>{p.nutritionist_name ?? '—'}</dd>
              {p.injuries && <><dt>Limitations</dt><dd style={{ color: 'var(--warning)' }}>{p.injuries}</dd></>}
              {p.medical_notes && <><dt>Medical</dt><dd>{p.medical_notes}</dd></>}
            </dl>
          )}
        </Card>
      </div>
      {data.assessments.length > 1 && (
        <div className="grid g-4">
          <Card title="Weight" sub="kg"><MetricLine points={series('weight_kg')} format={(v) => v.toFixed(1)} target={p?.target_weight_kg ? Number(p.target_weight_kg) : null} better={goalDown ? 'down' : 'up'} /></Card>
          <Card title="Body fat" sub="%"><MetricLine points={series('body_fat_pct')} format={(v) => v.toFixed(1)} /></Card>
          <Card title="Waist" sub="cm"><MetricLine points={series('waist_cm')} format={(v) => v.toFixed(0)} /></Card>
          <Card title="Push-ups" sub="reps"><MetricLine points={series('pushups')} format={(v) => v.toFixed(0)} better="up" /></Card>
        </div>
      )}
      <Card title="Assessment history" icon={<ClipboardList />} bodyClass="">
        {!data.assessments.length ? <Empty title="No assessments yet" /> : (
          <div className="table-wrap" style={{ marginTop: 6 }}><table className="tbl">
            <thead><tr><th>Date</th><th className="r">Weight</th><th className="r">Fat %</th><th className="r">BMI</th><th className="r">Muscle</th><th className="r">Waist</th><th className="r">Hips</th><th className="r">Push-ups</th><th className="r">Plank</th><th>By</th>{can('assessments.manage') && <th />}</tr></thead>
            <tbody>{data.assessments.map((a: any) => (
              <tr key={a.id}>
                <td className="muted" style={{ whiteSpace: 'nowrap' }}>{date(a.assessed_on)}</td>
                {['weight_kg', 'body_fat_pct', 'bmi', 'muscle_mass_kg', 'waist_cm', 'hips_cm', 'pushups', 'plank_seconds'].map((k) => <td key={k} className="r num">{a[k] ?? '—'}</td>)}
                <td className="muted">{a.assessed_by_name ?? '—'}</td>
                {can('assessments.manage') && <td><Button size="sm" variant="ghost" icon={<Pencil />} aria-label="Correct" onClick={() => setEditing(a)} /></td>}
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <Photos memberId={m.id} photos={data.photos} canManage={can('assessments.manage')} />
      {recording && <AssessmentDialog memberId={m.id} memberName={m.full_name} previous={latest} onClose={() => setRecording(false)} />}
      {editing && <AssessmentDialog memberId={m.id} memberName={m.full_name} existing={editing} onClose={() => setEditing(null)} />}
      {profile && <FitnessProfileDialog memberId={m.id} profile={p} onClose={() => setProfile(false)} />}
    </div>
  );
}

export function WorkoutTab({ m }: { m: any }) {
  const { can } = useAuth();
  const [assign, setAssign] = useState(false);
  const { data: list } = useQuery({ queryKey: ['workout', 'member', m.id], queryFn: () => api.get<any[]>('/fitness/workout-plans', { memberId: m.id }), enabled: can('workouts.read') });
  const active = list?.find((p) => p.status === 'active');
  const { data: plan } = useQuery({ queryKey: ['workout-plan', active?.id], queryFn: () => api.get<any>(`/fitness/workout-plans/${active!.id}`), enabled: !!active });
  if (!can('workouts.read')) return <Card><Empty title="You don't have access to workout plans" /></Card>;
  return (
    <div className="stack">
      <Card title={plan ? plan.name : 'Workout plan'} icon={<Dumbbell />} sub={plan ? `${plan.days.length} days/week · ${date(plan.starts_on)} – ${date(plan.ends_on)} · ${plan.trainer_name ?? 'no trainer'}` : undefined}
        actions={<>{plan && <Link className="btn sm" to={`/workouts/plans/${plan.id}`}><Pencil />Open editor</Link>}{can('workouts.manage') && <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setAssign(true)}>{plan ? 'New plan' : 'Assign plan'}</Button>}</>}>
        {!list ? <Skeleton h={200} /> : !active ? <Empty title="No active workout plan">Assign a template or build one from scratch.</Empty> : !plan ? <Skeleton h={200} /> : (
          <div className="stack">
            <div className="row wrap faint" style={{ fontSize: 12.5 }}>{plan.logs.filter((l: any) => Date.parse(l.performed_on) > Date.now() - 28 * 86400_000).length} sessions logged in 4 weeks · last {plan.logs[0] ? relative(plan.logs[0].performed_on) : 'never'}</div>
            <div className="day-view">{plan.days.map((d: any) => (
              <div key={d.id} className="summary-box" style={{ gap: 4 }}>
                <div className="row between"><b>{d.name}</b><span className="faint" style={{ fontSize: 12 }}>{d.focus}</span></div>
                {d.exercises.map((e: any) => <div key={e.id} className="row between" style={{ fontSize: 13 }}><span>{e.exercise_name}</span><span className="faint num">{e.sets}×{e.reps}{e.weight ? ` · ${e.weight}` : ''}</span></div>)}
              </div>
            ))}</div>
          </div>
        )}
      </Card>
      {list && list.filter((p) => p.status !== 'active').length > 0 && (
        <Card title="Previous plans" bodyClass="">
          <div className="table-wrap" style={{ marginTop: 6 }}><table className="tbl"><tbody>{list.filter((p) => p.status !== 'active').map((p) => (
            <tr key={p.id}><td><Link to={`/workouts/plans/${p.id}`} style={{ fontWeight: 700 }}>{p.name}</Link></td><td className="muted">{date(p.starts_on)} – {date(p.ends_on)}</td><td className="muted">{p.staff_name}</td><td><span className="badge neutral">{p.status}</span></td></tr>
          ))}</tbody></table></div>
        </Card>
      )}
      {assign && <AssignPlanDialog kind="workout" memberId={m.id} memberName={m.full_name} onClose={() => setAssign(false)} />}
    </div>
  );
}

export function NutritionTab({ m }: { m: any }) {
  const { can } = useAuth();
  const [assign, setAssign] = useState(false);
  const { data: list } = useQuery({ queryKey: ['nutrition', 'member', m.id], queryFn: () => api.get<any[]>('/fitness/nutrition-plans', { memberId: m.id }), enabled: can('nutrition.read') });
  const active = list?.find((p) => p.status === 'active');
  const { data: plan } = useQuery({ queryKey: ['nutrition-plan', active?.id], queryFn: () => api.get<any>(`/fitness/nutrition-plans/${active!.id}`), enabled: !!active });
  if (!can('nutrition.read')) return <Card><Empty title="You don't have access to nutrition plans" /></Card>;
  return (
    <Card title={plan ? plan.name : 'Nutrition plan'} icon={<Apple />} sub={plan ? `${plan.nutritionist_name ?? 'No nutritionist'} · since ${date(plan.starts_on)} · ${DIET_LABEL[plan.diet_type] ?? ''}` : undefined}
      actions={<>{plan && <Link className="btn sm" to={`/nutrition/plans/${plan.id}`}><Pencil />Open editor</Link>}{can('nutrition.manage') && <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setAssign(true)}>{plan ? 'New plan' : 'Assign plan'}</Button>}</>}>
      {!list ? <Skeleton h={200} /> : !active ? <Empty title="No active nutrition plan" /> : !plan ? <Skeleton h={200} /> : (
        <div className="grid g-dash-1">
          <div className="day-view">{plan.meals.map((ml: any) => (
            <div key={ml.id} className="summary-box" style={{ gap: 4 }}>
              <div className="row between"><b>{ml.name}</b><span className="faint num" style={{ fontSize: 12 }}>{ml.time} · {ml.totals.calories} kcal</span></div>
              {ml.items.map((i: any) => <div key={i.id} className="row between" style={{ fontSize: 13 }}><span>{i.food}</span><span className="faint">{i.quantity}</span></div>)}
            </div>
          ))}</div>
          <div className="stack" style={{ gap: 10 }}>
            <TargetRow label="Calories" actual={plan.totals.calories} target={plan.calorie_target} unit="kcal" />
            <TargetRow label="Protein" actual={plan.totals.protein_g} target={plan.protein_g} unit="g" />
            <MacroSplit protein={plan.totals.protein_g} carbs={plan.totals.carbs_g} fat={plan.totals.fat_g} />
            {plan.recommendations.length > 0 && <div><div className="section-label">Do</div><ul style={{ margin: '4px 0 0', paddingLeft: 18 }} className="muted">{plan.recommendations.map((r: string) => <li key={r}>{r}</li>)}</ul></div>}
            {plan.avoid.length > 0 && <div><div className="section-label">Avoid</div><ul style={{ margin: '4px 0 0', paddingLeft: 18 }} className="muted">{plan.avoid.map((r: string) => <li key={r}>{r}</li>)}</ul></div>}
          </div>
        </div>
      )}
      {assign && <AssignPlanDialog kind="nutrition" memberId={m.id} memberName={m.full_name} onClose={() => setAssign(false)} />}
    </Card>
  );
}
