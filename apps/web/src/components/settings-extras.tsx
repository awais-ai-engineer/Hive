'use client';

import { Button as UiButton, TimePicker as UiTimePicker, confirmAction as UiConfirm } from '@hive/ui';

import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { usePush } from '../lib/push';
import type { DeviceRow } from '../lib/secret';
import { apiData, requestError } from '../lib/spaces';

type Quiet = { quietStart: number | null; quietEnd: number | null; timezone: string | null };
const toTime = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const toMinutes = (value: string) => { const [h, m] = value.split(':').map(Number); return h * 60 + m; };

function Switch({ on, label, onClick, disabled }: { on: boolean; label: string; onClick: () => void; disabled?: boolean }) {
  return <UiButton tooltip={label} type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onClick}
    className={`relative mt-1 h-6 w-11 shrink-0 rounded-full transition disabled:opacity-40 ${on ? 'bg-brand' : 'bg-white/20'}`}>
    <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-[var(--rail-fg)] shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} /></UiButton>;
}

/** Browser notifications for this device, with optional quiet hours. */
export function PushCard() {
  const push = usePush();
  const [quiet, setQuiet] = useState<Quiet | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => { apiData<Quiet>('/api/push/settings').then(setQuiet).catch(cause => setError(requestError(cause))); }, []);

  async function saveQuiet(next: Quiet) {
    setError(''); setQuiet(next);
    try { setQuiet(await apiData<Quiet>('/api/push/settings', { method: 'PUT', body: JSON.stringify(next) })); }
    catch (cause) { setError(requestError(cause)); }
  }
  async function sendTest() {
    setError(''); setNote('');
    try { await apiData('/api/push/test', { method: 'POST' }); setNote('Sent. It should appear in a moment.'); }
    catch (cause) { setError(requestError(cause)); }
  }
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const quietOn = quiet?.quietStart != null && quiet?.quietEnd != null;
  const messages: Partial<Record<typeof push.state, string>> = {
    unsupported: 'This browser can’t show notifications from Hive. Try a recent Chrome, Edge, Firefox or Safari (on iPhone, install Hive to your Home Screen first).',
    unavailable: 'Push notifications are not switched on for this Hive server.',
    blocked: 'Notifications are blocked for this site. Allow them in your browser’s site settings, then come back.',
  };
  return <section className="card mt-5 p-5 sm:p-6">
    <h2 className="text-lg font-bold">Push notifications</h2>
    <p className="mt-1 text-sm text-white/60">Get a notification on this device when something needs you and Hive isn’t open. Messages in secret conversations only say “New secret message”.</p>
    <div className="mt-3 flex items-start justify-between gap-4">
      <div><p id="push-label" className="font-medium">Push notifications on this device</p>
        <p className="text-sm text-white/60">{messages[push.state] ?? (push.state === 'on' ? 'On for this browser.' : 'Off for this browser.')}</p></div>
      <Switch on={push.state === 'on'} label="Push notifications on this device" disabled={push.state !== 'on' && push.state !== 'off'}
        onClick={() => void (push.state === 'on' ? push.disable() : push.enable())} />
    </div>
    {push.state === 'on' && <div className="mt-2"><UiButton type="button" className="btn-ghost" onClick={() => void sendTest()}>Send a test notification</UiButton> <span role="status" className="text-sm text-emerald-500">{note}</span></div>}
    <div className="mt-5 border-t border-white/10 pt-4">
      <div className="flex items-start justify-between gap-4">
        <div><p className="font-medium">Quiet hours</p><p className="text-sm text-white/60">No push notifications during these hours. They still wait in your inbox.</p></div>
        <Switch on={quietOn} label="Quiet hours" disabled={!quiet}
          onClick={() => void saveQuiet(quietOn ? { quietStart: null, quietEnd: null, timezone: null } : { quietStart: 22 * 60, quietEnd: 7 * 60, timezone: zone })} />
      </div>
      {quiet && quietOn && <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <label>From <UiTimePicker label="From" className="auth-input !w-auto" value={toTime(quiet.quietStart!)} onChange={event => event.target.value && void saveQuiet({ ...quiet, quietStart: toMinutes(event.target.value), timezone: zone })} /></label>
        <label>Until <UiTimePicker label="Until" className="auth-input !w-auto" value={toTime(quiet.quietEnd!)} onChange={event => event.target.value && void saveQuiet({ ...quiet, quietEnd: toMinutes(event.target.value), timezone: zone })} /></label>
        <span className="text-white/50">Time zone: {quiet.timezone ?? zone}</span>
      </div>}
    </div>
    {(error || push.error) && <p role="alert" className="mt-3 text-sm text-rose-500">{error || push.error}</p>}
  </section>;
}

/** The devices that can read your secret conversations. */
export function DevicesCard() {
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { apiData<DeviceRow[]>('/api/me/devices').then(setDevices).catch(cause => setError(requestError(cause))); }, []);
  async function remove(device: DeviceRow) {
    if (!await UiConfirm(`Remove ${device.label || 'this device'}? It will no longer be able to read new secret messages.`)) return;
    try {
      const response = await apiFetch(`/api/me/devices/${device.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Could not remove the device. Please try again.');
      setDevices(list => list?.filter(item => item.id !== device.id) ?? null);
    } catch (cause) { setError(requestError(cause)); }
  }
  return <section className="card mt-5 p-5 sm:p-6">
    <h2 className="text-lg font-bold">Secret conversation devices</h2>
    <p className="mt-1 text-sm text-white/60">Secret conversations are encrypted on your devices. Each browser you use has its own key and can only read messages sent after it was set up. Remove devices you no longer use.</p>
    {error && <p role="alert" className="mt-2 text-sm text-rose-500">{error}</p>}
    {devices === null ? !error && <p className="mt-3 text-sm text-white/60">Loading…</p>
      : devices.length === 0 ? <p className="mt-3 text-sm text-white/60">No device has been set up yet. One is added the first time you open a secret conversation.</p>
        : <ul className="mt-3 divide-y divide-white/10">{devices.map(device => <li key={device.id} className="flex items-center gap-3 py-3">
          <div className="min-w-0 flex-1"><p className="truncate font-medium">{device.label || 'Browser'}</p><p className="text-xs text-white/50">Added {new Date(device.createdAt).toLocaleDateString()}</p></div>
          <UiButton type="button" className="btn-ghost text-rose-500" onClick={() => void remove(device)}>Remove</UiButton>
        </li>)}</ul>}
  </section>;
}
