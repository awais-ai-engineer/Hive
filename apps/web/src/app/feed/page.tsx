'use client';

import { Button as UiButton } from '@hive/ui';

import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { PostFeed } from '../../components/posts/post-feed';
import { colourFor } from '../../components/ui/avatar';
import { Icon } from '../../components/ui/icons';
import { useAuth } from '../../lib/auth';
import { apiData, type Space } from '../../lib/spaces';

function SpaceRow({ space, meta }: { space: Space; meta: string }) {
  return <li>
    <Link href={`/s/${space.slug}`} className="flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-[var(--surface-2)]">
      <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl font-bold" style={{ background: colourFor(space.slug), color: '#fff' }}>{space.name[0]?.toUpperCase()}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{space.name}</span>
        <span className="block truncate text-xs text-white/50">{meta}</span>
      </span>
    </Link>
  </li>;
}

export default function FeedPage() {
  const { user, loading } = useAuth();
  const [mine, setMine] = useState<Space[]>([]);
  const [trending, setTrending] = useState<Space[]>([]);
  const [hideHero, setHideHero] = useState(false);

  useEffect(() => {
    try { setHideHero(localStorage.getItem('hive:hide-feed-hero') === '1'); } catch { /* storage unavailable */ }
  }, []);
  useEffect(() => {
    if (loading) return;
    if (user) apiData<Space[]>('/api/me/spaces').then(setMine).catch(() => {});
    apiData<Space[] | { items: Space[] }>('/api/spaces')
      .then(value => setTrending((Array.isArray(value) ? value : value.items)
        .filter(space => space.type === 'community').sort((a, b) => b.member_count - a.member_count).slice(0, 5)))
      .catch(() => {});
  }, [loading, user]);

  const postTarget = mine.find(space => space.my_role && space.my_role !== 'guest');
  return <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 lg:grid-cols-[minmax(0,1fr)_300px]">
    <div className="min-w-0 space-y-5">
      {!hideHero && <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#5b3be8] via-[#7c5cff] to-[#a78bfa] p-6 sm:p-8" style={{ color: '#fff' }}>
        <div aria-hidden className="absolute -right-10 -top-10 h-56 w-56 rounded-full bg-[rgb(255_255_255/0.16)] blur-2xl" />
        <div aria-hidden className="absolute -bottom-16 right-24 h-40 w-40 rounded-full bg-fuchsia-300/30 blur-2xl" />
        <UiButton tooltip="Dismiss" type="button" onClick={() => { setHideHero(true); try { localStorage.setItem('hive:hide-feed-hero', '1'); } catch { /* ignore */ } }}
          aria-label="Dismiss" className="absolute right-4 top-4 rounded-full p-1.5 hover:bg-[rgb(255_255_255/0.16)]" style={{ color: '#fff' }}><Icon name="x" size={18} /></UiButton>
        <h1 className="relative text-2xl font-extrabold sm:text-3xl">{user ? 'Your feed' : 'Posts & Discussions'}</h1>
        <p className="relative mt-1 max-w-lg text-sm opacity-90 sm:text-base">
          {user ? 'The best posts from every space you belong to, in one place.' : 'Share ideas, ask questions and discuss them with the community.'}</p>
        <div className="relative mt-5 flex flex-wrap gap-2">
          {postTarget && <Link href={`/s/${postTarget.slug}/submit`} className="inline-flex items-center gap-2 rounded-xl bg-[#fff] px-4 py-2 text-sm font-semibold shadow-sm" style={{ color: '#5b3be8' }}><Icon name="edit" size={16} />Create post</Link>}
          <Link href="/spaces" className="inline-flex items-center gap-2 rounded-xl bg-[rgb(255_255_255/0.16)] px-4 py-2 text-sm font-semibold backdrop-blur hover:bg-[rgb(255_255_255/0.26)]" style={{ color: '#fff' }}><Icon name="compass" size={16} />Explore communities</Link>
        </div>
      </section>}
      {!loading && <Suspense fallback={<p className="text-white/50">Loading posts…</p>}><PostFeed /></Suspense>}
    </div>
    <aside className="hidden space-y-5 lg:block">
      {user && <section className="card p-4">
        <h2 className="mb-2 flex items-center gap-2 font-bold"><Icon name="layers" size={18} className="text-brand" />Your spaces</h2>
        {mine.length ? <ul>{mine.slice(0, 6).map(space => <SpaceRow key={space.id} space={space} meta={`${space.member_count} ${space.member_count === 1 ? "member" : "members"} · ${space.my_role}`} />)}</ul>
          : <p className="text-sm text-white/55">You haven&apos;t joined a space yet.</p>}
      </section>}
      <section className="card p-4">
        <h2 className="mb-2 flex items-center gap-2 font-bold"><span aria-hidden>🔥</span>Trending communities</h2>
        {trending.length ? <ul>{trending.map(space => <SpaceRow key={space.id} space={space} meta={`${space.member_count} ${space.member_count === 1 ? "member" : "members"}`} />)}</ul>
          : <p className="text-sm text-white/55">No communities yet.</p>}
        <Link href="/spaces" className="mt-2 block text-sm font-semibold text-brand hover:underline">View all</Link>
      </section>
    </aside>
  </main>;
}
