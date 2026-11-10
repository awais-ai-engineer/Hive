'use client';

import { io } from 'socket.io-client';
import { refreshSession, subscribeSession, type AuthSession } from './api';

let current: AuthSession | null = null;
let refreshed = false;
export const socket = io((process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').trim().replace(/\/+$/, ''), {
  autoConnect: false, withCredentials: true,
  auth: callback => callback(current ? { token: current.access_token } : {}),
});

subscribeSession(value => {
  const previousUser = current?.user.id;
  current = value;
  if (!value) { socket.disconnect(); refreshed = false; }
  else {
    if (previousUser && previousUser !== value.user.id) socket.disconnect();
    if (!socket.connected) socket.connect();
  }
});
socket.on('connect', () => { refreshed = false; });
socket.on('connect_error', async error => {
  if (error.message === 'unauthorized' && !refreshed && current) {
    refreshed = true;
    if (await refreshSession()) socket.connect();
  }
});

type Ack<T> = ({ ok: true } & T) | { ok: false; error: { code: string; message: string } };
export function chatRequest<T = Record<string, never>>(event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!socket.connected) { reject(new Error('Reconnecting… Please retry once connected.')); return; }
    socket.timeout(10000).emit(event, payload, (error: Error | null, response: Ack<T>) => {
      if (error) reject(new Error('Message timed out. Please retry.'));
      else if (!response.ok) reject(new Error(response.error.message));
      else resolve(response);
    });
  });
}
