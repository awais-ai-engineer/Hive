'use client';

import { Button as UiButton, Textarea as UiTextarea, Select as UiSelect, DatePicker as UiDatePicker } from '@hive/ui';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import type { Person } from '../../lib/docs';
import { requestError } from '../../lib/spaces';
import { QUICK_DUES, TASKS_CHANGED, addDays, dayKey, dueFromDay, tasksApi } from '../../lib/tasks';
import { Icon } from '../ui/icons';

/** Modal that turns a chat message into a to-do: pick who does it and when, then save. */
export function AddTodoDialog({ messageId, channelId, text, userId, onClose }: {
  messageId: string; channelId: string; text: string; userId: string; onClose: () => void;
}) {
  const [title, setTitle] = useState(text.trim().slice(0, 200) || 'Follow up on this message');
  const [people, setPeople] = useState<Person[]>([]);
  const [assignee, setAssignee] = useState('');
  const [day, setDay] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => { tasksApi.assignees(channelId).then(setPeople).catch(() => {}); }, [channelId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return setError('Give the to-do a title.');
    setBusy(true); setError('');
    try {
      await tasksApi.create({
        title: title.trim(), channel_id: channelId, source_message_id: messageId,
        assignee_id: assignee || userId, due_at: day ? dueFromDay(day) : null,
      });
      window.dispatchEvent(new Event(TASKS_CHANGED));
      setAdded(true);
    } catch (cause) { setError(requestError(cause)); }
    setBusy(false);
  }

  return <div className="on-surface fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4">
    <UiButton tooltip="Close" type="button" aria-label="Close" onClick={onClose} className="fixed inset-0 bg-[rgb(0_0_0/0.5)]" />
    <form role="dialog" aria-modal="true" aria-label="Add to to-dos" onSubmit={event => void submit(event)} className="card relative my-auto w-full max-w-md space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">{added ? 'Added to to-dos' : 'Add to to-dos'}</h2>
        <UiButton tooltip="Close dialog" type="button" onClick={onClose} aria-label="Close dialog" className="rounded p-1 text-white/60 hover:bg-white/10"><Icon name="x" size={18} /></UiButton>
      </div>
      {added ? <>
        <p className="text-sm text-white/70">Saved. {assignee && assignee !== userId ? 'They will see it in their to-dos.' : 'You will find it under My to-dos.'}</p>
        <div className="flex justify-end gap-2">
          <UiButton type="button" onClick={onClose} className="btn-ghost">Close</UiButton>
          <Link href="/home?view=todos" className="auth-button !mt-0 inline-flex items-center">Open to-dos</Link>
        </div>
      </> : <>
        <label className="block text-sm font-medium">What needs doing?
          <UiTextarea autoFocus rows={3} maxLength={200} value={title} onChange={event => setTitle(event.target.value)} className="auth-input" />
        </label>
        <label className="block text-sm font-medium">Assign to
          <UiSelect aria-label="Assign to" className="auth-input" value={assignee} onChange={event => setAssignee(event.target.value)}>
            <option value="">Me</option>
            {people.filter(person => person.id !== userId).map(person => <option key={person.id} value={person.id}>{person.username}</option>)}
          </UiSelect>
        </label>
        <div>
          <label className="block text-sm font-medium" htmlFor="todo-due">Due date (optional)</label>
          <UiDatePicker label="todo-due" id="todo-due" className="auth-input" value={day} min={dayKey(new Date())} onChange={event => setDay(event.target.value)} />
          <div className="mt-2 flex flex-wrap gap-2">
            {QUICK_DUES.map(({ label, days }) => <UiButton key={label} type="button" onClick={() => setDay(dayKey(addDays(new Date(), days)))}
              className="rounded-full border border-white/10 bg-[var(--surface-2)] px-3 py-1 text-sm hover:border-brand/50">{label}</UiButton>)}
            {day && <UiButton type="button" onClick={() => setDay('')} className="px-2 text-sm font-medium text-brand hover:underline">No date</UiButton>}
          </div>
        </div>
        {error && <p role="alert" className="text-sm text-rose-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <UiButton type="button" onClick={onClose} className="btn-ghost">Cancel</UiButton>
          <UiButton disabled={busy} className="auth-button !mt-0">{busy ? 'Saving…' : 'Add to-do'}</UiButton>
        </div>
      </>}
    </form>
  </div>;
}
