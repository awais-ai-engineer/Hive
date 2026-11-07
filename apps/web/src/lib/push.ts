'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiData } from './spaces';
import { apiFetch } from './api';

/** Installing the app and browser push notifications. */

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let installEvent: InstallEvent | null = null;
const installListeners = new Set<() => void>();

// Captured at module load: the browser can fire this before any menu has been rendered.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installEvent = event as InstallEvent;
    installListeners.forEach(listener => listener());
  });
  window.addEventListener('appinstalled', () => {
    installEvent = null;
    installListeners.forEach(listener => listener());
  });
}

/** `install` is set only while the browser offers to install Hive. */
export function useInstall() {
  const [available, setAvailable] = useState(!!installEvent);
  useEffect(() => {
    const update = () => setAvailable(!!installEvent);
    installListeners.add(update); update();
    return () => { installListeners.delete(update); };
  }, []);
  const install = useCallback(async () => {
    const event = installEvent;
    if (!event) return;
    installEvent = null; installListeners.forEach(listener => listener());
    await event.prompt();
  }, []);
  return available ? install : null;
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

export const pushSupported = () =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

async function currentSubscription() {
  const registration = await navigator.serviceWorker.getRegistration('/');
  return registration ? registration.pushManager.getSubscription() : null;
}

export type PushState = 'loading' | 'unsupported' | 'unavailable' | 'blocked' | 'off' | 'on';

/** Whether this device gets push notifications, and the switch to change it. */
export function usePush() {
  const [state, setState] = useState<PushState>('loading');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!pushSupported()) return setState('unsupported');
    try {
      const config = await apiData<{ enabled: boolean }>('/api/push/config');
      if (!config.enabled) return setState('unavailable');
      if (Notification.permission === 'denied') return setState('blocked');
      setState(await currentSubscription() ? 'on' : 'off');
    } catch { setState('off'); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const enable = useCallback(async () => {
    setError('');
    try {
      const config = await apiData<{ enabled: boolean; publicKey: string | null }>('/api/push/config');
      if (!config.enabled || !config.publicKey) throw new Error('Push notifications are not set up on this server.');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { setState(permission === 'denied' ? 'blocked' : 'off'); return; }
      const registration = await registerServiceWorker();
      if (!registration) throw new Error('This browser cannot run background notifications.');
      await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: keyBytes(config.publicKey) as BufferSource,
      });
      await apiData('/api/push/subscriptions', { method: 'POST', body: JSON.stringify({ ...subscription.toJSON(), userAgent: navigator.userAgent.slice(0, 200) }) });
      setState('on');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not turn on notifications.');
      void refresh();
    }
  }, [refresh]);

  const disable = useCallback(async () => {
    setError('');
    try { await unsubscribeThisDevice(); setState('off'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not turn off notifications.'); }
  }, []);

  return { state, error, enable, disable };
}

/** Stop pushes to this browser (used by the switch and when logging out, so the next person doesn't get them). */
export async function unsubscribeThisDevice() {
  if (!pushSupported()) return;
  const subscription = await currentSubscription();
  if (!subscription) return;
  await apiFetch('/api/push/subscriptions', { method: 'DELETE', body: JSON.stringify({ endpoint: subscription.endpoint }) }).catch(() => {});
  await subscription.unsubscribe();
}
