'use client';
import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '../../lib/auth';
import { calls } from '../../lib/call';
import { CallBar } from './call-bar';
import { CallDock } from './call-dock';

/** One call audio/UI host for the authenticated app, independent of the current page. */
export function GlobalCallDock() {
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => { calls.cancelRinging(); calls.setStageOpen(false); }, [pathname]);
  if (!user) return null;
  return <>
    <CallDock onAccept={channelId => router.push(`/home?c=${encodeURIComponent(channelId)}`)} titleFor={(_id, caller) => `Huddle with ${caller}`} />
    {!pathname.startsWith('/home') && <div className="fixed bottom-20 left-4 z-40 sm:bottom-4 w-[min(320px,calc(100vw-32px))]"><CallBar /></div>}
  </>;
}
