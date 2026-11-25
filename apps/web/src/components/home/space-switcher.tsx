"use client";

import { AlertDialog, Button as UiButton, DropdownMenu, Sheet } from '@hive/ui';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { apiData, requestError, SPACES_CHANGED, type Space } from '../../lib/spaces';
import { Icon } from '../ui/icons';
import { OPEN_SEARCH } from '../search/search-palette';
import { SpaceIcon } from './space-tiles';

/** Shared current-space action menu used by the rail tile and sidebar heading. */
export function SpaceSwitcher({ current, onOpenSwitcher, compact = false, spaces = [], onSwitch, stripOpen, onToggleStrip }: {
  /** The current membership, or null when the account has no spaces. */
  current: Space | null;
  /** Opens the space switcher strip. */
  onOpenSwitcher?: () => void;
  /** Renders the compact square trigger used in the main rail. */
  compact?: boolean;
  /** Every space the account belongs to, for the "Switch to" list. */
  spaces?: Space[];
  onSwitch?: (slug: string) => void;
  /** Whether the spaces strip is showing, and the control that toggles it. */
  stripOpen?: boolean;
  onToggleStrip?: () => void;
}) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const manage = current?.my_role === 'owner' || current?.my_role === 'admin';
  const trigger: ReactNode = compact
    ? <UiButton type="button" aria-label={current ? `Current space: ${current.name}` : 'No space yet'} aria-current={current ? 'page' : undefined} className={`rail-current-trigger ${current ? 'space-current' : ''}`} disabled={!current}>
      {current ? <SpaceIcon space={current} /> : <Icon name="layers" size={20} />}
    </UiButton>
    : <UiButton type="button" aria-label={current?.name ?? 'No space yet'} disabled={!current} className="space-sidebar-heading flex min-h-11 w-full items-center justify-between gap-2 rounded-xl px-1 text-left hover:bg-white/5 disabled:opacity-100">
      {current && <span className="shrink-0"><SpaceIcon space={current} /></span>}<span className="min-w-0 flex-1 truncate">{current?.name ?? 'No space yet'}</span>{current && <Icon name="chevronDown" size={18} />}
    </UiButton>;

  async function leave() {
    if (!current) return;
    setBusy(true); setError('');
    try {
      await apiData(`/api/spaces/${encodeURIComponent(current.slug)}/members/me`, { method: 'DELETE' });
      try { localStorage.removeItem('hive:last-space'); } catch { /* storage unavailable */ }
      window.dispatchEvent(new Event(SPACES_CHANGED));
      setLeaving(false); router.replace('/home');
    } catch (cause) { setError(requestError(cause)); throw cause; }
    finally { setBusy(false); }
  }
  async function mute() {
    if (!current) return;
    setBusy(true); setError('');
    try {
      await apiData(`/api/me/spaces/${encodeURIComponent(current.slug)}`, { method: 'PATCH', body: JSON.stringify({ muted: !current.muted }) });
      window.dispatchEvent(new Event(SPACES_CHANGED)); setNotifications(false);
    } catch (cause) { setError(requestError(cause)); }
    finally { setBusy(false); }
  }

  return <>
    <div className={compact ? 'contents' : 'space-sidebar-heading flex min-w-0 items-center gap-1'}>
    <DropdownMenu label="Space menu" trigger={trigger} triggerTooltip={current?.name} header={<><strong>{current?.name ?? 'No space yet'}</strong>{current && <span className="ui-menu-subtitle">{current.member_count} {current.member_count === 1 ? 'member' : 'members'}</span>}</>}
      items={[
        { label: 'Invite people', disabled: !current || !manage, onSelect: () => current && router.push(`/s/${current.slug}/settings#invites`) },
        { label: 'Space settings', disabled: !current || !manage, onSelect: () => current && router.push(`/s/${current.slug}/settings`) },
        { label: 'Notification preferences', disabled: !current, onSelect: () => { setError(''); setNotifications(true); } },
        { separator: true, label: '' },
        { label: 'Switch to', disabled: spaces.length < 2 || !onSwitch, children: spaces.map(space => ({
          label: `${space.slug === current?.slug ? '✓ ' : ''}${space.name}${space.kind === 'community' ? ' · community' : ''}`, disabled: space.slug === current?.slug, onSelect: () => onSwitch?.(space.slug) })) },
        { label: 'Switch space', disabled: spaces.length < 2 || (!onToggleStrip && !onOpenSwitcher), onSelect: () => onOpenSwitcher?.() },
        { label: 'Browse communities', onSelect: () => router.push('/spaces') },
        { label: 'Add a space', children: [
          { label: 'Create a work space', onSelect: () => router.push('/spaces/new?type=workspace') },
          { label: 'Create a community', onSelect: () => router.push('/spaces/new?type=community') },
          { label: 'Join with invite link', onSelect: () => window.dispatchEvent(new Event('hive:join-invite')) },
        ] },
        { separator: true, label: '' },
        { label: 'Sign out of this space', disabled: !current, danger: true, onSelect: () => { setError(''); setLeaving(true); } },
      ]} />
      {!compact && spaces.length > 1 && onToggleStrip && <UiButton type="button" onClick={onToggleStrip} aria-expanded={!!stripOpen} aria-label={stripOpen ? 'Hide space switcher' : 'Show space switcher'} tooltip={stripOpen ? 'Hide space switcher' : 'Show space switcher'} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/60 hover:bg-white/10"><Icon name="sidebar" size={18} /></UiButton>}
      {!compact && <UiButton type="button" onClick={() => window.dispatchEvent(new Event(OPEN_SEARCH))} aria-label="Search" tooltip="Search (Ctrl+K)" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/60 hover:bg-white/10"><Icon name="search" size={18} /></UiButton>}
    </div>
    <AlertDialog open={leaving} onOpenChange={setLeaving} title="Sign out of this space"
      description={current?.my_role === 'owner' ? 'Transfer ownership in space settings before signing out of this space.' : `Leave ${current?.name ?? 'this space'}? You will need to join again to access its conversations.`}
      danger={current?.my_role !== 'owner'} confirmLabel={current?.my_role === 'owner' ? 'Space settings' : 'Sign out of this space'}
      onConfirm={() => current?.my_role === 'owner' ? router.push(`/s/${current.slug}/settings`) : leave()}>{error && <p role="alert" className="ui-error">{error}</p>}</AlertDialog>
    <Sheet open={notifications} onOpenChange={setNotifications} title="Notification preferences" center description={`Choose activity notifications for ${current?.name ?? 'this space'}. Mentions remain visible when muted.`}>
      {error && <p role="alert" className="mb-3 text-sm text-rose-500">{error}</p>}
      <UiButton type="button" role="switch" aria-checked={current?.muted ?? false} disabled={busy} onClick={() => void mute()} className="btn-ghost min-h-11 w-full justify-between"><span>Mute space activity</span><span>{current?.muted ? 'On' : 'Off'}</span></UiButton>
      <UiButton className="btn-ghost mt-3 min-h-11 w-full justify-center" onClick={() => router.push('/settings?section=notifications')}>All notification settings</UiButton>
    </Sheet>
  </>;
}
