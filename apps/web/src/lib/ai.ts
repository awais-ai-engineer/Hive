'use client';

import { useEffect, useState } from 'react';
import type { AiSummary } from '@hive/shared';
import { apiFetch, responseData, subscribeSession } from './api';

export type AiStatus = { enabled: boolean; languages: { code: string; name: string }[] };

let status: Promise<AiStatus> | null = null;
subscribeSession(() => { status = null; });

/** Whether AI features are switched on for this server. Null while loading; controls stay hidden when off. */
export function useAiStatus(active = true): AiStatus | null {
  const [value, setValue] = useState<AiStatus | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    status ??= apiFetch('/api/ai/status').then(response => responseData<AiStatus>(response))
      .catch(() => ({ enabled: false, languages: [] }));
    void status.then(result => { if (live) setValue(result); });
    return () => { live = false; };
  }, [active]);
  return value?.enabled ? value : null;
}

export async function aiPost<T>(path: string, body: object): Promise<T> {
  return responseData<T>(await apiFetch(`/api/ai${path}`, { method: 'POST', body: JSON.stringify(body) }));
}

export const summarize = (body: object) => aiPost<AiSummary>('/summarize', body);

// Translation ---------------------------------------------------------------------------------

export type Translation = { targetId: string; translation: string | null; alreadyInLanguage: boolean; status: string };
type Waiter = { resolve: (value: Translation) => void; reject: (error: Error) => void };

const done = new Map<string, Translation>();
let queue: { id: string; language: string; waiter: Waiter }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

async function flush() {
  const batch = queue; queue = []; timer = null;
  for (const language of new Set(batch.map(item => item.language))) {
    const mine = batch.filter(item => item.language === language);
    try {
      const { items } = await aiPost<{ items: Translation[] }>('/translate-batch', {
        language, items: mine.map(item => ({ targetType: 'message', targetId: item.id })) });
      for (const item of mine) {
        const result = items.find(entry => entry.targetId === item.id);
        if (result?.status === 'ok') { done.set(`${language}:${item.id}`, result); item.waiter.resolve(result); }
        else item.waiter.reject(new Error(result?.status === 'unavailable' ? 'This message can no longer be translated.' : 'The translation did not come back. Please try again.'));
      }
    } catch (cause) { for (const item of mine) item.waiter.reject(cause instanceof Error ? cause : new Error('Translation failed.')); }
  }
}

/** Asks for a message translation; requests made close together travel as one batch. */
export function translateMessage(id: string, language: string): Promise<Translation> {
  const known = done.get(`${language}:${id}`);
  if (known) return Promise.resolve(known);
  return new Promise((resolve, reject) => {
    queue.push({ id, language, waiter: { resolve, reject } });
    timer ??= setTimeout(() => void flush(), 200);
  });
}

const TRANSLATE_ALL = (channelId: string) => `hive:translate-all:${channelId}`;
export const TRANSLATE_ALL_EVENT = 'hive:translate-all';
export function translateAll(channelId: string): boolean {
  try { return localStorage.getItem(TRANSLATE_ALL(channelId)) === '1'; } catch { return false; }
}
export function setTranslateAll(channelId: string, on: boolean) {
  try { localStorage.setItem(TRANSLATE_ALL(channelId), on ? '1' : '0'); } catch { /* storage unavailable */ }
  window.dispatchEvent(new CustomEvent(TRANSLATE_ALL_EVENT, { detail: { channelId } }));
}
