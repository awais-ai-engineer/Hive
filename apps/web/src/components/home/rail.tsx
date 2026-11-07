'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { sortSpaces, spaceKindLabel, type Space } from '../../lib/spaces';
import { Avatar, colourFor } from '../ui/avatar';
import { Icon, Logo } from '../ui/icons';
import { statusTitle } from '../../lib/status';
import { StatusDialog } from '../status-dialog';
import { PopupMenu } from './popup-menu';

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

/** The far-left strip: brand, one tile per space, and the user's own controls at the bottom. */
export function Rail({ spaces, current, onSwitch, unread, todos = 0 }: {
  spaces: Space[]; current: string | null; onSwitch: (slug: string) => void; unread: number; todos?: number;
}) {
  const { user, logout, updateUser } = useAuth();
  const router = useRouter();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
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
      className={`${tile} relative shrink-0 text-base font-bold ${active ? 'ring-2 ring-white/90 ring-offset-2 ring-offset-[var(--rail)]' : 'opacity-80 hover:opacity-100 hover:rounded-xl'}`}
      style={{ background: colourFor(space.slug) }}>
      <span style={{ color: '#fff' }}>{space.name[0]?.toUpperCase()}</span>
      {space.unread > 0 && <span className="absolute -right-1 -top-1 rounded-full bg-brand px-1 text-[10px]" aria-label={`${space.unread} unread`}>{space.unread > 99 ? '99+' : space.unread}</span>}
      <span aria-hidden className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--rail)]" style={{ color: '#fff' }}>
        <Icon name={space.type === 'workspace' ? 'lock' : 'globe'} size={10} /></span>
    </button>;
  };
  const tile = 'flex h-11 w-11 items-center justify-center rounded-2xl transition';
  return <nav aria-label="Spaces" className="on-dark flex h-full w-[72px] shrink-0 flex-col items-center gap-2 bg-[var(--rail)] py-3">
    <Link href="/feed" aria-label="Feed" className="mb-2"><Logo size={34} /></Link>
    <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto px-2">
      {favorites.map(tileFor)}
      {favorites.length > 0 && <div role="separator" className="my-1 h-px w-8 bg-white/15" />}
      {workspaces.map(tileFor)}
      {workspaces.length > 0 && communities.length > 0 && <div role="separator" className="my-1 h-px w-8 bg-white/15" />}
      {communities.map(tileFor)}
      <Link href="/spaces/new" aria-label="Create a space" className={`${tile} border border-dashed border-white/25 text-white/70 hover:border-white/60 hover:text-white`}>
        <Icon name="plus" />
      </Link>
    </div>
    <Link href="/communities/manage" title="Manage communities" aria-label="Manage communities" className={`${tile} text-white/70 hover:bg-white/10`}><Icon name="settings" /></Link>
    <Link href="/policies" title="Help & policies" aria-label="Help & policies" className={`${tile} text-white/70 hover:bg-white/10`}><Icon name="file" /></Link>
    <Link href="/home?view=inbox" title="Notifications" aria-label={unread ? `Notifications, ${unread > 99 ? '99+' : unread} unread` : 'Notifications'} className={`${tile} relative text-white/70 hover:bg-white/10 hover:text-white`}>
      <Icon name="bell" size={20} />
      {unread > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-rose-500 px-1 text-center text-[10px] font-semibold" style={{ color: '#fff' }}>{unread > 99 ? '99+' : unread}</span>}
    </Link>
    <Link href="/home?view=todos" title="To-dos" aria-label={todos ? `To-dos, ${todos} due` : 'To-dos'} className={`${tile} relative text-white/70 hover:bg-white/10 hover:text-white`}>
      <Icon name="checkSquare" size={20} />
      {todos > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-brand px-1 text-center text-[10px] font-semibold" style={{ color: '#fff' }}>{todos > 99 ? '99+' : todos}</span>}
    </Link>
    <button type="button" onClick={toggle} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      className={`${tile} text-white/70 hover:bg-white/10 hover:text-white`}><Icon name={dark ? 'sun' : 'moon'} size={20} /></button>
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
      { separator: true },
      { label: 'Log out', icon: 'logout', onSelect: () => void logout() },
    ]} />}
    {settingStatus && user && <StatusDialog user={user} onSaved={updateUser} onClose={() => setSettingStatus(false)} />}
  </nav>;
}
