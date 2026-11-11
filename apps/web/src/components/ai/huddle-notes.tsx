'use client';

import { Button as UiButton, Checkbox as UiCheckbox } from '@hive/ui';

import { useState } from 'react';
import type { AiSummary } from '@hive/shared';
import { aiPost, useAiStatus } from '../../lib/ai';
import { apiData, requestError } from '../../lib/spaces';
import { Skeleton, SummaryPanel } from './summary-panel';

/** Under a huddle summary line: summarise the chat sent during the huddle and turn action items into to-dos. */
export function HuddleNotes({ messageId, channelId, userId }: { messageId: string; channelId: string; userId?: string }) {
  const enabled = useAiStatus();
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [summary, setSummary] = useState<AiSummary | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  if (!enabled) return null;

  async function run() {
    setState('busy'); setError(''); setNotice('');
    try {
      const result = await aiPost<AiSummary>('/huddle-notes', { messageId });
      setSummary(result); setPicked(new Set(result.actions.map((_, index) => index))); setState('done');
    } catch (cause) { setError(requestError(cause)); setState('idle'); }
  }
  async function addTodos() {
    if (!summary || !userId) return;
    const chosen = summary.actions.filter((_, index) => picked.has(index));
    try {
      for (const item of chosen) {
        await apiData('/api/tasks', { method: 'POST', body: JSON.stringify({
          title: item.text.slice(0, 200), channel_id: channelId, assignee_id: userId,
          source_message_id: item.sources[0]?.messageId ?? null }) });
      }
      setNotice(`Added ${chosen.length} ${chosen.length === 1 ? 'to-do' : 'to-dos'} to your list.`);
      setPicked(new Set());
    } catch (cause) { setError(requestError(cause)); }
  }
  const toggle = (index: number) => setPicked(current => { const next = new Set(current); if (!next.delete(index)) next.add(index); return next; });
  return <div className="mx-auto my-2 max-w-xl text-left justify-start">
    <div className="text-center"><UiButton type="button" onClick={() => void run()} disabled={state === 'busy'} className="rounded-lg px-2 py-1 text-xs font-medium text-brand hover:bg-brand-soft">
      {state === 'busy' ? 'Reading the chat…' : state === 'done' ? 'Summarise again' : 'Summarise the chat during this huddle'}</UiButton></div>
    {error && <p role="alert" className="mt-1 text-center text-xs text-rose-500">{error}</p>}
    {state !== 'idle' && <section aria-live="polite" className="card mt-2 p-4 text-sm">
      {state === 'busy' ? <Skeleton /> : summary && <>
        <SummaryPanel summary={summary} hideActions />
        {summary.actions.length > 0 && <fieldset className="mt-2 border-t border-white/10 pt-3">
          <legend className="mb-1 text-xs font-semibold text-white/60">Action items: pick the ones to keep</legend>
          {summary.actions.map((item, index) => <label key={index} className="flex items-start gap-2 py-0.5">
            <UiCheckbox checked={picked.has(index)} onChange={() => toggle(index)} className="mt-1" /><span>{item.text}</span></label>)}
          <UiButton type="button" onClick={() => void addTodos()} disabled={!picked.size || !userId} className="auth-button mt-2 !w-auto px-4 py-1.5 text-sm">Add action items to to-dos</UiButton>
          {notice && <p role="status" className="mt-1 text-xs text-emerald-600">{notice}</p>}
        </fieldset>}
      </>}
    </section>}
  </div>;
}
