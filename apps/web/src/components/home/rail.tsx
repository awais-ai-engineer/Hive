'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { sortSpaces, spaceKindLabel, type Space } from '../../lib/spaces';
import { Avatar, colourFor } from '../ui/avatar';
import { Icon, Logo, type IconName } from '../ui/icons';
import { statusTitle } from '../../lib/status';
import { StatusDialog } from '../status-dialog';
import { PopupMenu } from './popup-menu';
import { useInstall } from '../../lib/push';
import { AskHive } from '../ai/ask-panel';

function useTheme() {
  const [dark, setDark] = useState(false);
  useEffect(() => { setDark(document.documentElement.classList.contains('dark')); }, []);
  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try { localStorage.setItem('hive:theme', next ? 'dark' : 'light'); } catch { /* storage unavailable */ }
  }
  return { dark, toggle };
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]!.toUpperCase()).join('') || '?';

/** The far-left strip: brand, one tile per space, and the user's own controls at the bottom. */
export function Rail({ spaces, current, onSwitch, unread, todos = 0 }: {
  spaces: Space[]; current: string | null; onSwitch: (slug: string) => void; unread: number; todos?: number;
}) {
  const { user, logout, updateUser } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const view = search.get('view');
  const isActive = (href: string) => {
    const [path, query] = href.split('?');
    if (pathname !== path) return false;
    const wanted = new URLSearchParams(query).get('view');
    return wanted ? view === wanted : path !== '/home' || !['inbox', 'todos'].includes(view ?? '');
  };
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const install = useInstall();
  const [settingStatus, setSettingStatus] = useState(false);
  const { dark, toggle } = useTheme();
  const ordered = sortSpaces(spaces);
  const favorites = ordered.filter(space => space.favorite);
  const workspaces = ordered.filter(space => space.type === 'workspace' && !space.favorite);
  const communities = ordered.filter(space => space.type === 'community' && !space.favorite);
  const tileFor = (space: Space) => {
    const active = space.slug === current;
    const label = `${space.name} (${spaceKindLabel(space)})`;
    return <button key={space.id} type="button" title={label} aria-label={label} aria-current={active ? 'page' : undefined}
      onClick={() => onSwitch(space.slug)}
      className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[13px] font-bold transition ${active ? 'ring-2 ring-[var(--brand)] ring-offset-2 ring-offset-[var(--rail)]' : 'opacity-85 hover:opacity-100'}`}
      style={{ background: colourFor(space.slug) }}>
      <span style={{ color: '#fff' }}>{initials(space.name)}</span>
      {space.unread > 0 && <span className="absolute -right-1.5 -top-1.5 min-w-[18px] rounded-full bg-brand px-1 text-center text-[10px] font-semibold leading-[18px]" style={{ color: 'var(--on-brand)' }} aria-label={`${space.unread} unread`}>{space.unread > 99 ? '99+' : space.unread}</span>}
      {space.type === 'workspace' && <span aria-hidden className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--rail)]" style={{ color: '#fff' }}>
        <Icon name="lock" size={9} /></span>}
    </button>;
  };
  const navItem = (href: string, icon: IconName, label: string, badge = 0, badgeTone: 'brand' | 'alert' = 'brand') => {
    const active = isActive(href);
    return <Link href={href} title={label} aria-label={badge ? `${label}, ${badge > 99 ? '99+' : badge}` : label} aria-current={active ? 'page' : undefined}
      className={`relative flex w-14 flex-col items-center gap-0.5 rounded-xl py-1.5 text-[10.5px] font-medium transition ${active ? 'bg-white/[0.12] text-white' : 'text-white/65 hover:bg-white/[0.08] hover:text-white'}`}>
      <Icon name={icon} size={19} />{label}
      {badge > 0 && <span className={`absolute right-2 top-0.5 min-w-[17px] rounded-full px-1 text-center text-[10px] font-semibold leading-[17px] ${badgeTone === 'alert' ? 'bg-rose-500' : 'bg-brand'}`}
        style={{ color: badgeTone === 'alert' ? '#fff' : 'var(--on-brand)' }}>{badge > 99 ? '99+' : badge}</span>}
    </Link>;
  };
  const group = (title: string, list: Space[]) => list.length > 0 && <>
    <p className="mt-3 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-white/45">{title}</p>
    {list.map(tileFor)}
  </>;
  return <nav aria-label="Spaces" className="on-dark flex h-full w-[76px] shrink-0 flex-col items-center gap-1 bg-[var(--rail)] py-3">
    <Link href="/home" aria-label="Hive home" className="mb-2"><Logo size={32} /></Link>
    {navItem('/home', 'home', 'Home')}
    {navItem('/home?view=inbox', 'bell', 'Activity', unread, 'alert')}
    {navItem('/home?view=todos', 'checkSquare', 'Tasks', todos)}
    {navItem('/spaces', 'compass', 'Explore')}
    {navItem('/games', 'gaming', 'Games')}
    <div className="mt-1 flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto px-2 pb-2 [scrollbar-width:none]">
      {group('Starred', favorites)}
      {group('Work', workspaces)}
      {group('Social', communities)}
      <Link href="/spaces/new" title="Create a space" aria-label="Create a space" className="mt-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dashed border-white/25 text-white/70 transition hover:border-white/60 hover:text-white">
        <Icon name="plus" />
      </Link>
    </div>
    <AskHive />
    <button type="button" onClick={toggle} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} title={dark ? 'Light theme' : 'Dark theme'}
      className="flex h-9 w-9 items-center justify-center rounded-xl text-white/65 transition hover:bg-white/[0.08] hover:text-white"><Icon name={dark ? 'sun' : 'moon'} size={18} /></button>
    {user && <div className="relative mt-1">
      <button type="button" aria-label="Your account menu" aria-haspopup="menu" aria-expanded={!!menu} title={statusTitle(user) ?? 'Your account'}
        onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setMenu({ x: box.right + 8, y: box.top - 120 }); }}>
        <Avatar name={user.username} src={user.avatar_url} size={40} online />
        {user.status_emoji && <span aria-hidden className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--surface)] text-[11px] shadow">{user.status_emoji}</span>}
      </button>
    </div>}
    {menu && <PopupMenu at={menu} label="Account" onClose={() => setMenu(null)} items={[
      { label: 'Set a status', icon: 'smile', onSelect: () => setSettingStatus(true) },
      { label: 'Settings and profile', icon: 'settings', onSelect: () => router.push('/settings') },
      { label: 'Manage communities', icon: 'users', onSelect: () => router.push('/communities/manage') },
      { label: 'Help & policies', icon: 'file', onSelect: () => router.push('/policies') },
      ...(install ? [{ label: 'Install Hive', icon: 'download' as const, onSelect: () => void install() }] : []),
      { separator: true },
      { label: 'Log out', icon: 'logout', onSelect: () => void logout() },
    ]} />}
    {settingStatus && user && <StatusDialog user={user} onSaved={updateUser} onClose={() => setSettingStatus(false)} />}
  </nav>;
}
