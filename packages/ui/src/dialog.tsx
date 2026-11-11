'use client';

import { forwardRef, useEffect, useState, type ReactNode, type ComponentRef } from 'react';
import * as Primitive from '@radix-ui/react-dialog';
import * as Alert from '@radix-ui/react-alert-dialog';
import { Button } from './controls';
import { toast } from 'sonner';

export type DialogProps = {
  /** Controlled modal state and accessible heading. */
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; children: ReactNode; className?: string; trigger?: ReactNode;
};

/** Modal content with focus trapping and restoration. */
export const Dialog = forwardRef<ComponentRef<typeof Primitive.Content>, DialogProps>(function Dialog({ open, onOpenChange, title, description, children, className = '', trigger }, ref) {
  return <Primitive.Root open={open} onOpenChange={onOpenChange}>{trigger && <Primitive.Trigger asChild>{trigger}</Primitive.Trigger>}<Primitive.Portal><Primitive.Overlay className="ui-modal-overlay" /><Primitive.Content ref={ref} className={`ui-dialog ${className}`}><div className="ui-dialog-heading"><Primitive.Title>{title}</Primitive.Title><Primitive.Close asChild><Button type="button" iconOnly aria-label={`Close ${title}`}>×</Button></Primitive.Close></div><Primitive.Description className="ui-help">{description}</Primitive.Description>{children}</Primitive.Content></Primitive.Portal></Primitive.Root>;
});

export type AlertDialogProps = Omit<DialogProps, 'children'> & { /** Resolve only after the destructive action succeeds. */ onConfirm: () => void | Promise<unknown>; confirmLabel?: string; danger?: boolean; children?: ReactNode };

/** Deliberate confirmation: cancel first, destructive action on the right. */
export const AlertDialog = forwardRef<ComponentRef<typeof Alert.Content>, AlertDialogProps>(function AlertDialog({ open, onOpenChange, title, description, onConfirm, confirmLabel = 'Continue', danger = true, children, className = '', trigger }, ref) {
  const [busy, setBusy] = useState(false);
  return <Alert.Root open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}>{trigger && <Alert.Trigger asChild>{trigger}</Alert.Trigger>}<Alert.Portal><Alert.Overlay className="ui-modal-overlay" /><Alert.Content ref={ref} className={`ui-dialog ${className}`}><Alert.Title className="ui-dialog-heading">{title}</Alert.Title><Alert.Description className="ui-help">{description}</Alert.Description>{children}<div className="ui-dialog-actions"><Alert.Cancel asChild><Button type="button" variant="secondary" disabled={busy}>Cancel</Button></Alert.Cancel><Button type="button" variant={danger ? 'danger' : 'primary'} loading={busy} onClick={async () => { setBusy(true); try { await onConfirm(); onOpenChange(false); } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not complete the action.'); } finally { setBusy(false); } }}>{confirmLabel}</Button></div></Alert.Content></Alert.Portal></Alert.Root>;
});

type Confirmation = { message: string; resolve: (confirmed: boolean) => void };
const queue: Confirmation[] = [];
const listeners = new Set<() => void>();
/** Queue a themed confirmation from event handlers without a native browser dialog. */
export function confirmAction(message: string): Promise<boolean> {
  return new Promise(resolve => { queue.push({ message, resolve }); listeners.forEach(listener => listener()); });
}

/** One app-level host serializes confirmations and resolves them on cancellation. */
export function ConfirmationProvider() {
  const [question, setQuestion] = useState<Confirmation | null>(null);
  useEffect(() => { const update = () => setQuestion(queue[0] ?? null); listeners.add(update); update(); return () => { listeners.delete(update); for (const entry of queue.splice(0)) entry.resolve(false); }; }, []);
  const finish = (confirmed: boolean) => { const current = queue.shift(); current?.resolve(confirmed); listeners.forEach(listener => listener()); };
  const action = question?.message.match(/^(Leave|Delete|Remove|Regenerate)/i)?.[1] ?? 'Continue';
  return <AlertDialog open={!!question} onOpenChange={open => { if (!open && queue[0] === question) finish(false); }} title={`${action} confirmation`} description={question?.message ?? ''} confirmLabel={action} onConfirm={() => finish(true)} />;
}
