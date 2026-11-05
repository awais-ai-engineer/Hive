'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { relativeTime, type Post, type PostSummary, type VoteResult } from '../../lib/posts';
import { MediaGallery, mediaUrl } from './media-gallery';
import { RepostDialog } from './repost-dialog';
import { ShareMenu } from './share-menu';
import { VoteButtons } from './vote-buttons';

/** The original post embedded inside a repost. */
function OriginalPost({ original }: { original: PostSummary }) {
  if (original.deleted) {
    return <div className="mt-3 rounded-lg border border-white/10 p-3 text-sm italic text-white/40">[deleted]</div>;
  }
  const first = original.media?.[0];
  return <Link href={`/p/${original.id}`} className="mt-3 block rounded-lg border border-white/15 p-3 hover:border-amber-400/50">
    <p className="text-xs text-white/45">{original.space.name} · {original.author ? `u/${original.author.username}` : '[deleted]'}</p>
    <p className="mt-1 break-words font-semibold [overflow-wrap:anywhere]">{original.title}
      {original.domain && <span className="ml-2 text-xs font-normal text-white/40">({original.domain})</span>}</p>
    {first?.kind === 'image' && <img src={mediaUrl(first.url)}
      alt={first.filename} loading="lazy" className="mt-2 max-h-60 max-w-full rounded object-contain" />}
    {first?.kind === 'video' && <p className="mt-2 text-xs text-white/50">▶ Video</p>}
  </Link>;
}

export function PostCard({ post, combined = false, full = false, reason, onChange }: {
  post: Post; combined?: boolean; full?: boolean; reason: string; onChange: (value: VoteResult) => void;
}) {
  const { user } = useAuth();
  const [reposting, setReposting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const canRepost = !!user && !post.deleted && post.space.type !== 'workspace';
  const original = post.repost_of;

  return <article className="min-w-0 rounded-xl border border-white/10 bg-white/[0.03] p-4 sm:flex sm:gap-4">
    <VoteButtons post={post} reason={reason} onChange={onChange} />
    <div className="min-w-0 flex-1">
      {original && <p className="mb-1 text-xs text-white/50">🔁 Reposted by {post.author ? `u/${post.author.username}` : '[deleted]'}
        {' · in '}<Link className="text-amber-400" href={`/s/${post.space.slug}`}>{post.space.name}</Link></p>}
      <h2 className="break-words text-lg font-semibold [overflow-wrap:anywhere]">
        {post.url ? <a href={post.url} target="_blank" rel="noopener noreferrer nofollow ugc" className="hover:text-amber-400">{post.title} ↗</a>
          : full ? post.title : <Link className="hover:text-amber-400" href={`/p/${post.id}`}>{post.title}</Link>}
        {post.domain && <span className="ml-2 text-xs font-normal text-white/40">({post.domain})</span>}
      </h2>
      {!original && <p className="mt-1 text-xs text-white/45">posted by {post.author ? `u/${post.author.username}` : '[deleted]'} · <time dateTime={post.created_at}>{relativeTime(post.created_at)}</time>
        {combined && <> · in <Link className="text-amber-400" href={`/s/${post.space.slug}`}>{post.space.name}</Link></>}
        {post.edited_at && ' · edited'}</p>}
      {original && <OriginalPost original={original} />}
      {!!post.media?.length && <MediaGallery files={post.media} postId={post.id} full={full} />}
      {post.body && <p className={`mt-3 whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${full ? 'text-white/85' : 'text-white/50'}`}>{full ? post.body : post.body.slice(0, 300) + (post.body.length > 300 ? '…' : '')}</p>}
      <div className="relative mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/55">
        <Link className="hover:text-amber-400" href={`/p/${post.id}#comments`}>💬 {post.comment_count} {post.comment_count === 1 ? 'comment' : 'comments'}</Link>
        {canRepost && <button type="button" className="hover:text-amber-400" onClick={() => setReposting(true)}>
          🔁 Repost{post.repost_count ? ` (${post.repost_count})` : ''}</button>}
        {!canRepost && post.repost_count > 0 && <span>🔁 {post.repost_count}</span>}
        {!post.deleted && <button type="button" className="hover:text-amber-400" aria-haspopup="menu" aria-expanded={sharing}
          onClick={() => setSharing(value => !value)}>↗ Share</button>}
        <ShareMenu post={post} isOpen={sharing} onClose={() => setSharing(false)} />
      </div>
      <RepostDialog post={post} isOpen={reposting} onClose={() => setReposting(false)} />
    </div>
  </article>;
}
