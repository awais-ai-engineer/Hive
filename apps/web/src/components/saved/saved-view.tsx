'use client';

import { Button as UiButton } from '@hive/ui';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { forgetSaved, type SavedKind } from '../../lib/saved';
import { apiData, requestError } from '../../lib/spaces';
import { Avatar } from '../ui/avatar';
import { Icon } from '../ui/icons';

type Place = { spaceId: string | null; spaceSlug: string | null; spaceName: string | null; channelId: string | null; channelName: string | null; isDm: boolean };
type Item = {
  id: string; type: SavedKind; createdAt: string; targetCreatedAt: string; snippet: string; title: string | null; place: Place;
  author: { id: string; username: string; displayName: string | null; avatarUrl: string | null } | null;
  messageId: string | null; postId: string | null; commentId: string | null; parentId: string | null;
};
type Page = { items: Item[]; nextCursor: string | null };

function href(item: Item) {
  if (item.type === 'message' && item.place.channelId) {
    const params = new URLSearchParams();
    if (item.place.spaceSlug) params.set('s', item.place.spaceSlug);
    params.set('c', item.place.channelId);
    if (item.parentId) params.set('t', item.parentId);
    if (item.messageId) params.set('m', item.messageId);
    return `/home?${params}`;
  }
  return `/p/${item.postId}`;
}

const where = (item: Item) => item.type === 'message'
  ? (item.place.isDm ? `Chat with ${item.place.channelName}` : `#${item.place.channelName} · ${item.place.spaceName}`)
  : item.place.spaceName ?? '';

/** Saved messages, posts and comments. Items the viewer can no longer read are simply not listed. */
export function SavedView() {
  const router = useRouter();
  const [tab, setTab] = useState<'message' | 'post'>('message');
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (next: string | null) => {
    if (next) setMore(true); else setReady(false);
    try {
      const page = await apiData<Page>(`/api/saved?limit=30${next ? `&cursor=${next}` : ''}`);
      setItems(current => next ? [...current, ...page.items] : page.items);
      setCursor(page.nextCursor); setError('');
    } catch (cause) { setError(requestError(cause)); }
    finally { setReady(true); setMore(false); }
  }, []);
  useEffect(() => { void load(null); }, [load]);

  async function remove(item: Item) {
    const target = item.messageId ?? item.commentId ?? item.postId;
    try {
      await apiData(`/api/saved/${item.type}s/${target}`, { method: 'DELETE' });
      forgetSaved(item.type, target!);
      setItems(current => current.filter(entry => entry.id !== item.id));
    } catch (cause) { setError(requestError(cause)); }
  }

  const shown = items.filter(item => (tab === 'message' ? item.type === 'message' : item.type !== 'message'));
  return <div className="min-h-0 flex-1 overflow-y-auto pr-1">
    <div role="tablist" aria-label="Saved items" className="mb-4 flex gap-1 border-b border-white/10">
      {([['message', 'Messages'], ['post', 'Posts and comments']] as const).map(([value, label]) =>
        <UiButton key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === value ? 'border-brand text-brand' : 'border-transparent text-white/60 hover:text-white'}`}>{label}</UiButton>)}
    </div>
    {error && <p role="alert" className="mb-3 text-sm text-rose-500">{error}</p>}
    {!ready ? <div role="status" aria-label="Loading saved items" className="space-y-3">
      {[1, 2, 3].map(index => <div key={index} className="h-24 animate-pulse rounded-xl bg-white/5" />)}
    </div> : !shown.length ? <div className="mt-16 flex flex-col items-center gap-2 text-center text-white/55">
      <Icon name="bookmark" size={36} />
      <p>{tab === 'message' ? 'No saved messages. Use Save on a message to keep it here.' : 'No saved posts or comments. Use Save on a post or comment to keep it here.'}</p>
    </div> : <ul className="space-y-3">
      {shown.map(item => <li key={item.id} className="card p-4">
        <p className="flex flex-wrap items-center gap-x-2 text-xs font-medium text-white/50">
          {item.author && <span className="flex items-center gap-1.5"><Avatar name={item.author.username} src={item.author.avatarUrl} size={18} />{item.author.displayName || item.author.username}</span>}
          <span>{where(item)}</span><span>{new Date(item.targetCreatedAt).toLocaleDateString()}</span>
          {item.type === 'comment' && <span className="rounded-full bg-brand-soft px-2 text-brand">Comment</span>}
        </p>
        {item.title && <p className="mt-1 font-semibold">{item.title}</p>}
        {item.snippet && <p className="mt-1 line-clamp-3 break-words text-white/80">{item.snippet}</p>}
        <div className="mt-3 flex gap-2">
          <UiButton type="button" className="auth-button text-sm" onClick={() => router.push(href(item))}>Open</UiButton>
          <UiButton type="button" className="btn-ghost text-rose-500" onClick={() => void remove(item)}>Remove</UiButton>
        </div>
      </li>)}
      {cursor && <li className="text-center"><UiButton type="button" className="btn-ghost" disabled={more} onClick={() => void load(cursor)}>{more ? 'Loading…' : 'Load more'}</UiButton></li>}
    </ul>}
  </div>;
}
