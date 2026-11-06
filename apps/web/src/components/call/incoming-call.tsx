'use client';

import { useEffect, useState } from 'react';
import { calls } from '../../lib/call';
import { socket } from '../../lib/socket';
import { Icon } from '../ui/icons';

type Ring = { channelId: string; from: { id: string; username: string } };

/** "bob is calling you" toast for conversation huddles. Mount once in the logged-in app. */
export function IncomingCall({ titleFor, onAccept }: { titleFor: (channelId: string, caller: string) => string; onAccept?: (channelId: string) => void }) {
  const [ring, setRing] = useState<Ring | null>(null);
  useEffect(() => {
    const onIncoming = (data: Ring) => { if (calls.getState().channelId !== data.channelId) setRing(data); };
    socket.on('call:incoming', onIncoming);
    return () => { socket.off('call:incoming', onIncoming); };
  }, []);
  useEffect(() => {
    if (!ring) return;
    const timer = setTimeout(() => setRing(null), 30000); // stop ringing after 30 seconds
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setRing(null); };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(timer); window.removeEventListener('keydown', onKey); };
  }, [ring]);
  if (!ring) return null;
  return <div role="alertdialog" aria-label="Incoming huddle" className="card on-surface animate-in fixed bottom-4 right-4 z-50 w-[min(92vw,320px)] p-4">
    <p className="flex items-center gap-2 font-semibold"><Icon name="headphones" size={18} className="text-brand" />{ring.from.username} is calling you</p>
    <p className="mt-1 text-xs text-white/60">Join the huddle to talk. They will see you when you arrive.</p>
    <div className="mt-3 flex justify-end gap-2 text-sm">
      <button type="button" onClick={() => setRing(null)} className="btn-ghost">Decline</button>
      <button type="button" autoFocus className="auth-button !py-1.5 !text-sm"
        onClick={() => { const { channelId } = ring; setRing(null); onAccept?.(channelId); void calls.join(channelId, titleFor(channelId, ring.from.username)); }}>Join</button>
    </div>
  </div>;
}
