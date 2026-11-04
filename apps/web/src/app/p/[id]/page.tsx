'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { postCreateSchema } from '@hive/shared';
import { useAuth } from '../../../lib/auth';
import { apiData, requestError, type Space } from '../../../lib/spaces';
import type { Post } from '../../../lib/posts';
import { PostCard } from '../../../components/posts/post-card';
import { socket } from '../../../lib/socket';

export default function PostPage() {
  const { id } = useParams<{ id: string }>();
  const { user, loading } = useAuth();
  const [post, setPost] = useState<Post | null>(null);
  const [space, setSpace] = useState<Space | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (loading) return;
    let active = true; setPost(null); setError('');
    apiData<Post>(`/api/posts/${id}`).then(async value => {
      if (!active) return;
      setPost(value); setBody(value.body ?? ''); setUrl(value.url ?? '');
      const place = await apiData<Space>(`/api/spaces/${value.space.slug}`);
      if (active) setSpace(place);
    }).catch(cause => { if (active) setError(requestError(cause)); });
    return () => { active = false; };
  }, [id, user?.id, loading]);
  useEffect(() => {
    if (!user || !post) return;
    const spaceId = post.space.id;
    const watch = () => socket.emit('space:watch', { spaceId }, () => {});
    const score = (value: { postId: string; score: number; upvotes: number; downvotes: number }) => {
      if (value.postId === id) setPost(current => current ? { ...current, score: value.score, upvotes: value.upvotes, downvotes: value.downvotes } : current);
    };
    if (socket.connected) watch();
    socket.on('connect', watch).on('post:score', score);
    return () => { socket.off('connect', watch).off('post:score', score); if (socket.connected) socket.emit('space:unwatch', { spaceId }, () => {}); };
  }, [user?.id, post?.space.id, id]);
  const own = user?.id === post?.author?.id;
  const moderate = ['owner', 'admin', 'moderator'].includes(space?.my_role ?? '');
  return <main className="mx-auto max-w-4xl px-4 py-8">
    {error && <p role="alert" className="mb-4 text-rose-400">{error}</p>}
    {!post && !error && <p>Loading post…</p>}
    {post && <>
      <PostCard post={post} full combined reason={post.deleted ? 'Post deleted' : !user ? 'Log in to vote' : !space?.my_role || space.my_role === 'guest' ? 'Join to vote' : ''} onChange={value => setPost(current => current ? { ...current, ...value } : current)} />
      {!post.deleted && <div className="mt-4 flex gap-4 text-sm text-amber-400">
        {own && <button onClick={() => setEditing(value => !value)}>Edit</button>}
        {(own || moderate) && <button onClick={() => setConfirm(true)}>Delete</button>}
      </div>}
      {editing && <form className="mt-4 space-y-3" onSubmit={async event => {
        event.preventDefault(); setError('');
        const parsed = postCreateSchema.safeParse({ title: post.title, body: body || null, url: url || null });
        if (!parsed.success) { setError(parsed.error.issues[0].message); return; }
        setBusy(true);
        try { setPost(await apiData<Post>(`/api/posts/${id}`, { method: 'PATCH', body: JSON.stringify({ body: parsed.data.body, url: parsed.data.url }) })); setEditing(false); }
        catch (cause) { setError(requestError(cause)); }
        finally { setBusy(false); }
      }}>
        <label className="block">Body<textarea className="auth-input min-h-40" maxLength={40000} value={body} onChange={event => setBody(event.target.value)} /></label>
        <label className="block">URL<input className="auth-input" type="url" maxLength={2000} value={url} onChange={event => setUrl(event.target.value)} /></label>
        <button disabled={busy} className="auth-button">Save</button><button type="button" className="ml-4" onClick={() => setEditing(false)}>Cancel</button>
      </form>}
      {confirm && <div role="alertdialog" aria-label="Delete post" className="mt-4 rounded border border-rose-400/30 p-4">
        <p>Delete this post?</p><button disabled={busy} className="mt-3 text-rose-400" onClick={async () => {
          setBusy(true);
          try { await apiData(`/api/posts/${id}`, { method: 'DELETE' }); setPost(await apiData<Post>(`/api/posts/${id}`)); setConfirm(false); setEditing(false); }
          catch (cause) { setError(requestError(cause)); }
          finally { setBusy(false); }
        }}>Confirm delete</button><button className="ml-4" onClick={() => setConfirm(false)}>Cancel</button>
      </div>}
    </>}
  </main>;
}
