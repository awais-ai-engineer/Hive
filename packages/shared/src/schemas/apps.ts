import { z } from 'zod';

export const commandNameSchema = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'Use letters, numbers, - or _ (start with a letter)');
export const reservedCommands = ['poll', 'remind', 'status', 'shrug', 'me', 'all', 'here', 'channel'] as const;

export const webhookCreateSchema = z.object({
  name: z.string().trim().min(1, 'Give it a name').max(80),
  channelId: z.string().min(1, 'Choose a channel'),
  emoji: z.string().min(1).max(16).default('🔔'),
});
export const botCreateSchema = z.object({
  name: z.string().trim().min(1, 'Give it a name').max(80),
  description: z.string().trim().max(300).default(''),
  emoji: z.string().min(1).max(16).default('🤖'),
  webhookUrl: z.string().trim().max(2000).nullable().optional(),
  channelIds: z.array(z.string()).max(100).default([]),
});
export const commandCreateSchema = z.object({
  name: commandNameSchema.refine(name => !(reservedCommands as readonly string[]).includes(name), 'Hive already uses that name'),
  botId: z.string().min(1, 'Choose a bot'),
  description: z.string().trim().max(200).default(''),
  usage: z.string().trim().max(120).default(''),
});

export const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('member_joined') }),
  z.object({ type: z.literal('message_keyword'), channelId: z.string().min(1, 'Choose a channel'), keyword: z.string().trim().min(1, 'Enter a word or phrase').max(100) }),
  z.object({ type: z.literal('reaction_added'), channelId: z.string().min(1, 'Choose a channel'), emoji: z.string().min(1, 'Pick an emoji').max(16) }),
  z.object({
    type: z.literal('schedule'), frequency: z.enum(['daily', 'weekly']),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 09:30'),
    timezone: z.string().min(1).default('UTC'), weekday: z.number().int().min(0).max(6).optional(),
  }),
]).superRefine((value, context) => {
  if (value.type === 'schedule' && value.frequency === 'weekly' && value.weekday === undefined)
    context.addIssue({ code: 'custom', message: 'Choose a weekday', path: ['weekday'] });
});

export const actionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('post_message'), to: z.enum(['channel', 'dm']), channelId: z.string().nullable().optional(),
    text: z.string().trim().min(1, 'Write the message').max(2000), sender: z.string().default('hive'),
  }),
  z.object({
    type: z.literal('create_todo'), title: z.string().trim().min(1, 'Write the to-do').max(200),
    assignee: z.string().default('trigger'), channelId: z.string().nullable().optional(),
  }),
  z.object({ type: z.literal('add_to_channel'), channelId: z.string().min(1, 'Choose a private channel') }),
]).superRefine((value, context) => {
  if (value.type === 'post_message' && value.to === 'channel' && !value.channelId)
    context.addIssue({ code: 'custom', message: 'Choose a channel', path: ['channelId'] });
});

export const workflowSchema = z.object({
  name: z.string().trim().min(1, 'Give the workflow a name').max(80),
  enabled: z.boolean().default(true),
  trigger: triggerSchema,
  action: actionSchema,
});

export type Trigger = z.infer<typeof triggerSchema>;
export type Action = z.infer<typeof actionSchema>;
export type WorkflowInput = z.infer<typeof workflowSchema>;

/** Triggers that come with a person (the one who joined, wrote or reacted). Schedules have none. */
export const personTriggers = ['member_joined', 'message_keyword', 'reaction_added'] as const;
export const workflowVariables = ['{user}', '{channel}', '{date}'] as const;

export const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

export type Lookup = { channel(id?: string | null): string; bot(id?: string | null): string; member(id?: string | null): string };

/** "When someone joins, send them a direct message: Welcome {user}!" in plain words. */
export function describeWorkflow(trigger: Trigger, action: Action, names: Lookup, space = 'this space'): string {
  let when = '';
  switch (trigger.type) {
    case 'member_joined': when = `someone joins ${space}`; break;
    case 'message_keyword': when = `a message in #${names.channel(trigger.channelId)} contains "${trigger.keyword || '…'}"`; break;
    case 'reaction_added': when = `someone reacts ${trigger.emoji || '…'} in #${names.channel(trigger.channelId)}`; break;
    case 'schedule': when = trigger.frequency === 'weekly'
      ? `it is ${weekdays[trigger.weekday ?? 0]} at ${trigger.time} (${trigger.timezone})`
      : `it is ${trigger.time} every day (${trigger.timezone})`; break;
  }
  let then = '';
  switch (action.type) {
    case 'post_message':
      then = action.to === 'dm'
        ? `send them a direct message: ${action.text || '…'}`
        : `${action.sender && action.sender !== 'hive' ? names.bot(action.sender) : 'Hive'} posts in #${names.channel(action.channelId)}: ${action.text || '…'}`;
      break;
    case 'create_todo':
      then = `create a to-do for ${action.assignee === 'trigger' ? 'that person' : names.member(action.assignee)}: ${action.title || '…'}`;
      break;
    case 'add_to_channel': then = `add that person to the private channel #${names.channel(action.channelId)}`; break;
  }
  return `When ${when}, ${then}`;
}

/** Ready-made rules for non-technical admins. Channel ids are filled in by the form. */
export const workflowTemplates = [
  {
    id: 'welcome', title: 'Welcome new members', blurb: 'Send every new member a friendly direct message.',
    name: 'Welcome new members', trigger: { type: 'member_joined' } as Trigger,
    action: { type: 'post_message', to: 'dm', text: 'Welcome {user}! Say hi in the general channel and look around. Today is {date}.', sender: 'hive' } as Action,
  },
  {
    id: 'standup', title: 'Daily stand-up reminder', blurb: 'Post a reminder in a channel every weekday morning.',
    name: 'Daily stand-up reminder', trigger: { type: 'schedule', frequency: 'daily', time: '09:30', timezone: 'UTC' } as Trigger,
    action: { type: 'post_message', to: 'channel', channelId: '', text: 'Good morning! Stand-up time. What did you do yesterday, and what is next? ({date})', sender: 'hive' } as Action,
  },
  {
    id: 'bugs', title: 'Turn 🐛 reactions into to-dos', blurb: 'React with 🐛 on a message and it becomes a to-do for you.',
    name: 'Bug reactions become to-dos', trigger: { type: 'reaction_added', channelId: '', emoji: '🐛' } as Trigger,
    action: { type: 'create_todo', title: 'Look into: {message}', assignee: 'trigger' } as Action,
  },
] as const;
