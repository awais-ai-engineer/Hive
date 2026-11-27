'use client';

import { Button, Popover } from '@hive/ui';
import { EmojiPicker } from './emoji-picker';
import { Icon } from './ui/icons';

type Props = { className: string; disabled: boolean; label: string; onRememberCaret: () => void; onInsert: (emoji: string) => void; onClose: () => void };

/** Shared Radix popover gives the composer picker reliable outside-click and Escape dismissal. */
export function ComposerEmojiButton({ className, disabled, label, onRememberCaret, onInsert, onClose }: Props) {
  return <Popover label={label} side="top" align="start" trigger={<Button type="button" className={className} disabled={disabled} aria-label={label} tooltip={label}><Icon name="smile" size={18} /></Button>} className="w-fit max-w-[calc(100vw-24px)] overflow-hidden border-0 bg-transparent p-0 shadow-none" onOpenChange={open => { if (open) onRememberCaret(); else onClose(); }}>
    <EmojiPicker onSelect={emoji => { onInsert(emoji); onClose(); }} onClose={onClose} />
  </Popover>;
}
