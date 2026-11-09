'use client';

import { AskHive } from '../ai/ask-panel';
import { LiveHuddleBanner } from '../call/live-huddle-banner';
import { useT } from '../../lib/i18n';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { conversationTitle, type Conversation } from '../../lib/dms';
import { apiData, type Channel, type Member, type Space } from '../../lib/spaces';
import { LEVEL_LABELS, type NotifyLevel } from '../../lib/sidebar';
import { dayText, activeStatus } from '../../lib/status';
import { StatusMark } from '../ui/status-mark';
import { ChannelMembers } from './channel-members';
import { HuddleButton } from '../call/huddle-button';
import { PopupMenu } from './popup-menu';
import { Avatar } from '../ui/avatar';
import { Icon, type IconName } from '../ui/icons';
import { CatchUp } from '../ai/catch-up';
import { TranslateAllToggle } from '../ai/translate';
import { TimerBanner, TimerButton } from './disappearing';

export type ChatTab = 'messages' | 'posts' | 'docs' | 'todos' | 'files';

type Props = {
  title?: string;
  channel?: Channel | null;
  space?: Space | null;
  conversation?: Conversation | null;
  tab?: ChatTab;
  onTab?: (tab: ChatTab) => void;
  onMenu: () => void;
  starred?: boolean;
  onStar?: () => void;
  level?: NotifyLevel;
  onLevel?: (level: NotifyLevel) => void;
  /** Called after the viewer leaves the open private channel. */
  onLeft?: () => void;
  /** Reload the open conversation after its disappearing-messages timer changed. */
  onTimerChanged?: () => void;
  onError?: (message: string) => void;
};

function Stack({ people, total, href }: { people: { id: string; username: string; avatar_url: string | null }[]; total: number; href?: string }) {
  const body = <span className="flex items-center">
    <span className="flex -space-x-2">{people.slice(0, 3).map(person => <span key={person.id} className="rounded-full ring-2 ring-[var(--surface)]">
      <Avatar name={person.username} src={person.avatar_url} size={30} /></span>)}</span>
    {total > 3 && <span className="-ml-2 flex h-[30px] min-w-[30px] items-center justify-center rounded-full bg-brand-soft px-1.5 text-xs font-semibold text-brand ring-2 ring-[var(--surface)]">+{total - 3}</span>}
  </span>;
  return href ? <Link href={href} aria-label={`${total} members`}>{body}</Link> : <span aria-label={`${total} people`}>{body}</span>;
}

/** Star and notification buttons for the open conversation. */
function Controls({ starred, onStar, level = 'all', onLevel }: Pick<Props, 'starred' | 'onStar' | 'level' | 'onLevel'>) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  if (!onStar && !onLevel) return null;
  const button = 'rounded-lg p-1.5 text-white/60 hover:bg-[var(--surface-2)] hover:text-white';
  return <div className="flex shrink-0 items-center">
    {onStar && <button type="button" onClick={onStar} aria-pressed={!!starred} title={starred ? 'Remove from starred' : 'Star this conversation to pin it at the top of your sidebar'}
      aria-label={starred ? 'Remove from starred' : 'Star this conversation'} className={`${button} ${starred ? '!text-amber-500' : ''}`}>
      <Icon name="star" size={18} fill={starred ? 'currentColor' : 'none'} /></button>}
    {onLevel && <button type="button" aria-haspopup="menu" aria-expanded={!!menu} title={`Notifications: ${LEVEL_LABELS[level]}`} aria-label={`Notifications: ${LEVEL_LABELS[level]}`}
      onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setMenu({ x: box.right - 256, y: box.bottom + 4 }); }} className={button}>
      <Icon name={level === 'all' ? 'bell' : 'bellOff'} size={18} /></button>}
    {menu && onLevel && <PopupMenu at={menu} label="Notifications" onClose={() => setMenu(null)} items={[
      { heading: 'Notify me about' },
      ...(['all', 'mentions', 'nothing'] as NotifyLevel[]).map(value => ({ label: LEVEL_LABELS[value], checked: level === value, onSelect: () => onLevel(value) })),
    ]} />}
  </div>;
}

function Tab({ active, icon, label, onClick }: { active: boolean; icon: IconName; label: string; onClick: () => void }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick}
    className={`flex items-center gap-2 border-b-2 px-1 pb-2.5 pt-1 text-sm font-medium transition ${active ? 'border-brand text-brand' : 'border-transparent text-white/55 hover:text-white'}`}>
    <Icon name={icon} size={16} />{label}
  </button>;
}

