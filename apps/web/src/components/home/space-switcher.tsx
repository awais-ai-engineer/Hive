'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { Space } from '../../lib/spaces';
import { SpaceKind } from '../ui/space-kind';

/** Current space name with a dropdown to switch to another of the viewer's spaces. */
export function SpaceSwitcher({ spaces, current, onSwitch }: {
  spaces: Space[]; current: Space | null; onSwitch: (slug: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !box.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', close); };
  }, [open]);

  return <div ref={box} className="relative">
    <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}
      className="flex w-full items-center justify-between gap-2 rounded px-1 py-1 text-left text-lg font-bold hover:bg-white/5">
      <span className="min-w-0">
        <span className="flex items-center gap-1.5"><span className="truncate">{current?.name ?? 'Choose a space'}</span>{current && <SpaceKind space={current} size={15} />}</span>
        {current && <span className="flex items-center gap-1.5 text-xs font-normal text-white/65"><span className="h-2 w-2 rounded-full bg-emerald-400" />{current.member_count} members</span>}
      </span><span aria-hidden className="text-sm text-white/60">▾</span>
    </button>
    {open && <div role="menu" className="on-surface absolute inset-x-0 top-full z-30 mt-1 rounded-md border border-white/15 bg-surface py-1 shadow-xl">
      {spaces.map(space => <button key={space.id} role="menuitem" type="button"
        onClick={() => { onSwitch(space.slug); setOpen(false); }}
        className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-white/10 ${space.id === current?.id ? 'text-amber-400' : 'text-white/80'}`}>
        <span className="flex min-w-0 items-center gap-1.5"><SpaceKind space={space} /><span className="truncate">{space.name}</span></span><span className="text-xs text-white/40">{space.type === 'workspace' ? 'Private' : 'Public'}</span>
      </button>)}
      <div className="my-1 border-t border-white/10" />
      <Link role="menuitem" href="/spaces" className="block px-3 py-1.5 text-sm text-white/70 hover:bg-white/10">Browse spaces</Link>
      <Link role="menuitem" href="/spaces/new" className="block px-3 py-1.5 text-sm text-white/70 hover:bg-white/10">Create space</Link>
    </div>}
  </div>;
}
