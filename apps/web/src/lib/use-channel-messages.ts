'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Attachment, AttachmentViewed, Message, MessageDeleted, MessageExpired, MessagePage, ReactionUpdate, ThreadPage } from '@hive/shared';
import { useAuth } from './auth';
import { apiData, requestError } from './spaces';
import { chatRequest, socket } from './socket';
import type { ComposerSendOptions } from './composer-actions';

export type ChatMessage = Message & { status?: 'sending' | 'failed'; error?: string; plain?: string };

type CachedMessageList = { messages: ChatMessage[]; parent: Message | null; hasOlder: boolean };
const messageCache = new Map<string, CachedMessageList>();

function messageCacheKey(userId: string | undefined, channelId: string, parentId: string | null) {
  return userId ? `${userId}:${channelId}:${parentId ?? 'channel'}` : null;
}

function readMessageCache(key: string): CachedMessageList | undefined {
  const memory = messageCache.get(key);
  if (memory) return memory;
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = sessionStorage.getItem(`hive:messages:v1:${key}`);
    if (!raw) return undefined;
    const saved = JSON.parse(raw) as CachedMessageList;
    if (!Array.isArray(saved.messages)) return undefined;
    messageCache.set(key, saved);
    return saved;
  } catch { return undefined; }
}

function writeMessageCache(key: string, value: CachedMessageList) {
  messageCache.set(key, value);
  if (typeof window === 'undefined') return;
  // Secret chat text must never be written to browser storage.
  if (value.messages.some(message => !!message.ciphertext)) {
    try { sessionStorage.removeItem(`hive:messages:v1:${key}`); } catch { /* storage unavailable */ }
    return;
  }
  try {
    sessionStorage.setItem(`hive:messages:v1:${key}`, JSON.stringify({ ...value, messages: value.messages.slice(-100) }));
  } catch { /* session cache is best-effort */ }
}

/**
 * Live message list for a channel (parentId = null) or for one thread (parentId = message id).
 * Loads over REST, then follows socket events; merges by id so nothing is ever duplicated.
 */
