'use client';
import { defaultSoundPreferences, normalizeSoundPreferences, soundEvents, type SoundEvent, type SoundPreferences, type SoundCategory } from '@hive/shared';
import { apiFetch, currentUserId, responseData } from './api';
export { soundEvents, soundCategories, defaultSoundPreferences, normalizeSoundPreferences } from '@hive/shared';
export type { SoundPreferences, SoundCategory, SoundEvent } from '@hive/shared';

let preferences = normalizeSoundPreferences();
let context: AudioContext | null = null;
let unlocked = false;
let suppressed = true;
let generation = 0;
let lastPlayback = 0;
let current: { source: AudioBufferSourceNode; gain: GainNode; priority: number; event: SoundEvent; mandatory: boolean } | null = null;
const buffers = new Map<SoundEvent, Promise<AudioBuffer | null>>();
const seen = new Map<string, number>();
const pending: { event: SoundEvent; id: string; mandatory: boolean }[] = [];
const listeners = new Set<(playing: boolean) => void>();
let announcing = false;
let ring: { id: string; event: 'invitation' | 'outgoing'; expires: number; timer: ReturnType<typeof setInterval>; expiryTimer: ReturnType<typeof setTimeout> } | null = null;
const bus = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('hive:sound-events-v2') : null;
bus?.addEventListener('message', ({ data }) => {
  if (data?.userId !== currentUserId()) return;
  if (typeof data?.id === 'string') remember(data.id);
  if (data?.resolved && ring?.id === data.resolved) stopRing();
});
function remember(id: string) {
  seen.set(id, Date.now());
  for (const [key, time] of seen) if (Date.now() - time > 120000 || seen.size > 1000) seen.delete(key);
}
function announcementState(value: boolean) {
  if (announcing === value) return;
  announcing = value; listeners.forEach(listener => listener(value));
}
/** Captions pause locally during disclosures; output never connects to WebRTC. */
export function onAnnouncement(listener: (playing: boolean) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function isAnnouncing() { return announcing; }
export function soundPreferences() { return normalizeSoundPreferences(preferences); }
export function configureSounds(value: Partial<SoundPreferences>) {
  preferences = normalizeSoundPreferences({ ...preferences, ...value });
  if (!preferences.enabled || !preferences.huddles) stopRing();
  if (current && !current.mandatory && (!preferences.enabled || !preferences[soundEvents[current.event].category] || preferences.events[current.event] === false)) stopCurrent();
  else if (current && context) current.gain.gain.setTargetAtTime(volume(current.event, current.mandatory), context.currentTime, .02);
}
export async function loadSounds() { configureSounds(await responseData<SoundPreferences>(await apiFetch('/api/me/sounds'))); }
export async function saveSounds(value: SoundPreferences) { configureSounds(await responseData<SoundPreferences>(await apiFetch('/api/me/sounds', { method: 'PUT', body: JSON.stringify(value) }))); }
export function suppressSounds(value: boolean) { suppressed = value; if (value) { stopRing(); if (!current?.mandatory) stopCurrent(); } }
export function soundsEnabled() { return preferences.enabled; }
export function setSoundsEnabled(on: boolean) { configureSounds({ enabled: on }); void saveSounds(preferences).catch(() => {}); }
function audio() {
  if (!unlocked || typeof window === 'undefined') return null;
  try {
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return null;
    context ??= new Context();
    if (context.state === 'suspended') void context.resume().then(drain).catch(() => {});
    return context;
  } catch { return null; }
}
export function unlockSounds() {
  unlocked = true; const ctx = audio();
  if (ctx?.state === 'running') drain();
  for (const event of ['incoming', 'message_sent', 'invitation'] as const) void asset(event);
}
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', unlockSounds, { passive: true });
  window.addEventListener('keydown', unlockSounds);
  window.addEventListener('pagehide', () => resetAudio());
}
function asset(event: SoundEvent): Promise<AudioBuffer | null> {
  const ctx = audio(); if (!ctx) return Promise.resolve(null);
  let buffer = buffers.get(event);
  if (!buffer) {
    buffer = fetch(`/sounds/v2/${event}.wav`).then(response => {
      if (!response.ok) throw new Error('Audio unavailable');
      return response.arrayBuffer();
    }).then(bytes => ctx.decodeAudioData(bytes)).catch(() => { buffers.delete(event); return null; });
    buffers.set(event, buffer);
  }
  return buffer;
}
function volume(event: SoundEvent, mandatory: boolean, previewVolume?: number) { return Math.min(1, Math.max(mandatory ? .25 : 0, previewVolume ?? preferences.volume) * soundEvents[event].gain); }
function stopCurrent() {
  const old = current; current = null;
  if (old) {
    const cleanup = () => { old.source.disconnect(); old.gain.disconnect(); };
    old.source.onended = cleanup;
    try {
      const now = context?.currentTime ?? 0;
      old.gain.gain.setTargetAtTime(0, now, .004);
      old.source.stop(now + .025);
    } catch { cleanup(); }
  }
  announcementState(false);
}
function drain() {
  if (current || !unlocked || context?.state !== 'running') return;
  const next = pending.shift(); if (next) void perform(next.event, next.id, { mandatory: next.mandatory }).catch(() => {}).finally(() => { if (!current) drain(); });
}
type Options = { mandatory?: boolean; preview?: boolean; volume?: number; ringId?: string };
function allowed(event: SoundEvent, options: Options) { return (!options.ringId || ring?.id === options.ringId) && (options.mandatory || options.preview || (!suppressed && preferences.enabled && preferences.volume > 0 && preferences[soundEvents[event].category] && preferences.events[event] !== false)); }
async function perform(event: SoundEvent, id: string | undefined, options: Options = {}) {
  if (!allowed(event, options) || (id && seen.has(id))) return;
  if (!unlocked || audio()?.state !== 'running') {
    if (options.mandatory && id && !pending.some(item => item.id === id)) pending.length < 32 && pending.push({ event, id, mandatory: true });
    return;
  }
  const epoch = generation; const buffer = await asset(event);
  if (!buffer || epoch !== generation || !allowed(event, options) || (id && seen.has(id))) return;
  const priority = options.preview ? 9 : soundEvents[event].priority;
  if (current && (current.mandatory || current.priority >= priority)) {
    if (options.mandatory && id && !pending.some(item => item.id === id)) pending.length < 32 && pending.push({ event, id, mandatory: true });
    return;
  }
  if (!options.preview && priority < 5 && Date.now() - lastPlayback < 180) return;
  const play = () => {
    if (epoch !== generation || !allowed(event, options) || (id && seen.has(id))) return;
    if (current && (current.mandatory || current.priority >= priority)) {
      if (options.mandatory && id && !pending.some(item => item.id === id) && pending.length < 32) pending.push({ event, id, mandatory: true });
      return;
    }
    if (id && soundEvents[event].scope === 'shared' && !options.preview) {
      try {
        const recent = JSON.parse(localStorage.getItem(`hive:sound-recent-v2:${currentUserId()}`) || '{}') as Record<string, number>;
        if (recent[id] > Date.now() - 120000) return;
        localStorage.setItem(`hive:sound-recent-v2:${currentUserId()}`, JSON.stringify({ ...Object.fromEntries(Object.entries(recent).filter(([, t]) => t > Date.now() - 120000).slice(-100)), [id]: Date.now() }));
      } catch { /* same-tab and BroadcastChannel protection remain */ }
    }
    if (id) { remember(id); bus?.postMessage({ id, userId: currentUserId() }); }
    stopCurrent();
    const ctx = context!; const source = ctx.createBufferSource(); const gain = ctx.createGain();
    source.buffer = buffer; gain.gain.value = volume(event, !!options.mandatory, options.volume);
    source.connect(gain).connect(ctx.destination);
    current = { source, gain, priority, event, mandatory: !!options.mandatory }; lastPlayback = Date.now();
    if (soundEvents[event].category === 'announcements') announcementState(true);
    source.onended = () => { if (current?.source === source) { current = null; announcementState(false); } source.disconnect(); gain.disconnect(); drain(); };
    source.start();
  };
  if (id && navigator.locks && soundEvents[event].scope === 'shared') await navigator.locks.request('hive:sound-playback-v2', play).catch(() => {});
  else play();
}
function dispatch(event: SoundEvent, id: string | undefined, options: Options = {}) { void perform(event, id, options).catch(() => { if (current?.event === event) stopCurrent(); }); }
export function playSound(event: SoundEvent, _category?: SoundCategory, id?: string, preview = false) { dispatch(event, id, { preview }); }
export function previewSound(event: SoundEvent, value = preferences.volume) { unlockSounds(); dispatch(event, undefined, { preview: true, volume: value }); }
export function announceSound(event: SoundEvent, id: string) { dispatch(event, id, { mandatory: true }); }
export function playMessageSound(id?: string) { playSound('incoming', 'messages', id); }
export function startRing(id = crypto.randomUUID(), outgoing = false, expires = Date.now() + 30000) {
  if (ring?.id === id) return;
  stopRing(); const event = outgoing ? 'outgoing' : 'invitation';
  if (!allowed(event, {}) || expires <= Date.now()) return;
  const tick = () => {
    if (!ring || ring.id !== id || Date.now() >= expires) { stopRing(id); return; }
    dispatch(event, `${id}:${Math.floor(Date.now() / 4000)}`, { ringId: id });
  };
  ring = { id, event, expires, timer: setInterval(tick, 4000), expiryTimer: setTimeout(() => stopRing(id), Math.max(0, expires - Date.now())) }; tick();
}
export function stopRing(id?: string, broadcast = false) {
  if (broadcast && id) bus?.postMessage({ resolved: id, userId: currentUserId() });
  if (id && ring?.id !== id) return;
  if (ring) { clearInterval(ring.timer); clearTimeout(ring.expiryTimer); }
  ring = null;
  if (current && (current.event === 'invitation' || current.event === 'outgoing')) { stopCurrent(); drain(); }
}
export function stopHuddleAudio() { stopRing(); generation++; pending.length = 0; if (current && soundEvents[current.event].category === 'announcements') stopCurrent(); }
export function resetAudio() { stopRing(); generation++; pending.length = 0; seen.clear(); stopCurrent(); preferences = normalizeSoundPreferences(defaultSoundPreferences); suppressed = true; }

let activeConversation: string | null = null;
export function setAudioConversation(channelId: string | null) { activeConversation = channelId; }
export function conversationAudible(channelId?: string | null) { return !channelId || channelId !== activeConversation || document.hidden; }
