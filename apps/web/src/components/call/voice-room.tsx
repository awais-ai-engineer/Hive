'use client';

import { useEffect, useState } from 'react';
import { calls } from '../../lib/call';
import { socket } from '../../lib/socket';
import { apiData } from '../../lib/spaces';
import { useCall } from '../../lib/use-call';
import { CallPanel } from './call-panel';

type Summary = { channelId: string; count: number; users: { id: string; username: string }[] };

/** A voice channel or DM huddle: who is in it, a Join button, and the call once joined. */
export function VoiceRoom({ channelId, title, username, reason = '', ring = false }: {
  channelId: string; title: string; username: string; reason?: string; ring?: boolean;
}) {
  const call = useCall();
  const [summary, setSummary] = useState<Summary | null>(null);
  useEffect(() => {
    let active = true;
    apiData<Summary>(`/api/calls/${channelId}`).then(value => { if (active) setSummary(value); }).catch(() => {});
    const onUpdate = (value: Summary) => { if (value.channelId === channelId) setSummary(value); };
    socket.on('call:participants', onUpdate);
    return () => { active = false; socket.off('call:participants', onUpdate); };
  }, [channelId]);

  if (call.channelId === channelId && call.status !== 'idle') return <CallPanel title={title} username={username} />;
  const names = summary?.users.map(user => user.username).join(', ');
  return <section aria-label={`Voice: ${title}`} className="rounded-xl border border-white/10 bg-white/[0.02] p-5 text-center">
    <p className="text-lg font-semibold">🔊 {title}</p>
    <p className="mt-1 text-sm text-white/50">{summary?.count ? `${names} ${summary.count === 1 ? 'is' : 'are'} here` : 'No one is here yet'}</p>
    {call.status === 'error' && call.error && <p role="alert" className="mt-2 text-sm text-rose-400">{call.error}</p>}
    <button type="button" disabled={!!reason} title={reason || undefined}
      onClick={async () => { await calls.join(channelId); if (ring) void calls.ring(channelId).catch(() => {}); }}
      className="mt-4 rounded-full bg-emerald-500 px-5 py-2 font-semibold text-black disabled:opacity-40">{ring ? '📞 Start huddle' : 'Join voice'}</button>
    {reason && <p className="mt-2 text-xs text-white/50">{reason}</p>}
    <p className="mt-3 text-xs text-white/40">Up to 6 people. Audio and video go directly between participants.</p>
  </section>;
}
