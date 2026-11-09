'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { aiPost, useAiStatus } from '../../lib/ai';
import { requestError } from '../../lib/spaces';
import { Icon } from '../ui/icons';

type Answer = { answer: string; sources: { n: number; type: string; id: string; title: string; url: string; snippet: string }[] };

/** Rail button and dialog (Ctrl+J) for Ask Hive: one question, one answer with sources. */
export function AskHive({ spaceId, inline = false }: { spaceId?: string; inline?: boolean }) {
  const enabled = useAiStatus();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j') { event.preventDefault(); setOpen(value => !value); }
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  if (!enabled) return null;

  async function ask() {
    if (question.trim().length < 2 || busy) return;
    setBusy(true); setError(''); setAnswer(null);
    try { setAnswer(await aiPost<Answer>('/ask', { question: question.trim(), ...(spaceId ? { spaceId } : {}) })); }
    catch (cause) { setError(requestError(cause)); } finally { setBusy(false); }
  }
  return <>
    {inline ? <button type="button" onClick={() => setOpen(true)} title="Ask Hive (Ctrl+J)"
      className="flex shrink-0 items-center gap-1.5 rounded-xl border border-[color-mix(in_srgb,var(--brand)_45%,transparent)] bg-brand-soft px-3 py-1.5 text-sm font-semibold text-[var(--brand-soft-fg)] transition hover:bg-[color-mix(in_srgb,var(--brand)_22%,transparent)]">
      <Icon name="sparkles" size={15} />Ask Hive</button>
    : <button type="button" onClick={() => setOpen(true)} title="Ask Hive (Ctrl+J)" aria-label="Ask Hive"
      className="flex h-9 w-9 items-center justify-center rounded-xl text-white/65 transition hover:bg-white/[0.08] hover:text-white"><Icon name="sparkles" size={18} /></button>}
    {open && <div className="fixed inset-0 z-50 flex items-start justify-center bg-[rgb(0_0_0/0.5)] p-4 pt-[10vh]" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section role="dialog" aria-modal="true" aria-label="Ask Hive" className="on-surface card w-full max-w-xl p-5 text-white">
        <div className="mb-3 flex items-center justify-between"><h2 className="flex items-center gap-2 text-lg font-bold"><Icon name="sparkles" className="text-brand" />Ask Hive</h2>
          <button type="button" onClick={() => setOpen(false)} title="Close" aria-label="Close" className="text-white/60 hover:text-white"><Icon name="x" /></button></div>
        <form onSubmit={event => { event.preventDefault(); void ask(); }} className="flex gap-2">
          <input ref={input} value={question} onChange={event => setQuestion(event.target.value)} maxLength={500} aria-label="Your question"
            placeholder="Ask about something you or your team discussed" className="auth-input min-w-0 flex-1" />
          <button className="auth-button !w-auto px-4" disabled={busy || question.trim().length < 2}>Ask</button>
        </form>
        <p className="mt-2 text-xs text-white/50">Answers use only content you can access.</p>
        {busy && <div aria-busy="true" className="mt-4 space-y-2">{[95, 80, 60].map(width => <div key={width} className="h-3 animate-pulse rounded bg-white/10" style={{ width: `${width}%` }} />)}</div>}
        {error && <p role="alert" className="mt-4 text-sm text-rose-500">{error}</p>}
        {answer && <div aria-live="polite" className="mt-4">
          <p className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">{answer.answer}</p>
          {answer.sources.length > 0 && <ul className="mt-3 flex flex-wrap gap-2" aria-label="Sources">{answer.sources.map(source => <li key={source.n}>
            <Link href={source.url} onClick={() => setOpen(false)} title={source.snippet} className="inline-flex max-w-full items-center gap-1 rounded-full bg-brand-soft px-3 py-1 text-xs font-medium text-brand hover:underline">
              <span>[{source.n}]</span><span className="truncate">{source.title}</span></Link></li>)}</ul>}
        </div>}
      </section>
    </div>}
  </>;
}
