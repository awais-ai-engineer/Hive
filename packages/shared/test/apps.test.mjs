import test from 'node:test';
import assert from 'node:assert/strict';
import { actionSchema, commandCreateSchema, describeWorkflow, triggerSchema, workflowSchema, workflowTemplates } from '../dist/schemas/apps.js';

const names = { channel: id => ({ c1: 'welcome', c2: 'general' })[id] ?? '?', bot: () => 'Helper', member: () => 'Dana' };

test('the sentence reads like plain language', () => {
  const sentence = describeWorkflow({ type: 'member_joined' }, { type: 'post_message', to: 'dm', text: 'Welcome {user}!', sender: 'hive' }, names, 'Hive Developers');
  assert.equal(sentence, 'When someone joins Hive Developers, send them a direct message: Welcome {user}!');
  assert.match(describeWorkflow({ type: 'schedule', frequency: 'weekly', weekday: 4, time: '17:00', timezone: 'UTC' },
    { type: 'create_todo', title: 'Report', assignee: 'u1' }, names), /Friday at 17:00 \(UTC\), create a to-do for Dana: Report/);
  assert.match(describeWorkflow({ type: 'reaction_added', channelId: 'c2', emoji: '🐛' }, { type: 'add_to_channel', channelId: 'c1' }, names),
    /someone reacts 🐛 in #general, add that person to the private channel #welcome/);
});

test('triggers and actions are validated', () => {
  assert.ok(triggerSchema.safeParse({ type: 'schedule', frequency: 'daily', time: '09:30' }).success);
  assert.ok(!triggerSchema.safeParse({ type: 'schedule', frequency: 'weekly', time: '09:30' }).success);
  assert.ok(!triggerSchema.safeParse({ type: 'schedule', frequency: 'daily', time: '9:30' }).success);
  assert.ok(!triggerSchema.safeParse({ type: 'message_keyword', channelId: 'c', keyword: '  ' }).success);
  assert.ok(!actionSchema.safeParse({ type: 'post_message', to: 'channel', text: 'hi' }).success);
  assert.ok(actionSchema.safeParse({ type: 'post_message', to: 'dm', text: 'hi' }).success);
  assert.ok(!actionSchema.safeParse({ type: 'create_todo', title: '' }).success);
});

test('every template is a valid workflow once its channel is chosen', () => {
  for (const template of workflowTemplates) {
    const trigger = 'channelId' in template.trigger ? { ...template.trigger, channelId: 'c1' } : template.trigger;
    const action = template.action.type === 'post_message' && template.action.to === 'channel' ? { ...template.action, channelId: 'c1' } : template.action;
    assert.ok(workflowSchema.safeParse({ name: template.name, trigger, action }).success, template.id);
  }
});

test('command names', () => {
  assert.equal(commandCreateSchema.parse({ name: ' Ping ', botId: 'b' }).name, 'ping');
  for (const name of ['poll', 'Bad Name', '1x', '']) assert.ok(!commandCreateSchema.safeParse({ name, botId: 'b' }).success, name);
});
