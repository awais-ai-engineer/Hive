'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { Conversation, UserResult } from '../../lib/dms';
import { apiData, requestError } from '../../lib/spaces';

/** Pick people (who share a space with you) and open the conversation with exactly them. */
export function NewConversation({ onOpened, onCancel }: { onOpened: (id: string) => void; onCancel: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserResult[]>([]);
  const [chosen, setChosen] = useState<UserResult[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    let active = true;
    const timer = setTimeout(() => {
      apiData<UserResult[]>(`/api/users/search?q=${encodeURIComponent(query.trim())}`)
        .then(found => { if (active) setResults(found); })
        .catch(cause => { if (active) setError(requestError(cause)); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [query]);

  async function start(event: FormEvent) {
    event.preventDefault();
    if (!chosen.length) return;
    setBusy(true); setError('');
    try {
      const conversation = await apiData<Conversation>('/api/dms', {
        method: 'POST', body: JSON.stringify({ usernames: chosen.map(person => person.username) }),
      });
      onOpened(conversation.id);
    } catch (cause) { setError(requestError(cause)); }
    finally { setBusy(false); }
  }

  const available = results.filter(result => !chosen.some(person => person.id === result.id));
  return <form onSubmit={start} className="rounded-lg border border-white/10 bg-[#0b0d12] p-3">
    {chosen.length > 0 && <ul className="mb-2 flex flex-wrap gap-1">{chosen.map(person => <li key={person.id}
      className="flex items-center gap-1 rounded-full bg-amber-400/15 px-2 py-0.5 text-sm text-amber-400">
      {person.username}
      <button type="button" aria-label={`Remove ${person.username}`} onClick={() => setChosen(list => list.filter(item => item.id !== person.id))}>×</button>
    </li>)}</ul>}
    <input autoFocus className="auth-input" aria-label="Search people" placeholder="Search by username"
      value={query} onChange={event => setQuery(event.target.value)} disabled={chosen.length >= 8} />
    {available.length > 0 && <ul className="mt-1 rounded border border-white/10">{available.map(result => <li key={result.id}>
      <button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-white/5"
        onClick={() => { setChosen(list => [...list, result]); setQuery(''); }}>{result.username}</button>
    </li>)}</ul>}
    {query.trim() && !available.length && <p className="mt-2 text-xs text-white/40">No one found. You can message people who share a space with you.</p>}
    {error && <p role="alert" className="mt-2 text-sm text-rose-400">{error}</p>}
    <div className="mt-3 flex justify-end gap-2 text-sm">
      <button type="button" onClick={onCancel} className="px-3 py-1 text-white/60">Cancel</button>
      <button disabled={!chosen.length || busy} className="auth-button">{chosen.length > 1 ? 'Start group' : 'Start chat'}</button>
    </div>
  </form>;
}
