'use client';

import { Button as UiButton } from '@hive/ui';

import { useState } from 'react';
import { apiData, requestError } from '../../lib/spaces';
import { Icon } from '../ui/icons';
import { PopupMenu } from './popup-menu';

const DAY = 86400;
export const TIMER_CHOICES: [number, string][] = [[0, 'Off'], [DAY, '24 hours'], [7 * DAY, '7 days'], [30 * DAY, '30 days']];

export function timerText(seconds: number | null | undefined) {
  return TIMER_CHOICES.find(([value]) => value === (seconds ?? 0))?.[1] ?? 'Off';
}

/** Header button to choose how long new messages in this conversation stay around. */
export function TimerButton({ channelId, seconds, onChanged, onError }: {
  channelId: string; seconds: number | null | undefined; onChanged: () => void; onError: (message: string) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const current = seconds ?? 0;
  async function choose(value: number) {
    try {
      await apiData(`/api/channels/${channelId}/disappearing`, { method: 'PUT', body: JSON.stringify({ seconds: value }) });
      onChanged();
    } catch (cause) { onError(requestError(cause)); }
  }
  return <>
    <UiButton type="button" aria-haspopup="menu" aria-expanded={!!menu} tooltip={`Disappearing messages: ${timerText(current)}`} aria-label={`Disappearing messages: ${timerText(current)}`}
      onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setMenu({ x: box.right - 256, y: box.bottom + 4 }); }}
      className={`rounded-lg p-1.5 hover:bg-[var(--surface-2)] ${current ? 'text-brand' : 'text-white/60 hover:text-white'}`}><Icon name="clock" size={18} /></UiButton>
    {menu && <PopupMenu at={menu} label="Disappearing messages" onClose={() => setMenu(null)} items={[
      { heading: 'Disappearing messages' },
      ...TIMER_CHOICES.map(([value, label]) => ({ label, checked: current === value, onSelect: () => void choose(value) })),
      { separator: true },
      { heading: 'Applies to new messages only' },
    ]} />}
  </>;
}

export function TimerBanner({ seconds }: { seconds: number | null | undefined }) {
  if (!seconds) return null;
  return <p role="status" className="mb-3 flex items-center gap-2 rounded-xl bg-brand-soft px-3 py-2 text-sm">
    <Icon name="clock" size={15} className="shrink-0 text-brand" />Messages disappear after {timerText(seconds)}</p>;
}
