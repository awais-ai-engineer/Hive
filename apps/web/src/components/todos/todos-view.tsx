'use client';

import { useState } from 'react';
import type { TaskScope } from '../../lib/tasks';
import { TodoList } from './todo-list';
import { TasksBoard } from './tasks-board';
import { loadSetting, saveSetting } from '../../lib/home';

const TABS: { scope: TaskScope; label: string; title: string; text: string }[] = [
  { scope: 'mine', label: 'My to-dos', title: 'You are all caught up', text: 'Add a to-do above, or turn any chat message into one from its menu.' },
  { scope: 'assigned_by_me', label: 'Assigned by me', title: 'Nothing assigned to others', text: 'To-dos you hand to other people show up here. Open a channel, go to its To-dos tab, and assign one.' },
  { scope: 'done', label: 'Done', title: 'No finished to-dos yet', text: 'Tick a to-do off and it moves here.' },
];

/** The To-dos screen: my to-dos, ones I assigned, and finished ones. */
export function TodosView({ userId }: { userId: string }) {
  const [scope, setScope] = useState<TaskScope>('mine');
  const [layout, setLayout] = useState<'board' | 'list'>(() => loadSetting<'board' | 'list'>('hive:tasks-layout', 'board'));
  const tab = TABS.find(item => item.scope === scope)!;
  const choose = (next: 'board' | 'list') => { setLayout(next); saveSetting('hive:tasks-layout', next); };
  const switcher = <div role="tablist" aria-label="Layout" className="ml-auto flex rounded-xl bg-[var(--surface-2)] p-1 text-sm">
    {(['board', 'list'] as const).map(value => <button key={value} type="button" role="tab" aria-selected={layout === value} onClick={() => choose(value)}
      className={`rounded-lg px-3 py-1 font-medium capitalize ${layout === value ? 'bg-[var(--surface)] shadow-sm' : 'text-white/60'}`}>{value}</button>)}
  </div>;
  if (layout === 'board') return <div className="flex min-h-0 flex-1 flex-col"><div className="mb-2 flex">{switcher}</div><TasksBoard userId={userId} /></div>;
  return <div className="min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto mb-2 flex max-w-3xl">{switcher}</div>
    <div role="tablist" aria-label="To-do lists" className="mx-auto mb-4 flex max-w-3xl gap-6 border-b border-white/10">
      {TABS.map(item => <button key={item.scope} type="button" role="tab" aria-selected={scope === item.scope} onClick={() => setScope(item.scope)}
        className={`border-b-2 px-1 pb-2.5 pt-1 text-sm font-medium transition ${scope === item.scope ? 'border-brand text-brand' : 'border-transparent text-white/55 hover:text-white'}`}>{item.label}</button>)}
    </div>
    <TodoList key={scope} scope={scope} userId={userId} emptyTitle={tab.title} emptyText={tab.text} />
  </div>;
}
