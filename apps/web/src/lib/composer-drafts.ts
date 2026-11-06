import { useEffect, useState } from 'react';
import { apiData } from './spaces';
import { currentUserId } from './api';

export type SavedDraft = { channelId: string; parentId: string | null; body: string; updatedAt: string };
export const DRAFTS_CHANGED = 'hive:drafts-changed';
const queues = new Map<string, Promise<unknown>>();
export function saveComposerDraft(owner: string, channelId: string, parentId: string | null, body: string) {
  const key = `${owner}:${channelId}:${parentId ?? ''}`;
  const pending = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (currentUserId() !== owner) return;
    await apiData(`/api/channels/${channelId}/draft`, { method: 'PUT', body: JSON.stringify({ parentId, body }) });
    window.dispatchEvent(new Event(DRAFTS_CHANGED));
  });
  queues.set(key,pending);
  void pending.finally(() => { if (queues.get(key) === pending) queues.delete(key); }).catch(() => {});
  return pending;
}

/** Ids of channels and conversations where the viewer has an unsent top-level draft. */
export function useDraftChannels() {
  const [ids, setIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    let active = true;
    const load = () => apiData<SavedDraft[]>('/api/drafts')
      .then(items => { if (active) setIds(new Set(items.filter(item => !item.parentId && item.body.trim()).map(item => item.channelId))); })
      .catch(() => {});
    void load();
    window.addEventListener(DRAFTS_CHANGED, load);
    return () => { active = false; window.removeEventListener(DRAFTS_CHANGED, load); };
  }, []);
  return ids;
}
