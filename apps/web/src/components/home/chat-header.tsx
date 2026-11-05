'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { conversationTitle, type Conversation } from '../../lib/dms';
import { apiData, type Channel, type Member, type Space } from '../../lib/spaces';
import { Avatar } from '../ui/avatar';
import { Icon, type IconName } from '../ui/icons';

export type ChatTab = 'messages' | 'posts';

type Props = {
  title?: string;
  channel?: Channel | null;
  space?: Space | null;
  conversation?: Conversation | null;
  tab?: ChatTab;
  onTab?: (tab: ChatTab) => void;
  onMenu: () => void;
};

function Stack({ people, total, href }: { people: { id: string; username: string; avatar_url: string | null }[]; total: number; href?: string }) {
  const body = <span className="flex items-center">
    <span className="flex -space-x-2">{people.slice(0, 3).map(person => <span key={person.id} className="rounded-full ring-2 ring-[var(--surface)]">
      <Avatar name={person.username} src={person.avatar_url} size={30} /></span>)}</span>
    {total > 3 && <span className="-ml-2 flex h-[30px] min-w-[30px] items-center justify-center rounded-full bg-brand-soft px-1.5 text-xs font-semibold text-brand ring-2 ring-[var(--surface)]">+{total - 3}</span>}
  </span>;
  return href ? <Link href={href} aria-label={`${total} members`}>{body}</Link> : <span aria-label={`${total} people`}>{body}</span>;
}

function Tab({ active, icon, label, onClick }: { active: boolean; icon: IconName; label: string; onClick: () => void }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick}
    className={`flex items-center gap-2 border-b-2 px-1 pb-2.5 pt-1 text-sm font-medium transition ${active ? 'border-brand text-brand' : 'border-transparent text-white/55 hover:text-white'}`}>
    <Icon name={icon} size={16} />{label}
  </button>;
}

/** Top of the main area: what is open, who is in it, and the Messages/Posts tabs for space channels. */
export function ChatHeader({ title, channel, space, conversation, tab = 'messages', onTab, onMenu }: Props) {
  const [members, setMembers] = useState<Member[]>([]);
  useEffect(() => {
    if (!space || !channel) return;
    let active = true;
    apiData<{ items: Member[] }>(`/api/spaces/${encodeURIComponent(space.slug)}/members`)
      .then(page => { if (active) setMembers(page.items); }).catch(() => {});
    return () => { active = false; };
  }, [space?.slug, channel?.id]);

  const menu = <button type="button" onClick={onMenu} aria-label="Open sidebar" className="rounded-lg p-1 text-white/70 hover:bg-[var(--surface-2)] md:hidden"><Icon name="menu" size={22} /></button>;
  const shell = 'mb-3 border-b border-white/10';

  if (conversation) {
    const online = conversation.participants.filter(person => person.online).length;
    return <header className={`${shell} flex items-center gap-3 pb-3`}>
      {menu}
      {conversation.is_group ? <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft font-semibold text-brand">{conversation.participants.length + 1}</span>
        : <Avatar name={conversation.participants[0]?.username ?? '?'} src={conversation.participants[0]?.avatar_url} size={40} online={!!conversation.participants[0]?.online} />}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-lg font-bold">{conversationTitle(conversation)}</h1>
        <p className="text-xs text-white/55">{conversation.is_group ? `${conversation.participants.length + 1} members · ${online} online`
          : conversation.participants[0]?.online ? 'Active now' : 'Offline'}</p>
      </div>
      <Stack people={conversation.participants} total={conversation.participants.length} />
    </header>;
  }

  if (channel && space) {
    return <header className={shell}>
      <div className="flex items-start gap-3">
        {menu}
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-1.5 truncate text-xl font-bold">
            <Icon name={channel.type === 'voice' ? 'volume' : 'hash'} size={20} className="shrink-0 text-white/45" />{channel.name}</h1>
          <p className="truncate text-sm text-white/55">{channel.topic || `${space.name} · ${space.type === 'community' ? 'Community' : 'Workspace'}`}</p>
        </div>
        <Stack people={members.map(member => member.user)} total={space.member_count} href={`/s/${space.slug}/members`} />
      </div>
      {onTab && channel.type !== 'voice' && <div role="tablist" aria-label="Channel views" className="mt-3 flex gap-6">
        <Tab active={tab === 'messages'} icon="message" label="Messages" onClick={() => onTab('messages')} />
        <Tab active={tab === 'posts'} icon="layers" label="Posts" onClick={() => onTab('posts')} />
      </div>}
    </header>;
  }

  return <header className={`${shell} flex items-center gap-3 pb-3`}>
    {menu}<h1 className="text-xl font-bold">{title}</h1>
  </header>;
}
