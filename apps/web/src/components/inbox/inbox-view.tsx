'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppNotification, NotificationType } from '@hive/shared';
import { actorName, describe, notificationHref } from '../../lib/notifications';
import { socket } from '../../lib/socket';
import { apiData, requestError, type Space } from '../../lib/spaces';
import { tasksApi } from '../../lib/tasks';
import { Avatar } from '../ui/avatar';
import { Icon, type IconName } from '../ui/icons';

type Page = { items: AppNotification[]; nextCursor: string | null; unreadCount: number };
type Side = 'work' | 'social';
type Filter = 'all' | NotificationType;

const FILTERS: { id: Filter; label: string; icon: IconName }[] = [
  { id: 'all', label: 'All activity', icon: 'inbox' },
  { id: 'mention', label: 'Mentions', icon: 'at' },
  { id: 'reply', label: 'Thread replies', icon: 'threads' },
  { id: 'dm', label: 'Direct messages', icon: 'message' },
  { id: 'reaction', label: 'Reactions', icon: 'smile' },
  { id: 'post_comment', label: 'Comments', icon: 'layers' },
  { id: 'invite_accepted', label: 'Invites', icon: 'users' },
];
const ICONS: Record<NotificationType, IconName> = {
  mention: 'at', reply: 'threads', dm: 'message', reaction: 'smile', post_comment: 'layers', invite_accepted: 'users',
};
/** Things that are waiting on you, not just news. */
const NEEDS_YOU: NotificationType[] = ['mention', 'dm', 'reply'];

