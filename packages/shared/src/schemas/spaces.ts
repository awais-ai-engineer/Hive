import { z } from 'zod';
import { categorySchema, tagsSchema } from '../categories';

const slug = z.string().min(3).max(50).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .refine(value => !['new', 'settings', 'api', 'invite', 'admin'].includes(value));
const domain = z.string().regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const channelName = z.string().min(1).max(80).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

export const spaceCreateSchema = z.object({
  type: z.enum(['community', 'workspace']),
  name: z.string().trim().min(2).max(60),
  slug,
  description: z.string().max(500).nullable().optional(),
  category: categorySchema.optional(),
  tags: tagsSchema.optional(),
  allowed_email_domain: domain.nullable().optional(),
}).refine(value => value.type === 'workspace' || value.allowed_email_domain == null, {
  path: ['allowed_email_domain'], message: 'Email domain is only allowed on workspaces',
});

export const spacePatchSchema = z.object({
  category: categorySchema.optional(),
  tags: tagsSchema.optional(),
  public_chat: z.boolean().optional(),
  name: z.string().trim().min(2).max(60).optional(),
  description: z.string().max(500).nullable().optional(),
  allowed_email_domain: domain.nullable().optional(),
});

export const channelCreateSchema = z.object({
  name: channelName,
  type: z.enum(['text', 'voice']),
  topic: z.string().max(250).nullable().optional(),
});

export const inviteCreateSchema = z.object({
  max_uses: z.number().int().min(1).max(1000).nullable().optional(),
  expires_in_hours: z.number().int().min(1).max(720).nullable().optional(),
});

export type SpaceCreateInput = z.infer<typeof spaceCreateSchema>;
export type SpacePatchInput = z.infer<typeof spacePatchSchema>;
export type ChannelCreateInput = z.infer<typeof channelCreateSchema>;
