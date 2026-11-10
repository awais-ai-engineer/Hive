'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../ui/icons';

export type MenuItem =
  | { heading: string }
  | { separator: true }
  | { label: string; onSelect: () => void; icon?: IconName; checked?: boolean; danger?: boolean; disabled?: boolean };

/** A small menu placed at a screen point (a button or a right-click). Arrow keys move, Escape closes. */
export function PopupMenu({ at, items, label, onClose }: {
  at: { x: number; y: number }; items: MenuItem[]; label: string; onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: at.x, top: at.y });
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    setPlace({
      left: Math.max(8, Math.min(at.x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(at.y, window.innerHeight - rect.height - 8)),
    });
  }, [at.x, at.y]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus();
    const away = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) close.current(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key === 'Tab') close.current();
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const buttons = [...(box.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
      const index = buttons.indexOf(document.activeElement as HTMLElement);
      const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
      buttons[(next + buttons.length) % buttons.length]?.focus();
    };
    const hide = () => close.current();
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', hide);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); window.removeEventListener('resize', hide); if (previous?.isConnected) previous.focus(); };
  }, []);

  return <div ref={box} role="menu" aria-label={label} style={{ position: 'fixed', left: place.left, top: place.top }}
    className="on-surface animate-in z-[60] max-h-[70vh] w-64 max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl border border-white/10 bg-surface p-1 text-sm shadow-[var(--shadow-pop)]">
    {items.map((item, index) => {
      if ('heading' in item) return <p key={index} className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-white/45">{item.heading}</p>;
      if ('separator' in item) return <div key={index} role="separator" className="my-1 h-px bg-white/10" />;
      return <button key={index} type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
        disabled={item.disabled} aria-checked={item.checked} onClick={() => { onClose(); item.onSelect(); }}
        className={`flex w-full items-center gap-2 rounded-lg px-2.5 min-h-11 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-50 hover:bg-[var(--surface-2)] focus:bg-[var(--surface-2)] focus:outline-none ${item.danger ? 'text-rose-500' : ''}`}>
        {item.icon ? <Icon name={item.icon} size={15} className="shrink-0 opacity-70" /> : item.checked !== undefined ? <span className="w-[15px] shrink-0 text-center text-brand">{item.checked ? '✓' : ''}</span> : null}
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
      </button>;
    })}
  </div>;
}
