import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, branchScope, session } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/ui';
import { Alert, Button, Dialog, Field } from '../../components/ui';
import { MemberPicker, type MemberPick } from '../shared';

export const GOAL_LABEL: Record<string, string> = {
  fat_loss: 'Fat loss', muscle_gain: 'Muscle gain', strength: 'Strength', general_fitness: 'General fitness', endurance: 'Endurance', mobility: 'Mobility', rehab: 'Rehab', sport: 'Sport',
};
export const LEVEL_LABEL: Record<string, string> = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };
export const DIET_LABEL: Record<string, string> = { vegetarian: 'Vegetarian', eggetarian: 'Eggetarian', non_vegetarian: 'Non-vegetarian', vegan: 'Vegan', jain: 'Jain' };
export const CATEGORY_LABEL: Record<string, string> = { strength: 'Strength', cardio: 'Cardio', mobility: 'Mobility', core: 'Core', plyometric: 'Plyometric', conditioning: 'Conditioning' };
export const PLAN_STATUS_TONE: Record<string, string> = { active: 'success', draft: 'neutral', completed: 'info', archived: 'neutral' };

/** Images behind auth: fetched with the bearer token and shown via an object URL. */
export function AuthImage({ src, alt }: { src: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
    fetch(`/api${src}`, { headers: { Authorization: `Bearer ${session.get()?.accessToken}`, 'X-Branch-Id': branchScope.get() } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (b && !cancelled) { revoke = URL.createObjectURL(b); setUrl(revoke); }
      })
      .catch(() => {});
    return () => { cancelled = true; if (revoke) URL.revokeObjectURL(revoke); };
  }, [src]);
  return url ? <img src={url} alt={alt} /> : <div className="skeleton" style={{ width: '100%', height: '100%' }} />;
}

const FIELDS: [string, string, string][] = [
  ['weightKg', 'Weight', 'kg'], ['heightCm', 'Height', 'cm'], ['bodyFatPct', 'Body fat', '%'], ['muscleMassKg', 'Muscle mass', 'kg'],
  ['visceralFat', 'Visceral fat', 'level'], ['restingHr', 'Resting HR', 'bpm'], ['bpSystolic', 'BP systolic', 'mmHg'], ['bpDiastolic', 'BP diastolic', 'mmHg'],
];
const MEASURES: [string, string][] = [['chestCm', 'Chest'], ['waistCm', 'Waist'], ['hipsCm', 'Hips'], ['armCm', 'Arm'], ['thighCm', 'Thigh']];
const TESTS: [string, string, string][] = [['pushups', 'Push-ups', 'reps'], ['plankSeconds', 'Plank', 'sec'], ['squats1min', 'Squats in 1 min', 'reps'], ['sitReachCm', 'Sit & reach', 'cm']];
const COLS: Record<string, string> = {
  weightKg: 'weight_kg', heightCm: 'height_cm', bodyFatPct: 'body_fat_pct', muscleMassKg: 'muscle_mass_kg', visceralFat: 'visceral_fat', restingHr: 'resting_hr',
  bpSystolic: 'bp_systolic', bpDiastolic: 'bp_diastolic', chestCm: 'chest_cm', waistCm: 'waist_cm', hipsCm: 'hips_cm', armCm: 'arm_cm', thighCm: 'thigh_cm',
  pushups: 'pushups', plankSeconds: 'plank_seconds', squats1min: 'squats_1min', sitReachCm: 'sit_reach_cm',
};

