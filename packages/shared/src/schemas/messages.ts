import { z } from 'zod';

export const messageBodySchema = z.string().trim().max(4000);
export const pollCreateSchema = z.object({ question: z.string().trim().min(1).max(200), options: z.array(z.string().trim().min(1).max(80)).min(2).max(10) });
export const pollSchema = z.object({ question: z.string(), closedAt: z.string().nullable(), options: z.array(z.object({ id: z.string(), label: z.string(), position: z.number(), count: z.number() })), counts: z.record(z.number()), total: z.number(), myVote: z.string().nullable() });
export const ciphertextSchema = z.object({
  v: z.literal(1), senderDeviceId: z.string(), salt: z.string(),
  envelopes: z.array(z.object({ deviceId: z.string(), iv: z.string(), ct: z.string() })).min(1).max(20),
});
export const messageSendSchema = z.object({
  kind: z.enum(['text', 'poll', 'voice']).optional(), poll: pollCreateSchema.optional(),
  channelId: z.string(), body: messageBodySchema.default(''), clientMsgId: z.string().uuid(),
  parentId: z.string().nullable().optional(), attachmentIds: z.array(z.string()).max(5).optional(),
  viewOnce: z.boolean().optional(), ciphertext: ciphertextSchema.optional(),
}).refine(value => !!value.poll || !!value.ciphertext || value.body.length > 0 || (value.attachmentIds?.length ?? 0) > 0, 'Message must contain text or an attachment')
  .refine(value => value.kind !== 'poll' || !!value.poll, 'Poll is required')
  .refine(value => !value.poll || (value.kind !== 'voice' && !value.attachmentIds?.length), 'Polls cannot contain attachments')
  .refine(value => value.kind !== 'voice' || value.attachmentIds?.length === 1, 'Voice messages require one audio attachment');

export const reactionSchema = z.object({ emoji: z.string(), count: z.number(), user_ids: z.array(z.string()) });
export const attachmentSchema = z.object({
  kind: z.enum(['image', 'video', 'file', 'audio']),
  durationMs: z.number().nullable().optional(), waveform: z.array(z.number().int().min(0).max(100)).length(64).nullable().optional(),
  id: z.string(), filename: z.string(), content_type: z.string(), size: z.number(), url: z.string(),
  viewOnce: z.boolean().optional(), viewState: z.enum(['unopened', 'opened']).nullable().optional(),
});
export const messageSchema = z.object({
  kind: z.enum(['text', 'poll', 'voice', 'huddle', 'system']).optional(),
  expires_at: z.string().nullable().optional(),
  ciphertext: ciphertextSchema.nullable().optional(),
  mentions: z.array(z.object({ userId: z.string(), username: z.string(), displayName: z.string().nullable() })).optional(),
  channelLinks: z.array(z.object({id: z.string(), name: z.string(), href: z.string()})).optional(),
  poll: pollSchema.nullable().optional(),
  id: z.string(), channel_id: z.string(), parent_id: z.string().nullable(),
  author: z.object({
    id: z.string(), username: z.string(), avatar_url: z.string().nullable(),
    status_emoji: z.string().nullable().optional(), status_text: z.string().nullable().optional(),
    status_expires_at: z.string().nullable().optional(),
  }),
  body: z.string().nullable(), client_msg_id: z.string().nullable(),
  created_at: z.string(), edited_at: z.string().nullable(), deleted: z.boolean(),
  reply_count: z.number(), reactions: z.array(reactionSchema), attachments: z.array(attachmentSchema),
  post_previews: z.array(z.object({
    id: z.string(), title: z.string(), score: z.number(), comment_count: z.number(), deleted: z.boolean(),
    space: z.object({ slug: z.string(), name: z.string() }),
  })).optional(),
});
export type Reaction = z.infer<typeof reactionSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
export type Message = z.infer<typeof messageSchema>;
export type MessagePage = { items: Message[]; has_more: boolean };
export type ThreadPage = MessagePage & { parent: Message };
export type ReactionUpdate = { messageId: string; channelId: string; reactions: Reaction[] };
export type MessageExpired = { channelId: string; ids: string[]; replyCounts: Record<string, number> };
export type ChannelDisappearing = { channelId: string; seconds: number };
export type AttachmentViewed = { attachmentId: string; messageId: string; channelId: string; viewerId: string; uploaderId: string; senderState: 'unopened' | 'opened' };
export type MessageDeleted = { id: string; channelId: string; parentId: string | null };

export type Poll = z.infer<typeof pollSchema>;
export type PollUpdate = {messageId: string; counts: Record<string, number>; total: number; closedAt: string | null};


export const reminderCreateSchema = z.object({
  text: z.string().trim().min(1).max(500), remindAt: z.string().datetime({ offset: true }),
}).refine(value => Date.parse(value.remindAt) > Date.now(), 'Choose a future time');
export const draftSaveSchema = z.object({ body: messageBodySchema.default(''), parentId: z.string().nullable().optional() });
export const scheduledCreateSchema = z.object({
  body: messageBodySchema.default(''), parentId: z.string().nullable().optional(),
  attachmentIds: z.array(z.string()).max(5).optional(), sendAt: z.string().datetime({ offset: true }),
}).refine(value => !!value.body || !!value.attachmentIds?.length, 'Message must contain text or an attachment')
  .refine(value => Date.parse(value.sendAt) > Date.now(), 'Choose a future time');
