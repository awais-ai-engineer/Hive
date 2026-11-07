'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Attachment } from '@hive/shared';
import { API_URL } from '../lib/api';
import { ReportDialog } from './report-dialog';
import { AddTodoDialog } from './todos/add-todo-dialog';
import { Avatar } from './ui/avatar';
import { Icon } from './ui/icons';
import { StatusMark } from './ui/status-mark';
import { chatRequest } from '../lib/socket';
import { requestError } from '../lib/spaces';
import type { ChatMessage } from '../lib/use-channel-messages';
import { RichText } from './rich-text';
import { EmojiPicker } from './emoji-picker';
import { PollCard } from './poll-card';
import { VoicePlayer } from './voice-player';
import { LinkPreview } from './link-preview';
import { HuddleNotes } from './ai/huddle-notes';
import { TranslateLink } from './ai/translate';
import { useSaved } from '../lib/saved';
import { ViewOnce } from './view-once';

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
  channels?: {id:string;name:string;href:string}[];
  /** Secret conversations: the decrypted text (undefined while decrypting, null when this device cannot read it). */
  secretText?: string | null;
};

export function formatSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

function AttachmentView({ file, own }: { file: Attachment; own: boolean }) {
  if (file.viewOnce) return <ViewOnce file={file} own={own} />;
  if (file.kind === 'audio') return <VoicePlayer attachment={file} />;
  const href = /^https?:\/\//.test(file.url) ? file.url : `${API_URL}${file.url}`;
  if (file.kind === 'video') return <video src={href} controls preload="metadata" playsInline className="max-h-80 max-w-full rounded" />;
  if (file.kind === 'image' && file.url) {
    return <a href={href} target="_blank" rel="noreferrer" className="block w-fit">
      <img src={href} alt={file.filename} loading="lazy" className="max-h-64 max-w-full rounded border border-white/10" />
    </a>;
  }
  return <a href={href} className="flex w-fit max-w-full items-center gap-2 rounded border border-white/10 px-3 py-2 text-sm hover:border-amber-400/60">
    <span aria-hidden>📄</span><span className="truncate text-amber-400">{file.filename}</span>
    <span className="shrink-0 text-xs text-white/40">{formatSize(file.size)}</span>
  </a>;
}

