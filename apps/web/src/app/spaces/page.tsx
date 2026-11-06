'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { CategoryPicker } from '../../components/interest-picker';
import { CategoryChips } from '../../components/communities/category-chips';
import { JoinCommunity } from '../../components/communities/rules';
import { Avatar } from '../../components/ui/avatar';
import { Icon } from '../../components/ui/icons';
import { useAuth } from '../../lib/auth';
import { apiData, requestError, type Space } from '../../lib/spaces';

type Tab = 'for_you' | 'following' | 'recent' | 'trending';
type Community = Space & { memberCount: number; postCount7d: number; joined: boolean };
type Page = { items: Community[]; nextCursor: string | null; needsInterests: boolean };
const tabs: [Tab, string][] = [['for_you', 'For You'], ['following', 'Following'], ['recent', 'Recent'], ['trending', 'Trending']];

export default function SpacesPage() {
  const { user, loading } = useAuth();
  const [tab, setTab] = useState<Tab>('for_you');
  const [category, setCategory] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState<Page | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  useEffect(() => { const timer = setTimeout(() => setDebounced(query.trim()), 300); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { apiData<{ categories: { slug: string; count: number }[] }>('/api/explore/categories').then(data => setCounts(Object.fromEntries(data.categories.map(item => [item.slug, item.count])))).catch(() => {}); }, [refresh]);
  const categorySlug = category[0] ?? '';
  const params = () => new URLSearchParams({ tab, q: debounced, category: categorySlug, limit: '20' });
  useEffect(() => {
    if (loading) return;
    const version = ++generation.current;
    setBusy(true); setError(''); setPage(null);
    apiData<Page>(`/api/explore/communities?${params()}`).then(data => { if (version === generation.current) setPage(data); })
      .catch(cause => { if (version === generation.current) setError(requestError(cause)); })
      .finally(() => { if (version === generation.current) setBusy(false); });
    return () => { generation.current++; };
  }, [tab, categorySlug, debounced, loading, user?.id, refresh]);
  async function more() {
    if (busy || !page?.nextCursor) return;
    const version = generation.current;
    const search = params(); search.set('cursor', page.nextCursor); setBusy(true); setError('');
    try { const data = await apiData<Page>(`/api/explore/communities?${search}`); if (version === generation.current) setPage(current => current && ({ ...data, items: [...current.items, ...data.items] })); }
    catch (cause) { if (version === generation.current) setError(requestError(cause)); }
    finally { if (version === generation.current) setBusy(false); }
  }
  return <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
    <header className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-sm font-medium text-brand">Find your people</p><h1 className="text-3xl font-extrabold">Explore</h1><p className="mt-2 text-white/65">Discover communities for the things you care about.</p></div><div className="flex flex-wrap gap-2">{user && <><Link className="btn-ghost" href="/communities/manage">Manage communities</Link><Link className="auth-button" href="/spaces/new">Create space</Link></>}</div></header>
    <label className="block text-sm font-medium">Search communities<input className="auth-input" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search names, descriptions and tags" /></label>
    <CategoryPicker value={category} onChange={setCategory} counts={counts} />
    <nav aria-label="Explore tabs" className="flex flex-wrap gap-2 border-b border-white/10 pb-3">{tabs.map(([key, label]) => <button key={key} type="button" aria-current={tab === key ? 'page' : undefined} className={`min-h-11 rounded-xl px-4 py-2 text-sm font-semibold ${tab === key ? 'bg-brand text-white' : 'bg-surface text-white/70 hover:bg-brand-soft'}`} onClick={() => setTab(key)}>{label}</button>)}</nav>
    {tab === 'for_you' && page?.needsInterests && <p className="rounded-xl bg-brand-soft p-4 text-sm">Pick your interests to get better suggestions. <Link href={user ? '/settings?section=interests' : '/login?next=%2Fsettings%3Fsection%3Dinterests'} className="font-semibold text-brand underline">Choose interests</Link></p>}
    {error && <p role="alert" className="text-rose-500">{error} <button className="underline" onClick={() => setRefresh(value => value+1)}>Retry</button></p>}
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{page?.items.map(space => <li key={space.id} className="card flex min-w-0 flex-col p-5">
      <div className="flex min-w-0 items-center gap-3"><Avatar name={space.name} size={44} square /><Link href={`/s/${space.slug}`} className="min-w-0 break-words text-lg font-bold hover:text-brand">{space.name}</Link></div><CategoryChips space={space} /><p className="mb-4 break-words text-sm text-white/70">{space.description || 'A place to share ideas and meet people.'}</p><p className="mt-auto mb-4 text-xs text-white/60">{space.memberCount} members · {space.postCount7d} posts this week</p>
      {space.joined ? <div className="flex flex-wrap items-center gap-3 text-sm"><span className="rounded-full bg-brand-soft px-3 py-1 text-brand">Joined · {space.role}</span><Link className="font-medium text-brand underline" href={`/s/${space.slug}`}>Open community</Link></div> : <JoinCommunity space={space} onJoined={() => setRefresh(value => value+1)} />}
    </li>)}{busy && Array.from({ length: 6 }, (_, index) => <li key={`skeleton-${index}`} aria-hidden className="card h-52 animate-pulse bg-white/5" />)}</ul>
    {busy && <span role="status" className="sr-only">Fetching communities</span>}
    {!busy && !error && page?.items.length === 0 && <div className="card flex flex-col items-center gap-3 p-8 text-center"><Icon name="compass" size={32} /><p>No communities match. Try another category.</p><button className="btn-ghost" onClick={() => { setCategory([]); setQuery(''); setTab('trending'); }}>Browse trending communities</button></div>}
    {page?.nextCursor && <button onClick={() => void more()} disabled={busy} className="auth-button">Load more</button>}
  </main>;
}