export function useMessageList(channelId: string, parentId: string | null = null) {
  const { user } = useAuth();
  const cacheKey = messageCacheKey(user?.id, channelId, parentId);
  const cached = cacheKey ? readMessageCache(cacheKey) : undefined;
  const [messages, setMessages] = useState<ChatMessage[]>(() => cached?.messages ?? []);
  const messagesRef = useRef<ChatMessage[]>([]);
  const [parent, setParent] = useState<Message | null>(() => cached?.parent ?? null);
  const [hasOlder, setHasOlder] = useState(() => cached?.hasOlder ?? false);
  const [connected, setConnected] = useState(socket.connected);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(() => !!cached);
  const generation = useRef(0);
  const olderBusy = useRef(false);

  const commit = useCallback((next: ChatMessage[]) => {
    messagesRef.current = next;
    setMessages(next);
    if (cacheKey && (next.length > 0 || messageCache.has(cacheKey))) {
      const previous = messageCache.get(cacheKey);
      writeMessageCache(cacheKey, { messages: next, parent: previous?.parent ?? null, hasOlder: previous?.hasOlder ?? false });
    }
  }, [cacheKey]);
  const merge = useCallback((incoming: ChatMessage[]) => {
    let next = [...messagesRef.current];
    for (const message of incoming) {
      next = next.filter(item => item.id !== message.id && !(
        item.status && item.author.id === message.author.id &&
        item.client_msg_id === message.client_msg_id
      ));
      next.push(message);
    }
    next.sort((a, b) => Number(!!a.status) - Number(!!b.status) || a.id.localeCompare(b.id));
    commit(next);
  }, [commit]);
  const patch = useCallback((id: string, change: (message: ChatMessage) => ChatMessage) => {
    commit(messagesRef.current.map(item => item.id === id ? change(item) : item));
  }, [commit]);

  useEffect(() => {
    const version = ++generation.current;
    let active = true;
    let initialized = false;
    let synchronizing = false;
    const saved = cacheKey ? readMessageCache(cacheKey) : undefined;
    if (saved) {
      messagesRef.current = saved.messages;
      setMessages(saved.messages); setParent(saved.parent); setHasOlder(saved.hasOlder); setReady(true);
    } else {
      commit([]); setParent(null); setHasOlder(false); setReady(false);
    }
    setError('');
    olderBusy.current = false;
    const mine = (message: { channel_id: string; parent_id: string | null }) =>
      message.channel_id === channelId && message.parent_id === parentId;
    const onMessage = (message: Message) => {
      if (!active) return;
      if (parentId && message.id === parentId) setParent(message);
      else if (mine(message)) merge([message]);
    };
    const onDelete = (data: MessageDeleted) => {
      if (!active || data.channelId !== channelId) return;
      const gone = (item: Message) => ({ ...item, deleted: true, body: null, reactions: [], attachments: [] });
      if (parentId && data.id === parentId) setParent(current => current && gone(current));
      else patch(data.id, gone);
    };
    const onExpired = (data: MessageExpired) => {
      if (!active || data.channelId !== channelId) return;
      const gone = new Set(data.ids);
      commit(messagesRef.current.filter(item => !gone.has(item.id)).map(item => data.replyCounts[item.id] !== undefined ? { ...item, reply_count: data.replyCounts[item.id] } : item));
      if (parentId && gone.has(parentId)) setError('This conversation thread has disappeared.');
    };
    const onViewed = (data: AttachmentViewed) => {
      if (!active || data.channelId !== channelId || !user) return;
      const state = data.viewerId === user.id ? 'opened' : data.uploaderId === user.id ? data.senderState : null;
      if (!state) return;
      const update = (item: Message) => ({ ...item, attachments: item.attachments.map(file => file.id === data.attachmentId ? { ...file, viewState: state } : file) });
      if (parentId && data.messageId === parentId) setParent(current => current && update(current));
      else patch(data.messageId, update);
    };
    // Messages past their deadline disappear from the screen right away; the server erases them shortly after.
    const sweep = setInterval(() => {
      const now = Date.now();
      if (messagesRef.current.some(item => item.expires_at && Date.parse(item.expires_at) <= now))
        commit(messagesRef.current.filter(item => !item.expires_at || Date.parse(item.expires_at) > now));
    }, 10000);
    const onReaction = (data: ReactionUpdate) => {
      if (!active || data.channelId !== channelId) return;
      if (parentId && data.messageId === parentId) setParent(current => current && { ...current, reactions: data.reactions });
      else patch(data.messageId, item => ({ ...item, reactions: data.reactions }));
    };
    const onPoll = (data: { messageId: string; counts: Record<string, number>; total: number; closedAt?: string | null }) => {
      const update = (item: ChatMessage) => item.poll ? { ...item, poll: { ...item.poll, counts: data.counts, total: data.total, closedAt: data.closedAt ?? item.poll.closedAt, options: item.poll.options.map(option => ({ ...option, count: data.counts[option.id] ?? 0 })) } } : item;
      if (parentId === data.messageId) setParent(item => item && update(item));
      else patch(data.messageId, update);
    };
    async function catchUp() {
      if (!active || !initialized || !user || !socket.connected || synchronizing) return;
      synchronizing = true;
      try {
        let cursor = messagesRef.current.filter(item => !item.status).at(-1)?.id ?? null;
        await chatRequest('channel:join', { channelId });
        let more = true;
        while (active && more) {
          let page: MessagePage | undefined;
          if (parentId) {
            const thread = await apiData<ThreadPage>(`/api/messages/${parentId}/thread${cursor ? `?after=${cursor}` : ''}`);
            if (active) setParent(thread.parent);
            page = thread;
          } else {
            const result = await chatRequest<{ channels: Record<string, MessagePage> }>('sync', { channels: { [channelId]: cursor } });
            page = result.channels[channelId];
          }
          if (!active || !page) break;
          merge(page.items);
          cursor = page.items.at(-1)?.id ?? cursor;
          more = page.has_more && page.items.length > 0;
        }
        if (active) setError('');
      } catch (cause) { if (active) setError(requestError(cause)); }
      finally { synchronizing = false; }
    }
    const onConnect = () => { setConnected(true); void catchUp(); };
    const onDisconnect = () => setConnected(false);
    socket.on('message:new', onMessage).on('message:updated', onMessage).on('message:deleted', onDelete)
      .on('message:expired', onExpired).on('attachment:viewed', onViewed).on('poll:updated', onPoll)
      .on('reaction:updated', onReaction).on('connect', onConnect).on('disconnect', onDisconnect);
    setConnected(socket.connected);
    if (saved) {
      initialized = true;
      void catchUp();
    }
    const initial = parentId
      ? apiData<ThreadPage>(`/api/messages/${parentId}/thread`).then(page => { if (active) setParent(page.parent); return { ...page, has_more: false }; })
      : apiData<MessagePage>(`/api/channels/${channelId}/messages`);
    initial.then(page => {
      if (!active) return;
      merge(page.items); setHasOlder(page.has_more); setReady(true); initialized = true;
      if (cacheKey) writeMessageCache(cacheKey, { messages: messagesRef.current, parent: parentId ? (page as ThreadPage).parent : null, hasOlder: page.has_more });
      void catchUp();
    }).catch(cause => { if (active) { setError(requestError(cause)); setReady(true); } });
    return () => {
      active = false; clearInterval(sweep);
      if (generation.current === version) generation.current++;
      socket.off('message:new', onMessage).off('message:updated', onMessage).off('message:deleted', onDelete)
        .off('message:expired', onExpired).off('attachment:viewed', onViewed).off('poll:updated', onPoll)
        .off('reaction:updated', onReaction).off('connect', onConnect).off('disconnect', onDisconnect);
      // The thread panel shares the channel room with the channel view, so only the channel leaves it.
      if (!parentId && socket.connected) socket.emit('channel:leave', { channelId }, () => {});
    };
  }, [channelId, parentId, user?.id, merge, patch, commit, cacheKey]);

  async function send(body: string, clientMsgId = crypto.randomUUID(), attachments: Attachment[] = [], options: ComposerSendOptions = {}) {
    if (!user) return false;
    const version = generation.current;
    const pending: ChatMessage = {
      id: `pending:${clientMsgId}`, channel_id: channelId, parent_id: parentId, author: user,
      body: body.trim(), client_msg_id: clientMsgId, created_at: new Date().toISOString(),
      edited_at: null, deleted: false, reply_count: 0, reactions: [], attachments, status: 'sending',
      kind: options.kind ?? 'text', mentions: [], channelLinks: [], poll: null, plain: options.plain,
    };
    merge([pending]);
    try {
      const wire = { ...options }; delete wire.plain;
      const result = await chatRequest<{ message: Message }>('message:send', {
        channelId, body: options.ciphertext ? '' : body, clientMsgId, parentId, attachmentIds: attachments.map(file => file.id),
        ...wire,
      });
      if (generation.current === version) merge([result.message]);
      return true;
    } catch (cause) {
      if (generation.current !== version) return false;
      patch(pending.id, item => ({ ...item, status: 'failed', error: requestError(cause) }));
      return false;
    }
  }

  async function loadOlder() {
    const oldest = messagesRef.current.find(item => !item.status)?.id;
    if (parentId || !oldest || !hasOlder || olderBusy.current) return;
    const version = generation.current;
    olderBusy.current = true;
    try {
      const page = await apiData<MessagePage>(`/api/channels/${channelId}/messages?before=${oldest}`);
      if (generation.current !== version) return;
      merge(page.items); setHasOlder(page.has_more);
    } catch (cause) { if (generation.current === version) setError(requestError(cause)); }
    finally { if (generation.current === version) olderBusy.current = false; }
  }
  return { messages, parent, send, loadOlder, hasOlder, connected, error, ready };
}

export const useChannelMessages = (channelId: string) => useMessageList(channelId, null);
