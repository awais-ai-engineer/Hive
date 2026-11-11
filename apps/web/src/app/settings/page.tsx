'use client';

import { FileDropzone as UiFileDropzone, Button as UiButton, Input as UiInput, Textarea as UiTextarea, Radio as UiRadio, Select as UiSelect } from '@hive/ui';

import { LanguagePicker } from '../../components/language-picker';
import { playMessageSound, setSoundsEnabled, soundsEnabled } from '../../lib/sounds';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Avatar } from '../../components/ui/avatar';
import { InterestsSettings } from '../../components/communities/interests-settings';
import { StatusDialog } from '../../components/status-dialog';
import { activeStatus, statusTitle } from '../../lib/status';
import { API_URL, apiFetch, responseData, uploadFile, type User } from '../../lib/api';
import { ImageCropper } from '../../components/image-cropper';
import { TYPE_LABELS } from '../../lib/notifications';
import { notificationTypes, type NotificationType } from '@hive/shared';
import { useAuth } from '../../lib/auth';
import { apiData, requestError } from '../../lib/spaces';
import { useAiStatus } from '../../lib/ai';
import { DevicesCard, PushCard } from '../../components/settings-extras';

type Section = 'profile' | 'notifications' | 'privacy' | 'blocked' | 'interests';
const sections: [Section, string][] = [['profile', 'Profile'], ['notifications', 'Notifications'], ['privacy', 'Privacy'], ['blocked', 'Blocked people'], ['interests', 'Interests']];

function Saved({ show }: { show: boolean }) {
  return <span role="status" className="text-sm font-medium text-emerald-500">{show ? 'Saved' : ''}</span>;
}

async function patchMe(body: object) {
  return responseData<User>(await apiFetch('/api/me', { method: 'PATCH', body: JSON.stringify(body) }));
}

