'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { conversationTitle, type Conversation } from '../../lib/dms';
import { badge, loadSetting, saveSetting } from '../../lib/home';
import { useDraftChannels } from '../../lib/composer-drafts';
import type { Channel, Space } from '../../lib/spaces';
import { Avatar } from '../ui/avatar';
import { Icon, type IconName } from '../ui/icons';
import { CreateChannelDialog } from './create-channel-dialog';
import { FindConversation } from './find-conversation';
import { NewConversation } from './new-conversation';
import { SpaceSwitcher } from './space-switcher';

type Section = 'channels' | 'conversations' | 'direct';

type Props = {
  spaces: Space[];
  space: Space | null;
  channels: Channel[];
  conversations: Conversation[];
  selected: string | null;
  view: string | null;
  unreadTotal: number;
  threadsUnread: number;
  onSwitchSpace: (slug: string) => void;
  onOpen: (id: string) => void;
  onView: (view: 'unreads' | 'threads' | 'drafts') => void;
  onPerson: (username: string) => void;
  onChannelCreated: (channel: Channel) => void;
};

function Count({ value }: { value: number }) {
  if (!value) return null;
  return <span aria-label={`${value} unread`} className="ml-auto shrink-0 rounded-full bg-[var(--brand)] px-1.5 text-[11px] font-semibold leading-5" style={{ color: '#fff' }}>{badge(value)}</span>;
}

