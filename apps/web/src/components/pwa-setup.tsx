'use client';

import { useEffect } from 'react';
import { registerServiceWorker } from '../lib/push';

/** Registers the service worker (offline page and push) in production builds. */
export function PwaSetup() {
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') void registerServiceWorker().catch(() => {});
  }, []);
  return null;
}
