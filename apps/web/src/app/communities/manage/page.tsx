'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../../lib/auth';
import { apiData, requestError, sortSpaces, SPACES_CHANGED, type Space } from '../../../lib/spaces';
import { socket } from '../../../lib/socket';
import { Avatar } from '../../../components/ui/avatar';
import { Icon } from '../../../components/ui/icons';
import { SpaceKind } from '../../../components/ui/space-kind';

export default function ManageCommunities() {
  const { user, loading } = useAuth();
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [owner, setOwner] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const viewer = useRef(user?.id);
  viewer.current = user?.id;
  const generation = useRef(0);
  const load = useCallback(async () => {
    const account = user?.id;
    if (!account) return;
    const version = ++generation.current;
    try {
      const data = await apiData<Space[]>('/api/me/spaces');
      if (version === generation.current && account === viewer.current) { setSpaces(sortSpaces(data)); setOwner(account); setError(''); }
    } catch (cause) { if (version === generation.current && account === viewer.current) setError(requestError(cause)); }
  }, [user?.id]);
  useEffect(() => {
    setSpaces(null); setError('');
    if (!user) return;
    void load();
    const refresh = () => void load();
    socket.on('spaces:updated', refresh).on('connect', refresh);
    return () => { generation.current++; socket.off('spaces:updated', refresh).off('connect', refresh); };
  }, [user?.id, load]);
  const visibleSpaces = owner === user?.id ? spaces : null;
  async function change(space: Space, body: object) {
    setBusy(true); setError('');
    try { await apiData(`/api/me/spaces/${space.slug}`, { method: 'PATCH', body: JSON.stringify(body) }); await load(); window.dispatchEvent(new Event(SPACES_CHANGED)); }
    catch (cause) { setError(requestError(cause)); } finally { setBusy(false); }
  }
  async function move(index: number, offset: number) {
    const account = user?.id;
    const next = [...spaces!]; [next[index], next[index+offset]] = [next[index+offset], next[index]];
    setBusy(true); setError('');
    try { await apiData('/api/me/spaces/order', { method: 'PUT', body: JSON.stringify({ slugs: next.map(space => space.slug) }) }); if (account === viewer.current) setSpaces(next); window.dispatchEvent(new Event(SPACES_CHANGED)); }
    catch (cause) { setError(requestError(cause)); } finally { setBusy(false); }
  }
  if (!loading && !user) return <main className="mx-auto max-w-5xl p-8"><h1 className="text-3xl font-bold">Manage communities</h1><Link className="auth-button mt-4" href="/login?next=/communities/manage">Log in to manage your spaces</Link></main>;
  return <main className="mx-auto max-w-5xl space-y-6 px-4 py-8"><header><h1 className="text-3xl font-extrabold">Manage communities</h1><p className="mt-2 text-white/65">Your communities and private workspaces, in the order that works for you.</p><p className="mt-2 text-sm text-white/60">Favourites stay first. Muting hides ordinary activity from totals; mentions and direct messages still reach you.</p></header>
    {error && <p role="alert" className="text-rose-500">{error} <button className="underline" onClick={() => void load()}>Retry</button></p>}
    {visibleSpaces === null && !error && <div role="status" aria-label="Fetching your spaces" className="space-y-3">{[1,2,3].map(i => <div key={i} className="card h-28 animate-pulse bg-white/5" />)}</div>}
    <ul className="space-y-4">{visibleSpaces?.map((space, index) => <li key={space.id} className="card flex min-w-0 flex-col gap-4 p-4 sm:flex-row sm:items-center">
      <Avatar name={space.name} size={44} square /><div className="min-w-0 flex-1"><Link className="break-words font-bold hover:text-brand" href={`/s/${space.slug}`}>{space.name}</Link><p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-white/60"><SpaceKind space={space} /><span className="rounded-full bg-brand-soft px-2 py-0.5 text-brand">{space.role}</span><span>{space.member_count} members</span></p>{space.my_role === 'owner' && <p className="mt-2 text-xs text-white/60">Owners cannot leave a space they own.</p>}</div>
      <div className="flex flex-wrap items-center gap-2"><button type="button" role="switch" aria-checked={space.muted} aria-label={`Mute ${space.name}`} disabled={busy} className="btn-ghost" onClick={() => void change(space, { muted: !space.muted })}><Icon name="bell" />{space.muted ? 'Muted' : 'Mute'}</button><button type="button" title={`Favourite ${space.name}`} aria-label={`Favourite ${space.name}`} aria-pressed={space.favorite} disabled={busy} className={`btn-ghost ${space.favorite ? 'text-brand' : ''}`} onClick={() => void change(space, { favorite: !space.favorite })}><Icon name="star" /></button>
        <button type="button" title={`Move ${space.name} up`} aria-label={`Move ${space.name} up`} className="btn-ghost" disabled={busy || index === 0 || visibleSpaces[index-1]?.favorite !== space.favorite} onClick={() => void move(index, -1)}>Up</button><button type="button" title={`Move ${space.name} down`} aria-label={`Move ${space.name} down`} className="btn-ghost" disabled={busy || index === visibleSpaces.length-1 || visibleSpaces[index+1]?.favorite !== space.favorite} onClick={() => void move(index, 1)}>Down</button>
        <button type="button" className="btn-ghost text-rose-500" disabled={busy || space.my_role === 'owner'} title={space.my_role === 'owner' ? 'Owners cannot leave their space' : `Leave ${space.name}`} onClick={async () => {
          if (!window.confirm(`Leave ${space.name}? You can join public communities again later.`)) return;
          setBusy(true); setError('');
          try { await apiData(`/api/spaces/${space.slug}/members/me`, { method: 'DELETE' }); await load(); window.dispatchEvent(new Event(SPACES_CHANGED)); }
          catch (cause) { setError(requestError(cause)); } finally { setBusy(false); }
        }}>Leave</button></div>
    </li>)}</ul>
    {visibleSpaces?.length === 0 && <div className="card flex flex-col items-center gap-3 p-8"><Icon name="users" size={32} /><p>You haven’t joined any spaces yet.</p><Link href="/spaces" className="auth-button">Explore communities</Link></div>}
  </main>;
}
