import { z } from 'zod';

export const signupSchema = z.object({
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_]+$/),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const profileSchema = z.object({
  username: signupSchema.shape.username.optional(),
  avatar_url: z.string().url().refine(value => /^https?:\/\//i.test(value)).nullable().optional(),
});
