'use client';

import { apiFetch, responseData } from './api';

export type SoundPreferences = { enabled: boolean; volume: number; messages: boolean; huddles: boolean; activity: boolean; feedback: boolean };
export type SoundCategory = 'messages' | 'huddles' | 'activity' | 'feedback';
const defaults: SoundPreferences = { enabled: true, volume: 0.35, messages: true, huddles: true, activity: true, feedback: true };
let preferences = { ...defaults };
let context: AudioContext | null = null;
let unlocked = false;
let suppressed = false;
let lastPlayback = 0;
let ringTimer: ReturnType<typeof setInterval> | null = null;
const seen = new Map<string, number>();
const tabId = typeof crypto !== 'undefined' ? crypto.randomUUID() : '';
const bus = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('hive:sound-events') : null;
if (bus) bus.onmessage = ({ data }) => {
  if (typeof data?.id !== 'string') return;
  seen.set(data.id, Date.now());
  const oldest = seen.keys().next().value;
  if (seen.size > 1000 && oldest !== undefined) seen.delete(oldest);
};

export function soundPreferences() { return { ...preferences }; }
export function configureSounds(value: Partial<SoundPreferences>) {
  preferences = { ...preferences, ...value };
  preferences.volume = Math.max(0, Math.min(1, preferences.volume));
  try { localStorage.setItem('hive:sound-preferences', JSON.stringify(preferences)); } catch { /* storage may be disabled */ }
  if (!preferences.enabled) stopRing();
}
export async function loadSounds() {
  configureSounds(await responseData<SoundPreferences>(await apiFetch('/api/me/sounds')));
}
export async function saveSounds(value: SoundPreferences) {
  const saved = await responseData<SoundPreferences>(await apiFetch('/api/me/sounds', { method: 'PUT', body: JSON.stringify(value) }));
  configureSounds(saved);
}
export function suppressSounds(value: boolean) { suppressed = value; if (value) stopRing(); }
export function soundsEnabled() { return preferences.enabled; }
export function setSoundsEnabled(on: boolean) { configureSounds({ enabled: on }); void saveSounds(preferences).catch(() => {}); }

function audio() {
  if (!unlocked || typeof window === 'undefined') return null;
  try {
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return null;
    context ??= new Context();
    if (context.state === 'suspended') void context.resume().catch(() => {});
    return context;
  } catch { return null; }
}
if (typeof window !== 'undefined') {
  const unlock = () => { unlocked = true; audio(); };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
}

/** Original synthesized tones; no third-party recordings or asset licences required. */
function tone(ctx: AudioContext, frequency: number, start: number, length: number) {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'sine'; oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(preferences.volume * 0.18, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  oscillator.start(start); oscillator.stop(start + length + 0.02);
}

export function playSound(event: string, category: SoundCategory = 'feedback', id?: string, preview = false) {
  const now = Date.now();
  if (!preferences.enabled || preferences.volume <= 0 || !preferences[category] || (!preview && suppressed) || now - lastPlayback < 350) return;
  if (id && seen.has(id)) return;
  const ctx = audio();
  if (!ctx || ctx.state !== 'running') return;
  const perform = () => {
    if (id) {
      try {
        const key = 'hive:sound-recent';
        const recent = JSON.parse(localStorage.getItem(key) || '{}') as Record<string, number>;
        if (recent[id] > now - 60000) return;
        const pruned = Object.fromEntries(Object.entries(recent).filter(([, time]) => time > now - 60000).slice(-100));
        localStorage.setItem(key, JSON.stringify({ ...pruned, [id]: now }));
      } catch { /* same-tab deduplication remains available */ }
      seen.set(id, now); bus?.postMessage({ id, tabId });
    }
    lastPlayback = now;
    for (const [key, time] of seen) if (now - time > 60000) seen.delete(key);
    const down = /leave|stop|off|end|mute|error|failed|lost/.test(event);
    const base = category === 'huddles' ? 660 : category === 'messages' ? 880 : category === 'activity' ? 740 : 520;
    tone(ctx, down ? base * 1.25 : base, ctx.currentTime, 0.13);
    tone(ctx, down ? base : base * 1.5, ctx.currentTime + 0.10, 0.20);
  };
  if (id && navigator.locks) void navigator.locks.request('hive:sound-playback', perform).catch(() => {});
  else perform();
}
export function playMessageSound(id?: string) { playSound('incoming', 'messages', id); }
export function startRing(id?: string) {
  if (ringTimer || suppressed || !preferences.enabled || !preferences.huddles) return;
  const started = Date.now();
  playSound('invitation', 'huddles', id ? `${id}:0` : undefined);
  ringTimer = setInterval(() => playSound('invitation', 'huddles', id ? `${id}:${Math.round((Date.now() - started) / 2000)}` : undefined), 2000);
  setTimeout(stopRing, 30000);
}
export function stopRing() { if (ringTimer) clearInterval(ringTimer); ringTimer = null; }