function Row({ active, unread, draft, onClick, children }: { active: boolean; unread: number; draft?: boolean; onClick: () => void; children: ReactNode }) {
  return <li>
    <button type="button" onClick={onClick} aria-current={active ? 'page' : undefined}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[14px] transition ${active
        ? 'bg-[var(--brand)] font-semibold shadow-sm' : unread ? 'font-semibold text-white hover:bg-white/10' : 'text-white/75 hover:bg-white/10 hover:text-white'}`}>
      {children}
      {draft && !active && <Icon name="edit" size={13} aria-label="Unsent draft" className="ml-auto shrink-0 opacity-70" />}
      <Count value={active ? 0 : unread} />
    </button>
  </li>;
}

function NavItem({ icon, label, active, count, onClick, href }: {
  icon: IconName; label: string; active?: boolean; count?: number; onClick?: () => void; href?: string;
}) {
  const body = <><Icon name={icon} size={17} className="shrink-0 opacity-80" /><span className="truncate">{label}</span><Count value={count ?? 0} /></>;
  const style = `flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[14px] transition ${active ? 'bg-white/15 font-semibold text-white' : 'text-white/80 hover:bg-white/10 hover:text-white'}`;
  return <li>{href ? <Link href={href} className={style}>{body}</Link> : <button type="button" onClick={onClick} className={style}>{body}</button>}</li>;
}

/** Slack-style sidebar on the purple panel: workspace switcher, search, views, channels and DMs. */
export function Sidebar(props: Props) {
  const { space, channels, conversations, selected, view } = props;
  const [collapsed, setCollapsed] = useState<Record<Section, boolean>>({ channels: false, conversations: false, direct: false });
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [composing, setComposing] = useState<'group' | 'direct' | null>(null);
  useEffect(() => { setCollapsed(current => loadSetting('hive:sidebar', current)); }, []);
  function toggle(section: Section) {
    setCollapsed(current => { const next = { ...current, [section]: !current[section] }; saveSetting('hive:sidebar', next); return next; });
  }
  const drafts = useDraftChannels();
  const groups = conversations.filter(item => item.is_group);
  const direct = conversations.filter(item => !item.is_group);
  const canAddChannel = space?.my_role === 'owner' || space?.my_role === 'admin';

  const heading = (section: Section, label: string, add?: () => void, addLabel?: string) =>
    <div className="mb-1 mt-5 flex items-center justify-between px-2.5">
      <button type="button" onClick={() => toggle(section)} aria-expanded={!collapsed[section]}
        className="flex items-center gap-1 text-[13px] font-semibold text-white/60 hover:text-white">
        <Icon name={collapsed[section] ? 'chevronRight' : 'chevronDown'} size={14} />{label}
      </button>
      {add && <button type="button" onClick={add} aria-label={addLabel} className="rounded p-0.5 text-white/60 hover:bg-white/10 hover:text-white"><Icon name="plus" size={16} /></button>}
    </div>;
  const newForm = (kind: 'group' | 'direct') => composing === kind && <div className="on-surface mt-2">
    <NewConversation onOpened={id => { setComposing(null); props.onOpen(id); }} onCancel={() => setComposing(null)} />
  </div>;

  return <nav aria-label="Conversations" className="on-dark flex h-full min-h-0 flex-col bg-gradient-to-b from-[var(--sidebar-from)] to-[var(--sidebar-to)] px-3 py-4">
    <SpaceSwitcher spaces={props.spaces} current={space} onSwitch={props.onSwitchSpace} />
    <div className="mt-3"><FindConversation channels={channels} conversations={conversations} onOpen={props.onOpen} onPerson={props.onPerson} /></div>
    <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-width:thin]">
      <ul className="space-y-0.5">
        <NavItem icon="threads" label="Threads" active={view === 'threads'} count={props.threadsUnread} onClick={() => props.onView('threads')} />
        <NavItem icon="inbox" label="Unreads" active={view === 'unreads'} count={props.unreadTotal} onClick={() => props.onView('unreads')} />
        <NavItem icon="send" label="Drafts & scheduled" active={view === 'drafts'} onClick={() => props.onView('drafts')} />
        <NavItem icon="layers" label="Feed" href="/feed" />
        {space && <NavItem icon="users" label="Members" href={`/s/${space.slug}/members`} />}
      </ul>

      {heading('channels', 'Channels', canAddChannel ? () => setCreatingChannel(true) : undefined, 'Add channel')}
      {!collapsed.channels && <ul className="space-y-0.5">
        {!space && <li className="px-2.5 text-xs text-white/50">Join or create a space to see its channels.</li>}
        {channels.map(channel => <Row key={channel.id} active={channel.id === selected} unread={channel.unread} draft={drafts.has(channel.id)} onClick={() => props.onOpen(channel.id)}>
          <Icon name={channel.type === 'voice' ? 'volume' : channel.is_private ? 'lock' : 'hash'} size={16} className="shrink-0 opacity-70" />
          <span className="truncate">{channel.name}</span>
        </Row>)}
      </ul>}

      {heading('conversations', 'Conversations', () => setComposing(composing === 'group' ? null : 'group'), 'New group conversation')}
      {!collapsed.conversations && <ul className="space-y-0.5">
        {groups.map(item => <Row key={item.id} active={item.id === selected} unread={item.unread} draft={drafts.has(item.id)} onClick={() => props.onOpen(item.id)}>
          <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-white/15 text-[11px] font-semibold">{item.participants.length + 1}</span>
          <span className="truncate">{conversationTitle(item)}</span>
        </Row>)}
        {!groups.length && composing !== 'group' && <li className="px-2.5 text-xs text-white/45">No group conversations yet</li>}
        {newForm('group')}
      </ul>}

      {heading('direct', 'Direct messages', () => setComposing(composing === 'direct' ? null : 'direct'), 'New message')}
      {!collapsed.direct && <ul className="space-y-0.5">
        {direct.map(item => {
          const person = item.participants[0];
          return <Row key={item.id} active={item.id === selected} unread={item.unread} draft={drafts.has(item.id)} onClick={() => props.onOpen(item.id)}>
            <Avatar name={person?.username ?? '?'} src={person?.avatar_url} size={22} online={!!person?.online} />
            <span className="truncate">{person?.username ?? 'Unknown'}</span>
          </Row>;
        })}
        {newForm('direct')}
      </ul>}
    </div>
    {creatingChannel && space && <CreateChannelDialog space={space} onClose={() => setCreatingChannel(false)}
      onCreated={channel => { setCreatingChannel(false); props.onChannelCreated(channel); }} />}
  </nav>;
}
