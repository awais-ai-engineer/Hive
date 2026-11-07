'use client';

import { useMemo, useState } from 'react';
import { describeWorkflow, personTriggers, weekdays, workflowSchema, workflowTemplates, type Action, type Trigger } from '@hive/shared';
import { apiData, requestError } from '../../lib/spaces';
import { base, type AppChannel, type Bot, type SpaceMemberRow, type Workflow, type WorkflowRun } from '../../lib/apps';
import { Empty, Section } from './parts';

type Props = {
  slug: string; spaceName: string; channels: (AppChannel & { is_private?: boolean })[]; bots: Bot[]; members: SpaceMemberRow[];
  workflows: Workflow[]; reload: () => Promise<void>; fail: (message: string) => void;
};
const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const blankTrigger = (type: Trigger['type']): Trigger => ({
  member_joined: { type: 'member_joined' }, message_keyword: { type: 'message_keyword', channelId: '', keyword: '' },
  reaction_added: { type: 'reaction_added', channelId: '', emoji: '🐛' },
  schedule: { type: 'schedule', frequency: 'daily', time: '09:30', timezone: zone() },
} as Record<Trigger['type'], Trigger>)[type];
const blankAction = (type: Action['type']): Action => ({
  post_message: { type: 'post_message', to: 'channel', channelId: '', text: '', sender: 'hive' },
  create_todo: { type: 'create_todo', title: '', assignee: 'trigger' }, add_to_channel: { type: 'add_to_channel', channelId: '' },
} as Record<Action['type'], Action>)[type];

