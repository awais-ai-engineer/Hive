'use client';

import { playMessageSound } from '../lib/sounds';
import { currentUserId } from '../lib/api';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth';
import { Avatar } from './ui/avatar';
import { Icon, Logo } from './ui/icons';
import { useInstall } from '../lib/push';
import { DMS_CHANGED } from '../lib/dms';
import { socket } from '../lib/socket';
import { apiData } from '../lib/spaces';
import { useNotificationCount } from '../lib/notifications';
import { OPEN_SEARCH } from './search/search-palette';

export default function Nav() {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unread, setUnread] = useState(0);
  const [menu, setMenu] = useState(false);
  const install = useInstall();
  const menuRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const notifications = useNotificationCount();

  // Total unread direct messages, refreshed on new DM activity and after reading.
  useEffect(() => {
    if (!user) { setUnread(0); return; }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        apiData<{ items: { unread: number }[] }>('/api/me/unreads')
          .then(page => { if (active) setUnread(page.items.reduce((sum, item) => sum + item.unread, 0)); })
          .catch(() => {});
      }, 400);
    };
    refresh();
    // On pages other than Home (which plays its own), chime for new direct messages.
    const chime = (data: { authorId?: string; parentId?: string }) => {
      if (!location.pathname.startsWith('/home') && data.authorId && data.authorId !== currentUserId() && !data.parentId) playMessageSound();
    };
    socket.on('dm:activity', chime);
    socket.on('dm:activity', refresh).on('space:activity', refresh).on('spaces:updated', refresh).on('read:updated', refresh).on('connect', refresh);
    window.addEventListener(DMS_CHANGED, refresh);
    return () => {
      active = false; clearTimeout(timer);
      socket.off('dm:activity', chime);
      socket.off('dm:activity', refresh).off('space:activity', refresh).off('spaces:updated', refresh).off('read:updated', refresh).off('connect', refresh);
      window.removeEventListener(DMS_CHANGED, refresh);
    };
  }, [user, pathname]);

  useEffect(() => setMenu(false), [pathname]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(false); };
    const esc = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [menu]);

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
          {link('/policies', 'Help & policies')}
        </div>
        {!loading && <div className="ml-auto flex items-center gap-2 text-sm">
          {user ? <>
            <button type="button" aria-label="Search (Ctrl+K)" title="Search (Ctrl+K)" onClick={() => window.dispatchEvent(new Event(OPEN_SEARCH))}
              className="rounded-xl p-2 text-white/65 hover:bg-[var(--surface-2)] hover:text-white"><Icon name="search" size={20} /></button>
            <Link href="/home?view=inbox" title="Notifications" aria-label={notifications ? `Notifications, ${notifications > 99 ? '99+' : notifications} unread` : 'Notifications'}
              className="relative rounded-xl p-2 text-white/65 hover:bg-[var(--surface-2)] hover:text-white"><Icon name="bell" size={20} />
              {notifications > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-rose-500 px-1 text-center text-[10px] font-semibold" style={{ color: '#fff' }}>{notifications > 99 ? '99+' : notifications}</span>}
            </Link>
            <Link href="/spaces/new" className="auth-button hidden h-10 sm:inline-flex"><Icon name="plus" size={16} />Create</Link>
            <div ref={menuRef} className="relative ml-1">
              <button type="button" aria-label="Account menu" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(value => !value)} className="rounded-full">
                <Avatar name={user.username} src={user.avatar_url} size={36} /></button>
              {menu && <div role="menu" className="card animate-in absolute right-0 z-40 mt-2 w-48 p-1 shadow-[var(--shadow-pop)]">
                {([[`/u/${user.username}`, 'Your profile'], ['/home?view=saved', 'Saved items'], ['/home?view=files', 'All files'], ['/settings', 'Settings'], ['/communities/manage', 'Manage communities'], ['/policies', 'Help & policies']] as const).map(([href, label]) =>
                  <Link key={href} role="menuitem" href={href} className="block rounded-lg px-3 py-2 text-sm hover:bg-[var(--surface-2)]">{label}</Link>)}
                {install && <button type="button" role="menuitem" onClick={() => { setMenu(false); void install(); }} className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)]">Install Hive</button>}
                <button type="button" role="menuitem" onClick={signOut} disabled={busy} className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)] disabled:opacity-40">Log out</button>
              </div>}
            </div>
          </> : <>
            <Link href="/login" className="rounded-xl px-3 py-2 font-medium text-white/70 hover:text-white">Log in</Link>
            <Link href="/signup" className="auth-button h-10">Sign up</Link>
          </>}
        </div>}
      </nav>
      {error && <p role="alert" className="pb-2 text-center text-sm text-rose-500">{error}</p>}
      {/* Phones: the main sections move to a bottom tab bar. */}
      <nav aria-label="Sections" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-white/10 bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden">
        {([['/home', 'Home', 'home'], ['/feed', 'Feed', 'layers'], ['/spaces', 'Explore', 'compass'], [user ? '/settings' : '/login', user ? 'You' : 'Log in', 'users']] as const).map(([href, label, icon]) => {
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
