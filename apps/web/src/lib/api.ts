export type User = {
  id: string;
  username: string;
  email: string;
  avatar_url: string | null;
  created_at: string;
};

export type AuthSession = { access_token: string; token_type: string; user: User };
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
let session: AuthSession | null = null;
let revision = 0;
let refreshPromise: Promise<AuthSession | null> | null = null;
const listeners = new Set<(value: AuthSession | null) => void>();

export function setSession(value: AuthSession | null) {
  session = value;
  revision += 1;
  listeners.forEach(listener => listener(value));
}

export function subscribeSession(listener: (value: AuthSession | null) => void) {
  listeners.add(listener);
  listener(session);
  return () => { listeners.delete(listener); };
}

export function updateSessionUser(user: User) {
  if (session) setSession({ ...session, user });
}

export async function responseData<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) {
    throw new Error(typeof body.detail === 'string' ? body.detail : 'Please check your input.');
  }
  return body as T;
}

export function refreshSession(): Promise<AuthSession | null> {
  if (!refreshPromise) {
    const started = revision;
    refreshPromise = (async () => {
      try {
        const response = await fetch(`${API_URL}/api/auth/refresh`, {
          method: 'POST', credentials: 'include',
        });
        const value = await responseData<AuthSession>(response);
        if (revision === started) setSession(value);
        return session;
      } catch {
        if (revision === started) setSession(null);
        return null;
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = () => {
    const headers = new Headers(init.headers);
    if (session) headers.set('Authorization', `Bearer ${session.access_token}`);
    else headers.delete('Authorization');
    if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    return fetch(`${API_URL}${path}`, { ...init, headers, credentials: 'include' });
  };
  const token = session?.access_token;
  const response = await send();
  if (response.status !== 401 || path.startsWith('/api/auth/')) return response;
  const restored = session && session.access_token !== token ? session : await refreshSession();
  if (!restored) return response;
  const retried = await send();
  if (retried.status === 401) setSession(null);
  return retried;
}

export async function endSession() {
  if (refreshPromise) await refreshPromise;
  const response = await apiFetch('/api/auth/logout', { method: 'POST' });
  if (!response.ok) throw new Error('Could not log out. Please try again.');
  setSession(null);
}
