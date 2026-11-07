'use client';

/*
 * Notification sounds made with the Web Audio API, so there are no audio files to load.
 * Browsers only allow sound after the person has interacted with the page, so the audio
 * context is created (or resumed) on the first click or key press.
 */
const KEY = 'hive:sounds';
let context: AudioContext | null = null;
let ringTimer: ReturnType<typeof setInterval> | null = null;
let lastMessage = 0;

export function soundsEnabled() {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
}

export function setSoundsEnabled(on: boolean) {
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* the choice still applies until reload */ }
  if (!on) stopRing();
}

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!context) {
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return null;
    context = new Context();
  }
  if (context.state === 'suspended') void context.resume().catch(() => {});
  return context;
}

if (typeof window !== 'undefined') {
  const unlock = () => { audio(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

function tone(ctx: AudioContext, frequency: number, start: number, length: number, volume = 0.18) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(volume, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + length + 0.05);
}

/** A short two-note chime for a new message. Rapid bursts play once. */
export function playMessageSound() {
  if (!soundsEnabled() || Date.now() - lastMessage < 1500) return;
  const ctx = audio();
  if (!ctx || ctx.state !== 'running') return;
  lastMessage = Date.now();
  const now = ctx.currentTime;
  tone(ctx, 880, now, 0.18);
  tone(ctx, 1320, now + 0.11, 0.28);
}

/** Repeats a ringtone until stopRing() is called (or 30 seconds pass). */
export function startRing() {
  if (!soundsEnabled() || ringTimer) return;
  const ring = () => {
    const ctx = audio();
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    for (const offset of [0, 0.25]) { tone(ctx, 660, now + offset, 0.2, 0.22); tone(ctx, 990, now + offset, 0.2, 0.12); }
  };
  ring();
  ringTimer = setInterval(ring, 2000);
  setTimeout(stopRing, 30000);
}

export function stopRing() {
  if (ringTimer) clearInterval(ringTimer);
  ringTimer = null;
}
