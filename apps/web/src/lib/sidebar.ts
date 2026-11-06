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
const json = (method: string, body?: object): RequestInit => ({ method, body: body ? JSON.stringify(body) : undefined });

/** Stars, custom sections, collapsed state and notification levels; refreshed when another tab changes them. */
export function useSidebarData(enabled: boolean) {
  const [data, setData] = useState<SidebarData>(EMPTY);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(async () => {
    try {
      const [stars, sidebar, prefs] = await Promise.all([
        apiData<{ channel_id: string }[]>('/api/me/stars'),
        apiData<{ sections: CustomSection[]; collapsed: string[] }>('/api/me/sidebar'),
        apiData<{ channel_id: string; level: NotifyLevel }[]>('/api/me/conversation-prefs'),
      ]);
      setData({
        stars: stars.map(star => star.channel_id), sections: sidebar.sections, collapsed: sidebar.collapsed,
        prefs: Object.fromEntries(prefs.map(pref => [pref.channel_id, pref.level])),
      });
    } catch { /* the sidebar keeps what it has */ }
  }, []);
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
