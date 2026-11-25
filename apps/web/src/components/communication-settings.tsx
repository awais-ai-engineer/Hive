'use client';
import { Combobox, Button as UiButton, Input as UiInput, Select as UiSelect, Checkbox as UiCheckbox } from '@hive/ui';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiData, requestError } from '../lib/spaces';
import { SoundSettings } from './sound-settings';

type Schedule = { id: string; status: string; starts_at: string; ends_at: string; message: string | null; restrictions: string[]; exceptions: string[]; suppress_notifications: boolean; timezone: string };
const statuses = ['available', 'busy', 'in_a_meeting', 'out_of_office', 'do_not_disturb', 'on_leave', 'custom'];
const localInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export function CommunicationSettings() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [status, setStatus] = useState('in_a_meeting');
  const [start, setStart] = useState(() => localInput(new Date()));
  const [end, setEnd] = useState(() => localInput(new Date(Date.now() + 3600000)));
  const [restrictions, setRestrictions] = useState(['messages', 'media', 'voice', 'huddles']);
  const [message, setMessage] = useState('');
  const [exceptions, setExceptions] = useState('');
  const names = useRef<Record<string, string>>({});
  const [suppress, setSuppress] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => apiData<Schedule[]>('/api/me/availability').then(setSchedules);
  useEffect(() => {
    void load().catch(cause => setError(requestError(cause)));
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setSaved('');
    try {
      const startsAt = new Date(start); const endsAt = new Date(end);
      if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) throw new Error('Choose a valid start and end time.');
      if (endsAt <= startsAt) throw new Error('The end time must be after the start time.');
      if (endsAt.getTime() <= Date.now()) throw new Error('Choose an end time in the future.');
      await apiData(`/api/me/availability${editing ? `/${editing}` : ''}`, { method: editing ? 'PUT' : 'POST', body: JSON.stringify({ status, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, message: message || null, restrictions: status === 'available' ? [] : restrictions, exceptions: exceptions.split(',').map(id => id.trim()).filter(Boolean), suppress_notifications: status !== 'available' && suppress }) });
      await load(); setEditing(null); setSaved('Availability saved');
    } catch (cause) { setError(requestError(cause)); }
    finally { setBusy(false); }
  }
  async function cancel(id: string) {
    setBusy(true); setError('');
    try { await apiData(`/api/me/availability/${id}`, { method: 'DELETE' }); await load(); } catch (cause) { setError(requestError(cause)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-5">
    {error && <p role="alert" className="text-rose-500">{error}</p>}{saved && <p role="status">{saved}</p>}
    <SoundSettings />
    <form onSubmit={submit} className="card space-y-4 p-5"><h2 className="text-lg font-bold">Smart availability</h2><p className="text-sm text-white/60">Schedules use your timezone. Overlapping restrictions combine; cancelling a schedule restores any other active schedule.</p>
      <label className="block">Status<UiSelect className="auth-input mt-1" value={status} onChange={event => setStatus(event.target.value)}>{statuses.map(value => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</UiSelect></label>
      <div className="grid gap-3 sm:grid-cols-2"><label>Start<UiInput className="auth-input" type="datetime-local" required value={start} onChange={event => setStart(event.target.value)} /></label><label>End<UiInput className="auth-input" type="datetime-local" required value={end} onChange={event => setEnd(event.target.value)} /></label></div>
      <label className="block">Status message<UiInput className="auth-input" maxLength={280} value={message} onChange={event => setMessage(event.target.value)} /></label>
      <fieldset className="flex flex-wrap gap-4"><legend className="mb-2">Block direct contact</legend>{['messages', 'media', 'voice', 'huddles'].map(kind => <label className="flex items-center gap-2 capitalize" key={kind}><UiCheckbox checked={restrictions.includes(kind)} onChange={event => setRestrictions(event.target.checked ? [...restrictions, kind] : restrictions.filter(item => item !== kind))} />{kind}</label>)}</fieldset>
      <label className="flex items-center gap-2"><UiCheckbox checked={suppress} onChange={event => setSuppress(event.target.checked)} />Silence notifications and sounds</label>
      <fieldset><legend className="mb-2">Emergency exceptions</legend><p className="mb-2 text-sm text-white/60">Only people you choose here can bypass your direct-contact restrictions.</p><Combobox label="Allow emergency contact" placeholder="Search people" loadOptions={async (query, signal) => {
        if (!query.trim()) return [];
        const people = await apiData<{ id: string; username: string }[]>(`/api/users/search?q=${encodeURIComponent(query)}`, { signal });
        people.forEach(person => { names.current[person.id] = person.username; });
        return people.filter(person => !exceptions.split(',').includes(person.id)).map(person => ({ value: person.id, label: person.username }));
      }} onValueChange={id => setExceptions(current => [...current.split(',').filter(Boolean), id].join(','))} />
      <ul className="mt-2 flex flex-wrap gap-2">{exceptions.split(',').map(id => id.trim()).filter(Boolean).map(id => <li key={id} className="flex items-center gap-1 rounded-lg bg-brand-soft px-2 text-sm"><span>{names.current[id] ?? 'Authorized person'}</span><UiButton type="button" aria-label="Remove emergency exception" onClick={() => setExceptions(current => current.split(',').filter(value => value.trim() !== id).join(','))}>×</UiButton></li>)}</ul></fieldset>
      <UiButton disabled={busy} className="auth-button">{busy ? 'Saving…' : editing ? 'Update schedule' : 'Save availability'}</UiButton>
      <ul className="space-y-3">{schedules.map(item => <li className="rounded-xl border border-white/10 p-3" key={item.id}><strong className="capitalize">{item.status.replaceAll('_', ' ')}</strong><p className="text-sm">{new Date(item.starts_at).toLocaleString()} – {new Date(item.ends_at).toLocaleString()}</p><div className="mt-2 flex gap-2"><UiButton type="button" className="btn-ghost" onClick={() => { setEditing(item.id); setStatus(item.status); setStart(localInput(new Date(item.starts_at))); setEnd(localInput(new Date(item.ends_at))); setMessage(item.message ?? ''); setRestrictions(item.restrictions); setExceptions(item.exceptions.join(', ')); setSuppress(item.suppress_notifications); }}>Edit</UiButton><UiButton type="button" disabled={busy} className="btn-ghost" onClick={() => void cancel(item.id)}>Cancel schedule</UiButton></div></li>)}</ul>
    </form>
  </div>;
}
