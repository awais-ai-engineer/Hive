'use client';

import { Suspense } from 'react';
import { useAuth } from '../../lib/auth';
import { PostFeed } from '../../components/posts/post-feed';

export default function FeedPage() {
  const { user, loading } = useAuth();
  return <main className="mx-auto max-w-4xl px-4 py-8">
    <h1 className="mb-6 text-2xl font-bold">{user ? 'Your feed' : 'Popular communities'}</h1>
    {!loading && <Suspense fallback={<p>Loading posts…</p>}><PostFeed /></Suspense>}
  </main>;
}
