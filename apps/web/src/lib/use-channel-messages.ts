'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Attachment, Message, MessageDeleted, MessagePage, ReactionUpdate, ThreadPage } from '@hive/shared';
import { useAuth } from './auth';
import { apiData, requestError } from './spaces';
import { chatRequest, socket } from './socket';

export type ChatMessage = Message & { status?: 'sending' | 'failed'; error?: string };

/**
 * Live message list for a channel (parentId = null) or for one thread (parentId = message id).
 * Loads over REST, then follows socket events; merges by id so nothing is ever duplicated.
 */
export function useMessageList(channelId: string, parentId: string | null = null) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  const [parent, setParent] = useState<Message | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [connected, setConnected] = useState(socket.connected);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const generation = useRef(0);
  const olderBusy = useRef(false);

  const commit = useCallback((next: ChatMessage[]) => {
    messagesRef.current = next;
    setMessages(next);
  }, []);
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
    commit([]); setParent(null); setHasOlder(false); setReady(false); setError('');
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
    const onReaction = (data: ReactionUpdate) => {
      if (!active || data.channelId !== channelId) return;
      if (parentId && data.messageId === parentId) setParent(current => current && { ...current, reactions: data.reactions });
      else patch(data.messageId, item => ({ ...item, reactions: data.reactions }));
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
      .on('reaction:updated', onReaction).on('connect', onConnect).on('disconnect', onDisconnect);
    setConnected(socket.connected);
    const initial = parentId
      ? apiData<ThreadPage>(`/api/messages/${parentId}/thread`).then(page => { if (active) setParent(page.parent); return { ...page, has_more: false }; })
      : apiData<MessagePage>(`/api/channels/${channelId}/messages`);
    initial.then(page => {
      if (!active) return;
      merge(page.items); setHasOlder(page.has_more); setReady(true); initialized = true;
      void catchUp();
    }).catch(cause => { if (active) { setError(requestError(cause)); setReady(true); } });
    return () => {
      active = false;
      if (generation.current === version) generation.current++;
      socket.off('message:new', onMessage).off('message:updated', onMessage).off('message:deleted', onDelete)
        .off('reaction:updated', onReaction).off('connect', onConnect).off('disconnect', onDisconnect);
      // The thread panel shares the channel room with the channel view, so only the channel leaves it.
      if (!parentId && socket.connected) socket.emit('channel:leave', { channelId }, () => {});
    };
  }, [channelId, parentId, user?.id, merge, patch, commit]);

  async function send(body: string, clientMsgId = crypto.randomUUID(), attachments: Attachment[] = []) {
    if (!user) return;
    const version = generation.current;
    const pending: ChatMessage = {
      id: `pending:${clientMsgId}`, channel_id: channelId, parent_id: parentId, author: user,
      body: body.trim(), client_msg_id: clientMsgId, created_at: new Date().toISOString(),
      edited_at: null, deleted: false, reply_count: 0, reactions: [], attachments, status: 'sending',
    };
    merge([pending]);
    try {
      const result = await chatRequest<{ message: Message }>('message:send', {
        channelId, body, clientMsgId, parentId, attachmentIds: attachments.map(file => file.id),
      });
      if (generation.current === version) merge([result.message]);
    } catch (cause) {
      if (generation.current !== version) return;
      patch(pending.id, item => ({ ...item, status: 'failed', error: requestError(cause) }));
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
