'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { DMS_CHANGED, type Conversation } from '../lib/dms';
import { socket } from '../lib/socket';
import { apiData } from '../lib/spaces';

export default function Nav() {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unread, setUnread] = useState(0);
  const pathname = usePathname();

  // Total unread direct messages, refreshed on new DM activity and after reading.
  useEffect(() => {
    if (!user) { setUnread(0); return; }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        apiData<Conversation[]>('/api/dms')
          .then(list => { if (active) setUnread(list.reduce((sum, item) => sum + item.unread, 0)); })
          .catch(() => {});
      }, 400);
    };
    refresh();
    socket.on('dm:activity', refresh).on('read:updated', refresh).on('connect', refresh);
    window.addEventListener(DMS_CHANGED, refresh);
    return () => {
      active = false; clearTimeout(timer);
      socket.off('dm:activity', refresh).off('read:updated', refresh).off('connect', refresh);
      window.removeEventListener(DMS_CHANGED, refresh);
    };
  }, [user, pathname]);

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
        <div className="ml-auto mr-4 flex items-center gap-4 text-sm">
          <Link href="/feed">Feed</Link>
          <Link href="/spaces">Spaces</Link>
          {user && <Link href="/home" className="flex items-center gap-1">Home
            {unread > 0 && <span aria-label={`${unread} unread messages`} className="rounded-full bg-amber-400 px-1.5 text-xs font-semibold text-black">{unread > 99 ? '99+' : unread}</span>}
          </Link>}
        </div>
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
