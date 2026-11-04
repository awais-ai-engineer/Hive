'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth';
import { chatRequest, socket } from '../lib/socket';
import { requestError, type Channel, type Space } from '../lib/spaces';
import { useChannelMessages } from '../lib/use-channel-messages';

export function ChannelChat({ channel, space }: { channel: Channel; space: Space }) {
  const { user } = useAuth();
  const chat = useChannelMessages(channel.id);
  const [body, setBody] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [error, setError] = useState('');
  const [newMessages, setNewMessages] = useState(false);
  const [typers, setTypers] = useState<Record<string, { name: string; until: number }>>({});
  const list = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const started = useRef(false);
  const previousLast = useRef<string | undefined>(undefined);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const lastTyping = useRef(0);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reason = channel.type === 'voice' ? 'Voice rooms coming soon' : !user ? 'Log in to chat'
    : !space.my_role ? 'Join this space to chat' : space.my_role === 'guest' ? 'You have read-only access' : '';
  const canModerate = ['owner', 'admin', 'moderator'].includes(space.my_role ?? '');

  useLayoutEffect(() => {
    const element = list.current;
    if (!element || !chat.ready) return;
    const latest = chat.messages.at(-1)?.id;
    if (anchor.current) {
      element.scrollTop = anchor.current.top + element.scrollHeight - anchor.current.height;
      anchor.current = null;
    } else if (!started.current || nearBottom.current) {
      element.scrollTop = element.scrollHeight;
      setNewMessages(false);
    } else if (latest !== previousLast.current) setNewMessages(true);
    previousLast.current = latest;
    started.current = true;
  }, [chat.messages, chat.ready]);

  useEffect(() => {
    const onTyping = (data: { channelId: string; user: { id: string; username: string }; typing: boolean }) => {
      if (data.channelId !== channel.id || data.user.id === user?.id) return;
      setTypers(previous => {
        const next = { ...previous };
        if (data.typing) next[data.user.id] = { name: data.user.username, until: Date.now() + 5000 };
        else delete next[data.user.id];
        return next;
      });
    };
    socket.on('typing', onTyping);
    const timer = setInterval(() => setTypers(previous => Object.fromEntries(
      Object.entries(previous).filter(([, value]) => value.until > Date.now())
    )), 1000);
    return () => {
      socket.off('typing', onTyping); clearInterval(timer);
      if (idle.current) clearTimeout(idle.current);
      if (socket.connected) socket.emit('typing:stop', { channelId: channel.id });
    };
  }, [channel.id, user?.id]);

  function stopTyping() {
    if (idle.current) clearTimeout(idle.current);
    if (socket.connected) socket.emit('typing:stop', { channelId: channel.id });
  }
  function typing(value: string) {
    setBody(value);
    if (socket.connected && Date.now() - lastTyping.current >= 3000) {
      socket.emit('typing:start', { channelId: channel.id }); lastTyping.current = Date.now();
    }
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(stopTyping, 4000);
  }
  function send() {
    if (reason || !body.trim()) return;
    stopTyping(); nearBottom.current = true;
    void chat.send(body); setBody('');
  }
  async function edit(id: string) {
    try {
      await chatRequest('message:edit', { messageId: id, body: editBody });
      setEditing(null); setError('');
    } catch (cause) { setError(requestError(cause)); }
  }
  async function remove(id: string) {
    try { await chatRequest('message:delete', { messageId: id }); setError(''); }
    catch (cause) { setError(requestError(cause)); }
  }
  async function loadOlder() {
    if (!list.current || anchor.current || !chat.hasOlder) return;
    anchor.current = { height: list.current.scrollHeight, top: list.current.scrollTop };
    await chat.loadOlder();
    // A failed request does not produce a list update.
    requestAnimationFrame(() => { anchor.current = null; });
  }
  const names = Object.values(typers).map(value => value.name);
  const typingText = names.length > 2 ? 'Several people are typing…'
    : names.length === 2 ? `${names[0]} and ${names[1]} are typing…`
    : names.length === 1 ? `${names[0]} is typing…` : '';

  return <div className="min-w-0">
    {user && !chat.connected && <p role="status" className="mb-2 rounded bg-amber-400/10 px-3 py-2 text-sm text-amber-400">Reconnecting…</p>}
    {(error || chat.error) && <p role="alert" className="mb-2 text-sm text-rose-400">{error || chat.error}</p>}
    <div ref={list} aria-label="Channel messages" className="h-[50vh] min-h-64 overflow-y-auto overscroll-contain [overflow-anchor:none]"
      onScroll={() => {
        const element = list.current!;
        nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        if (nearBottom.current) setNewMessages(false);
        if (element.scrollTop < 20 && started.current) void loadOlder();
      }}>
      {chat.hasOlder && <button onClick={() => void loadOlder()} className="mb-4 w-full text-sm text-amber-400">Load older messages</button>}
      {!chat.ready && <p className="text-white/50">Loading messages…</p>}
      {chat.ready && !chat.messages.length && <p className="py-8 text-center text-white/40">No messages yet</p>}
      {chat.messages.map((message, index) => {
        const previous = chat.messages[index - 1];
        const grouped = previous?.author.id === message.author.id &&
          Date.parse(message.created_at) - Date.parse(previous.created_at) < 300000;
        const own = user?.id === message.author.id;
        return <article key={message.id} data-message-id={message.id} className={`group relative rounded px-2 py-1 hover:bg-white/[0.03] ${grouped ? '' : 'mt-4'}`}>
          {!grouped && <div className="mb-1 flex items-center gap-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-400/15 text-sm text-amber-400">{message.author.username[0].toUpperCase()}</span>
            <span className="truncate font-semibold">{message.author.username}</span>
            <time dateTime={message.created_at} title={new Date(message.created_at).toLocaleString()} className="shrink-0 text-xs text-white/40">{new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
          </div>}
          {editing === message.id ? <textarea autoFocus aria-label="Edit message" value={editBody} maxLength={4000}
            className="w-full rounded border border-amber-400/50 bg-[#0b0d12] p-2" onChange={event => setEditBody(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') setEditing(null);
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void edit(message.id); }
            }} /> : <p className={`whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${message.deleted ? 'italic text-white/40' : 'text-white/85'}`}>
            {message.deleted ? 'Message deleted' : message.body}
            {message.edited_at && !message.deleted && <span className="ml-2 text-xs text-white/40">(edited)</span>}
          </p>}
          {message.status === 'sending' && <span className="text-xs text-white/40">Sending…</span>}
          {message.status === 'failed' && <p className="text-xs text-rose-400">Failed: {message.error} <button className="underline" onClick={() => void chat.send(message.body ?? '', message.client_msg_id!)}>Retry</button></p>}
          {!message.deleted && !message.status && (own || canModerate) && <div className="flex justify-end gap-3 text-xs text-amber-400 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
            {own && <button aria-label="Edit message" onClick={() => { setEditing(message.id); setEditBody(message.body ?? ''); }}>Edit</button>}
            <button aria-label="Delete message" onClick={() => void remove(message.id)}>Delete</button>
          </div>}
        </article>;
      })}
    </div>
    {newMessages && <button className="mt-2 w-full rounded bg-amber-400/15 py-1 text-sm text-amber-400" onClick={() => {
      if (list.current) list.current.scrollTop = list.current.scrollHeight;
      nearBottom.current = true; setNewMessages(false);
    }}>New messages ↓</button>}
    <p role="status" className="min-h-7 py-1 text-xs text-white/50">{typingText}</p>
    <form onSubmit={event => { event.preventDefault(); send(); }}>
      <textarea aria-label="Message" placeholder={reason || `Message #${channel.name}`} disabled={!!reason} value={body} maxLength={4000} rows={2}
        className="w-full resize-none rounded-lg border border-white/15 bg-[#0b0d12] p-3 text-sm disabled:opacity-60 focus:border-amber-400 focus:outline-none"
        onChange={event => typing(event.target.value)} onBlur={stopTyping} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); }
        }} />
      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-white/40">
        <span>{reason || (body.length > 3500 ? `${body.length}/4000` : 'Enter to send · Shift+Enter for a new line')}</span>
        <button type="submit" disabled={!!reason || !body.trim()} className="rounded bg-amber-400 px-3 py-2 font-semibold text-black disabled:opacity-40">Send</button>
      </div>
    </form>
  </div>;
}
