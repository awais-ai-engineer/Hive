'use client';

import { useState } from 'react';
import { vote, type Post, type VoteResult } from '../../lib/posts';
import { requestError } from '../../lib/spaces';

export function VoteButtons({ post, reason, onChange }: { post: Post; reason: string; onChange: (value: VoteResult) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function choose(direction: number) {
    if (busy || reason) return;
    const value = post.my_vote === direction ? 0 : direction;
    const previous = { score: post.score, upvotes: post.upvotes, downvotes: post.downvotes, my_vote: post.my_vote };
    onChange({ score: post.score + value - post.my_vote, my_vote: value,
      upvotes: post.upvotes + Number(value === 1) - Number(post.my_vote === 1),
      downvotes: post.downvotes + Number(value === -1) - Number(post.my_vote === -1) });
    setBusy(true); setError('');
    try { onChange(await vote(post.id, value)); }
    catch (cause) { onChange(previous); setError(requestError(cause)); }
    finally { setBusy(false); }
  }
  return <div className="flex shrink-0 flex-wrap items-center gap-2 sm:w-14 sm:flex-col">
    <button aria-label="Upvote" aria-pressed={post.my_vote === 1} disabled={!!reason || busy} title={reason || 'Upvote'}
      className={`rounded px-2 py-1 focus-visible:outline-amber-400 disabled:opacity-40 ${post.my_vote === 1 ? 'text-amber-400' : 'text-white/50'}`} onClick={() => void choose(1)}>▲</button>
    <span aria-label="Score" className="text-sm font-semibold">{post.score}</span>
    <button aria-label="Downvote" aria-pressed={post.my_vote === -1} disabled={!!reason || busy} title={reason || 'Downvote'}
      className={`rounded px-2 py-1 focus-visible:outline-amber-400 disabled:opacity-40 ${post.my_vote === -1 ? 'text-amber-400' : 'text-white/50'}`} onClick={() => void choose(-1)}>▼</button>
    {error && <p role="alert" className="max-w-48 text-xs text-rose-400">{error}</p>}
  </div>;
}
