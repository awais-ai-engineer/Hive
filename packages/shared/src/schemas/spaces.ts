import { z } from 'zod';
import { categorySchema, tagsSchema } from '../categories';

const slug = z.string().min(3).max(50).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .refine(value => !['new', 'settings', 'api', 'invite', 'admin'].includes(value));
/** Email providers shared by millions of people: allowing one would let anyone join. */
export const PUBLIC_EMAIL_DOMAINS = [
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'yandex.com',
  'zoho.com',
];

/** Turns what people paste ("You@Acme.com", "https://www.acme.com/", "@acme.com") into "acme.com". */
export function normalizeDomain(value: string): string {
  let domain = value.trim().toLowerCase();
  domain = domain.replace(/^[a-z]+:\/\//, '');
  domain = domain.slice(domain.lastIndexOf('@') + 1);
  domain = domain.split(/[/?#:\s]/)[0].replace(/^www\./, '').replace(/\.+$/, '');
  return domain;
}

const domain = z.preprocess(
  value => typeof value === 'string' ? (normalizeDomain(value) || null) : value,
  z.string()
    .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
      'Enter your company domain, like yourcompany.com')
    .refine(value => !PUBLIC_EMAIL_DOMAINS.includes(value),
      'Use your company domain. Public email providers like gmail.com would let anyone join.')
    .nullable(),
);
const channelName = z.string().min(1).max(80).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

export const spaceCreateSchema = z.object({
  type: z.enum(['community', 'workspace']),
  name: z.string().trim().min(2).max(60),
  slug,
  description: z.string().max(500).nullable().optional(),
  category: categorySchema.optional(),
  tags: tagsSchema.optional(),
  allowed_email_domain: domain.optional(),
}).refine(value => value.type === 'workspace' || value.allowed_email_domain == null, {
  path: ['allowed_email_domain'], message: 'Email domain is only allowed on workspaces',
});

export const spacePatchSchema = z.object({
  category: categorySchema.optional(),
  tags: tagsSchema.optional(),
  public_chat: z.boolean().optional(),
  name: z.string().trim().min(2).max(60).optional(),
  description: z.string().max(500).nullable().optional(),
  allowed_email_domain: domain.optional(),
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
