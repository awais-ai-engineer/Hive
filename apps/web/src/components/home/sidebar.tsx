'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { conversationTitle, type Conversation } from '../../lib/dms';
import { badge, loadSetting, saveSetting } from '../../lib/home';
import type { Channel, Space } from '../../lib/spaces';
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
  onView: (view: 'unreads' | 'threads') => void;
  onPerson: (username: string) => void;
};

function Count({ value }: { value: number }) {
  if (!value) return null;
  return <span aria-label={`${value} unread`} className="shrink-0 rounded-full bg-amber-400 px-1.5 text-xs font-semibold text-black">{badge(value)}</span>;
}

function Row({ active, unread, onClick, children }: { active: boolean; unread: number; onClick: () => void; children: ReactNode }) {
  return <li>
    <button type="button" onClick={onClick} aria-current={active ? 'page' : undefined}
      className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm focus-visible:outline focus-visible:outline-amber-400 ${active ? 'bg-white/10 text-amber-400' : unread ? 'font-semibold text-white' : 'text-white/70 hover:bg-white/5'}`}>
      {children}
      <span className="ml-auto" />
      <Count value={active ? 0 : unread} />
    </button>
  </li>;
}

/** Slack-style sidebar: space switcher, search, Unreads/Threads, channels, group and 1:1 DMs. */
export function Sidebar(props: Props) {
  const { space, channels, conversations, selected, view } = props;
  const [collapsed, setCollapsed] = useState<Record<Section, boolean>>({ channels: false, conversations: false, direct: false });
  const [composing, setComposing] = useState<'group' | 'direct' | null>(null);
  useEffect(() => { setCollapsed(current => loadSetting('hive:sidebar', current)); }, []);
  function toggle(section: Section) {
    setCollapsed(current => { const next = { ...current, [section]: !current[section] }; saveSetting('hive:sidebar', next); return next; });
  }
  const groups = conversations.filter(item => item.is_group);
  const direct = conversations.filter(item => !item.is_group);
  const canAddChannel = space?.my_role === 'owner' || space?.my_role === 'admin';

  const heading = (section: Section, label: string) => <button type="button" onClick={() => toggle(section)} aria-expanded={!collapsed[section]}
    className="mb-1 mt-5 flex w-full items-center gap-1 px-1 text-left text-xs font-semibold uppercase tracking-wide text-white/50 hover:text-white/80">
    <span aria-hidden className="w-3">{collapsed[section] ? '▸' : '▾'}</span>{label}
  </button>;
  const newForm = (kind: 'group' | 'direct') => composing === kind && <div className="mt-2">
    <NewConversation onOpened={id => { setComposing(null); props.onOpen(id); }} onCancel={() => setComposing(null)} />
  </div>;

  return <nav aria-label="Conversations" className="flex h-full min-h-0 flex-col">
    <SpaceSwitcher spaces={props.spaces} current={space} onSwitch={props.onSwitchSpace} />
    <div className="mt-2"><FindConversation channels={channels} conversations={conversations} onOpen={props.onOpen} onPerson={props.onPerson} /></div>
    <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
      <ul className="space-y-0.5">
        <Row active={view === 'unreads'} unread={props.unreadTotal} onClick={() => props.onView('unreads')}><span aria-hidden>📥</span> Unreads</Row>
        <Row active={view === 'threads'} unread={props.threadsUnread} onClick={() => props.onView('threads')}><span aria-hidden>🧵</span> Threads</Row>
      </ul>

      {heading('channels', 'Channels')}
      {!collapsed.channels && <ul className="space-y-0.5">
        {!space && <li className="px-2 text-xs text-white/40">Join or create a space to see its channels.</li>}
        {channels.map(channel => <Row key={channel.id} active={channel.id === selected} unread={channel.unread} onClick={() => props.onOpen(channel.id)}>
          <span aria-hidden className="w-4 text-center text-white/50">{channel.type === 'voice' ? '🔊' : '#'}</span>
          <span className="truncate">{channel.name}</span>
        </Row>)}
        {canAddChannel && <li><Link href={`/s/${space!.slug}/settings`} className="block px-2 py-1 text-sm text-white/50 hover:text-amber-400">+ Add channel</Link></li>}
      </ul>}

      {heading('conversations', 'Conversations')}
      {!collapsed.conversations && <ul className="space-y-0.5">
        {groups.map(item => <Row key={item.id} active={item.id === selected} unread={item.unread} onClick={() => props.onOpen(item.id)}>
          <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-white/10 text-xs text-white/70">{item.participants.length + 1}</span>
          <span className="truncate">{conversationTitle(item)}</span>
        </Row>)}
        <li><button type="button" onClick={() => setComposing(composing === 'group' ? null : 'group')} className="px-2 py-1 text-sm text-white/50 hover:text-amber-400">+ New group</button></li>
        {newForm('group')}
      </ul>}

      {heading('direct', 'Direct messages')}
      {!collapsed.direct && <ul className="space-y-0.5">
        {direct.map(item => {
          const person = item.participants[0];
          return <Row key={item.id} active={item.id === selected} unread={item.unread} onClick={() => props.onOpen(item.id)}>
            <span className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded bg-amber-400/15 text-xs text-amber-400">
              {person?.username[0].toUpperCase()}
              <span aria-label={person?.online ? 'Online' : 'Offline'} className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-[#0b0d12] ${person?.online ? 'bg-emerald-400' : 'bg-white/30'}`} />
            </span>
            <span className="truncate">{person?.username ?? 'Unknown'}</span>
          </Row>;
        })}
        <li><button type="button" onClick={() => setComposing(composing === 'direct' ? null : 'direct')} className="px-2 py-1 text-sm text-white/50 hover:text-amber-400">+ New message</button></li>
        {newForm('direct')}
      </ul>}
    </div>
  </nav>;
}
