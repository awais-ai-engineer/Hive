'use client';

import { useEffect, useState } from 'react';
import { calls } from '../../lib/call';
import { useCall } from '../../lib/use-call';
import { useAuth } from '../../lib/auth';
import { Icon } from '../ui/icons';
import { VideoTile } from './video-tile';

/** Floating participant tiles for the active call. Stays on screen while you move around /home. */
export function CallStage() {
  const call = useCall();
  const { user } = useAuth();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const open = call.stageOpen && call.status !== 'idle';

  useEffect(() => {
    if (!open || !navigator.mediaDevices?.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices()
      .then(list => setDevices(list.filter(item => item.kind === 'audioinput'))).catch(() => {});
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') calls.setStageOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  const sharing = call.peers.find(peer => peer.screen);
  const count = call.peers.length + 1;
  const columns = count <= 2 ? 'grid-cols-1 min-[420px]:grid-cols-2' : 'grid-cols-2';
  return <section aria-label={`Huddle in ${call.title}`}
    className="card on-surface animate-in fixed inset-x-3 bottom-3 z-40 max-h-[70dvh] overflow-y-auto p-3 sm:left-auto sm:right-4 sm:w-[420px]">
    <div className="mb-2 flex items-center justify-between gap-2">
      <h2 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold"><Icon name="headphones" size={16} className="shrink-0 text-brand" /><span className="truncate">{call.title}</span></h2>
      <button type="button" onClick={() => calls.setStageOpen(false)} aria-label="Hide participants" title="Hide participants (Esc)"
        className="rounded-lg p-1 text-white/60 hover:bg-[var(--surface-2)] hover:text-white"><Icon name="x" size={16} /></button>
    </div>
    <div className={`grid gap-2 ${columns}`}>
      {sharing && <VideoTile key={`${sharing.sid}-screen`} stream={sharing.stream} name={`${sharing.username} (screen)`}
        avatarUrl={sharing.avatarUrl} muted={sharing.muted} speaking={sharing.speaking} video large />}
      <VideoTile stream={call.localStream} name={user?.username ?? 'You'} avatarUrl={user?.avatar_url} muted={call.muted}
        speaking={call.speaking} video={call.camera || call.screen} self />
      {call.peers.filter(peer => peer !== sharing).map(peer => <VideoTile key={peer.sid} stream={peer.stream} name={peer.username}
        avatarUrl={peer.avatarUrl} muted={peer.muted} speaking={peer.speaking} video={peer.camera || peer.screen} />)}
    </div>
    {devices.length > 1 && <label className="mt-3 block text-xs text-white/60">Microphone
      <select className="auth-input !mt-1 !py-1.5 text-sm" defaultValue="" onChange={event => event.target.value && void calls.useMicrophone(event.target.value)}>
        <option value="" disabled>Choose a microphone</option>
        {devices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label || 'Microphone'}</option>)}
      </select>
    </label>}
  </section>;
}
