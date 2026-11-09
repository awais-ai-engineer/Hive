'use client';

import { calls } from '../../lib/call';
import { useCall } from '../../lib/use-call';
import { useHuddles } from '../../lib/huddles';
import { Avatar } from '../ui/avatar';
import { Icon } from '../ui/icons';

/** Green "huddle is live" strip at the top of a channel or conversation while people are talking. */
export function LiveHuddleBanner({ channelId, title }: { channelId: string; title: string }) {
  const huddle = useHuddles()[channelId];
  const call = useCall();
  if (!huddle?.count) return null;
  const joined = call.channelId === channelId && call.status !== 'idle' && call.status !== 'error';
  const shown = huddle.users.slice(0, 3);
  return <div role="status" className="mb-3 flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5">
    <span className="relative flex h-2.5 w-2.5 shrink-0"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" /></span>
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-semibold">{joined ? 'You are in this huddle' : 'Huddle is live'}</p>
      <p className="truncate text-xs text-white/60">{huddle.count} {huddle.count === 1 ? 'person' : 'people'} in {title}</p>
    </div>
    <span className="hidden -space-x-1.5 sm:flex">
      {shown.map(user => <span key={user.id} title={user.username} className="rounded-full ring-2 ring-[var(--canvas)]"><Avatar name={user.username} src={user.avatarUrl} size={24} /></span>)}
      {huddle.count > shown.length && <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--surface-2)] text-[10px] font-semibold ring-2 ring-[var(--canvas)]">+{huddle.count - shown.length}</span>}
    </span>
    <button type="button" onClick={() => { if (joined) calls.setStageOpen(true); else void calls.join(channelId, title).then(() => calls.setStageOpen(true)); }}
      className="flex shrink-0 items-center gap-1.5 rounded-lg bg-[#15171c] px-3 py-1.5 text-sm font-semibold dark:bg-[#e8eaee]"
      style={{ color: 'var(--canvas)' }}>
      <Icon name="headphones" size={15} />{joined ? 'Open huddle' : 'Join huddle'}
    </button>
  </div>;
}
