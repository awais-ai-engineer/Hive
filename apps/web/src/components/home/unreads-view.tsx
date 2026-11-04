'use client';

import { badge, placeLabel, type Place, type UnreadItem } from '../../lib/home';
import { MessageItem } from '../message-item';

type Props = {
  items: UnreadItem[];
  ready: boolean;
  userId?: string;
  onOpen: (place: Place) => void;
  onMarkRead: (item: UnreadItem) => void;
};

/** Everything unread across the viewer's channels and conversations, one card per place. */
export function UnreadsView({ items, ready, userId, onOpen, onMarkRead }: Props) {
  if (!ready) return <p className="text-white/50">Loading unread messages…</p>;
  if (!items.length) return <p className="mt-16 text-center text-white/50">You&apos;re all caught up 🎉</p>;
  return <ul className="space-y-4">{items.map(item => <li key={item.channel.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h2 className="min-w-0 truncate font-semibold">{placeLabel(item.channel)}
        <span className="ml-2 rounded-full bg-amber-400 px-1.5 text-xs font-semibold text-black">{badge(item.unread)} new</span></h2>
      <div className="flex shrink-0 gap-3 text-sm">
        <button type="button" onClick={() => onMarkRead(item)} className="text-white/60 hover:text-white">Mark as read</button>
        <button type="button" onClick={() => onOpen(item.channel)} className="text-amber-400">Open</button>
      </div>
    </div>
    {item.unread > item.items.length && <p className="mb-1 text-xs text-white/40">Showing the latest {item.items.length}</p>}
    {item.items.map((message, index) => {
      const previous = item.items[index - 1];
      const grouped = previous?.author.id === message.author.id && Date.parse(message.created_at) - Date.parse(previous.created_at) < 300000;
      return <MessageItem key={message.id} message={message} grouped={grouped} userId={userId}
        canWrite={false} canModerate={false} onRetry={() => {}} onError={() => {}} />;
    })}
  </li>)}</ul>;
}
