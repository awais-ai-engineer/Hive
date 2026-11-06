import type { StatusFields } from './status';

export type Participant = { id: string; username: string; avatar_url: string | null; online: boolean } & StatusFields;

export type Conversation = {
  id: string;
  participants: Participant[];
  is_group: boolean;
  last_message: {
    id: string; author_id: string; body: string | null; has_attachments: boolean; created_at: string;
  } | null;
  unread: number;
  created_at: string;
};

export type UserResult = { id: string; username: string; avatar_url: string | null };

/** Fired after the viewer reads or opens conversations, so the nav badge can refresh. */
export const DMS_CHANGED = 'hive:dms-changed';

export function conversationTitle(conversation: Conversation) {
  const names = conversation.participants.map(person => person.username);
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
}

export function preview(conversation: Conversation, viewerId?: string) {
  const last = conversation.last_message;
  if (!last) return 'No messages yet';
  const text = last.body === null ? 'Message deleted' : last.body || (last.has_attachments ? '📎 Attachment' : '');
  return last.author_id === viewerId ? `You: ${text}` : text;
}

export function shortTime(iso: string) {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
