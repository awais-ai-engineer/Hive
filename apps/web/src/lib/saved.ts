'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { apiData } from './spaces';
import { useAuth } from './auth';

export type SavedKind = 'message' | 'post' | 'comment';
type Ids = { messages: string[]; posts: string[]; comments: string[] };

const plural = { message: 'messages', post: 'posts', comment: 'comments' } as const;
let state: Record<SavedKind, Set<string>> = { message: new Set(), post: new Set(), comment: new Set() };
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

function replace(ids: Ids) {
  state = { message: new Set(ids.messages), post: new Set(ids.posts), comment: new Set(ids.comments) };
  loaded = true;
  emit();
}
function change(kind: SavedKind, id: string, on: boolean) {
  const next = new Set(state[kind]);
  if (on) next.add(id); else next.delete(id);
  state = { ...state, [kind]: next };
  emit();
}

/** Which messages, posts and comments the viewer saved; one shared copy for every bookmark button. */
export function useSaved() {
  const { user } = useAuth();
  const snapshot = useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, () => state, () => state);
  useEffect(() => {
    if (!user || loaded) return;
    apiData<Ids>('/api/saved/ids').then(replace).catch(() => {});
  }, [user]);
  const isSaved = useCallback((kind: SavedKind, id: string) => snapshot[kind].has(id), [snapshot]);
  const toggle = useCallback(async (kind: SavedKind, id: string) => {
    const on = !state[kind].has(id);
    change(kind, id, on);
    try { await apiData(`/api/saved/${plural[kind]}/${id}`, { method: on ? 'PUT' : 'DELETE' }); }
    catch (cause) { change(kind, id, !on); throw cause; }
  }, []);
  return { isSaved, toggle, enabled: !!user };
}

export function forgetSaved(kind: SavedKind, id: string) { change(kind, id, false); }
