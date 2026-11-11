'use client';

import { Textarea as UiTextarea, Button as UiButton } from '@hive/ui';

import { useState } from 'react';
import { commentCreateSchema } from '@hive/shared';

type Props = {
  onSubmit: (body: string) => Promise<void>;
  reason?: string;
  placeholder?: string;
  submitLabel?: string;
  initialValue?: string;
  onCancel?: () => void;
  autoFocus?: boolean;
};

export function CommentComposer({
  onSubmit,
  reason,
  placeholder = 'What are your thoughts?',
  submitLabel = 'Comment',
  initialValue = '',
  onCancel,
  autoFocus = false,
}: Props) {
  const [body, setBody] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleSend() {
    if (busy || reason) return;
    setError('');
    const parsed = commentCreateSchema.safeParse({ body });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Please check your comment.');
      return;
    }
    setBusy(true);
    try {
      await onSubmit(parsed.data.body);
      setBody('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to post comment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-white/10 bg-surface p-3">
      {error && (
        <p role="alert" className="mb-2 text-xs text-rose-400">
          {error}
        </p>
      )}
      <UiTextarea
        autoFocus={autoFocus}
        disabled={!!reason || busy}
        value={body}
        maxLength={10000}
        placeholder={reason || placeholder}
        onChange={event => setBody(event.target.value)}
        onKeyDown={event => {
          if (
            event.key === 'Enter' &&
            (event.ctrlKey || event.metaKey) &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            void handleSend();
          }
        }}
        className="w-full resize-y rounded border border-white/10 bg-canvas p-2.5 text-sm text-white/90 placeholder-white/35 focus:border-amber-400/60 focus:outline-none disabled:opacity-50 min-h-24"
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-white/40">
          {10000 - body.length} characters left · Ctrl+Enter to submit
        </span>
        <div className="flex items-center gap-2">
          {onCancel && (
            <UiButton
              type="button"
              disabled={busy}
              onClick={onCancel}
              className="rounded px-3 py-1.5 text-xs text-white/60 hover:text-white"
            >
              Cancel
            </UiButton>
          )}
          <UiButton
            type="button"
            disabled={!!reason || busy || !body.trim()}
            onClick={() => void handleSend()}
            className="rounded bg-amber-400 px-3.5 py-1.5 text-xs font-semibold text-black hover:bg-amber-300 disabled:opacity-40"
          >
            {busy ? 'Posting…' : submitLabel}
          </UiButton>
        </div>
      </div>
    </div>
  );
}
