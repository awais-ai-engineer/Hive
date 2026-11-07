'use client';

import { useEffect, useState } from 'react';

/** "4:05" since the huddle connected; empty before that. */
export function useCallTimer(connected: boolean) {
  const [started, setStarted] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setStarted(connected ? Date.now() : null); }, [connected]);
  useEffect(() => {
    if (!started) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [started]);
  if (!started) return '';
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  const hours = Math.floor(seconds / 3600);
  const rest = `${Math.floor((seconds % 3600) / 60)}`.padStart(hours ? 2 : 1, '0') + ':' + `${seconds % 60}`.padStart(2, '0');
  return hours ? `${hours}:${rest}` : rest;
}
