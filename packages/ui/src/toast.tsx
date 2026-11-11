'use client';

import { forwardRef } from 'react';
import { Toaster, toast } from 'sonner';
export { toast };

/** Shared success/info/error toasts, five-second duration, with optional actions. */
export const ToastHost = forwardRef<HTMLDivElement, { className?: string }>(function ToastHost({ className = '' }, ref) {
  return <div ref={ref} className={className}><Toaster position="bottom-right" duration={5000} closeButton toastOptions={{ classNames: { toast: 'ui-toast', title: 'ui-toast-title', description: 'ui-help', actionButton: 'ui-toast-action', closeButton: 'ui-toast-close' } }} /></div>;
});
