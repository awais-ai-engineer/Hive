'use client';

import { useEffect, useRef, useState } from 'react';
import { calls } from '../../lib/call';
import { useCall } from '../../lib/use-call';
import { useAuth } from '../../lib/auth';
import { Avatar } from '../ui/avatar';
import { Icon, type IconName } from '../ui/icons';
import { useCallTimer } from './call-timer';

// The huddle window always uses a dark surface, like other meeting apps, in both themes.
const WHITE = { color: '#fff' };

type Tile = {
  key: string; name: string; avatarUrl?: string | null; stream: MediaStream | null;
  video: boolean; muted: boolean; speaking: boolean; mirror?: boolean; label?: string;
};

function TileView({ tile, big = false }: { tile: Tile; big?: boolean }) {
  const element = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (element.current && element.current.srcObject !== tile.stream) element.current.srcObject = tile.stream;
  }, [tile.stream]);
  const talking = tile.speaking && !tile.muted;
  return <figure aria-label={`${tile.label ?? tile.name}${tile.muted ? ', muted' : talking ? ', speaking' : ''}`}
    className={`relative flex min-h-0 items-center justify-center overflow-hidden rounded-2xl bg-[#26222f] transition-shadow ${big ? 'h-full w-full' : 'aspect-video w-full'} ${talking ? 'shadow-[0_0_0_3px_#22c55e]' : 'shadow-[0_0_0_1px_rgb(255_255_255/0.06)]'}`}>
    {/* Sound plays from the call dock so it continues while this window is closed. */}
    <video ref={element} autoPlay playsInline muted
      className={`h-full w-full ${big ? 'object-contain' : 'object-cover'} ${tile.video ? '' : 'hidden'}`}
      style={tile.mirror ? { transform: 'scaleX(-1)' } : undefined} />
    {!tile.video && <span className={`rounded-full ${talking ? 'shadow-[0_0_0_4px_rgb(34_197_94/0.5)]' : ''}`}>
      <Avatar name={tile.name} src={tile.avatarUrl} size={big ? 96 : 64} /></span>}
    <figcaption className="absolute bottom-2 left-2 flex max-w-[85%] items-center gap-1.5 rounded-lg bg-[rgb(0_0_0/0.55)] px-2 py-1 text-xs font-medium backdrop-blur" style={WHITE}>
      {tile.muted && <Icon name="micOff" size={12} className="shrink-0 text-rose-300" aria-label="Muted" />}
      <span className="truncate">{tile.label ?? tile.name}</span>
    </figcaption>
  </figure>;
}

export function RoundControl({ icon, label, active, warn, onClick, size = 'lg' }: {
  icon: IconName; label: string; active?: boolean; warn?: boolean; onClick: () => void; size?: 'sm' | 'lg';
}) {
  const box = size === 'lg' ? 'h-11 w-11' : 'h-8 w-8';
  const tone = warn ? 'bg-rose-500/90 hover:bg-rose-500' : active ? 'bg-emerald-500 hover:bg-emerald-400' : 'bg-[rgb(255_255_255/0.12)] hover:bg-[rgb(255_255_255/0.2)]';
  return <button type="button" onClick={onClick} aria-label={label} title={label} aria-pressed={active ?? warn}
    className={`flex ${box} shrink-0 items-center justify-center rounded-full transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#fff] ${tone}`} style={WHITE}>
    <Icon name={icon} size={size === 'lg' ? 20 : 16} />
  </button>;
}

