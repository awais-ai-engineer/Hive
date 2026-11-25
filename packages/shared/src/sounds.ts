/** Stable account preference keys and the complete local audio catalogue. */
export const soundCategories = {
  messages: 'Messages', mentions: 'Mentions and notifications', huddles: 'Huddle calls',
  participants: 'Huddle participant activity', controls: 'Huddle controls',
  announcements: 'Voice announcements', activity: 'Workspace and community activity', feedback: 'Reminders and system alerts',
} as const;
export type SoundCategory = keyof typeof soundCategories;
const entry = (label: string, category: SoundCategory, priority = 1, gain = 1, scope: 'local' | 'shared' = 'shared') => ({ label, category, priority, gain, scope });
export const soundEvents = {
  incoming: entry('Incoming direct message', 'messages', 2),
  channel_message: entry('Incoming channel message', 'messages', 1, .7),
  message_sent: entry('Message delivered', 'messages', 1, .5, 'local'),
  mention: entry('Mention or tag', 'mentions', 3), reply: entry('Thread reply', 'messages', 2, .8),
  message_failed: entry('Message delivery failed', 'feedback', 3, .8, 'local'),
  priority: entry('Priority notification', 'mentions', 4),
  invitation: entry('Incoming Huddle invitation', 'huddles', 7),
  outgoing: entry('Calling', 'huddles', 6, .65, 'local'),
  huddle_start: entry('Huddle connected', 'huddles', 4), huddle_end: entry('Huddle ended', 'huddles', 4),
  participant_join: entry('Participant joined', 'participants', 2, .7),
  participant_leave: entry('Participant left', 'participants', 2, .65),
  microphone_mute: entry('Microphone muted', 'controls', 2, .6, 'local'),
  microphone_on: entry('Microphone unmuted', 'controls', 2, .6, 'local'),
  camera_on: entry('Camera enabled', 'controls', 2, .6, 'local'), camera_off: entry('Camera disabled', 'controls', 2, .6, 'local'),
  hand_on: entry('Hand raised', 'participants', 3, .75), hand_off: entry('Hand lowered', 'controls', 1, .5, 'local'),
  screen_on: entry('Screen sharing started', 'controls', 3, .8, 'local'), screen_off: entry('Screen sharing stopped', 'controls', 2, .7, 'local'),
  connection_lost: entry('Connection lost', 'huddles', 5), reconnection: entry('Connection restored', 'huddles', 4),
  declined: entry('Invitation declined', 'huddles', 4), unanswered: entry('Invitation unanswered', 'huddles', 3),
  captions_start: entry('Live captions enabled', 'controls', 2, .6, 'local'), captions_stop: entry('Live captions disabled', 'controls', 2, .6, 'local'),
  workspace_invite: entry('Workspace invitation', 'activity', 3), community_invite: entry('Community invitation', 'activity', 3),
  invite_accepted: entry('Invitation accepted', 'activity', 2), join_request: entry('Community join request', 'activity', 3),
  member_join: entry('New member', 'activity', 1, .7), task_assigned: entry('Task assigned', 'feedback', 3),
  meeting_reminder: entry('Meeting reminder', 'feedback', 4), deadline: entry('Deadline reminder', 'feedback', 4),
  system: entry('Important system notification', 'feedback', 3), success: entry('Significant action completed', 'feedback', 1, .6, 'local'),
  warning: entry('Warning', 'feedback', 3, .8, 'local'), error: entry('Error', 'feedback', 3, .8, 'local'),
  notes_enabled: entry('AI meeting notes are now enabled.', 'announcements', 10),
  notes_stopped: entry('AI meeting notes have been stopped.', 'announcements', 10),
  recording_started: entry('This meeting is now being recorded.', 'announcements', 10),
  recording_stopped: entry('Meeting recording has stopped.', 'announcements', 10),
  transcription_started: entry('Speech transcription is now enabled. Finalized captions will be saved as meeting notes.', 'announcements', 10),
  transcription_stopped: entry('Speech transcription has stopped.', 'announcements', 10),
  transcription_active: entry('Speech transcription is active in this Huddle. Finalized captions are saved as meeting notes.', 'announcements', 10),
} as const;
export type SoundEvent = keyof typeof soundEvents;
export type SoundPreferences = { enabled: boolean; volume: number } & Record<SoundCategory, boolean> & { events: Partial<Record<SoundEvent, boolean>> };
export const defaultSoundPreferences: SoundPreferences = {
  enabled: true, volume: .35, messages: true, mentions: true, huddles: true, participants: true,
  controls: true, announcements: true, activity: true, feedback: true, events: {},
};
export function normalizeSoundPreferences(value: Partial<SoundPreferences> = {}): SoundPreferences {
  const result = { ...defaultSoundPreferences, ...value, events: { ...value.events } };
  // Older accounts used one switch for all Huddle events.
  for (const category of ['participants', 'controls'] as const) if (value[category] === undefined) result[category] = value.huddles ?? true;
  if (value.mentions === undefined) result.mentions = value.messages ?? true;
  result.volume = Number.isFinite(result.volume) ? Math.max(0, Math.min(1, result.volume)) : .35;
  return result;
}
