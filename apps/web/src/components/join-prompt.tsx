'use client';

import { Button as UiButton } from '@hive/ui';

import Link from 'next/link';
import { useState } from 'react';
import { apiData, requestError } from '../lib/spaces';
import { Icon } from './ui/icons';

/** Shown instead of a community's chat when the viewer is not a member (chat is members-only). */
export function JoinPrompt({ space, loggedIn }: { space: { name: string; slug: string }; loggedIn: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function join() {
    setBusy(true); setError('');
    try {
      await apiData(`/api/spaces/${encodeURIComponent(space.slug)}/join`, { method: 'POST' });
      window.location.reload();
    } catch (cause) { setError(requestError(cause)); setBusy(false); }
  }
  const next = typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search;
  return <div className="flex flex-1 items-center justify-center p-6">
    <div className="card max-w-sm p-8 text-center">
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-soft text-brand"><Icon name="message" size={24} /></span>
      {loggedIn ? <>
        <h2 className="mt-4 text-lg font-bold">Join {space.name} to read and join the conversation</h2>
        <p className="mt-1 text-sm text-white/60">Chat in this community is for members. Posts are still open to everyone.</p>
        <UiButton type="button" disabled={busy} onClick={() => void join()} className="auth-button mt-5">{busy ? 'Joining…' : 'Join community'}</UiButton>
      </> : <>
        <h2 className="mt-4 text-lg font-bold">Log in to read this community&apos;s chat</h2>
        <p className="mt-1 text-sm text-white/60">Chat is for members. Posts are still open to everyone.</p>
        <Link href={`/login?next=${encodeURIComponent(next)}`} className="auth-button mt-5 inline-block">Log in</Link>
      </>}
      {error && <p role="alert" className="mt-3 text-sm text-rose-500">{error}</p>}
    </div>
  </div>;
}
