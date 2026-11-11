'use client';

import { Button as UiButton, Combobox, Checkbox as UiCheckbox } from '@hive/ui';

import { useCallback, useRef, useState, type FormEvent } from 'react';
import type { Conversation, UserResult } from '../../lib/dms';
import { apiData, requestError } from '../../lib/spaces';

/** Pick people (who share a space with you) and open the conversation with exactly them. */
export function NewConversation({ onOpened, onCancel }: { onOpened: (id: string, conversation: Conversation) => void; onCancel: () => void }) {
  const people = useRef<UserResult[]>([]);
  const [chosen, setChosen] = useState<UserResult[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState(false);

  const loadPeople = useCallback(async (query: string, signal: AbortSignal) => {
    if (!query.trim()) return [];
    const found = await apiData<UserResult[]>(`/api/users/search?q=${encodeURIComponent(query.trim())}`, { signal });
    people.current = found;
    return found.filter(person => !chosen.some(item => item.id === person.id)).map(person => ({ value: person.id, label: person.username }));
  }, [chosen]);

  async function start(event: FormEvent) {
    event.preventDefault();
    if (!chosen.length) return;
    setBusy(true); setError('');
    try {
      const conversation = await apiData<Conversation>(secret && chosen.length === 1 ? '/api/dms/secret' : '/api/dms', {
        method: 'POST', body: JSON.stringify({ usernames: chosen.map(person => person.username) }),
      });
      onOpened(conversation.id, conversation);
    } catch (cause) { setError(requestError(cause)); }
    finally { setBusy(false); }
  }

  return <form onSubmit={start} className="rounded-lg border border-white/10 bg-canvas p-3">
    {chosen.length > 0 && <ul className="mb-2 flex flex-wrap gap-1">{chosen.map(person => <li key={person.id}
      className="flex items-center gap-1 rounded-full bg-amber-400/15 px-2 py-0.5 text-sm text-amber-400">
      {person.username}
      <UiButton tooltip={`Remove ${person.username}`} type="button" aria-label={`Remove ${person.username}`} onClick={() => setChosen(list => list.filter(item => item.id !== person.id))}>×</UiButton>
    </li>)}</ul>}
    <Combobox label="Add people" placeholder="Search people" loadOptions={loadPeople} disabled={chosen.length >= 8} onValueChange={id => { const person = people.current.find(item => item.id === id); if (person) setChosen(list => [...list, person]); }} />
    {chosen.length === 1 && <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm"><UiCheckbox className="mt-1 accent-[var(--brand)]" checked={secret} onChange={event => setSecret(event.target.checked)} />
      <span><span className="font-medium">Secret conversation</span><span className="block text-xs text-white/60">End-to-end encrypted, text only. Even Hive can&apos;t read it, and it only opens on your devices.</span></span></label>}
    {error && <p role="alert" className="mt-2 text-sm text-rose-400">{error}</p>}
    <div className="mt-3 flex justify-end gap-2 text-sm">
      <UiButton type="button" onClick={onCancel} className="px-3 py-1 text-white/60">Cancel</UiButton>
      <UiButton disabled={!chosen.length || busy} className="auth-button">{chosen.length > 1 ? 'Start group' : secret ? 'Start secret chat' : 'Start chat'}</UiButton>
    </div>
  </form>;
}
