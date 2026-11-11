'use client';

import { forwardRef, useEffect, useRef, useState } from 'react';

/** Lazy-loaded Emoji Mart with search, skin tone, and local recent history. */
export const EmojiPicker = forwardRef<HTMLDivElement, { onSelect: (emoji: string) => void; onClose?: () => void; className?: string }>(function EmojiPicker({ onSelect, onClose, className = '' }, ref) {
  const host = useRef<HTMLDivElement>(null); const select = useRef(onSelect); select.current = onSelect; const [error, setError] = useState('');
  useEffect(() => {
    let active = true; let picker: HTMLElement | undefined;
    Promise.all([import('emoji-mart'), import('@emoji-mart/data')]).then(([{ Picker }, { default: data }]) => {
      if (!active || !host.current) return;
      picker = new Picker({ data, theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light', previewPosition: 'none', skinTonePosition: 'search', autoFocus: true, onEmojiSelect: (emoji: { native: string }) => select.current(emoji.native) }) as unknown as HTMLElement;
      host.current.replaceChildren(picker);
    }).catch(() => { if (active) setError('Could not load emojis. Reopen the picker to retry.'); });
    return () => { active = false; picker?.remove(); };
  }, []);
  return <div ref={ref} className={`ui-emoji-picker ${className}`} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose?.(); } }}><div ref={host} />{error && <p role="alert">{error}</p>}</div>;
});
