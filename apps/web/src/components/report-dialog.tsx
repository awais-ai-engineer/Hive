'use client';

import { Button as UiButton, Textarea as UiTextarea } from '@hive/ui';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiData, requestError } from '../lib/spaces';

export type ReportTarget = { type: 'user' | 'message' | 'post' | 'comment'; id: string; label?: string };

/** Small modal that sends a report to the moderators. Shared by profiles, messages and posts. */
export function ReportDialog({ target, onClose }: { target: ReportTarget | null; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (target) { setReason(''); setError(''); setSent(false); setTimeout(() => field.current?.focus(), 0); } }, [target]);
  useEffect(() => {
    if (!target) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target, onClose]);
  if (!target) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      await apiData('/api/reports', { method: 'POST', body: JSON.stringify({ target_type: target!.type, target_id: target!.id, reason: reason.trim() }) });
      setSent(true);
    } catch (cause) { setError(requestError(cause)); }
    finally { setBusy(false); }
  }

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div role="dialog" aria-modal="true" aria-labelledby="report-title" className="on-surface card animate-in w-full max-w-md p-6 shadow-[var(--shadow-pop)]">
      <h2 id="report-title" className="text-lg font-bold">Report {target.label ?? target.type}</h2>
      {sent ? <>
        <p role="status" className="mt-3 text-white/80">Thanks, our moderators will review it.</p>
        <UiButton type="button" onClick={onClose} className="auth-button mt-5">Close</UiButton>
      </> : <form onSubmit={submit} className="mt-3">
        <label className="block text-sm font-medium">What is wrong?
          <UiTextarea ref={field} required maxLength={1000} rows={4} value={reason} onChange={event => setReason(event.target.value)}
            className="auth-input resize-none" placeholder="Tell us what happened so we can look into it." />
        </label>
        {error && <p role="alert" className="mt-2 text-sm text-rose-500">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <UiButton type="button" onClick={onClose} className="btn-ghost">Cancel</UiButton>
          <UiButton disabled={busy || !reason.trim()} className="auth-button">{busy ? 'Sending…' : 'Send report'}</UiButton>
        </div>
      </form>}
    </div>
  </div>;
}
