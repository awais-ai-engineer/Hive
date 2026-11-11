'use client';

import { Tooltip as UiTooltip } from '@hive/ui';

import { Button as UiButton, Select as UiSelect } from '@hive/ui';

import { useEffect, useRef, useState } from 'react';
import { useT } from '../../lib/i18n';
import { calls, captionsSupported, REACTIONS, type Reaction } from '../../lib/call';
import { useCall } from '../../lib/use-call';
import { useAuth } from '../../lib/auth';
import { socket } from '../../lib/socket';
import { Avatar } from '../ui/avatar';
import { Icon, type IconName } from '../ui/icons';
import { useCallTimer } from './call-timer';

// The huddle window always uses a dark surface, like other meeting apps, in both themes.
const WHITE = { color: 'var(--rail-fg)' };
const MUTED_TEXT = { color: 'rgb(255 255 255 / 0.6)' };

type Tile = {
  key: string; name: string; avatarUrl?: string | null; stream: MediaStream | null;
  video: boolean; muted: boolean; speaking: boolean; mirror?: boolean; label?: string;
  hand?: boolean; state?: string;
};

function TileView({ tile, big = false, reactions = [] }: { tile: Tile; big?: boolean; reactions?: Reaction[] }) {
  const element = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (element.current && element.current.srcObject !== tile.stream) element.current.srcObject = tile.stream;
  }, [tile.stream]);
  const talking = tile.speaking && !tile.muted;
  return <figure aria-label={`${tile.label ?? tile.name}${tile.hand ? ', hand raised' : ''}${tile.muted ? ', muted' : talking ? ', speaking' : ''}`}
    className={`relative flex min-h-0 items-center justify-center overflow-hidden rounded-2xl bg-[var(--call-panel)] transition-shadow ${big ? 'h-full w-full' : 'aspect-video w-full'} ${talking ? 'shadow-[0_0_0_2px_var(--brand)]' : 'shadow-[0_0_0_1px_rgb(255_255_255/0.06)]'}`}>
    {/* Sound plays from the call dock so it continues while this window is closed. */}
    <video ref={element} autoPlay playsInline muted
      className={`h-full w-full ${big ? 'object-contain' : 'object-cover'} ${tile.video ? '' : 'hidden'}`}
      style={tile.mirror ? { transform: 'scaleX(-1)' } : undefined} />
    {!tile.video && <span className={`rounded-full ${talking ? 'shadow-[0_0_0_4px_rgb(242_165_22/0.45)]' : ''}`}>
      <Avatar name={tile.name} src={tile.avatarUrl} size={big ? 96 : 60} /></span>}
    {(tile.state || tile.hand) && <span className={`absolute right-2 top-2 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${tile.hand ? 'bg-[var(--brand)] text-[var(--rail)]' : 'bg-[rgb(0_0_0/0.55)]'}`}
      style={tile.hand ? undefined : WHITE}>{tile.hand ? '✋ Hand raised' : tile.state}</span>}
    <figcaption className="absolute bottom-2 left-2 flex max-w-[85%] items-center gap-1.5 rounded-lg bg-[rgb(0_0_0/0.55)] px-2 py-1 text-xs font-medium backdrop-blur" style={WHITE}>
      {tile.muted && <Icon name="micOff" size={12} className="shrink-0 text-rose-300" aria-label="Muted" />}
      <span className="truncate">{tile.label ?? tile.name}</span>
    </figcaption>
    {reactions.map((reaction, index) => <span key={reaction.id} aria-hidden className="pointer-events-none absolute bottom-10 text-3xl motion-safe:animate-bounce"
      style={{ left: `${20 + ((index * 23) % 60)}%` }}>{reaction.emoji}</span>)}
  </figure>;
}

export function RoundControl({ icon, label, active, warn, onClick, size = 'lg', caption }: {
  icon: IconName; label: string; active?: boolean; warn?: boolean; onClick: () => void; size?: 'sm' | 'lg'; caption?: string;
}) {
  const box = size === 'lg' ? 'h-11 w-11' : 'h-8 w-8';
  const tone = warn ? 'bg-rose-500/90 hover:bg-rose-500' : active ? 'bg-[var(--brand)] hover:bg-[var(--brand-strong)]' : 'bg-[rgb(255_255_255/0.12)] hover:bg-[rgb(255_255_255/0.2)]';
  const button = <UiButton type="button" onClick={onClick} aria-label={label} tooltip={label} aria-pressed={active ?? warn}
    className={`flex ${box} shrink-0 items-center justify-center rounded-full transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--rail-fg)] ${tone}`}
    style={{ color: active && !warn ? 'var(--rail)' : 'var(--rail-fg)' }}>
    <Icon name={icon} size={size === 'lg' ? 20 : 16} />
  </UiButton>;
  if (!caption) return button;
  return <div className="flex w-14 flex-col items-center gap-1">{button}<span className="text-[11px] font-medium" style={MUTED_TEXT}>{caption}</span></div>;
}

