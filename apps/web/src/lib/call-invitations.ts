'use client';
import { useSyncExternalStore } from 'react';
import { currentUserId, subscribeSession } from './api';
import { apiData } from './spaces';
import { chatRequest, socket } from './socket';
import { startRing, stopRing } from './sounds';

export type Invitation = { invitationId: string; channelId: string; channelName: string; caller: string;
  from: { id: string; username: string; displayName?: string; avatarUrl?: string | null };
  people: { id: string; username: string; displayName?: string; avatarUrl?: string | null }[];
  recipients: string[]; declined: string[]; status: string; version: number; createdAt: string;
  expiresAt: number; sound?: boolean; acceptedBy?: string | null; acceptedSid?: string | null };
const empty: Invitation[] = [];
let state = empty;
let revision = 0;
let owner: string | null = null;
let expiry: ReturnType<typeof setTimeout> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();
const terminal = new Set(['declined', 'expired', 'cancelled', 'ended']);

function reconcile() {
  if (expiry) clearTimeout(expiry);
  const next = state.filter(row => row.status === 'ringing' && row.expiresAt > Date.now()).map(row => row.expiresAt).sort((a,b) => a-b)[0];
  if (next) expiry = setTimeout(() => { state = [...state]; reconcile(); listeners.forEach(listener => listener()); }, Math.max(0, next - Date.now()));
  const user = currentUserId();
  const incoming = state.find(row => row.status === 'ringing' && row.from.id !== user && row.recipients.includes(user ?? '') && !row.declined.includes(user ?? '') && row.expiresAt > Date.now());
  const outgoing = state.find(row => row.status === 'ringing' && row.from.id === user && row.expiresAt > Date.now());
  const ring = incoming ?? outgoing;
  if (ring && ring.sound !== false) startRing(ring.invitationId, !incoming, ring.expiresAt); else stopRing();
}
function update(data: Invitation) {
  if (!data?.invitationId || !currentUserId()) return;
  const previous = state.find(row => row.invitationId === data.invitationId);
  if (previous && previous.version > data.version) return;
  state = [data, ...state.filter(row => row.invitationId !== data.invitationId)].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-100);
  revision++; reconcile(); listeners.forEach(listener => listener());
}
async function recover() {
  const owner = currentUserId(); const started = revision;
  if (!owner) return;
  try {
    const rows = await apiData<Invitation[]>('/api/calls/invitations');
    if (owner !== currentUserId()) return;
    for (const row of rows) update(row);
    // Only prune a snapshot when no newer realtime transition raced the request.
    if (started === revision - rows.length) {
      const ids = new Set(rows.map(row => row.invitationId));
      state = state.filter(row => terminal.has(row.status) || ids.has(row.invitationId));
    }
    reconcile(); listeners.forEach(listener => listener());
  } catch { /* keep the visible invitation and expiry during transient network failures */ }
}
if (typeof window !== 'undefined') {
  // `call:incoming` is the immediate recipient-targeted delivery event. Keep
  // the broader events as recovery paths for reconnects and secondary tabs.
  socket.on('call:invitation', update)
    .on('call:incoming', update)
    .on('call:resolved', update)
    .on('connect', recover);
  subscribeSession(session => {
    const nextOwner = currentUserId() ?? null;
    if (owner !== nextOwner) { state = empty; revision++; stopRing(); if (expiry) clearTimeout(expiry); listeners.forEach(listener => listener()); owner = nextOwner; }
    if (!session) { if (timer) clearInterval(timer); timer = null; state = empty; revision++; stopRing(); listeners.forEach(listener => listener()); }
    else if (!timer) { void recover(); timer = setInterval(() => void recover(), 5000); }
  });
}
export function useInvitations() { return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state, () => empty); }
export async function respondInvitation(invitationId: string, action: 'accepted' | 'declined' | 'cancelled') {
  const row = await chatRequest<Invitation>('call:respond', { invitationId, action });
  update(row); return row;
}
