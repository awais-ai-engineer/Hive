'use client';

import { Button as UiButton } from '@hive/ui';

import { useState } from 'react';
import type { RewriteInput } from '@hive/shared';
import { aiPost, useAiStatus } from '../../lib/ai';
import { requestError } from '../../lib/spaces';
import { Icon } from '../ui/icons';

const MODES: { mode: RewriteInput['mode']; label: string }[] = [
  { mode: 'shorter', label: 'Make it shorter' }, { mode: 'professional', label: 'More professional' },
  { mode: 'friendlier', label: 'Friendlier' }, { mode: 'fix_grammar', label: 'Fix spelling and grammar' },
];

/** Composer button: suggests a rewrite in a small panel. Nothing changes until you press "Use this". */
export function RewriteButton({ body, disabled, onUse }: { body: string; disabled: boolean; onUse: (text: string) => void }) {
  const enabled = useAiStatus();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  if (!enabled) return null;
  async function run(mode: RewriteInput['mode']) {
    setBusy(true); setError(''); setResult('');
    try { setResult((await aiPost<{ text: string }>('/rewrite', { text: body, mode })).text); }
    catch (cause) { setError(requestError(cause)); } finally { setBusy(false); }
  }
  const empty = !body.trim();
  return <span className="relative">
    <UiButton type="button" disabled={disabled || empty || body.length > 4000} onClick={() => setOpen(value => !value)} aria-expanded={open}
      tooltip={empty ? 'Write something first, then ask for a rewrite' : 'Rewrite your message with AI'} aria-label="Rewrite with AI"
      className="flex h-9 min-w-9 items-center justify-center gap-1 rounded-lg px-2 text-sm text-white/70 hover:bg-brand-soft hover:text-brand disabled:opacity-40">
      <Icon name="sparkles" size={16} /><span className="hidden sm:inline">Rewrite</span></UiButton>
    {open && <section aria-label="Rewrite" className="on-surface absolute bottom-full left-0 z-30 mb-2 w-80 max-w-[calc(100vw-2rem)] rounded-2xl border border-white/10 bg-surface p-3 text-white shadow-[var(--shadow-pop)]">
      <div className="mb-2 flex flex-wrap gap-1.5">{MODES.map(item => <UiButton key={item.mode} type="button" disabled={busy} onClick={() => void run(item.mode)} className="btn-ghost text-xs">{item.label}</UiButton>)}</div>
      {busy && <div className="h-10 animate-pulse rounded bg-white/10" aria-label="Rewriting" />}
      {error && <p role="alert" className="text-sm text-rose-500">{error}</p>}
      {result && <>
        <p className="whitespace-pre-wrap rounded-lg bg-[var(--surface-2)] p-2 text-sm [overflow-wrap:anywhere]">{result}</p>
        <div className="mt-2 flex gap-2">
          <UiButton type="button" className="auth-button !w-auto px-3 py-1 text-sm" onClick={() => { onUse(result); setOpen(false); setResult(''); }}>Use this</UiButton>
          <UiButton type="button" className="btn-ghost text-sm" onClick={() => setResult('')}>Discard</UiButton></div></>}
      {!busy && !result && !error && <p className="text-xs text-white/55">Pick what you would like. You can review the result before using it.</p>}
    </section>}
  </span>;
}
