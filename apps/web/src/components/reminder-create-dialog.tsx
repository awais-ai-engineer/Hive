'use client';

import { Button, Dialog, Input } from '@hive/ui';
import { useId, useMemo, useState } from 'react';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { text: string; remindAt: string }) => Promise<boolean | void> | boolean | void;
};

function localDateTime(date: Date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

/** A compact, local-time reminder composer. The API stores the submitted instant in UTC. */
export function ReminderCreateDialog({ open, onOpenChange, onCreate }: Props) {
  const id = useId();
  const [text, setText] = useState('');
  const [when, setWhen] = useState(() => localDateTime(new Date(Date.now() + 60 * 60_000)));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const quick = useMemo(() => [
    { label: 'In 15 minutes', at: () => new Date(Date.now() + 15 * 60_000) },
    { label: 'In 1 hour', at: () => new Date(Date.now() + 60 * 60_000) },
    { label: 'Tomorrow', at: () => { const date = new Date(); date.setDate(date.getDate() + 1); date.setHours(9, 0, 0, 0); return date; } },
  ], []);
  async function submit() {
    const title = text.trim(); const date = new Date(when);
    if (!title) { setError('Add a reminder description.'); return; }
    if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) { setError('Choose a future date and time.'); return; }
    setBusy(true); setError('');
    try {
      const created = await onCreate({ text: title, remindAt: date.toISOString() });
      if (created === false) return;
      setText(''); setWhen(localDateTime(new Date(Date.now() + 60 * 60_000))); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not set this reminder.'); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange} title="Set a reminder" description="Hive will notify you at the selected time." className="max-w-md">
    <form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <Input id={`${id}-text`} label="Reminder" value={text} maxLength={500} autoFocus placeholder="What do you need to remember?" onChange={event => setText(event.target.value)} />
      <div><span className="ui-label">Quick schedule</span><div className="mt-1 flex flex-wrap gap-2">{quick.map(item => <Button key={item.label} type="button" variant="secondary" onClick={() => setWhen(localDateTime(item.at()))}>{item.label}</Button>)}</div></div>
      <Input id={`${id}-when`} label="Date and time" type="datetime-local" value={when} min={localDateTime(new Date())} onChange={event => setWhen(event.target.value)} />
      {error && <p role="alert" className="text-sm text-rose-500">{error}</p>}
      <div className="ui-dialog-actions"><Button type="button" variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Set reminder</Button></div>
    </form>
  </Dialog>;
}