/** Record a new assessment (or correct one). Previous values show as placeholders. */
export function AssessmentDialog({ memberId, memberName, previous, existing, appointmentId, onClose }: {
  memberId?: string; memberName?: string; previous?: any; existing?: any; appointmentId?: string; onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [member, setMember] = useState<MemberPick | null>(memberId ? { id: memberId, full_name: memberName ?? 'Member', member_code: '' } : null);
  const [v, setV] = useState<Record<string, string>>(() => (existing ? Object.fromEntries(Object.entries(COLS).map(([k, c]) => [k, existing[c] == null ? '' : String(existing[c])])) : {}));
  const [date, setDate] = useState(existing?.assessed_on ?? new Date().toLocaleDateString('en-CA'));
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { assessedOn: date, notes: notes || null };
      for (const k of Object.keys(COLS)) body[k] = v[k] === '' || v[k] === undefined ? null : Number(v[k]);
      return existing ? api.put(`/fitness/assessments/${existing.id}`, body) : api.post('/fitness/assessments', { ...body, memberId: member!.id, appointmentId: appointmentId ?? null });
    },
    onSuccess: () => { qc.invalidateQueries(); toast('success', existing ? 'Assessment corrected' : 'Assessment recorded'); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? (Array.isArray(e.details) ? `${(e.details as any)[0].path}: ${(e.details as any)[0].message}` : e.message) : 'Failed'),
  });
  const input = (k: string, label: string, unit: string) => (
    <Field key={k} label={`${label} (${unit})`}>
      <input className="input num" type="number" step="0.1" inputMode="decimal" value={v[k] ?? ''} placeholder={previous?.[COLS[k]] != null ? `last ${previous[COLS[k]]}` : ''}
        onChange={(e) => setV({ ...v, [k]: e.target.value })} />
    </Field>
  );
  return (
    <Dialog open variant="drawer" onClose={onClose} title={existing ? 'Correct assessment' : 'Record assessment'} sub={existing ? `From ${existing.assessed_on}` : 'Fill in what you measured — everything is optional except one value. BMI is calculated.'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!member} loading={save.isPending} onClick={() => { setError(''); save.mutate(); }}>Save</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        {!existing && !memberId && <Field label="Member"><MemberPicker value={member} onChange={setMember} /></Field>}
        <Field label="Date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <div className="section-label">Body composition</div>
        <div className="form-grid">{FIELDS.map(([k, l, u]) => input(k, l, u))}</div>
        <div className="section-label">Measurements</div>
        <div className="form-grid">{MEASURES.map(([k, l]) => input(k, l, 'cm'))}</div>
        <div className="section-label">Fitness tests</div>
        <div className="form-grid">{TESTS.map(([k, l, u]) => input(k, l, u))}</div>
        <Field label="Notes"><textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Observations, posture, next focus…" /></Field>
      </div>
    </Dialog>
  );
}