function ProfileCard({ user, updateUser }: { user: User; updateUser: (user: User) => void }) {
  const [displayName, setDisplayName] = useState(user.display_name ?? '');
  const [username, setUsername] = useState(user.username);
  const [bio, setBio] = useState(user.bio ?? '');
  const [editingStatus, setEditingStatus] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [cropping, setCropping] = useState<{ file: File; shape: 'avatar' | 'cover' } | null>(null);
  const [photoError, setPhotoError] = useState('');
  const avatarInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);

  function pick(shape: 'avatar' | 'cover', chosen?: File) {
    setPhotoError('');
    if (avatarInput.current) avatarInput.current.value = '';
    if (coverInput.current) coverInput.current.value = '';
    if (!chosen) return;
    if (!chosen.type.startsWith('image/')) return setPhotoError('Please choose an image file.');
    const limit = shape === 'avatar' ? 5 : 8;
    if (chosen.size > limit * 1024 * 1024) return setPhotoError(`That image is over ${limit} MB. Please pick a smaller one.`);
    setCropping({ file: chosen, shape });
  }
  async function upload(image: File) {
    if (!cropping) return;
    const shape = cropping.shape;
    setPhotoError('');
    try {
      updateUser(await uploadFile<User>(`/api/me/${shape}`, image, () => {}));
      setCropping(null);
    } catch (cause) { setPhotoError(requestError(cause)); throw cause; }
  }
  async function removeImage(shape: 'avatar' | 'cover') {
    setPhotoError('');
    try { updateUser(await responseData<User>(await apiFetch(`/api/me/${shape}`, { method: 'DELETE' }))); }
    catch (cause) { setPhotoError(requestError(cause)); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(''); setSaved(false);
    try {
      updateUser(await patchMe({ username: username.trim(), display_name: displayName.trim(), bio: bio.trim()}));
      setSaved(true);
    } catch (cause) { setError(requestError(cause)); }
    finally { setBusy(false); }
  }

  return <form onSubmit={save} className="card space-y-6 p-5 sm:p-6">
    <div>
      <h2 className="text-lg font-bold">Profile photo</h2>
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <Avatar name={user.username} src={user.avatar_url} size={80} />
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <UiFileDropzone.Input ref={avatarInput} id="photo" accept="image/*" className="peer sr-only" onChange={event => pick('avatar', event.target.files?.[0])} />
            <label htmlFor="photo" className="btn-ghost cursor-pointer peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-[var(--ring)]">Upload photo</label>
            {user.avatar_url && <UiButton type="button" onClick={() => void removeImage('avatar')} className="btn-ghost text-rose-500">Remove</UiButton>}
          </div>
          <p className="text-xs text-white/50">PNG, JPG, GIF or WebP, up to 5 MB. You can crop and zoom before saving.</p>
        </div>
      </div>
    </div>

    <div>
      <h2 className="text-lg font-bold">Cover image</h2>
      <div className="mt-3 h-24 overflow-hidden rounded-xl bg-gradient-to-br from-[#fcd77f] via-[#f2a516] to-[#15171c]">
        {user.cover_url && <img src={user.cover_url.startsWith('/') ? `${API_URL}${user.cover_url}` : user.cover_url} alt="" className="h-full w-full object-cover" />}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <UiFileDropzone.Input ref={coverInput} id="cover" accept="image/*" className="peer sr-only" onChange={event => pick('cover', event.target.files?.[0])} />
        <label htmlFor="cover" className="btn-ghost cursor-pointer peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-[var(--ring)]">{user.cover_url ? 'Change cover' : 'Upload cover'}</label>
        {user.cover_url && <UiButton type="button" onClick={() => void removeImage('cover')} className="btn-ghost text-rose-500">Remove</UiButton>}
      </div>
      {photoError && <p role="alert" className="mt-2 text-sm text-rose-500">{photoError}</p>}
    </div>
    {cropping && <ImageCropper file={cropping.file} shape={cropping.shape} onCancel={() => setCropping(null)} onSave={upload} />}

    <div className="grid gap-4 sm:grid-cols-2">
      <label className="block text-sm font-medium">Display name
        <UiInput className="auth-input" value={displayName} maxLength={60} placeholder={user.username} onChange={event => setDisplayName(event.target.value)} />
      </label>
      <label className="block text-sm font-medium">Username
        <UiInput className="auth-input" value={username} required minLength={3} maxLength={32} pattern="[a-zA-Z0-9_]+" aria-describedby="uname-hint" onChange={event => setUsername(event.target.value)} />
        <span id="uname-hint" className="mt-1 block text-xs font-normal text-white/50">People mention you with @{username || 'username'}</span>
      </label>
    </div>

    <label className="block text-sm font-medium">About you
      <UiTextarea className="auth-input resize-none" rows={3} maxLength={300} value={bio} onChange={event => setBio(event.target.value)} placeholder="A line or two about what you do." />
      <span className="mt-1 block text-right text-xs font-normal text-white/50" aria-live="polite">{bio.length}/300</span>
    </label>

    <div>
      <p className="text-sm font-medium">Status</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span className="text-sm text-white/70">{(() => { const status = activeStatus(user); return status.emoji || status.text || status.away
          ? statusTitle(user)
          : 'No status set'; })()}</span>
        <UiButton type="button" className="btn-ghost" onClick={() => setEditingStatus(true)}>Set a status</UiButton>
      </div>
      <p className="mt-1 text-xs text-white/50">Let people know what you are up to, when it should clear, and if you are out of office.</p>
    </div>
    {editingStatus && <StatusDialog user={user} onSaved={updateUser} onClose={() => setEditingStatus(false)} />}

    {error && <p role="alert" className="text-sm text-rose-500">{error}</p>}
    <div className="flex items-center gap-3">
      <UiButton disabled={busy} className="auth-button">{busy ? 'Saving…' : 'Save changes'}</UiButton>
      <Saved show={saved} />
    </div>
  </form>;
}

const POLICIES = [
  ['everyone', 'Everyone in your spaces', 'Anyone who shares a space with you can start a conversation.'],
  ['workspaces', 'Only people in your workspaces', 'People you only share a community with can’t message you first.'],
  ['nobody', 'Nobody new', 'Existing conversations keep working. No one can start a new one.'],
] as const;

