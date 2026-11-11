'use client';

import { Button as UiButton } from '@hive/ui';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { Attachment } from '@hive/shared';
import { API_URL } from '../../lib/api';
import { fixVideoDuration } from '../../lib/video-duration';

export const mediaUrl = (url: string) => /^https?:\/\//.test(url) ? url : `${API_URL}${url}`;

export function MediaGallery({ files, postId, full = false }: { files: Attachment[]; postId: string; full?: boolean }) {
  const [index, setIndex] = useState(0);
  const [lightbox, setLightbox] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const file = files[index % files.length];
  function move(amount: number) { setIndex(value => (value + amount + files.length) % files.length); }
  useEffect(() => {
    if (!lightbox) return;
    returnFocus.current = document.activeElement as HTMLElement;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const previous = document.body.style.overflow; document.body.style.overflow = 'hidden';
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLightbox(false);
      if (event.key === 'ArrowLeft') { event.preventDefault(); setIndex(value => (value - 1 + files.length) % files.length); }
      if (event.key === 'ArrowRight') { event.preventDefault(); setIndex(value => (value + 1) % files.length); }
      if (event.key === 'Tab') {
        const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
        const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', key);
    return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', key); returnFocus.current?.focus(); };
  }, [lightbox, files.length]);
  if (!file) return null;
  if (file.kind === 'video') return <video src={mediaUrl(file.url)} controls preload="metadata" playsInline onLoadedMetadata={fixVideoDuration} className="mt-3 max-h-[512px] w-full rounded bg-[rgb(0_0_0)]" />;
  const image = <img src={mediaUrl(file.url)} alt={file.filename || `Image ${index + 1} of ${files.length}`} loading="lazy" className="max-h-[512px] w-full object-contain" />;
  const controls = <div className="flex items-center justify-between gap-3 p-2 text-sm text-amber-400">
    <UiButton tooltip="Previous image" type="button" aria-label="Previous image" onClick={() => move(-1)}>‹</UiButton>
    <span>{index + 1}/{files.length}</span>
    {full && <div className="flex flex-wrap gap-1">{files.map((item, i) => <UiButton tooltip={`Image ${i + 1}`} key={item.id} aria-label={`Image ${i + 1}`} aria-pressed={index === i} onClick={() => setIndex(i)} className={`h-2 w-2 rounded-full ${i === index ? 'bg-amber-400' : 'bg-white/30'}`} />)}</div>}
    <UiButton tooltip="Next image" type="button" aria-label="Next image" onClick={() => move(1)}>›</UiButton>
  </div>;
  return <div className="mt-3 min-w-0 rounded bg-[rgb(0_0_0/0.40)]" onKeyDown={event => {
    if (full && !lightbox && event.key === 'ArrowLeft') move(-1);
    if (full && !lightbox && event.key === 'ArrowRight') move(1);
  }}>
    {full ? <UiButton tooltip="Open image" type="button" className="block w-full" aria-label="Open image" onClick={() => setLightbox(true)}>{image}</UiButton> : <Link href={`/p/${postId}`}>{image}</Link>}
    {files.length > 1 && controls}
    {lightbox && <div ref={dialog} role="dialog" aria-modal="true" aria-label="Image gallery" className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[rgb(0_0_0/0.95)] p-4" onClick={event => { if (event.target === event.currentTarget) setLightbox(false); }}>
      <UiButton tooltip="Close image" className="absolute right-5 top-4 text-2xl text-white" aria-label="Close image" onClick={() => setLightbox(false)}>×</UiButton>
      <img src={mediaUrl(file.url)} alt={file.filename} className="max-h-[80vh] max-w-full object-contain" />
      {files.length > 1 && controls}
    </div>}
  </div>;
}
