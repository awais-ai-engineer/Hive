import { z } from 'zod';
import entries from './categories.json';

export const categories = entries;
export const categorySchema = z.string().refine(value => categories.some(item => item.slug === value), 'Choose a valid category');
export const tagsSchema = z.array(z.string().trim().toLowerCase().min(2).max(24).regex(/^[a-z0-9-]+$/))
  .transform(values => [...new Set(values)]).refine(values => values.length <= 5, 'Use at most 5 tags');
export const interestsSchema = z.object({ categories: z.array(categorySchema).max(16).transform(values => [...new Set(values)]) });
export const spaceRulesSchema = z.object({ rules: z.array(z.object({ title: z.string().trim().min(1).max(80), description: z.string().trim().max(500).default('') })).max(15) });
export const membershipPatchSchema = z.object({ muted: z.boolean().optional(), favorite: z.boolean().optional() });
export const spaceOrderSchema = z.object({ slugs: z.array(z.string()).max(500).refine(values => new Set(values).size === values.length) });
