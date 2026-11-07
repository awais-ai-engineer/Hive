'use client';

import Link from 'next/link';
import type { AiItem, AiSummary } from '@hive/shared';
import { Icon } from '../ui/icons';

function Group({ title, items }: { title?: string; items: AiItem[] }) {
  if (!items.length) return null;
  return <section className="mb-3">
    {title && <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-white/50">{title}</h4>}
    <ul className="space-y-1.5">{items.map((item, index) => <li key={index} className="flex gap-2 text-sm leading-relaxed">
      <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
      <span className="min-w-0 flex-1">
        <span className="[overflow-wrap:anywhere]">{item.text}</span>
        {item.sources.map(source => <Link key={source.n} href={source.url} title={`Open the message from ${source.author}`}
          aria-label={`Open the message from ${source.author}`}
          className="ml-1 inline-flex items-center gap-0.5 rounded-md bg-brand-soft px-1.5 py-0.5 align-middle text-xs font-medium text-brand hover:underline">
          <Icon name="message" size={11} />{source.author}</Link>)}
      </span>
    </li>)}</ul>
  </section>;
}

/** A summary as bullet points; each point links back to the messages it came from. */
export function SummaryPanel({ summary, hideActions = false }: { summary: AiSummary; hideActions?: boolean }) {
  if (summary.empty) return <p className="text-sm text-white/60">There is nothing to summarise yet.</p>;
  const nothing = !summary.points.length && !summary.decisions.length && !summary.questions.length && !summary.actions.length;
  return <div>
    <p className="mb-2 text-xs text-white/45">Based on {summary.messageCount} {summary.messageCount === 1 ? 'message' : 'messages'}
      {summary.scope === 'last_24h' ? ' from the last 24 hours' : ''}</p>
    <Group items={summary.points} />
    <Group title="Decisions" items={summary.decisions} />
    <Group title="Open questions" items={summary.questions} />
    {!hideActions && <Group title="Action items" items={summary.actions} />}
    {nothing && <p className="text-sm text-white/60">The summary came back empty. Please try again.</p>}
  </div>;
}

export function Skeleton() {
  return <div aria-busy="true" aria-label="Writing the summary" className="space-y-2">
    {[90, 75, 82].map(width => <div key={width} className="h-3 animate-pulse rounded bg-white/10" style={{ width: `${width}%` }} />)}
  </div>;
}
