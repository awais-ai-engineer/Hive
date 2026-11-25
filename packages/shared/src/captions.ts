import { z } from 'zod';

export const captionInputSchema = z.object({
  channelId: z.string().min(1), segmentId: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  text: z.string().min(1).max(4000), final: z.boolean().default(false),
});

/** Keep every character while fitting complete recognition results into transport limits. */
export function captionParts(text: string): string[] {
  const parts: string[] = [];
  let part = '';
  for (const point of text) {
    if (part.length + point.length > 3000) { parts.push(part); part = ''; }
    part += point;
  }
  if (part) parts.push(part);
  return parts;
}
