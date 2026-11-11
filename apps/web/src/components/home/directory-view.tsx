'use client';

import { Button as UiButton, Input as UiInput } from '@hive/ui';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { apiData, requestError, type Space } from '../../lib/spaces';
import type { StatusFields } from '../../lib/status';
import { activeStatus, dayText, untilText } from '../../lib/status';
import { Avatar } from '../ui/avatar';
import { Icon } from '../ui/icons';
import { StatusMark } from '../ui/status-mark';

export type DirectoryTab = 'people' | 'channels';

type Person = StatusFields & { id: string; username: string; display_name: string | null; avatar_url: string | null; online: boolean };
type DirectoryChannel = { id: string; name: string; type: string; topic: string | null; is_private: boolean; member_count: number };
type Page<T> = { items: T[]; next_cursor: string | null };

/** Loads a searchable, "load more" list from a directory endpoint. */
function useDirectory<T>(path: string | null, query: string) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const fetchPage = useCallback(async (after: string | null) => {
    if (!path) return null;
    const params = new URLSearchParams({ limit: '50' });
    if (query.trim()) params.set('q', query.trim());
    if (after) params.set('cursor', after);
    return apiData<Page<T>>(`${path}${path.includes('?') ? '&' : '?'}${params}`);
  }, [path, query]);

  useEffect(() => {
    let active = true;
    setState('loading');
    const timer = setTimeout(() => {
      fetchPage(null).then(page => {
        if (!active || !page) return;
        setItems(page.items); setCursor(page.next_cursor); setState('ready');
      }).catch(cause => { if (active) { setError(requestError(cause)); setState('error'); } });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [fetchPage]);

  async function more() {
    try {
      const page = await fetchPage(cursor);
      if (page) { setItems(current => [...current, ...page.items]); setCursor(page.next_cursor); }
    } catch (cause) { setError(requestError(cause)); setState('error'); }
  }
  return { items, hasMore: !!cursor, more, state, error };
}

function PersonRow({ person, onMessage }: { person: Person; onMessage: (username: string) => void }) {
  const status = activeStatus(person);
  const name = person.display_name || person.username;
  return <li className="flex flex-wrap items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-[var(--surface-2)]">
    <Avatar name={person.username} src={person.avatar_url} size={44} online={person.online} />
    <div className="min-w-0 flex-1">
      <p className="flex items-center gap-1.5 truncate font-semibold">{name}<StatusMark person={person} />
        {person.display_name && <span className="truncate text-sm font-normal text-white/50">@{person.username}</span>}</p>
      <p className="truncate text-sm text-white/60">
        {status.text ? `${status.emoji ?? ''} ${status.text}${status.until ? ` · until ${untilText(status.until)}` : ''}`.trim()
          : status.emoji ?? (person.online ? 'Online' : 'Offline')}
        {status.away && <span> · Out of office until {dayText(status.away)}</span>}
      </p>
    </div>
    <div className="flex shrink-0 gap-2">
      <UiButton type="button" onClick={() => onMessage(person.username)} className="auth-button !px-3 !py-1.5 text-sm">
        <Icon name="message" size={15} />Message</UiButton>
      <Link href={`/u/${person.username}`} className="btn-ghost !py-1.5"><Icon name="user" size={15} />View profile</Link>
    </div>
  </li>;
}

/** The "Directories" view: find people you share a space with, and browse the current space's channels. */
export function DirectoryView({ space, tab, onTab, onMessage, onOpenChannel }: {
  space: Space | null; tab: DirectoryTab; onTab: (tab: DirectoryTab) => void;
  onMessage: (username: string) => void; onOpenChannel: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  useEffect(() => setQuery(''), [tab, space?.slug]);
  const people = useDirectory<Person>(tab === 'people' ? '/api/directory/people' : null, query);
  const channels = useDirectory<DirectoryChannel>(tab === 'channels' && space ? `/api/directory/channels?space=${encodeURIComponent(space.slug)}` : null, query);
  const list = tab === 'people' ? people : channels;

  const tabButton = (value: DirectoryTab, label: string, icon: 'users' | 'hash') =>
    <UiButton type="button" role="tab" aria-selected={tab === value} onClick={() => onTab(value)}
      className={`flex items-center gap-2 border-b-2 px-1 pb-2.5 pt-1 text-sm font-medium transition ${tab === value ? 'border-brand text-brand' : 'border-transparent text-white/55 hover:text-white'}`}>
      <Icon name={icon} size={16} />{label}</UiButton>;

  return <div className="flex min-h-0 flex-1 flex-col">
    <p className="mb-3 text-sm text-white/60">{tab === 'people' ? 'Everyone who shares a space with you.' : space ? `All channels you can open in ${space.name}.` : 'Choose a space to see its channels.'}</p>
    <div role="tablist" aria-label="Directory" className="flex gap-6 border-b border-white/10">
      {tabButton('people', 'People', 'users')}{tabButton('channels', 'Channels', 'hash')}
    </div>
    <label className="relative mt-3 block">
      <span className="sr-only">{tab === 'people' ? 'Search people' : 'Search channels'}</span>
      <Icon name="search" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/45" />
      <UiInput type="search" className="auth-input !mt-0 pl-9" value={query} maxLength={50} onChange={event => setQuery(event.target.value)}
        placeholder={tab === 'people' ? 'Search by name or username' : 'Search channels'} />
    </label>
    <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1" aria-live="polite" aria-busy={list.state === 'loading'}>
      {list.state === 'error' && <p role="alert" className="text-sm text-rose-500">{list.error}</p>}
      {list.state === 'loading' && !list.items.length && <p className="text-sm text-white/50">Loading…</p>}
      {list.state === 'ready' && !list.items.length && <p className="rounded-xl border border-dashed border-white/15 p-6 text-center text-sm text-white/60">
        {query.trim() ? 'Nothing matches your search.' : tab === 'people' ? 'Nobody else is here yet. Invite people to a space and they will show up.' : 'There are no channels to show yet.'}</p>}
      {tab === 'people' && <ul className="space-y-0.5">{people.items.map(person => <PersonRow key={person.id} person={person} onMessage={onMessage} />)}</ul>}
      {tab === 'channels' && <ul className="space-y-0.5">{channels.items.map(channel => <li key={channel.id} className="flex flex-wrap items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-[var(--surface-2)]">
        <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand"><Icon name={channel.is_private ? 'lock' : channel.type === 'voice' ? 'volume' : 'hash'} size={18} /></span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 truncate font-semibold">{channel.name}
            {channel.is_private && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-xs font-medium text-brand">Private</span>}</p>
          <p className="truncate text-sm text-white/60">{channel.topic || 'No topic yet'} · {channel.member_count} {channel.member_count === 1 ? 'member' : 'members'}</p>
        </div>
        <UiButton type="button" onClick={() => onOpenChannel(channel.id)} className="btn-ghost !py-1.5" tooltip="You are already part of this space, so you can open any channel here">Open</UiButton>
      </li>)}</ul>}
      {list.hasMore && <UiButton type="button" onClick={() => void list.more()} className="btn-ghost mx-auto mt-3 flex">Show more</UiButton>}
    </div>
  </div>;
}
