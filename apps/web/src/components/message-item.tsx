'use client';

import { useState } from 'react';
import type { Attachment } from '@hive/shared';
import { API_URL } from '../lib/api';
import { chatRequest } from '../lib/socket';
import { requestError } from '../lib/spaces';
import type { ChatMessage } from '../lib/use-channel-messages';

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '🙏'];

type Props = {
  message: ChatMessage;
  grouped: boolean;
  userId?: string;
  canWrite: boolean;
  canModerate: boolean;
  onRetry: (message: ChatMessage) => void;
  onReply?: (message: ChatMessage) => void;
  onError: (message: string) => void;
};

export function formatSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

function AttachmentView({ file }: { file: Attachment }) {
  const href = `${API_URL}${file.url}`;
  if (file.content_type.startsWith('image/') && file.url) {
    return <a href={href} target="_blank" rel="noreferrer" className="block w-fit">
      <img src={href} alt={file.filename} loading="lazy" className="max-h-64 max-w-full rounded border border-white/10" />
    </a>;
  }
  return <a href={href} className="flex w-fit max-w-full items-center gap-2 rounded border border-white/10 px-3 py-2 text-sm hover:border-amber-400/60">
    <span aria-hidden>📄</span><span className="truncate text-amber-400">{file.filename}</span>
    <span className="shrink-0 text-xs text-white/40">{formatSize(file.size)}</span>
  </a>;
}

export function MessageItem({ message, grouped, userId, canWrite, canModerate, onRetry, onReply, onError }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [picker, setPicker] = useState(false);
  const own = userId === message.author.id;
  const live = !message.deleted && !message.status;

  async function run(event: string, payload: object) {
    try { await chatRequest(event, payload); return true; }
    catch (cause) { onError(requestError(cause)); return false; }
  }
  async function saveEdit() {
    if (await run('message:edit', { messageId: message.id, body: draft })) setEditing(false);
  }
  function react(emoji: string) {
    setPicker(false);
    void run('reaction:toggle', { messageId: message.id, emoji });
  }

  return <article data-message-id={message.id} className={`group relative rounded px-2 py-1 hover:bg-white/[0.03] ${grouped ? '' : 'mt-4'}`}>
    {!grouped && <div className="mb-1 flex items-center gap-2">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-400/15 text-sm text-amber-400">{message.author.username[0].toUpperCase()}</span>
      <span className="truncate font-semibold">{message.author.username}</span>
      <time dateTime={message.created_at} title={new Date(message.created_at).toLocaleString()} className="shrink-0 text-xs text-white/40">
        {new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </time>
    </div>}
    {editing ? <textarea autoFocus aria-label="Edit message" value={draft} maxLength={4000}
      className="w-full rounded border border-amber-400/50 bg-[#0b0d12] p-2" onChange={event => setDraft(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Escape') setEditing(false);
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void saveEdit(); }
      }} /> : (message.body || message.deleted) && <p className={`whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${message.deleted ? 'italic text-white/40' : 'text-white/85'}`}>
      {message.deleted ? 'Message deleted' : message.body}
      {message.edited_at && !message.deleted && <span className="ml-2 text-xs text-white/40">(edited)</span>}
    </p>}
    {message.attachments.length > 0 && <div className="mt-1 flex flex-wrap gap-2">
      {message.attachments.map(file => <AttachmentView key={file.id} file={file} />)}
    </div>}
    {message.reactions.length > 0 && <div className="mt-1 flex flex-wrap gap-1">
      {message.reactions.map(reaction => {
        const mine = !!userId && reaction.user_ids.includes(userId);
        return <button key={reaction.emoji} disabled={!canWrite || !live} onClick={() => react(reaction.emoji)}
          aria-pressed={mine} aria-label={`${reaction.emoji} ${reaction.count}`}
          className={`rounded-full border px-2 text-sm ${mine ? 'border-amber-400/70 bg-amber-400/15' : 'border-white/15'} disabled:cursor-default`}>
          {reaction.emoji} <span className="text-xs text-white/70">{reaction.count}</span>
        </button>;
      })}
    </div>}
    {onReply && message.reply_count > 0 && <button onClick={() => onReply(message)} className="mt-1 text-xs font-semibold text-amber-400">
      {message.reply_count} {message.reply_count === 1 ? 'reply' : 'replies'}
    </button>}
    {message.status === 'sending' && <span className="text-xs text-white/40">Sending…</span>}
    {message.status === 'failed' && <p className="text-xs text-rose-400">Failed: {message.error} <button className="underline" onClick={() => onRetry(message)}>Retry</button></p>}
    {live && (canWrite || own || canModerate) && <div className="flex flex-wrap justify-end gap-3 text-xs text-amber-400 sm:absolute sm:right-2 sm:top-1 sm:rounded sm:bg-[#151821] sm:px-2 sm:py-1 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
      {canWrite && <button aria-label="Add reaction" aria-expanded={picker} onClick={() => setPicker(value => !value)}>React</button>}
      {canWrite && onReply && <button aria-label="Reply in thread" onClick={() => onReply(message)}>Reply</button>}
      {own && <button aria-label="Edit message" onClick={() => { setEditing(true); setDraft(message.body ?? ''); }}>Edit</button>}
      {(own || canModerate) && <button aria-label="Delete message" onClick={() => void run('message:delete', { messageId: message.id })}>Delete</button>}
    </div>}
    {picker && <div role="menu" className="mt-1 flex w-fit gap-1 rounded border border-white/15 bg-[#151821] p-1">
      {QUICK_REACTIONS.map(emoji => <button key={emoji} role="menuitem" onClick={() => react(emoji)} className="rounded px-1 text-lg hover:bg-white/10">{emoji}</button>)}
    </div>}
  </article>;
}
