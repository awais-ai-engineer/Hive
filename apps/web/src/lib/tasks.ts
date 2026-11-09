import { apiData } from './spaces';
import type { Place } from './home';
import type { Person } from './docs';

export type Task = {
  id: string;
  title: string;
  notes: string;
  status: 'open' | 'doing' | 'done';
  priority: 'low' | 'medium' | 'high' | null;
  due_at: string | null;
  completed_at: string | null;
  created_by: Person | null;
  assignee: Person | null;
  channel_id: string | null;
  place: Place | null;
  source_message_id: string | null;
  position: number;
  created_at: string;
  updated_at: string;
};

export type TaskScope = 'mine' | 'assigned_by_me' | 'done' | 'channel';
export type TaskEvent = { action: 'created' | 'updated' | 'deleted'; taskId: string; channelId: string | null; assigneeId: string | null; createdBy: string };

/** Fired after this tab changes a to-do, so the rail badge can refresh at once. */
export const TASKS_CHANGED = 'hive:tasks';

const pad = (value: number) => String(value).padStart(2, '0');
export const dayKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export const endOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59);
export const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

/** A date picked in the UI becomes the end of that local day, so "today" is not overdue until tonight. */
export const dueFromDay = (day: string) => {
  const [year, month, date] = day.split('-').map(Number);
  return endOfDay(new Date(year, month - 1, date)).toISOString();
};

export type Bucket = 'overdue' | 'today' | 'upcoming' | 'none';
export const BUCKET_LABELS: Record<Bucket, string> = { overdue: 'Overdue', today: 'Today', upcoming: 'Upcoming', none: 'No date' };
export const BUCKETS: Bucket[] = ['overdue', 'today', 'upcoming', 'none'];

export function bucketOf(task: Task, now = new Date()): Bucket {
  if (!task.due_at) return 'none';
  const due = dayKey(new Date(task.due_at));
  const today = dayKey(now);
  return due < today ? 'overdue' : due === today ? 'today' : 'upcoming';
}

export function dueLabel(iso: string | null, now = new Date()) {
  if (!iso) return 'No date';
  const due = new Date(iso);
  const key = dayKey(due);
  if (key === dayKey(now)) return 'Today';
  if (key === dayKey(addDays(now, 1))) return 'Tomorrow';
  if (key === dayKey(addDays(now, -1))) return 'Yesterday';
  return due.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: due.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export const QUICK_DUES: { label: string; days: number }[] = [
  { label: 'Today', days: 0 }, { label: 'Tomorrow', days: 1 }, { label: 'Next week', days: 7 },
];

export const tasksApi = {
  list: (scope: TaskScope, channelId?: string) =>
    apiData<Task[]>(`/api/tasks?scope=${scope}${channelId ? `&channel_id=${channelId}` : ''}`),
  create: (body: { title: string; notes?: string; assignee_id?: string | null; channel_id?: string | null; source_message_id?: string | null; due_at?: string | null; priority?: Task['priority'] }) =>
    apiData<Task>('/api/tasks', { method: 'POST', body: JSON.stringify(body) }),
  patch: (id: string, body: Partial<{ title: string; notes: string; assignee_id: string | null; due_at: string | null; status: Task['status']; priority: Task['priority'] }>) =>
    apiData<Task>(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (id: string) => apiData<void>(`/api/tasks/${id}`, { method: 'DELETE' }),
  assignees: (channelId: string | null) => apiData<Person[]>(`/api/tasks/assignees${channelId ? `?channel_id=${channelId}` : ''}`),
  dueCount: () => apiData<{ due_count: number }>(`/api/tasks/summary?until=${encodeURIComponent(endOfDay(new Date()).toISOString())}`),
};
