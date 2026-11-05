'use client';

import { useSyncExternalStore } from 'react';
import { calls, type CallState } from './call';

const server: CallState = {
  channelId: null, status: 'idle', error: '', muted: false, camera: false, screen: false,
  localStream: null, speaking: false, peers: [],
};

/** Live call state for React components (one shared call per tab). */
export function useCall() {
  return useSyncExternalStore(calls.subscribe, calls.getState, () => server);
}
