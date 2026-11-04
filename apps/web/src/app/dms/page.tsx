'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ChannelChat } from '../../components/channel-chat';
import { useAuth } from '../../lib/auth';
import {
  conversationTitle, DMS_CHANGED, preview, shortTime, type Conversation, type UserResult,
} from '../../lib/dms';
import { socket } from '../../lib/socket';
import { apiData, requestError } from '../../lib/spaces';

export default function MessagesPage() {
  return <Suspense fallback={<p className="p-8 text-white/50">Loading…</p>}><Messages /></Suspense>;
}

function Avatar({ conversation }: { conversation: Conversation }) {
  const first = conversation.participants[0];
  const online = conversation.participants.some(person => person.online);
  return <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-400/15 text-amber-400">
    {conversation.is_group ? conversation.participants.length + 1 : first?.username[0].toUpperCase()}
    {online && <span aria-label="Online" className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[#0b0d12] bg-emerald-400" />}
  </span>;
}

function NewConversation({ onOpened, onCancel }: { onOpened: (id: string) => void; onCancel: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserResult[]>([]);
  const [chosen, setChosen] = useState<UserResult[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    let active = true;
    const timer = setTimeout(() => {
      apiData<UserResult[]>(`/api/users/search?q=${encodeURIComponent(query.trim())}`)
        .then(found => { if (active) setResults(found); })
        .catch(cause => { if (active) setError(requestError(cause)); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [query]);

  async function start(event: FormEvent) {
    event.preventDefault();
    if (!chosen.length) return;
    setBusy(true); setError('');
    try {
      const conversation = await apiData<Conversation>('/api/dms', {
        method: 'POST', body: JSON.stringify({ usernames: chosen.map(person => person.username) }),
      });
      onOpened(conversation.id);
    } catch (cause) { setError(requestError(cause)); }
    finally { setBusy(false); }
  }

  const available = results.filter(result => !chosen.some(person => person.id === result.id));
  return <form onSubmit={start} className="mb-4 rounded-lg border border-white/10 p-3">
    {chosen.length > 0 && <ul className="mb-2 flex flex-wrap gap-1">{chosen.map(person => <li key={person.id}
      className="flex items-center gap-1 rounded-full bg-amber-400/15 px-2 py-0.5 text-sm text-amber-400">
      {person.username}
      <button type="button" aria-label={`Remove ${person.username}`} onClick={() => setChosen(list => list.filter(item => item.id !== person.id))}>×</button>
    </li>)}</ul>}
    <input autoFocus className="auth-input" aria-label="Search people" placeholder="Search by username"
      value={query} onChange={event => setQuery(event.target.value)} disabled={chosen.length >= 8} />
    {available.length > 0 && <ul className="mt-1 rounded border border-white/10">{available.map(result => <li key={result.id}>
      <button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-white/5"
        onClick={() => { setChosen(list => [...list, result]); setQuery(''); }}>{result.username}</button>
    </li>)}</ul>}
    {query.trim() && !available.length && <p className="mt-2 text-xs text-white/40">No one found. You can message people who share a space with you.</p>}
    {error && <p role="alert" className="mt-2 text-sm text-rose-400">{error}</p>}
    <div className="mt-3 flex justify-end gap-2 text-sm">
      <button type="button" onClick={onCancel} className="px-3 py-1 text-white/60">Cancel</button>
      <button disabled={!chosen.length || busy} className="auth-button">{chosen.length > 1 ? 'Start group' : 'Start chat'}</button>
    </div>
  </form>;
}

function Messages() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const search = useSearchParams();
  const selected = search.get('c');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [composing, setComposing] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try { setConversations(await apiData<Conversation[]>('/api/dms')); setError(''); }
    catch (cause) { setError(requestError(cause)); }
    finally { setReady(true); }
  }, []);

  useEffect(() => { if (!loading && user) void load(); }, [loading, user, load]);

  useEffect(() => {
    if (!user) return;
    const refresh = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => void load(), 300);
    };
    const onPresence = (data: { userId: string; online: boolean }) => setConversations(list => list.map(item => ({
      ...item, participants: item.participants.map(person => person.id === data.userId ? { ...person, online: data.online } : person),
    })));
    socket.on('dm:activity', refresh).on('read:updated', refresh).on('presence', onPresence).on('connect', refresh);
    return () => {
      socket.off('dm:activity', refresh).off('read:updated', refresh).off('presence', onPresence).off('connect', refresh);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [user, load]);

  const markRead = useCallback((channelId: string) => {
    setConversations(list => list.map(item => item.id === channelId ? { ...item, unread: 0 } : item));
    window.dispatchEvent(new Event(DMS_CHANGED));
  }, []);

  if (!loading && !user) {
    return <main className="mx-auto max-w-md px-4 py-16 text-center">
      <h1 className="mb-3 text-2xl font-bold">Messages</h1>
      <p className="text-white/60"><Link className="text-amber-400" href="/login?next=/dms">Log in</Link> to see your conversations.</p>
    </main>;
  }

  const open = (id: string) => { setComposing(false); router.replace(`/dms?c=${id}`); void load(); };
  const current = conversations.find(item => item.id === selected);
  return <main className="mx-auto grid max-w-6xl gap-6 px-4 py-8 md:grid-cols-[300px_1fr]">
    <aside className={`min-w-0 rounded-xl border border-white/10 bg-white/[0.03] p-4 ${current ? 'hidden md:block' : ''}`}>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold">Messages</h1>
        {!composing && <button onClick={() => setComposing(true)} className="text-sm text-amber-400">New message</button>}
      </div>
      {composing && <NewConversation onOpened={open} onCancel={() => setComposing(false)} />}
      {error && <p role="alert" className="mb-2 text-sm text-rose-400">{error}</p>}
      {!ready && <p className="text-sm text-white/50">Loading conversations…</p>}
      {ready && !conversations.length && !composing && <p className="text-sm text-white/40">No conversations yet. Start one with “New message”.</p>}
      <ul className="space-y-1">{conversations.map(conversation => {
        const active = conversation.id === selected;
        const unread = active ? 0 : conversation.unread;
        return <li key={conversation.id}>
          <button onClick={() => open(conversation.id)}
            className={`flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left ${active ? 'bg-white/10' : 'hover:bg-white/5'}`}>
            <Avatar conversation={conversation} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className={`truncate ${unread ? 'font-semibold text-white' : 'text-white/85'}`}>{conversationTitle(conversation)}</span>
                {conversation.last_message && <span className="shrink-0 text-xs text-white/40">{shortTime(conversation.last_message.created_at)}</span>}
              </span>
              <span className="flex items-center justify-between gap-2">
                <span className={`truncate text-sm ${unread ? 'text-white/80' : 'text-white/45'}`}>{preview(conversation, user?.id)}</span>
                {unread > 0 && <span aria-label={`${unread} unread`} className="shrink-0 rounded-full bg-amber-400 px-1.5 text-xs font-semibold text-black">{unread > 99 ? '99+' : unread}</span>}
              </span>
            </span>
          </button>
        </li>;
      })}</ul>
    </aside>
    <section className={`min-h-80 min-w-0 rounded-xl border border-white/10 bg-white/[0.03] p-3 sm:p-6 ${current ? '' : 'hidden md:block'}`}>
      {current ? <>
        <div className="mb-4 flex items-center gap-3">
          <button onClick={() => router.replace('/dms')} className="text-amber-400 md:hidden" aria-label="Back to conversations">←</button>
          <Avatar conversation={current} />
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">{conversationTitle(current)}</h2>
            <p className="text-xs text-white/50">{current.is_group
              ? `${current.participants.filter(person => person.online).length} of ${current.participants.length} online`
              : current.participants[0]?.online ? 'Online' : 'Offline'}</p>
          </div>
        </div>
        <ChannelChat key={current.id} channel={{ id: current.id, name: conversationTitle(current) }}
          placeholder={`Message ${conversationTitle(current)}`} reason="" canModerate={false} tracksReads onRead={markRead} />
      </> : <p className="mt-12 text-center text-white/40">{selected && ready ? 'Conversation not found' : 'Select a conversation or start a new one'}</p>}
    </section>
  </main>;
}