/** Top of the main area: what is open, who is in it, and the Messages/Posts tabs for space channels. */
export function ChatHeader({ title, channel, space, conversation, tab = 'messages', onTab, onMenu, onLeft, onTimerChanged, onError, ...controls }: Props) {
  const { t } = useT();
  const [members, setMembers] = useState<Member[]>([]);
  const [panel, setPanel] = useState(false);
  useEffect(() => setPanel(false), [channel?.id]);
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
    const partner = conversation.is_group ? null : conversation.participants[0];
    const away = partner ? activeStatus(partner).away : null;
    return <><header className={shell}><div className="flex items-center gap-3 pb-3">
      {menu}
      {conversation.is_group ? <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft font-semibold text-brand">{conversation.participants.length + 1}</span>
        : <Avatar name={conversation.participants[0]?.username ?? '?'} src={conversation.participants[0]?.avatar_url} size={40} online={!!conversation.participants[0]?.online} />}
      <div className="min-w-0 flex-1">
        <h1 className="flex items-center gap-1.5 truncate text-lg font-bold">{conversation.encrypted && <Icon name="lock" size={16} className="shrink-0 text-brand" aria-label="Secret conversation" />}{conversationTitle(conversation)}{partner && <StatusMark person={partner} className="text-base font-normal" />}</h1>
        <p className="text-xs text-white/55">{conversation.is_group ? `${conversation.participants.length + 1} members · ${online} online`
          : conversation.participants[0]?.online ? 'Active now' : 'Offline'}</p>
      </div>
      <HuddleButton channelId={conversation.id} title={conversationTitle(conversation)} ring />
      {onTimerChanged && !conversation.read_only && <TimerButton channelId={conversation.id} seconds={conversation.disappear_after} onChanged={onTimerChanged} onError={onError ?? (() => {})} />}
      <Controls {...controls} />
      <Stack people={conversation.participants} total={conversation.participants.length} />
    </div>
      {onTab && <div role="tablist" aria-label="Conversation views" className="flex gap-6 overflow-x-auto">
        <Tab active={tab === 'messages'} icon="message" label={t('tabs.messages')} onClick={() => onTab('messages')} />
        <Tab active={tab === 'docs'} icon="file" label={t('tabs.docs')} onClick={() => onTab('docs')} />
        <Tab active={tab === 'todos'} icon="checkSquare" label={t('tabs.todos')} onClick={() => onTab('todos')} />
        <Tab active={tab === 'files'} icon="folder" label={t('tabs.files')} onClick={() => onTab('files')} />
      </div>}
    </header>
    <LiveHuddleBanner channelId={conversation.id} title={conversationTitle(conversation)} />
    <TimerBanner seconds={conversation.disappear_after} />
    {!conversation.encrypted && <div className="mb-3 flex flex-wrap items-start gap-x-4 gap-y-2"><CatchUp channelId={conversation.id} /><TranslateAllToggle channelId={conversation.id} /></div>}
    {away && <p role="status" className="-mt-1 mb-3 rounded-xl bg-brand-soft px-3 py-2 text-sm">
      🌴 <strong>{partner?.username}</strong> is out of office until {dayText(away)}. They may reply late.</p>}</>;
  }

  if (channel && space) {
    return <><header className={shell}>
      <div className="flex items-start gap-3">
        {menu}
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-1.5 truncate text-xl font-bold">
            <Icon name={channel.type === 'voice' ? 'volume' : channel.is_private ? 'lock' : 'hash'} size={20} className="shrink-0 text-white/45" />{channel.name}</h1>
          <p className="truncate text-sm text-white/55">{channel.is_private && <span className="mr-2 rounded-full bg-brand-soft px-2 py-0.5 text-xs font-medium text-brand">Private channel</span>}{channel.topic || `${space.name} · ${space.type === 'community' ? 'Community' : 'Workspace'}`}</p>
        </div>
        {channel.type !== 'voice' && <HuddleButton channelId={channel.id} title={`#${channel.name}`} />}
        {channel.type !== 'voice' && <AskHive spaceId={space.id} inline />}
        {channel.type !== 'voice' && onTimerChanged && (space.my_role === 'owner' || space.my_role === 'admin') && <TimerButton channelId={channel.id} seconds={channel.disappear_after} onChanged={onTimerChanged} onError={onError ?? (() => {})} />}
        <Controls {...controls} />
        {channel.is_private && <div className="relative">
          <button type="button" onClick={() => setPanel(open => !open)} aria-expanded={panel} className="btn-ghost flex items-center gap-1.5 text-sm">
            <Icon name="users" size={15} />Members</button>
          {panel && <ChannelMembers space={space} channel={channel} isAdmin={space.my_role === 'owner' || space.my_role === 'admin'}
            onLeft={() => { setPanel(false); onLeft?.(); }} />}
        </div>}
        <Stack people={members.map(member => member.user)} total={space.member_count} href={`/s/${space.slug}/members`} />
      </div>
      {onTab && channel.type !== 'voice' && <div role="tablist" aria-label="Channel views" className="mt-3 flex gap-6 overflow-x-auto">
        <Tab active={tab === 'messages'} icon="message" label={t('tabs.messages')} onClick={() => onTab('messages')} />
        <Tab active={tab === 'posts'} icon="layers" label={t('tabs.posts')} onClick={() => onTab('posts')} />
        <Tab active={tab === 'docs'} icon="file" label={t('tabs.docs')} onClick={() => onTab('docs')} />
        <Tab active={tab === 'todos'} icon="checkSquare" label={t('tabs.todos')} onClick={() => onTab('todos')} />
        <Tab active={tab === 'files'} icon="folder" label={t('tabs.files')} onClick={() => onTab('files')} />
      </div>}
    </header>
    {channel.type !== 'voice' && <LiveHuddleBanner channelId={channel.id} title={`#${channel.name}`} />}
    {channel.type !== 'voice' && <TimerBanner seconds={channel.disappear_after} />}
    {channel.type !== 'voice' && <div className="mb-3 flex flex-wrap items-start gap-x-4 gap-y-2"><CatchUp channelId={channel.id} /><TranslateAllToggle channelId={channel.id} /></div>}</>;
  }

  return <header className={`${shell} flex items-center gap-3 pb-3`}>
    {menu}<h1 className="text-xl font-bold">{title}</h1>
  </header>;
}
