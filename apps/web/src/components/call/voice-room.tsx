'use client';

import { calls } from '../../lib/call';
import { useHuddles } from '../../lib/huddles';
import { useCall } from '../../lib/use-call';
import { Avatar } from '../ui/avatar';
import { Icon } from '../ui/icons';

/** Main view of a voice channel: an always-on room anyone with access can drop into. */
export function VoiceRoom({ channelId, title, reason = '' }: { channelId: string; title: string; reason?: string }) {
  const call = useCall();
  const room = useHuddles()[channelId];
  const inRoom = call.channelId === channelId && call.status !== 'idle' && call.status !== 'error';
  const names = room?.users.map(user => user.username).join(', ');
  return <section aria-label={`Voice: ${title}`} className="card mx-auto mt-6 w-full max-w-lg p-6 text-center">
    <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-soft text-brand"><Icon name="volume" size={24} /></span>
    <h2 className="mt-3 text-lg font-semibold">{title}</h2>
    {room?.count ? <>
      <ul className="mt-3 flex justify-center -space-x-2" aria-label="In the room">
        {room.users.map(user => <li key={user.id} title={user.username} className="rounded-full ring-2 ring-[var(--surface)]"><Avatar name={user.username} src={user.avatarUrl} size={36} /></li>)}
      </ul>
      <p className="mt-2 text-sm text-white/60">{names} {room.count === 1 ? 'is' : 'are'} here</p>
    </> : <p className="mt-1 text-sm text-white/60">No one is here yet. Join and others can drop in any time.</p>}
    {call.error && !inRoom && <p role="alert" className="mt-3 text-sm text-rose-500">{call.error}</p>}
    <button type="button" disabled={!!reason && !inRoom} title={reason || undefined}
      onClick={() => void (inRoom ? calls.leave() : calls.join(channelId, title))}
      className={inRoom ? 'btn-ghost mt-4' : 'auth-button mt-4 !bg-emerald-600'}>
      <Icon name={inRoom ? 'phoneOff' : 'headphones'} size={16} />{inRoom ? 'Leave room' : 'Join voice'}
    </button>
    {reason && <p className="mt-2 text-xs text-white/60">{reason}</p>}
    <p className="mt-3 text-xs text-white/50">Up to 6 people. Audio and video go directly between participants.</p>
  </section>;
}
