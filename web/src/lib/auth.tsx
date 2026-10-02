import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, branchScope, session } from './api';

export interface Me {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  role_name: string | null;
  role_key: string | null;
  must_change_password: boolean;
  all_branches: boolean;
  permissions: string[];
  branches: { id: string; name: string; code: string }[];
  organization: { id: string; name: string; currency: string; expiring_soon_days: number };
}

interface AuthValue {
  me: Me | null;
  loading: boolean;
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
  can: (...perms: string[]) => boolean;
  branch: string;
  setBranch: (id: string) => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(!!session.get());
  const [branch, setBranchState] = useState(branchScope.get());

  const refreshMe = useCallback(async () => {
    const profile = await api.get<Me>('/auth/me');
    setMe(profile);
    const current = branchScope.get();
    if (current !== 'all' && !profile.branches.some((b) => b.id === current)) {
      branchScope.set('all');
      setBranchState('all');
    }
  }, []);

  useEffect(() => {
    session.onUnauthorized(() => {
      setMe(null);
      qc.clear();
    });
    if (session.get()) refreshMe().catch(() => session.set(null)).finally(() => setLoading(false));
  }, [qc, refreshMe]);

  const value = useMemo<AuthValue>(
    () => ({
      me,
      loading,
      branch,
      async login(identifier, password) {
        const res = await api.post<{ accessToken: string; refreshToken: string; user: Me }>('/auth/login', { identifier, password, client: 'crm' });
        session.set({ accessToken: res.accessToken, refreshToken: res.refreshToken });
        setMe(res.user);
      },
      async logout() {
        const t = session.get();
        session.set(null);
        setMe(null);
        qc.clear();
        if (t) await api.post('/auth/logout', { refreshToken: t.refreshToken }).catch(() => {});
      },
      refreshMe,
      can: (...perms) => !!me && perms.every((p) => me.permissions.includes(p)),
      setBranch(id) {
        branchScope.set(id);
        setBranchState(id);
        qc.invalidateQueries();
      },
    }),
    [me, loading, branch, qc, refreshMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
