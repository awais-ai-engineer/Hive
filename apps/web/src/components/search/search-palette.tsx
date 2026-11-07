'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { SearchPanel } from './search-panel';

export const OPEN_SEARCH = 'hive:search';

/** Ctrl/Cmd+K command palette. Anything can open it with `window.dispatchEvent(new Event(OPEN_SEARCH))`. */
export function SearchPalette() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const before = useRef<HTMLElement | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!user) return;
    const show = () => { before.current = document.activeElement as HTMLElement | null; setOpen(true); };
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); show(); }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_SEARCH, show);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener(OPEN_SEARCH, show); };
  }, [user]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = Array.from(box.current?.querySelectorAll<HTMLElement>('input, button, select, a[href]') ?? []).filter(item => !item.hasAttribute('disabled'));
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  function close() { setOpen(false); before.current?.focus?.(); }
  if (!open || !user) return null;
  return <div className="fixed inset-0 z-50 flex items-start justify-center bg-[rgb(0_0_0/0.5)] p-3 pt-[8vh]" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={box} role="dialog" aria-modal="true" aria-label="Search" className="card w-full max-w-2xl p-4 shadow-[var(--shadow-pop)]">
      <SearchPanel variant="palette" onDone={close} />
    </div>
  </div>;
}
