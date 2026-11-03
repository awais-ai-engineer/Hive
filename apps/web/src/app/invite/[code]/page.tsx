'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '../../../lib/auth';
import { apiData, requestError } from '../../../lib/spaces';

type Preview = { space: { name: string; slug: string; type: string; description: string | null; member_count: number }; valid: boolean };

export default function InvitePage() {
  const { code } = useParams<{ code: string }>();
  const router = useRouter();
  const { user, loading } = useAuth();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('Loading invite…');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    apiData<Preview>(`/api/invites/${encodeURIComponent(code)}`).then(value => {
      if (active) { setPreview(value); setError(''); }
    }).catch(cause => { if (active) setError(requestError(cause)); });
    return () => { active = false; };
  }, [code]);

  async function accept() {
    if (!user) { router.push(`/login?next=${encodeURIComponent(`/invite/${code}`)}`); return; }
    setBusy(true); setError('');
    try {
      const space = await apiData<{ slug: string }>(`/api/invites/${encodeURIComponent(code)}/accept`, { method: 'POST' });
      router.push(`/s/${space.slug}`);
    } catch (cause) { setError(requestError(cause)); }
    finally { setBusy(false); }
  }

  return <main className="mx-auto max-w-lg px-4 py-16">
    <section className="rounded-xl border border-white/10 bg-white/[0.03] p-6">
      <h1 className="text-2xl font-bold">You’ve been invited</h1>
      {error && <p role="alert" className="mt-4 text-rose-400">{error}</p>}
      {preview && <><h2 className="mt-5 text-xl">{preview.space.name}</h2>
        <p className="mt-1 capitalize text-white/50">{preview.space.type} · {preview.space.member_count} members</p>
        {preview.space.description && <p className="mt-3 text-white/70">{preview.space.description}</p>}
        {!preview.valid && <p className="mt-4 text-rose-400">This invite has expired, was revoked, or has been used up.</p>}
        {preview.valid && (loading ? <p className="mt-4">Loading account…</p> : user ?
          <button onClick={accept} disabled={busy} className="auth-button mt-5">{busy ? 'Joining…' : 'Accept invite'}</button> :
          <Link className="auth-button mt-5 inline-block" href={`/login?next=${encodeURIComponent(`/invite/${code}`)}`}>Log in to accept</Link>)}
      </>}
    </section>
  </main>;
}
