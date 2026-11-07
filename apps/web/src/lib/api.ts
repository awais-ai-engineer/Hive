export type User = {
  id: string;
  username: string;
  email: string;
  avatar_url: string | null;
  cover_url?: string | null;
  created_at: string;
  display_name?: string | null;
  bio?: string | null;
  status_text?: string | null;
  status_emoji?: string | null;
  status_expires_at?: string | null;
  out_of_office_until?: string | null;
  dm_policy?: 'everyone' | 'workspaces' | 'nobody';
  appear_offline?: boolean;
  translate_language?: string | null;
};

export type AuthSession = { access_token: string; token_type: string; user: User };
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
// Login, refresh and logout use a cookie. When the site and the API live on different domains,
// those calls go through the site's own domain (a rewrite in next.config.ts), so the cookie is
// first-party and works in browsers that block third-party cookies.
const AUTH_URL = process.env.NEXT_PUBLIC_AUTH_PROXY === '1' ? '' : API_URL;
const baseFor = (path: string) => path.startsWith('/api/auth/') ? AUTH_URL : API_URL;
let session: AuthSession | null = null;
let revision = 0;
let refreshPromise: Promise<AuthSession | null> | null = null;
const listeners = new Set<(value: AuthSession | null) => void>();
export const currentUserId = () => session?.user.id;

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
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (!response.ok) {
    throw new Error(typeof body.detail === 'string' ? body.detail : typeof body.detail?.message === 'string' ? body.detail.message : 'Please check your input.');
  }
  return body as T;
}

export function refreshSession(): Promise<AuthSession | null> {
  if (!refreshPromise) {
    const started = revision;
    refreshPromise = (async () => {
      try {
        const response = await fetch(`${AUTH_URL}/api/auth/refresh`, {
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
    return fetch(`${baseFor(path)}${path}`, { ...init, headers, credentials: 'include' });
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

export function uploadFile<T>(path: string, file: File, onProgress: (percent: number) => void, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let request: XMLHttpRequest | null = null;
    let settled = false;
    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve(result!);
    };
    const cancel = () => { request?.abort(); finish(new DOMException('Upload cancelled', 'AbortError')); };
    signal?.addEventListener('abort', cancel, { once: true });
    async function send(retried = false) {
      if (signal?.aborted) { cancel(); return; }
      const xhr = new XMLHttpRequest(); request = xhr;
      xhr.open('POST', `${API_URL}${path}`); xhr.withCredentials = true;
      if (session) xhr.setRequestHeader('Authorization', `Bearer ${session.access_token}`);
      xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
      xhr.onerror = () => finish(new Error('Upload failed. Check your connection.'));
      xhr.onabort = () => finish(new DOMException('Upload cancelled', 'AbortError'));
      xhr.onload = async () => {
        if (xhr.status === 401 && !retried) {
          if (await refreshSession()) { void send(true); return; }
        }
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status < 200 || xhr.status >= 300) throw new Error(typeof data.detail === 'string' ? data.detail : 'Upload failed');
          finish(undefined, data as T);
        } catch (error) { finish(error instanceof Error ? error : new Error('Upload failed')); }
      };
      const form = new FormData(); form.append('file', file); xhr.send(form);
    }
    void send();
  });
}