export function FitnessProfileDialog({ memberId, profile, onClose }: { memberId: string; profile: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: staff } = useQuery({ queryKey: ['appt-staff'], queryFn: () => api.get<any[]>('/appointments/staff') });
  const [f, setF] = useState({
    primaryGoal: profile?.primary_goal ?? '', targetWeightKg: profile?.target_weight_kg ?? '', experienceLevel: profile?.experience_level ?? '',
    trainingDaysPerWeek: profile?.training_days_per_week ?? '', injuries: profile?.injuries ?? '', medicalNotes: profile?.medical_notes ?? '',
    dietaryPreference: profile?.dietary_preference ?? '', assignedTrainerId: profile?.assigned_trainer_id ?? '', assignedNutritionistId: profile?.assigned_nutritionist_id ?? '',
  });
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: () => api.put(`/fitness/members/${memberId}/profile`, Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v === '' ? null : v]))),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['fitness-summary', memberId] }); toast('success', 'Fitness profile saved'); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Failed'),
  });
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog open variant="drawer" onClose={onClose} title="Fitness profile" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        <div className="form-grid">
          <Field label="Primary goal"><select className="select" value={f.primaryGoal} onChange={set('primaryGoal')}><option value="">—</option>{Object.entries(GOAL_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Target weight (kg)"><input className="input num" type="number" step="0.1" value={f.targetWeightKg} onChange={set('targetWeightKg')} /></Field>
          <Field label="Experience"><select className="select" value={f.experienceLevel} onChange={set('experienceLevel')}><option value="">—</option>{Object.entries(LEVEL_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Training days / week"><input className="input num" type="number" min={1} max={7} value={f.trainingDaysPerWeek} onChange={set('trainingDaysPerWeek')} /></Field>
          <Field label="Diet"><select className="select" value={f.dietaryPreference} onChange={set('dietaryPreference')}><option value="">—</option>{Object.entries(DIET_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Trainer"><select className="select" value={f.assignedTrainerId} onChange={set('assignedTrainerId')}><option value="">—</option>{staff?.filter((s) => s.role_key === 'trainer').map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}</select></Field>
          <Field label="Nutritionist" className="full"><select className="select" value={f.assignedNutritionistId} onChange={set('assignedNutritionistId')}><option value="">—</option>{staff?.filter((s) => s.role_key === 'nutritionist').map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}</select></Field>
          <Field label="Injuries / limitations" className="full"><textarea className="textarea" value={f.injuries} onChange={set('injuries')} /></Field>
          <Field label="Medical notes" className="full" hint="Visible to staff with fitness access only"><textarea className="textarea" value={f.medicalNotes} onChange={set('medicalNotes')} /></Field>
        </div>
      </div>
    </Dialog>
  );
}

/** Assign a template (or copy any plan) to a member. */
export function AssignPlanDialog({ kind, memberId, memberName, templateId, onClose }: { kind: 'workout' | 'nutrition'; memberId?: string; memberName?: string; templateId?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = useAuth();
  const base = kind === 'workout' ? '/fitness/workout-plans' : '/fitness/nutrition-plans';
  const [member, setMember] = useState<MemberPick | null>(memberId ? { id: memberId, full_name: memberName ?? 'Member', member_code: '' } : null);
  const [tpl, setTpl] = useState(templateId ?? '');
  const [startsOn, setStartsOn] = useState(new Date().toLocaleDateString('en-CA'));
  const [error, setError] = useState('');
  const { data: templates } = useQuery({ queryKey: [kind, 'templates'], queryFn: () => api.get<any[]>(base, { templates: true }) });
  const assign = useMutation({
    mutationFn: () => api.post<{ id: string }>(`${base}/${tpl}/assign`, { memberId: member!.id, startsOn }),
    onSuccess: (r) => { qc.invalidateQueries(); toast('success', 'Plan assigned · member notified in the app'); onClose(); navigate(`/${kind === 'workout' ? 'workouts' : 'nutrition'}/plans/${r.id}`); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Failed'),
  });
  const blank = useMutation({
    mutationFn: () => api.post<{ id: string }>(base, {
      memberId: member!.id,
      plan: kind === 'workout'
        ? { name: `${member!.full_name.split(' ')[0]}'s plan`, startsOn, days: [{ name: 'Day 1', exercises: [] }] }
        : { name: `${member!.full_name.split(' ')[0]}'s nutrition`, startsOn, meals: [{ name: 'Breakfast', time: '08:00', items: [] }] },
    }),
    onSuccess: (r) => { qc.invalidateQueries(); onClose(); navigate(`/${kind === 'workout' ? 'workouts' : 'nutrition'}/plans/${r.id}`); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Failed'),
  });
  const manage = can(kind === 'workout' ? 'workouts.manage' : 'nutrition.manage');
  return (
    <Dialog open onClose={onClose} title={`Assign ${kind} plan`} sub="The member's current plan (if any) is marked completed. Templates are copied, so you can tailor this member's version."
      footer={<><Button onClick={onClose}>Cancel</Button>{manage && <Button disabled={!member} loading={blank.isPending} onClick={() => blank.mutate()}>Start blank</Button>}<Button variant="primary" disabled={!member || !tpl || !manage} loading={assign.isPending} onClick={() => assign.mutate()}>Assign template</Button></>}>
      <div className="form">
        {error && <Alert>{error}</Alert>}
        {!memberId && <Field label="Member"><MemberPicker value={member} onChange={setMember} /></Field>}
        <Field label="Starts"><input className="input" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></Field>
        <div className="stack" style={{ gap: 6 }}>
          {templates?.filter((t) => t.status === 'active').map((t) => (
            <button type="button" key={t.id} className={`plan-option ${tpl === t.id ? 'on' : ''}`} onClick={() => setTpl(t.id)}>
              <div className="row between"><span className="pn">{t.name}</span><span className="faint" style={{ fontSize: 12 }}>{t.active_assignments} using it</span></div>
              <div className="pd">{kind === 'workout' ? `${t.goal ?? ''} · ${LEVEL_LABEL[t.level] ?? ''} · ${t.day_count} days/week · ${t.duration_weeks ?? '—'} weeks` : `${t.goal ?? ''} · ${t.calorie_target ?? '—'} kcal · ${t.protein_g ?? '—'} g protein · ${DIET_LABEL[t.diet_type] ?? ''}`}</div>
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
