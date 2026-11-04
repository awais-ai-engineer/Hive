'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';

/** Conversations now live on the Home screen; keep old links working. */
function Redirect() {
  const router = useRouter();
  const conversation = useSearchParams().get('c');
  useEffect(() => {
    router.replace(conversation ? `/home?c=${encodeURIComponent(conversation)}` : '/home');
  }, [conversation, router]);
  return <p className="p-8 text-white/50">Opening Home…</p>;
}

export default function MessagesPage() {
  return <Suspense><Redirect /></Suspense>;
}
