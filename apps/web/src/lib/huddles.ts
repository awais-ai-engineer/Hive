'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { socket } from './socket';
import { apiData } from './spaces';

export type HuddleUser = { id: string; username: string; avatarUrl?: string | null };
export type Huddle = { channelId: string; count: number; users: HuddleUser[] };

/** Who is in a huddle or voice room right now, keyed by channel or conversation id. */
let huddles: Record<string, Huddle> = {};
const listeners = new Set<() => void>();
const publish = (next: Record<string, Huddle>) => { huddles = next; listeners.forEach(listener => listener()); };

async function load() {
  try {
    const list = await apiData<Huddle[]>('/api/calls');
    publish(Object.fromEntries(list.map(item => [item.channelId, item])));
  } catch { /* the sidebar keeps what it has */ }
}

if (typeof window !== 'undefined') {
  socket.on('call:participants', (huddle: Huddle) => {
    const next = { ...huddles };
    if (huddle.count > 0) next[huddle.channelId] = huddle; else delete next[huddle.channelId];
    publish(next);
  });
  socket.on('connect', () => void load());
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const empty: Record<string, Huddle> = {};

/** Live huddles; `enabled` (logged in) triggers a load. */
export function useHuddles(enabled = true) {
  useEffect(() => { if (enabled) void load(); }, [enabled]);
  return useSyncExternalStore(subscribe, () => huddles, () => empty);
}