export function MessageItem({ message, grouped, userId, canWrite, canModerate, onRetry, onReply, onError, channels = [], secretText }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [picker, setPicker] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [todo, setTodo] = useState(false);
  const saved = useSaved();
  const isSaved = saved.isSaved('message', message.id);
  const own = userId === message.author.id;
  const live = !message.deleted && !message.status;
  const secret = !!message.ciphertext || message.plain !== undefined;
  const secretBody = message.plain ?? secretText;
  const viewOnce = message.attachments.some(file => file.viewOnce);
  const mentioned = !!userId && !!message.mentions?.some(mention=>mention.userId===userId);
  useEffect(()=>{const edit=(event:Event)=>{if(own&&!message.ciphertext&&message.kind!=='poll'&&message.kind!=='voice'&&(event as CustomEvent<{id:string}>).detail.id===message.id){setDraft(message.body??'');setEditing(true);}};window.addEventListener('hive:edit-message',edit);return()=>window.removeEventListener('hive:edit-message',edit);},[own,message.id,message.body,message.kind]);

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

  const time = new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (message.kind === 'system') {
    return <div data-message-id={message.id} className="my-3 px-2">
      <div role="status" className="flex items-center justify-center gap-2 text-center text-xs text-white/55">
        <Icon name="clock" size={14} className="shrink-0" /><span><strong>{message.author.username}</strong> {message.body}</span>
        <time dateTime={message.created_at} title={new Date(message.created_at).toLocaleString()} className="shrink-0 text-white/40">{time}</time>
      </div>
    </div>;
  }
  if (message.kind === 'huddle') {
    // System line, for example the summary of a huddle that just ended.
    return <div data-message-id={message.id} className="my-3 px-2">
      <div role="status" className="flex items-center justify-center gap-2 text-center text-xs text-white/55">
        <Icon name="headphones" size={14} className="shrink-0" /><span>{message.body}</span>
        <time dateTime={message.created_at} title={new Date(message.created_at).toLocaleString()} className="shrink-0 text-white/40">{time}</time>
      </div>
      {!message.id.startsWith('pending:') && <HuddleNotes messageId={message.id} channelId={message.channel_id} userId={userId} />}
    </div>;
  }
  return <article data-message-id={message.id} className={`group relative flex gap-3 rounded-xl px-2 py-1 transition hover:bg-[var(--surface-2)] ${mentioned?'border-s-2 border-brand bg-brand-soft':''} ${grouped ? '' : 'mt-3 pt-2'}`}>
    <div className="w-10 shrink-0">
      {grouped ? <time dateTime={message.created_at} className="hidden pt-1 text-right text-[10px] text-white/35 group-hover:block">{time}</time>
        : <Link href={`/u/${message.author.username}`} aria-label={`${message.author.username}'s profile`}><Avatar name={message.author.username} src={message.author.avatar_url} size={40} /></Link>}
    </div>
    <div className="min-w-0 flex-1">
    {!grouped && <div className="flex items-baseline gap-2">
      <Link href={`/u/${message.author.username}`} className="truncate font-semibold hover:underline">{message.author.username}</Link>
      <StatusMark person={message.author} />
      <time dateTime={message.created_at} title={new Date(message.created_at).toLocaleString()} className="shrink-0 text-xs text-white/40">
        {time}
      </time>
      {message.expires_at && <span className="shrink-0 text-xs text-white/40" title={`Disappears ${new Date(message.expires_at).toLocaleString()}`}><Icon name="clock" size={12} className="inline" /></span>}
    </div>}
    {mentioned&&<span className="my-1 inline-block rounded-full bg-brand px-2 py-0.5 text-xs text-white">Mentions you</span>}
    {editing ? <textarea autoFocus aria-label="Edit message" value={draft} maxLength={4000}
      className="w-full rounded-xl border border-brand/50 bg-surface p-2" onChange={event => setDraft(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Escape') setEditing(false);
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void saveEdit(); }
      }} /> : message.deleted ? <p className="italic leading-relaxed text-white/40">Message deleted</p>
      : secret ? <p className="whitespace-pre-wrap break-words leading-relaxed text-white/90 [overflow-wrap:anywhere]">{secretBody === undefined ? <span className="italic text-white/50">Decrypting…</span>
        : secretBody === null ? <span className="italic text-white/50">This message can&apos;t be read on this device. Secret messages only open on devices that were set up when they were sent.</span> : secretBody}</p>
      : message.kind === 'poll' && message.poll ? <PollCard message={message} userId={userId} />
      : message.body ? <div className="break-words leading-relaxed text-white/90 [overflow-wrap:anywhere]">
        <RichText source={message.body} mentions={message.mentions ?? []} channels={message.channelLinks ?? channels} />
        {message.edited_at && <span className="text-xs text-white/40">(edited)</span>}
      </div> : null}
    {!editing && live && !own && !secret && (!message.kind || message.kind === 'text') && !!message.body?.trim()
      && <TranslateLink targetId={message.id} channelId={message.channel_id} />}
    {!editing && !message.deleted && !secret && message.kind !== 'poll' && !!message.body && !message.post_previews?.length
      && <LinkPreview source={message.body} messageId={message.id} userId={userId} />}
    {message.attachments.length > 0 && <div className="mt-1 flex flex-wrap gap-2">
      {message.attachments.map(file => <AttachmentView key={file.id} file={file} own={own} />)}
    </div>}
    {!message.deleted && !!message.post_previews?.length && <div className="mt-1 flex flex-col gap-2">
      {message.post_previews.map(preview => <Link key={preview.id} href={`/p/${preview.id}`}
        className="block w-full max-w-md rounded-lg border border-white/15 bg-white/[0.03] px-3 py-2 hover:border-amber-400/60">
        <span className="block text-xs text-white/45">{preview.space.name}</span>
        <span className="block truncate font-semibold text-white/90">{preview.deleted ? '[deleted]' : preview.title}</span>
        <span className="block text-xs text-white/45">▲ {preview.score} · 💬 {preview.comment_count}</span>
      </Link>)}
    </div>}
    {message.reactions.length > 0 && <div className="mt-1 flex flex-wrap gap-1">
      {message.reactions.map(reaction => {
        const mine = !!userId && reaction.user_ids.includes(userId);
        return <button key={reaction.emoji} disabled={!canWrite || !live} onClick={() => react(reaction.emoji)}
          aria-pressed={mine} aria-label={`${reaction.emoji} ${reaction.count}`}
          className={`flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-sm transition ${mine ? 'border-brand/50 bg-brand-soft' : 'border-white/10 bg-[var(--surface-2)] hover:border-white/25'} disabled:cursor-default`}>
          {reaction.emoji} <span className={`text-xs font-semibold ${mine ? 'text-brand' : 'text-white/70'}`}>{reaction.count}</span>
        </button>;
      })}
    </div>}
    {onReply && message.reply_count > 0 && <button onClick={() => onReply(message)} className="mt-1 rounded-lg px-1 text-xs font-semibold text-brand hover:bg-brand-soft">
      {message.reply_count} {message.reply_count === 1 ? 'reply' : 'replies'}
    </button>}
    {message.status === 'sending' && <span className="text-xs text-white/40">Sending…</span>}
    {message.status === 'failed' && <p className="text-xs text-rose-400">Failed: {message.error} <button className="underline" onClick={() => onRetry(message)}>Retry</button></p>}
    {live && (canWrite || own || canModerate || !!userId) && <div className="mt-1 flex flex-wrap gap-3 text-xs font-medium text-brand sm:absolute sm:-top-3 sm:right-3 sm:mt-0 sm:gap-1 sm:rounded-xl sm:border sm:border-white/10 sm:bg-surface sm:p-1 sm:shadow-[var(--shadow-card)] sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 [&>button]:rounded-lg [&>button]:px-2 [&>button]:py-1 [&>button:hover]:bg-[var(--surface-2)]">
      {canWrite && <button aria-label="Add reaction" aria-expanded={picker} onClick={() => setPicker(value => !value)}>React</button>}
      {canWrite && onReply && <button aria-label="Reply in thread" onClick={() => onReply(message)}>Reply</button>}
      {own && !secret && <button aria-label="Edit message" onClick={() => { setEditing(true); setDraft(message.body ?? ''); }}>Edit</button>}
      {!!userId && !secret && !viewOnce && !message.id.startsWith('pending:') && <button aria-label={isSaved ? 'Remove from saved items' : 'Save message'} aria-pressed={isSaved}
        onClick={() => void saved.toggle('message', message.id).catch(cause => onError(requestError(cause)))}>{isSaved ? 'Saved' : 'Save'}</button>}
      {canWrite && !!userId && !secret && !viewOnce && !message.id.startsWith('pending:') && <button aria-label="Add to to-dos" onClick={() => setTodo(true)}>Add to to-dos</button>}
      {!own && !!userId && !message.id.startsWith('pending:') && <button aria-label="Report message" onClick={() => setReporting(true)}>Report</button>}
      {(own || canModerate) && <button aria-label="Delete message" onClick={() => void run('message:delete', { messageId: message.id })}>Delete</button>}
    </div>}
    {picker && <div role="menu" className="mt-1 flex w-fit gap-1 rounded-2xl border border-white/10 bg-surface p-1 shadow-[var(--shadow-pop)]">
      {QUICK_REACTIONS.map(emoji => <button key={emoji} role="menuitem" onClick={() => react(emoji)} className="rounded px-1 text-lg hover:bg-white/10">{emoji}</button>)}
    </div>}
    </div>
    {todo && userId && <AddTodoDialog messageId={message.id} channelId={message.channel_id} text={message.body ?? ''} userId={userId} onClose={() => setTodo(false)} />}
    <ReportDialog target={reporting ? { type: 'message', id: message.id, label: 'message' } : null} onClose={() => setReporting(false)} />
  </article>;
}
