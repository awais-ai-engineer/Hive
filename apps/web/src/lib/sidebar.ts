'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { socket } from './socket';
import { apiData } from './spaces';

export type NotifyLevel = 'all' | 'mentions' | 'nothing';
export type BuiltInSection = 'starred' | 'channels' | 'conversations' | 'dms';

export type CustomSection = {
  id: string;
  name: string;
  emoji: string | null;
  /** Null: the section shows in every space (and may hold direct messages). */
  space_id: string | null;
  position: number;
  collapsed: boolean;
  channel_ids: string[];
};

export type SidebarData = {
  stars: string[];
  sections: CustomSection[];
  collapsed: string[];
  prefs: Record<string, NotifyLevel>;
};

export const LEVEL_LABELS: Record<NotifyLevel, string> = {
  all: 'All messages', mentions: 'Only @mentions', nothing: 'Nothing (muted)',
};

const EMPTY: SidebarData = { stars: [], sections: [], collapsed: [], prefs: {} };
const sidebarCache = new Map<string, SidebarData>();
function readSidebarCache(userId: string): SidebarData | undefined {
  const memory = sidebarCache.get(userId);
  if (memory) return memory;
  try {
    const raw = sessionStorage.getItem(`hive:sidebar:v1:${userId}`);
    if (!raw) return undefined;
    const data = JSON.parse(raw) as SidebarData;
    if (!Array.isArray(data.stars) || !Array.isArray(data.sections)) return undefined;
    sidebarCache.set(userId, data);
    return data;
  } catch { return undefined; }
}
function writeSidebarCache(userId: string, data: SidebarData) {
  sidebarCache.set(userId, data);
  try { sessionStorage.setItem(`hive:sidebar:v1:${userId}`, JSON.stringify(data)); } catch { /* session cache is best-effort */ }
}
const json = (method: string, body?: object): RequestInit => ({ method, body: body ? JSON.stringify(body) : undefined });

/** Stars, custom sections, collapsed state and notification levels; refreshed when another tab changes them. */
export function useSidebarData(enabled: boolean, userId?: string) {
  const [data, setData] = useState<SidebarData>(() => userId ? readSidebarCache(userId) ?? EMPTY : EMPTY);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(async () => {
    try {
      const [stars, sidebar, prefs] = await Promise.all([
        apiData<{ channel_id: string }[]>('/api/me/stars'),
        apiData<{ sections: CustomSection[]; collapsed: string[] }>('/api/me/sidebar'),
        apiData<{ channel_id: string; level: NotifyLevel }[]>('/api/me/conversation-prefs'),
      ]);
      const next = {
        stars: stars.map(star => star.channel_id), sections: sidebar.sections, collapsed: sidebar.collapsed,
        prefs: Object.fromEntries(prefs.map(pref => [pref.channel_id, pref.level])),
      };
      setData(next);
      if (userId) writeSidebarCache(userId, next);
    } catch { /* the sidebar keeps what it has */ }
  }, [userId]);
  const reload = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), 150);
  }, [load]);
  useEffect(() => {
    if (!enabled) return;
    void load();
    socket.on('sidebar:updated', reload).on('connect', reload);
    return () => {
      socket.off('sidebar:updated', reload).off('connect', reload);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled, load, reload]);
  useEffect(() => { if (userId) writeSidebarCache(userId, data); }, [data, userId]);
  return { data, setData, reload };
}

export const sidebarApi = {
  star: (id: string) => apiData(`/api/me/stars/${id}`, json('PUT')),
  unstar: (id: string) => apiData(`/api/me/stars/${id}`, json('DELETE')),
  setLevel: (id: string, level: NotifyLevel) => apiData(`/api/me/conversation-prefs/${id}`, json('PUT', { level })),
  createSection: (name: string, emoji: string | null, spaceId: string | null) =>
    apiData<CustomSection>('/api/me/sidebar/sections', json('POST', { name, emoji, space_id: spaceId })),
  updateSection: (id: string, body: { name?: string; emoji?: string | null; collapsed?: boolean }) =>
    apiData(`/api/me/sidebar/sections/${id}`, json('PATCH', body)),
  deleteSection: (id: string) => apiData(`/api/me/sidebar/sections/${id}`, json('DELETE')),
  orderSections: (ids: string[]) => apiData('/api/me/sidebar/sections/order', json('PUT', { ids })),
  moveTo: (sectionId: string, channelId: string) => apiData(`/api/me/sidebar/sections/${sectionId}/items/${channelId}`, json('PUT')),
  moveOut: (channelId: string) => apiData(`/api/me/sidebar/items/${channelId}`, json('DELETE')),
  setCollapsed: (key: BuiltInSection, collapsed: boolean) => apiData(`/api/me/sidebar/collapsed/${key}`, json('PUT', { collapsed })),
};
