'use client';

import { Tooltip as UiTooltip } from '@hive/ui';

import { Button as UiButton } from '@hive/ui';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { fileHref, fileLocation, type FileItem } from '../../lib/files';
import { Icon } from '../ui/icons';
import { fixVideoDuration } from '../../lib/video-duration';

/** Full-screen viewer for images and videos: arrows move, Esc closes, focus stays inside. */
export function Lightbox({ items, index, onIndex, onClose }: {
  items: FileItem[]; index: number; onIndex: (index: number) => void; onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const file = items[index];
  const go = (step: number) => onIndex((index + step + items.length) % items.length);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>('button')?.focus();
    return () => before?.focus?.();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      else if (event.key === 'ArrowLeft' && items.length > 1) go(-1);
      else if (event.key === 'ArrowRight' && items.length > 1) go(1);
      else if (event.key === 'Tab') {
        const focusable = Array.from(box.current?.querySelectorAll<HTMLElement>('button, a[href]') ?? []);
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!file) return null;
  const location = fileLocation(file);
  const round = 'flex h-10 w-10 items-center justify-center rounded-full bg-[rgb(255_255_255/0.15)] hover:bg-[rgb(255_255_255/0.3)]';
  return <div ref={box} role="dialog" aria-modal="true" aria-label={`Viewing ${file.filename}`} className="fixed inset-0 z-50 flex flex-col bg-[rgb(0_0_0/0.9)]" style={{ color: 'var(--rail-fg)' }}>
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{file.filename}</p>
        <p className="truncate text-xs opacity-70">{file.uploader.displayName || file.uploader.username} · {new Date(file.createdAt).toLocaleString()} · {index + 1} of {items.length}</p>
      </div>
      {location && <Link href={location} className="rounded-lg bg-[rgb(255_255_255/0.15)] px-3 py-1.5 text-sm hover:bg-[rgb(255_255_255/0.3)]">Go to message</Link>}
      <UiTooltip content="Download"><a href={fileHref(file.url)} download={file.filename} aria-label="Download" className={round}><Icon name="download" /></a></UiTooltip>
      <UiButton type="button" onClick={onClose} aria-label="Close" tooltip="Close" className={round}><Icon name="x" /></UiButton>
    </div>
    <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-4" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      {items.length > 1 && <UiButton type="button" onClick={() => go(-1)} aria-label="Previous" tooltip="Previous" className={`${round} absolute left-3 z-10`}><Icon name="chevronLeft" /></UiButton>}
      {file.kind === 'video'
        ? <video key={file.id} src={fileHref(file.url)} controls autoPlay playsInline onLoadedMetadata={fixVideoDuration} className="max-h-full max-w-full" />
        : <img key={file.id} src={fileHref(file.url)} alt={file.filename} className="max-h-full max-w-full object-contain" />}
      {items.length > 1 && <UiButton type="button" onClick={() => go(1)} aria-label="Next" tooltip="Next" className={`${round} absolute right-3 z-10`}><Icon name="chevronRight" /></UiButton>}
    </div>
  </div>;
}
