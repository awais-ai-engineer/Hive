'use client';

import { Button as UiButton } from '@hive/ui';

import { useEffect, useRef, useState } from 'react';
import { socket } from '../lib/socket';
import { useMessageList } from '../lib/use-channel-messages';
import { Composer } from './composer';
import { MessageItem } from './message-item';
import { CatchUp } from './ai/catch-up';

type Props = {
  channelId: string;
  channels?: { id: string; name: string }[];
  parentId: string;
  userId?: string;
  reason: string;
  canWrite: boolean;
  canModerate: boolean;
  onClose: () => void;
};

/** Side panel with one thread: the parent message, its replies and a reply composer. */
export function ThreadPanel({ channelId, channels, parentId, userId, reason, canWrite, canModerate, onClose }: Props) {
  const thread = useMessageList(channelId, parentId);
  const [error, setError] = useState('');
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = list.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [thread.messages.length]);
  // Opening a thread marks its newest reply as read (drives the Threads view highlight).
  const lastRead = useRef<string | null>(null);
  useEffect(() => {
    const newest = thread.messages.filter(item => !item.status).at(-1)?.id;
    if (!userId || !newest || newest === lastRead.current || !socket.connected) return;
    lastRead.current = newest;
    socket.emit('thread:read', { parentId, messageId: newest }, () => {});
  }, [thread.messages, userId, parentId]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const blocked = reason || (thread.parent?.deleted ? 'This message was deleted' : '');
  const shared = { userId, canModerate, onError: setError, onRetry: () => {} };
  return <aside aria-label="Thread" className="fixed inset-0 z-20 flex flex-col bg-surface p-4 md:inset-y-0 md:left-auto md:w-[400px] md:border-l md:border-white/10 md:shadow-[var(--shadow-pop)] xl:static xl:z-auto xl:-my-4 xl:-mr-6 xl:w-[380px] xl:shrink-0 xl:shadow-none">
    <div className="mb-3 flex items-center justify-between">
      <h2 className="font-semibold">Thread</h2>
      <UiButton tooltip="Close thread" onClick={onClose} aria-label="Close thread" className="text-xl text-white/60 hover:text-white">×</UiButton>
    </div>
    {thread.ready && thread.messages.length > 0 && <CatchUp channelId={channelId} threadId={parentId} className="mb-2" />}
    {(error || thread.error) && <p role="alert" className="mb-2 text-sm text-rose-400">{error || thread.error}</p>}
    <div ref={list} className="min-h-0 flex-1 overflow-y-auto">
      {thread.parent && <div className="border-b border-white/10 pb-3">
        <MessageItem {...shared} message={thread.parent} grouped={false} canWrite={canWrite} />
      </div>}
      {!thread.ready && <p className="py-4 text-white/50">Loading thread…</p>}
      {thread.ready && thread.parent && <p className="py-2 text-xs text-white/40">
        {thread.messages.length ? `${thread.messages.length} ${thread.messages.length === 1 ? 'reply' : 'replies'}` : 'No replies yet'}
      </p>}
      {thread.messages.map((message, index) => {
        const previous = thread.messages[index - 1];
        const grouped = previous?.author.id === message.author.id &&
          Date.parse(message.created_at) - Date.parse(previous.created_at) < 300000;
        return <MessageItem key={message.id} {...shared} message={message} grouped={grouped} canWrite={canWrite}
          onRetry={failed => void thread.send(failed.body ?? '', failed.client_msg_id!, failed.attachments)} />;
      })}
    </div>
    <div className="pt-3">
      <Composer channelId={channelId} channels={channels} parentId={parentId} placeholder="Reply…" reason={blocked} onEditLast={()=>{const last=thread.messages.filter(item=>item.author.id===userId&&!item.deleted&&!item.status&&(!item.kind||item.kind==='text')).at(-1);if(last)window.dispatchEvent(new CustomEvent('hive:edit-message',{detail:{id:last.id}}));}}
        onSend={(body, files, options) => thread.send(body, undefined, files, options)} />
    </div>
  </aside>;
}
