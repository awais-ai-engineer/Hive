"use client";

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Sheet, Tooltip } from '@hive/ui';
import { useAuth } from '../../lib/auth';
import { apiData, requestError, SPACES_CHANGED, type Space } from '../../lib/spaces';
import { activeStatus } from '../../lib/status';
import { Avatar } from '../ui/avatar';
import { Icon, type IconName } from '../ui/icons';
import { StatusDialog } from '../status-dialog';
import { PopupMenu, type MenuItem } from './popup-menu';
import { SpaceIcon, SpaceTiles } from './space-tiles';

function useTheme() {
  const [dark, setDark] = useState(false);
  useEffect(() => { setDark(document.documentElement.classList.contains('dark')); }, []);
  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try { localStorage.setItem('hive:theme', next ? 'dark' : 'light'); } catch { /* storage unavailable */ }
  }
  return { dark, toggle };
}


/** Space navigation, desktop expansion, and the mobile space sheet. */
export function Rail({ spaces, current, onSwitch, unread, todos = 0 }: {
  spaces: Space[]; current: string | null; onSwitch: (slug: string) => void; unread: number; todos?: number;
}) {
  const { user, logout, updateUser } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [join, setJoin] = useState(false);
  const [invite, setInvite] = useState('');
  const [joinError, setJoinError] = useState('');
  const [statusDialog, setStatusDialog] = useState(false);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; label: string; items: MenuItem[] } | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState('');
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const enter = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const leave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { dark, toggle } = useTheme();
  const expanded = pinned || hovered;
  const active = optimistic ?? current;
  const ordered = [...spaces].sort((a, b) => {
    const position = (space: Space) => order?.includes(space.id) ? order.indexOf(space.id) : space.position ?? Infinity;
    return Number(b.kind === 'work') - Number(a.kind === 'work') || position(a) - position(b) || a.name.localeCompare(b.name);
  });
  const work = ordered.filter(space => space.kind === 'work');
  const social = ordered.filter(space => space.kind === 'community');
  const selectedSpace = spaces.find(space => space.slug === active);
  const status = user?.appear_offline ? 'offline' : user && activeStatus(user).away ? 'away' : 'active';

  useEffect(() => { try { setPinned(localStorage.getItem('hive.rail.pinned') === 'true'); } catch { /* storage unavailable */ } }, []);
  useEffect(() => () => { clearTimeout(enter.current); clearTimeout(leave.current); }, []);
  useEffect(() => setOptimistic(null), [current]);
  useEffect(() => { if (!savingRef.current) setOrder(null); }, [spaces]);
  const switchSpace = (slug: string) => { setOptimistic(slug); setSheet(false); onSwitch(slug); };
  const switchRef = useRef(switchSpace);
  switchRef.current = switchSpace;
  const orderedRef = useRef(ordered);
  orderedRef.current = ordered;
  useEffect(() => {
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.altKey || !/^[1-9]$/.test(event.key)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      const space = orderedRef.current[Number(event.key) - 1];
      if (space) { event.preventDefault(); switchRef.current(space.slug); }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);

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
  const below = (button: HTMLElement) => { const box = button.getBoundingClientRect(); return { x: box.right + 8, y: box.top }; };
  function addMenu(button: HTMLElement) {
    setSheet(false);
    setMenu({ at: below(button), label: 'Add a space', items: [
      { label: 'Create a work space', icon: 'lock', onSelect: () => router.push('/spaces/new?type=workspace') },
      { label: 'Create a community', icon: 'globe', onSelect: () => router.push('/spaces/new?type=community') },
      { label: 'Join with invite link', icon: 'users', onSelect: () => { setSheet(false); setJoinError(''); setJoin(true); } },
    ] });
  }
  function profileMenu(button: HTMLElement) {
    setSheet(false);
    setMenu({ at: below(button), label: 'Your profile', items: [
      { label: 'Set a status', icon: 'smile', onSelect: () => { setSheet(false); setStatusDialog(true); } },
      { label: 'Preferences', icon: 'settings', onSelect: () => router.push('/settings') },
      { label: 'Sign out', icon: 'logout', onSelect: () => { void logout().catch(cause => setError(requestError(cause))); } },
    ] });
  }
  const navItem = (href: string, icon: IconName, label: string, count = 0) => {
    const view = new URLSearchParams(href.split('?')[1]).get('view');
    const isActive = pathname === href.split('?')[0] && (view ? search.get('view') === view : !['inbox', 'todos'].includes(search.get('view') ?? ''));
    return <Tooltip key={href} content={label}><Link href={href} aria-current={isActive ? 'page' : undefined} className={`rail-global-link ${isActive ? 'rail-global-active' : ''}`}>
      <Icon name={icon} size={20} /><span>{label}</span>{count > 0 && <span className="rail-global-badge" aria-label={`${count} unread`}>{count > 99 ? '99+' : count}</span>}
    </Link></Tooltip>;
  };
  const globalNav = <>{navItem('/home', 'home', 'Home')}{navItem('/home?view=inbox', 'bell', 'Activity', unread)}{navItem('/home?view=todos', 'checkSquare', 'Tasks', todos)}{navItem('/spaces', 'compass', 'Explore')}</>;
  const controls = <>
    <Tooltip content={dark ? 'Switch to light theme' : 'Switch to dark theme'}><button type="button" onClick={toggle} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} className="rail-control"><Icon name={dark ? 'sun' : 'moon'} size={20} /></button></Tooltip>
    {user && <Tooltip content={`Your profile: ${status}`}><button type="button" aria-label={`Your profile and status: ${status}`} aria-haspopup="menu" aria-expanded={menu?.label === 'Your profile'} onClick={event => profileMenu(event.currentTarget)} className="rail-control">
      <Avatar name={user.username} src={user.avatar_url} size={44} status={status} statusBorder="var(--rail)" />
    </button></Tooltip>}
  </>;
  return <>
    <div className={`rail-shell ${pinned ? 'rail-pinned' : ''}`}>
      <nav aria-label="Spaces" className={`on-dark space-rail ${expanded ? 'space-rail-expanded' : ''}`} onKeyDown={arrows}
        onPointerEnter={event => { if (event.pointerType !== 'mouse') return; clearTimeout(leave.current); enter.current = setTimeout(() => setHovered(true), 600); }}
        onPointerLeave={() => { clearTimeout(enter.current); leave.current = setTimeout(() => setHovered(false), 300); }}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHovered(false); }}>
        <Tooltip content={pinned ? 'Collapse spaces' : 'Expand spaces'}><button type="button" aria-label={pinned ? 'Collapse spaces' : 'Expand spaces'} aria-expanded={expanded} className="rail-control rail-expand"
          onClick={() => { const next = !pinned; setPinned(next); setHovered(false); clearTimeout(enter.current); try { localStorage.setItem('hive.rail.pinned', String(next)); } catch { /* storage unavailable */ } }}>
          <Icon name={pinned ? 'chevronLeft' : 'chevronRight'} size={18} />{expanded && <span className="text-sm">Spaces</span>}
        </button></Tooltip>
        <div className="rail-spaces">
          {work.length > 0 && <><h2 className="rail-group-label">WORK</h2><SpaceTiles spaces={work} current={active} expanded={expanded} onSwitch={switchSpace} onOrder={ids => void saveOrder(ids, 'work')} disabled={saving} /></>}
          {work.length > 0 && social.length > 0 && <div role="separator" className="rail-divider" />}
          {social.length > 0 && <><h2 className="rail-group-label">SOCIAL</h2><SpaceTiles spaces={social} current={active} expanded={expanded} onSwitch={switchSpace} onOrder={ids => void saveOrder(ids, 'community')} disabled={saving} /></>}
          <Tooltip content="Add a space"><button type="button" aria-label="Add a space" aria-haspopup="menu" aria-expanded={menu?.label === 'Add a space'} className="rail-add" onClick={event => addMenu(event.currentTarget)}><Icon name="plus" /></button></Tooltip>
        </div>
        <div role="separator" className="rail-divider" />
        <div className="rail-global">{globalNav}</div>
        <div className="rail-profile">{controls}</div>
        {error && <p role="alert" className="px-2 text-xs text-rail-muted">{error}</p>}
      </nav>
    </div>
    <div className="rail-mobile-top on-dark">
      <Sheet open={sheet} onOpenChange={setSheet} title="Your spaces" description="Choose a work space or community."
        trigger={<button type="button" aria-label="Open spaces" className="rail-mobile-trigger">{selectedSpace ? <SpaceIcon space={selectedSpace} /> : <Icon name="layers" />}<span className="truncate">{selectedSpace?.name ?? 'Spaces'}</span><Icon name="chevronDown" size={16} /></button>}>
        <nav aria-label="Spaces">
          {([['WORK', work], ['SOCIAL', social]] as const).map(([title, list]) => list.length > 0 && <section key={title} className="mb-5"><h2 className="mb-3 text-xs font-semibold text-muted">{title}</h2><div className="grid grid-cols-4 gap-x-2 gap-y-4">
            {list.map(space => <button key={space.id} type="button" aria-label={space.name} aria-current={space.slug === active ? 'page' : undefined} onClick={() => switchSpace(space.slug)} className={`mobile-space ${space.slug === active ? 'space-current' : ''}`}><SpaceIcon space={space} /><span className="w-full truncate text-xs">{space.name}</span></button>)}
          </div></section>)}
          {!spaces.length && <p className="mb-4 text-sm text-muted">No space yet. Create one or browse communities to get started.</p>}
          <button type="button" className="btn-ghost min-h-11 w-full justify-center" aria-haspopup="menu" onClick={event => addMenu(event.currentTarget)}><Icon name="plus" />Add a space</button>
          <div className="on-dark mt-4 flex items-center justify-center gap-3 rounded-xl bg-rail p-3">{controls}</div>
        </nav>
      </Sheet>
    </div>
    <nav aria-label="Global navigation" className="on-dark rail-mobile-tabs">{globalNav}</nav>
    {menu && <PopupMenu at={menu.at} label={menu.label} items={menu.items} onClose={() => setMenu(null)} />}
    <Sheet open={join} onOpenChange={setJoin} title="Join with invite link" description="Paste the invite link or code someone shared with you." center>
      <form onSubmit={event => {
        event.preventDefault();
        const raw = invite.trim();
        const code = raw.match(/(?:^|\/)invite\/([a-zA-Z0-9_-]+)(?:[?#].*)?$/)?.[1] ?? (/^[a-zA-Z0-9_-]+$/.test(raw) ? raw : null);
        if (!code) { setJoinError('Enter a valid invite link or code.'); return; }
        setJoin(false); router.push(`/invite/${encodeURIComponent(code)}`);
      }}>
        <label className="block text-sm font-medium">Invite link or code<input autoFocus className="auth-input" value={invite} onChange={event => setInvite(event.target.value)} required /></label>
        {joinError && <p role="alert" className="mt-2 text-sm text-rose-500">{joinError}</p>}
        <button className="auth-button mt-4 min-h-11">Open invite</button>
      </form>
    </Sheet>
    {statusDialog && user && <StatusDialog user={user} onSaved={updateUser} onClose={() => setStatusDialog(false)} />}
  </>;
}
