'use client';
import { Button } from '@hive/ui';
import { useState } from 'react';
import { calls } from '../../lib/call';
import { currentUserId } from '../../lib/api';
import { respondInvitation, useInvitations } from '../../lib/call-invitations';
import { requestError } from '../../lib/spaces';
import { stopRing } from '../../lib/sounds';
import { Avatar } from '../ui/avatar';

/** Authoritative, recoverable invitation UI. Route changes never own or resolve a call. */
export function IncomingCall({ titleFor, onAccept }: { titleFor: (channelId: string, caller: string) => string; onAccept?: (channelId: string) => void }) {
  const rows = useInvitations(); const user = currentUserId();
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const incoming = rows.find(row => row.status === 'ringing' && row.from.id !== user && row.recipients.includes(user ?? '') && !row.declined.includes(user ?? '') && row.expiresAt > Date.now());
  const outgoing = rows.find(row => row.from.id === user && ['ringing', 'accepted', 'connecting'].includes(row.status) && row.expiresAt > Date.now());
  const row = incoming ?? outgoing;
  if (!row) return error ? <p role="alert" className="card fixed bottom-20 right-4 z-[60] max-w-xs p-3 text-sm text-rose-500">{error}<Button type="button" className="btn-ghost" onClick={() => setError('')}>Dismiss</Button></p> : null;
  const person = incoming ? row.from : row.people[0];
  async function decline() {
    setBusy(true); setError('');
    try { await respondInvitation(row!.invitationId, incoming ? 'declined' : 'cancelled'); }
    catch (cause) { setError(requestError(cause)); } finally { setBusy(false); }
  }
  async function accept() {
    if (!incoming) return;
    setBusy(true); setError(''); stopRing(row!.invitationId);
    try {
      // Server acceptance reserves the device and stops every other recipient tab's ringtone.
      await respondInvitation(row!.invitationId, 'accepted');
      onAccept?.(row!.channelId);
      await calls.join(row!.channelId, titleFor(row!.channelId, incoming.from.displayName ?? incoming.from.username), row!.invitationId);
      if (calls.getState().channelId === row!.channelId && calls.getState().status !== 'idle' && calls.getState().status !== 'error') calls.setStageOpen(true);
      else await respondInvitation(row!.invitationId, 'declined');
    } catch (cause) { setError(requestError(cause)); } finally { setBusy(false); }
  }
  return <section role={incoming ? 'alertdialog' : 'status'} aria-label={incoming ? 'Incoming huddle' : 'Outgoing Huddle'} className="card on-surface fixed bottom-20 right-4 z-[60] w-[min(92vw,320px)] p-4 sm:bottom-4">
    <div className="flex items-center gap-3"><Avatar name={person?.displayName ?? person?.username ?? 'Huddle'} src={person?.avatarUrl} size={36} /><div className="min-w-0"><p className="truncate text-sm font-semibold">{person?.displayName ?? person?.username ?? 'Conversation Huddle'}</p><p className="text-xs text-white/60">{incoming ? 'Incoming Huddle invitation' : row.status === 'ringing' ? 'Calling — waiting for an answer' : 'Connecting media…'}</p></div></div>
    {row.channelName && <p className="mt-2 truncate text-xs text-white/60">{row.channelName}</p>}
    {incoming && <p className="mt-2 text-xs text-white/60">Sound needs permission from your browser. You can still join or decline here.</p>}
    {error && <p role="alert" className="mt-2 text-xs text-rose-500">{error}</p>}
    <div className="mt-3 flex justify-end gap-2"><Button disabled={busy} type="button" className="btn-ghost" onClick={() => void decline()}>{incoming ? 'Decline' : 'Cancel call'}</Button>{incoming && <Button disabled={busy} type="button" className="auth-button !w-auto" onClick={() => void accept()}>Join</Button>}</div>
  </section>;
}
