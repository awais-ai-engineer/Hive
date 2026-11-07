'use client';

import { useT } from '../../lib/i18n';
import Link from 'next/link';
import { useState, type Dispatch, type MouseEvent as ReactMouseEvent, type SetStateAction } from 'react';
import { conversationTitle, type Conversation } from '../../lib/dms';
import { badge } from '../../lib/home';
import { LEVEL_LABELS, sidebarApi, type BuiltInSection, type CustomSection, type NotifyLevel, type SidebarData } from '../../lib/sidebar';
import { requestError, type Channel, type Space } from '../../lib/spaces';
import { useDraftChannels } from '../../lib/composer-drafts';
import { Avatar } from '../ui/avatar';
import { Icon, type IconName } from '../ui/icons';
import { StatusMark } from '../ui/status-mark';
import { CallBar } from '../call/call-bar';
import { calls } from '../../lib/call';
import { useHuddles } from '../../lib/huddles';
import { CreateChannelDialog } from './create-channel-dialog';
import { FindConversation } from './find-conversation';
import { NewConversation } from './new-conversation';
import { PopupMenu, type MenuItem } from './popup-menu';
import { SectionDialog } from './section-dialog';
import { SpaceSwitcher } from './space-switcher';

type Props = {
  spaces: Space[];
  space: Space | null;
  channels: Channel[];
  conversations: Conversation[];
  selected: string | null;
  view: string | null;
  unreadTotal: number;
  threadsUnread: number;
  data: SidebarData;
  /** Shows a change at once; `onChanged` then fetches the saved state. */
  update: Dispatch<SetStateAction<SidebarData>>;
  onChanged: () => void;
  onSwitchSpace: (slug: string) => void;
  onOpen: (id: string) => void;
  onView: (view: 'unreads' | 'threads' | 'directory' | 'drafts' | 'saved' | 'files') => void;
  onBrowseChannels: () => void;
  onChannelCreated: (channel: Channel) => void;
};

type Entry = { id: string; kind: 'channel' | 'group' | 'dm'; label: string; unread: number; channel?: Channel; conversation?: Conversation };
type Menu = { x: number; y: number; items: MenuItem[]; label: string };
type Dialog = { mode: 'new'; moveId?: string } | { mode: 'rename'; section: CustomSection } | null;

function Count({ value }: { value: number }) {
  if (!value) return null;
  return <span aria-label={`${value} unread`} className="ml-auto shrink-0 rounded-full bg-[var(--brand)] px-1.5 text-[11px] font-semibold leading-5" style={{ color: '#fff' }}>{badge(value)}</span>;
}

function NavItem({ icon, label, active, count, onClick, href }: {
  icon: IconName; label: string; active?: boolean; count?: number; onClick?: () => void; href?: string;
}) {
  const body = <><Icon name={icon} size={17} className="shrink-0 opacity-80" /><span className="truncate">{label}</span><Count value={count ?? 0} /></>;
  const style = `flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[14px] transition ${active ? 'bg-white/15 font-semibold text-white' : 'text-white/80 hover:bg-white/10 hover:text-white'}`;
  return <li>{href ? <Link href={href} className={style}>{body}</Link> : <button type="button" onClick={onClick} className={style}>{body}</button>}</li>;
}

const hint = (text: string) => <li className="px-2.5 py-0.5 text-xs text-white/50">{text}</li>;

