'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../../../../lib/auth';
import { apiData, requestError, type Channel, type Space } from '../../../../../lib/spaces';
import { base, type Bot, type SlashCommand, type SpaceMemberRow, type Webhook, type Workflow } from '../../../../../lib/apps';
import { SettingsTabs } from '../../../../../components/apps/parts';
import { WebhooksSection } from '../../../../../components/apps/webhooks-section';
import { BotsSection } from '../../../../../components/apps/bots-section';
import { CommandsSection } from '../../../../../components/apps/commands-section';
import { WorkflowsSection } from '../../../../../components/apps/workflows-section';

const rank: Record<string, number> = { owner: 5, admin: 4, moderator: 3, member: 2, guest: 1 };

export default function AppsPage() {
  const { slug } = useParams<{ slug: string }>();
  const { user, loading } = useAuth();
  const [space, setSpace] = useState<Space | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [members, setMembers] = useState<SpaceMemberRow[]>([]);
  const [error, setError] = useState('Loading…');

  const load = useCallback(async () => {
    const spaceData = await apiData<Space>(base(slug));
    setSpace(spaceData);
    if (!spaceData.my_role || rank[spaceData.my_role] < rank.admin) { setError('Insufficient role'); return; }
    const [channelData, hookData, botData, commandData, workflowData, memberData] = await Promise.all([
      apiData<Channel[]>(`${base(slug)}/channels`), apiData<Webhook[]>(`${base(slug)}/webhooks`), apiData<Bot[]>(`${base(slug)}/bots`),
      apiData<SlashCommand[]>(`${base(slug)}/commands`), apiData<Workflow[]>(`${base(slug)}/workflows`),
      apiData<{ items: SpaceMemberRow[] }>(`${base(slug)}/members`),
    ]);
    setChannels(channelData.filter(channel => channel.type === 'text')); setHooks(hookData); setBots(botData);
    setCommands(commandData); setWorkflows(workflowData); setMembers(memberData.items); setError('');
  }, [slug]);

  useEffect(() => { if (!loading) load().catch(cause => setError(requestError(cause))); }, [load, loading, user]);

  const allowed = !!space?.my_role && rank[space.my_role] >= rank.admin;
  const reload = async () => { try { await load(); } catch (cause) { setError(requestError(cause)); } };
  if (loading || !space || !allowed) return <main className="mx-auto max-w-3xl px-4 py-10">
    <Link href={`/s/${slug}`} className="text-sm text-brand">← Back to space</Link>
    {error && <p role="alert" className="mt-4 text-rose-500">{error}</p>}
  </main>;

  return <main className="mx-auto max-w-3xl space-y-6 px-4 py-10">
    <div><Link href={`/s/${slug}`} className="text-sm text-brand">← {space.name}</Link>
      <h1 className="mt-2 text-3xl font-bold">Space settings</h1></div>
    <SettingsTabs slug={slug} active="apps" />
    {error && <p role="alert" className="text-rose-500">{error}</p>}
    <section className="card p-5">
      <h2 className="text-xl font-semibold">Apps directory</h2>
      <p className="mt-1 text-sm text-white/70">Connect Hive to other tools and automate routine work. Only owners and admins see this page; secrets are shown once when created.</p>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {[['#webhooks', '🔔', 'Incoming webhooks', 'Let another tool post into a channel.', hooks.length],
          ['#bots', '🤖', 'Bots', 'Programs that read and write in chosen channels.', bots.length],
          ['#commands', '/', 'Slash commands', 'Your own /commands, answered by a bot.', commands.length],
          ['#workflows', '⚙️', 'Workflows', 'When this happens, do that: no code.', workflows.length]].map(([href, icon, title, text, count]) =>
          <li key={href as string}><a href={href as string} className="flex items-start gap-3 rounded-xl border border-white/10 p-3 hover:border-brand">
            <span className="text-2xl" aria-hidden>{icon}</span><span><span className="block font-semibold">{title} <span className="text-sm font-normal text-white/60">({count})</span></span><span className="text-sm text-white/70">{text}</span></span></a></li>)}
      </ul>
    </section>
    <WorkflowsSection slug={slug} spaceName={space.name} channels={channels} bots={bots} members={members} workflows={workflows} reload={reload} fail={setError} />
    <WebhooksSection slug={slug} channels={channels} hooks={hooks} reload={reload} fail={setError} />
    <BotsSection slug={slug} channels={channels} bots={bots} reload={reload} fail={setError} />
    <CommandsSection slug={slug} bots={bots} commands={commands} reload={reload} fail={setError} />
  </main>;
}
