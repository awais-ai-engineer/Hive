import { z } from 'zod';

export const messageBodySchema = z.string().trim().max(4000);
export const messageSendSchema = z.object({
  channelId: z.string(), body: messageBodySchema, clientMsgId: z.string().uuid(),
  parentId: z.string().nullable().optional(), attachmentIds: z.array(z.string()).max(5).optional(),
}).refine(value => value.body.length > 0 || (value.attachmentIds?.length ?? 0) > 0, 'Message must contain text or an attachment');

export const reactionSchema = z.object({ emoji: z.string(), count: z.number(), user_ids: z.array(z.string()) });
export const attachmentSchema = z.object({
  kind: z.enum(['image', 'video', 'file']),
  id: z.string(), filename: z.string(), content_type: z.string(), size: z.number(), url: z.string(),
});
export const messageSchema = z.object({
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
  /** "huddle" for the line posted when a huddle ends; absent or null for people's messages. */
  kind: z.string().nullable().optional(),
});
export type Reaction = z.infer<typeof reactionSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
export type Message = z.infer<typeof messageSchema>;
export type MessagePage = { items: Message[]; has_more: boolean };
export type ThreadPage = MessagePage & { parent: Message };
export type ReactionUpdate = { messageId: string; channelId: string; reactions: Reaction[] };
export type MessageDeleted = { id: string; channelId: string; parentId: string | null };
