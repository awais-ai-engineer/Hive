'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '../lib/auth';

export default function Nav() {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function signOut() {
    setBusy(true);
    setError('');
    try { await logout(); router.push('/login'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not log out.'); }
    finally { setBusy(false); }
  }

  return (
    <header className="border-b border-white/10 px-4 py-4">
      <nav className="mx-auto flex max-w-5xl items-center justify-between" aria-label="Main navigation">
        <Link href="/" className="text-xl font-bold text-amber-400">Hive</Link>
        {!loading && <div className="flex items-center gap-3 text-sm">
          {user ? <><Link href="/me">{user.username}</Link><span>·</span>
            <button onClick={signOut} disabled={busy} className="text-amber-400 disabled:opacity-40">Log out</button></>
            : <><Link href="/login">Log in</Link><span>/</span><Link href="/signup">Sign up</Link></>}
        </div>}
      </nav>
      {error && <p role="alert" className="text-center text-rose-400">{error}</p>}
    </header>
  );
}