/** The huddle: video tiles, screen share, reactions, captions and controls. Centred window or full screen. */
export function CallStage() {
  const call = useCall();
  const { user } = useAuth();
  const { t } = useT();
  const [full, setFull] = useState(false);
  const [menu, setMenu] = useState<'settings' | 'react' | null>(null);
  const [panel, setPanel] = useState<'people' | 'captions'>('people');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const timer = useCallTimer(call.status === 'connected');
  const open = call.stageOpen && call.status !== 'idle';

  useEffect(() => {
    if (menu !== 'settings' || !navigator.mediaDevices?.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices()
      .then(list => setDevices(list.filter(item => item.kind === 'audioinput'))).catch(() => {});
  }, [menu]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (menu) setMenu(null); else if (full) setFull(false); else calls.setStageOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, full, menu]);
  useEffect(() => { if (!open) { setFull(false); setMenu(null); } }, [open]);

  if (!open) return null;
  const me = socket.id ?? 'me';
  const canShare = typeof navigator !== 'undefined' && !!navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices;
  const reactionsFor = (sid: string) => call.reactions.filter(reaction => reaction.sid === sid || (sid === me && reaction.sid === 'me'));
  const stateOf = (screen: boolean, camera: boolean, speaking: boolean, muted: boolean) =>
    screen ? 'Sharing' : speaking && !muted ? 'Speaking' : !camera ? 'Camera off' : undefined;
  const mine: Tile = {
    key: me, name: user?.username ?? 'You', avatarUrl: user?.avatar_url, stream: call.localStream,
    video: call.camera || call.screen, muted: call.muted, speaking: call.speaking, mirror: call.camera && !call.screen,
    label: `${user?.username ?? 'You'} (you)`, hand: call.hand, state: stateOf(call.screen, call.camera, call.speaking, call.muted),
  };
  const others: Tile[] = call.peers.map(peer => ({
    key: peer.sid, name: peer.username, avatarUrl: peer.avatarUrl, stream: peer.stream,
    video: peer.camera || peer.screen, muted: peer.muted, speaking: peer.speaking, hand: peer.hand,
    state: stateOf(peer.screen, peer.camera, peer.speaking, peer.muted),
  }));
  const sharer = call.peers.find(peer => peer.screen);
  const sharerTile = sharer ? others.find(tile => tile.key === sharer.sid) : undefined;
  const stage: Tile | null = sharerTile ? { ...sharerTile, key: `${sharerTile.key}-screen`, label: `${sharerTile.name} is sharing their screen`, state: undefined, hand: false }
    : call.screen ? { ...mine, key: 'me-screen', mirror: false, label: 'You are sharing your screen', state: undefined, hand: false } : null;
  const shownKey = sharerTile ? sharerTile.key : call.screen ? me : null;
  const tiles = [mine, ...others];
  const strip = tiles.filter(tile => tile.key !== shownKey);
  const count = call.peers.length + 1;
  const columns = count === 1 ? 'grid-cols-1' : count <= 4 ? 'grid-cols-2' : 'grid-cols-3';
  const latest = [...call.captions].reverse().find(caption => Date.now() - Number(caption.id.split('-').at(-1)) < 12000 || !caption.final);
  const raised = tiles.filter(tile => tile.hand);

  const sidePanel = <aside aria-label="Huddle details" className="hidden w-80 shrink-0 flex-col border-l border-[rgb(255_255_255/0.08)] lg:flex">
    <div role="tablist" className="flex gap-1 border-b border-[rgb(255_255_255/0.08)] px-3 pt-2 text-sm">
      {([['people', `People · ${count}`], ['captions', 'Notes']] as const).map(([value, label]) => <UiButton key={value} type="button" role="tab" aria-selected={panel === value}
        onClick={() => setPanel(value)} className={`-mb-px border-b-2 px-3 py-2 font-medium ${panel === value ? 'border-[var(--brand)]' : 'border-transparent'}`}
        style={panel === value ? WHITE : MUTED_TEXT}>{label}</UiButton>)}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {panel === 'people' ? <ul className="space-y-1">
        {raised.length > 0 && <li className="mb-2 rounded-lg bg-[rgb(242_165_22/0.15)] px-3 py-2 text-xs" style={WHITE}>✋ {raised.map(tile => tile.name).join(', ')} raised a hand</li>}
        {tiles.map(tile => <li key={tile.key} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
          <Avatar name={tile.name} src={tile.avatarUrl} size={28} />
          <span className="min-w-0 flex-1 truncate text-sm">{tile.label ?? tile.name}</span>
          {tile.hand && <UiTooltip content="Hand raised"><span>✋</span></UiTooltip>}
          {tile.video && <Icon name="video" size={14} className="opacity-60" />}
          <Icon name={tile.muted ? 'micOff' : 'mic'} size={14} className={tile.muted ? 'text-rose-300' : 'opacity-60'} />
        </li>)}
      </ul> : !call.captions.length ? <div className="mt-6 text-center text-sm" style={MUTED_TEXT}>
        <p>{captionsSupported() ? 'Notes are built from live captions. Turn captions on to add what you say. When the huddle ends, the notes are saved as a Doc in this conversation for everyone in it.' : 'Notes need live captions, which work in Chrome or Edge on a computer.'}</p>
        {captionsSupported() && !call.captionsOn && <UiButton type="button" onClick={() => calls.toggleCaptions(user?.username ?? 'You')}
          className="mt-3 rounded-lg bg-[var(--brand)] px-3 py-1.5 text-sm font-semibold text-[var(--rail)]">Take notes</UiButton>}
      </div>
        : <ol className="space-y-2 text-sm">{call.captions.map(caption => <li key={caption.id}>
          <span className="font-semibold">{caption.username}: </span><span style={caption.final ? undefined : MUTED_TEXT}>{caption.text}</span></li>)}</ol>}
    </div>
    <p className="border-t border-[rgb(255_255_255/0.08)] p-3 text-xs" style={MUTED_TEXT}>Everyone in this huddle sees captions as they are spoken. Finished lines are saved as meeting notes in this conversation when the huddle ends.</p>
  </aside>;

  return <div className={`fixed inset-0 z-50 flex items-center justify-center ${full ? '' : 'bg-[rgb(8_6_14/0.62)] p-3 backdrop-blur-sm sm:p-6'}`}
    onMouseDown={event => { if (event.target === event.currentTarget) calls.setStageOpen(false); }}>
  <section aria-label={`Huddle in ${call.title}`} role="dialog" aria-modal
    className={`animate-in flex flex-col overflow-hidden bg-[var(--call-surface)] ${full
      ? 'h-full w-full'
      : 'h-[min(88dvh,780px)] w-[min(1200px,100%)] rounded-3xl shadow-[0_0_0_1.5px_rgb(242_165_22/0.7),0_0_40px_6px_rgb(242_165_22/0.3),0_30px_80px_rgb(0_0_0/0.55)]'}`}
    style={WHITE}>
    <header className="flex items-center gap-3 border-b border-[rgb(255_255_255/0.08)] px-4 py-3">
      <UiButton type="button" onClick={() => calls.setStageOpen(false)} aria-label={t('huddle.minimise')} tooltip={t('huddle.minimise')}
        className="rounded-lg p-1.5 hover:bg-[rgb(255_255_255/0.1)]"><Icon name="chevronLeft" size={18} /></UiButton>
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold">{call.status === 'joining' ? 'Connecting…' : call.title}</h2>
        <p className="text-xs" style={MUTED_TEXT}>{t('huddle.people', { count })}</p>
      </div>
      {timer && <span className="flex items-center gap-1.5 rounded-full bg-[rgb(255_255_255/0.1)] px-2.5 py-1 text-xs font-semibold"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />{timer}</span>}
      {(call.captionsOn || call.captions.length > 0) && <span className="hidden items-center gap-1 rounded-full bg-[rgb(242_165_22/0.18)] px-2.5 py-1 text-xs font-semibold text-[var(--call-highlight)] sm:flex"><Icon name="file" size={12} />Taking notes</span>}
      <span className="ml-auto" />
      <RoundControl size="sm" icon={full ? 'shrink' : 'expand'} label={full ? t('huddle.exitFullScreen') : t('huddle.fullScreen')} onClick={() => setFull(value => !value)} />
    </header>

    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-3">
        {stage ? <div className="relative min-h-0 flex-1">
          <TileView tile={stage} big />
          {latest && <p className="absolute bottom-4 left-1/2 max-w-[80%] -translate-x-1/2 rounded-lg bg-[rgb(0_0_0/0.7)] px-3 py-1.5 text-sm">{latest.username}: {latest.text}</p>}
        </div> : <div className="relative min-h-0 flex-1">
          <div className={`grid h-full content-center gap-3 overflow-auto ${columns} ${count === 1 ? 'mx-auto w-full max-w-xl' : ''}`}>
            {tiles.map(tile => <TileView key={tile.key} tile={tile} reactions={reactionsFor(tile.key)} />)}
          </div>
          {latest && <p className="absolute bottom-3 left-1/2 max-w-[80%] -translate-x-1/2 rounded-lg bg-[rgb(0_0_0/0.7)] px-3 py-1.5 text-sm">{latest.username}: {latest.text}</p>}
        </div>}
        {stage && strip.length > 0 && <div className="flex h-28 shrink-0 gap-2 overflow-x-auto [&>figure]:w-48 [&>figure]:shrink-0">
          {strip.map(tile => <TileView key={tile.key} tile={tile} reactions={reactionsFor(tile.key)} />)}
        </div>}
      </div>
      {full && sidePanel}
    </div>

    {call.error && <p role="alert" className="mx-4 mb-2 rounded-lg bg-rose-500/15 px-3 py-2 text-sm text-rose-200">{call.error}</p>}
    <footer className="relative flex items-start justify-center gap-1 border-t border-[rgb(255_255_255/0.08)] px-4 py-3 sm:gap-2">
      <RoundControl caption={call.muted ? 'Unmute' : 'Mute'} icon={call.muted ? 'micOff' : 'mic'} label={call.muted ? t('huddle.unmute') : t('huddle.mute')} warn={call.muted} onClick={() => calls.toggleMute()} />
      <RoundControl caption="Video" icon={call.camera ? 'video' : 'videoOff'} label={call.camera ? t('huddle.cameraOff') : t('huddle.cameraOn')} active={call.camera} onClick={() => void calls.toggleCamera()} />
      {canShare && <RoundControl caption="Share" icon="screen" label={call.screen ? t('huddle.stopShare') : t('huddle.share')} active={call.screen} onClick={() => void calls.toggleScreen()} />}
      <div className="hidden sm:block"><RoundControl caption="Raise hand" icon="hand" label={call.hand ? 'Lower your hand' : 'Raise your hand'} active={call.hand} onClick={() => calls.toggleHand()} /></div>
      <RoundControl caption="React" icon="smile" label="Send a reaction" active={menu === 'react'} onClick={() => setMenu(value => value === 'react' ? null : 'react')} />
      {captionsSupported() && <div className="hidden sm:block"><RoundControl caption="Captions" icon="captions" label={call.captionsOn ? 'Turn captions off' : 'Turn captions on'} active={call.captionsOn}
        onClick={() => calls.toggleCaptions(user?.username ?? 'You')} /></div>}
      <RoundControl caption="Audio" icon="settings" label="Audio settings" active={menu === 'settings'} onClick={() => setMenu(value => value === 'settings' ? null : 'settings')} />
      <div className="ml-2 flex w-16 flex-col items-center gap-1 sm:ml-4">
        <UiButton type="button" onClick={() => void calls.leave()} aria-label={t('huddle.leave')} tooltip={t('huddle.leave')}
          className="flex h-11 w-16 items-center justify-center rounded-full bg-rose-600 transition hover:bg-rose-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--rail-fg)]" style={WHITE}>
          <Icon name="phone" size={20} className="rotate-[135deg]" />
        </UiButton>
        <span className="text-[11px] font-medium" style={MUTED_TEXT}>{t('huddle.leave')}</span>
      </div>
      {menu === 'react' && <div className="absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 gap-1 rounded-2xl bg-[var(--call-panel)] p-2 shadow-xl">
        {REACTIONS.map(emoji => <UiButton tooltip={`React ${emoji}`} key={emoji} type="button" aria-label={`React ${emoji}`} onClick={() => { calls.react(emoji); setMenu(null); }}
          className="rounded-xl px-2 py-1 text-2xl transition hover:bg-[rgb(255_255_255/0.12)]">{emoji}</UiButton>)}
      </div>}
      {menu === 'settings' && <div className="absolute bottom-full left-1/2 mb-2 w-72 -translate-x-1/2 rounded-xl bg-[var(--call-panel)] p-3 shadow-xl">
        <label className="block text-xs font-medium" style={MUTED_TEXT}>Microphone
          <UiSelect aria-label="Microphone" className="mt-1 w-full rounded-lg border border-[rgb(255_255_255/0.15)] bg-[var(--call-surface)] px-2 py-2 text-sm" style={WHITE}
            defaultValue="" onChange={event => { if (event.target.value) void calls.useMicrophone(event.target.value); }}>
            <option value="" disabled>{devices.length ? 'Choose a microphone' : 'Looking for microphones…'}</option>
            {devices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label || 'Microphone'}</option>)}
          </UiSelect>
        </label>
      </div>}
    </footer>
  </section>
  </div>;
}
