'use client';

import { useState } from 'react';
import { vote, type VoteResult } from '../../lib/posts';
import { requestError } from '../../lib/spaces';

export type VotableItem = {
  id: string;
  score: number;
  upvotes: number;
  downvotes: number;
  my_vote: number;
};

export function VoteButtons({
  item,
  post,
  reason,
  onChange,
  onVote,
  horizontal = false,
}: {
  item?: VotableItem;
  post?: VotableItem;
  reason: string;
  onChange: (value: VoteResult) => void;
  onVote?: (id: string, value: number) => Promise<VoteResult>;
  horizontal?: boolean;
}) {
  const current = item ?? post!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function choose(direction: number) {
    if (busy || reason) return;
    const value = current.my_vote === direction ? 0 : direction;
    const previous = {
      score: current.score,
      upvotes: current.upvotes,
      downvotes: current.downvotes,
      my_vote: current.my_vote,
    };
    onChange({
      score: current.score + value - current.my_vote,
      my_vote: value,
      upvotes: current.upvotes + Number(value === 1) - Number(current.my_vote === 1),
      downvotes: current.downvotes + Number(value === -1) - Number(current.my_vote === -1),
    });
    setBusy(true);
    setError('');
    try {
      const voteFn = onVote ?? vote;
      onChange(await voteFn(current.id, value));
    } catch (cause) {
      onChange(previous);
      setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`flex shrink-0 items-center gap-1 ${horizontal ? 'flex-row' : 'flex-wrap sm:w-14 sm:flex-col'}`}>
      <button
        aria-label="Upvote"
        aria-pressed={current.my_vote === 1}
        disabled={!!reason || busy}
        title={reason || 'Upvote'}
        className={`rounded px-1.5 py-0.5 text-xs focus-visible:outline-amber-400 disabled:opacity-40 ${current.my_vote === 1 ? 'text-amber-400' : 'text-white/50 hover:text-white/80'}`}
        onClick={() => void choose(1)}
      >
        ▲
      </button>
      <span aria-label="Score" className="text-xs font-semibold sm:text-sm">
        {current.score}
      </span>
      <button
        aria-label="Downvote"
        aria-pressed={current.my_vote === -1}
        disabled={!!reason || busy}
        title={reason || 'Downvote'}
        className={`rounded px-1.5 py-0.5 text-xs focus-visible:outline-amber-400 disabled:opacity-40 ${current.my_vote === -1 ? 'text-amber-400' : 'text-white/50 hover:text-white/80'}`}
        onClick={() => void choose(-1)}
      >
        ▼
      </button>
      {error && <p role="alert" className="max-w-48 text-xs text-rose-400">{error}</p>}
    </div>
  );
}
