"use client";

import { Button as UiButton, DropdownMenu, Input as UiInput, Sheet, Tooltip } from '@hive/ui';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useAuth } from '../../lib/auth';
import { apiData, requestError, SPACES_CHANGED, type Space } from '../../lib/spaces';
import { isTextEntryTarget } from '../../lib/keyboard';
import { activeStatus } from '../../lib/status';
import { Avatar } from '../ui/avatar';
import { Icon, type IconName } from '../ui/icons';
import { StatusDialog } from '../status-dialog';
import { SpaceIcon, SpaceTiles } from './space-tiles';
import { SpaceSwitcher } from './space-switcher';

function useTheme() {
  const [dark, setDark] = useState(false);
  useEffect(() => { setDark(document.documentElement.classList.contains('dark')); }, []);
  function toggle() {
    const next = !dark;
    setDark(next); document.documentElement.classList.toggle('dark', next);
    try { localStorage.setItem('hive:theme', next ? 'dark' : 'light'); } catch { /* storage unavailable */ }
  }
  return { dark, toggle };
}

/** The switcher strip and fixed-width current-space rail for Hive navigation. */
export function Rail({ spaces, current, onSwitch, unread, todos = 0, switcherOpen, onToggleSwitcher, onOpenSwitcher, onMore, onNewHuddle }: {
  /** Spaces available to the signed-in user. */
  spaces: Space[];
  /** Current space slug from the URL. */
  current: string | null;
  /** Changes the selected space and URL. */
  onSwitch: (slug: string) => void;
  /** Activity count for the global navigation badge. */
  unread: number;
  /** Number of tasks due. */
  todos?: number;
  /** Whether the space switcher strip is open. */
  switcherOpen: boolean;
  /** Toggles and persists the strip state. */
  onToggleSwitcher: () => void;
  /** Opens the switcher without closing it when already open. */
  onOpenSwitcher: () => void;
  /** Opens the mobile More tab's sidebar. */
  onMore: () => void;
  /** Starts a huddle in an available voice channel. */
  onNewHuddle: () => void;
}) {
  const { user, logout, updateUser } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [sheet, setSheet] = useState(false);
  const [join, setJoin] = useState(false);
  const [invite, setInvite] = useState('');
  const [joinError, setJoinError] = useState('');
  const [statusDialog, setStatusDialog] = useState(false);
  const [error, setError] = useState('');
  const [order, setOrder] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const { dark, toggle } = useTheme();
  const ordered = [...spaces].sort((a, b) => {
    const position = (space: Space) => order?.includes(space.id) ? order.indexOf(space.id) : space.position ?? Infinity;
    return Number(b.kind === 'work') - Number(a.kind === 'work') || position(a) - position(b) || a.name.localeCompare(b.name);
  });
  const work = ordered.filter(space => space.kind === 'work');
  const social = ordered.filter(space => space.kind === 'community');
  const selectedSpace = spaces.find(space => space.slug === current) ?? null;
  const status = user?.appear_offline ? 'offline' : user && activeStatus(user).away ? 'away' : 'active';

  useEffect(() => { if (!savingRef.current) setOrder(null); }, [spaces]);
  useEffect(() => {
    const openJoin = () => { setJoinError(''); setJoin(true); };
    window.addEventListener('hive:join-invite', openJoin);
    return () => window.removeEventListener('hive:join-invite', openJoin);
  }, []);
  useEffect(() => {
    const onShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || isTextEntryTarget(event.target)
        || (!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey || !/^[1-9]$/.test(event.key)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      const space = ordered[Number(event.key) - 1];
      if (space) { event.preventDefault(); onSwitch(space.slug); }
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, [ordered, onSwitch]);

  async function saveOrder(ids: string[], kind: Space['kind']) {
    if (savingRef.current) return;
    let index = 0;
    const next = ordered.map(space => space.kind === kind ? ids[index++] : space.id);
    setOrder(next); setSaving(true); savingRef.current = true; setError('');
    try {
      await apiData('/api/me/preferences', { method: 'PATCH', body: JSON.stringify({ spaceOrder: next }) });
      window.dispatchEvent(new Event(SPACES_CHANGED));
    } catch (cause) { setOrder(null); setError(requestError(cause)); }
    finally { setSaving(false); savingRef.current = false; }
  }
  function arrows(event: KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || (event.target as HTMLElement).closest('[data-dragging="true"]') || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]')];
    const index = buttons.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }
  const navItem = (href: string, icon: IconName, label: string, count = 0) => {
    const view = new URLSearchParams(href.split('?')[1]).get('view');
    const isActive = pathname === href.split('?')[0] && (view ? search.get('view') === view : !['inbox', 'todos', 'directory', 'files'].includes(search.get('view') ?? ''));
    return <Tooltip key={href} content={label}><Link href={href} aria-current={isActive ? 'page' : undefined} className={`rail-global-link ${isActive ? 'rail-global-active' : ''}`}>
      <Icon name={icon} size={20} /><span>{label}</span>{count > 0 && <span className="rail-global-badge" aria-label={`${count} unread`}>{count > 99 ? '99+' : count}</span>}
    </Link></Tooltip>;
  };
  const globalNav = <>
    {navItem('/home', 'home', 'Home')}
    {navItem('/home?view=directory', 'message', 'DMs')}
    {navItem('/home?view=inbox', 'bell', 'Activity', unread)}
    {navItem('/home?view=todos', 'checkSquare', 'Tasks', todos)}
    {navItem('/home?view=files', 'folder', 'Files')}
    {navItem('/feed', 'layers', 'Feed')}
    {navItem('/spaces', 'compass', 'Explore')}
  </>;
  const profileItems = [
    { label: 'Set a status', onSelect: () => setStatusDialog(true) },
    { label: 'Preferences', onSelect: () => router.push('/settings') },
    { separator: true, label: '' },
    { label: 'Sign out', onSelect: () => { void logout().catch(cause => setError(requestError(cause))); } },
  ];
  const controls = <>
    <Tooltip content={dark ? 'Switch to light theme' : 'Switch to dark theme'}><UiButton type="button" onClick={toggle} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} className="rail-control"><Icon name={dark ? 'sun' : 'moon'} size={20} /></UiButton></Tooltip>
    {user && <DropdownMenu label="Your profile" triggerTooltip={`Your profile: ${status}`} trigger={<UiButton type="button" aria-label={`Your profile and status: ${status}`} className="rail-profile-trigger"><Avatar name={user.username} src={user.avatar_url} size={40} status={status} statusBorder="var(--rail)" /></UiButton>}
      header={<><strong>{user.username}</strong><span className="ui-menu-subtitle">{status}</span></>} items={profileItems} />}
  </>;
  const createMenu = (trigger: ReactNode, label = 'Create') => <DropdownMenu label={`${label} menu`} triggerTooltip={label} trigger={trigger} items={[
    { label: 'New message', onSelect: () => router.push('/home?view=directory') },
    { label: 'New channel', disabled: !selectedSpace, onSelect: () => router.push('/home?view=directory&dir=channels') },
    { label: 'New huddle', disabled: !selectedSpace, onSelect: onNewHuddle },
  ]} />;
  const addMenu = [
    { label: 'Create a work space', onSelect: () => router.push('/spaces/new?type=workspace') },
    { label: 'Create a community', onSelect: () => router.push('/spaces/new?type=community') },
    { label: 'Join with invite link', onSelect: () => window.dispatchEvent(new Event('hive:join-invite')) },
  ];
  const others = spaces.filter(space => space.slug !== current);
  const spacesMenu = (trigger: ReactNode) => <DropdownMenu label="Spaces menu" triggerTooltip="Your spaces" trigger={trigger} header="Your spaces" items={[
    ...others.map(space => ({ label: `${space.name}${space.kind === 'community' ? ' · community' : ''}`, onSelect: () => onSwitch(space.slug) })),
    ...(others.length ? [{ separator: true, label: '' }] : []),
    { label: 'Browse communities', onSelect: () => router.push('/spaces') },
    { separator: true, label: '' },
    ...addMenu,
  ]} />;
  const tiles = (list: Space[], kind: Space['kind']) => <SpaceTiles spaces={list} current={current} expanded={false} onSwitch={slug => { setSheet(false); onSwitch(slug); }} onOrder={ids => void saveOrder(ids, kind)} disabled={saving} />;

  return <>
    <div className={`rail-switcher-width ${switcherOpen ? 'rail-switcher-width-open' : ''}`} aria-hidden={!switcherOpen} inert={!switcherOpen}>
      <nav aria-label="Spaces" className="on-dark space-switcher-strip" onKeyDown={arrows}>
        {work.length > 0 && <><h2 className="switcher-group-label">WORK</h2>{tiles(work, 'work')}</>}
        {work.length > 0 && social.length > 0 && <div role="separator" className="rail-divider" />}
        {social.length > 0 && <><h2 className="switcher-group-label">SOCIAL</h2>{tiles(social, 'community')}</>}
        {spacesMenu(<UiButton type="button" aria-label="Your spaces" className="rail-add"><Icon name="plus" /></UiButton>)}
      </nav>
    </div>
    <div className="rail-shell">
      <nav aria-label="Main" className="on-dark space-rail" onKeyDown={arrows}>
        <SpaceSwitcher current={selectedSpace} compact onOpenSwitcher={onOpenSwitcher} spaces={spaces} onSwitch={onSwitch} stripOpen={switcherOpen} onToggleStrip={onToggleSwitcher} />
        <div className="rail-global">{globalNav}</div>
        <div className="rail-spacer" />
        {createMenu(<UiButton type="button" aria-label="Create" className="rail-create"><Icon name="plus" size={21} /></UiButton>)}
        <div className="rail-profile">{controls}</div>
        {error && <p role="alert" className="px-2 text-xs text-rail-muted">{error}</p>}
      </nav>
    </div>
    <div className="rail-mobile-top on-dark">
      <Sheet open={sheet} onOpenChange={setSheet} title="Your spaces" description="Choose a work space or community."
        trigger={<UiButton type="button" aria-label={selectedSpace ? `Current space: ${selectedSpace.name}` : 'Open spaces'} className="rail-mobile-trigger">
          {selectedSpace ? <SpaceIcon space={selectedSpace} /> : <Icon name="layers" />}<span className="truncate">{selectedSpace?.name ?? 'No space yet'}</span><Icon name="chevronDown" size={16} />
        </UiButton>}>
        <nav aria-label="Spaces" onKeyDown={arrows}>
          {([['WORK', work], ['SOCIAL', social]] as const).map(([title, list]) => list.length > 0 && <section key={title} className="mb-5"><h2 className="mb-3 text-xs font-semibold text-muted">{title}</h2><div className="grid grid-cols-4 gap-x-2 gap-y-4">
            {list.map(space => <UiButton tooltip={space.name} key={space.id} type="button" aria-label={space.name} aria-current={space.slug === current ? 'page' : undefined} onClick={() => { setSheet(false); onSwitch(space.slug); }} className={`mobile-space ${space.slug === current ? 'space-current' : ''}`}><SpaceIcon space={space} /><span className="w-full truncate text-xs">{space.name}</span></UiButton>)}
          </div></section>)}
          {createMenu(<UiButton type="button" aria-label="Add a space" className="btn-ghost min-h-11 w-full justify-center"><Icon name="plus" />Add a space</UiButton>, 'Add a space')}
          <div className="on-dark mt-4 flex items-center justify-center gap-3 rounded-xl bg-rail p-3">{controls}</div>
        </nav>
      </Sheet>
    </div>
    <nav aria-label="Global navigation" className="on-dark rail-mobile-tabs">
      {navItem('/home', 'home', 'Home')}{navItem('/home?view=directory', 'message', 'DMs')}{navItem('/home?view=inbox', 'bell', 'Activity')}{navItem('/home?view=todos', 'checkSquare', 'Tasks')}
      <Tooltip content="More"><UiButton type="button" aria-label="More" onClick={onMore} className="rail-global-link"><Icon name="more" size={20} /><span>More</span></UiButton></Tooltip>
    </nav>
    <Sheet open={join} onOpenChange={setJoin} title="Join with invite link" description="Paste the invite link or code someone shared with you." center>
      <form onSubmit={event => {
        event.preventDefault();
        const raw = invite.trim();
        const code = raw.match(/(?:^|\/)invite\/([a-zA-Z0-9_-]+)(?:[?#].*)?$/)?.[1] ?? (/^[a-zA-Z0-9_-]+$/.test(raw) ? raw : null);
        if (!code) { setJoinError('Enter a valid invite link or code.'); return; }
        setJoin(false); router.push(`/invite/${encodeURIComponent(code)}`);
      }}>
        <label className="block text-sm font-medium">Invite link or code<UiInput autoFocus className="auth-input" value={invite} onChange={event => setInvite(event.target.value)} required /></label>
        {joinError && <p role="alert" className="mt-2 text-sm text-rose-500">{joinError}</p>}
        <UiButton className="auth-button mt-4 min-h-11">Open invite</UiButton>
      </form>
    </Sheet>
    {statusDialog && user && <StatusDialog user={user} onSaved={updateUser} onClose={() => setStatusDialog(false)} />}
  </>;
}
