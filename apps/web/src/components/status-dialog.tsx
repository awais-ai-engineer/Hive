'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { apiFetch, responseData, type User } from '../lib/api';
import { requestError } from '../lib/spaces';
import { activeStatus, localDay } from '../lib/status';
import { Icon } from './ui/icons';

const PRESETS: [string, string][] = [['🗓️', 'In a meeting'], ['🚌', 'Commuting'], ['🤒', 'Out sick'], ['🌴', 'Vacationing'], ['🏠', 'Working remotely']];
const EMOJI = ['😀', '🙂', '😎', '🤔', '🎉', '🔥', '💡', '🎧', '☕', '🚀'];
const CLEAR_AFTER = [
  ['never', "Don't clear"], ['30m', '30 minutes'], ['1h', '1 hour'], ['4h', '4 hours'],
  ['today', 'Today'], ['week', 'This week'], ['custom', 'Choose date and time…'],
] as const;
type Clear = typeof CLEAR_AFTER[number][0];

const pad = (value: number) => String(value).padStart(2, '0');
const dayValue = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const inputValue = (date: Date) => `${dayValue(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** When a status should clear, as a Date (null: never). */
function expiry(choice: Clear, custom: string): Date | null {
  const now = new Date();
  if (choice === '30m') return new Date(now.getTime() + 30 * 60_000);
  if (choice === '1h') return new Date(now.getTime() + 60 * 60_000);
  if (choice === '4h') return new Date(now.getTime() + 4 * 60 * 60_000);
  if (choice === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  if (choice === 'week') return new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((7 - now.getDay()) % 7), 23, 59, 59);
  if (choice === 'custom' && custom) return new Date(custom);
  return null;
}

/** Modal to set a status (emoji, text, when it clears) and an out-of-office end date. */
export function StatusDialog({ user, onSaved, onClose }: { user: User; onSaved: (user: User) => void; onClose: () => void }) {
  const current = activeStatus(user);
  const [emoji, setEmoji] = useState(current.emoji ?? '');
  const [text, setText] = useState(current.text ?? '');
  const [clear, setClear] = useState<Clear>(current.until ? 'custom' : 'never');
  const [custom, setCustom] = useState(current.until ? inputValue(new Date(current.until)) : '');
  const [away, setAway] = useState(!!current.away);
  const [awayDate, setAwayDate] = useState(current.away ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function save(body: object) {
    setBusy(true); setError('');
    try {
      onSaved(await responseData<User>(await apiFetch('/api/me', { method: 'PATCH', body: JSON.stringify(body) })));
      onClose();
    } catch (cause) { setError(requestError(cause)); setBusy(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const hasStatus = !!(emoji.trim() || text.trim());
    const when = hasStatus ? expiry(clear, custom) : null;
    if (clear === 'custom' && hasStatus && (!when || Number.isNaN(when.getTime()))) return setError('Choose when your status should clear.');
    if (when && when.getTime() <= Date.now()) return setError('That time has already passed. Choose a later time.');
    if (away && !awayDate) return setError('Choose the last day you are out of office.');
    if (away && localDay(awayDate) < localDay(dayValue(new Date()))) return setError('Out of office must end today or later.');
    void save({
      status_emoji: emoji.trim() || null, status_text: text.trim() || null,
      status_expires_at: when ? when.toISOString() : null, out_of_office_until: away ? awayDate : null,
    });
  }

  return <div className="on-surface fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4">
    <button type="button" aria-label="Close" onClick={onClose} className="fixed inset-0 bg-[rgb(0_0_0/0.5)]" />
    <form role="dialog" aria-modal="true" aria-label="Set a status" onSubmit={submit} className="card relative my-auto w-full max-w-md space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Set a status</h2>
        <button type="button" onClick={onClose} aria-label="Close dialog" className="rounded p-1 text-white/60 hover:bg-white/10"><Icon name="x" size={18} /></button>
      </div>
      <div className="flex gap-2">
        <input aria-label="Status emoji" className="auth-input !mt-0 !w-14 text-center text-xl" maxLength={16} value={emoji} placeholder="💬" onChange={event => setEmoji(event.target.value)} />
        <input aria-label="Status text" className="auth-input !mt-0" autoFocus maxLength={80} value={text} placeholder="What are you up to?" onChange={event => setText(event.target.value)} />
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Suggested emoji">
        {EMOJI.map(item => <button key={item} type="button" aria-pressed={emoji === item} onClick={() => setEmoji(emoji === item ? '' : item)}
          className={`h-9 w-9 rounded-lg text-lg hover:bg-[var(--surface-2)] ${emoji === item ? 'bg-brand-soft ring-2 ring-brand' : ''}`}>{item}</button>)}
      </div>
      <div>
        <p className="mb-1 text-sm font-medium">Quick picks</p>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map(([e, t]) => <button key={t} type="button" onClick={() => { setEmoji(e); setText(t); if (t === 'Vacationing' || t === 'Out sick') setAway(true); }}
            className="rounded-full border border-white/10 bg-[var(--surface-2)] px-3 py-1 text-sm hover:border-brand/50">{e} {t}</button>)}
        </div>
      </div>
      <label className="block text-sm font-medium">Clear after
        <select className="auth-input" value={clear} onChange={event => setClear(event.target.value as Clear)}>
          {CLEAR_AFTER.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      {clear === 'custom' && <label className="block text-sm font-medium">Clear on
        <input type="datetime-local" className="auth-input" value={custom} min={inputValue(new Date())} onChange={event => setCustom(event.target.value)} />
      </label>}
      <div className="rounded-xl bg-brand-soft p-3">
        <label className="flex cursor-pointer items-start gap-3">
          <input type="checkbox" role="switch" className="mt-1" checked={away} onChange={event => setAway(event.target.checked)} />
          <span><span className="text-sm font-semibold">🌴 Out of office</span>
            <span className="block text-sm text-white/60">Shows a note in your direct messages so people know when you are back.</span></span>
        </label>
        {away && <label className="mt-3 block text-sm font-medium">Out of office until
          <input type="date" className="auth-input" required value={awayDate} min={dayValue(new Date())} onChange={event => setAwayDate(event.target.value)} />
        </label>}
      </div>
      {error && <p role="alert" className="text-sm text-rose-500">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" disabled={busy} onClick={() => void save({ status_emoji: null, status_text: null, status_expires_at: null, out_of_office_until: null })}
          className="text-sm font-medium text-brand hover:underline disabled:opacity-40">Clear status</button>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button disabled={busy} className="auth-button">{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </form>
  </div>;
}
