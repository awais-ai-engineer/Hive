'use client';

import { Button as UiButton } from '@hive/ui';

import { useState } from 'react';
import { calls } from '../../lib/call';
import { useHuddles } from '../../lib/huddles';
import { useCall } from '../../lib/use-call';
import { requestError } from '../../lib/spaces';
import { Avatar } from '../ui/avatar';
import { Icon } from '../ui/icons';

/**
 * Header button that starts or joins the huddle of a channel or conversation. While people are in
 * it, it turns into a green "Huddle · 3" pill with their avatars. Starting one in a direct
 * conversation also rings the other person.
 */
export function HuddleButton({ channelId, title, ring = false }: { channelId: string; title: string; ring?: boolean }) {
  const call = useCall();
  const huddle = useHuddles()[channelId];
  const [error, setError] = useState('');
  const inThis = call.channelId === channelId && call.status !== 'idle' && call.status !== 'error';
  const count = huddle?.count ?? 0;

  async function toggle() {
    setError('');
    // Already in this huddle: bring the huddle window back to the centre of the screen.
    if (inThis) { calls.setStageOpen(true); return; }
    const alone = count === 0;
    await calls.join(channelId, title);
    const state = calls.getState();
    if (state.status === 'error') { setError(state.error); return; }
    calls.setStageOpen(true);
    if (ring && alone) await calls.ring(channelId).catch(cause => setError(requestError(cause)));
  }

  const label = inThis ? 'Open the huddle window' : count ? `Join the huddle with ${huddle.users.map(user => user.username).join(', ')}` : 'Start a huddle';
  return <div className="relative shrink-0">
    <UiButton type="button" onClick={() => void toggle()} aria-label={label} tooltip={label} aria-pressed={inThis}
      className={count || inThis
        ? 'flex items-center gap-2 rounded-full bg-emerald-600 px-3 py-1.5 text-sm font-semibold transition hover:bg-emerald-700'
        : 'btn-ghost !px-2.5 !py-1.5'}
      style={count || inThis ? { color: 'var(--rail-fg)' } : undefined}>
      <Icon name="headphones" size={16} />
      <span className={count || inThis ? '' : 'max-sm:sr-only'}>{count ? `Huddle · ${count}` : 'Huddle'}</span>
      {count > 0 && <span className="-space-x-1.5 flex max-sm:hidden" aria-hidden>
        {huddle.users.slice(0, 3).map(user => <span key={user.id} className="rounded-full ring-2 ring-emerald-600"><Avatar name={user.username} src={user.avatarUrl} size={20} /></span>)}
      </span>}
    </UiButton>
    {error && <p role="alert" className="on-surface card absolute right-0 top-full z-20 mt-1 w-64 p-2 text-xs text-rose-500">{error}</p>}
  </div>;
}
