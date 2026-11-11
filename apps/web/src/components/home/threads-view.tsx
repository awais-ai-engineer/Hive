'use client';

import { Button as UiButton, EmptyState, LoadingState } from '@hive/ui';

import { useCallback, useEffect, useState } from 'react';
import { placeLabel, type ThreadItem } from '../../lib/home';
import { apiData, requestError } from '../../lib/spaces';
import { MessageItem } from '../message-item';

type Props = {
  /** Bump to reload (e.g. on thread:activity). */
  version: number;
  userId?: string;
  onOpen: (item: ThreadItem) => void;
};

/** Every thread the viewer started or replied to, newest activity first. */
export function ThreadsView({ version, userId, onOpen }: Props) {
  const [items, setItems] = useState<ThreadItem[]>([]);
  const [more, setMore] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (before?: string) => {
    try {
      const page = await apiData<{ items: ThreadItem[]; has_more: boolean }>(
        `/api/me/threads${before ? `?before=${before}` : ''}`);
      setItems(current => before ? [...current, ...page.items] : page.items);
      setMore(page.has_more); setError('');
    } catch (cause) { setError(requestError(cause)); }
    finally { setReady(true); }
  }, []);
  useEffect(() => { void load(); }, [load, version]);

  if (!ready) return <LoadingState label="Loading threads" />;
  return <div>
    {error && <p role="alert" className="mb-2 text-sm text-rose-400">{error}</p>}
    {!items.length && <EmptyState title="No threads yet" description="Reply to any message to start a thread. Replies will stay together here." />}
    <ul className="space-y-4">{items.map(item => {
      const fresh = item.unread_replies > 0;
      return <li key={item.parent.id}>
        <article className={`rounded-xl border bg-white/[0.02] p-4 ${fresh ? 'border-amber-400/40 border-l-4 border-l-amber-400' : 'border-white/10'}`}>
          <div className="mb-1 flex items-center justify-between gap-2 text-sm">
            <span className="truncate text-white/60">{placeLabel(item.channel)}</span>
            {fresh && <span className="shrink-0 rounded-full bg-amber-400 px-1.5 text-xs font-semibold text-black">{item.unread_replies} new</span>}
          </div>
          <MessageItem message={item.parent} grouped={false} userId={userId} canWrite={false} canModerate={false}
            onRetry={() => {}} onError={() => {}} />
          <div className="ml-4 border-l border-white/10 pl-3">
            {item.reply_count > item.latest_replies.length && <p className="pt-1 text-xs text-white/40">
              {item.reply_count - item.latest_replies.length} earlier {item.reply_count - item.latest_replies.length === 1 ? 'reply' : 'replies'}</p>}
            {item.latest_replies.map(message => <MessageItem key={message.id} message={message} grouped={false} userId={userId}
              canWrite={false} canModerate={false} onRetry={() => {}} onError={() => {}} />)}
          </div>
          <UiButton type="button" onClick={() => onOpen(item)} className="mt-2 text-sm font-semibold text-amber-400">
            Open thread · {item.reply_count} {item.reply_count === 1 ? 'reply' : 'replies'}
          </UiButton>
        </article>
      </li>;
    })}</ul>
    {more && <UiButton type="button" onClick={() => void load(items.at(-1)?.last_reply_id)} className="auth-button mt-4">Load more</UiButton>}
  </div>;
}
