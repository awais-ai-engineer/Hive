'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message, MessagePage } from '@hive/shared';
import { useAuth } from './auth';
import { apiData, requestError } from './spaces';
import { chatRequest, socket } from './socket';

export type ChatMessage = Message & { status?: 'sending' | 'failed'; error?: string };

export function useChannelMessages(channelId: string) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [connected, setConnected] = useState(socket.connected);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const generation = useRef(0);
  const olderBusy = useRef(false);

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
      messagesRef.current = next;
      setMessages(next);
  }, []);

  useEffect(() => {
    const version = ++generation.current;
    let active = true;
    let initialized = false;
    let synchronizing = false;
    messagesRef.current = [];
    setMessages([]); setHasOlder(false); setReady(false); setError('');
    olderBusy.current = false;
    const onMessage = (message: Message) => { if (active && message.channel_id === channelId) merge([message]); };
    const onDelete = (data: { id: string; channelId: string }) => {
      if (data.channelId !== channelId) return;
      setMessages(previous => {
        const next = previous.map(item => item.id === data.id ? { ...item, deleted: true, body: null } : item);
        messagesRef.current = next;
        return next;
      });
    };
    async function joinAndSync() {
      if (!active || !initialized || !user || !socket.connected || synchronizing) return;
      synchronizing = true;
      try {
        const known = messagesRef.current.filter(item => !item.status);
        let cursor = known.at(-1)?.id ?? null;
        await chatRequest('channel:join', { channelId });
        let more = true;
        while (active && more) {
          const result = await chatRequest<{ channels: Record<string, MessagePage> }>('sync', { channels: { [channelId]: cursor } });
          if (!active) return;
          const page = result.channels[channelId];
          if (!page) break;
          merge(page.items);
          cursor = page.items.at(-1)?.id ?? cursor;
          more = page.has_more && page.items.length > 0;
        }
        if (active) setError('');
      } catch (cause) { if (active) setError(requestError(cause)); }
      finally { synchronizing = false; }
    }
    const onConnect = () => { setConnected(true); void joinAndSync(); };
    const onDisconnect = () => setConnected(false);
    socket.on('message:new', onMessage).on('message:updated', onMessage).on('message:deleted', onDelete);
    socket.on('connect', onConnect).on('disconnect', onDisconnect);
    setConnected(socket.connected);
    apiData<MessagePage>(`/api/channels/${channelId}/messages`).then(page => {
      if (!active) return;
      merge(page.items); setHasOlder(page.has_more); setReady(true); initialized = true;
      void joinAndSync();
    }).catch(cause => { if (active) { setError(requestError(cause)); setReady(true); } });
    return () => {
      active = false;
      if (generation.current === version) generation.current++;
      socket.off('message:new', onMessage).off('message:updated', onMessage).off('message:deleted', onDelete);
      socket.off('connect', onConnect).off('disconnect', onDisconnect);
      if (socket.connected) socket.emit('channel:leave', { channelId }, () => {});
    };
  }, [channelId, user?.id, merge]);

  async function send(body: string, clientMsgId = crypto.randomUUID()) {
    if (!user) return;
    const version = generation.current;
    const pending: ChatMessage = {
      id: `pending:${clientMsgId}`, channel_id: channelId, author: user, body: body.trim(),
      client_msg_id: clientMsgId, created_at: new Date().toISOString(), edited_at: null,
      deleted: false, status: 'sending',
    };
    merge([pending]);
    try {
      const result = await chatRequest<{ message: Message }>('message:send', { channelId, body, clientMsgId });
      if (generation.current === version) merge([result.message]);
    } catch (cause) {
      if (generation.current !== version) return;
      setMessages(previous => {
        const next = previous.map(item => item.id === pending.id ? { ...item, status: 'failed' as const, error: requestError(cause) } : item);
        messagesRef.current = next;
        return next;
      });
    }
  }

  async function loadOlder() {
    const oldest = messagesRef.current.find(item => !item.status)?.id;
    if (!oldest || !hasOlder || olderBusy.current) return;
    const version = generation.current;
    olderBusy.current = true;
    try {
      const page = await apiData<MessagePage>(`/api/channels/${channelId}/messages?before=${oldest}`);
      if (generation.current !== version) return;
      merge(page.items); setHasOlder(page.has_more);
    } catch (cause) { if (generation.current === version) setError(requestError(cause)); }
    finally { if (generation.current === version) olderBusy.current = false; }
  }
  return { messages, send, loadOlder, hasOlder, connected, error, ready };
}
