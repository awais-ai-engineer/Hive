'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { requestError } from '../../lib/spaces';
import { Icon } from '../ui/icons';

const EMOJI = ['📌', '🚀', '💼', '🎯', '📚', '🎨', '🛠️', '💬', '⭐', '🏠'];

/** Name (and optional emoji) for a new or renamed sidebar section. */
export function SectionDialog({ initial, canSpanSpaces, onSave, onClose }: {
  initial?: { name: string; emoji: string | null };
  /** Offer "show in every space" (new sections only). */
  canSpanSpaces?: boolean;
  onSave: (name: string, emoji: string | null, everywhere: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [emoji, setEmoji] = useState(initial?.emoji ?? '');
  const [everywhere, setEverywhere] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try { await onSave(name.trim(), emoji.trim() || null, everywhere); }
    catch (cause) { setError(requestError(cause)); setBusy(false); }
  }

  return <div className="on-surface fixed inset-0 z-50 flex items-center justify-center p-4">
    <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-[rgb(0_0_0/0.5)]" />
    <form role="dialog" aria-modal="true" aria-label={initial ? 'Rename section' : 'New section'} onSubmit={submit} className="card relative w-full max-w-md space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">{initial ? 'Rename section' : 'New section'}</h2>
        <button type="button" onClick={onClose} aria-label="Close dialog" className="rounded p-1 text-white/60 hover:bg-white/10"><Icon name="x" size={18} /></button>
      </div>
      <p className="text-sm text-white/60">Sections are groups of channels in your sidebar. Only you can see them.</p>
      <div className="flex gap-2">
        <label className="block w-20 text-sm font-medium">Emoji
          <input className="auth-input text-center" maxLength={16} value={emoji} placeholder="🙂" onChange={event => setEmoji(event.target.value)} />
        </label>
        <label className="block flex-1 text-sm font-medium">Name
          <input className="auth-input" autoFocus required maxLength={40} value={name} placeholder="Projects" onChange={event => setName(event.target.value)} />
        </label>
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Suggested emoji">
        {EMOJI.map(item => <button key={item} type="button" aria-pressed={emoji === item} onClick={() => setEmoji(emoji === item ? '' : item)}
          className={`h-9 w-9 rounded-lg text-lg hover:bg-[var(--surface-2)] ${emoji === item ? 'bg-brand-soft ring-2 ring-brand' : ''}`}>{item}</button>)}
      </div>
      {canSpanSpaces && <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-brand-soft p-3">
        <input type="checkbox" role="switch" className="mt-1" checked={everywhere} onChange={event => setEverywhere(event.target.checked)} />
        <span><span className="text-sm font-semibold">Show in every space</span>
          <span className="block text-sm text-white/60">Needed if you want to put direct messages in this section. Otherwise it only appears in this space.</span></span>
      </label>}
      {error && <p role="alert" className="text-sm text-rose-500">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
        <button disabled={busy || !name.trim()} className="auth-button">{busy ? 'Saving…' : initial ? 'Save' : 'Create section'}</button>
      </div>
    </form>
  </div>;
}
