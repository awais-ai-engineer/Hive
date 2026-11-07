'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { AppNotification } from '@hive/shared';
import { actorName, describe, notificationHref } from '../../lib/notifications';
import { socket } from '../../lib/socket';
import { apiData, requestError } from '../../lib/spaces';
import { Avatar } from '../ui/avatar';
import { Icon } from '../ui/icons';

type Page = { items: AppNotification[]; nextCursor: string | null; unreadCount: number };

function dayLabel(value: string) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

/** Notifications inbox: All / Unread tabs, grouped by day, live through the socket. */
export function InboxView() {
  const router = useRouter();
  const [tab, setTab] = useState<'all' | 'unread'>('all');
  const [items, setItems] = useState<AppNotification[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [ready, setReady] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (next: string | null) => {
    if (next) setMore(true); else setReady(false);
    try {
      const page = await apiData<Page>(`/api/notifications?limit=30${tab === 'unread' ? '&unread=true' : ''}${next ? `&cursor=${next}` : ''}`);
      setItems(current => next ? [...current, ...page.items] : page.items);
      setCursor(page.nextCursor); setUnread(page.unreadCount); setError('');
    } catch (cause) { setError(requestError(cause)); }
    finally { setReady(true); setMore(false); }
  }, [tab]);
  useEffect(() => { void load(null); }, [load]);

  useEffect(() => {
    const onNew = (item: AppNotification) => setItems(current => {
      if (tab === 'unread' && item.readAt) return current;
      return [item, ...current.filter(existing => existing.id !== item.id)];
    });
    const onCount = (data: { count: number }) => setUnread(data.count);
    const reload = () => void load(null);
    socket.on('notification:new', onNew).on('notification:count', onCount).on('connect', reload);
    return () => { socket.off('notification:new', onNew).off('notification:count', onCount).off('connect', reload); };
  }, [tab, load]);

  async function open(item: AppNotification) {
    if (!item.readAt) {
      setItems(current => current.map(entry => entry.id === item.id ? { ...entry, readAt: new Date().toISOString() } : entry));
      apiData(`/api/notifications/${item.id}/read`, { method: 'POST' }).catch(() => {});
    }
    router.push(notificationHref(item));
  }
  async function readAll() {
    try {
      await apiData('/api/notifications/read-all', { method: 'POST' });
      setItems(current => (tab === 'unread' ? [] : current.map(entry => ({ ...entry, readAt: entry.readAt ?? new Date().toISOString() }))));
      setUnread(0);
    } catch (cause) { setError(requestError(cause)); }
  }

  const groups: [string, AppNotification[]][] = [];
  for (const item of items) {
    const label = dayLabel(item.createdAt);
    const last = groups[groups.length - 1];
    if (last && last[0] === label) last[1].push(item); else groups.push([label, [item]]);
  }

  return <div className="min-h-0 flex-1 overflow-y-auto pr-1">
    <div className="mb-4 flex items-center gap-2 border-b border-white/10">
      <div role="tablist" aria-label="Notifications" className="flex gap-1">
        {(['all', 'unread'] as const).map(value => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === value ? 'border-brand text-brand' : 'border-transparent text-white/60 hover:text-white'}`}>
          {value === 'all' ? 'All' : 'Unread'}{value === 'unread' && unread > 0 && <span className="ml-1.5 rounded-full bg-brand-soft px-1.5 text-xs text-brand">{unread > 99 ? '99+' : unread}</span>}</button>)}
      </div>
      <button type="button" className="btn-ghost mb-1 ml-auto" disabled={unread === 0} onClick={() => void readAll()}>Mark all read</button>
    </div>
    {error && <p role="alert" className="mb-3 text-sm text-rose-500">{error}</p>}
    {!ready ? <div role="status" aria-label="Loading notifications" className="space-y-3">
      {[1, 2, 3, 4].map(index => <div key={index} className="h-16 animate-pulse rounded-xl bg-white/5" />)}
    </div> : !items.length ? <div className="mt-16 flex flex-col items-center gap-2 text-center text-white/55">
      <Icon name="bell" size={36} />
      <p>{tab === 'unread' ? 'You’re all caught up.' : 'Nothing here yet. Mentions, replies and reactions will show up in this inbox.'}</p>
    </div> : <>
      {groups.map(([label, list]) => <section key={label} className="mb-5" aria-label={label}>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">{label}</h2>
        <ul className="space-y-1.5">
          {list.map(item => <li key={item.id}>
            <button type="button" onClick={() => void open(item)}
              className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition hover:bg-[var(--surface-2)] ${item.readAt ? 'border-white/10' : 'border-brand/40 bg-brand-soft'}`}>
              <Avatar name={actorName(item)} src={item.actor?.avatarUrl} size={36} />
              <span className="min-w-0 flex-1">
                <span className={`block text-sm ${item.readAt ? '' : 'font-semibold'}`}>{describe(item)}</span>
                {item.snippet && item.type !== 'invite_accepted' && <span className="mt-0.5 line-clamp-2 block break-words text-sm text-white/60">{item.snippet}</span>}
                <time dateTime={item.createdAt} className="mt-0.5 block text-xs text-white/45">{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
              </span>
              {!item.readAt && <span aria-label="Unread" className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full bg-brand" />}
            </button>
          </li>)}
        </ul>
      </section>)}
      {cursor && <div className="text-center"><button type="button" className="btn-ghost" disabled={more} onClick={() => void load(cursor)}>{more ? 'Loading…' : 'Load more'}</button></div>}
    </>}
  </div>;
}
