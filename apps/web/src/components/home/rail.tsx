'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { spaceKindLabel, type Space } from '../../lib/spaces';
import { Avatar, colourFor } from '../ui/avatar';
import { Icon, Logo } from '../ui/icons';

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
export function Rail({ spaces, current, onSwitch, unread }: {
  spaces: Space[]; current: string | null; onSwitch: (slug: string) => void; unread: number;
}) {
  const { user, logout } = useAuth();
  const { dark, toggle } = useTheme();
  const workspaces = spaces.filter(space => space.type === 'workspace');
  const communities = spaces.filter(space => space.type === 'community');
  const tileFor = (space: Space) => {
    const active = space.slug === current;
    const label = `${space.name} (${spaceKindLabel(space)})`;
    return <button key={space.id} type="button" title={label} aria-label={label} aria-current={active ? 'page' : undefined}
      onClick={() => onSwitch(space.slug)}
      className={`${tile} relative shrink-0 text-base font-bold ${active ? 'ring-2 ring-white/90 ring-offset-2 ring-offset-[var(--rail)]' : 'opacity-80 hover:opacity-100 hover:rounded-xl'}`}
      style={{ background: colourFor(space.slug) }}>
      <span style={{ color: '#fff' }}>{space.name[0]?.toUpperCase()}</span>
      <span aria-hidden className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--rail)]" style={{ color: '#fff' }}>
        <Icon name={space.type === 'workspace' ? 'lock' : 'globe'} size={10} /></span>
    </button>;
  };
  const tile = 'flex h-11 w-11 items-center justify-center rounded-2xl transition';
  return <nav aria-label="Spaces" className="on-dark flex h-full w-[72px] shrink-0 flex-col items-center gap-2 bg-[var(--rail)] py-3">
    <Link href="/feed" aria-label="Feed" className="mb-2"><Logo size={34} /></Link>
    <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto px-2">
      {workspaces.map(tileFor)}
      {workspaces.length > 0 && communities.length > 0 && <div role="separator" className="my-1 h-px w-8 bg-white/15" />}
      {communities.map(tileFor)}
      <Link href="/spaces/new" aria-label="Create a space" className={`${tile} border border-dashed border-white/25 text-white/70 hover:border-white/60 hover:text-white`}>
        <Icon name="plus" />
      </Link>
    </div>
    <Link href="/home?view=unreads" aria-label={unread ? `${unread} unread` : 'Unreads'} className={`${tile} relative text-white/70 hover:bg-white/10 hover:text-white`}>
      <Icon name="bell" size={20} />
      {unread > 0 && <span className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-rose-500" />}
    </Link>
    <button type="button" onClick={toggle} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      className={`${tile} text-white/70 hover:bg-white/10 hover:text-white`}><Icon name={dark ? 'sun' : 'moon'} size={20} /></button>
    {user && <div className="group relative mt-1">
      <Link href="/me" aria-label="Your profile"><Avatar name={user.username} src={user.avatar_url} size={40} online /></Link>
      <button type="button" onClick={() => void logout()} aria-label="Log out" title="Log out"
        className="absolute -right-1 -top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-[var(--surface)] text-[var(--fg)] shadow group-hover:flex group-focus-within:flex">
        <Icon name="logout" size={12} />
      </button>
    </div>}
  </nav>;
}
