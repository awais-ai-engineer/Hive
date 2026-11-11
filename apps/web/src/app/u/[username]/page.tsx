'use client';

import { Button as UiButton, LoadingState } from '@hive/ui';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Avatar } from '../../../components/ui/avatar';
import { Icon } from '../../../components/ui/icons';
import { ReportDialog } from '../../../components/report-dialog';
import { API_URL, apiFetch } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { apiData, requestError } from '../../../lib/spaces';

type Profile = {
  id: string; username: string; display_name: string | null; avatar_url: string | null; cover_url: string | null; bio: string | null;
  status_text: string | null; status_emoji: string | null; created_at: string; online: boolean;
  shared_spaces: { slug: string; name: string; type: 'community' | 'workspace' }[]; blocked_by_me: boolean;
};

export default function ProfilePage() {
  const { username } = useParams<{ username: string }>();
  const router = useRouter();
  const { user, loading } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (loading) return;
    setProfile(null); setMissing(false);
    apiData<Profile>(`/api/users/${encodeURIComponent(username)}`).then(setProfile)
      .catch(cause => { const text = requestError(cause); if (/not found|exist/i.test(text)) setMissing(true); else setError(text); });
  }, [username, loading, user?.id]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(false); };
    const esc = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [menu]);

  async function message() {
    if (!profile) return;
    setBusy(true); setError('');
    try {
      const conversation = await apiData<{ id: string }>('/api/dms', { method: 'POST', body: JSON.stringify({ usernames: [profile.username] }) });
      router.push(`/home?c=${conversation.id}`);
    } catch (cause) { setError(requestError(cause)); setBusy(false); }
  }
  async function toggleBlock() {
    if (!profile) return;
    setBusy(true); setError('');
    try {
      const response = await apiFetch(profile.blocked_by_me ? `/api/me/blocks/${profile.id}` : '/api/me/blocks', profile.blocked_by_me
        ? { method: 'DELETE' } : { method: 'POST', body: JSON.stringify({ user_id: profile.id }) });
      if (!response.ok) throw new Error('Something went wrong. Please try again.');
      setProfile({ ...profile, blocked_by_me: !profile.blocked_by_me });
      setConfirmBlock(false); setMenu(false);
    } catch (cause) { setError(requestError(cause)); }
    finally { setBusy(false); }
  }

  if (missing) return <main className="mx-auto max-w-md px-4 py-20 text-center">
    <h1 className="text-2xl font-bold">This person doesn’t exist</h1>
    <p className="mt-2 text-white/60">Check the username, or they may have changed it.</p>
    <Link href="/spaces" className="auth-button mt-6">Explore spaces</Link>
  </main>;
  if (!profile) return error ? <main role="alert" className="p-16 text-center text-white/60">{error}</main> : <LoadingState label="Loading profile" />;

  const own = user?.id === profile.id;
  const name = profile.display_name || profile.username;
  const joined = new Date(profile.created_at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const item = 'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left justify-start text-sm hover:bg-[var(--surface-2)]';
  return <main className="mx-auto max-w-2xl px-4 py-6">
    <article className="card overflow-hidden">
      <div className="relative h-32 overflow-hidden bg-gradient-to-br from-[#fcd77f] via-[#f2a516] to-[#15171c] sm:h-40">
        {profile.cover_url && <img src={profile.cover_url.startsWith('/') ? `${API_URL}${profile.cover_url}` : profile.cover_url} alt="" className="h-full w-full object-cover" />}
        {own && <Link href="/settings" className="absolute right-3 top-3 rounded-lg bg-[rgb(0_0_0/0.5)] px-3 py-1.5 text-sm font-medium hover:bg-[rgb(0_0_0/0.7)]" style={{ color: '#fff' }}>Edit cover</Link>}
      </div>
      <div className="px-5 pb-6 sm:px-8">
        <div className="-mt-12 flex items-end justify-between gap-3">
          <div className="rounded-full border-4 border-[var(--surface)] bg-surface"><Avatar name={profile.username} src={profile.avatar_url} size={96} online={profile.online} /></div>
          <div className="flex items-center gap-2 pb-1">
            {own ? <Link href="/settings" className="btn-ghost"><Icon name="edit" size={16} />Edit profile</Link>
              : user && <>
                {!profile.blocked_by_me && <UiButton type="button" onClick={message} disabled={busy} className="auth-button"><Icon name="message" size={16} />Message</UiButton>}
                <div ref={menuRef} className="relative">
                  <UiButton tooltip="More actions" type="button" aria-label="More actions" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(value => !value)} className="btn-ghost !px-2.5"><Icon name="more" /></UiButton>
                  {menu && <div role="menu" className="card animate-in absolute right-0 z-20 mt-2 w-44 p-1 shadow-[var(--shadow-pop)]">
                    <UiButton role="menuitem" className={item} onClick={() => { setMenu(false); setConfirmBlock(true); }}>{profile.blocked_by_me ? 'Unblock' : 'Block'}</UiButton>
                    <UiButton role="menuitem" className={item} onClick={() => { setMenu(false); setReporting(true); }}>Report</UiButton>
                  </div>}
                </div></>}
          </div>
        </div>

        <h1 className="mt-3 text-2xl font-extrabold tracking-tight">{name}</h1>
        <p className="text-white/55">@{profile.username}</p>
        {(profile.status_text || profile.status_emoji) && <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-3 py-1 text-sm font-medium text-brand">
          {profile.status_emoji && <span aria-hidden>{profile.status_emoji}</span>}{profile.status_text}</p>}
        {profile.bio && <p className="mt-3 whitespace-pre-wrap break-words text-white/85">{profile.bio}</p>}
        <p className="mt-3 text-sm text-white/50">Joined {joined}</p>

        {error && <p role="alert" className="mt-4 rounded-xl bg-rose-500/10 px-3 py-2 text-sm text-rose-500">{error}</p>}
        {profile.blocked_by_me && <p className="mt-4 text-sm text-white/60">You’ve blocked this person.</p>}
        {confirmBlock && <div role="alertdialog" aria-label={profile.blocked_by_me ? 'Unblock' : 'Block'} className="mt-4 rounded-xl border border-white/10 bg-[var(--surface-2)] p-4">
          <p className="text-sm">{profile.blocked_by_me ? `Unblock ${name}? They’ll be able to message you again.` : `Block ${name}? They won’t be able to message you.`}</p>
          <div className="mt-3 flex gap-2">
            <UiButton type="button" onClick={toggleBlock} disabled={busy} className="auth-button text-sm">{profile.blocked_by_me ? 'Unblock' : 'Block'}</UiButton>
            <UiButton type="button" onClick={() => setConfirmBlock(false)} className="btn-ghost">Cancel</UiButton>
          </div>
        </div>}

        {!own && <section className="mt-6">
          <h2 className="text-sm font-semibold text-white/70">Spaces you share</h2>
          {profile.shared_spaces.length ? <ul className="mt-2 flex flex-wrap gap-2">{profile.shared_spaces.map(space => <li key={space.slug}>
            <Link href={`/s/${space.slug}`} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-[var(--surface-2)] px-3 py-1 text-sm font-medium hover:border-brand/50">
              <Icon name={space.type === 'workspace' ? 'lock' : 'globe'} size={13} />{space.name}</Link></li>)}</ul>
            : <p className="mt-2 text-sm text-white/50">You don’t share any spaces yet.</p>}
        </section>}
      </div>
    </article>
    <ReportDialog target={reporting ? { type: 'user', id: profile.id, label: `@${profile.username}` } : null} onClose={() => setReporting(false)} />
  </main>;
}
