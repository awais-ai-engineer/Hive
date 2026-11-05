'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { Avatar } from './ui/avatar';
import { Icon, Logo } from './ui/icons';
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

  if (pathname?.startsWith('/home')) return null;

  const link = (href: string, label: string) => {
    const active = pathname === href || (href !== '/' && pathname?.startsWith(href));
    return <Link href={href} aria-current={active ? 'page' : undefined}
      className={`rounded-xl px-3 py-2 text-sm font-medium transition ${active ? 'bg-brand-soft text-brand' : 'text-white/65 hover:bg-[var(--surface-2)] hover:text-white'}`}>{label}</Link>;
  };
  return (
    <header className="sticky top-0 z-30 border-b border-white/[0.07] bg-surface/85 backdrop-blur">
      <nav className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4" aria-label="Main navigation">
        <Link href={user ? '/home' : '/'} className="mr-3 flex items-center gap-2 text-xl font-extrabold tracking-tight"><Logo size={30} />Hive</Link>
        <div className="hidden items-center gap-1 sm:flex">
          {user && <Link href="/home" className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium text-white/65 transition hover:bg-[var(--surface-2)] hover:text-white">Home
            {unread > 0 && <span aria-label={`${unread} unread messages`} className="rounded-full bg-brand px-1.5 text-[11px] font-semibold leading-5 text-white">{unread > 99 ? '99+' : unread}</span>}
          </Link>}
          {link('/feed', 'Feed')}
          {link('/spaces', 'Explore')}
        </div>
        {!loading && <div className="ml-auto flex items-center gap-2 text-sm">
          {user ? <>
            <Link href="/spaces/new" className="auth-button hidden h-10 sm:inline-flex"><Icon name="plus" size={16} />Create</Link>
            <Link href="/me" aria-label="Your profile" className="ml-1"><Avatar name={user.username} src={user.avatar_url} size={36} /></Link>
            <button onClick={signOut} disabled={busy} aria-label="Log out" title="Log out" className="rounded-xl p-2 text-white/55 hover:bg-[var(--surface-2)] hover:text-white disabled:opacity-40"><Icon name="logout" /></button>
          </> : <>
            <Link href="/login" className="rounded-xl px-3 py-2 font-medium text-white/70 hover:text-white">Log in</Link>
            <Link href="/signup" className="auth-button h-10">Sign up</Link>
          </>}
        </div>}
      </nav>
      {error && <p role="alert" className="pb-2 text-center text-sm text-rose-500">{error}</p>}
      {/* Phones: the main sections move to a bottom tab bar. */}
      <nav aria-label="Sections" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-white/10 bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden">
        {([['/home', 'Home', 'home'], ['/feed', 'Feed', 'layers'], ['/spaces', 'Explore', 'compass'], [user ? '/me' : '/login', user ? 'You' : 'Log in', 'users']] as const).map(([href, label, icon]) => {
          const active = pathname?.startsWith(href);
          return <Link key={href} href={href} aria-current={active ? 'page' : undefined}
            className={`flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${active ? 'text-brand' : 'text-white/55'}`}>
            <Icon name={icon} size={22} />{label}{href === '/home' && unread > 0 && <span className="sr-only">{unread} unread</span>}
          </Link>;
        })}
      </nav>
    </header>
  );
}
