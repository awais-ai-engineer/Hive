'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Leaderboard } from '@hive/shared';
import { gamesPath, type GamesSummary } from '../../lib/games';
import { apiData } from '../../lib/spaces';
import { Avatar } from '../ui/avatar';
import { Icon } from '../ui/icons';

const WORD_TEXT = { playing: 'Guess today’s 5-letter word in six tries.', won: 'Solved today. Come back tomorrow for a new word.', lost: 'Out of tries today. A new word arrives tomorrow.' };

/** Right column of a community: today's games and this week's leaderboard (members only). */
export function CommunityGames({ slug }: { slug: string }) {
  const [summary, setSummary] = useState<GamesSummary | null>(null);
  const [board, setBoard] = useState<Leaderboard | null>(null);
  useEffect(() => {
    apiData<GamesSummary>(gamesPath(slug, '/summary')).then(setSummary).catch(() => {});
    apiData<Leaderboard>(gamesPath(slug, '/leaderboard?period=weekly')).then(setBoard).catch(() => {});
  }, [slug]);
  if (!summary) return null;
  const href = `/s/${slug}/games`;
  return <div className="space-y-4">
    <section className="card p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-bold">Daily Word</h2>
        {summary.badges.wordStreak > 1 && <span className="text-xs font-semibold text-[var(--brand-soft-fg)]">{summary.badges.wordStreak}-day streak</span>}
      </div>
      <p className="mt-1 text-sm text-white/60">{WORD_TEXT[summary.word.status]}</p>
      <div className="mt-3 grid grid-cols-5 gap-1.5" aria-hidden>
        {Array.from({ length: 5 }, (_, index) => <span key={index} className={`aspect-square rounded-md border ${summary.word.status === 'won' ? 'border-emerald-600 bg-emerald-600' : 'border-[var(--border)] bg-[var(--surface-2)]'}`} />)}
      </div>
      <Link href={href} className="mt-3 flex w-full items-center justify-center rounded-xl bg-[var(--rail)] py-2 text-sm font-semibold dark:bg-[var(--call-foreground)]" style={{ color: 'var(--canvas)' }}>
        {summary.word.status === 'playing' ? (summary.word.guesses ? 'Continue playing' : 'Play now') : 'See results'}</Link>
    </section>
    {(summary.newQuizzes > 0 || summary.openPredictions > 0) && <section className="card p-4">
      <h2 className="font-bold">More games</h2>
      <ul className="mt-2 space-y-1 text-sm">
        {summary.newQuizzes > 0 && <li><Link href={`${href}?tab=trivia`} className="flex items-center gap-2 hover:underline"><Icon name="sparkles" size={14} />{summary.newQuizzes} new trivia {summary.newQuizzes === 1 ? 'quiz' : 'quizzes'}</Link></li>}
        {summary.openPredictions > 0 && <li><Link href={`${href}?tab=predictions`} className="flex items-center gap-2 hover:underline"><Icon name="trending" size={14} />{summary.openPredictions} open {summary.openPredictions === 1 ? 'prediction' : 'predictions'}</Link></li>}
      </ul>
    </section>}
    <section className="card p-4">
      <div className="mb-2 flex items-center justify-between"><h2 className="font-bold">This week</h2><Link href={href} className="text-xs font-medium text-[var(--brand-soft-fg)] hover:underline">Full leaderboard</Link></div>
      {!board?.entries.length ? <p className="text-sm text-white/55">Nobody has scored yet this week. Play a game to get on the board.</p>
        : <ol className="space-y-1.5">{board.entries.slice(0, 5).map(entry => <li key={entry.user.id} className="flex items-center gap-2 text-sm">
          <span className="w-4 text-right font-bold text-white/50">{entry.rank}</span>
          <Avatar name={entry.user.username} src={entry.user.avatarUrl} size={22} />
          <span className="min-w-0 flex-1 truncate">{entry.user.displayName || entry.user.username}</span>
          <span className="font-semibold">{entry.points}</span>
        </li>)}</ol>}
      <p className="mt-3 text-xs text-white/45">Games and points are only for this community. They never appear in work spaces.</p>
    </section>
  </div>;
}
