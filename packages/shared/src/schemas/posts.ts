import { z } from 'zod';

export const postCreateSchema = z.object({
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().max(40000).transform(value => value || null).nullable().optional(),
  url: z.string().max(2000).url().refine(value => /^https?:\/\//.test(value), 'Use an HTTP or HTTPS link').nullable().optional(),
}).refine(value => !(value.body && value.url), 'Choose text or a link');
export type PostCreateInput = z.infer<typeof postCreateSchema>;