/** Slack-style sidebar on the purple panel: space switcher, search, views, and your sections. */
export function Sidebar(props: Props) {
  const { t } = useT();
  const { space, channels, conversations, selected, view, data } = props;
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [composing, setComposing] = useState<'group' | 'direct' | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState('');
  const huddles = useHuddles();
  const drafts = useDraftChannels();

  const role = space?.my_role;
  const isAdmin = role === 'owner' || role === 'admin';
  const collapsed = (key: string) => data.collapsed.includes(key);

  async function run(action: () => Promise<unknown>) {
    setError('');
    try { await action(); } catch (cause) { setError(requestError(cause)); }
    props.onChanged();
  }

  // Entries and which section each one lives in ----------------------------------------------
  const entries: Entry[] = [
    ...channels.map((channel): Entry => ({ id: channel.id, kind: 'channel', label: channel.name, unread: channel.unread, channel })),
    ...conversations.map((item): Entry => ({ id: item.id, kind: item.is_group ? 'group' : 'dm', label: conversationTitle(item), unread: item.unread, conversation: item })),
  ];
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const starred = data.stars.map(id => byId.get(id)).filter((entry): entry is Entry => !!entry);
  const placed = new Set(starred.map(entry => entry.id));
  const custom = data.sections.filter(section => section.space_id === null || section.space_id === space?.id).map(section => {
    const items = section.channel_ids.map(id => byId.get(id)).filter((entry): entry is Entry => !!entry && !placed.has(entry.id));
    items.forEach(entry => placed.add(entry.id));
    return { section, items };
  });
  const rest = (kind: Entry['kind']) => entries.filter(entry => entry.kind === kind && !placed.has(entry.id));

  // Actions ---------------------------------------------------------------------------------
  function toggleBuiltIn(key: BuiltInSection) {
    const now = !collapsed(key);
    props.update(current => ({ ...current, collapsed: now ? [...current.collapsed, key] : current.collapsed.filter(item => item !== key) }));
    void run(() => sidebarApi.setCollapsed(key, now));
  }
  function toggleCustom(section: CustomSection) {
    props.update(current => ({ ...current, sections: current.sections.map(item => item.id === section.id ? { ...item, collapsed: !item.collapsed } : item) }));
    void run(() => sidebarApi.updateSection(section.id, { collapsed: !section.collapsed }));
  }
  function setStar(entry: Entry, on: boolean) {
    props.update(current => ({ ...current, stars: on ? [...current.stars, entry.id] : current.stars.filter(id => id !== entry.id) }));
    void run(() => (on ? sidebarApi.star(entry.id) : sidebarApi.unstar(entry.id)));
  }
  function setLevel(entry: Entry, level: NotifyLevel) {
    props.update(current => {
      const prefs = { ...current.prefs };
      if (level === 'all') delete prefs[entry.id]; else prefs[entry.id] = level;
      return { ...current, prefs };
    });
    void run(() => sidebarApi.setLevel(entry.id, level));
  }
  function moveSection(section: CustomSection, direction: -1 | 1) {
    const visible = custom.map(item => item.section.id);
    const from = visible.indexOf(section.id);
    const target = visible[from + direction];
    if (target === undefined) return;
    const all = data.sections.map(item => item.id);
    const a = all.indexOf(section.id); const b = all.indexOf(target);
    [all[a], all[b]] = [all[b], all[a]];
    props.update(current => ({ ...current, sections: all.map(id => current.sections.find(item => item.id === id)!) }));
    void run(() => sidebarApi.orderSections(all));
  }
  function removeSection(section: CustomSection) {
    if (!window.confirm(`Delete the section "${section.name}"? Its channels go back to their usual place; nothing else is deleted.`)) return;
    void run(() => sidebarApi.deleteSection(section.id));
  }

  // Menus -----------------------------------------------------------------------------------
  function openMenu(point: { x: number; y: number }, label: string, items: MenuItem[]) { setMenu({ ...point, label, items }); }
  function entryMenu(entry: Entry): MenuItem[] {
    const isStarred = data.stars.includes(entry.id);
    const level = data.prefs[entry.id] ?? 'all';
    const homes = data.sections.filter(section => section.space_id === null || (entry.kind === 'channel' && section.space_id === space?.id));
    const inSection = homes.find(section => section.channel_ids.includes(entry.id));
    return [
      { label: isStarred ? 'Remove from starred' : 'Star this conversation', icon: 'star', onSelect: () => setStar(entry, !isStarred) },
      { separator: true },
      { heading: 'Move to section' },
      { label: 'Default section', checked: !inSection, onSelect: () => { if (inSection) void run(() => sidebarApi.moveOut(entry.id)); } },
      ...homes.map((section): MenuItem => ({
        label: `${section.emoji ?? ''} ${section.name}`.trim(), checked: inSection?.id === section.id,
        onSelect: () => { if (inSection?.id !== section.id) void run(() => sidebarApi.moveTo(section.id, entry.id)); },
      })),
      { label: 'New section…', icon: 'plus', onSelect: () => setDialog({ mode: 'new', moveId: entry.id }) },
      { separator: true },
      { heading: 'Notifications' },
      ...(['all', 'mentions', 'nothing'] as NotifyLevel[]).map((value): MenuItem => ({ label: LEVEL_LABELS[value], checked: level === value, onSelect: () => setLevel(entry, value) })),
    ];
  }
  const sectionMenu = (section: CustomSection): MenuItem[] => [
    { label: 'Rename section', icon: 'edit', onSelect: () => setDialog({ mode: 'rename', section }) },
    { label: 'Move up', onSelect: () => moveSection(section, -1) },
    { label: 'Move down', onSelect: () => moveSection(section, 1) },
    { separator: true },
    { label: 'Delete section', danger: true, onSelect: () => removeSection(section) },
  ];
  function below(event: ReactMouseEvent<HTMLElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: box.left, y: box.bottom + 4 };
  }

  // Rendering -------------------------------------------------------------------------------
  function row(entry: Entry) {
    const active = entry.id === selected;
    const level = data.prefs[entry.id] ?? 'all';
    const quiet = level !== 'all';
    const person = entry.conversation?.participants[0];
    return <li key={entry.id} onContextMenu={event => { event.preventDefault(); openMenu({ x: event.clientX, y: event.clientY }, `Actions for ${entry.label}`, entryMenu(entry)); }}
      className={`group flex items-center rounded-lg transition ${active ? 'bg-[var(--brand)] font-semibold shadow-sm' : 'hover:bg-white/10'} ${quiet && !active ? 'opacity-60' : ''}`}>
      <button type="button" onClick={() => { props.onOpen(entry.id); if (entry.channel?.type === 'voice') void calls.join(entry.id, entry.label); }} aria-current={active ? 'page' : undefined}
        title={quiet ? `Notifications: ${LEVEL_LABELS[level]}` : undefined}
        className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[14px] ${active ? '' : entry.unread && !quiet ? 'font-semibold text-white' : 'text-white/75 hover:text-white'}`}>
        {entry.kind === 'channel' && <Icon name={entry.channel?.type === 'voice' ? 'volume' : entry.channel?.is_private ? 'lock' : 'hash'} size={16} className="shrink-0 opacity-70" />}
        {entry.kind === 'group' && <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-white/15 text-[11px] font-semibold">{(entry.conversation?.participants.length ?? 0) + 1}</span>}
        {entry.kind === 'dm' && <Avatar name={person?.username ?? '?'} src={person?.avatar_url} size={22} online={!!person?.online} />}
        <span className="truncate">{entry.kind === 'dm' ? person?.username ?? 'Unknown' : entry.label}</span>
        {entry.kind === 'dm' && person && <StatusMark person={person} className="text-[13px]" />}
        {entry.conversation?.encrypted && <Icon name="lock" size={13} className="shrink-0 opacity-80" aria-label="Secret conversation" />}
        {huddles[entry.id] && <span className="ml-1 flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-300" title={`In the huddle: ${huddles[entry.id].users.map(user => user.username).join(', ')}`}>
          <Icon name="headphones" size={14} /><span aria-label={`${huddles[entry.id].count} in huddle`}>{huddles[entry.id].count}</span></span>}
        {quiet && <Icon name="bellOff" size={13} className="shrink-0 opacity-70" aria-label={LEVEL_LABELS[level]} />}
        {drafts.has(entry.id) && !active && <Icon name="edit" size={13} aria-label="Unsent draft" className="ml-auto shrink-0 opacity-70" />}
        <Count value={active ? 0 : entry.unread} />
      </button>
      <button type="button" aria-label={`More actions for ${entry.label}`} aria-haspopup="menu" title="Star, move to a section, or change notifications"
        onClick={event => openMenu(below(event), `Actions for ${entry.label}`, entryMenu(entry))}
        className="mr-1 shrink-0 rounded p-1 text-white/60 hover:bg-white/10 hover:text-white focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
        <Icon name="more" size={15} />
      </button>
    </li>;
  }

  const addChannelsMenu = (event: ReactMouseEvent<HTMLElement>) => openMenu(below(event), 'Add channels', [
    ...(isAdmin ? [{ label: 'Create a new channel', icon: 'plus', onSelect: () => setCreatingChannel(true) } as MenuItem] : []),
    { label: 'Browse channels', icon: 'directory', onSelect: props.onBrowseChannels },
  ]);
  const heading = (key: BuiltInSection, label: string, add?: (event: ReactMouseEvent<HTMLElement>) => void, addLabel?: string) =>
    <div className="mb-1 mt-5 flex items-center justify-between px-2.5">
      <button type="button" onClick={() => toggleBuiltIn(key)} aria-expanded={!collapsed(key)}
        className="flex items-center gap-1 text-[13px] font-semibold text-white/60 hover:text-white">
        <Icon name={collapsed(key) ? 'chevronRight' : 'chevronDown'} size={14} />{label}
      </button>
      {add && <button type="button" onClick={add} aria-haspopup={key === 'channels' ? 'menu' : undefined} aria-label={addLabel} title={addLabel} className="rounded p-0.5 text-white/60 hover:bg-white/10 hover:text-white"><Icon name="plus" size={16} /></button>}
    </div>;
  const newForm = (kind: 'group' | 'direct') => composing === kind && <div className="on-surface mt-2">
    <NewConversation onOpened={id => { setComposing(null); props.onOpen(id); }} onCancel={() => setComposing(null)} />
  </div>;
  const quickAction = (label: string, onClick: (event: ReactMouseEvent<HTMLElement>) => void) =>
    <li><button type="button" onClick={onClick} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-white/60 hover:bg-white/10 hover:text-white">
      <Icon name="plus" size={15} className="shrink-0" /><span className="truncate">{label}</span></button></li>;

  return <nav aria-label="Conversations" className="on-dark flex h-full min-h-0 flex-col bg-gradient-to-b from-[var(--sidebar-from)] to-[var(--sidebar-to)] px-3 py-4">
    <SpaceSwitcher spaces={props.spaces} current={space} onSwitch={props.onSwitchSpace} />
    <div className="mt-3"><FindConversation /></div>
    <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-width:thin]">
      <ul className="space-y-0.5">
        <NavItem icon="threads" label={t('nav.threads')} active={view === 'threads'} count={props.threadsUnread} onClick={() => props.onView('threads')} />
        <NavItem icon="inbox" label={t('nav.unreads')} active={view === 'unreads'} count={props.unreadTotal} onClick={() => props.onView('unreads')} />
        <NavItem icon="directory" label={t('nav.directories')} active={view === 'directory'} onClick={() => props.onView('directory')} />
        <NavItem icon="send" label={t('nav.drafts')} active={view === 'drafts'} onClick={() => props.onView('drafts')} />
        <NavItem icon="bookmark" label={t('nav.saved')} active={view === 'saved'} onClick={() => props.onView('saved')} />
        <NavItem icon="folder" label={t('nav.allFiles')} active={view === 'files'} onClick={() => props.onView('files')} />
        <NavItem icon="layers" label={t('nav.feed')} href="/feed" />
        {space && <NavItem icon="users" label={t('nav.members')} href={`/s/${space.slug}/members`} />}
      </ul>

      {heading('starred', t('sidebar.starred'))}
      {!collapsed('starred') && <ul className="space-y-0.5">
        {starred.map(row)}
        {!starred.length && hint('Star a conversation to keep it here. Use the ⋯ next to any channel or message.')}
      </ul>}

      {custom.map(({ section, items }) => <div key={section.id}>
        <div className="mb-1 mt-5 flex items-center justify-between px-2.5">
          <button type="button" onClick={() => toggleCustom(section)} aria-expanded={!section.collapsed}
            className="flex min-w-0 items-center gap-1 text-[13px] font-semibold text-white/60 hover:text-white">
            <Icon name={section.collapsed ? 'chevronRight' : 'chevronDown'} size={14} className="shrink-0" />
            {section.emoji && <span aria-hidden>{section.emoji}</span>}<span className="truncate">{section.name}</span>
          </button>
          <button type="button" aria-label={`Section options for ${section.name}`} aria-haspopup="menu" title="Rename, reorder or delete this section"
            onClick={event => openMenu(below(event), `Options for ${section.name}`, sectionMenu(section))}
            className="rounded p-0.5 text-white/60 hover:bg-white/10 hover:text-white"><Icon name="more" size={16} /></button>
        </div>
        {!section.collapsed && <ul className="space-y-0.5">
          {items.map(row)}
          {!items.length && hint('Empty. Use the ⋯ next to a channel and choose "Move to section".')}
        </ul>}
      </div>)}

      {heading('channels', t('sidebar.channels'), space ? addChannelsMenu : undefined, t('sidebar.addChannels'))}
      {!collapsed('channels') && <ul className="space-y-0.5">
        {!space && hint('Join or create a space to see its channels.')}
        {rest('channel').map(row)}
        {space && quickAction(t('sidebar.addChannels'), addChannelsMenu)}
      </ul>}

      {heading('conversations', t('sidebar.conversations'), () => setComposing(composing === 'group' ? null : 'group'), 'New group conversation')}
      {!collapsed('conversations') && <ul className="space-y-0.5">
        {rest('group').map(row)}
        {!rest('group').length && composing !== 'group' && hint('No group conversations yet')}
        {newForm('group')}
      </ul>}

      {heading('dms', t('sidebar.directMessages'), () => setComposing(composing === 'direct' ? null : 'direct'), 'New message')}
      {!collapsed('dms') && <ul className="space-y-0.5">
        {rest('dm').map(row)}
        {newForm('direct')}
        {space && isAdmin && <li><Link href={`/s/${space.slug}/settings#invites`} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-white/60 hover:bg-white/10 hover:text-white">
          <Icon name="plus" size={15} className="shrink-0" />{t('sidebar.invitePeople')}</Link></li>}
      </ul>}
      <div className="mt-4 border-t border-white/10 pt-2"><ul>
        {quickAction(t('sidebar.newSection'), () => setDialog({ mode: 'new' }))}
      </ul></div>
      {error && <p role="alert" className="mt-3 px-2.5 text-xs text-rose-300">{error}</p>}
    </div>
    <CallBar />
    {menu && <PopupMenu at={menu} label={menu.label} items={menu.items} onClose={() => setMenu(null)} />}
    {dialog && <SectionDialog key={dialog.mode === 'rename' ? dialog.section.id : 'new'}
      initial={dialog.mode === 'rename' ? { name: dialog.section.name, emoji: dialog.section.emoji } : undefined}
      canSpanSpaces={dialog.mode === 'new' && !!space && !(dialog.moveId && byId.get(dialog.moveId)?.kind !== 'channel')}
      onClose={() => setDialog(null)}
      onSave={async (name, emoji, everywhere) => {
        if (dialog.mode === 'rename') await sidebarApi.updateSection(dialog.section.id, { name, emoji });
        else {
          const direct = !!dialog.moveId && byId.get(dialog.moveId)?.kind !== 'channel';
          const created = await sidebarApi.createSection(name, emoji, everywhere || direct || !space ? null : space.id);
          if (dialog.moveId) await sidebarApi.moveTo(created.id, dialog.moveId);
        }
        setDialog(null);
        props.onChanged();
      }} />}
    {creatingChannel && space && <CreateChannelDialog space={space} onClose={() => setCreatingChannel(false)}
      onCreated={channel => { setCreatingChannel(false); props.onChannelCreated(channel); }} />}
  </nav>;
}
