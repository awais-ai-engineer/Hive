'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type DragEvent, type FormEvent } from 'react';
import { placeHref } from '../../lib/home';
import { socket } from '../../lib/socket';
import { requestError } from '../../lib/spaces';
import { bucketOf, dueFromDay, dueLabel, TASKS_CHANGED, tasksApi, type Task } from '../../lib/tasks';
import { Avatar } from '../ui/avatar';
import { Icon } from '../ui/icons';

type Status = Task['status'];
type Scope = 'mine' | 'assigned_by_me';
const COLUMNS: { status: Status; title: string; empty: string }[] = [
  { status: 'open', title: 'To do', empty: 'Nothing waiting. Add a task below.' },
  { status: 'doing', title: 'In progress', empty: 'Drag a task here when you start it.' },
  { status: 'done', title: 'Done', empty: 'Finished tasks land here.' },
];
const PRIORITY: Record<NonNullable<Task['priority']>, { label: string; tone: string }> = {
  high: { label: 'High', tone: 'text-rose-600 dark:text-rose-400' },
  medium: { label: 'Medium', tone: 'text-amber-700 dark:text-amber-300' },
  low: { label: 'Low', tone: 'text-white/55' },
};
const placeName = (task: Task) => task.place ? (task.place.kind === 'channel' ? `#${task.place.name}` : task.place.name) : 'Personal';
const toDay = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('en-CA') : '';

