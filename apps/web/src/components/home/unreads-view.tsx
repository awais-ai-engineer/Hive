'use client';

import { useEffect, useState } from 'react';
import type { PriorityLevel } from '@hive/shared';
import { aiPost, useAiStatus } from '../../lib/ai';
import { badge, placeLabel, type Place, type UnreadItem } from '../../lib/home';
import { requestError } from '../../lib/spaces';
import { CatchUp } from '../ai/catch-up';
import { MessageItem } from '../message-item';

type Props = {
  items: UnreadItem[];
  ready: boolean;
  userId?: string;
  onOpen: (place: Place, threadId?: string) => void;
  onMarkRead: (item: UnreadItem) => void;
};

type Rating = { channelId: string; level: PriorityLevel; reason: string };
const GROUPS: { level: PriorityLevel; title: string }[] = [
  { level: 'urgent', title: 'Urgent' }, { level: 'for_you', title: 'For you' }, { level: 'later', title: 'Later' },
];

function Card({ item, userId, reason, onOpen, onMarkRead }: Pick<Props, 'userId' | 'onOpen' | 'onMarkRead'> & { item: UnreadItem; reason?: string }) {
  return <li className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h2 className="min-w-0 truncate font-semibold">{placeLabel(item.channel)}
        <span className="ml-2 rounded-full bg-amber-400 px-1.5 text-xs font-semibold text-black">{badge(item.unread)} new</span></h2>
      <div className="flex shrink-0 gap-3 text-sm">
        <button type="button" onClick={() => onMarkRead(item)} className="text-white/60 hover:text-white">Mark as read</button>
        <button type="button" onClick={() => onOpen(item.channel, item.items[0]?.parent_id ?? undefined)} className="text-amber-400">Open</button>
      </div>
    </div>
    {reason && <p className="mb-2 text-sm text-white/65">{reason}</p>}
    {item.unread > item.items.length && <p className="mb-1 text-xs text-white/40">Showing the latest {item.items.length}</p>}
    {item.items.map((message, index) => {
      const previous = item.items[index - 1];
      const grouped = previous?.author.id === message.author.id && Date.parse(message.created_at) - Date.parse(previous.created_at) < 300000;
      return <MessageItem key={message.id} message={message} grouped={grouped} userId={userId}
        canWrite={false} canModerate={false} onRetry={() => {}} onError={() => {}} />;
    })}
  </li>;
}

/** Everything unread across the viewer's channels and conversations, one card per place. */
export function UnreadsView({ items, ready, userId, onOpen, onMarkRead }: Props) {
  const ai = useAiStatus();
  const [sorted, setSorted] = useState(false);
  const [ratings, setRatings] = useState<Rating[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const key = items.map(item => `${item.channel.id}:${item.items.at(-1)?.id}`).join(',');
  useEffect(() => {
    if (!sorted || !ai || !items.length) return;
    let active = true;
    setBusy(true); setError('');
    aiPost<{ items: Rating[] }>('/priority', {}).then(result => { if (active) setRatings(result.items); })
      .catch(cause => { if (active) { setError(requestError(cause)); setSorted(false); } })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [sorted, ai, key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ready) return <ul aria-busy="true" aria-label="Loading unread messages" className="space-y-4">{[0, 1].map(index =>
    <li key={index} className="h-28 animate-pulse rounded-xl bg-white/5" />)}</ul>;
  if (!items.length) return <p className="mt-16 text-center text-white/50">You&apos;re all caught up 🎉</p>;

  const byChannel = new Map(items.map(item => [item.channel.id, item]));
  const shared = { userId, onOpen, onMarkRead };
  return <div>
    {ai && <div className="mb-4 flex flex-wrap items-start gap-x-4 gap-y-2">
      <CatchUp />
      <label className="flex cursor-pointer items-center gap-1.5 py-1.5 text-sm text-white/70" title="Let AI sort your unread conversations by how soon they need you">
        <input type="checkbox" checked={sorted} onChange={event => setSorted(event.target.checked)} />Sort by priority</label>
    </div>}
    {error && <p role="alert" className="mb-3 text-sm text-rose-500">{error}</p>}
    {sorted && busy && <p aria-live="polite" className="mb-3 text-sm text-white/55">Sorting your conversations…</p>}
    {sorted && ratings && !busy ? GROUPS.map(group => {
      const rated = ratings.filter(rating => rating.level === group.level && byChannel.has(rating.channelId));
      if (!rated.length) return null;
      return <section key={group.level} className="mb-5" aria-label={group.title}>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-white/55">{group.title}</h3>
        <ul className="space-y-4">{rated.map(rating => <Card key={rating.channelId} {...shared} item={byChannel.get(rating.channelId)!} reason={rating.reason} />)}</ul>
      </section>;
    }) : <ul className="space-y-4">{items.map(item => <Card key={item.channel.id} {...shared} item={item} />)}</ul>}
    {sorted && ratings && <p className="mt-2 text-xs text-white/40">Sorted by AI from your unread messages. It can make mistakes.</p>}
  </div>;
}
