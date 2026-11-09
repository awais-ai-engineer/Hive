'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Leaderboard } from '../../../../components/games/leaderboard';
import { Predictions } from '../../../../components/games/predictions';
import { Trivia } from '../../../../components/games/trivia';
import { WordGame } from '../../../../components/games/word-game';
import { Icon } from '../../../../components/ui/icons';
import { useAuth } from '../../../../lib/auth';
import { gamesPath, type GamesSummary } from '../../../../lib/games';
import { apiData, requestError } from '../../../../lib/spaces';

const TABS = [['word', 'Daily Word'], ['trivia', 'Trivia'], ['predictions', 'Predictions']] as const;

export default function CommunityGames() {
  const { slug } = useParams<{ slug: string }>();
  const { user, loading } = useAuth();
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('word');
  const [summary, setSummary] = useState<GamesSummary | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion(value => value + 1), []);

  useEffect(() => {
    if (loading || !user) return;
    apiData<GamesSummary>(gamesPath(slug, '/summary')).then(setSummary).catch(cause => setError(requestError(cause)));
  }, [slug, loading, user, version]);

  if (!loading && !user) return <main className="mx-auto max-w-md px-4 py-16 text-center">
    <p className="text-white/60"><Link className="text-brand" href={`/login?next=/s/${slug}/games`}>Log in</Link> to play.</p></main>;
  if (error) return <main className="mx-auto max-w-md px-4 py-16 text-center"><p role="alert" className="text-white/70">{error}</p>
    <Link className="mt-3 inline-block text-brand" href="/games">Back to games</Link></main>;
  return <main className="mx-auto max-w-5xl px-4 py-6 sm:py-8">
    <nav aria-label="Breadcrumb" className="mb-3 text-sm"><Link href="/games" className="text-brand hover:underline">Games</Link><span className="text-white/40"> / </span><Link href={`/s/${slug}`} className="text-white/70 hover:underline">{slug}</Link></nav>
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><h1 className="flex items-center gap-2 text-3xl font-extrabold tracking-tight"><Icon name="gaming" size={28} className="text-brand" />Games</h1>
      {summary && <p className="flex flex-wrap gap-2 text-sm">
        {summary.badges.topPlayer && <span className="rounded-full bg-brand-soft px-3 py-1 font-semibold text-brand">Top player</span>}
        {summary.badges.wordStreak > 1 && <span className="rounded-full bg-brand-soft px-3 py-1 font-semibold text-brand">{summary.badges.wordStreak}-day Daily Word streak</span>}</p>}</div>
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="min-w-0">
        <div role="tablist" aria-label="Games" className="mb-4 flex gap-1 overflow-x-auto">{TABS.map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}
          className={`whitespace-nowrap rounded-xl px-4 py-2 text-sm font-medium ${tab === value ? 'bg-brand-soft text-brand' : 'text-white/65 hover:bg-[var(--surface-2)]'}`}>{label}
          {value === 'trivia' && !!summary?.newQuizzes && <span className="ml-1.5 rounded-full bg-brand px-1.5 text-xs" style={{ color: 'var(--on-brand)' }}>{summary.newQuizzes}</span>}
          {value === 'predictions' && !!summary?.openPredictions && <span className="ml-1.5 rounded-full bg-brand px-1.5 text-xs" style={{ color: 'var(--on-brand)' }}>{summary.openPredictions}</span>}</button>)}</div>
        {tab === 'word' && <WordGame slug={slug} onFinished={refresh} />}
        {tab === 'trivia' && <Trivia slug={slug} canManage={!!summary?.canManage} onScored={refresh} />}
        {tab === 'predictions' && <Predictions slug={slug} canManage={!!summary?.canManage} onScored={refresh} />}
      </div>
      <Leaderboard slug={slug} refresh={version} />
    </div>
  </main>;
}
