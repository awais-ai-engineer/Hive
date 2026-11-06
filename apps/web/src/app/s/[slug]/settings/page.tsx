'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { channelCreateSchema, inviteCreateSchema, spacePatchSchema } from '@hive/shared';
import { SpaceKind } from '../../../../components/ui/space-kind';
import { CategoryPicker } from '../../../../components/interest-picker';
import { TagsInput } from '../../../../components/communities/tags-input';
import { RulesEditor } from '../../../../components/communities/rules';
import { useAuth } from '../../../../lib/auth';
import { apiData, requestError, spaceKindLabel, type Channel, type Space } from '../../../../lib/spaces';

type Invite = { id: string; code: string; max_uses: number | null; uses: number;
  expires_at: string | null; revoked_at: string | null; created_at: string };
const rank: Record<string, number> = { owner: 5, admin: 4, moderator: 3, member: 2, guest: 1 };

export default function SettingsPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const { user, loading } = useAuth();
  const [space, setSpace] = useState<Space | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [error, setError] = useState('Loading settings…');
  const [busy, setBusy] = useState(false);
  const [newInvite, setNewInvite] = useState('');
  const [category, setCategory] = useState('other');
  const [tags, setTags] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  async function load() {
    const [spaceData, channelData, inviteData] = await Promise.all([
      apiData<Space>(`/api/spaces/${encodeURIComponent(slug)}`),
      apiData<Channel[]>(`/api/spaces/${encodeURIComponent(slug)}/channels`),
      apiData<Invite[]>(`/api/spaces/${encodeURIComponent(slug)}/invites`),
    ]);
    setSpace(spaceData); setChannels(channelData); setInvites(inviteData); setError('');
    setCategory(spaceData.category); setTags(spaceData.tags);
    // Arriving from "Invite people" in the sidebar: bring the invites into view.
    if (window.location.hash === '#invites') requestAnimationFrame(() => document.getElementById('invites')?.scrollIntoView());
  }

  useEffect(() => {
    if (loading) return;
    load().catch(cause => setError(requestError(cause)));
  }, [slug, loading, user]);

  async function saveSpace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false);
    const form = new FormData(event.currentTarget);
    const parsed = spacePatchSchema.safeParse({
      name: form.get('name'), description: form.get('description'),
      category: space?.type === 'community' ? category : undefined,
      tags: space?.type === 'community' ? tags : undefined,
      allowed_email_domain: space?.type === 'workspace' ? form.get('allowed_email_domain') || null : undefined,
    });
    if (!parsed.success) { setError(parsed.error.issues[0].message); setBusy(false); return; }
    try { await apiData(`/api/spaces/${encodeURIComponent(slug)}`, { method: 'PATCH', body: JSON.stringify(parsed.data) }); await load(); setSaved(true); }
    catch (cause) { setError(requestError(cause)); }
    finally { setBusy(false); }
  }

  async function togglePublicChat(value: boolean) {
    setError('');
    try { await apiData(`/api/spaces/${encodeURIComponent(slug)}`, { method: 'PATCH', body: JSON.stringify({ public_chat: value }) }); await load(); }
    catch (cause) { setError(requestError(cause)); }
  }

  async function addChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const parsed = channelCreateSchema.safeParse({ name: form.get('name'), type: form.get('type'), topic: form.get('topic') || undefined });
    if (!parsed.success) { setError(parsed.error.issues[0].message); return; }
    try { await apiData(`/api/spaces/${encodeURIComponent(slug)}/channels`, { method: 'POST', body: JSON.stringify(parsed.data) }); formElement.reset(); await load(); }
    catch (cause) { setError(requestError(cause)); }
  }

  async function editChannel(channel: Channel, changes: object) {
    try {
      await apiData(`/api/spaces/${encodeURIComponent(slug)}/channels/${channel.id}`, { method: 'PATCH', body: JSON.stringify(changes) });
      await load();
    } catch (cause) { setError(requestError(cause)); }
  }

  async function moveChannel(index: number, offset: -1 | 1) {
    const current = channels[index];
    const neighbor = channels[index + offset];
    if (!current || !neighbor) return;
    try {
      await Promise.all([
        apiData(`/api/spaces/${encodeURIComponent(slug)}/channels/${current.id}`, {
          method: 'PATCH', body: JSON.stringify({ position: neighbor.position }),
        }),
        apiData(`/api/spaces/${encodeURIComponent(slug)}/channels/${neighbor.id}`, {
          method: 'PATCH', body: JSON.stringify({ position: current.position }),
        }),
      ]);
      await load();
    } catch (cause) { setError(requestError(cause)); }
  }

  async function removeChannel(channel: Channel) {
    try { await apiData(`/api/spaces/${encodeURIComponent(slug)}/channels/${channel.id}`, { method: 'DELETE' }); await load(); }
    catch (cause) { setError(requestError(cause)); }
  }

  async function addInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const maxUses = form.get('max_uses'); const hours = form.get('expires_in_hours');
    const parsed = inviteCreateSchema.safeParse({ max_uses: maxUses ? Number(maxUses) : undefined,
      expires_in_hours: hours ? Number(hours) : undefined });
    if (!parsed.success) { setError(parsed.error.issues[0].message); return; }
    try {
      const invite = await apiData<Invite>(`/api/spaces/${encodeURIComponent(slug)}/invites`, { method: 'POST', body: JSON.stringify(parsed.data) });
      setNewInvite(`http://localhost:3000/invite/${invite.code}`); formElement.reset(); await load();
    } catch (cause) { setError(requestError(cause)); }
  }

  async function revoke(invite: Invite) {
    try { await apiData(`/api/spaces/${encodeURIComponent(slug)}/invites/${invite.id}`, { method: 'DELETE' }); await load(); }
    catch (cause) { setError(requestError(cause)); }
  }

  async function deleteSpace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get('confirm_slug') !== slug) { setError('Enter the space slug to confirm deletion.'); return; }
    if (!window.confirm(`Delete ${slug}? This cannot be undone.`)) return;
    setBusy(true);
    try { await apiData(`/api/spaces/${encodeURIComponent(slug)}`, { method: 'DELETE' }); router.push('/spaces'); }
    catch (cause) { setError(requestError(cause)); }
    finally { setBusy(false); }
  }

  if (loading || !space) return <main className="mx-auto max-w-3xl px-4 py-10">
    <Link href={`/s/${slug}`} className="text-amber-400">← Back to space</Link>
    {error && <p role="alert" className="mt-4 text-rose-400">{error}</p>}
  </main>;
  if (!space.my_role || rank[space.my_role] < rank.admin) return <main className="mx-auto max-w-3xl px-4 py-10">
    <p role="alert" className="text-rose-400">Insufficient role</p></main>;

  return <main className="mx-auto max-w-3xl space-y-10 px-4 py-10">
    <div><Link href={`/s/${slug}`} className="text-sm text-amber-400">← {space.name}</Link>
      <h1 className="mt-2 text-3xl font-bold">Space settings</h1></div>
    {error && <p role="alert" className="text-rose-400">{error}</p>}
    <section className="card p-5"><h2 className="mb-2 flex items-center gap-2 text-xl font-semibold"><SpaceKind space={space} size={18} />Privacy</h2>
      <p className="text-white/70"><strong>{spaceKindLabel(space)}.</strong> {space.type === 'workspace'
        ? 'Only people you invite can find or open this space. Outsiders see nothing, not even that it exists. Chat, files and posts are visible to members only.'
        : `Anyone can find this community and read its posts. ${space.public_chat ? 'Anyone can also read the chat without joining.' : 'Only members can read and join the chat.'} Posting always requires membership.`}</p>
      {space.type === 'community' && <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl bg-brand-soft p-3">
        <input type="checkbox" role="switch" className="mt-1" checked={space.public_chat} onChange={event => void togglePublicChat(event.target.checked)} />
        <span><span className="block font-semibold">Public chat</span>
          <span className="text-sm text-white/60">Let anyone read this community&apos;s chat without joining (posting still requires membership).</span></span>
      </label>}
    </section>
    <section><h2 className="mb-4 text-xl font-semibold">Details</h2>
      <form onSubmit={saveSpace} className="space-y-3">
        <label className="block">Name<input name="name" className="auth-input" required minLength={2} maxLength={60} defaultValue={space.name} /></label>
        <label className="block">Description<textarea name="description" className="auth-input" maxLength={500} defaultValue={space.description ?? ''} /></label>
        {space.type === 'community' && <><fieldset><legend className="mb-3 font-medium">Category</legend><CategoryPicker value={[category]} onChange={values => { setCategory(values[0] ?? 'other'); setSaved(false); }} /></fieldset><TagsInput value={tags} onChange={setTags} /></>}
        {space.type === 'workspace' && <label className="block">Allowed email domain<input name="allowed_email_domain" className="auth-input" defaultValue={space.allowed_email_domain ?? ''} placeholder="acme.test" /></label>}
        <button disabled={busy} className="auth-button">Save details</button>
        {saved && <p role="status" className="text-sm text-brand">Details saved</p>}
      </form>
    </section>
    {space.type === 'community' && <RulesEditor slug={slug} />}
    <section><h2 className="mb-4 text-xl font-semibold">Channels</h2>
      <ul className="space-y-3">{channels.map((channel, index) => <li key={channel.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 p-3">
        <input aria-label={`Channel name ${channel.name}`} className="auth-input my-0 w-44" maxLength={80} defaultValue={channel.name}
          onBlur={event => { if (event.target.value !== channel.name) editChannel(channel, { name: event.target.value }); }} />
        <input aria-label={`Topic ${channel.name}`} className="auth-input my-0 min-w-40 flex-1" maxLength={250} defaultValue={channel.topic ?? ''} placeholder="Topic"
          onBlur={event => { if (event.target.value !== (channel.topic ?? '')) editChannel(channel, { topic: event.target.value || null }); }} />
        <button aria-label={`Move ${channel.name} up`} disabled={index === 0} onClick={() => moveChannel(index, -1)}>↑</button>
        <button aria-label={`Move ${channel.name} down`} disabled={index === channels.length - 1} onClick={() => moveChannel(index, 1)}>↓</button>
        <button onClick={() => removeChannel(channel)} className="text-rose-400">Delete</button>
      </li>)}</ul>
      <form onSubmit={addChannel} className="mt-4 flex flex-wrap items-end gap-3">
        <label>Name<input name="name" className="auth-input" required maxLength={80} /></label>
        <label>Type<select name="type" className="auth-input"><option value="text">Text</option><option value="voice">Voice</option></select></label>
        <label>Topic<input name="topic" className="auth-input" maxLength={250} /></label>
        <button className="auth-button">Add channel</button>
      </form>
    </section>
    <section id="invites" className="scroll-mt-4"><h2 className="mb-4 text-xl font-semibold">Invites</h2>
      <form onSubmit={addInvite} className="flex flex-wrap items-end gap-3">
        <label>Maximum uses<input name="max_uses" type="number" min={1} max={1000} className="auth-input" placeholder="Unlimited" /></label>
        <label>Expires in hours<input name="expires_in_hours" type="number" min={1} max={720} className="auth-input" placeholder="Never" /></label>
        <button className="auth-button">Create invite</button>
      </form>
      {newInvite && <div className="mt-4 flex flex-wrap items-center gap-3 rounded border border-white/10 p-3">
        <a href={newInvite} className="break-all text-amber-400">{newInvite}</a>
        <button onClick={() => navigator.clipboard.writeText(newInvite)} className="auth-button">Copy</button>
      </div>}
      <ul className="mt-4 space-y-2">{invites.map(invite => <li key={invite.id} className="flex items-center justify-between gap-4 border-b border-white/10 py-2">
        <span className="break-all">{invite.code} · {invite.uses}/{invite.max_uses ?? '∞'} uses
          {invite.revoked_at && <span className="text-white/50"> · revoked</span>}</span>
        {!invite.revoked_at && <button onClick={() => revoke(invite)} className="text-rose-400">Revoke</button>}
      </li>)}</ul>
    </section>
    {space.my_role === 'owner' && <section className="border-t border-rose-500/30 pt-6">
      <h2 className="mb-3 text-xl font-semibold text-rose-400">Delete space</h2>
      <form onSubmit={deleteSpace} className="flex flex-wrap items-end gap-3">
        <label>Type <code>{slug}</code> to confirm<input name="confirm_slug" className="auth-input" required /></label>
        <button disabled={busy} className="rounded-lg bg-rose-500 px-4 py-2 font-medium text-white">Delete space</button>
      </form>
    </section>}
  </main>;
}
