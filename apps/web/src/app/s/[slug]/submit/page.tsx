'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { postCreateSchema } from '@hive/shared';
import { useAuth } from '../../../../lib/auth';
import { apiData, requestError } from '../../../../lib/spaces';
import type { Post } from '../../../../lib/posts';

export default function SubmitPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const { user, loading } = useAuth();
  const [kind, setKind] = useState('text');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (loading) return <p className="p-8">Loading…</p>;
  if (!user) return <main className="p-8"><Link className="text-amber-400" href={`/login?next=${encodeURIComponent(`/s/${slug}/submit`)}`}>Log in</Link> to create a post.</main>;
  return <main className="mx-auto max-w-2xl px-4 py-8">
    <h1 className="mb-6 text-2xl font-bold">Create post</h1>
    <form className="space-y-4" onSubmit={async event => {
      event.preventDefault(); setError('');
      const parsed = postCreateSchema.safeParse({ title, body: kind === 'text' ? body : null, url: kind === 'link' && url ? url : null });
      if (!parsed.success) { setError(parsed.error.issues[0].message); return; }
      setBusy(true);
      try {
        const post = await apiData<Post>(`/api/spaces/${encodeURIComponent(slug)}/posts`, { method: 'POST', body: JSON.stringify(parsed.data) });
        router.push(`/p/${post.id}`);
      } catch (cause) { setError(requestError(cause)); }
      finally { setBusy(false); }
    }}>
      <div className="flex gap-3">{['text', 'link'].map(value => <button type="button" key={value} aria-pressed={kind === value} className={`rounded px-4 py-2 capitalize ${kind === value ? 'bg-white/10 text-amber-400' : ''}`} onClick={() => setKind(value)}>{value}</button>)}</div>
      <label className="block">Title<input className="auth-input mt-1" value={title} maxLength={300} required onChange={event => setTitle(event.target.value)} /></label>
      <p className="text-right text-xs text-white/40">{title.length}/300</p>
      {kind === 'text' ? <label className="block">Body<textarea className="auth-input mt-1 min-h-48" maxLength={40000} value={body} onChange={event => setBody(event.target.value)} /></label>
        : <label className="block">URL<input type="url" className="auth-input mt-1" maxLength={2000} value={url} onChange={event => setUrl(event.target.value)} /></label>}
      {error && <p role="alert" className="text-rose-400">{error}</p>}
      <button disabled={busy} className="auth-button">{busy ? 'Posting…' : 'Create post'}</button>
    </form>
  </main>;
}
