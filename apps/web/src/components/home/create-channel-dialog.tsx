'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { channelCreateSchema } from '@hive/shared';
import { apiData, requestError, type Channel, type Space } from '../../lib/spaces';
import { Icon } from '../ui/icons';

const toName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-/, '').slice(0, 80);

/** Modal for admins to add a text channel, optionally private (visible only to people they add). */
export function CreateChannelDialog({ space, onCreated, onClose }: {
  space: Space; onCreated: (channel: Channel) => void; onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    const parsed = channelCreateSchema.safeParse({ name: name.replace(/-$/, ''), type: 'text', topic: topic.trim() || undefined });
    if (!parsed.success) { setError(parsed.error.issues[0].message); return; }
    setBusy(true);
    try {
      const channel = await apiData<Channel>(`/api/spaces/${encodeURIComponent(space.slug)}/channels`,
        { method: 'POST', body: JSON.stringify({ ...parsed.data, is_private: isPrivate }) });
      onCreated(channel);
    } catch (cause) { setError(requestError(cause)); setBusy(false); }
  }

  return <div className="on-surface fixed inset-0 z-50 flex items-center justify-center p-4">
    <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-[rgb(0_0_0/0.5)]" />
    <form role="dialog" aria-modal="true" aria-label="Create channel" onSubmit={submit} className="card relative w-full max-w-md space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Create a channel</h2>
        <button type="button" onClick={onClose} aria-label="Close dialog" className="rounded p-1 text-white/60 hover:bg-white/10"><Icon name="x" size={18} /></button>
      </div>
      <label className="block text-sm font-medium">Name
        <input className="auth-input" autoFocus required maxLength={80} value={name} placeholder="project-updates"
          onChange={event => setName(toName(event.target.value))} />
        <span className="font-normal text-white/55">Lowercase letters, numbers and dashes.</span></label>
      <label className="block text-sm font-medium">Topic
        <input className="auth-input" maxLength={250} value={topic} onChange={event => setTopic(event.target.value)} />
        <span className="font-normal text-white/55">Optional. What is this channel about?</span></label>
      <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-brand-soft p-3">
        <input type="checkbox" role="switch" className="mt-1" checked={isPrivate} onChange={event => setIsPrivate(event.target.checked)} />
        <span><span className="flex items-center gap-1.5 text-sm font-semibold"><Icon name="lock" size={14} />Make private</span>
          <span className="text-sm text-white/60">Only people you add can see this channel.</span></span>
      </label>
      {error && <p role="alert" className="text-sm text-rose-500">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
        <button disabled={busy || !name} className="auth-button">{busy ? 'Creating…' : 'Create channel'}</button>
      </div>
    </form>
  </div>;
}
