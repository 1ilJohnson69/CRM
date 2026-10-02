export class ApiError extends Error {
  status: number;
  code: string;
  details?: { path: string; message: string }[];
  constructor(status: number, code: string, message: string, details?: { path: string; message: string }[]) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  fieldErrors(): Record<string, string> {
    return Object.fromEntries((this.details ?? []).map((d) => [d.path, d.message]));
  }
}

const KEY = 'forge.session';
type Tokens = { accessToken: string; refreshToken: string };

let tokens: Tokens | null = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
})();
let branchId: string = (() => {
  try {
    return localStorage.getItem('forge.branch') ?? 'all';
  } catch {
    return 'all';
  }
})();
let onUnauthorized: () => void = () => {};

export const session = {
  get: () => tokens,
  set(next: Tokens | null) {
    tokens = next;
    try {
      if (next) localStorage.setItem(KEY, JSON.stringify(next));
      else localStorage.removeItem(KEY);
    } catch {
      /* storage unavailable: session lives in memory only */
    }
  },
  onUnauthorized(fn: () => void) {
    onUnauthorized = fn;
  },
};

export const branchScope = {
  get: () => branchId,
  set(id: string) {
    branchId = id;
    try {
      localStorage.setItem('forge.branch', id);
    } catch {
      /* ignore */
    }
  },
};

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  if (!tokens?.refreshToken) return false;
  refreshing ??= fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: tokens.refreshToken }),
  })
    .then(async (res) => {
      if (!res.ok) return false;
      session.set(await res.json());
      return true;
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

type Query = Record<string, string | number | boolean | undefined | null>;

export function qs(params?: Query) {
  if (!params) return '';
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
}

export async function request<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
  const headers: Record<string, string> = { 'X-Branch-Id': branchId };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (tokens) headers.Authorization = `Bearer ${tokens.accessToken}`;
  const res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

  if (res.status === 401 && retry && tokens && !path.startsWith('/auth/login')) {
    if (await refresh()) return request<T>(method, path, body, false);
    session.set(null);
    onUnauthorized();
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error ?? {};
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? 'Request failed', e.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, params?: Query) => request<T>('GET', path + qs(params)),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

/** Opens an authenticated PDF in a new tab. */
export async function openPdf(path: string) {
  const win = window.open('', '_blank');
  const doFetch = () => fetch(`/api${path}`, { headers: { Authorization: `Bearer ${tokens?.accessToken}`, 'X-Branch-Id': branchId } });
  let res = await doFetch();
  if (res.status === 401 && (await refresh())) res = await doFetch();
  if (!res.ok) {
    win?.close();
    throw new ApiError(res.status, 'pdf', 'Could not generate the PDF');
  }
  const url = URL.createObjectURL(await res.blob());
  if (win) win.location.href = url;
  else window.location.href = url;
}

export interface Paged<T> {
  data: T[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

/** Downloads an authenticated file (CSV exports) without exposing the token in a URL. */
export async function downloadFile(path: string, query?: Record<string, string | number | boolean | undefined | null>) {
  const doFetch = () => fetch(`/api${path}${qs(query as any)}`, { headers: { Authorization: `Bearer ${tokens?.accessToken}`, 'X-Branch-Id': branchId } });
  let res = await doFetch();
  if (res.status === 401 && (await refresh())) res = await doFetch();
  if (!res.ok) throw new ApiError(res.status, 'download', (await res.json().catch(() => ({})))?.error?.message ?? 'Download failed');
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'export.csv';
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
