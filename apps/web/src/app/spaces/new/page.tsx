'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { spaceCreateSchema, type SpaceCreateInput } from '@hive/shared';
import { Icon } from '../../../components/ui/icons';
import { CategoryPicker } from '../../../components/interest-picker';
import { TagsInput } from '../../../components/communities/tags-input';
import { DomainInput } from '../../../components/spaces/domain-input';
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
  const [type, setType] = useState<'community' | 'workspace'>('workspace');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState('other');
  const [tags, setTags] = useState<string[]>([]);

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
      category: type === 'community' ? category : 'other',
      tags: type === 'community' ? tags : [],
      description: String(form.get('description') ?? '') || undefined,
      allowed_email_domain: type === 'workspace' ? String(form.get('allowed_email_domain') ?? '').trim() || undefined : undefined,
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
  const kinds = [
    { value: 'workspace', icon: 'lock', title: 'Private workspace', text: 'For your team or company. Only people you invite can see it. Chat, files and posts stay private.' },
    { value: 'community', icon: 'globe', title: 'Public community', text: 'For open groups. Anyone can find it and read posts; members can chat.' },
  ] as const;
  return <main className="mx-auto max-w-xl px-4 py-12">
    <h1 className="text-3xl font-bold">Create a space</h1>
    <p className="mt-2 text-white/60">Choose who this space is for. You can invite people right after.</p>
    <form className="mt-6 space-y-5" onSubmit={submit}>
      <fieldset><legend className="sr-only">Space type</legend>
        <div className="grid gap-3 sm:grid-cols-2" role="radiogroup">
          {kinds.map(kind => <label key={kind.value} className={`card cursor-pointer p-4 transition ${type === kind.value ? 'ring-2 ring-[var(--brand)]' : 'hover:bg-brand-soft'}`}>
            <input className="sr-only" type="radio" name="type" checked={type === kind.value} onChange={() => setType(kind.value)} />
            <span className="flex items-center gap-2 font-semibold"><span className="text-brand"><Icon name={kind.icon} size={20} /></span>{kind.title}</span>
            <span className="mt-2 block text-sm text-white/60">{kind.text}</span>
          </label>)}
        </div>
      </fieldset>
      <label className="block font-medium">Name<input className="auth-input" required minLength={2} maxLength={60} value={name}
        onChange={event => { setName(event.target.value); if (!slugEdited) setSlug(makeSlug(event.target.value)); }} />
        <span className="text-sm font-normal text-white/55">What people will see in the sidebar and search.</span></label>
      <label className="block font-medium">Slug<input className="auth-input" required minLength={3} maxLength={50} value={slug}
        onChange={event => { setSlugEdited(true); setSlug(event.target.value); }} />
        <span className="text-sm font-normal text-white/55">Used in the web address: /s/{slug || 'your-space'}. Lowercase letters, numbers and dashes.</span></label>
      <label className="block font-medium">Description<textarea className="auth-input" name="description" maxLength={500} rows={3} />
        <span className="text-sm font-normal text-white/55">Optional. A sentence about what this space is for.</span></label>
      {type === 'community' && <><fieldset><legend className="mb-3 font-medium">Category</legend><CategoryPicker value={[category]} onChange={values => setCategory(values[0] ?? 'other')} /></fieldset><TagsInput value={tags} onChange={setTags} /></>}
      {type === 'workspace' && <DomainInput />}
      {error && <p role="alert" className="text-rose-400">{error}</p>}
      <button disabled={busy || loading} className="auth-button">{busy ? 'Creating…' : 'Create space'}</button>
    </form>
  </main>;
}
