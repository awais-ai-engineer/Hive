import type { Attachment } from '@hive/shared';
import { apiData } from './spaces';

export type Post = {
  media: Attachment[];
  id: string; space: { id: string; slug: string; name: string };
  author: { id: string; username: string; avatar_url: string | null } | null;
  title: string; body: string | null; url: string | null; domain: string | null;
  score: number; upvotes: number; downvotes: number; comment_count: number;
  my_vote: number; created_at: string; edited_at: string | null; deleted: boolean;
};
export type PostPage = { items: Post[]; next_cursor: string | null };
export type VoteResult = Pick<Post, 'score' | 'upvotes' | 'downvotes' | 'my_vote'>;
export const fetchPosts = (path: string, params: URLSearchParams) => apiData<PostPage>(`${path}?${params}`);
export const vote = (id: string, value: number) => apiData<VoteResult>(`/api/posts/${id}/vote`, {
  method: 'PUT', body: JSON.stringify({ value }),
});
export function relativeTime(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return 'just now';
  for (const [unit, size] of [['y', 31536000], ['mo', 2592000], ['d', 86400], ['h', 3600], ['m', 60]] as const) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${unit} ago`;
  }
  return 'just now';
}
