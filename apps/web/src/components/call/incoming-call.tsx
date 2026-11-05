'use client';

import { useEffect, useState } from 'react';
import { calls } from '../../lib/call';
import { socket } from '../../lib/socket';

type Ring = { channelId: string; from: { id: string; username: string } };

/** "bob is calling you" banner for DM huddles. Mount once in the logged-in app. */
export function IncomingCall({ onAccept }: { onAccept?: (channelId: string) => void }) {
  const [ring, setRing] = useState<Ring | null>(null);
  useEffect(() => {
    const onIncoming = (data: Ring) => { if (calls.getState().channelId !== data.channelId) setRing(data); };
    socket.on('call:incoming', onIncoming);
    return () => { socket.off('call:incoming', onIncoming); };
  }, []);
  useEffect(() => {
    if (!ring) return;
    const timer = setTimeout(() => setRing(null), 30000); // stop ringing after 30 seconds
    return () => clearTimeout(timer);
  }, [ring]);
  if (!ring) return null;
  return <div role="alertdialog" aria-label="Incoming call"
    className="fixed bottom-4 right-4 z-50 w-[min(92vw,320px)] rounded-xl border border-amber-400/40 bg-[#151821] p-4 shadow-2xl">
    <p className="font-semibold">📞 {ring.from.username} is calling you</p>
    <div className="mt-3 flex justify-end gap-2 text-sm">
      <button type="button" onClick={() => setRing(null)} className="rounded px-3 py-1.5 text-white/70 hover:bg-white/10">Decline</button>
      <button type="button" autoFocus className="rounded bg-emerald-500 px-3 py-1.5 font-semibold text-black"
        onClick={() => { const channelId = ring.channelId; setRing(null); onAccept?.(channelId); void calls.join(channelId); }}>Join</button>
    </div>
  </div>;
}
