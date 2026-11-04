import type { Message } from '@hive/shared';
import type { Participant } from './dms';

export type Place = {
  id: string;
  kind: 'channel' | 'dm';
  name: string;
  space: { id: string; slug: string; name: string } | null;
  participants: Participant[] | null;
};

export type ThreadItem = {
  parent: Message;
  channel: Place;
  reply_count: number;
  last_reply_id: string;
  last_reply_at: string;
  latest_replies: Message[];
  unread_replies: number;
};

export type UnreadItem = { channel: Place; unread: number; first_unread_id: string | null; items: Message[] };

/** URL for a place on the Home screen (keeps the space of a channel selected). */
export function placeHref(place: Place, currentSlug?: string | null, threadId?: string) {
  const params = new URLSearchParams();
  const slug = place.space?.slug ?? currentSlug;
  if (slug) params.set('s', slug);
  params.set('c', place.id);
  if (threadId) params.set('t', threadId);
  return `/home?${params}`;
}

export function placeLabel(place: Place) {
  return place.kind === 'channel' ? `#${place.name} · ${place.space?.name ?? ''}` : place.name;
}

export const badge = (count: number) => (count > 99 ? '99+' : String(count));

/** Small localStorage helpers; storage can be unavailable (private mode), so never throw. */
export function loadSetting<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch { return fallback; }
}

export function saveSetting(key: string, value: unknown) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}
