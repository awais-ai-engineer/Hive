'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../../lib/auth';
import { socket } from '../../../lib/socket';
import { ChannelChat } from '../../../components/channel-chat';
import { apiData, requestError, type Channel, type Member, type Space } from '../../../lib/spaces';

const rank: Record<string, number> = { owner: 5, admin: 4, moderator: 3, member: 2, guest: 1 };

export default function SpacePage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const { user, loading } = useAuth();
  const [space, setSpace] = useState<Space | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [error, setError] = useState('Loading space…');
  const [busy, setBusy] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);

  const load = useCallback(async () => {
    const [data, channelList] = await Promise.all([
      apiData<Space>(`/api/spaces/${encodeURIComponent(slug)}`),
      apiData<Channel[]>(`/api/spaces/${encodeURIComponent(slug)}/channels`),
    ]);
    setSpace(data); setChannels(channelList); setError('');
  }, [slug]);

  useEffect(() => {
    if (loading) return;
    let active = true;
    setError('Loading space…');
    Promise.all([
      apiData<Space>(`/api/spaces/${encodeURIComponent(slug)}`),
      apiData<Channel[]>(`/api/spaces/${encodeURIComponent(slug)}/channels`),
    ]).then(([data, channelList]) => {
      if (active) { setSpace(data); setChannels(channelList); setError(''); }
    }).catch(cause => { if (active) setError(requestError(cause)); });
    apiData<{ items: Member[] }>(`/api/spaces/${encodeURIComponent(slug)}/members`)
      .then(page => { if (active) setMembers(page.items); }).catch(() => {});
    return () => { active = false; };
  }, [slug, loading, user]);

  const selected = search.get('c');
  const channel = channels.find(item => item.id === selected) ?? channels[0];
  const clearUnread = useCallback((channelId: string) => {
    setChannels(list => list.map(item => item.id === channelId && item.unread ? { ...item, unread: 0 } : item));
  }, []);

  useEffect(() => {
    const onActivity = (data: { channelId: string; authorId: string }) => {
      if (data.authorId === user?.id || data.channelId === channel?.id) return;
      setChannels(list => list.map(item => item.id === data.channelId ? { ...item, unread: item.unread + 1 } : item));
    };
    const onRead = (data: { channelId: string }) => clearUnread(data.channelId);
    const onPresence = (data: { userId: string; online: boolean }) => {
      setMembers(list => list.map(item => item.user.id === data.userId ? { ...item, online: data.online } : item));
    };
    socket.on('channel:activity', onActivity).on('read:updated', onRead).on('presence', onPresence);
    return () => { socket.off('channel:activity', onActivity).off('read:updated', onRead).off('presence', onPresence); };
  }, [user?.id, channel?.id, clearUnread]);

  useEffect(() => {
    if (channels.length > 0 && !search.get('c')) {
      router.replace(`/s/${slug}?c=${channels[0].id}`);
    }
  }, [channels, search, slug, router]);

  async function changeMembership(action: 'join' | 'leave') {
    setBusy(true); setError('');
    try {
      if (!user) { router.push(`/login?next=${encodeURIComponent(`/s/${slug}`)}`); return; }
      await apiData(`/api/spaces/${encodeURIComponent(slug)}/${action === 'leave' ? 'members/me' : action}`, { method: action === 'join' ? 'POST' : 'DELETE' });
      await load();
    } catch (cause) { setError(requestError(cause)); }
    finally { setBusy(false); }
  }

  const online = members.filter(item => item.online);
  const canAdmin = space?.my_role && rank[space.my_role] >= rank.admin;
  const canLeave = space?.my_role && space.my_role !== 'owner';
  return <main className="mx-auto grid max-w-6xl gap-6 px-4 py-8 md:grid-cols-[240px_1fr]">
    <aside className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
      <h1 className="text-xl font-bold">{space?.name ?? (error === 'Space not found' ? 'Space not found' : 'Space')}</h1>
      {space && <>
        <p className="mt-1 text-sm text-white/50">{space.member_count} members</p>
        <Link className="mt-3 inline-block text-sm text-amber-400" href={`/s/${slug}/members`}>View members</Link>
        {canAdmin && <Link className="ml-3 inline-block text-sm text-amber-400" href={`/s/${slug}/settings`}>Settings</Link>}
        <h2 className="mb-2 mt-6 text-sm font-semibold uppercase text-white/50">Channels</h2>
        <ul className="space-y-1">{channels.map(item => <li key={item.id}>
          <button onClick={() => router.replace(`/s/${slug}?c=${item.id}`)}
            className={`w-full rounded px-2 py-1 text-left ${item.id === channel?.id ? 'bg-white/10 text-amber-400' : 'text-white/70'}`}>
            <span className="flex items-center justify-between gap-2">
              <span className={`truncate ${item.unread && item.id !== channel?.id ? 'font-semibold text-white' : ''}`}>{item.type === 'voice' ? '🔊' : '#'} {item.name}</span>
              {item.unread > 0 && item.id !== channel?.id && <span aria-label={`${item.unread} unread`}
                className="rounded-full bg-amber-400 px-1.5 text-xs font-semibold text-black">{item.unread > 99 ? '99+' : item.unread}</span>}
            </span>
          </button>
        </li>)}</ul>
        <h2 className="mb-2 mt-6 text-sm font-semibold uppercase text-white/50">Online — {online.length}</h2>
        <ul className="space-y-1 text-sm">{online.slice(0, 15).map(item => <li key={item.user.id} className="flex items-center gap-2 text-white/70">
          <span aria-hidden className="h-2 w-2 rounded-full bg-emerald-400" />
          <span className="truncate">{item.user.username}</span>
        </li>)}</ul>
      </>}
    </aside>
    <section className="min-h-80 min-w-0 rounded-xl border border-white/10 bg-white/[0.03] p-3 sm:p-6">
      {space && <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div><p className="text-sm uppercase text-white/50">{space.type}</p>
          <h2 className="text-2xl font-semibold">{channel?.name ?? space.name}</h2>
          {channel?.topic && <p className="mt-1 text-white/60">{channel.topic}</p>}
        </div>
        <div className="flex gap-2">
          {!space.my_role && space.type === 'community' && <button disabled={busy} onClick={() => changeMembership('join')} className="auth-button">Join</button>}
          {canLeave && <button disabled={busy} onClick={() => changeMembership('leave')} className="auth-button">Leave</button>}
        </div>
      </div>}
      {error && <p role="alert" className={error === 'Loading space…' ? 'text-white/50' : 'text-rose-400'}>{error}</p>}
      {space && channel && <ChannelChat key={`${channel.id}:${user?.id ?? 'anonymous'}`} channel={channel} space={space} onRead={clearUnread} />}
    </section>
  </main>;
}
