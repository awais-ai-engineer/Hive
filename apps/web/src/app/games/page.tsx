'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '../../components/ui/icons';
import { useAuth } from '../../lib/auth';
import { statusText, type HubItem } from '../../lib/games';
import { apiData, requestError } from '../../lib/spaces';

export default function GamesHub() {
  const { user, loading } = useAuth();
  const [items, setItems] = useState<HubItem[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (loading || !user) return;
    apiData<HubItem[]>('/api/games/hub').then(setItems).catch(cause => setError(requestError(cause)));
  }, [loading, user]);
  if (!loading && !user) return <main className="mx-auto max-w-md px-4 py-16 text-center">
    <p className="text-white/60"><Link className="text-brand" href="/login?next=/games">Log in</Link> to play games with your communities.</p></main>;
  return <main className="mx-auto max-w-4xl px-4 py-6 sm:py-8">
    <div className="mb-5 flex items-center justify-between gap-3"><h1 className="flex items-center gap-2 text-3xl font-extrabold tracking-tight"><Icon name="gaming" size={28} className="text-brand" />Games</h1>
      <Link href="/home" className="btn-ghost">Back to home</Link></div>
    {error && <p role="alert" className="text-rose-500">{error}</p>}
    {!items && !error && <div aria-busy="true" className="grid gap-4 sm:grid-cols-2">{[0, 1].map(i => <div key={i} className="h-32 animate-pulse rounded-2xl bg-white/5" />)}</div>}
    {items && !items.length && <div className="card p-8 text-center"><Icon name="users" size={30} className="mx-auto text-brand" />
      <p className="mt-2 font-medium">Games live inside communities</p><p className="text-sm text-white/60">Join a community to play the Daily Word, trivia and predictions with its members.</p>
      <Link href="/spaces" className="auth-button mt-4 inline-block !w-auto px-5">Find a community</Link></div>}
    {items && <ul className="grid gap-4 sm:grid-cols-2">{items.map(item => <li key={item.slug} className="card p-5">
      <h2 className="text-lg font-bold">{item.name}</h2>
      <p className="mt-1 text-sm text-white/65">Daily Word: {statusText(item.wordStatus)}{item.wordStatus === 'playing' && item.wordGuesses ? ` (${item.wordGuesses} of 6 guesses used)` : ''}</p>
      <div className="mt-3 flex flex-wrap gap-2"><Link href={`/s/${item.slug}/games`} className="auth-button !w-auto px-4">{item.wordStatus === 'playing' ? 'Play now' : 'Open games'}</Link></div>
    </li>)}</ul>}
  </main>;
}
