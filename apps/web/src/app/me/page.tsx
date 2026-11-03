'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { profileSchema } from '@hive/shared';
import { apiFetch, responseData, type User } from '../../lib/api';
import { useAuth } from '../../lib/auth';

export default function ProfilePage() {
  const { user, loading, logout, updateUser } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const parsed = profileSchema.safeParse(Object.fromEntries(new FormData(event.currentTarget)));
      if (!parsed.success) throw new Error(parsed.error.issues[0].message);
      const response = await apiFetch('/api/me', { method: 'PATCH', body: JSON.stringify(parsed.data) });
      updateUser(await responseData<User>(response));
      setSaved(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save profile.'); }
    finally { setBusy(false); }
  }

  async function signOut() {
    setBusy(true);
    setError('');
    try { await logout(); router.replace('/login'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not log out.'); }
    finally { setBusy(false); }
  }

  if (loading || !user) return <main className="p-16 text-center">Loading…</main>;
  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <section className="space-y-5 rounded-xl border border-white/10 bg-white/[0.03] p-6">
        <h1 className="text-2xl font-bold">{user.username}</h1>
        <p className="break-all text-white/70">{user.email}</p>
        <p className="text-sm text-white/50">Joined {new Date(user.created_at).toLocaleDateString()}</p>
        <form onSubmit={save} className="space-y-4">
          <label className="block">Username
            <input key={user.username} className="auth-input" name="username" defaultValue={user.username} required minLength={3} maxLength={32} pattern="[a-zA-Z0-9_]+" />
          </label>
          <button disabled={busy} className="auth-button">{busy ? 'Please wait…' : 'Save changes'}</button>
        </form>
        {saved && <p role="status" className="text-emerald-400">Profile updated.</p>}
        {error && <p role="alert" className="text-rose-400">{error}</p>}
        <button onClick={signOut} disabled={busy} className="text-amber-400 disabled:opacity-40">Log out</button>
      </section>
    </main>
  );
}
