'use client';

import { Button as UiButton } from '@hive/ui';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Comment } from '@hive/shared';
import { SocketEvents } from '@hive/shared';
import { useAuth } from '../../lib/auth';
import type { Space } from '../../lib/spaces';
import {
  createComment,
  fetchComment,
  fetchComments,
} from '../../lib/comments';
import { socket } from '../../lib/socket';
import { CommentComposer } from './comment-composer';
import { CommentTree } from './comment-tree';

type Props = {
  postId: string;
  space: Space | null;
  postDeleted: boolean;
};

export function CommentSection({ postId, space, postDeleted }: Props) {
  const { user } = useAuth();
  const search = useSearchParams();
  const router = useRouter();

  const sort = ['best', 'top', 'new', 'old'].includes(search.get('sort') ?? '')
    ? search.get('sort')!
    : 'best';

  const [comments, setComments] = useState<Comment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [freshCount, setFreshCount] = useState(0);
  const [focusedThread, setFocusedThread] = useState<Comment | null>(null);

  const version = useRef(0);
  const userIdRef = useRef(user?.id);
  userIdRef.current = user?.id;
  const paging = useRef(false);

  const myRole = space?.my_role;
  const canModerate = ['owner', 'admin', 'moderator'].includes(myRole ?? '');
  const commentReason = postDeleted
    ? 'Post deleted'
    : !user
    ? 'Log in to comment'
    : !myRole || myRole === 'guest'
    ? 'Join to comment'
    : '';
  const voteReason = postDeleted
    ? 'Post deleted'
    : !user
    ? 'Log in to vote'
    : !myRole || myRole === 'guest'
    ? 'Join to vote'
    : '';

  const load = useCallback(async () => {
    const current = ++version.current;
    setBusy(true);
    setError('');
    try {
      const page = await fetchComments(postId, new URLSearchParams({ sort }));
      if (version.current === current) {
        setComments(page.items);
        setCursor(page.next_cursor);
        setFreshCount(0);
      }
    } catch (cause) {
      if (version.current === current) {
        setError(cause instanceof Error ? cause.message : 'Failed to load comments');
      }
    } finally {
      if (version.current === current) setBusy(false);
    }
  }, [postId, sort]);

  useEffect(() => {
    void load();
    return () => {
      version.current++;
    };
  }, [load, user?.id]);

  // Handle URL anchor #c-<id>
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash;
    if (hash && hash.startsWith('#c-')) {
      const targetId = hash.slice(3);
      const el = document.getElementById(`c-${targetId}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        // Comment not on page, fetch it directly and focus thread
        fetchComment(targetId, sort)
          .then(c => {
            setFocusedThread(c);
          })
          .catch(() => {});
      }
    }
  }, [comments, sort]);

  // Realtime post:watch / post:unwatch and events
  useEffect(() => {
    const watch = () => socket.emit(SocketEvents.PostWatch, { postId }, () => {});

    const onCommentNew = (incoming: Comment) => {
      if (!incoming.parent_id) {
        // Top-level comment from someone else: show the pill instead of jumping the list.
        // Our own comments are already inserted when the request returns.
        if (incoming.author?.id === userIdRef.current) return;
        setFreshCount(c => c + 1);
      } else {
        // Insert reply into existing tree
        setComments(list => insertReply(list, incoming));
        if (focusedThread) {
          setFocusedThread(curr => (curr ? insertReplySingle(curr, incoming) : curr));
        }
      }
    };

    const onCommentScore = (data: {
      id: string;
      score: number;
      upvotes: number;
      downvotes: number;
    }) => {
      setComments(list =>
        updateNode(list, data.id, {
          score: data.score,
          upvotes: data.upvotes,
          downvotes: data.downvotes,
        })
      );
      if (focusedThread) {
        setFocusedThread(curr =>
          curr
            ? updateNodeSingle(curr, data.id, {
                score: data.score,
                upvotes: data.upvotes,
                downvotes: data.downvotes,
              })
            : curr
        );
      }
    };

    const onCommentUpdated = (data: Comment) => {
      setComments(list =>
        updateNode(list, data.id, { body: data.body, edited_at: data.edited_at })
      );
      if (focusedThread) {
        setFocusedThread(curr =>
          curr
            ? updateNodeSingle(curr, data.id, { body: data.body, edited_at: data.edited_at })
            : curr
        );
      }
    };

    const onCommentDeleted = (data: { id: string }) => {
      setComments(list =>
        updateNode(list, data.id, { deleted: true, body: null, author: null })
      );
      if (focusedThread) {
        setFocusedThread(curr =>
          curr
            ? updateNodeSingle(curr, data.id, { deleted: true, body: null, author: null })
            : curr
        );
      }
    };

    if (socket.connected) watch();
    socket
      .on('connect', watch)
      .on(SocketEvents.CommentNew, onCommentNew)
      .on(SocketEvents.CommentScore, onCommentScore)
      .on(SocketEvents.CommentUpdated, onCommentUpdated)
      .on(SocketEvents.CommentDeleted, onCommentDeleted);

    return () => {
      socket
        .off('connect', watch)
        .off(SocketEvents.CommentNew, onCommentNew)
        .off(SocketEvents.CommentScore, onCommentScore)
        .off(SocketEvents.CommentUpdated, onCommentUpdated)
        .off(SocketEvents.CommentDeleted, onCommentDeleted);
      if (socket.connected) {
        socket.emit(SocketEvents.PostUnwatch, { postId }, () => {});
      }
    };
  }, [postId, focusedThread]);

  function changeSort(newSort: string) {
    const params = new URLSearchParams(search.toString());
    params.set('sort', newSort);
    router.push(`?${params}`);
  }

  async function handleLoadMore() {
    if (!cursor || paging.current) return;
    paging.current = true;
    const current = version.current;
    try {
      const page = await fetchComments(
        postId,
        new URLSearchParams({ sort, cursor })
      );
      if (current === version.current) {
        setComments(list => [...list, ...page.items.filter(c => !list.some(x => x.id === c.id))]);
        setCursor(page.next_cursor);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load more');
    } finally {
      paging.current = false;
    }
  }

  async function handleCreateTopComment(body: string) {
    const created = await createComment(postId, body, null);
    setComments(list => [created, ...list]);
  }

  async function handleReply(parentId: string, body: string) {
    const created = await createComment(postId, body, parentId);
    setComments(list => insertReply(list, created));
    if (focusedThread) {
      setFocusedThread(curr => (curr ? insertReplySingle(curr, created) : curr));
    }
  }

  function handleUpdateComment(updated: Partial<Comment> & { id: string }) {
    setComments(list => updateNode(list, updated.id, updated));
    if (focusedThread) {
      setFocusedThread(curr => (curr ? updateNodeSingle(curr, updated.id, updated) : curr));
    }
  }

  function handleDeleteComment(commentId: string) {
    setComments(list =>
      updateNode(list, commentId, { deleted: true, body: null, author: null })
    );
    if (focusedThread) {
      setFocusedThread(curr =>
        curr ? updateNodeSingle(curr, commentId, { deleted: true, body: null, author: null }) : curr
      );
    }
  }

  function handleReplaceSubtree(commentId: string, fullComment: Comment) {
    setComments(list => replaceNode(list, commentId, fullComment));
    if (focusedThread) {
      setFocusedThread(curr => (curr ? replaceNodeSingle(curr, commentId, fullComment) : curr));
    }
  }

  return (
    <section className="mt-8 border-t border-white/10 pt-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h3 className="text-lg font-semibold text-white">Comments</h3>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-white/40">Sort by:</span>
          {['best', 'top', 'new', 'old'].map(option => (
            <UiButton
              key={option}
              aria-pressed={sort === option}
              onClick={() => changeSort(option)}
              className={`rounded px-2.5 py-1 capitalize transition-colors ${
                sort === option
                  ? 'bg-amber-400/20 text-amber-400 font-medium'
                  : 'text-white/50 hover:text-white/80'
              }`}
            >
              {option}
            </UiButton>
          ))}
        </div>
      </div>

      {/* Top Composer */}
      {!postDeleted && !focusedThread && (
        <div className="mb-6">
          <CommentComposer
            onSubmit={handleCreateTopComment}
            reason={commentReason}
            placeholder="What are your thoughts?"
            submitLabel="Comment"
          />
        </div>
      )}

      {/* Fresh Comments Pill */}
      {freshCount > 0 && (
        <div className="mb-4 text-center">
          <UiButton
            onClick={() => void load()}
            className="rounded-full border border-amber-400/40 bg-amber-400/15 px-4 py-1.5 text-xs font-semibold text-amber-400 shadow-sm hover:bg-amber-400/25"
          >
            {freshCount} new {freshCount === 1 ? 'comment' : 'comments'} — show
          </UiButton>
        </div>
      )}

      {error && (
        <p role="alert" className="mb-4 text-xs text-rose-400">
          {error}
        </p>
      )}

      {/* Continue this thread focused view */}
      {focusedThread ? (
        <div>
          <UiButton
            onClick={() => setFocusedThread(null)}
            className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-amber-400 hover:underline"
          >
            ← Back to all comments
          </UiButton>
          <CommentTree
            comment={focusedThread}
            postId={postId}
            userId={user?.id}
            canModerate={canModerate}
            voteReason={voteReason}
            commentReason={commentReason}
            onReply={handleReply}
            onUpdate={handleUpdateComment}
            onDelete={handleDeleteComment}
            onReplaceSubtree={handleReplaceSubtree}
            onFocusThread={id => {
              fetchComment(id, sort).then(setFocusedThread).catch(() => {});
            }}
          />
        </div>
      ) : (
        <>
          {busy && !comments.length && (
            <p className="py-6 text-sm text-white/40">Loading comments…</p>
          )}

          {!busy && !comments.length && !error && (
            <p className="py-8 text-center text-sm text-white/40">
              No comments yet. Start the conversation.
            </p>
          )}

          <div className="space-y-4">
            {comments.map(c => (
              <CommentTree
                key={c.id}
                comment={c}
                postId={postId}
                userId={user?.id}
                canModerate={canModerate}
                voteReason={voteReason}
                commentReason={commentReason}
                onReply={handleReply}
                onUpdate={handleUpdateComment}
                onDelete={handleDeleteComment}
                onReplaceSubtree={handleReplaceSubtree}
                onFocusThread={id => {
                  fetchComment(id, sort).then(setFocusedThread).catch(() => {});
                }}
              />
            ))}
          </div>

          {cursor && (
            <div className="mt-6 text-center">
              <UiButton
                disabled={paging.current}
                onClick={handleLoadMore}
                className="rounded border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-white/80 hover:bg-white/10 hover:text-white"
              >
                Load more comments
              </UiButton>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// Tree immutability helpers
function insertReply(list: Comment[], incoming: Comment): Comment[] {
  return list.map(item => insertReplySingle(item, incoming));
}

function insertReplySingle(node: Comment, incoming: Comment): Comment {
  if (node.id === incoming.parent_id) {
    if (node.replies.some(r => r.id === incoming.id)) return node;
    return {
      ...node,
      reply_count: node.reply_count + 1,
      replies: [...node.replies, incoming],
    };
  }
  if (!node.replies.length) return node;
  return {
    ...node,
    replies: node.replies.map(r => insertReplySingle(r, incoming)),
  };
}

function updateNode(list: Comment[], id: string, updates: Partial<Comment>): Comment[] {
  return list.map(item => updateNodeSingle(item, id, updates));
}

function updateNodeSingle(node: Comment, id: string, updates: Partial<Comment>): Comment {
  if (node.id === id) {
    return { ...node, ...updates };
  }
  if (!node.replies.length) return node;
  return {
    ...node,
    replies: node.replies.map(r => updateNodeSingle(r, id, updates)),
  };
}

function replaceNode(list: Comment[], id: string, replacement: Comment): Comment[] {
  return list.map(item => replaceNodeSingle(item, id, replacement));
}

function replaceNodeSingle(node: Comment, id: string, replacement: Comment): Comment {
  if (node.id === id) {
    return replacement;
  }
  if (!node.replies.length) return node;
  return {
    ...node,
    replies: node.replies.map(r => replaceNodeSingle(r, id, replacement)),
  };
}
