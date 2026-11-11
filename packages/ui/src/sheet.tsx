'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { forwardRef, type ComponentRef, type ReactNode } from 'react';

/** Modal bottom sheet with focus trapping, Escape dismissal, and focus restoration. */
export const Sheet = forwardRef<ComponentRef<typeof Dialog.Content>, {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; children: ReactNode; trigger?: ReactNode; center?: boolean; className?: string;
}>(function Sheet({ open, onOpenChange, title, description, children, trigger, center = false, className = '' }, ref) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
    <Dialog.Portal><Dialog.Overlay className="hive-sheet-overlay" />
      <Dialog.Content ref={ref} className={`hive-sheet ${center ? 'hive-sheet-center' : ''} ${className}`}>
        <div className="flex items-center justify-between gap-3"><Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title><Dialog.Close className="flex h-11 w-11 items-center justify-center rounded-xl hover:bg-[var(--surface-2)]" aria-label={`Close ${title}`}>×</Dialog.Close></div>
        <Dialog.Description className="mb-4 text-sm text-muted">{description}</Dialog.Description>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
});
