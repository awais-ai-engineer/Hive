"use client";

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Sheet } from '@hive/ui';
import { apiData, requestError, SPACES_CHANGED, type Space } from '../../lib/spaces';
import { Icon } from '../ui/icons';
import { PopupMenu } from './popup-menu';

/** Actions for the current space; switching lives in the rail. */
export function SpaceSwitcher({ current }: { current: Space | null }) {
  const router = useRouter();
  const trigger = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notifications, setNotifications] = useState(false);
  const manage = current?.my_role === 'owner' || current?.my_role === 'admin';
  const closeMenu = () => { setMenu(null); trigger.current?.focus(); };
  async function leave() {
    if (!current) return;
    setBusy(true); setError('');
    try {
      await apiData(`/api/spaces/${encodeURIComponent(current.slug)}/members/me`, { method: 'DELETE' });
      try { localStorage.removeItem('hive:last-space'); } catch { /* storage unavailable */ }
      window.dispatchEvent(new Event(SPACES_CHANGED));
      setLeaving(false); router.replace('/home');
    } catch (cause) { setError(requestError(cause)); }
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
    <button ref={trigger} type="button" disabled={!current} aria-haspopup="menu" aria-expanded={!!menu}
      onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setMenu({ x: box.left, y: box.bottom + 4 }); }}
      className="space-sidebar-heading flex min-h-11 w-full items-center justify-between gap-2 rounded-xl px-1 text-left hover:bg-white/5 disabled:opacity-100">
      <span className="truncate">{current?.name ?? 'No space yet'}</span>{current && <Icon name="chevronDown" size={18} />}
    </button>
    {menu && current && <PopupMenu at={menu} label="Space actions" onClose={closeMenu} items={[
      { label: 'Invite people', icon: 'users', disabled: !manage, onSelect: () => router.push(`/s/${current.slug}/settings#invites`) },
      { label: 'Space settings', icon: 'settings', disabled: !manage, onSelect: () => router.push(`/s/${current.slug}/settings`) },
      { label: 'Notification preferences', icon: 'bell', onSelect: () => { setError(''); setNotifications(true); } },
      { separator: true },
      { label: 'Leave space', icon: 'logout', danger: true, onSelect: () => { setError(''); setLeaving(true); } },
    ]} />}
    <Sheet open={leaving} onOpenChange={open => { if (!busy) setLeaving(open); }} title="Leave space" center
      description={current?.my_role === 'owner' ? 'Transfer ownership in space settings before leaving this space.' : `Leave ${current?.name ?? 'this space'}? You will need to join again to access its conversations.`}>
      {error && <p role="alert" className="mb-3 text-sm text-rose-500">{error}</p>}
      <div className="flex justify-end gap-2"><button className="btn-ghost min-h-11" onClick={() => setLeaving(false)} disabled={busy}>Cancel</button>
        {current?.my_role === 'owner' ? <button className="auth-button min-h-11" onClick={() => router.push(`/s/${current.slug}/settings`)}>Space settings</button>
          : <button className="min-h-11 rounded-xl bg-rose-600 px-4 font-semibold text-[var(--rail-fg)] disabled:opacity-50" disabled={busy} onClick={() => void leave()}>{busy ? 'Leaving?' : 'Leave space'}</button>}
      </div>
    </Sheet>
    <Sheet open={notifications} onOpenChange={setNotifications} title="Notification preferences" center description={`Choose activity notifications for ${current?.name ?? 'this space'}. Mentions remain visible when muted.`}>
      {error && <p role="alert" className="mb-3 text-sm text-rose-500">{error}</p>}
      <button type="button" role="switch" aria-checked={current?.muted ?? false} disabled={busy} onClick={() => void mute()} className="btn-ghost min-h-11 w-full justify-between"><span>Mute space activity</span><span>{current?.muted ? 'On' : 'Off'}</span></button>
      <button className="btn-ghost mt-3 min-h-11 w-full justify-center" onClick={() => router.push('/settings?section=notifications')}>All notification settings</button>
    </Sheet>
  </>;
}