/** The huddle window: video tiles, screen share and call controls. Floating, or full screen. */
export function CallStage() {
  const call = useCall();
  const { user } = useAuth();
  const [full, setFull] = useState(false);
  const [settings, setSettings] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const timer = useCallTimer(call.status === 'connected');
  const open = call.stageOpen && call.status !== 'idle';

  useEffect(() => {
    if (!settings || !navigator.mediaDevices?.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices()
      .then(list => setDevices(list.filter(item => item.kind === 'audioinput'))).catch(() => {});
  }, [settings]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (settings) setSettings(false); else if (full) setFull(false); else calls.setStageOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, full, settings]);
  useEffect(() => { if (!open) { setFull(false); setSettings(false); } }, [open]);

  if (!open) return null;
  const canShare = typeof navigator !== 'undefined' && !!navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices;
  const me: Tile = {
    key: 'me', name: user?.username ?? 'You', avatarUrl: user?.avatar_url, stream: call.localStream,
    video: call.camera || call.screen, muted: call.muted, speaking: call.speaking, mirror: call.camera && !call.screen,
    label: `${user?.username ?? 'You'} (you)`,
  };
  const others: Tile[] = call.peers.map(peer => ({
    key: peer.sid, name: peer.username, avatarUrl: peer.avatarUrl, stream: peer.stream,
    video: peer.camera || peer.screen, muted: peer.muted, speaking: peer.speaking,
  }));
  const sharer = call.peers.find(peer => peer.screen);
  const sharerTile = sharer ? others.find(tile => tile.key === sharer.sid) : undefined;
  const stage: Tile | null = sharerTile
    ? { ...sharerTile, key: `${sharerTile.key}-screen`, label: `${sharerTile.name} is sharing their screen` }
    : call.screen ? { ...me, key: 'me-screen', mirror: false, label: 'You are sharing your screen' } : null;
  const shownKey = sharerTile ? sharerTile.key : call.screen ? 'me' : null;
  const strip = [me, ...others].filter(tile => tile.key !== shownKey);
  const count = call.peers.length + 1;
  const columns = count === 1 ? 'grid-cols-1' : count <= 4 ? 'grid-cols-2' : 'grid-cols-3';

  return <div className={`fixed inset-0 z-50 flex items-center justify-center ${full ? '' : 'bg-[rgb(8_6_14/0.62)] p-3 backdrop-blur-sm sm:p-6'}`}
    onMouseDown={event => { if (event.target === event.currentTarget) calls.setStageOpen(false); }}>
  <section aria-label={`Huddle in ${call.title}`} role="dialog" aria-modal
    className={`animate-in flex flex-col overflow-hidden bg-[#16131c] ${full
      ? 'h-full w-full'
      : 'h-[min(86dvh,760px)] w-[min(1100px,100%)] rounded-3xl shadow-[0_0_0_1.5px_rgb(139_92_246/0.75),0_0_40px_6px_rgb(124_58_237/0.45),0_30px_80px_rgb(0_0_0/0.55)]'}`}
    style={WHITE}>
    <header className="flex items-center gap-3 border-b border-[rgb(255_255_255/0.08)] px-4 py-3">
      <span className="relative flex h-2.5 w-2.5 shrink-0"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" /></span>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-semibold">{call.status === 'joining' ? 'Connecting…' : `Huddle in ${call.title}`}</h2>
        <p className="text-xs" style={{ color: 'rgb(255 255 255 / 0.6)' }}>{count} {count === 1 ? 'person' : 'people'}{timer ? ` · ${timer}` : ''}</p>
      </div>
      <RoundControl size="sm" icon={full ? 'shrink' : 'expand'} label={full ? 'Exit full screen' : 'Full screen'} onClick={() => setFull(value => !value)} />
      <RoundControl size="sm" icon="x" label="Minimise (the huddle keeps going)" onClick={() => calls.setStageOpen(false)} />
    </header>

    <div className="min-h-0 flex-1 p-3">
      {stage ? <div className="flex h-full flex-col gap-3 md:flex-row">
        <div className="min-h-0 flex-1"><TileView tile={stage} big /></div>
        {strip.length > 0 && <div className="flex h-24 shrink-0 flex-row gap-2 overflow-auto [&>figure]:w-40 [&>figure]:shrink-0 md:h-auto md:w-56 md:flex-col md:[&>figure]:w-full">
          {strip.map(tile => <TileView key={tile.key} tile={tile} />)}
        </div>}
      </div> : <div className={`grid h-full content-center gap-3 overflow-auto ${columns} ${count === 1 ? 'mx-auto w-full max-w-xl' : ''}`}>
        {[me, ...others].map(tile => <TileView key={tile.key} tile={tile} />)}
      </div>}
    </div>

    {call.error && <p role="alert" className="mx-4 mb-2 rounded-lg bg-rose-500/15 px-3 py-2 text-sm text-rose-200">{call.error}</p>}
    <footer className="relative flex items-center justify-center gap-2 border-t border-[rgb(255_255_255/0.08)] px-4 py-3">
      <RoundControl icon={call.muted ? 'micOff' : 'mic'} label={call.muted ? 'Unmute microphone' : 'Mute microphone'} warn={call.muted} onClick={() => calls.toggleMute()} />
      <RoundControl icon={call.camera ? 'video' : 'videoOff'} label={call.camera ? 'Turn camera off' : 'Turn camera on'} active={call.camera} onClick={() => void calls.toggleCamera()} />
      {canShare && <RoundControl icon="screen" label={call.screen ? 'Stop sharing your screen' : 'Share your screen'} active={call.screen} onClick={() => void calls.toggleScreen()} />}
      <RoundControl icon="settings" label="Audio settings" active={settings} onClick={() => setSettings(value => !value)} />
      <button type="button" onClick={() => void calls.leave()}
        className="ml-2 flex h-11 items-center gap-2 rounded-full bg-rose-600 px-5 text-sm font-semibold transition hover:bg-rose-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#fff]" style={WHITE}>
        <Icon name="phoneOff" size={18} />Leave
      </button>
      {settings && <div className="absolute bottom-full left-1/2 mb-2 w-72 -translate-x-1/2 rounded-xl bg-[#26222f] p-3 shadow-xl">
        <label className="block text-xs font-medium" style={{ color: 'rgb(255 255 255 / 0.7)' }}>Microphone
          <select className="mt-1 w-full rounded-lg border border-[rgb(255_255_255/0.15)] bg-[#16131c] px-2 py-2 text-sm" style={WHITE}
            defaultValue="" onChange={event => { if (event.target.value) void calls.useMicrophone(event.target.value); }}>
            <option value="" disabled>{devices.length ? 'Choose a microphone' : 'Looking for microphones…'}</option>
            {devices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label || 'Microphone'}</option>)}
          </select>
        </label>
      </div>}
    </footer>
  </section>
  </div>;
}
