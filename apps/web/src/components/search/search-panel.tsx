'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { conversationTitle, DM_OPENED, type Conversation, type UserResult } from '../../lib/dms';
import {
  clearRecentSearches, GROUP_LABELS, hitHref, hitPlace, NO_FILTERS, recentSearches, rememberSearch, runSearch, TYPE_TABS,
  type Hit, type SearchFilters, type SearchResponse, type SearchType, type Segment,
} from '../../lib/search';
import { apiData, requestError, type Space } from '../../lib/spaces';
import { Avatar } from '../ui/avatar';
import { Icon, type IconName } from '../ui/icons';

const ICONS: Record<Hit['type'], IconName> = { message: 'message', post: 'layers', comment: 'threads', person: 'user', channel: 'hash', file: 'file' };

function Highlight({ parts }: { parts: Segment[] }) {
  return <>{parts.map((part, index) => part.match
    ? <mark key={index} className="rounded bg-brand-soft px-0.5 text-brand">{part.text}</mark>
    : <span key={index}>{part.text}</span>)}</>;
}

type Row =
  | { key: string; kind: 'hit'; hit: Hit }
  | { key: string; kind: 'dm'; id: string; label: string }
  | { key: string; kind: 'person'; username: string; label: string };

/** Search box with results, shared by the Ctrl+K dialog and the full search page. */
export function SearchPanel({ variant, initialQuery = '', onDone }: { variant: 'palette' | 'page'; initialQuery?: string; onDone?: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [type, setType] = useState<SearchType>('all');
  const [filters, setFilters] = useState<SearchFilters>(NO_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [person, setPerson] = useState('');
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [extra, setExtra] = useState<Hit[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [people, setPeople] = useState<UserResult[]>([]);
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const run = useRef(0);
  const term = query.trim();

  useEffect(() => {
    input.current?.focus();
    setRecent(recentSearches());
    apiData<Conversation[]>('/api/dms').then(setConversations).catch(() => {});
    apiData<Space[]>('/api/me/spaces').then(setSpaces).catch(() => {});
  }, []);

  // A typed username becomes the "from person" filter once it matches someone exactly.
  useEffect(() => {
    const name = person.trim();
    if (!name) { setFilters(current => current.authorId ? { ...current, authorId: '' } : current); return; }
    const timer = setTimeout(() => {
      apiData<UserResult[]>(`/api/users/search?q=${encodeURIComponent(name)}`)
        .then(found => setFilters(current => ({ ...current, authorId: found.find(item => item.username.toLowerCase() === name.toLowerCase())?.id ?? '' })))
        .catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [person]);

  useEffect(() => {
    if (!term) { setPeople([]); return; }
    let live = true;
    const timer = setTimeout(() => {
      apiData<UserResult[]>(`/api/users/search?q=${encodeURIComponent(term)}`).then(found => { if (live) setPeople(found); }).catch(() => {});
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [term]);

  useEffect(() => {
    setExtra([]); setCursor(null); setActive(0);
    if (term.length < 2) { setResponse(null); setError(''); return; }
    const id = ++run.current;
    setBusy(true);
    const timer = setTimeout(() => {
      runSearch(term, type, filters)
        .then(result => { if (id === run.current) { setResponse(result); setCursor(result.nextCursor); setError(''); } })
        .catch(cause => { if (id === run.current) { setResponse(null); setError(requestError(cause)); } })
        .finally(() => { if (id === run.current) setBusy(false); });
    }, 250);
    return () => clearTimeout(timer);
  }, [term, type, filters]);

  const filtered = !!(filters.spaceId || person.trim() || filters.from || filters.to);
  const rows = useMemo<Row[]>(() => {
    const list: Row[] = [];
    const needle = term.toLowerCase();
    if (needle && variant === 'palette' && type === 'all') {
      const direct = new Set(conversations.filter(item => !item.is_group).map(item => item.participants[0]?.username));
      conversations.filter(item => conversationTitle(item).toLowerCase().includes(needle)).slice(0, 4)
        .forEach(item => list.push({ key: `dm:${item.id}`, kind: 'dm', id: item.id, label: conversationTitle(item) }));
      people.filter(item => !direct.has(item.username)).slice(0, 3)
        .forEach(item => list.push({ key: `person:${item.id}`, kind: 'person', username: item.username, label: item.username }));
    }
    const hits = response?.groups ? Object.values(response.groups).flat() : [...(response?.items ?? []), ...extra];
    hits.forEach(hit => list.push({ key: `${hit.type}:${hit.id}`, kind: 'hit', hit }));
    return list;
  }, [term, variant, type, conversations, people, response, extra]);

  function finish() { onDone?.(); }
  async function choose(row: Row) {
    rememberSearch(term);
    if (row.kind === 'dm') router.push(`/home?c=${row.id}`);
    else if (row.kind === 'person') {
      try {
        const conversation = await apiData<Conversation>('/api/dms', { method: 'POST', body: JSON.stringify({ usernames: [row.username] }) });
        window.dispatchEvent(new CustomEvent(DM_OPENED, { detail: conversation }));
        router.push(`/home?c=${conversation.id}`);
      } catch (cause) { setError(requestError(cause)); return; }
    } else {
      const href = hitHref(row.hit);
      if (!href) return;
      router.push(href);
    }
    finish();
  }
  async function more() {
    if (!cursor) return;
    setBusy(true);
    try {
      const page = await runSearch(term, type, filters, cursor);
      setExtra(current => [...current, ...(page.items ?? [])]);
      setCursor(page.nextCursor);
    } catch (cause) { setError(requestError(cause)); }
    finally { setBusy(false); }
  }

  function onKey(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(index + 1, rows.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(index - 1, 0)); }
    else if (event.key === 'Enter' && rows[active]) { event.preventDefault(); void choose(rows[active]); }
    else if (event.key === 'Escape' && variant === 'palette') { event.preventDefault(); finish(); }
  }
  useEffect(() => {
    document.getElementById(`search-row-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const field = 'auth-input !mt-0';
  const grouped = response?.groups;
  let index = -1;
  const renderRow = (row: Row) => {
    index += 1;
    const position = index;
    const selected = position === active;
    const style = `flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left text-sm ${selected ? 'bg-brand-soft' : 'hover:bg-[var(--surface-2)]'}`;
    if (row.kind !== 'hit') {
      return <li key={row.key} id={`search-row-${position}`} role="option" aria-selected={selected}>
        <button type="button" className={style} onMouseMove={() => setActive(position)} onClick={() => void choose(row)}>
          <Icon name={row.kind === 'dm' ? 'message' : 'user'} size={16} className="mt-0.5 shrink-0 text-white/50" />
          <span className="min-w-0 flex-1 truncate font-medium">{row.label}</span>
          <span className="shrink-0 text-xs text-white/45">{row.kind === 'dm' ? 'Conversation' : 'Message'}</span>
        </button>
      </li>;
    }
    const hit = row.hit;
    return <li key={row.key} id={`search-row-${position}`} role="option" aria-selected={selected}>
      <button type="button" className={style} onMouseMove={() => setActive(position)} onClick={() => void choose(row)}>
        {hit.type === 'person' && hit.author ? <Avatar name={hit.author.username} src={hit.author.avatarUrl} size={28} />
          : <Icon name={ICONS[hit.type]} size={16} className="mt-0.5 shrink-0 text-white/50" />}
        <span className="min-w-0 flex-1">
          {hit.title.length > 0 && <span className="block truncate font-medium"><Highlight parts={hit.title} /></span>}
          {hit.snippet.length > 0 && <span className="line-clamp-2 block break-words text-white/70"><Highlight parts={hit.snippet} /></span>}
          <span className="block truncate text-xs text-white/45">
            {hit.type !== 'person' && hit.type !== 'channel' && hit.author ? `${hit.author.displayName || hit.author.username} · ` : ''}
            {hitPlace(hit)}{hit.createdAt && hit.type !== 'person' && hit.type !== 'channel' ? ` · ${new Date(hit.createdAt).toLocaleDateString()}` : ''}
          </span>
        </span>
      </button>
    </li>;
  };

  const body = <>
    <div className="flex items-center gap-2">
      <div className="relative flex-1">
        <Icon name="search" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/45" />
        <input ref={input} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onKey} maxLength={200}
          role="combobox" aria-expanded={rows.length > 0} aria-controls="search-results" aria-label="Search Hive"
          placeholder="Search messages, posts, people, channels and files" className={`${field} !pl-9`} />
      </div>
      <button type="button" className={`btn-ghost ${filtered ? '!text-brand' : ''}`} aria-expanded={showFilters} aria-controls="search-filters" onClick={() => setShowFilters(value => !value)}>Filters</button>
      {variant === 'palette' && <button type="button" className="btn-ghost !px-2" aria-label="Close search" title="Close" onClick={finish}><Icon name="x" size={16} /></button>}
    </div>
    <div role="tablist" aria-label="Result type" className="mt-3 flex gap-1 overflow-x-auto">
      {TYPE_TABS.map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={type === value} onClick={() => setType(value)}
        className={`whitespace-nowrap rounded-full px-3 py-1 text-sm font-medium ${type === value ? 'bg-brand-soft text-brand' : 'text-white/60 hover:bg-[var(--surface-2)]'}`}>{label}</button>)}
    </div>
    {showFilters && <div id="search-filters" className="mt-3 grid gap-2 sm:grid-cols-4">
      <label className="text-xs font-medium">Space
        <select className={field} value={filters.spaceId} onChange={event => setFilters({ ...filters, spaceId: event.target.value })}>
          <option value="">Any space</option>{spaces.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}
        </select></label>
      <label className="text-xs font-medium">From person
        <input className={field} value={person} placeholder="username" maxLength={32} onChange={event => setPerson(event.target.value)} />
        {person.trim() && !filters.authorId && <span className="text-[11px] font-normal text-white/50">No exact match yet</span>}</label>
      <label className="text-xs font-medium">From date
        <input type="date" className={field} value={filters.from} max={filters.to || undefined} onChange={event => setFilters({ ...filters, from: event.target.value })} /></label>
      <label className="text-xs font-medium">To date
        <input type="date" className={field} value={filters.to} min={filters.from || undefined} onChange={event => setFilters({ ...filters, to: event.target.value })} /></label>
    </div>}
    {error && <p role="alert" className="mt-3 text-sm text-rose-500">{error}</p>}
    <div className={`mt-3 overflow-y-auto ${variant === 'palette' ? 'max-h-[55vh]' : ''}`} aria-busy={busy}>
      {term.length < 2 && !rows.length ? <div className="py-6 text-sm text-white/55">
        {recent.length > 0 ? <>
          <div className="mb-1 flex items-center justify-between"><p className="text-xs font-semibold uppercase tracking-wide">Recent searches</p>
            <button type="button" className="text-xs underline" onClick={() => { clearRecentSearches(); setRecent([]); }}>Clear</button></div>
          <ul>{recent.map(item => <li key={item}><button type="button" className="w-full rounded-lg px-3 py-1.5 text-left hover:bg-[var(--surface-2)]" onClick={() => setQuery(item)}>
            <Icon name="clock" size={14} className="mr-2 inline" />{item}</button></li>)}</ul>
        </> : <p>Type at least two letters to search everything you can read.</p>}
      </div>
        : busy && !rows.length ? <div role="status" aria-label="Searching" className="space-y-2 py-2">{[1, 2, 3].map(item => <div key={item} className="h-12 animate-pulse rounded-lg bg-white/5" />)}</div>
        : !rows.length && term.length >= 2 ? <div className="flex flex-col items-center gap-2 py-10 text-center text-white/55">
          <Icon name="search" size={30} /><p>No results for “{term}”.</p>
          {(filtered || type !== 'all') && <button type="button" className="btn-ghost" onClick={() => { setType('all'); setFilters(NO_FILTERS); setPerson(''); }}>Search everywhere</button>}
        </div>
        : <ul id="search-results" role="listbox" aria-label="Search results">
          {grouped ? <>
            {rows.filter(row => row.kind !== 'hit').map(renderRow)}
            {Object.entries(grouped).filter(([, hits]) => hits.length).map(([name, hits]) => <li key={name} role="presentation">
              <p className="mt-2 flex items-center justify-between px-3 text-xs font-semibold uppercase tracking-wide text-white/50">{GROUP_LABELS[name]}
                <button type="button" className="text-brand normal-case underline" onClick={() => setType(name as SearchType)}>See all</button></p>
              <ul role="presentation">{hits.map(hit => renderRow({ key: `${hit.type}:${hit.id}`, kind: 'hit', hit }))}</ul>
            </li>)}
          </> : rows.map(renderRow)}
          {cursor && <li role="presentation" className="py-2 text-center"><button type="button" className="btn-ghost" disabled={busy} onClick={() => void more()}>{busy ? 'Loading…' : 'Load more'}</button></li>}
        </ul>}
    </div>
  </>;
  return variant === 'palette' ? <div>{body}</div> : <div className="mx-auto w-full max-w-3xl">{body}</div>;
}
