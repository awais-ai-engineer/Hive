import { z } from 'zod';

export const commentCreateSchema = z.object({
  body: z.string().trim().min(1).max(10000),
  parentId: z.string().nullable().optional(),
});
export type CommentCreateInput = z.infer<typeof commentCreateSchema>;

export const commentPatchSchema = z.object({
  body: z.string().trim().min(1).max(10000),
});
export type CommentPatchInput = z.infer<typeof commentPatchSchema>;

export const commentVoteSchema = z.object({
  value: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
});
export type CommentVoteInput = z.infer<typeof commentVoteSchema>;

export type Comment = {
  id: string;
  post_id: string;
  parent_id: string | null;
  author: { id: string; username: string; avatar_url: string | null } | null;
  body: string | null;
  score: number;
  upvotes: number;
  downvotes: number;
  my_vote: number;
  reply_count: number;
  depth: number;
  created_at: string;
  edited_at: string | null;
  deleted: boolean;
  replies: Comment[];
  more_replies: number;
};

export type CommentPage = {
  items: Comment[];
  next_cursor: string | null;
};
