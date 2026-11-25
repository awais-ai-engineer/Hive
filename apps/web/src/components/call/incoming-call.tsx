'use client';

import { Button as UiButton } from '@hive/ui';

import { useEffect, useState } from 'react';
import { calls } from '../../lib/call';
import { chatRequest, socket } from '../../lib/socket';
import { startRing, stopRing } from '../../lib/sounds';
import { Icon } from '../ui/icons';

type Ring = { channelId: string; invitationId: string; expiresAt: number; sound?: boolean; from: { id: string; username: string } };

/** "bob is calling you" toast for conversation huddles. Mount once in the logged-in app. */
export function IncomingCall({ titleFor, onAccept }: { titleFor: (channelId: string, caller: string) => string; onAccept?: (channelId: string) => void }) {
  const [ring, setRing] = useState<Ring | null>(null);
  useEffect(() => {
    const onIncoming = (data: Ring) => { if (calls.getState().channelId !== data.channelId) setRing(data); };
    const resolved = (data: { invitationId: string }) => setRing(current => current?.invitationId === data.invitationId ? null : current);
    const disconnected = () => setRing(null);
    socket.on('call:resolved', resolved).on('disconnect', disconnected);
    socket.on('call:incoming', onIncoming);
    return () => { socket.off('call:incoming', onIncoming).off('call:resolved', resolved).off('disconnect', disconnected); };
  }, []);
  useEffect(() => {
    if (!ring) { stopRing(); return; }
    if (ring.sound !== false) startRing(ring.invitationId, false, ring.expiresAt);
    const timer = setTimeout(() => setRing(null), Math.max(0, ring.expiresAt - Date.now()));
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { void chatRequest('call:respond', { invitationId: ring.invitationId, action: 'declined' }).catch(() => {}); setRing(null); } };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(timer); stopRing(); window.removeEventListener('keydown', onKey); };
  }, [ring]);
  if (!ring) return null;
  return <div role="alertdialog" aria-label="Incoming huddle" className="card on-surface animate-in fixed bottom-4 right-4 z-50 w-[min(92vw,320px)] p-4">
    <p className="flex items-center gap-2 font-semibold"><Icon name="headphones" size={18} className="text-brand" />{ring.from.username} is calling you</p>
    <p className="mt-1 text-xs text-white/60">Join the huddle to talk. They will see you when you arrive.</p>
    <div className="mt-3 flex justify-end gap-2 text-sm">
      <UiButton type="button" onClick={() => { void chatRequest('call:respond', { invitationId: ring.invitationId, action: 'declined' }).catch(() => {}); setRing(null); }} className="btn-ghost">Decline</UiButton>
      <UiButton type="button" autoFocus className="auth-button !py-1.5 !text-sm"
        onClick={() => { const { channelId } = ring; setRing(null); onAccept?.(channelId); void calls.join(channelId, titleFor(channelId, ring.from.username)).then(async () => { if (calls.getState().channelId === channelId && calls.getState().status === 'connected') { await chatRequest('call:respond', { invitationId: ring.invitationId, action: 'accepted' }); calls.setStageOpen(true); } else await chatRequest('call:respond', { invitationId: ring.invitationId, action: 'declined' }); }).catch(() => {}); }}>Join</UiButton>
    </div>
  </div>;
}
