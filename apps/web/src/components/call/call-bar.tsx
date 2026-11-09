'use client';

import { useT } from '../../lib/i18n';
import { calls } from '../../lib/call';
import { useCall } from '../../lib/use-call';
import { useAuth } from '../../lib/auth';
import { Avatar } from '../ui/avatar';
import { Icon } from '../ui/icons';
import { RoundControl } from './call-stage';
import { useCallTimer } from './call-timer';

/** Compact huddle card at the bottom of the sidebar; it stays while you move around /home. */
export function CallBar() {
  const call = useCall();
  const { user } = useAuth();
  const { t } = useT();
  const timer = useCallTimer(call.status === 'connected');
  if (call.status === 'idle' || !call.channelId) return null;
  const canShare = typeof navigator !== 'undefined' && !!navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices;
  const people = [{ key: 'me', name: user?.username ?? 'You', avatar: user?.avatar_url, talking: call.speaking && !call.muted },
    ...call.peers.map(peer => ({ key: peer.sid, name: peer.username, avatar: peer.avatarUrl, talking: peer.speaking && !peer.muted }))];
  return <section aria-label={`Huddle in ${call.title}`} className="mt-3 rounded-2xl bg-[#16131c] p-3 shadow-lg" style={{ color: '#fff' }}>
    <button type="button" onClick={() => calls.setStageOpen(true)} title="Open the huddle window" className="flex w-full items-center gap-2 text-left">
      <span className="relative flex h-2 w-2 shrink-0"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" /><span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{call.status === 'joining' ? 'Connecting…' : call.title}</span>
        <span className="block text-[11px]" style={{ color: 'rgb(255 255 255 / 0.6)' }}>{t('huddle.huddle')}{timer ? ` · ${timer}` : ''}</span>
      </span>
      <span className="flex -space-x-1.5">
        {people.slice(0, 4).map(person => <span key={person.key} title={person.name}
          className={`rounded-full ring-2 ${person.talking ? 'ring-emerald-400' : 'ring-[#16131c]'}`}><Avatar name={person.name} src={person.avatar} size={22} /></span>)}
        {people.length > 4 && <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-[rgb(255_255_255/0.15)] text-[10px] ring-2 ring-[#16131c]">+{people.length - 4}</span>}
      </span>
    </button>
    {call.error && <p role="alert" className="mt-2 text-xs text-rose-300">{call.error}</p>}
    <div className="mt-3 flex items-center gap-1.5">
      <RoundControl size="sm" icon={call.muted ? 'micOff' : 'mic'} label={call.muted ? t('huddle.unmute') : t('huddle.mute')} warn={call.muted} onClick={() => calls.toggleMute()} />
      <RoundControl size="sm" icon={call.camera ? 'video' : 'videoOff'} label={call.camera ? t('huddle.cameraOff') : t('huddle.cameraOn')} active={call.camera}
        onClick={() => { void calls.toggleCamera().then(() => { if (calls.getState().camera) calls.setStageOpen(true); }); }} />
      {canShare && <RoundControl size="sm" icon="screen" label={call.screen ? t('huddle.stopShare') : t('huddle.share')} active={call.screen}
        onClick={() => { void calls.toggleScreen().then(() => { if (calls.getState().screen) calls.setStageOpen(true); }); }} />}
      <RoundControl size="sm" icon="popout" label="Open the huddle window" active={call.stageOpen} onClick={() => calls.setStageOpen(!call.stageOpen)} />
      <button type="button" onClick={() => void calls.leave()} aria-label={t('huddle.leave')} title={t('huddle.leave')}
        className="ml-auto flex h-8 w-11 items-center justify-center rounded-full bg-rose-600 transition hover:bg-rose-500" style={{ color: '#fff' }}>
        <Icon name="phone" size={16} className="rotate-[135deg]" /></button>
    </div>
  </section>;
}
