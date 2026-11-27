'use client';

import { Button as UiButton, Select as UiSelect, LoadingState } from '@hive/ui';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/icons';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '../../lib/auth';
import { fetchPosts, type Post, type VoteResult } from '../../lib/posts';
import { apiData, requestError, type Space } from '../../lib/spaces';
import { socket } from '../../lib/socket';
import { PostCard } from './post-card';
import { PostComposerDialog } from './post-composer-dialog';

export function PostFeed({ space }: { space?: Space }) {
  const { user, loading } = useAuth();
  const search = useSearchParams();
  const router = useRouter();
  const sort = ['hot', 'new', 'top'].includes(search.get('sort') ?? '') ? search.get('sort')! : 'hot';
  const period = search.get('t') ?? 'week';
  const path = space ? `/api/spaces/${encodeURIComponent(space.slug)}/posts` : '/api/feed';
  const [posts, setPosts] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [memberships, setMemberships] = useState<Space[]>([]);
  const [composerOpen, setComposerOpen] = useState(false);
  const version = useRef(0);
  const paging = useRef(false);
  const load = useCallback(async () => {
    const current = ++version.current;
    setBusy(true); setError('');
    try {
      const page = await fetchPosts(path, new URLSearchParams({ sort, t: period }));
      if (version.current === current) { setPosts(page.items); setCursor(page.next_cursor); setFresh(false); }
    } catch (cause) { if (version.current === current) setError(requestError(cause)); }
    finally { if (version.current === current) setBusy(false); }
  }, [path, sort, period]);
  useEffect(() => { if (!loading) void load(); return () => { version.current++; }; }, [load, loading, user?.id]);
  useEffect(() => {
    if (!user) { setMemberships([]); return; }
    let active = true;
    apiData<Space[]>('/api/me/spaces').then(value => { if (active) setMemberships(value); }).catch(() => {});
    return () => { active = false; };
  }, [user?.id]);
  useEffect(() => {
    if (!user) return;
    const ids = space ? [space.id] : memberships.map(item => item.id);
    const watch = () => ids.forEach(spaceId => socket.emit('space:watch', { spaceId }, () => {}));
    if (socket.connected) watch();
    const score = (data: { postId: string; score: number; upvotes: number; downvotes: number }) => setPosts(list => list.map(post => post.id === data.postId ? { ...post, score: data.score, upvotes: data.upvotes, downvotes: data.downvotes } : post));
    const newPost = (data: { spaceId: string; postId: string }) => {
      if (!ids.includes(data.spaceId)) return;
      void load();
    };
    socket.on('connect', watch).on('post:score', score).on('post:new', newPost);
    return () => {
      socket.off('connect', watch).off('post:score', score).off('post:new', newPost);
      ids.forEach(spaceId => { if (socket.connected) socket.emit('space:unwatch', { spaceId }, () => {}); });
    };
  }, [user?.id, space?.id, memberships, load]);
  function change(key: string, value: string) {
    const params = new URLSearchParams(search.toString()); params.set(key, value); router.push(`?${params}`);
  }
  async function more() {
    if (!cursor || paging.current) return;
    paging.current = true; const current = version.current;
    try {
      const page = await fetchPosts(path, new URLSearchParams({ sort, t: period, cursor }));
      if (current === version.current) {
        setPosts(list => [...list, ...page.items.filter(post => !list.some(item => item.id === post.id))]);
        setCursor(page.next_cursor);
      }
    } catch (cause) { setError(requestError(cause)); }
    finally { paging.current = false; }
  }
  const update = (id: string, value: VoteResult) => setPosts(list => list.map(post => post.id === id ? { ...post, ...value } : post));
  const postableSpaces = space
    ? (space.my_role && space.my_role !== 'guest' ? [space] : [])
    : memberships.filter(item => item.my_role && item.my_role !== 'guest');
  function addPublished(post: Post) {
    if (!space || post.space.id === space.id) setPosts(list => [post, ...list.filter(item => item.id !== post.id)]);
    setFresh(false);
  }
  return <div className="min-w-0 space-y-4">
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex flex-wrap items-center gap-2">
      {([['hot', 'Hot', 'trending'], ['new', 'Latest', 'sparkles'], ['top', 'Top', 'activity']] as const).map(([value, label, icon]) =>
        <UiButton key={value} aria-pressed={sort === value} onClick={() => change('sort', value)}
          className={`flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium transition ${sort === value ? 'bg-brand-soft text-brand shadow-sm' : 'text-white/60 hover:bg-[var(--surface-2)] hover:text-white'}`}>
          <Icon name={icon} size={16} />{label}</UiButton>)}
      </div>
      {sort === 'top' && <UiSelect aria-label="Time range" value={period} onChange={event => change('t', event.target.value)} className="rounded-xl border border-white/10 bg-surface px-3 py-2 text-sm">
        {Object.entries({ day: 'Today', week: 'This week', month: 'This month', year: 'This year', all: 'All time' }).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </UiSelect>}
      {!!user && !!postableSpaces.length && <UiButton type="button" onClick={() => setComposerOpen(true)} className="ml-auto inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"><Icon name="plus" size={17} />Create Post</UiButton>}
    </div>
    {fresh && <UiButton onClick={() => void load()} className="mx-auto block rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white shadow-[var(--shadow-pop)]">↑ New posts</UiButton>}
    {error && <p role="alert" className="text-rose-400">{error}</p>}
    {busy && !posts.length ? <LoadingState label="Loading posts" /> : !posts.length && !error && <div className="card flex flex-col items-center px-5 py-10 text-center">
      <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-brand-soft text-brand"><Icon name="edit" size={20} /></span>
      <h2 className="font-semibold">No posts yet</h2><p className="mt-1 max-w-sm text-sm text-white/55">{space ? `Start the conversation in ${space.name}.` : 'Share an update, idea, or question with a space you belong to.'}</p>
      {!!user && !!postableSpaces.length && <UiButton type="button" onClick={() => setComposerOpen(true)} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white"><Icon name="plus" size={16} />Create your first post</UiButton>}
    </div>}
    {posts.map(post => {
      const role = space?.my_role ?? memberships.find(item => item.id === post.space.id)?.my_role;
      return <PostCard key={post.id} post={post} combined={!space} reason={!user ? 'Log in to vote' : !role || role === 'guest' ? 'Join to vote' : ''} onChange={value => update(post.id, value)} />;
    })}
    {cursor && !busy && <UiButton className="auth-button" onClick={() => void more()}>Load more</UiButton>}
    <PostComposerDialog open={composerOpen} onOpenChange={setComposerOpen} spaces={postableSpaces} initialSpace={space} userId={user?.id ?? ''} onPublished={addPublished} />
  </div>;
}