/** Kanban board for to-dos: To do, In progress and Done, with a detail panel for the selected task. */
export function TasksBoard({ userId }: { userId: string }) {
  const [scope, setScope] = useState<Scope>('mine');
  const [open, setOpen] = useState<Task[] | null>(null);
  const [done, setDone] = useState<Task[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [fromChat, setFromChat] = useState(false);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([tasksApi.list(scope), tasksApi.list('done')]).then(([active, finished]) => {
      setOpen(active);
      setDone(finished.filter(task => scope === 'mine' ? (task.assignee?.id ?? task.created_by?.id) === userId : task.created_by?.id === userId && task.assignee?.id !== userId).slice(0, 30));
      setError('');
    }).catch(cause => setError(requestError(cause)));
  }, [scope, userId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    socket.on('task:updated', load);
    window.addEventListener(TASKS_CHANGED, load);
    return () => { socket.off('task:updated', load); window.removeEventListener(TASKS_CHANGED, load); };
  }, [load]);

  const all = [...(open ?? []), ...done];
  const visible = all.filter(task => !fromChat || task.source_message_id);
  const current = all.find(task => task.id === selected) ?? null;
  const overdue = (open ?? []).filter(task => bucketOf(task) === 'overdue').length;

  async function patch(task: Task, body: Parameters<typeof tasksApi.patch>[1]) {
    const optimistic = { ...task, ...body } as Task;
    const move = (list: Task[]) => list.filter(item => item.id !== task.id);
    if (body.status === 'done') { setOpen(list => move(list ?? [])); setDone(list => [optimistic, ...move(list)]); }
    else if (body.status && task.status === 'done') { setDone(move); setOpen(list => [optimistic, ...move(list ?? [])]); }
    else { setOpen(list => (list ?? []).map(item => item.id === task.id ? optimistic : item)); setDone(list => list.map(item => item.id === task.id ? optimistic : item)); }
    try { await tasksApi.patch(task.id, body); window.dispatchEvent(new Event(TASKS_CHANGED)); }
    catch (cause) { setError(requestError(cause)); load(); }
  }
  async function add(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    try { await tasksApi.create({ title: title.trim() }); setTitle(''); load(); window.dispatchEvent(new Event(TASKS_CHANGED)); }
    catch (cause) { setError(requestError(cause)); }
  }
  async function remove(task: Task) {
    try { await tasksApi.remove(task.id); setSelected(null); load(); window.dispatchEvent(new Event(TASKS_CHANGED)); }
    catch (cause) { setError(requestError(cause)); }
  }
  function drop(event: DragEvent, status: Status) {
    event.preventDefault();
    const task = all.find(item => item.id === event.dataTransfer.getData('text/plain'));
    setDragging(null);
    if (task && task.status !== status) void patch(task, { status });
  }

  const card = (task: Task) => {
    const late = task.status !== 'done' && bucketOf(task) === 'overdue';
    return <li key={task.id}>
      <button type="button" draggable onDragStart={event => { event.dataTransfer.setData('text/plain', task.id); setDragging(task.id); }} onDragEnd={() => setDragging(null)}
        onClick={() => setSelected(task.id)} aria-current={task.id === selected ? 'true' : undefined}
        className={`w-full rounded-xl border bg-[var(--surface)] p-3 text-left shadow-sm transition hover:shadow ${task.id === selected ? 'border-[#15171c] ring-1 ring-[#15171c] dark:border-[#e8eaee] dark:ring-[#e8eaee]' : 'border-[var(--border)]'} ${dragging === task.id ? 'opacity-50' : ''}`}>
        <p className={`text-sm font-semibold ${task.status === 'done' ? 'text-white/55 line-through' : ''}`}>{task.status === 'done' && <Icon name="check" size={13} className="mr-1 inline text-emerald-600" />}{task.title}</p>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-white/55"><span className="h-2 w-2 rounded-sm bg-[var(--brand)]" />{placeName(task)}</p>
        {task.source_message_id && <p className="mt-1 flex items-center gap-1 text-xs font-medium text-[var(--brand-soft-fg)]"><Icon name="sparkles" size={12} />From a message</p>}
        <div className="mt-2 flex items-center gap-2 text-xs text-white/55">
          {task.due_at && <span className={`flex items-center gap-1 ${late ? 'font-semibold text-rose-600 dark:text-rose-400' : ''}`}><Icon name="calendar" size={12} />{dueLabel(task.due_at)}</span>}
          {task.priority && <span className={`flex items-center gap-1 font-medium ${PRIORITY[task.priority].tone}`}><Icon name="flag" size={12} />{PRIORITY[task.priority].label}</span>}
          {task.assignee && <span className="ml-auto" title={task.assignee.username}><Avatar name={task.assignee.username} src={task.assignee.avatar_url} size={20} /></span>}
        </div>
      </button>
    </li>;
  };

  return <div className="flex min-h-0 flex-1 gap-5">
    <section aria-label="Tasks" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <h2 className="text-xl font-bold">{scope === 'mine' ? 'My tasks' : 'Assigned by me'}</h2>
          <p className="text-sm text-white/55">{(open ?? []).length} open{overdue ? ` · ${overdue} overdue` : ''}</p>
        </div>
        <div role="tablist" aria-label="Whose tasks" className="flex rounded-xl bg-[var(--surface-2)] p-1 text-sm">
          {([['mine', 'My tasks'], ['assigned_by_me', 'Assigned by me']] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={scope === value}
            onClick={() => { setScope(value); setSelected(null); }} className={`rounded-lg px-3 py-1 font-medium ${scope === value ? 'bg-[var(--surface)] shadow-sm' : 'text-white/60'}`}>{label}</button>)}
        </div>
        <button type="button" aria-pressed={fromChat} onClick={() => setFromChat(value => !value)} className={`btn-ghost ${fromChat ? '!border-[var(--brand)] !bg-brand-soft' : ''}`}><Icon name="sparkles" size={14} />Created from chat</button>
      </div>
      <form onSubmit={add} className="mb-3 flex gap-2">
        <input className="auth-input !mt-0" value={title} maxLength={200} onChange={event => setTitle(event.target.value)} placeholder="Add a task… press Enter" aria-label="New task" />
        <button className="auth-button shrink-0" disabled={!title.trim()}><Icon name="plus" size={15} />New task</button>
      </form>
      {error && <p role="alert" className="mb-3 text-sm text-rose-500">{error}</p>}
      {open === null ? <div role="status" aria-label="Loading tasks" className="grid gap-3 md:grid-cols-3">{[1, 2, 3].map(index => <div key={index} className="h-48 animate-pulse rounded-2xl bg-[var(--surface-2)]" />)}</div>
        : <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto md:grid-cols-3">
          {COLUMNS.map(column => {
            const list = visible.filter(task => task.status === column.status);
            return <div key={column.status} onDragOver={event => event.preventDefault()} onDrop={event => drop(event, column.status)}
              className="flex min-h-[12rem] flex-col rounded-2xl bg-[var(--surface-2)] p-3">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">{column.title}<span className="text-white/50">{list.length}</span></h3>
              {list.length ? <ul className="space-y-2">{list.map(card)}</ul> : <p className="mt-6 text-center text-xs text-white/45">{column.empty}</p>}
            </div>;
          })}
        </div>}
    </section>

    <aside aria-label="Task details" className="hidden w-80 shrink-0 border-l border-[var(--border)] pl-5 xl:block">
      {!current ? <div className="mt-24 text-center text-sm text-white/50"><Icon name="checkSquare" size={32} className="mx-auto mb-2 opacity-60" />Select a task to see and edit its details. Drag cards between columns to change their status.</div> : <div className="space-y-4">
        <div className="flex items-start justify-between gap-2">
          <p className="flex items-center gap-1.5 text-xs text-white/55"><span className="h-2 w-2 rounded-sm bg-[var(--brand)]" />{placeName(current)}</p>
          <button type="button" aria-label="Close" title="Close" onClick={() => setSelected(null)} className="rounded p-1 text-white/55 hover:bg-[var(--surface-2)]"><Icon name="x" size={16} /></button>
        </div>
        <h3 className="text-lg font-bold">{current.title}</h3>
        <dl className="grid grid-cols-[6rem_1fr] items-center gap-y-3 text-sm">
          <dt className="text-white/55">Status</dt>
          <dd><select className="auth-input !mt-0 !py-1.5" value={current.status} onChange={event => void patch(current, { status: event.target.value as Status })}>
            {COLUMNS.map(column => <option key={column.status} value={column.status}>{column.title}</option>)}</select></dd>
          <dt className="text-white/55">Assignee</dt>
          <dd className="flex items-center gap-2">{current.assignee ? <><Avatar name={current.assignee.username} src={current.assignee.avatar_url} size={22} />{current.assignee.username}{current.assignee.id === userId && ' (you)'}</> : <span className="text-white/50">Nobody</span>}</dd>
          <dt className="text-white/55">Due</dt>
          <dd><input type="date" className="auth-input !mt-0 !py-1.5" value={toDay(current.due_at)} onChange={event => void patch(current, { due_at: event.target.value ? dueFromDay(event.target.value) : null })} /></dd>
          <dt className="text-white/55">Priority</dt>
          <dd><select className="auth-input !mt-0 !py-1.5" value={current.priority ?? ''} onChange={event => void patch(current, { priority: (event.target.value || null) as Task['priority'] })}>
            <option value="">None</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></dd>
        </dl>
        {current.notes && <p className="whitespace-pre-wrap rounded-xl bg-[var(--surface-2)] p-3 text-sm">{current.notes}</p>}
        {current.source_message_id && current.place && <div className="rounded-xl border border-[var(--border)] p-3">
          <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold"><Icon name="sparkles" size={13} className="text-[var(--brand)]" />Created from a message</p>
          <p className="text-sm text-white/60">{current.created_by ? `${current.created_by.username} turned a message in ${placeName(current)} into this task.` : `From a message in ${placeName(current)}.`}</p>
          <Link href={`${placeHref(current.place)}&m=${current.source_message_id}`} className="mt-1 inline-block text-sm font-medium text-[var(--brand-soft-fg)] underline">Open in {placeName(current)}</Link>
        </div>}
        <button type="button" className="btn-ghost w-full justify-center text-rose-600" onClick={() => void remove(current)}><Icon name="trash" size={15} />Delete task</button>
      </div>}
    </aside>
  </div>;
}
