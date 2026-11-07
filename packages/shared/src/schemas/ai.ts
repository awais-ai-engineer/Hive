import { z } from 'zod';

export const rewriteModes = ['shorter', 'professional', 'friendlier', 'fix_grammar'] as const;
export const rewriteSchema = z.object({
  text: z.string().min(1).max(4000),
  mode: z.enum(rewriteModes),
});
export type RewriteInput = z.infer<typeof rewriteSchema>;

export const translateSchema = z.object({
  targetType: z.enum(['message', 'post', 'comment']),
  targetId: z.string().min(1).max(26),
  language: z.string().max(8),
});
export type TranslateInput = z.infer<typeof translateSchema>;

export const summarizeSchema = z.object({
  channelId: z.string().max(26).optional(),
  parentId: z.string().max(26).optional(),
  sinceUnread: z.boolean().optional(),
  allUnreads: z.boolean().optional(),
});
export type SummarizeInput = z.infer<typeof summarizeSchema>;

export const askSchema = z.object({
  question: z.string().min(2).max(500),
  spaceId: z.string().max(26).optional(),
});
export type AskInput = z.infer<typeof askSchema>;

export type AiSource = { n: number; messageId: string; channelId: string; url: string; author: string; place: string };
export type AiItem = { text: string; sources: AiSource[] };
export type AiSummary = {
  scope: string; messageCount: number; empty: boolean;
  points: AiItem[]; decisions: AiItem[]; questions: AiItem[]; actions: AiItem[];
};
export type PriorityLevel = 'urgent' | 'for_you' | 'later';
