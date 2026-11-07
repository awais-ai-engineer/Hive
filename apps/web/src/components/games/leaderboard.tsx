'use client';

import { useEffect, useState } from 'react';
import type { Leaderboard as Board, LeaderEntry } from '@hive/shared';
import { gamesPath } from '../../lib/games';
import { apiData, requestError } from '../../lib/spaces';
import { Avatar } from '../ui/avatar';
import { Icon } from '../ui/icons';

const PERIODS = [['daily', 'Today'], ['weekly', 'This week'], ['all', 'All time']] as const;

function Row({ entry, me }: { entry: LeaderEntry; me?: boolean }) {
  return <li className={`flex items-center gap-3 rounded-xl px-3 py-2 ${me ? 'bg-brand-soft' : ''}`}>
    <span className="w-6 text-right text-sm font-bold text-white/55">{entry.rank}</span>
    <Avatar name={entry.user.username} src={entry.user.avatarUrl} size={28} />
    <span className="min-w-0 flex-1 truncate font-medium">{entry.user.displayName || entry.user.username}
      {entry.topPlayer && <span title="Top 3 last week" className="ml-2 rounded-full bg-brand-soft px-2 py-0.5 text-xs font-semibold text-brand">Top player</span>}</span>
    <span className="text-sm font-semibold">{entry.points}</span>
  </li>;
}

export function Leaderboard({ slug, refresh }: { slug: string; refresh: number }) {
  const [period, setPeriod] = useState<(typeof PERIODS)[number][0]>('weekly');
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setBoard(null); setError('');
    apiData<Board>(gamesPath(slug, `/leaderboard?period=${period}`)).then(setBoard).catch(cause => setError(requestError(cause)));
  }, [slug, period, refresh]);
  const mine = board?.me && !board.entries.some(entry => entry.user.id === board.me?.user.id) ? board.me : null;
  return <section className="card p-4" aria-label="Leaderboard">
    <h2 className="mb-2 flex items-center gap-2 text-lg font-bold"><Icon name="sports" className="text-brand" />Leaderboard</h2>
    <div role="tablist" aria-label="Leaderboard period" className="mb-2 flex gap-1">{PERIODS.map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={period === value}
      onClick={() => setPeriod(value)} className={`rounded-lg px-3 py-1 text-sm font-medium ${period === value ? 'bg-brand-soft text-brand' : 'text-white/60 hover:bg-[var(--surface-2)]'}`}>{label}</button>)}</div>
    {error && <p role="alert" className="text-sm text-rose-500">{error}</p>}
    {!board && !error && <div aria-busy="true" className="space-y-2">{[0, 1, 2].map(i => <div key={i} className="h-9 animate-pulse rounded-xl bg-white/5" />)}</div>}
    {board && !board.entries.length && <p className="py-4 text-center text-sm text-white/60">Nobody has scored yet. Play a game to get on the board.</p>}
    {board && <ol>{board.entries.map(entry => <Row key={entry.user.id} entry={entry} me={entry.user.id === board.me?.user.id} />)}</ol>}
    {mine && <ol className="mt-2 border-t border-white/10 pt-2"><Row entry={mine} me /></ol>}
  </section>;
}
