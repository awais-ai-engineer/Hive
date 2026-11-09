'use client';

import { Avatar, colourFor } from '../../../components/ui/avatar';
import { Icon, type IconName } from '../../../components/ui/icons';
import { CommunityGames } from '../../../components/communities/community-side';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../../lib/auth';
import { socket } from '../../../lib/socket';
import { SpaceKind } from '../../../components/ui/space-kind';
import { ChannelChat } from '../../../components/channel-chat';
import { PostFeed } from '../../../components/posts/post-feed';
import { CategoryChips } from '../../../components/communities/category-chips';
import { JoinCommunity, RulesCard } from '../../../components/communities/rules';
import { apiData, requestError, spaceKindLabel, type Channel, type Member, type Space } from '../../../lib/spaces';

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
  const tab = search.get('tab') ?? (space?.type === 'community' ? 'posts' : 'chat');
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
      const params = new URLSearchParams(search.toString());
      params.set('c', channels[0].id);
      router.replace(`/s/${slug}?${params}`);
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
  const isMember = !!space?.my_role && space.my_role !== 'guest';
  const navLink = (href: string, icon: IconName, label: string, active = false) => <li><Link href={href} aria-current={active ? 'page' : undefined}
    className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[14px] transition ${active ? 'bg-[var(--sidebar-active)] font-semibold' : 'text-white/75 hover:bg-white/[0.06]'}`}>
    <Icon name={icon} size={16} className="shrink-0 opacity-75" />{label}</Link></li>;
  return <main className="mx-auto grid max-w-7xl gap-6 px-4 py-6 md:grid-cols-[250px_1fr] xl:grid-cols-[250px_1fr_300px]">
    <aside className="on-sidebar flex flex-col gap-4 rounded-2xl border border-[var(--border)] bg-[var(--sidebar)] p-4 md:sticky md:top-20 md:max-h-[calc(100dvh-6rem)] md:overflow-y-auto">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-sm font-bold" style={{ background: space ? colourFor(space.slug) : 'var(--surface-2)', color: '#fff' }}>
          {space?.name.split(/\s+/).slice(0, 2).map(word => word[0]?.toUpperCase()).join('') ?? '?'}</span>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-bold">{space?.name ?? (error === 'Space not found' ? 'Space not found' : 'Space')}</h1>
          {space && <p className="flex items-center gap-1 text-xs text-white/55"><SpaceKind space={space} />{spaceKindLabel(space)} · {space.member_count} members · {online.length} online</p>}
        </div>
      </div>
      {space && <>
        <div className="flex gap-2">
          {!space.my_role && space.type === 'community' && <JoinCommunity space={space} onJoined={() => void load()} />}
          {canLeave && <button disabled={busy} onClick={() => { if (window.confirm(`Leave ${space.name}? You can join again later if it is public.`)) void changeMembership('leave'); }} title="You are a member. Click to leave."
            className="btn-ghost flex-1 justify-center"><Icon name="check" size={15} />Joined</button>}
        </div>
        <CategoryChips space={space} />
        <ul className="space-y-0.5">
          {navLink(`/s/${slug}?tab=posts${selected ? `&c=${selected}` : ''}`, 'home', 'Home feed', tab === 'posts')}
          {navLink(`/s/${slug}/members`, 'users', 'Members')}
          {space.type === 'community' && isMember && navLink(`/s/${slug}/games`, 'gaming', 'Games')}
          {canAdmin && navLink(`/s/${slug}/settings`, 'settings', 'Settings')}
        </ul>
        <div>
          <p className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-white/50">Chat rooms</p>
          <ul className="space-y-0.5">{channels.map(item => <li key={item.id}>
            <button onClick={() => router.replace(`/s/${slug}?tab=chat&c=${item.id}`)}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[14px] ${tab === 'chat' && item.id === channel?.id ? 'bg-[var(--sidebar-active)] font-semibold' : 'text-white/75 hover:bg-white/[0.06]'}`}>
              <Icon name={item.type === 'voice' ? 'volume' : item.is_private ? 'lock' : 'hash'} size={15} className="shrink-0 opacity-60" />
              <span className={`truncate ${item.unread && item.id !== channel?.id ? 'font-semibold' : ''}`}>{item.name}</span>
              {item.unread > 0 && item.id !== channel?.id && <span aria-label={`${item.unread} unread`}
                className="ml-auto rounded-full bg-brand px-1.5 text-xs font-semibold" style={{ color: 'var(--on-brand)' }}>{item.unread > 99 ? '99+' : item.unread}</span>}
            </button>
          </li>)}</ul>
        </div>
        {space.type === 'community' && <div className="mt-auto"><RulesCard slug={slug} /></div>}
      </>}
    </aside>
    <section className="min-h-80 min-w-0">
      {space && <div className="mb-4">
        <h2 className="text-2xl font-bold">{tab === 'posts' ? 'Home feed' : `#${channel?.name ?? ''}`}</h2>
        <p className="text-sm text-white/55">{tab === 'posts' ? `Posts from ${space.name}, ranked by what’s active right now.` : channel?.topic || `Chat with the ${space.name} community.`}</p>
      </div>}
      {error && <p role="alert" className={error === 'Loading space…' ? 'text-white/50' : 'text-rose-400'}>{error}</p>}
      {space && tab === 'posts' && <>
        {space.my_role && rank[space.my_role] >= rank.member && <Link href={`/s/${slug}/submit`}
          className="card mb-4 flex items-center gap-3 p-3 transition hover:border-[var(--brand)]">
          {user && <Avatar name={user.username} src={user.avatar_url} size={32} />}
          <span className="flex-1 rounded-xl border border-[var(--border)] px-3 py-2 text-sm text-white/50">Share something with {space.name}</span>
          <span className="hidden items-center gap-3 text-sm text-white/60 sm:flex"><Icon name="image" size={16} /><Icon name="video" size={16} /><Icon name="share" size={16} /></span>
          <span className="rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white">Post</span>
        </Link>}
        <PostFeed space={space} />
      </>}
      {space && tab === 'chat' && channel && <div className="card p-3 sm:p-5"><ChannelChat key={`${channel.id}:${user?.id ?? 'anonymous'}`} channel={channel} channels={channels} space={space} placeholder={`Message #${channel.name}`}
        reason={channel.type === 'voice' ? 'Voice rooms coming soon' : !user ? 'Log in to chat'
          : !space.my_role ? 'Join this space to chat' : space.my_role === 'guest' ? 'You have read-only access' : ''}
        canModerate={!!space.my_role && rank[space.my_role] >= rank.moderator} tracksReads={!!space.my_role} onRead={clearUnread} /></div>}
    </section>
    <aside className="hidden xl:block">{space?.type === 'community' && isMember && <div className="sticky top-20"><CommunityGames slug={slug} /></div>}</aside>
  </main>;
}
