"use client";

import { AlertDialog, Button as UiButton, DropdownMenu, Sheet } from '@hive/ui';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { apiData, requestError, SPACES_CHANGED, type Space } from '../../lib/spaces';
import { Icon } from '../ui/icons';
import { SpaceIcon } from './space-tiles';

/** Shared current-space action menu used by the rail tile and sidebar heading. */
export function SpaceSwitcher({ current, onOpenSwitcher, compact = false }: {
  /** The current membership, or null when the account has no spaces. */
  current: Space | null;
  /** Opens the space switcher strip. */
  onOpenSwitcher?: () => void;
  /** Renders the compact square trigger used in the main rail. */
  compact?: boolean;
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
    : <UiButton type="button" disabled={!current} className="space-sidebar-heading flex min-h-11 w-full items-center justify-between gap-2 rounded-xl px-1 text-left hover:bg-white/5 disabled:opacity-100">
      <span className="truncate">{current?.name ?? 'No space yet'}</span>{current && <Icon name="chevronDown" size={18} />}
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
    <DropdownMenu label="Space menu" trigger={trigger} triggerTooltip={compact ? current?.name : undefined} header={<><strong>{current?.name ?? 'No space yet'}</strong>{current && <span className="ui-menu-subtitle">{current.member_count} {current.member_count === 1 ? 'member' : 'members'}</span>}</>}
      items={[
        { label: 'Invite people', disabled: !current || !manage, onSelect: () => current && router.push(`/s/${current.slug}/settings#invites`) },
        { label: 'Space settings', disabled: !current || !manage, onSelect: () => current && router.push(`/s/${current.slug}/settings`) },
        { label: 'Notification preferences', disabled: !current, onSelect: () => { setError(''); setNotifications(true); } },
        { separator: true, label: '' },
        { label: 'Switch space', disabled: !onOpenSwitcher, onSelect: onOpenSwitcher },
        { label: 'Add a space', children: [
          { label: 'Create a work space', onSelect: () => router.push('/spaces/new?type=workspace') },
          { label: 'Create a community', onSelect: () => router.push('/spaces/new?type=community') },
          { label: 'Join with invite link', onSelect: () => window.dispatchEvent(new Event('hive:join-invite')) },
        ] },
        { separator: true, label: '' },
        { label: 'Sign out of this space', disabled: !current, danger: true, onSelect: () => { setError(''); setLeaving(true); } },
      ]} />
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
