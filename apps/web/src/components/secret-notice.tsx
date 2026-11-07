'use client';

import { useState } from 'react';
import { Icon } from './ui/icons';

/** What a secret conversation is, how to check it is really private, and its limits. */
export function SecretNotice({ name, safety, ready, peerReady, error }: { name: string; safety: string; ready: boolean; peerReady: boolean; error: string }) {
  const [open, setOpen] = useState(false);
  return <div className="mb-2 rounded-xl bg-brand-soft px-3 py-2 text-sm">
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Icon name="lock" size={15} className="shrink-0 text-brand" />
      <span>Messages are end-to-end encrypted. Only you and <strong>{name}</strong> can read them.</span>
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="font-semibold text-brand underline">{open ? 'Hide details' : 'Verify and learn more'}</button>
    </p>
    {error ? <p role="alert" className="mt-1 text-rose-500">{error}</p>
      : !ready ? <p role="status" className="mt-1 text-white/60">Setting up secure keys on this device…</p>
        : !peerReady && <p role="status" className="mt-1">{name} has not turned on secret conversations yet. They need to open Hive once, then you can message them here.</p>}
    {open && <div className="mt-2 space-y-2 border-t border-white/10 pt-2 text-white/80">
      <div><p className="font-medium">Safety number</p>
        <p className="mt-1 font-mono text-base tracking-wider" aria-label="Safety number">{safety || '…'}</p>
        <p className="mt-1 text-xs">Read this number out to {name} (in person or on a call). If you both see the same number, nobody is listening in. It changes if either of you adds a new device.</p></div>
      <ul className="list-disc space-y-1 pl-5 text-xs">
        <li>Messages can only be read on the devices that were set up when they were sent. On a new device, older messages show as unreadable.</li>
        <li>Secret conversations are text only: no files, voice, polls, threads or editing. They are never searched, summarized or previewed.</li>
        <li>Notifications only say &ldquo;New secret message&rdquo;.</li>
      </ul>
    </div>}
  </div>;
}
