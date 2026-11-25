/** Public links follow the deployed site unless a canonical domain is configured. */
export function publicUrl(path: string): string {
  const configured = process.env.NEXT_PUBLIC_WEB_URL?.trim();
  const origin = configured || (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid public website URL');
  return new URL(path, url.origin).toString();
}
