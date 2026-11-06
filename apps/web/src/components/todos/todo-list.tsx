'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import type { Person } from '../../lib/docs';
import { placeHref, placeLabel } from '../../lib/home';
import { socket } from '../../lib/socket';
import { requestError } from '../../lib/spaces';
import {
  BUCKETS, BUCKET_LABELS, QUICK_DUES, TASKS_CHANGED, addDays, bucketOf, dayKey, dueFromDay, dueLabel, tasksApi,
  type Task, type TaskEvent, type TaskScope,
} from '../../lib/tasks';
import { PopupMenu, type MenuItem } from '../home/popup-menu';
import { Icon } from '../ui/icons';

type Patch = Parameters<typeof tasksApi.patch>[1];
const changed = () => window.dispatchEvent(new Event(TASKS_CHANGED));

function Row({ task, userId, editable, onPatch, onDelete, onError }: {
  task: Task; userId: string; editable: boolean;
  onPatch: (task: Task, patch: Patch) => void; onDelete: (task: Task) => void; onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const [menu, setMenu] = useState<{ kind: 'due' | 'who'; x: number; y: number } | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [picking, setPicking] = useState(false);
  const done = task.status === 'done';
  const overdue = !done && bucketOf(task) === 'overdue';

  function open(kind: 'due' | 'who') {
    return (event: MouseEvent<HTMLButtonElement>) => {
      const box = event.currentTarget.getBoundingClientRect();
      setMenu({ kind, x: box.left, y: box.bottom + 4 });
      if (kind === 'who' && !people.length) tasksApi.assignees(task.channel_id).then(setPeople).catch(cause => onError(requestError(cause)));
    };
  }
  function saveTitle() {
    setEditing(false);
    const title = draft.trim();
    if (title && title !== task.title) onPatch(task, { title });
    else setDraft(task.title);
  }
  const dueItems: MenuItem[] = [
    ...QUICK_DUES.map(({ label, days }) => ({ label, onSelect: () => onPatch(task, { due_at: dueFromDay(dayKey(addDays(new Date(), days))) }) })),
    { label: 'Pick a date…', icon: 'calendar' as const, onSelect: () => setPicking(true) },
    ...(task.due_at ? [{ separator: true } as MenuItem, { label: 'Remove date', onSelect: () => onPatch(task, { due_at: null }) } as MenuItem] : []),
  ];
  const whoItems: MenuItem[] = [
    { heading: 'Assign to' },
    ...people.map(person => ({ label: person.id === userId ? `${person.username} (you)` : person.username, checked: task.assignee?.id === person.id, onSelect: () => onPatch(task, { assignee_id: person.id }) })),
    ...(task.assignee ? [{ separator: true } as MenuItem, { label: 'Unassign', onSelect: () => onPatch(task, { assignee_id: null }) } as MenuItem] : []),
  ];
  const chip = 'flex items-center gap-1 rounded-full border border-white/10 px-2 py-0.5 text-xs hover:border-brand/50 disabled:cursor-default disabled:hover:border-white/10';

  return <li className="group flex items-start gap-3 rounded-xl px-2 py-2 hover:bg-[var(--surface-2)]">
    <input type="checkbox" checked={done} disabled={!editable} aria-label={done ? `Mark "${task.title}" as not done` : `Mark "${task.title}" as done`}
      onChange={() => onPatch(task, { status: done ? 'open' : 'done' })} className="mt-1 h-[18px] w-[18px] shrink-0 accent-[var(--brand)]" />
    <div className="min-w-0 flex-1">
      {editing
        ? <input autoFocus aria-label="To-do title" value={draft} maxLength={200} onChange={event => setDraft(event.target.value)} onBlur={saveTitle}
          onKeyDown={event => { if (event.key === 'Enter') saveTitle(); if (event.key === 'Escape') { setDraft(task.title); setEditing(false); } }}
          className="auth-input !mt-0 !py-1" />
        : <button type="button" disabled={!editable} onClick={() => { setDraft(task.title); setEditing(true); }} title={editable ? 'Click to edit' : undefined}
          className={`block w-full break-words text-left [overflow-wrap:anywhere] disabled:cursor-default ${done ? 'text-white/45 line-through' : ''}`}>{task.title}</button>}
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {picking
          ? <input type="date" autoFocus aria-label="Due date" defaultValue={task.due_at ? dayKey(new Date(task.due_at)) : ''} className="auth-input !mt-0 !w-auto !py-0.5 text-xs"
            onChange={event => { if (event.target.value) { onPatch(task, { due_at: dueFromDay(event.target.value) }); setPicking(false); } }}
            onBlur={() => setPicking(false)} />
          : <button type="button" disabled={!editable} onClick={open('due')} aria-haspopup="menu" aria-label={`Due date: ${dueLabel(task.due_at)}`}
            className={`${chip} ${overdue ? '!border-rose-500/50 text-rose-500' : 'text-white/60'}`}><Icon name="calendar" size={12} />{task.due_at ? dueLabel(task.due_at) : 'Add date'}</button>}
        {task.channel_id && <button type="button" disabled={!editable} onClick={open('who')} aria-haspopup="menu" aria-label={`Assigned to ${task.assignee?.username ?? 'no one'}`}
          className={`${chip} text-white/60`}><Icon name="user" size={12} />{task.assignee ? (task.assignee.id === userId ? 'You' : task.assignee.username) : 'Unassigned'}</button>}
        {task.place && <Link href={`${placeHref(task.place)}${task.source_message_id ? `&m=${task.source_message_id}` : ''}`}
          className="flex items-center gap-1 text-xs text-brand hover:underline">
          <Icon name={task.source_message_id ? 'message' : 'hash'} size={12} />{task.source_message_id ? `View message in ${placeLabel(task.place)}` : placeLabel(task.place)}</Link>}
        {task.created_by && task.created_by.id !== userId && <span className="text-xs text-white/45">from {task.created_by.username}</span>}
      </div>
    </div>
    {editable && <button type="button" onClick={() => onDelete(task)} aria-label={`Delete "${task.title}"`}
      className="shrink-0 rounded p-1 text-white/35 hover:bg-white/10 hover:text-rose-500 focus-visible:text-rose-500 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"><Icon name="trash" size={16} /></button>}
    {menu && <PopupMenu at={menu} label={menu.kind === 'due' ? 'Due date' : 'Assignee'} onClose={() => setMenu(null)} items={menu.kind === 'due' ? dueItems : whoItems} />}
  </li>;
}

/** A list of to-dos for one scope (mine, assigned by me, done, or one channel) with quick add. */
export function TodoList({ scope, channelId, userId, canWrite = true, emptyTitle, emptyText }: {
  scope: TaskScope; channelId?: string; userId: string; canWrite?: boolean; emptyTitle: string; emptyText: string;
}) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [undo, setUndo] = useState<Task | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const canAdd = canWrite && (scope === 'mine' || scope === 'channel');

  const load = useCallback(() => {
    tasksApi.list(scope, channelId).then(list => { setTasks(list); setError(''); }).catch(cause => setError(requestError(cause)));
  }, [scope, channelId]);
  useEffect(() => { setTasks(null); load(); }, [load]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => { if (timer) clearTimeout(timer); timer = setTimeout(load, 300); };
    const onTask = (data: TaskEvent) => { if (scope !== 'channel' || data.channelId === channelId) refresh(); };
    socket.on('task:updated', onTask).on('connect', refresh);
    return () => { if (timer) clearTimeout(timer); socket.off('task:updated', onTask).off('connect', refresh); };
  }, [load, scope, channelId]);
  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current); }, []);

  async function add(event: FormEvent) {
    event.preventDefault();
    const text = title.trim();
    if (!text) return;
    setTitle('');
    try {
      const created = await tasksApi.create({ title: text, channel_id: channelId ?? null });
      setTasks(list => [...(list ?? []), created]);
      changed();
    } catch (cause) { setError(requestError(cause)); setTitle(text); }
    input.current?.focus();
  }

  async function patch(task: Task, body: Patch) {
    setError('');
    const optimistic: Task = {
      ...task,
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...('due_at' in body ? { due_at: body.due_at ?? null } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    };
    setTasks(list => (list ?? []).map(item => item.id === task.id ? optimistic : item));
    try {
      const saved = await tasksApi.patch(task.id, body);
      setTasks(list => (list ?? []).map(item => item.id === task.id ? saved : item));
      if (body.status === 'done') {
        setUndo(task);
        if (undoTimer.current) clearTimeout(undoTimer.current);
        undoTimer.current = setTimeout(() => setUndo(null), 6000);
      }
      changed();
      if ('assignee_id' in body && scope !== 'channel') load();
    } catch (cause) { setError(requestError(cause)); load(); }
  }
  async function remove(task: Task) {
    setTasks(list => (list ?? []).filter(item => item.id !== task.id));
    try { await tasksApi.remove(task.id); changed(); } catch (cause) { setError(requestError(cause)); load(); }
  }
  async function undoDone() {
    if (!undo) return;
    const task = undo;
    setUndo(null);
    await patch(task, { status: 'open' });
    load();
  }

  const row = (task: Task) => <Row key={task.id} task={task} userId={userId} onPatch={(t, b) => void patch(t, b)} onDelete={t => void remove(t)}
    onError={setError} editable={canWrite} />;
  // In the open lists a finished to-do stays visible until the next refresh, so Undo has something to act on.
  const open = (tasks ?? []).filter(task => task.status === 'open' || (scope !== 'channel' && scope !== 'done' && undo?.id === task.id));
  const finished = (tasks ?? []).filter(task => task.status === 'done');
  const now = new Date();
  const grouped = scope === 'mine' || scope === 'assigned_by_me';

  return <div className="mx-auto w-full max-w-3xl">
    {canAdd && <form onSubmit={event => void add(event)} className="mb-4 flex gap-2">
      <input ref={input} value={title} maxLength={200} onChange={event => setTitle(event.target.value)} aria-label="New to-do"
        placeholder="Add a to-do… press Enter" className="auth-input !mt-0" />
      <button disabled={!title.trim()} className="auth-button !mt-0 shrink-0 !px-4">Add</button>
    </form>}
    {error && <p role="alert" className="mb-3 text-sm text-rose-500">{error}</p>}
    {tasks === null && !error && <p className="text-white/55">Loading to-dos…</p>}
    {tasks?.length === 0 && <div className="card flex flex-col items-center gap-2 p-8 text-center">
      <Icon name="checkSquare" size={32} className="text-white/35" />
      <p className="font-semibold">{emptyTitle}</p>
      <p className="max-w-sm text-sm text-white/60">{emptyText}</p>
      {canAdd && <button type="button" onClick={() => input.current?.focus()} className="auth-button !mt-2 !px-4 !py-2">Add a to-do</button>}
    </div>}
    {grouped && BUCKETS.map(bucket => {
      const items = open.filter(task => bucketOf(task, now) === bucket);
      return items.length > 0 && <section key={bucket} className="mb-4" aria-label={BUCKET_LABELS[bucket]}>
        <h2 className={`mb-1 px-2 text-xs font-semibold uppercase tracking-wide ${bucket === 'overdue' ? 'text-rose-500' : 'text-white/50'}`}>{BUCKET_LABELS[bucket]} · {items.length}</h2>
        <ul>{items.map(row)}</ul>
      </section>;
    })}
    {!grouped && open.length > 0 && <ul>{open.map(row)}</ul>}
    {scope === 'channel' && finished.length > 0 && <details className="mt-4">
      <summary className="cursor-pointer px-2 text-xs font-semibold uppercase tracking-wide text-white/50">Done · {finished.length}</summary>
      <ul className="mt-1">{finished.map(row)}</ul>
    </details>}
    {scope === 'done' && finished.length > 0 && <ul>{finished.map(row)}</ul>}
    {undo && <div role="status" className="on-surface fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-white/10 bg-surface px-4 py-2.5 text-sm shadow-[var(--shadow-pop)]">
      <span>Marked done</span><button type="button" onClick={() => void undoDone()} className="font-semibold text-brand hover:underline">Undo</button>
    </div>}
  </div>;
}
