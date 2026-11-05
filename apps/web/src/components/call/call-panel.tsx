'use client';

import { useEffect, useState } from 'react';
import { calls } from '../../lib/call';
import { useCall } from '../../lib/use-call';
import { VideoTile } from './video-tile';

/** The active call: a grid of 1–6 tiles (a shared screen gets a large tile) and the controls. */
export function CallPanel({ title, username }: { title: string; username: string }) {
  const call = useCall();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [picker, setPicker] = useState(false);
  const [canShare, setCanShare] = useState(false);

  useEffect(() => { setCanShare(!!navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices); }, []);
  useEffect(() => {
    if (!picker) return;
    navigator.mediaDevices.enumerateDevices()
      .then(list => setDevices(list.filter(item => item.kind === 'audioinput'))).catch(() => {});
  }, [picker]);

  if (call.status === 'idle') return null;
  const sharing = call.peers.find(peer => peer.screen);
  const count = call.peers.length + 1;
  const columns = count === 1 ? 'grid-cols-1' : count <= 4 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-2 sm:grid-cols-3';
  const control = 'rounded-full px-3 py-2 text-sm font-semibold focus-visible:outline focus-visible:outline-amber-400';

  return <section aria-label={`Call in ${title}`} className="rounded-xl border border-white/10 bg-[#0e1016] p-3">
    <div className="mb-2 flex items-center justify-between gap-2 text-sm">
      <h2 className="truncate font-semibold">🔊 {title}</h2>
      <span className="shrink-0 text-xs text-white/50">{call.status === 'joining' ? 'Connecting…' : `${count} in call`}</span>
    </div>
    {call.error && <p role="alert" className="mb-2 text-xs text-amber-400">{call.error}</p>}
    <div className={`grid gap-2 ${columns}`}>
      {sharing && <VideoTile key={`${sharing.sid}-screen`} stream={sharing.stream} name={`${sharing.username} (screen)`}
        muted={sharing.muted} speaking={sharing.speaking} video large />}
      <VideoTile stream={call.localStream} name={username} muted={call.muted} speaking={call.speaking}
        video={call.camera || call.screen} self />
      {call.peers.filter(peer => peer !== sharing).map(peer => <VideoTile key={peer.sid} stream={peer.stream}
        name={peer.username} muted={peer.muted} speaking={peer.speaking} video={peer.camera || peer.screen} />)}
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
      <button type="button" onClick={() => calls.toggleMute()} aria-pressed={call.muted}
        className={`${control} ${call.muted ? 'bg-rose-500/20 text-rose-300' : 'bg-white/10'}`}>{call.muted ? '🔇 Unmute' : '🎙 Mute'}</button>
      <button type="button" onClick={() => void calls.toggleCamera()} aria-pressed={call.camera}
        className={`${control} ${call.camera ? 'bg-amber-400 text-black' : 'bg-white/10'}`}>{call.camera ? '📷 Camera off' : '📷 Camera'}</button>
      {canShare && <button type="button" onClick={() => void calls.toggleScreen()} aria-pressed={call.screen}
        className={`${control} ${call.screen ? 'bg-amber-400 text-black' : 'bg-white/10'}`}>🖥 {call.screen ? 'Stop sharing' : 'Share screen'}</button>}
      <div className="relative">
        <button type="button" onClick={() => setPicker(value => !value)} aria-expanded={picker} className={`${control} bg-white/10`}>⚙ Mic</button>
        {picker && <ul role="menu" className="absolute bottom-full left-0 z-30 mb-1 w-64 rounded-md border border-white/15 bg-[#151821] py-1 text-sm shadow-xl">
          {devices.map(device => <li key={device.deviceId}><button type="button" role="menuitem"
            className="w-full truncate px-3 py-1.5 text-left hover:bg-white/10"
            onClick={() => { void calls.useMicrophone(device.deviceId); setPicker(false); }}>{device.label || 'Microphone'}</button></li>)}
          {!devices.length && <li className="px-3 py-1.5 text-white/50">No microphones found</li>}
        </ul>}
      </div>
      <button type="button" onClick={() => void calls.leave()} className={`${control} bg-rose-600 text-white`}>Leave</button>
    </div>
  </section>;
}
