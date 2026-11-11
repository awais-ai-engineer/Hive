'use client';

import { Button as UiButton } from '@hive/ui';

import { useState } from 'react';
import type { AiSummary } from '@hive/shared';
import { summarize, useAiStatus } from '../../lib/ai';
import { requestError } from '../../lib/spaces';
import { Icon } from '../ui/icons';
import { Skeleton, SummaryPanel } from './summary-panel';

type Props = { channelId?: string; threadId?: string; label?: string; className?: string };

/** "Catch me up" for the Unreads view (no channel) or one channel; also summarises a thread. */
export function CatchUp({ channelId, threadId, label, className = '' }: Props) {
  const enabled = useAiStatus();
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [summary, setSummary] = useState<AiSummary | null>(null);
  const [error, setError] = useState('');
  if (!enabled) return null;
  const title = label ?? (threadId ? 'Summarise thread' : 'Catch me up');
  async function run() {
    setState('busy'); setError('');
    try {
      setSummary(await summarize(channelId
        ? { channelId, ...(threadId ? { parentId: threadId } : { sinceUnread: true }) } : { allUnreads: true }));
      setState('done');
    } catch (cause) { setError(requestError(cause)); setState('idle'); }
  }
  return <div className={className}>
    <UiButton type="button" onClick={() => state === 'done' ? setState('idle') : void run()} disabled={state === 'busy'}
      aria-expanded={state === 'done'} tooltip="Short bullet points of what you missed, with links to the messages"
      className="btn-ghost flex items-center gap-1.5 text-sm"><Icon name="sparkles" size={15} className="text-brand" />{state === 'busy' ? 'Working…' : title}</UiButton>
    {error && <p role="alert" className="mt-2 text-sm text-rose-500">{error}</p>}
    {(state === 'busy' || state === 'done') && <section aria-live="polite" aria-label={title} className="card mt-2 p-4">
      <div className="mb-2 flex items-center justify-between"><h3 className="flex items-center gap-1.5 font-semibold"><Icon name="sparkles" size={15} className="text-brand" />{title}</h3>
        {state === 'done' && <UiButton type="button" onClick={() => setState('idle')} tooltip="Close summary" aria-label="Close summary" className="text-white/60 hover:text-white"><Icon name="x" size={16} /></UiButton>}</div>
      {state === 'busy' ? <Skeleton /> : summary && <SummaryPanel summary={summary} />}
      <p className="mt-2 text-xs text-white/40">Written by AI from messages you can read. It can make mistakes.</p>
    </section>}
  </div>;
}
