'use client';

import Link from 'next/link';
import { relativeTime, type Post, type VoteResult } from '../../lib/posts';
import { VoteButtons } from './vote-buttons';

export function PostCard({ post, combined = false, full = false, reason, onChange }: {
  post: Post; combined?: boolean; full?: boolean; reason: string; onChange: (value: VoteResult) => void;
}) {
  return <article className="min-w-0 rounded-xl border border-white/10 bg-white/[0.03] p-4 sm:flex sm:gap-4">
    <VoteButtons post={post} reason={reason} onChange={onChange} />
    <div className="min-w-0 flex-1">
      <h2 className="break-words text-lg font-semibold [overflow-wrap:anywhere]">
        {post.url ? <a href={post.url} target="_blank" rel="noopener noreferrer nofollow ugc" className="hover:text-amber-400">{post.title} ↗</a>
          : full ? post.title : <Link className="hover:text-amber-400" href={`/p/${post.id}`}>{post.title}</Link>}
        {post.domain && <span className="ml-2 text-xs font-normal text-white/40">({post.domain})</span>}
      </h2>
      <p className="mt-1 text-xs text-white/45">posted by {post.author ? `u/${post.author.username}` : '[deleted]'} · <time dateTime={post.created_at}>{relativeTime(post.created_at)}</time>
        {combined && <> · in <Link className="text-amber-400" href={`/s/${post.space.slug}`}>{post.space.name}</Link></>}
        {post.edited_at && ' · edited'}</p>
      {post.body && <p className={`mt-3 whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${full ? 'text-white/85' : 'text-white/50'}`}>{full ? post.body : post.body.slice(0, 300) + (post.body.length > 300 ? '…' : '')}</p>}
      <Link className="mt-3 inline-block text-xs text-white/50 hover:text-amber-400" href={`/p/${post.id}`}>{post.comment_count} comments · View post</Link>
    </div>
  </article>;
}
