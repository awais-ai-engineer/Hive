'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth';
import { socket } from '../lib/socket';
import { useChannelMessages, type ChatMessage } from '../lib/use-channel-messages';
import { Composer } from './composer';
import { MessageItem } from './message-item';
import { ThreadPanel } from './thread-panel';

type Props = {
  channel: { id: string; name: string };
  placeholder: string;
  /** Why the viewer can't post here ('' when they can). */
  reason: string;
  canModerate: boolean;
  /** Whether the viewer has a read marker to move (space members, conversation participants). */
  tracksReads: boolean;
  onRead?: (channelId: string) => void;
};

export function ChannelChat({ channel, placeholder, reason, canModerate, tracksReads, onRead }: Props) {
  const { user } = useAuth();
  const chat = useChannelMessages(channel.id);
  const [error, setError] = useState('');
  const [newMessages, setNewMessages] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [typers, setTypers] = useState<Record<string, { name: string; until: number }>>({});
  const list = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const started = useRef(false);
  const previousLast = useRef<string | undefined>(undefined);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const lastRead = useRef<string | null>(null);
  const canWrite = !reason;

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

  // Mark the newest message as read while this channel is visible and scrolled to the bottom.
  const markRead = useCallback(() => {
    const newest = chat.messages.filter(item => !item.status).at(-1)?.id;
    if (!user || !tracksReads || !newest || newest === lastRead.current) return;
    if (document.visibilityState !== 'visible' || !nearBottom.current || !socket.connected) return;
    lastRead.current = newest;
    socket.emit('read:update', { channelId: channel.id, messageId: newest }, () => {});
    onRead?.(channel.id);
  }, [chat.messages, user, tracksReads, channel.id, onRead]);
  useEffect(() => {
    const timer = setTimeout(markRead, 800);
    document.addEventListener('visibilitychange', markRead);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', markRead); };
  }, [markRead]);

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
    return () => { socket.off('typing', onTyping); clearInterval(timer); };
  }, [channel.id, user?.id]);

  async function loadOlder() {
    if (!list.current || anchor.current || !chat.hasOlder) return;
    anchor.current = { height: list.current.scrollHeight, top: list.current.scrollTop };
    await chat.loadOlder();
    // A failed request does not produce a list update.
    requestAnimationFrame(() => { anchor.current = null; });
  }
  const retry = (message: ChatMessage) => void chat.send(message.body ?? '', message.client_msg_id!, message.attachments);
  const closeThread = useCallback(() => setThreadId(null), []);
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
        if (nearBottom.current) { setNewMessages(false); markRead(); }
        if (element.scrollTop < 20 && started.current) void loadOlder();
      }}>
      {chat.hasOlder && <button onClick={() => void loadOlder()} className="mb-4 w-full text-sm text-amber-400">Load older messages</button>}
      {!chat.ready && <p className="text-white/50">Loading messages…</p>}
      {chat.ready && !chat.messages.length && <p className="py-8 text-center text-white/40">No messages yet</p>}
      {chat.messages.map((message, index) => {
        const previous = chat.messages[index - 1];
        const grouped = previous?.author.id === message.author.id && !previous.reply_count &&
          Date.parse(message.created_at) - Date.parse(previous.created_at) < 300000;
        return <MessageItem key={message.id} message={message} grouped={grouped} userId={user?.id}
          canWrite={canWrite} canModerate={canModerate} onRetry={retry} onError={setError}
          onReply={item => setThreadId(item.id)} />;
      })}
    </div>
    {newMessages && <button className="mt-2 w-full rounded bg-amber-400/15 py-1 text-sm text-amber-400" onClick={() => {
      if (list.current) list.current.scrollTop = list.current.scrollHeight;
      nearBottom.current = true; setNewMessages(false);
    }}>New messages ↓</button>}
    <p role="status" className="min-h-7 py-1 text-xs text-white/50">{typingText}</p>
    <Composer channelId={channel.id} placeholder={placeholder} reason={reason} sendTyping
      onSend={(body, files) => { nearBottom.current = true; void chat.send(body, undefined, files); }} />
    {threadId && <ThreadPanel key={threadId} channelId={channel.id} parentId={threadId} userId={user?.id}
      reason={reason} canWrite={canWrite} canModerate={canModerate} onClose={closeThread} />}
  </div>;
}