export function WorkflowsSection({ slug, spaceName, channels, bots, members, workflows, reload, fail }: Props) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState<Trigger>(blankTrigger('member_joined'));
  const [action, setAction] = useState<Action>(blankAction('post_message'));
  const [runs, setRuns] = useState<{ id: string; rows: WorkflowRun[] } | null>(null);

  const names = useMemo(() => ({
    channel: (id?: string | null) => channels.find(channel => channel.id === id)?.name ?? '…',
    bot: (id?: string | null) => bots.find(bot => bot.id === id)?.name ?? 'a bot',
    member: (id?: string | null) => members.find(member => member.user.id === id)?.user.username ?? 'a member',
  }), [channels, bots, members]);
  const hasPerson = (personTriggers as readonly string[]).includes(trigger.type);
  const privateChannels = channels.filter(channel => channel.is_private);

  function open(next: { name: string; trigger: Trigger; action: Action }, id: string | 'new') {
    setName(next.name); setTrigger(next.trigger); setAction(next.action); setEditing(id); fail('');
  }
  function pickTrigger(type: Trigger['type']) {
    setTrigger(blankTrigger(type));
    if (!(personTriggers as readonly string[]).includes(type)) {
      if (action.type === 'add_to_channel') setAction(blankAction('post_message'));
      if (action.type === 'post_message' && action.to === 'dm') setAction({ ...action, to: 'channel' });
      if (action.type === 'create_todo' && action.assignee === 'trigger') setAction({ ...action, assignee: members[0]?.user.id ?? '' });
    }
  }
  async function save() {
    fail('');
    const parsed = workflowSchema.safeParse({ name: name || 'My workflow', trigger, action });
    if (!parsed.success) { fail(parsed.error.issues[0].message); return; }
    try {
      if (editing === 'new') await apiData(`${base(slug)}/workflows`, { method: 'POST', body: JSON.stringify(parsed.data) });
      else await apiData(`${base(slug)}/workflows/${editing}`, { method: 'PATCH', body: JSON.stringify(parsed.data) });
      setEditing(null); await reload();
    } catch (cause) { fail(requestError(cause)); }
  }
  async function patch(workflow: Workflow, body: object) {
    fail(''); try { await apiData(`${base(slug)}/workflows/${workflow.id}`, { method: 'PATCH', body: JSON.stringify(body) }); await reload(); } catch (cause) { fail(requestError(cause)); }
  }
  async function remove(workflow: Workflow) {
    if (!window.confirm(`Delete "${workflow.name}"?`)) return;
    fail(''); try { await apiData(`${base(slug)}/workflows/${workflow.id}`, { method: 'DELETE' }); await reload(); } catch (cause) { fail(requestError(cause)); }
  }
  async function toggleRuns(workflow: Workflow) {
    if (runs?.id === workflow.id) { setRuns(null); return; }
    try { setRuns({ id: workflow.id, rows: await apiData<WorkflowRun[]>(`${base(slug)}/workflows/${workflow.id}/runs`) }); } catch (cause) { fail(requestError(cause)); }
  }

  const channelSelect = (value: string | null | undefined, onChange: (id: string) => void, list = channels, label = 'Channel') =>
    <label className="block text-sm">{label}<select className="auth-input" value={value ?? ''} onChange={event => onChange(event.target.value)}>
      <option value="">Choose…</option>{list.map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}</select></label>;

  return <Section id="workflows" title="Workflows" intro="Automate routine work without code: pick what should start it (“When…”), then what Hive should do (“Then…”). Hive never runs a workflow because of a message another workflow posted, and a workflow pauses after 20 runs in a minute.">
    {!workflows.length && editing === null && <Empty>No workflows yet. Start from a ready-made one below.</Empty>}
    <ul className="space-y-2">{workflows.map(workflow => <li key={workflow.id} className="space-y-2 rounded-xl border border-white/10 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2"><input type="checkbox" role="switch" checked={workflow.enabled} aria-label={`Turn ${workflow.name} ${workflow.enabled ? 'off' : 'on'}`} onChange={event => void patch(workflow, { enabled: event.target.checked })} />
          <span className="font-medium">{workflow.name}</span></label>
        <span className={`text-xs ${workflow.enabled ? 'text-emerald-500' : 'text-white/50'}`}>{workflow.enabled ? 'On' : 'Off'}</span>
        <span className="ml-auto flex gap-3 text-sm">
          <button type="button" className="text-brand underline" onClick={() => open({ name: workflow.name, trigger: workflow.trigger, action: workflow.action }, workflow.id)}>Edit</button>
          <button type="button" className="text-brand underline" onClick={() => void toggleRuns(workflow)}>History</button>
          <button type="button" className="text-rose-500" onClick={() => void remove(workflow)}>Delete</button></span>
      </div>
      <p className="text-sm text-white/70">{describeWorkflow(workflow.trigger, workflow.action, names, spaceName)}</p>
      {workflow.lastRun && <p className={`text-xs ${workflow.lastRun.status === 'error' ? 'text-rose-500' : 'text-white/50'}`}>Last run: {workflow.lastRun.status}{workflow.lastRun.error ? ` (${workflow.lastRun.error})` : ''} · {new Date(workflow.lastRun.at).toLocaleString()}</p>}
      {workflow.nextRunAt && workflow.enabled && <p className="text-xs text-white/50">Next run: {new Date(workflow.nextRunAt).toLocaleString()}</p>}
      {runs?.id === workflow.id && (runs.rows.length ? <ul className="max-h-60 space-y-1 overflow-y-auto text-xs">{runs.rows.map(run => <li key={run.id}>
        <span className={run.status === 'ok' ? 'text-emerald-500' : run.status === 'error' ? 'text-rose-500' : 'text-amber-500'}>{run.status}</span> · {new Date(run.at).toLocaleString()}{run.user ? ` · ${run.user}` : ''}{run.detail ? ` · ${run.detail}` : ''}{run.error ? ` · ${run.error}` : ''}</li>)}</ul> : <p className="text-xs text-white/60">It has not run yet.</p>)}
    </li>)}</ul>

    {editing === null ? <div>
      <p className="mb-2 text-sm font-medium">Start from a template</p>
      <div className="grid gap-2 sm:grid-cols-3">{workflowTemplates.map(template => <button key={template.id} type="button" className="card p-3 text-left hover:border-brand"
        onClick={() => open({ name: template.name, trigger: structuredClone(template.trigger) as Trigger, action: structuredClone(template.action) as Action }, 'new')}>
        <span className="block font-semibold">{template.title}</span><span className="text-xs text-white/60">{template.blurb}</span></button>)}</div>
      <button type="button" className="auth-button mt-3" onClick={() => open({ name: '', trigger: blankTrigger('member_joined'), action: blankAction('post_message') }, 'new')}>Build your own</button>
    </div> : <div className="space-y-4 rounded-xl border border-brand/40 p-4">
      <label className="block text-sm">Name<input className="auth-input" value={name} maxLength={80} onChange={event => setName(event.target.value)} placeholder="Welcome new members" /></label>
      <fieldset className="space-y-2"><legend className="font-semibold">1. When…</legend>
        <select aria-label="Trigger" className="auth-input" value={trigger.type} onChange={event => pickTrigger(event.target.value as Trigger['type'])}>
          <option value="member_joined">someone joins the space</option><option value="message_keyword">a message contains a word</option>
          <option value="reaction_added">someone adds an emoji reaction</option><option value="schedule">it is a certain time</option></select>
        {(trigger.type === 'message_keyword' || trigger.type === 'reaction_added') && channelSelect(trigger.channelId, id => setTrigger({ ...trigger, channelId: id }), channels, 'In channel')}
        {trigger.type === 'message_keyword' && <label className="block text-sm">Word or phrase<input className="auth-input" maxLength={100} value={trigger.keyword} onChange={event => setTrigger({ ...trigger, keyword: event.target.value })} placeholder="deploy" /></label>}
        {trigger.type === 'reaction_added' && <label className="block text-sm">Emoji<input className="auth-input w-28" maxLength={16} value={trigger.emoji} onChange={event => setTrigger({ ...trigger, emoji: event.target.value })} /></label>}
        {trigger.type === 'schedule' && <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">Repeats<select className="auth-input" value={trigger.frequency} onChange={event => setTrigger({ ...trigger, frequency: event.target.value as 'daily' | 'weekly', weekday: event.target.value === 'weekly' ? trigger.weekday ?? 0 : undefined })}><option value="daily">every day</option><option value="weekly">every week</option></select></label>
          {trigger.frequency === 'weekly' && <label className="text-sm">On<select className="auth-input" value={trigger.weekday ?? 0} onChange={event => setTrigger({ ...trigger, weekday: Number(event.target.value) })}>{weekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>}
          <label className="text-sm">At<input type="time" className="auth-input" value={trigger.time} onChange={event => setTrigger({ ...trigger, time: event.target.value })} /></label>
          <label className="min-w-40 flex-1 text-sm">Time zone<input className="auth-input" value={trigger.timezone} onChange={event => setTrigger({ ...trigger, timezone: event.target.value })} /></label></div>}
      </fieldset>
      <fieldset className="space-y-2"><legend className="font-semibold">2. Then…</legend>
        <select aria-label="Action" className="auth-input" value={action.type} onChange={event => setAction(blankAction(event.target.value as Action['type']))}>
          <option value="post_message">post a message</option><option value="create_todo">create a to-do</option>
          {hasPerson && <option value="add_to_channel">add the person to a private channel</option>}</select>
        {action.type === 'post_message' && <>
          {hasPerson && <label className="block text-sm">Send to<select className="auth-input" value={action.to} onChange={event => setAction({ ...action, to: event.target.value as 'channel' | 'dm', sender: event.target.value === 'dm' ? 'hive' : action.sender })}>
            <option value="channel">a channel</option><option value="dm">the person, as a direct message</option></select></label>}
          {action.to === 'channel' && <>{channelSelect(action.channelId, id => setAction({ ...action, channelId: id }), channels, 'Post in')}
            <label className="block text-sm">Posted by<select className="auth-input" value={action.sender} onChange={event => setAction({ ...action, sender: event.target.value })}>
              <option value="hive">Hive</option>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name} (bot)</option>)}</select></label></>}
          <label className="block text-sm">Message<textarea className="auth-input" rows={3} maxLength={2000} value={action.text} onChange={event => setAction({ ...action, text: event.target.value })} placeholder="Welcome {user}!" /></label></>}
        {action.type === 'create_todo' && <>
          <label className="block text-sm">To-do<input className="auth-input" maxLength={200} value={action.title} onChange={event => setAction({ ...action, title: event.target.value })} placeholder="Follow up with {user}" /></label>
          <label className="block text-sm">Assign to<select className="auth-input" value={action.assignee} onChange={event => setAction({ ...action, assignee: event.target.value })}>
            {hasPerson && <option value="trigger">the person who triggered it</option>}{members.map(member => <option key={member.user.id} value={member.user.id}>{member.user.username}</option>)}</select></label></>}
        {action.type === 'add_to_channel' && (privateChannels.length ? channelSelect(action.channelId, id => setAction({ ...action, channelId: id }), privateChannels, 'Private channel') :
          <p className="text-sm text-white/60">This space has no private channels. Create one in General settings first.</p>)}
        <p className="text-xs text-white/60">You can use {'{user}'} (the person), {'{channel}'} and {'{date}'} in text{trigger.type !== 'schedule' && trigger.type !== 'member_joined' ? ', and {message} for the message text' : ''}.</p>
      </fieldset>
      <p className="rounded-xl bg-brand-soft p-3 text-sm" aria-live="polite"><strong>Preview:</strong> {describeWorkflow(trigger, action, names, spaceName)}</p>
      <div className="flex gap-2"><button type="button" className="auth-button" onClick={() => void save()}>{editing === 'new' ? 'Save workflow' : 'Save changes'}</button><button type="button" className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button></div>
    </div>}
  </Section>;
}
