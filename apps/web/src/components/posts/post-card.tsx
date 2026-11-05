'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { relativeTime, type Post, type PostSummary, type VoteResult } from '../../lib/posts';
import { Avatar } from '../ui/avatar';
import { ReportDialog } from '../report-dialog';
import { Icon } from '../ui/icons';
import { MediaGallery, mediaUrl } from './media-gallery';
import { RepostDialog } from './repost-dialog';
import { ShareMenu } from './share-menu';
import { VoteButtons } from './vote-buttons';

/** The original post embedded inside a repost. */
function OriginalPost({ original }: { original: PostSummary }) {
  if (original.deleted) {
    return <div className="mt-3 rounded-xl border border-white/10 p-3 text-sm italic text-white/40">[deleted]</div>;
  }
  const first = original.media?.[0];
  return <Link href={`/p/${original.id}`} className="mt-3 flex gap-3 rounded-xl border border-white/10 bg-[var(--surface-2)] p-3 transition hover:border-brand/40">
    <div className="min-w-0 flex-1">
      <p className="text-xs text-white/50">{original.space.name} · {original.author ? original.author.username : '[deleted]'}</p>
      <p className="mt-1 break-words font-semibold [overflow-wrap:anywhere]">{original.title}
        {original.domain && <span className="ml-2 text-xs font-normal text-white/45">({original.domain})</span>}</p>
    </div>
    {first?.kind === 'image' && <img src={mediaUrl(first.url)} alt="" loading="lazy" className="h-16 w-24 shrink-0 rounded-lg object-cover" />}
  </Link>;
}

/** Feed card: author and space, title with excerpt and thumbnail, and an action row. */
export function PostCard({ post, combined = false, full = false, reason, onChange }: {
  post: Post; combined?: boolean; full?: boolean; reason: string; onChange: (value: VoteResult) => void;
}) {
  const { user } = useAuth();
  const [reposting, setReposting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [reporting, setReporting] = useState(false);
  const canRepost = !!user && !post.deleted && post.space.type !== 'workspace';
  const original = post.repost_of;
  const thumb = !full ? post.media?.find(file => file.kind === 'image') : undefined;
  const author = post.author?.username ?? '[deleted]';
  const action = 'flex items-center gap-1.5 rounded-full px-2.5 py-1 transition hover:bg-[var(--surface-2)] hover:text-white';

  return <article className="card animate-in min-w-0 p-4 sm:p-5">
    <header className="flex items-center gap-2 text-sm">
      {post.author ? <Link href={`/u/${post.author.username}`} aria-label={`${author}'s profile`}><Avatar name={author} src={post.author.avatar_url} size={30} /></Link>
        : <Avatar name={author} size={30} />}
      {post.author ? <Link href={`/u/${post.author.username}`} className="font-semibold hover:underline">{author}</Link> : <span className="font-semibold">{author}</span>}
      <span className="text-white/40">·</span>
      <time dateTime={post.created_at} className="text-white/50">{relativeTime(post.created_at)}</time>
      {(combined || original) && <>
        <span className="text-white/40">in</span>
        <Link href={`/s/${post.space.slug}`} className="truncate rounded-full bg-brand-soft px-2 py-0.5 text-xs font-semibold text-brand hover:underline">{post.space.name}</Link>
      </>}
      {post.edited_at && <span className="text-xs text-white/40">· edited</span>}
    </header>

    {original && <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-white/55">🔁 Reposted by {author}</p>}

    <div className="mt-2 flex gap-4">
      <div className="min-w-0 flex-1">
        <h2 className={`break-words font-bold leading-snug [overflow-wrap:anywhere] ${full ? 'text-2xl' : 'text-lg'}`}>
          {post.url ? <a href={post.url} target="_blank" rel="noopener noreferrer nofollow ugc" className="hover:text-brand">{post.title} <span className="text-white/40">↗</span></a>
            : full ? post.title : <Link className="hover:text-brand" href={`/p/${post.id}`}>{post.title}</Link>}
          {post.domain && <span className="ml-2 text-xs font-normal text-white/45">({post.domain})</span>}
        </h2>
        {post.body && <p className={`mt-1.5 whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${full ? 'text-[15px] leading-relaxed text-white/85' : 'line-clamp-2 text-sm text-white/60'}`}>{post.body}</p>}
      </div>
      {thumb && <Link href={`/p/${post.id}`} className="hidden shrink-0 sm:block" aria-label="Open post">
        <img src={mediaUrl(thumb.url)} alt="" loading="lazy" className="h-24 w-40 rounded-xl object-cover" />
      </Link>}
    </div>

    {original && <OriginalPost original={original} />}
    {(full || !thumb) && !!post.media?.length && <MediaGallery files={post.media} postId={post.id} full={full} />}

    <footer className="relative mt-3 flex flex-wrap items-center gap-1 text-sm text-white/60">
      <VoteButtons post={post} reason={reason} onChange={onChange} horizontal />
      <Link className={action} href={`/p/${post.id}#comments`}><Icon name="message" size={16} />{post.comment_count} {post.comment_count === 1 ? 'comment' : 'comments'}</Link>
      {canRepost && <button type="button" className={action} onClick={() => setReposting(true)}>
        🔁 Repost{post.repost_count ? ` · ${post.repost_count}` : ''}</button>}
      {!canRepost && post.repost_count > 0 && <span className={action}>🔁 {post.repost_count}</span>}
      {!post.deleted && <button type="button" className={action} aria-haspopup="menu" aria-expanded={sharing}
        onClick={() => setSharing(value => !value)}><Icon name="send" size={15} />Share</button>}
      {!!user && !post.deleted && post.author && post.author.id !== user.id && <button type="button" className={action} onClick={() => setReporting(true)}><Icon name="flag" size={15} />Report</button>}
      <ShareMenu post={post} isOpen={sharing} onClose={() => setSharing(false)} />
    </footer>
    <ReportDialog target={reporting ? { type: 'post', id: post.id, label: 'post' } : null} onClose={() => setReporting(false)} />
    <RepostDialog post={post} isOpen={reposting} onClose={() => setReposting(false)} />
  </article>;
}
