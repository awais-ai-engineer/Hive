'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { apiData, requestError, type Space } from '../../lib/spaces';

type Page = { items: Space[]; next_cursor: string | null };

export default function SpacesPage() {
  const { user, loading } = useAuth();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [items, setItems] = useState<Space[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let active = true;
    setBusy(true);
    setError('');
    const params = new URLSearchParams({ limit: '20' });
    if (debounced) params.set('q', debounced);
    apiData<Page>(`/api/spaces?${params}`).then(page => {
      if (active) { setItems(page.items); setCursor(page.next_cursor); }
    }).catch(error => { if (active) setError(requestError(error)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [debounced]);

  async function loadMore() {
    if (!cursor || busy) return;
    setBusy(true);
    setError('');
    const params = new URLSearchParams({ limit: '20', cursor });
    if (debounced) params.set('q', debounced);
    try {
      const page = await apiData<Page>(`/api/spaces?${params}`);
      setItems(current => [...current, ...page.items]);
      setCursor(page.next_cursor);
    } catch (cause) { setError(requestError(cause)); }
    finally { setBusy(false); }
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-12">
      <div className="flex items-center justify-between">
        <div><h1 className="text-3xl font-bold">Communities</h1>
          <p className="mt-2 text-white/60">Find a community and join the conversation.</p></div>
        {!loading && user && <Link className="auth-button" href="/spaces/new">Create space</Link>}
      </div>
      <label className="mt-8 block">Search communities
        <input className="auth-input" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by name or slug" />
      </label>
      {error && <p role="alert" className="mt-4 text-rose-400">{error}</p>}
      <ul className="mt-6 grid gap-4 sm:grid-cols-2">
        {items.map(space => <li key={space.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
          <Link href={`/s/${space.slug}`} className="text-xl font-semibold text-amber-400">{space.name}</Link>
          <p className="mt-1 text-sm text-white/50">/s/{space.slug} · {space.member_count} members</p>
          {space.description && <p className="mt-3 text-white/70">{space.description}</p>}
        </li>)}
      </ul>
      {!busy && items.length === 0 && <p className="mt-6 text-white/60">No communities found.</p>}
      {cursor && <button onClick={loadMore} disabled={busy} className="auth-button mt-6">Load more</button>}
      {busy && <p role="status" className="mt-4 text-white/50">Loading…</p>}
    </main>
  );
}
