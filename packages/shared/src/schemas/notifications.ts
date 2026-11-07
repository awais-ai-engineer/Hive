import { z } from 'zod';

export const notificationTypes = ['mention', 'reply', 'reaction', 'post_comment', 'invite_accepted', 'dm'] as const;
export const notificationTypeSchema = z.enum(notificationTypes);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

export const personSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});
export type Person = z.infer<typeof personSchema>;

export const notificationSchema = z.object({
  id: z.string(),
  type: notificationTypeSchema,
  actor: personSchema.nullable(),
  spaceId: z.string().nullable(),
  spaceSlug: z.string().nullable(),
  spaceName: z.string().nullable(),
  channelId: z.string().nullable(),
  channelName: z.string().nullable(),
  isDm: z.boolean(),
  messageId: z.string().nullable(),
  postId: z.string().nullable(),
  commentId: z.string().nullable(),
  snippet: z.string(),
  count: z.number(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export type AppNotification = z.infer<typeof notificationSchema>;

export const notificationCountSchema = z.object({ count: z.number().int().nonnegative() });
export type NotificationCount = z.infer<typeof notificationCountSchema>;

export const notificationPreferencesSchema = z.object({
  preferences: z.record(notificationTypeSchema, z.boolean()),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
