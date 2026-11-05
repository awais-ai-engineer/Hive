import type { Comment, CommentPage } from '@hive/shared';
import type { VoteResult } from './posts';
import { apiData } from './spaces';

export type { Comment, CommentPage };

export const fetchComments = (postId: string, params: URLSearchParams) =>
  apiData<CommentPage>(`/api/posts/${postId}/comments?${params}`);

export const fetchComment = (commentId: string, sort: string = 'best') =>
  apiData<Comment>(`/api/comments/${commentId}?sort=${sort}`);

export const createComment = (postId: string, body: string, parentId?: string | null) =>
  apiData<Comment>(`/api/posts/${postId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body, parentId: parentId || undefined }),
  });

export const editComment = (commentId: string, body: string) =>
  apiData<Comment>(`/api/comments/${commentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  });

export const deleteComment = (commentId: string) =>
  apiData(`/api/comments/${commentId}`, {
    method: 'DELETE',
  });

export const voteComment = (commentId: string, value: number) =>
  apiData<VoteResult>(`/api/comments/${commentId}/vote`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