function timeLabel(value: string) {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const placeOf = (item: AppNotification) => [item.isDm ? 'Direct message' : item.spaceName, item.channelName && !item.isDm ? `#${item.channelName}` : null]
  .filter(Boolean).join(' · ');

/** Activity: everything that needs you, split into work and social, with a preview of the selected item. */
export function InboxView() {
  const router = useRouter();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [side, setSide] = useState<Side>('work');
  const [filter, setFilter] = useState<Filter>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [priority, setPriority] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async (next: string | null) => {
    if (next) setMore(true); else setReady(false);
    try {
      const page = await apiData<Page>(`/api/notifications?limit=50${next ? `&cursor=${next}` : ''}`);
      setItems(current => next ? [...current, ...page.items] : page.items);
      setCursor(page.nextCursor); setError('');
    } catch (cause) { setError(requestError(cause)); }
    finally { setReady(true); setMore(false); }
  }, []);
  useEffect(() => { void load(null); }, [load]);
  useEffect(() => { apiData<Space[]>('/api/me/spaces').then(setSpaces).catch(() => {}); }, []);
  useEffect(() => {
    const onNew = (item: AppNotification) => setItems(current => [item, ...current.filter(existing => existing.id !== item.id)]);
    const reload = () => void load(null);
    socket.on('notification:new', onNew).on('connect', reload);
    return () => { socket.off('notification:new', onNew).off('connect', reload); };
  }, [load]);

  // Direct messages and private workspaces are work; public communities are social.
  const kind = useMemo(() => new Map(spaces.map(space => [space.id, space.type])), [spaces]);
  const sideOf = useCallback((item: AppNotification): Side => item.isDm || !item.spaceId || kind.get(item.spaceId) !== 'community' ? 'work' : 'social', [kind]);
  const inSide = items.filter(item => sideOf(item) === side);
  const unreadIn = (list: AppNotification[]) => list.filter(item => !item.readAt).length;
  const counts = { work: unreadIn(items.filter(item => sideOf(item) === 'work')), social: unreadIn(items.filter(item => sideOf(item) === 'social')) };
  let shown = inSide.filter(item => (filter === 'all' || item.type === filter) && (!unreadOnly || !item.readAt));
  if (priority) shown = [...shown].sort((a, b) => Number(!!a.readAt) - Number(!!b.readAt)
    || Number(!NEEDS_YOU.includes(a.type)) - Number(!NEEDS_YOU.includes(b.type)) || b.createdAt.localeCompare(a.createdAt));
  const needsYou = inSide.filter(item => !item.readAt && NEEDS_YOU.includes(item.type));
  const current = shown.find(item => item.id === selected) ?? null;
  const spaceCount = new Set(inSide.filter(item => !item.readAt).map(item => item.spaceId ?? 'dm')).size;

  function markRead(item: AppNotification) {
    if (item.readAt) return;
    setItems(list => list.map(entry => entry.id === item.id ? { ...entry, readAt: new Date().toISOString() } : entry));
    apiData(`/api/notifications/${item.id}/read`, { method: 'POST' }).catch(() => {});
  }
  function select(item: AppNotification) { setSelected(item.id); setNotice(''); markRead(item); }
  async function readAll() {
    try {
      await apiData('/api/notifications/read-all', { method: 'POST' });
      setItems(list => list.map(entry => ({ ...entry, readAt: entry.readAt ?? new Date().toISOString() })));
    } catch (cause) { setError(requestError(cause)); }
  }
  async function addToTasks(item: AppNotification) {
    try {
      await tasksApi.create({ title: (item.snippet || describe(item)).slice(0, 200), channel_id: item.channelId, source_message_id: item.messageId });
      setNotice('Added to your to-dos.');
    } catch (cause) { setError(requestError(cause)); }
  }
  async function remindLater(item: AppNotification) {
    try {
      await apiData('/api/reminders', { method: 'POST', body: JSON.stringify({ text: `${describe(item)}: ${item.snippet}`.slice(0, 500), remindAt: new Date(Date.now() + 3 * 3600_000).toISOString() }) });
      setNotice('We’ll remind you in 3 hours.');
    } catch (cause) { setError(requestError(cause)); }
  }

  const filterButton = (entry: typeof FILTERS[number]) => {
    const count = unreadIn(inSide.filter(item => entry.id === 'all' || item.type === entry.id));
    const active = filter === entry.id;
    return <li key={entry.id}><button type="button" onClick={() => setFilter(entry.id)} aria-pressed={active}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[14px] transition ${active ? 'bg-[var(--surface-2)] font-semibold' : 'text-white/75 hover:bg-[var(--surface-2)]'}`}>
      <Icon name={entry.icon} size={16} className="shrink-0 opacity-70" />{entry.label}
      {count > 0 && <span className={`ml-auto rounded-full px-1.5 text-[11px] font-semibold leading-5 ${entry.id === 'mention' ? 'bg-brand' : ''}`}
        style={entry.id === 'mention' ? { color: 'var(--on-brand)' } : undefined}>{count}</span>}
    </button></li>;
  };

  return <div className="flex min-h-0 flex-1 gap-5">
    <aside aria-label="Activity filters" className="hidden w-56 shrink-0 flex-col lg:flex">
      <div role="tablist" aria-label="Work or social" className="mb-3 grid grid-cols-2 rounded-xl bg-[var(--surface-2)] p-1 text-sm">
        {(['work', 'social'] as const).map(value => <button key={value} type="button" role="tab" aria-selected={side === value} onClick={() => { setSide(value); setSelected(null); }}
          className={`rounded-lg py-1.5 font-medium capitalize transition ${side === value ? 'bg-[var(--surface)] shadow-sm' : 'text-white/60 hover:text-white'}`}>
          {value} · {counts[value]}</button>)}
      </div>
      <ul className="space-y-0.5">{FILTERS.map(filterButton)}</ul>
    </aside>

    <section aria-label="Activity" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <h2 className="text-xl font-bold capitalize">{side} activity</h2>
          <p className="text-sm text-white/55">{unreadIn(inSide)} unread{spaceCount > 1 ? ` across ${spaceCount} places` : ''}</p>
        </div>
        <label className="btn-ghost cursor-pointer"><input type="checkbox" className="accent-[var(--brand)]" checked={unreadOnly} onChange={event => setUnreadOnly(event.target.checked)} />Unread only</label>
        <button type="button" className="btn-ghost" disabled={!unreadIn(items)} onClick={() => void readAll()}><Icon name="check" size={15} />Mark all read</button>
      </div>
      <div className="mb-3 flex gap-1 overflow-x-auto lg:hidden">
        {(['work', 'social'] as const).map(value => <button key={value} type="button" onClick={() => setSide(value)} aria-pressed={side === value}
          className={`shrink-0 rounded-full px-3 py-1 text-sm capitalize ${side === value ? 'bg-brand font-semibold text-white' : 'bg-[var(--surface-2)]'}`}>{value} · {counts[value]}</button>)}
      </div>
      {needsYou.length > 0 && <div className="mb-3 flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#15171c] text-brand dark:bg-[#e8eaee]"><Icon name="sparkles" size={16} /></span>
        <p className="min-w-0 flex-1 text-sm"><strong>{needsYou.length} {needsYou.length === 1 ? 'item needs' : 'items need'} you.</strong> Mentions, direct messages and replies come first when sorted by priority.</p>
        <button type="button" className="btn-ghost shrink-0" aria-pressed={priority} onClick={() => setPriority(value => !value)}>{priority ? 'Newest first' : 'Sort by priority'}</button>
      </div>}
      {error && <p role="alert" className="mb-3 text-sm text-rose-500">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {!ready ? <div role="status" aria-label="Loading activity" className="space-y-2">{[1, 2, 3, 4].map(index => <div key={index} className="h-16 animate-pulse rounded-xl bg-[var(--surface-2)]" />)}</div>
          : !shown.length ? <div className="mt-16 flex flex-col items-center gap-2 text-center text-white/55">
            <Icon name="bell" size={36} />
            <p>{unreadOnly || filter !== 'all' ? 'Nothing here right now.' : side === 'work' ? 'No work activity yet. Mentions, replies and direct messages will show up here.' : 'No community activity yet. Comments and replies in communities show up here.'}</p>
          </div>
          : <ul className="space-y-1.5">{shown.map(item => <li key={item.id}>
            <button type="button" onClick={() => select(item)} aria-current={item.id === selected ? 'true' : undefined}
              className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition ${item.id === selected ? 'border-[var(--brand)] bg-brand-soft' : 'border-[var(--border)] hover:bg-[var(--surface-2)]'}`}>
              <span className="relative shrink-0">
                <Avatar name={actorName(item)} src={item.actor?.avatarUrl} size={36} />
                <span aria-hidden className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border-2 border-[var(--canvas)] bg-[#15171c] dark:bg-[#e8eaee]" style={{ color: 'var(--canvas)' }}>
                  <Icon name={ICONS[item.type]} size={10} /></span>
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-sm ${item.readAt ? '' : 'font-semibold'}`}>{describe(item)}</span>
                {item.snippet && item.type !== 'invite_accepted' && <span className="mt-0.5 line-clamp-1 block break-words text-sm text-white/60">{item.snippet}</span>}
                <span className="mt-0.5 block text-xs text-white/45">{placeOf(item)}{placeOf(item) ? ' · ' : ''}{timeLabel(item.createdAt)}</span>
              </span>
              {!item.readAt && <span aria-label="Unread" className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full bg-[#2b5fd9]" />}
            </button>
          </li>)}</ul>}
        {cursor && <div className="mt-3 text-center"><button type="button" className="btn-ghost" disabled={more} onClick={() => void load(cursor)}>{more ? 'Loading…' : 'Load more'}</button></div>}
      </div>
    </section>

    <aside aria-label="Selected activity" className="hidden w-80 shrink-0 flex-col border-l border-[var(--border)] pl-5 xl:flex">
      {!current ? <div className="mt-24 text-center text-sm text-white/50">
        <Icon name="inbox" size={32} className="mx-auto mb-2 opacity-60" />Select an item to see it here, reply, or turn it into a to-do.
      </div> : <>
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="min-w-0"><p className="text-xs text-white/50">{current.isDm ? 'Direct message' : current.spaceName}</p>
            <p className="truncate font-semibold">{current.isDm ? actorName(current) : current.channelName ? `#${current.channelName}` : describe(current)}</p></div>
          <button type="button" className="btn-ghost shrink-0" onClick={() => router.push(notificationHref(current))}>Open</button>
        </div>
        <div className={`rounded-xl border p-3 ${current.type === 'mention' ? 'border-[color-mix(in_srgb,var(--brand)_45%,transparent)] bg-brand-soft' : 'border-[var(--border)] bg-[var(--surface-2)]'}`}>
          <div className="mb-1 flex items-center gap-2"><Avatar name={actorName(current)} src={current.actor?.avatarUrl} size={24} />
            <span className="text-sm font-semibold">{actorName(current)}</span><span className="text-xs text-white/50">{timeLabel(current.createdAt)}</span></div>
          <p className="whitespace-pre-wrap break-words text-sm">{current.snippet || describe(current)}</p>
        </div>
        <div className="mt-4 grid gap-2">
          <button type="button" className="auth-button" onClick={() => router.push(notificationHref(current))}><Icon name="message" size={15} />{current.channelId ? 'Reply in conversation' : 'Open'}</button>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="btn-ghost justify-center" onClick={() => void remindLater(current)}><Icon name="clock" size={15} />Remind me later</button>
            <button type="button" className="btn-ghost justify-center" onClick={() => void addToTasks(current)}><Icon name="checkSquare" size={15} />Add to Tasks</button>
          </div>
          <button type="button" className="btn-ghost justify-center" onClick={() => { markRead(current); setSelected(null); }}><Icon name="check" size={15} />Mark done</button>
        </div>
        {notice && <p role="status" className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">{notice}</p>}
      </>}
    </aside>
  </div>;
}
