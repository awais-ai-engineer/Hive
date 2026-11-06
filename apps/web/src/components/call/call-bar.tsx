'use client';

import { calls } from '../../lib/call';
import { useCall } from '../../lib/use-call';
import { useAuth } from '../../lib/auth';
import { Avatar } from '../ui/avatar';
import { Icon, type IconName } from '../ui/icons';

function Control({ icon, label, on, danger, onClick }: { icon: IconName; label: string; on?: boolean; danger?: boolean; onClick: () => void }) {
  return <button type="button" onClick={onClick} aria-label={label} title={label} aria-pressed={on}
    className={`flex h-9 w-9 items-center justify-center rounded-lg transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white ${
      danger ? 'bg-rose-600' : on ? 'bg-[#fff] !text-[#2a1b5e]' : 'bg-white/15 hover:bg-white/25'}`}
    style={danger ? { color: '#fff' } : undefined}>
    <Icon name={icon} size={18} />
  </button>;
}

/** Slim call controls at the bottom of the sidebar, visible on every page of /home. */
export function CallBar() {
  const call = useCall();
  const { user } = useAuth();
  if (call.status === 'idle' || !call.channelId) return null;
  const canShare = typeof navigator !== 'undefined' && !!navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices;
  const people = [{ key: 'me', name: user?.username ?? 'You', avatar: user?.avatar_url, talking: call.speaking && !call.muted },
    ...call.peers.map(peer => ({ key: peer.sid, name: peer.username, avatar: peer.avatarUrl, talking: peer.speaking && !peer.muted }))];
  return <section aria-label={`Huddle in ${call.title}`} className="mt-3 rounded-xl bg-white/10 p-2.5">
    <div className="flex items-center gap-2 text-sm font-semibold">
      <Icon name="headphones" size={16} className="shrink-0 text-emerald-300" />
      <span className="truncate">{call.status === 'joining' ? 'Connecting…' : call.title}</span>
      <span className="ml-auto shrink-0 text-xs font-normal text-white/70">{call.peers.length + 1} in huddle</span>
    </div>
    <ul className="mt-2 flex -space-x-1.5" aria-label="Participants">
      {people.slice(0, 6).map(person => <li key={person.key} title={person.name}
        className={`rounded-full ring-2 ${person.talking ? 'ring-emerald-400' : 'ring-transparent'}`}>
        <Avatar name={person.name} src={person.avatar} size={26} /></li>)}
    </ul>
    {call.error && <p role="alert" className="mt-2 text-xs text-rose-200">{call.error}</p>}
    <div className="mt-2 flex items-center gap-1.5">
      <Control icon={call.muted ? 'micOff' : 'mic'} label={call.muted ? 'Unmute' : 'Mute'} on={call.muted} onClick={() => calls.toggleMute()} />
      <Control icon={call.camera ? 'video' : 'videoOff'} label={call.camera ? 'Turn camera off' : 'Turn camera on'} on={call.camera}
        onClick={() => { void calls.toggleCamera().then(() => { if (calls.getState().camera) calls.setStageOpen(true); }); }} />
      {canShare && <Control icon="screen" label={call.screen ? 'Stop sharing your screen' : 'Share your screen'} on={call.screen}
        onClick={() => { void calls.toggleScreen().then(() => { if (calls.getState().screen) calls.setStageOpen(true); }); }} />}
      <Control icon="users" label={call.stageOpen ? 'Hide participants' : 'Show participants'} on={call.stageOpen}
        onClick={() => calls.setStageOpen(!call.stageOpen)} />
      <span className="ml-auto" />
      <Control icon="phoneOff" label="Leave huddle" danger onClick={() => void calls.leave()} />
    </div>
  </section>;
}
