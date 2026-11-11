'use client';

import { Button as UiButton, Textarea as UiTextarea, DateTimePicker as UiDateTimePicker } from '@hive/ui';

import { useCallback, useEffect, useState } from 'react';
import { placeLabel, type Place } from '../../lib/home';
import { apiData, requestError } from '../../lib/spaces';
import { DRAFTS_CHANGED } from '../../lib/composer-drafts';

type Draft = { channelId: string; parentId: string | null; body: string; updatedAt: string; place: Place };
type Scheduled = { id: string; channelId: string; parentId: string | null; body: string; sendAt: string; failedAt: string | null; place: Place };
type Reminder = { id: string; text: string; remindAt: string };
type Tab = 'drafts' | 'scheduled' | 'reminders';

const when = (value: string) => new Date(value).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const toInput = (value: string) => { const date = new Date(value); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return date.toISOString().slice(0, 16); };

/** Unsent drafts, messages waiting to be sent later, and personal reminders. */
export function DraftsView({ onOpen }: { onOpen: (place: Place, threadId: string | null) => void }) {
  const [tab, setTab] = useState<Tab>('drafts');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [scheduled, setScheduled] = useState<Scheduled[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string; sendAt: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, s, r] = await Promise.all([apiData<Draft[]>('/api/drafts'), apiData<Scheduled[]>('/api/scheduled'), apiData<Reminder[]>('/api/reminders')]);
      setDrafts(d); setScheduled(s); setReminders(r); setError('');
    } catch (cause) { setError(requestError(cause)); }
    finally { setReady(true); }
  }, []);
  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener(DRAFTS_CHANGED, refresh);
    return () => window.removeEventListener(DRAFTS_CHANGED, refresh);
  }, [load]);

  async function act(run: () => Promise<unknown>) {
    try { await run(); await load(); } catch (cause) { setError(requestError(cause)); }
  }
  const discardDraft = (draft: Draft) => act(() => apiData(`/api/channels/${draft.channelId}/draft`, { method: 'PUT', body: JSON.stringify({ parentId: draft.parentId, body: '' }) }));
  const cancelScheduled = (item: Scheduled) => act(() => apiData(`/api/scheduled/${item.id}`, { method: 'DELETE' }));
  const cancelReminder = (item: Reminder) => act(() => apiData(`/api/reminders/${item.id}`, { method: 'DELETE' }));
  const saveEdit = () => editing && act(async () => {
    const sendAt = new Date(editing.sendAt);
    if (!Number.isFinite(sendAt.getTime()) || sendAt.getTime() <= Date.now()) throw new Error('Choose a future date and time.');
    await apiData(`/api/scheduled/${editing.id}`, { method: 'PATCH', body: JSON.stringify({ body: editing.body, sendAt: sendAt.toISOString() }) });
    setEditing(null);
  });

  const tabs: [Tab, string, number][] = [['drafts', 'Drafts', drafts.length], ['scheduled', 'Scheduled', scheduled.length], ['reminders', 'Reminders', reminders.length]];
  const empty: Record<Tab, string> = {
    drafts: 'No drafts. Anything you type and don’t send is kept here automatically.',
    scheduled: 'Nothing scheduled. Use the arrow next to Send to send a message later.',
    reminders: 'No reminders. Type /remind in 30m call the bank in any chat.',
  };
  const count = tab === 'drafts' ? drafts.length : tab === 'scheduled' ? scheduled.length : reminders.length;

  return <div className="min-h-0 flex-1 overflow-y-auto pr-1">
    <div role="tablist" aria-label="Drafts and scheduled" className="mb-4 flex gap-1 border-b border-white/10">
      {tabs.map(([id, label, total]) => <UiButton key={id} role="tab" type="button" aria-selected={tab === id} onClick={() => setTab(id)}
        className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === id ? 'border-brand text-brand' : 'border-transparent text-white/60 hover:text-white'}`}>
        {label}{total > 0 && <span className="ml-1.5 rounded-full bg-brand-soft px-1.5 text-xs text-brand">{total}</span>}</UiButton>)}
    </div>
    {error && <p role="alert" className="mb-3 text-sm text-rose-500">{error}</p>}
    {!ready ? <p className="text-white/50">Loading…</p> : !count ? <p className="mt-16 text-center text-white/50">{empty[tab]}</p> : <ul className="space-y-3">
      {tab === 'drafts' && drafts.map(draft => <li key={`${draft.channelId}:${draft.parentId ?? ''}`} className="card p-4">
        <p className="text-xs font-medium text-white/50">{placeLabel(draft.place)}{draft.parentId ? ' · in a thread' : ''} · edited {when(draft.updatedAt)}</p>
        <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words">{draft.body}</p>
        <div className="mt-3 flex gap-2">
          <UiButton type="button" className="auth-button text-sm" onClick={() => onOpen(draft.place, draft.parentId)}>Continue writing</UiButton>
          <UiButton type="button" className="btn-ghost text-rose-500" onClick={() => void discardDraft(draft)}>Discard</UiButton>
        </div>
      </li>)}
      {tab === 'scheduled' && scheduled.map(item => <li key={item.id} className="card p-4">
        <p className="text-xs font-medium text-white/50">{placeLabel(item.place)}{item.parentId ? ' · in a thread' : ''}</p>
        {item.failedAt
          ? <p className="mt-1 text-sm font-medium text-rose-500">Not sent: you no longer have access to this conversation.</p>
          : <p className="mt-1 text-sm font-medium text-brand">Sends {when(item.sendAt)}</p>}
        {editing?.id === item.id ? <div className="mt-2 space-y-2">
          <UiTextarea aria-label="Message" className="auth-input" rows={3} maxLength={4000} value={editing.body} onChange={event => setEditing({ ...editing, body: event.target.value })} />
          <label className="block text-sm">Send at<UiDateTimePicker label="Send at" className="auth-input" value={editing.sendAt} onChange={event => setEditing({ ...editing, sendAt: event.target.value })} /></label>
          <div className="flex gap-2"><UiButton type="button" className="auth-button text-sm" onClick={() => void saveEdit()}>Save</UiButton><UiButton type="button" className="btn-ghost" onClick={() => setEditing(null)}>Cancel</UiButton></div>
        </div> : <>
          <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words">{item.body}</p>
          <div className="mt-3 flex gap-2">
            {!item.failedAt && <UiButton type="button" className="btn-ghost" onClick={() => setEditing({ id: item.id, body: item.body, sendAt: toInput(item.sendAt) })}>Edit</UiButton>}
            <UiButton type="button" className="btn-ghost text-rose-500" onClick={() => void cancelScheduled(item)}>{item.failedAt ? 'Dismiss' : 'Cancel sending'}</UiButton>
          </div>
        </>}
      </li>)}
      {tab === 'reminders' && reminders.map(item => <li key={item.id} className="card flex items-start justify-between gap-3 p-4">
        <div><p className="text-sm font-medium text-brand">{when(item.remindAt)}</p><p className="mt-1 break-words">{item.text}</p></div>
        <UiButton type="button" className="btn-ghost text-rose-500" onClick={() => void cancelReminder(item)}>Delete</UiButton>
      </li>)}
    </ul>}
  </div>;
}
