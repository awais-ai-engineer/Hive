'use client';

import { Avatar } from '../ui/avatar';
import { useState } from 'react';
import type { Comment } from '@hive/shared';
import { relativeTime, type VoteResult } from '../../lib/posts';
import { VoteButtons } from '../posts/vote-buttons';
import { voteComment, editComment, deleteComment } from '../../lib/comments';
import { CommentComposer } from './comment-composer';

type Props = {
  comment: Comment;
  postId: string;
  userId?: string;
  canModerate: boolean;
  voteReason: string;
  commentReason: string;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onReply: (parentId: string, body: string) => Promise<void>;
  onUpdate: (updated: Partial<Comment> & { id: string }) => void;
  onDelete: (commentId: string) => void;
};

export function CommentItem({
  comment,
  postId,
  userId,
  canModerate,
  voteReason,
  commentReason,
  isCollapsed,
  onToggleCollapse,
  onReply,
  onUpdate,
  onDelete,
}: Props) {
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  const isAuthor = !!userId && comment.author?.id === userId;
  const canDelete = !comment.deleted && (isAuthor || canModerate);
  const canEdit = !comment.deleted && isAuthor;

  function handleVoteChange(res: VoteResult) {
    onUpdate({ id: comment.id, ...res });
  }

  async function handleSaveEdit(newBody: string) {
    const updated = await editComment(comment.id, newBody);
    onUpdate({
      id: comment.id,
      body: updated.body,
      edited_at: updated.edited_at,
    });
    setEditing(false);
  }

  async function handleConfirmDelete() {
    setBusy(true);
    setActionError('');
    try {
      await deleteComment(comment.id);
      onDelete(comment.id);
      setConfirmDelete(false);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Failed to delete');
    } finally {
      setBusy(false);
    }
  }

  async function handleShare() {
    const url = `${window.location.origin}/p/${postId}#c-${comment.id}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  }

  if (isCollapsed) {
    return (
      <div className="flex items-center gap-2 py-1 text-xs text-white/40">
        <button
          onClick={onToggleCollapse}
          className="rounded px-1 text-amber-400 hover:bg-white/10"
          title="Expand comment"
        >
          [+]
        </button>
        <span className="font-medium text-white/60">
          {comment.deleted ? '[deleted]' : comment.author?.username ?? 'deleted'}
        </span>
        <span>·</span>
        <span>
          {comment.reply_count} {comment.reply_count === 1 ? 'reply' : 'replies'}
        </span>
      </div>
    );
  }

  return (
    <div
      id={`c-${comment.id}`}
      data-comment-id={comment.id}
      className="group relative rounded-md py-1 transition-colors duration-500 target:bg-amber-400/10 target:p-2"
    >
      {/* Header */}
      <div className="flex items-center gap-2 text-xs text-white/40">
        <button
          onClick={onToggleCollapse}
          className="rounded px-1 text-white/50 hover:bg-white/10 hover:text-white"
          title="Collapse comment"
        >
          [–]
        </button>
        {!comment.deleted && comment.author && <Avatar name={comment.author.username} src={comment.author.avatar_url} size={24} />}
        <span className="font-semibold text-white/85">
          {comment.deleted ? (
            <span className="italic text-white/40">[deleted]</span>
          ) : (
            comment.author?.username ?? 'deleted'
          )}
        </span>
        <span>·</span>
        <time dateTime={comment.created_at}>{relativeTime(comment.created_at)}</time>
        {comment.edited_at && !comment.deleted && <span>· edited</span>}
      </div>

      {/* Body or Inline Editor */}
      {editing ? (
        <div className="mt-2">
          <CommentComposer
            initialValue={comment.body ?? ''}
            submitLabel="Save edit"
            onSubmit={handleSaveEdit}
            onCancel={() => setEditing(false)}
            autoFocus
          />
        </div>
      ) : (
        <p
          className={`mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere] ${
            comment.deleted ? 'italic text-white/35' : 'text-white/85'
          }`}
        >
          {comment.deleted ? '[deleted]' : comment.body}
        </p>
      )}

      {actionError && (
        <p role="alert" className="mt-1 text-xs text-rose-400">
          {actionError}
        </p>
      )}

      {/* Actions row */}
      {!comment.deleted && !editing && (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-white/50">
          <VoteButtons
            item={comment}
            onVote={voteComment}
            horizontal
            reason={voteReason}
            onChange={handleVoteChange}
          />
          <button
            onClick={() => setReplying(val => !val)}
            className="hover:text-amber-400 font-medium"
          >
            Reply
          </button>
          {canEdit && (
            <button
              onClick={() => setEditing(true)}
              className="hover:text-amber-400 font-medium"
            >
              Edit
            </button>
          )}
          {canDelete && (
            <button
              onClick={() => setConfirmDelete(true)}
              className="hover:text-rose-400 font-medium"
            >
              Delete
            </button>
          )}
          <button onClick={handleShare} className="hover:text-amber-400 font-medium">
            {copied ? 'Copied link!' : 'Share'}
          </button>
        </div>
      )}

      {/* Delete confirmation dialog */}
      {confirmDelete && (
        <div
          role="alertdialog"
          aria-label="Delete comment"
          className="mt-2 rounded border border-rose-400/30 bg-rose-950/20 p-3"
        >
          <p className="text-xs text-white/80">
            Are you sure you want to delete this comment? Replies will remain visible.
          </p>
          <div className="mt-2 flex items-center gap-3">
            <button
              disabled={busy}
              onClick={handleConfirmDelete}
              className="text-xs font-semibold text-rose-400 hover:text-rose-300 disabled:opacity-50"
            >
              {busy ? 'Deleting…' : 'Confirm delete'}
            </button>
            <button
              disabled={busy}
              onClick={() => setConfirmDelete(false)}
              className="text-xs text-white/60 hover:text-white"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Inline reply composer */}
      {replying && (
        <div className="mt-3">
          <CommentComposer
            placeholder={`Reply to ${comment.author?.username ?? 'author'}…`}
            submitLabel="Reply"
            reason={commentReason}
            autoFocus
            onSubmit={async body => {
              await onReply(comment.id, body);
              setReplying(false);
            }}
            onCancel={() => setReplying(false)}
          />
        </div>
      )}
    </div>
  );
}
