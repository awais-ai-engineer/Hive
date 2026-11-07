'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { SearchPanel } from '../../components/search/search-panel';
import { useAuth } from '../../lib/auth';

function Results() {
  const { user, loading } = useAuth();
  const q = useSearchParams().get('q') ?? '';
  if (loading) return null;
  if (!user) return <p className="p-16 text-center"><Link className="font-semibold text-brand hover:underline" href="/login?next=/search">Log in to search</Link></p>;
  return <SearchPanel variant="page" initialQuery={q} />;
}

export default function SearchPage() {
  return <main className="mx-auto max-w-4xl px-4 py-8 pb-24">
    <h1 className="mb-4 text-3xl font-extrabold tracking-tight">Search</h1>
    <Suspense><Results /></Suspense>
  </main>;
}
