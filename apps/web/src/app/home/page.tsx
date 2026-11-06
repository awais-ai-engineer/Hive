'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ChannelChat } from '../../components/channel-chat';
import { PostFeed } from '../../components/posts/post-feed';
import { ChatHeader } from '../../components/home/chat-header';
import { Rail } from '../../components/home/rail';
import { Sidebar } from '../../components/home/sidebar';
import { ThreadsView } from '../../components/home/threads-view';
import { UnreadsView } from '../../components/home/unreads-view';
import { DraftsView } from '../../components/home/drafts-view';
import { useAuth } from '../../lib/auth';
import { conversationTitle, DMS_CHANGED, type Conversation } from '../../lib/dms';
import { loadSetting, placeHref, saveSetting, type Place, type ThreadItem, type UnreadItem } from '../../lib/home';
import { socket } from '../../lib/socket';
import { apiData, requestError, SPACES_CHANGED, type Channel, type Space } from '../../lib/spaces';

const rank: Record<string, number> = { owner: 5, admin: 4, moderator: 3, member: 2, guest: 1 };
const LAST_SPACE = 'hive:last-space';

export default function HomePage() {
  return <Suspense fallback={<p className="p-8 text-white/50">Loading…</p>}><Home /></Suspense>;
}

/** Calls `fn` once, `delay` ms after the last call (collapses bursts of socket events). */
function useDebounced(fn: () => void, delay: number) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => latest.current(), delay);
  }, [delay]);
}

