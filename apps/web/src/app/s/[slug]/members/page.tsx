'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '../../../../lib/auth';
import { apiData, requestError, type Member, type Space } from '../../../../lib/spaces';

const roles = ['owner', 'admin', 'moderator', 'member', 'guest'] as const;
const rank: Record<string, number> = { owner: 5, admin: 4, moderator: 3, member: 2, guest: 1 };

export default function MembersPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const { user, loading } = useAuth();
  const [space, setSpace] = useState<Space | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('Loading members…');

  async function load() {
    const [data, page] = await Promise.all([
      apiData<Space>(`/api/spaces/${encodeURIComponent(slug)}`),
      apiData<{ items: Member[]; next_cursor: string | null }>(`/api/spaces/${encodeURIComponent(slug)}/members`),
    ]);
    setSpace(data); setMembers(page.items); setCursor(page.next_cursor); setError('');
  }

  useEffect(() => {
    if (loading) return;
    load().catch(cause => setError(requestError(cause)));
  }, [slug, loading, user]);

  async function message(member: Member) {
    try {
      const conversation = await apiData<{ id: string }>('/api/dms', {
        method: 'POST', body: JSON.stringify({ usernames: [member.user.username] }),
      });
      router.push(`/home?c=${conversation.id}`);
    } catch (cause) { setError(requestError(cause)); }
  }

  async function updateRole(member: Member, role: string) {
    try {
      await apiData(`/api/spaces/${encodeURIComponent(slug)}/members/${member.user.id}`, {
        method: 'PATCH', body: JSON.stringify({ role }),
      });
      await load();
    } catch (cause) { setError(requestError(cause)); }
  }

  async function remove(member: Member) {
    try {
      await apiData(`/api/spaces/${encodeURIComponent(slug)}/members/${member.user.id}`, { method: 'DELETE' });
      setMembers(current => current.filter(item => item.user.id !== member.user.id));
    } catch (cause) { setError(requestError(cause)); }
  }

  async function more() {
    if (!cursor) return;
    try {
      const page = await apiData<{ items: Member[]; next_cursor: string | null }>(
        `/api/spaces/${encodeURIComponent(slug)}/members?cursor=${encodeURIComponent(cursor)}`);
      setMembers(current => [...current, ...page.items]); setCursor(page.next_cursor);
    } catch (cause) { setError(requestError(cause)); }
  }

  const rankYou = space?.my_role ? rank[space.my_role] : 0;
  return <main className="mx-auto max-w-3xl px-4 py-10">
    <Link href={`/s/${slug}`} className="text-sm text-amber-400">← {space?.name ?? 'Space'}</Link>
    <h1 className="mb-6 mt-3 text-3xl font-bold">Members</h1>
    {error && <p role="alert" className="text-rose-400">{error}</p>}
    <ul className="divide-y divide-white/10 rounded-xl border border-white/10">
      {members.map(member => {
        const mayChangeRole = rankYou >= rank.admin && rank[member.role ?? 'guest'] < rankYou
          && member.user.id !== user?.id;
        const mayKick = rankYou >= rank.moderator && rank[member.role ?? 'guest'] < rankYou
          && member.user.id !== user?.id;
        const choices = roles.filter(role => rank[role] < rankYou);
        return <li key={member.user.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div><span aria-label={member.online ? 'Online' : 'Offline'} className={`mr-2 inline-block h-2 w-2 rounded-full ${member.online ? 'bg-emerald-400' : 'bg-white/20'}`} /><span className="font-medium">{member.user.username}</span>
            <span className="ml-3 rounded bg-white/10 px-2 py-1 text-xs capitalize">{member.role}</span></div>
          {(mayChangeRole || mayKick || (user && space?.my_role && member.user.id !== user.id)) && <div className="flex items-center gap-2">
            {user && space?.my_role && member.user.id !== user.id && <button onClick={() => message(member)} className="text-sm text-amber-400">Message</button>}
            {mayChangeRole && <select aria-label={`Role for ${member.user.username}`} defaultValue={member.role ?? 'guest'}
              onChange={event => updateRole(member, event.target.value)} className="rounded bg-surface px-2 py-1">
              <option value={member.role ?? 'guest'} disabled>Change role</option>
              {choices.map(role => <option key={role} value={role}>{role}</option>)}
            </select>}
            {mayKick && <button onClick={() => remove(member)} className="text-sm text-rose-400">Remove</button>}
          </div>}
        </li>;
      })}
    </ul>
    {cursor && <button onClick={more} className="auth-button mt-5">Load more</button>}
  </main>;
}
