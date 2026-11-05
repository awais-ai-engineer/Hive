'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { conversationTitle, type Conversation, type UserResult } from '../../lib/dms';
import { apiData, type Channel } from '../../lib/spaces';

type Option =
  | { kind: 'channel'; id: string; label: string }
  | { kind: 'dm'; id: string; label: string }
  | { kind: 'person'; id: string; label: string; username: string };

type Props = {
  channels: Channel[];
  conversations: Conversation[];
  onOpen: (id: string) => void;
  onPerson: (username: string) => void;
};

/** "Find a conversation" box. Ctrl+K / ⌘K focuses it from anywhere on the Home screen. */
export function FindConversation({ channels, conversations, onOpen, onPerson }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<UserResult[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        input.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const term = query.trim();
    if (!term) { setPeople([]); return; }
    let live = true;
    const timer = setTimeout(() => {
      apiData<UserResult[]>(`/api/users/search?q=${encodeURIComponent(term)}`)
        .then(found => { if (live) setPeople(found); }).catch(() => {});
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [query]);

  const options = useMemo<Option[]>(() => {
    const term = query.trim().toLowerCase();
    if (!term) return [];
    const matches = (text: string) => text.toLowerCase().includes(term);
    const direct = new Set(conversations.filter(item => !item.is_group).map(item => item.participants[0]?.username));
    return [
      ...channels.filter(item => matches(item.name)).map(item => ({ kind: 'channel' as const, id: item.id, label: `# ${item.name}` })),
      ...conversations.filter(item => matches(conversationTitle(item))).map(item => ({ kind: 'dm' as const, id: item.id, label: conversationTitle(item) })),
      ...people.filter(person => !direct.has(person.username)).map(person => ({
        kind: 'person' as const, id: person.id, label: person.username, username: person.username,
      })),
    ].slice(0, 12);
  }, [query, channels, conversations, people]);

  useEffect(() => { setActive(0); }, [query]);

  function choose(option: Option) {
    if (option.kind === 'person') onPerson(option.username);
    else onOpen(option.id);
    setQuery(''); setOpen(false); input.current?.blur();
  }

  return <div className="relative">
    <input ref={input} value={query} aria-label="Find a conversation" placeholder="Find a conversation  (Ctrl+K)"
      role="combobox" aria-expanded={open && options.length > 0} aria-controls="find-results"
      className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/55 focus:border-white/40 focus:outline-none"
      onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
      onChange={event => { setQuery(event.target.value); setOpen(true); }}
      onKeyDown={event => {
        if (event.key === 'Escape') { setQuery(''); setOpen(false); input.current?.blur(); }
        else if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(index + 1, options.length - 1)); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(index - 1, 0)); }
        else if (event.key === 'Enter' && options[active]) { event.preventDefault(); choose(options[active]); }
      }} />
    {open && query.trim() && <ul id="find-results" role="listbox"
      className="on-surface absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-md border border-white/15 bg-surface py-1 shadow-xl">
      {options.map((option, index) => <li key={`${option.kind}:${option.id}`} role="option" aria-selected={index === active}>
        <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => choose(option)}
          className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm ${index === active ? 'bg-white/10 text-amber-400' : 'text-white/80'}`}>
          <span className="truncate">{option.label}</span>
          <span className="shrink-0 text-xs text-white/40">{option.kind === 'person' ? 'Message' : option.kind === 'dm' ? 'Conversation' : 'Channel'}</span>
        </button>
      </li>)}
      {!options.length && <li className="px-3 py-2 text-xs text-white/40">No matches</li>}
    </ul>}
  </div>;
}
