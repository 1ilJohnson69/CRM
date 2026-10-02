import { useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Construction, KeyRound } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/ui';
import { Alert, Button, Card, Empty, Field } from '../../components/ui';
import { Logo } from '../../components/layout/Shell';
import { NAV, PHASE_LABEL } from '../../components/layout/nav';

const DEMO = [
  ['admin@forge.fit', 'Super Admin'],
  ['meera@forge.fit', 'Branch Manager · Indiranagar'],
  ['sneha@forge.fit', 'Front Desk · Indiranagar'],
  ['accounts@forge.fit', 'Accountant'],
];

export function LoginPage() {
  const { login } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e?: FormEvent, id = identifier, pw = password) => {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(id, pw);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <div className="login-art">
        <div className="row"><Logo /><b style={{ letterSpacing: '0.1em' }} className="gold-text">FORGE</b></div>
        <div>
          <h1>The operating system for <span className="gold-text">serious gyms.</span></h1>
          <p>Members, memberships, desk collections and renewals — one backend shared by your CRM and your members’ app.</p>
        </div>
        <div className="login-stats">
          <div><b className="gold-text">1</b><span>Source of truth</span></div>
          <div><b className="gold-text">0</b><span>Payment gateways</span></div>
          <div><b className="gold-text">∞</b><span>Branches</span></div>
        </div>
      </div>
      <div className="login-form">
        <form className="login-card" onSubmit={submit}>
          <div><h2>Sign in</h2><div className="muted">Staff access to the Forge CRM.</div></div>
          {error && <Alert>{error}</Alert>}
          <Field label="Email or phone"><input className="input" autoFocus autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} /></Field>
          <Field label="Password"><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Button variant="primary" size="lg" className="block" loading={busy} type="submit">Sign in</Button>
          {import.meta.env.DEV && (
            <div className="stack" style={{ gap: 8 }}>
              <div className="section-label">Demo accounts · password Forge@2026</div>
              <div className="demo-accounts">
                {DEMO.map(([email, role]) => (
                  <button type="button" key={email} onClick={() => { setIdentifier(email); setPassword('Forge@2026'); submit(undefined, email, 'Forge@2026'); }}>
                    <span>{email}</span><span>{role}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

export function AccountPage() {
  const toast = useToast();
  const { me, refreshMe } = useAuth();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const m = useMutation({
    mutationFn: () => api.post('/auth/change-password', { currentPassword, newPassword }),
    onSuccess: () => { toast('success', 'Password changed'); setCurrent(''); setNew(''); setConfirm(''); refreshMe(); },
    onError: (e) => setError(e instanceof ApiError ? (e.details?.[0]?.message ?? e.message) : 'Failed'),
  });
  return (
    <div className="page" style={{ maxWidth: 560 }}>
      <div className="page-head"><div><h1>Your account</h1><div className="sub">{me?.full_name} · {me?.email}</div></div></div>
      {me?.must_change_password && <Alert tone="warning">You're using a temporary password. Please set your own.</Alert>}
      <Card title="Change password" icon={<KeyRound />}>
        <form className="form" onSubmit={(e) => { e.preventDefault(); setError(''); if (newPassword !== confirm) { setError('Passwords do not match'); return; } m.mutate(); }}>
          {error && <Alert>{error}</Alert>}
          <Field label="Current password"><input className="input" type="password" value={currentPassword} onChange={(e) => setCurrent(e.target.value)} /></Field>
          <Field label="New password" hint="At least 8 characters"><input className="input" type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} /></Field>
          <Field label="Confirm new password"><input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
          <div><Button variant="primary" type="submit" loading={m.isPending}>Update password</Button></div>
        </form>
      </Card>
    </div>
  );
}

export function PlannedPage() {
  const { pathname } = useLocation();
  const item = NAV.flatMap((g) => g.items).find((i) => i.to === pathname);
  return (
    <div className="page">
      <Card>
        <Empty icon={<Construction size={20} />} title={`${item?.label ?? 'This module'} is planned`}>
          It ships in {item?.phase ? PHASE_LABEL[item.phase] : 'a later phase'} and will plug into the same members, branches and billing records you're using now — no data migration needed.
        </Empty>
      </Card>
    </div>
  );
}

export function NotFoundPage() {
  return <div className="page"><Card><Empty title="Page not found" /></Card></div>;
}
