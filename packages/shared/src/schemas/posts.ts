import { z } from 'zod';
import { attachmentSchema } from './messages';

export const postCreateSchema = z.object({
  mediaIds: z.array(z.string()).max(10).optional(),
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().max(40000).transform(value => value || null).nullable().optional(),
  url: z.string().max(2000).url().refine(value => /^https?:\/\//.test(value), 'Use an HTTP or HTTPS link').nullable().optional(),
}).refine(value => !((value.body || value.mediaIds?.length) && value.url), 'Choose text or a link');
export type PostCreateInput = z.infer<typeof postCreateSchema>;

export const repostCreateSchema = z.object({
  spaceSlug: z.string().min(1),
  title: z.string().trim().max(300).optional(),
});
export type RepostCreateInput = z.infer<typeof repostCreateSchema>;

export const postSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  space: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  author: z.object({ id: z.string(), username: z.string(), avatar_url: z.string().nullable() }).nullable(),
  url: z.string().nullable().optional(),
  domain: z.string().nullable().optional(),
  media: z.array(attachmentSchema).optional(),
  score: z.number().default(0),
  comment_count: z.number().default(0),
  deleted: z.boolean().default(false),
});
export type PostSummary = z.infer<typeof postSummarySchema>;