function Home() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const search = useSearchParams();
  const slugParam = search.get('s');
  const selected = search.get('c');
  const view = search.get('view');
  const threadParam = search.get('t');
  const tab = search.get('tab') === 'posts' ? 'posts' : 'messages';

  const [spaces, setSpaces] = useState<Space[]>([]);
  const [spacesReady, setSpacesReady] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [unreads, setUnreads] = useState<UnreadItem[]>([]);
  const [unreadsReady, setUnreadsReady] = useState(false);
  const [threadsUnread, setThreadsUnread] = useState(0);
  const [threadsVersion, setThreadsVersion] = useState(0);
  const [error, setError] = useState('');
  const [drawer, setDrawer] = useState(false);

  const slug = slugParam ?? (spacesReady ? loadSetting<string | null>(LAST_SPACE, null) ?? spaces[0]?.slug ?? null : null);
  const space = spaces.find(item => item.slug === slug) ?? null;

  const go = useCallback((params: Record<string, string | null | undefined>) => {
    const next = new URLSearchParams();
    const merged = { s: slug, ...params };
    for (const [key, value] of Object.entries(merged)) if (value) next.set(key, value);
    router.push(`/home?${next}`);
    setDrawer(false);
  }, [router, slug]);

  // Data loading -------------------------------------------------------------------------
  useEffect(() => {
    if (loading || !user) return;
    const refresh = () => apiData<Space[]>('/api/me/spaces').then(list => { setSpaces(list); setSpacesReady(true); })
      .catch(cause => { setError(requestError(cause)); setSpacesReady(true); });
    void refresh();
    socket.on('spaces:updated', refresh).on('space:activity', refresh).on('read:updated', refresh).on('connect', refresh);
    window.addEventListener(SPACES_CHANGED, refresh);
    return () => { socket.off('spaces:updated', refresh).off('space:activity', refresh).off('read:updated', refresh).off('connect', refresh); window.removeEventListener(SPACES_CHANGED, refresh); };
  }, [loading, user]);

  const spaceSlug = space?.slug ?? null;
  const loadChannels = useCallback(async () => {
    if (!spaceSlug) return [];
    const list = await apiData<Channel[]>(`/api/spaces/${encodeURIComponent(spaceSlug)}/channels`);
    setChannels(list);
    return list;
  }, [spaceSlug]);
  useEffect(() => {
    if (!spaceSlug) { setChannels([]); return; }
    saveSetting(LAST_SPACE, spaceSlug);
    loadChannels().catch(cause => setError(requestError(cause)));
  }, [spaceSlug, loadChannels]);

  const loadConversations = useCallback(() => {
    apiData<Conversation[]>('/api/dms').then(setConversations).catch(() => {});
  }, []);
  const loadUnreads = useCallback(() => {
    apiData<{ items: UnreadItem[] }>('/api/me/unreads')
      .then(page => { setUnreads(page.items); setUnreadsReady(true); }).catch(() => {});
  }, []);
  const loadThreads = useCallback(() => {
    apiData<{ items: ThreadItem[] }>('/api/me/threads?limit=50')
      .then(page => setThreadsUnread(page.items.filter(item => item.unread_replies > 0).length)).catch(() => {});
  }, []);
  const refreshConversations = useDebounced(loadConversations, 300);
  const refreshUnreads = useDebounced(loadUnreads, 400);
  const refreshThreads = useDebounced(() => { loadThreads(); setThreadsVersion(value => value + 1); }, 400);

  useEffect(() => {
    if (loading || !user) return;
    loadConversations(); loadUnreads(); loadThreads();
  }, [loading, user, loadConversations, loadUnreads, loadThreads]);

  // Live updates --------------------------------------------------------------------------
  useEffect(() => {
    if (!user || !space) return;
    const watch = () => { if (socket.connected) socket.emit('space:watch', { spaceId: space.id }, () => {}); };
    watch();
    socket.on('connect', watch);
    return () => {
      socket.off('connect', watch);
      if (socket.connected) socket.emit('space:unwatch', { spaceId: space.id }, () => {});
    };
  }, [user, space]);

  useEffect(() => {
    if (!user) return;
    const onChannelActivity = (data: { channelId: string; authorId: string }) => {
      if (data.authorId === user.id) return;
      if (data.channelId !== selected) {
        setChannels(list => list.map(item => item.id === data.channelId ? { ...item, unread: item.unread + 1 } : item));
      }
      refreshUnreads();
    };
    const onDm = () => { refreshConversations(); refreshUnreads(); };
    const onRead = (data: { channelId: string }) => {
      setChannels(list => list.map(item => item.id === data.channelId ? { ...item, unread: 0 } : item));
      refreshConversations(); refreshUnreads();
    };
    const onPresence = (data: { userId: string; online: boolean }) => setConversations(list => list.map(item => ({
      ...item, participants: item.participants.map(person => person.id === data.userId ? { ...person, online: data.online } : person),
    })));
    const onReconnect = () => { refreshConversations(); refreshUnreads(); refreshThreads(); };
    socket.on('channel:activity', onChannelActivity).on('dm:activity', onDm).on('read:updated', onRead)
      .on('space:activity', refreshUnreads).on('spaces:updated', refreshUnreads)
      .on('thread:activity', refreshThreads).on('thread:read', refreshThreads).on('presence', onPresence).on('connect', onReconnect);
    return () => {
      socket.off('channel:activity', onChannelActivity).off('dm:activity', onDm).off('read:updated', onRead)
        .off('space:activity', refreshUnreads).off('spaces:updated', refreshUnreads)
        .off('thread:activity', refreshThreads).off('thread:read', refreshThreads).off('presence', onPresence).off('connect', onReconnect);
    };
  }, [user, selected, refreshConversations, refreshUnreads, refreshThreads]);

  // Private channels appear or disappear when someone adds or removes the viewer.
  useEffect(() => {
    if (!user) return;
    const onChannelChange = (data: { channelId: string; spaceId: string }, removed: boolean) => {
      if (data.spaceId !== space?.id) return;
      loadChannels().catch(() => {});
      if (removed && data.channelId === selected) go({ c: null });
    };
    const onAdded = (data: { channelId: string; spaceId: string }) => onChannelChange(data, false);
    const onRemoved = (data: { channelId: string; spaceId: string }) => onChannelChange(data, true);
    socket.on('channel:added', onAdded).on('channel:removed', onRemoved);
    return () => { socket.off('channel:added', onAdded).off('channel:removed', onRemoved); };
  }, [user, space?.id, selected, loadChannels, go]);

  async function channelCreated(created: Channel) {
    await loadChannels().catch(() => {});
    go({ c: created.id });
  }

  const markRead = useCallback((channelId: string) => {
    setChannels(list => list.map(item => item.id === channelId && item.unread ? { ...item, unread: 0 } : item));
    setConversations(list => list.map(item => item.id === channelId && item.unread ? { ...item, unread: 0 } : item));
    window.dispatchEvent(new Event(DMS_CHANGED));
    refreshUnreads();
  }, [refreshUnreads]);

  useEffect(() => { if (threadParam) refreshThreads(); }, [threadParam, refreshThreads]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setDrawer(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  // Actions ------------------------------------------------------------------------------
  async function openPerson(username: string) {
    try {
      const conversation = await apiData<Conversation>('/api/dms', { method: 'POST', body: JSON.stringify({ usernames: [username] }) });
      loadConversations();
      go({ c: conversation.id });
    } catch (cause) { setError(requestError(cause)); }
  }
  function openPlace(place: Place, threadId?: string) {
    router.push(placeHref(place, slug, threadId));
    setDrawer(false);
  }
  function markUnreadItem(item: UnreadItem) {
    const newest = item.items.at(-1)?.id;
    if (newest && socket.connected) socket.emit('read:update', { channelId: item.channel.id, messageId: newest }, () => {});
    setUnreads(list => list.filter(entry => entry.channel.id !== item.channel.id));
    markRead(item.channel.id);
  }

  // Render -------------------------------------------------------------------------------
  if (!loading && !user) {
    return <main className="mx-auto max-w-md px-4 py-16 text-center">
      <h1 className="mb-3 text-2xl font-bold">Home</h1>
      <p className="text-white/60"><Link className="text-amber-400" href="/login?next=/home">Log in</Link> to see your channels and conversations.</p>
    </main>;
  }

  const conversation = conversations.find(item => item.id === selected) ?? null;
  const channel = channels.find(item => item.id === selected) ?? null;
  const myRank = space?.my_role ? rank[space.my_role] : 0;
  const unreadTotal = unreads.reduce((sum, item) => sum + item.unread, 0);
  const showView = view === 'unreads' || view === 'threads' || view === 'drafts' || (!conversation && !channel);
  const threadChange = (id: string | null) => go({ c: selected, t: id });

  let main;
  if (conversation) {
    main = <>
      <ChatHeader conversation={conversation} onMenu={() => setDrawer(true)} />
      <ChannelChat key={conversation.id} channel={{ id: conversation.id, name: conversationTitle(conversation) }}
        placeholder={`Message ${conversationTitle(conversation)}`} reason={conversation.read_only ? 'Hive reminders are read-only' : ''} canModerate={false} tracksReads onRead={markRead}
        threadId={threadParam} onThreadChange={threadChange} />
    </>;
  } else if (channel && space) {
    main = <>
      <ChatHeader channel={channel} space={space} tab={tab} onTab={next => go({ c: channel.id, tab: next === 'posts' ? 'posts' : null })}
        onMenu={() => setDrawer(true)}
        onLeft={() => { void loadChannels().catch(() => {}); go({ c: null }); }} />
      {tab === 'posts' ? <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <Suspense fallback={<p className="text-white/50">Loading posts…</p>}><PostFeed space={space} /></Suspense>
      </div> : <ChannelChat key={channel.id} channel={channel} channels={channels} space={space} placeholder={`Message #${channel.name}`}
        reason={channel.type === 'voice' ? 'Voice rooms coming soon' : !space.my_role ? 'Join this space to chat'
          : space.my_role === 'guest' ? 'You have read-only access' : ''}
        canModerate={myRank >= rank.moderator} tracksReads={!!space.my_role} onRead={markRead}
        threadId={threadParam} onThreadChange={threadChange} />}
    </>;
  } else if (view === 'drafts') {
    main = <>
      <ChatHeader title="Drafts & scheduled" onMenu={() => setDrawer(true)} />
      <DraftsView onOpen={(place, threadId) => openPlace(place, threadId ?? undefined)} />
    </>;
  } else if (view === 'threads') {
    main = <>
      <ChatHeader title="Threads" onMenu={() => setDrawer(true)} />
      <ThreadsView version={threadsVersion} userId={user?.id} onOpen={item => openPlace(item.channel, item.parent.id)} />
    </>;
  } else {
    main = <>
      <ChatHeader title="Unreads" onMenu={() => setDrawer(true)} />
      {selected && conversations.length + channels.length > 0 && <p className="mb-3 text-sm text-white/50">That conversation isn&apos;t in this space. Showing your unread messages instead.</p>}
      <UnreadsView items={unreads} ready={unreadsReady} userId={user?.id} onOpen={(place, threadId) => openPlace(place, threadId)} onMarkRead={markUnreadItem} />
    </>;
  }

  // Full-screen app shell: workspace rail, purple sidebar, then the open conversation.
  return <main className="flex h-dvh overflow-hidden bg-canvas">
    {drawer && <button type="button" aria-label="Close sidebar" onClick={() => setDrawer(false)} className="fixed inset-0 z-30 bg-[rgb(0_0_0/0.5)] md:hidden" />}
    <div className={`${drawer ? 'fixed inset-y-0 left-0 z-40 flex' : 'hidden'} h-full md:static md:z-auto md:flex`}>
      <Rail spaces={spaces} current={space?.slug ?? null} onSwitch={next => go({ s: next })} unread={unreadTotal} />
      <aside className="h-full w-[min(80vw,280px)] md:w-[280px]">
        {spacesReady && !spaces.length && <p className="on-dark bg-[var(--sidebar-from)] px-4 pt-4 text-sm text-white/70">You haven&apos;t joined a space yet. <Link href="/spaces" className="underline">Browse spaces</Link> or <Link href="/spaces/new" className="underline">create one</Link>.</p>}
        <Sidebar spaces={spaces} space={space} channels={channels} conversations={conversations}
          selected={selected} view={showView && view !== 'threads' && view !== 'drafts' ? 'unreads' : view}
          unreadTotal={unreadTotal} threadsUnread={threadsUnread}
          onSwitchSpace={next => go({ s: next })} onOpen={id => go({ c: id })} onView={next => go({ view: next })}
          onPerson={username => void openPerson(username)} onChannelCreated={channel => void channelCreated(channel)} />
      </aside>
    </div>
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface px-3 py-3 sm:px-6 sm:py-4">
      {error && <p role="alert" className="mb-2 text-sm text-rose-500">{error}</p>}
      {main}
    </section>
  </main>;
}