function PrivacyCard({ user, updateUser }: { user: User; updateUser: (user: User) => void }) {
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  async function change(body: object) {
    setError(''); setSaved(false);
    try { updateUser(await patchMe(body)); setSaved(true); }
    catch (cause) { setError(requestError(cause)); }
  }
  const policy = user.dm_policy ?? 'everyone';
  const offline = !!user.appear_offline;
  return <div className="space-y-5">
    <section className="card p-5 sm:p-6">
      <h2 className="text-lg font-bold">Who can send you new direct messages</h2>
      <div role="radiogroup" aria-label="Who can send you new direct messages" className="mt-3 space-y-2">
        {POLICIES.map(([value, title, text]) => <label key={value} className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition ${policy === value ? 'border-brand bg-brand-soft' : 'border-white/10 hover:bg-[var(--surface-2)]'}`}>
          <UiRadio name="dm_policy" className="mt-1 accent-[var(--brand)]" checked={policy === value} onChange={() => void change({ dm_policy: value })} />
          <span><span className="block font-semibold">{title}</span><span className="block text-sm text-white/60">{text}</span></span>
        </label>)}
      </div>
    </section>
    <section className="card flex items-start justify-between gap-4 p-5 sm:p-6">
      <div><h2 id="offline-label" className="text-lg font-bold">Appear offline</h2>
        <p className="mt-1 text-sm text-white/60">Others will see you as offline, even while you’re using Hive.</p></div>
      <UiButton type="button" role="switch" aria-checked={offline} aria-labelledby="offline-label" onClick={() => void change({ appear_offline: !offline })}
        className={`relative mt-1 h-6 w-11 shrink-0 rounded-full transition ${offline ? 'bg-brand' : 'bg-white/20'}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-[#fff] shadow transition-all ${offline ? 'left-[22px]' : 'left-0.5'}`} /></UiButton>
    </section>
    <p className="rounded-2xl bg-brand-soft p-4 text-sm text-brand">Your email is never shown to other people. Profiles show only spaces you both belong to.</p>
    {error && <p role="alert" className="text-sm text-rose-500">{error}</p>}
    <Saved show={saved} />
  </div>;
}

function TranslateCard({ user, updateUser }: { user: User; updateUser: (user: User) => void }) {
  const ai = useAiStatus();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  if (!ai) return null;
  async function change(value: string) {
    setError(''); setSaved(false);
    try { updateUser(await patchMe({ translate_language: value || null })); setSaved(true); }
    catch (cause) { setError(requestError(cause)); }
  }
  return <section className="card mt-5 p-5 sm:p-6">
    <h2 className="text-lg font-bold">Translation</h2>
    <label className="mt-3 block text-sm font-medium">Translate messages into
      <UiSelect aria-label="Translate messages into" className="auth-input" value={user.translate_language ?? ''} onChange={event => void change(event.target.value)}>
        <option value="">Don&apos;t offer translation</option>
        {ai.languages.map(item => <option key={item.code} value={item.code}>{item.name}</option>)}
      </UiSelect>
    </label>
    <p className="mt-2 text-sm text-white/60">When this is set, messages from other people show a small Translate link. Only the text you ask to translate is sent to the AI service.</p>
    {error && <p role="alert" className="mt-2 text-sm text-rose-500">{error}</p>}
    <Saved show={saved} />
  </section>;
}

function SoundCard() {
  const [on, setOn] = useState(true);
  useEffect(() => setOn(soundsEnabled()), []);
  function toggle() {
    const next = !on;
    setOn(next); setSoundsEnabled(next);
    if (next) playMessageSound();
  }
  return <section className="card mb-5 flex items-start justify-between gap-4 p-5 sm:p-6">
    <div><h2 className="text-lg font-bold">Sounds</h2>
      <p className="mt-1 text-sm text-white/60">Play a chime for new messages in conversations you aren&apos;t looking at, and a ringtone when someone calls you. Quiet conversations stay silent.</p></div>
    <UiButton tooltip="Notification sounds" type="button" role="switch" aria-checked={on} aria-label="Notification sounds" onClick={toggle}
      className={`relative mt-1 h-6 w-11 shrink-0 rounded-full transition ${on ? 'bg-brand' : 'bg-white/20'}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-[#fff] shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} /></UiButton>
  </section>;
}

function NotificationsCard() {
  const [prefs, setPrefs] = useState<Record<string, boolean> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    apiData<{ preferences: Record<string, boolean> }>('/api/notifications/preferences').then(result => setPrefs(result.preferences)).catch(cause => setError(requestError(cause)));
  }, []);
  async function toggle(type: NotificationType) {
    if (!prefs) return;
    const next = !prefs[type];
    setPrefs({ ...prefs, [type]: next });
    setError('');
    try {
      const result = await apiData<{ preferences: Record<string, boolean> }>('/api/notifications/preferences', { method: 'PUT', body: JSON.stringify({ preferences: { [type]: next } }) });
      setPrefs(result.preferences);
    } catch (cause) { setPrefs(current => current && { ...current, [type]: !next }); setError(requestError(cause)); }
  }
  return <section className="card p-5 sm:p-6">
    <h2 className="text-lg font-bold">Notifications</h2>
    <p className="mt-1 text-sm text-white/60">Choose what lands in your inbox. Muted spaces and quiet conversations still only let mentions through.</p>
    {error && <p role="alert" className="mt-2 text-sm text-rose-500">{error}</p>}
    {!prefs ? !error && <div role="status" aria-label="Loading notification settings" className="mt-4 h-40 animate-pulse rounded-xl bg-white/5" />
      : <ul className="mt-3 divide-y divide-white/10">{notificationTypes.map(type => <li key={type} className="flex items-start justify-between gap-4 py-3">
        <div><p id={`pref-${type}`} className="font-medium">{TYPE_LABELS[type].title}</p><p className="text-sm text-white/60">{TYPE_LABELS[type].hint}</p></div>
        <UiButton type="button" role="switch" aria-checked={prefs[type]} aria-labelledby={`pref-${type}`} onClick={() => void toggle(type)}
          className={`relative mt-1 h-6 w-11 shrink-0 rounded-full transition ${prefs[type] ? 'bg-brand' : 'bg-white/20'}`}>
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-[#fff] shadow transition-all ${prefs[type] ? 'left-[22px]' : 'left-0.5'}`} /></UiButton>
      </li>)}</ul>}
  </section>;
}

