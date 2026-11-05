'use client';

import { useState } from 'react';
import type { Comment } from '@hive/shared';
import { CommentItem } from './comment-item';
import { fetchComment } from '../../lib/comments';

type Props = {
  comment: Comment;
  postId: string;
  userId?: string;
  canModerate: boolean;
  voteReason: string;
  commentReason: string;
  onReply: (parentId: string, body: string) => Promise<void>;
  onUpdate: (updated: Partial<Comment> & { id: string }) => void;
  onDelete: (commentId: string) => void;
  onReplaceSubtree: (commentId: string, fullComment: Comment) => void;
  onFocusThread?: (commentId: string) => void;
};

export function CommentTree({
  comment,
  postId,
  userId,
  canModerate,
  voteReason,
  commentReason,
  onReply,
  onUpdate,
  onDelete,
  onReplaceSubtree,
  onFocusThread,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState('');

  async function handleLoadMore() {
    setLoadingMore(true);
    setLoadError('');
    try {
      const full = await fetchComment(comment.id);
      onReplaceSubtree(comment.id, full);
    } catch {
      setLoadError('Failed to load replies.');
    } finally {
      setLoadingMore(false);
    }
  }

  // Deep levels stop indenting further after level 6 on mobile screens
  const indentClass =
    comment.depth >= 6
      ? 'border-l border-white/10 pl-2 sm:pl-4 ml-1 sm:ml-2'
      : 'border-l border-white/10 pl-3 sm:pl-4 ml-1 sm:ml-2';

  return (
    <div className="relative my-2">
      {/* Clickable vertical gutter line */}
      <div
        onClick={() => setCollapsed(val => !val)}
        className="absolute bottom-0 left-0 top-6 w-3 cursor-pointer opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-100"
        title="Click to collapse"
      />

      <CommentItem
        comment={comment}
        postId={postId}
        userId={userId}
        canModerate={canModerate}
        voteReason={voteReason}
        commentReason={commentReason}
        isCollapsed={collapsed}
        onToggleCollapse={() => setCollapsed(val => !val)}
        onReply={onReply}
        onUpdate={onUpdate}
        onDelete={onDelete}
      />

      {/* Children replies */}
      {!collapsed && (
        <div className={`mt-2 ${indentClass}`}>
          {comment.replies.map(child => (
            <CommentTree
              key={child.id}
              comment={child}
              postId={postId}
              userId={userId}
              canModerate={canModerate}
              voteReason={voteReason}
              commentReason={commentReason}
              onReply={onReply}
              onUpdate={onUpdate}
              onDelete={onDelete}
              onReplaceSubtree={onReplaceSubtree}
              onFocusThread={onFocusThread}
            />
          ))}

          {/* More replies or Continue this thread */}
          {comment.more_replies > 0 && (
            <div className="mt-2 text-xs">
              {comment.depth >= 5 && onFocusThread ? (
                <button
                  onClick={() => onFocusThread(comment.id)}
                  className="font-medium text-amber-400 hover:underline"
                >
                  Continue this thread →
                </button>
              ) : (
                <button
                  disabled={loadingMore}
                  onClick={handleLoadMore}
                  className="font-medium text-amber-400 hover:underline disabled:opacity-50"
                >
                  {loadingMore
                    ? 'Loading replies…'
                    : `${comment.more_replies} more ${
                        comment.more_replies === 1 ? 'reply' : 'replies'
                      }`}
                </button>
              )}
              {loadError && <p className="mt-1 text-rose-400">{loadError}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
