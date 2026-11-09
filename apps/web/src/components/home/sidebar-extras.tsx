'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiData } from '../../lib/spaces';
import { Icon } from '../ui/icons';

export type LiveHuddle = { id: string; title: string; place: string; count: number };

/** "Huddles" in the sidebar: every call happening right now in places you can open. */
export function HuddlesSection({ huddles, onJoin }: { huddles: LiveHuddle[]; onJoin: (huddle: LiveHuddle) => void }) {
  if (!huddles.length) return null;
  return <div className="mt-5">
    <p className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-white/50">Huddles</p>
    <ul className="space-y-0.5">{huddles.map(huddle => <li key={huddle.id}>
      <button type="button" onClick={() => onJoin(huddle)} title={`Join the huddle in ${huddle.place}`}
        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left hover:bg-white/[0.06]">
        <Icon name="headphones" size={16} className="shrink-0 opacity-75" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold">{huddle.title}</span>
          <span className="block truncate text-[12px] text-white/55">{huddle.place} · {huddle.count} {huddle.count === 1 ? 'person' : 'people'}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-[12px] font-semibold text-emerald-600 dark:text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />Live</span>
      </button>
    </li>)}</ul>
  </div>;
}

type Quiet = { quietStart: number | null; quietEnd: number | null };
const clock = (minutes: number) => new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60)
  .toLocaleTimeString([], { hour: 'numeric', minute: minutes % 60 ? '2-digit' : undefined });

/** Small card at the bottom of the sidebar showing (or offering) quiet hours. */
export function QuietHoursCard() {
  const [quiet, setQuiet] = useState<Quiet | null>(null);
  useEffect(() => { apiData<Quiet>('/api/push/settings').then(setQuiet).catch(() => setQuiet(null)); }, []);
  if (!quiet) return null;
  const on = quiet.quietStart != null && quiet.quietEnd != null;
  return <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
    <Icon name="bellOff" size={16} className="mt-0.5 shrink-0 opacity-60" />
    <div className="min-w-0 flex-1">
      <p className="text-[13px] font-semibold">{on ? `Quiet hours at ${clock(quiet.quietStart!)}` : 'Quiet hours are off'}</p>
      <p className="text-[12px] text-white/55">{on ? `Alerts pause until ${clock(quiet.quietEnd!)}` : 'Pause alerts at night'}</p>
    </div>
    <Link href="/settings" className="shrink-0 rounded-lg border border-[var(--border)] px-2 py-1 text-[12px] font-medium hover:bg-[var(--surface-2)]">{on ? 'Edit' : 'Set'}</Link>
  </div>;
}
