'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { spaceCreateSchema, type SpaceCreateInput } from '@hive/shared';
import { useAuth } from '../../../lib/auth';
import { apiData, requestError, type Space } from '../../../lib/spaces';

function makeSlug(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

export default function NewSpacePage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [type, setType] = useState<'community' | 'workspace'>('community');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace('/login?next=%2Fspaces%2Fnew');
  }, [loading, user, router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    const input: SpaceCreateInput = {
      name,
      slug,
      type,
      description: String(form.get('description') ?? '') || undefined,
      allowed_email_domain: type === 'workspace' ? String(form.get('allowed_email_domain') ?? '') || undefined : undefined,
    };
    const parsed = spaceCreateSchema.safeParse(input);
    if (!parsed.success) { setError(parsed.error.issues[0].message); setBusy(false); return; }
    try {
      const space = await apiData<Space>('/api/spaces', { method: 'POST', body: JSON.stringify(parsed.data) });
      router.push(`/s/${space.slug}`);
    } catch (cause) { setError(requestError(cause)); }
    finally { setBusy(false); }
  }

  if (!loading && !user) return null;
  return <main className="mx-auto max-w-lg px-4 py-12">
    <h1 className="text-3xl font-bold">Create a space</h1>
    <form className="mt-6 space-y-4" onSubmit={submit}>
      <fieldset><legend className="mb-2">Space type</legend><div className="flex gap-5">
        {(['community', 'workspace'] as const).map(option => <label key={option} className="flex items-center gap-2 capitalize">
          <input type="radio" name="type" checked={type === option} onChange={() => setType(option)} />{option}
        </label>)}
      </div></fieldset>
      <label className="block">Name<input className="auth-input" required minLength={2} maxLength={60} value={name}
        onChange={event => { setName(event.target.value); if (!slugEdited) setSlug(makeSlug(event.target.value)); }} /></label>
      <label className="block">Slug<input className="auth-input" required minLength={3} maxLength={50} value={slug}
        onChange={event => { setSlugEdited(true); setSlug(event.target.value); }} /></label>
      <label className="block">Description<textarea className="auth-input" name="description" maxLength={500} rows={3} /></label>
      {type === 'workspace' && <label className="block">Allowed email domain
        <input className="auth-input" name="allowed_email_domain" placeholder="acme.test" /></label>}
      {error && <p role="alert" className="text-rose-400">{error}</p>}
      <button disabled={busy || loading} className="auth-button">{busy ? 'Creating…' : 'Create space'}</button>
    </form>
  </main>;
}
