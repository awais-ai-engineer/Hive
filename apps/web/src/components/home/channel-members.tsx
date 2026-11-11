'use client';

import { Button as UiButton, Input as UiInput } from '@hive/ui';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../../lib/auth';
import type { UserResult } from '../../lib/dms';
import { apiData, requestError, type Channel, type Space } from '../../lib/spaces';
import { Avatar } from '../ui/avatar';

type Person = { id: string; username: string; avatar_url: string | null };

/** Popover for a private channel: who is in it, add people by username, remove people or leave. */
export function ChannelMembers({ space, channel, isAdmin, onLeft }: {
  space: Space; channel: Channel; isAdmin: boolean; onLeft: () => void;
}) {
  const { user } = useAuth();
  const base = `/api/spaces/${encodeURIComponent(space.slug)}/channels/${channel.id}/members`;
  const [people, setPeople] = useState<Person[]>([]);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<UserResult[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    apiData<Person[]>(base).then(setPeople).catch(cause => setError(requestError(cause)));
  }, [base]);
  useEffect(load, [load]);

  useEffect(() => {
    const term = query.trim();
    if (!term) { setFound([]); return; }
    let active = true;
    const timer = setTimeout(() => {
      apiData<UserResult[]>(`/api/users/search?q=${encodeURIComponent(term)}`)
        .then(list => { if (active) setFound(list.filter(item => !people.some(person => person.id === item.id))); })
        .catch(cause => { if (active) setError(requestError(cause)); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [query, people]);

  async function add(username: string) {
    setError('');
    try {
      await apiData(base, { method: 'POST', body: JSON.stringify({ username }) });
      setQuery(''); load();
    } catch (cause) { setError(requestError(cause)); }
  }
  async function remove(person: Person) {
    setError('');
    try {
      await apiData(`${base}/${person.id}`, { method: 'DELETE' });
      if (person.id === user?.id) onLeft(); else load();
    } catch (cause) { setError(requestError(cause)); }
  }
  const submit = (event: FormEvent) => { event.preventDefault(); if (query.trim()) void add(query.trim()); };

  return <div className="on-surface card absolute right-0 top-full z-30 mt-2 w-80 max-w-[90vw] p-4">
    <h2 className="text-sm font-semibold">Members of #{channel.name}</h2>
    <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
      {people.map(person => <li key={person.id} className="flex items-center gap-2 text-sm">
        <Avatar name={person.username} src={person.avatar_url} size={24} />
        <span className="min-w-0 flex-1 truncate">{person.username}</span>
        {person.id === user?.id ? <UiButton type="button" onClick={() => void remove(person)} className="text-xs text-rose-500 hover:underline">Leave channel</UiButton>
          : isAdmin && <UiButton tooltip={`Remove ${person.username}`} type="button" onClick={() => void remove(person)} aria-label={`Remove ${person.username}`} className="text-xs text-rose-500 hover:underline">Remove</UiButton>}
      </li>)}
    </ul>
    <form onSubmit={submit} className="mt-3 border-t border-white/10 pt-3">
      <label className="block text-xs font-medium">Add people
        <UiInput className="auth-input" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by username" /></label>
      {found.length > 0 && <ul className="mt-1 max-h-32 overflow-y-auto rounded-xl border border-white/10">
        {found.map(item => <li key={item.id}><UiButton type="button" onClick={() => void add(item.username)}
          className="flex w-full items-center gap-2 px-2 py-1.5 text-left justify-start text-sm hover:bg-brand-soft">
          <Avatar name={item.username} src={item.avatar_url} size={20} />{item.username}</UiButton></li>)}
      </ul>}
    </form>
    {error && <p role="alert" className="mt-2 text-xs text-rose-500">{error}</p>}
  </div>;
}
