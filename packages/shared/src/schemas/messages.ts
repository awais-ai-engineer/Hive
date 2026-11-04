import { z } from 'zod';

export const messageBodySchema = z.string().trim().min(1).max(4000);
export const messageSendSchema = z.object({
  channelId: z.string(), body: messageBodySchema, clientMsgId: z.string().uuid(),
});
export const messageSchema = z.object({
  id: z.string(), channel_id: z.string(),
  author: z.object({ id: z.string(), username: z.string(), avatar_url: z.string().nullable() }),
  body: z.string().nullable(), client_msg_id: z.string().nullable(),
  created_at: z.string(), edited_at: z.string().nullable(), deleted: z.boolean(),
});
export type Message = z.infer<typeof messageSchema>;
export type MessagePage = { items: Message[]; has_more: boolean };