type Blocked = { id: string; username: string; avatar_url: string | null };

function BlockedCard() {
  const [list, setList] = useState<Blocked[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { apiData<Blocked[]>('/api/me/blocks').then(setList).catch(cause => setError(requestError(cause))); }, []);
  async function unblock(person: Blocked) {
    setError('');
    try {
      const response = await apiFetch(`/api/me/blocks/${person.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Could not unblock. Please try again.');
      setList(current => current?.filter(item => item.id !== person.id) ?? null);
    } catch (cause) { setError(requestError(cause)); }
  }
  return <section className="card p-5 sm:p-6">
    <h2 className="text-lg font-bold">Blocked people</h2>
    {error && <p role="alert" className="mt-2 text-sm text-rose-500">{error}</p>}
    {list === null ? !error && <p className="mt-3 text-sm text-white/60">Loading…</p>
      : list.length === 0 ? <p className="mt-3 text-sm text-white/60">You haven’t blocked anyone.</p>
      : <ul className="mt-3 divide-y divide-white/10">{list.map(person => <li key={person.id} className="flex items-center gap-3 py-3">
        <Avatar name={person.username} src={person.avatar_url} size={36} />
        <Link href={`/u/${person.username}`} className="flex-1 truncate font-medium hover:underline">{person.username}</Link>
        <UiButton type="button" className="btn-ghost" onClick={() => void unblock(person)}>Unblock</UiButton>
      </li>)}</ul>}
  </section>;
}

export default function SettingsPage() {
  const { user, loading, updateUser } = useAuth();
  const [section, setSection] = useState<Section>('profile');
  useEffect(() => { const wanted = new URLSearchParams(window.location.search).get('section'); if (sections.some(([id]) => id === wanted)) setSection(wanted as Section); }, []);
  if (loading) return <main className="p-16 text-center text-white/60">Loading…</main>;
  if (!user) return <main className="p-16 text-center"><Link className="font-semibold text-brand hover:underline" href="/login?next=/settings">Log in to see your settings</Link></main>;
  return <main className="mx-auto max-w-4xl px-4 py-8">
    <h1 className="mb-6 text-3xl font-extrabold tracking-tight">Settings</h1>
    <div className="grid gap-6 md:grid-cols-[200px_1fr]">
      <nav aria-label="Settings sections" className="flex gap-1 overflow-x-auto md:flex-col">
        {sections.map(([id, label]) => <UiButton key={id} type="button" aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}
          className={`whitespace-nowrap rounded-xl px-3 py-2 text-left justify-start text-sm font-medium transition ${section === id ? 'bg-brand-soft text-brand' : 'text-white/65 hover:bg-[var(--surface-2)] hover:text-white'}`}>{label}</UiButton>)}
        <Link href="/communities/manage" className="rounded-xl px-3 py-2 text-sm text-brand">Manage communities</Link>
      </nav>
      <div className="min-w-0">
        {section === 'profile' && <><ProfileCard user={user} updateUser={updateUser} /><section className="card mt-5 p-5 sm:p-6"><LanguagePicker /><p className="mt-2 text-sm text-white/60">Changes the language of Hive's menus and buttons on this device.</p></section><TranslateCard user={user} updateUser={updateUser} /></>}
        {section === 'notifications' && <><SoundCard /><NotificationsCard /><PushCard /></>}
        {section === 'privacy' && <><PrivacyCard user={user} updateUser={updateUser} /><DevicesCard /></>}
        {section === 'blocked' && <BlockedCard />}
        {section === 'interests' && <InterestsSettings />}
      </div>
    </div>
  </main>;
}
