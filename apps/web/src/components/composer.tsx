'use client';

import { useEffect, useRef, useState } from 'react';
import type { Attachment } from '@hive/shared';
import { UploadPicker, type UploadControls } from './upload-picker';
import { Icon } from './ui/icons';
import { socket } from '../lib/socket';

const EMOJI = ['👍', '❤️', '😂', '🎉', '🔥', '🙏', '👀', '✅', '🚀', '😊', '🤔', '💯'];

type Props = {
  channelId: string;
  placeholder: string;
  reason: string;
  sendTyping?: boolean;
  onSend: (body: string, attachments: Attachment[]) => void;
};

/** Message box: Enter sends, Shift+Enter adds a line, files upload before the message is sent. */
export function Composer({ channelId, placeholder, reason, sendTyping = false, onSend }: Props) {
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [pickerKey, setPickerKey] = useState(0);
  const [error, setError] = useState('');
  const [emoji, setEmoji] = useState(false);
  const uploads = useRef<UploadControls | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);

  function stopTyping() {
    if (idle.current) clearTimeout(idle.current);
    idle.current = null;
    if (sendTyping && lastTyping.current && socket.connected) socket.emit('typing:stop', { channelId });
    lastTyping.current = 0;
  }
  // Tell others we stopped typing when the channel changes or the composer unmounts.
  useEffect(() => stopTyping, [channelId]);

  function change(value: string) {
    setBody(value);
    if (!sendTyping) return;
    if (socket.connected && Date.now() - lastTyping.current >= 3000) {
      socket.emit('typing:start', { channelId }); lastTyping.current = Date.now();
    }
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(stopTyping, 4000);
  }

  function submit() {
    if (reason || uploading || (!body.trim() && !files.length)) return;
    stopTyping();
    onSend(body, files);
    setBody(''); setFiles([]); setError(''); setPickerKey(value => value + 1);
  }

  /** Insert text at the cursor (emoji picker, @ button) and keep focus in the box. */
  function insert(text: string) {
    const element = box.current;
    const start = element?.selectionStart ?? body.length;
    const end = element?.selectionEnd ?? body.length;
    change(body.slice(0, start) + text + body.slice(end));
    requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(start + text.length, start + text.length); });
  }

  const empty = !body.trim() && !files.length;
  const tool = 'flex h-8 w-8 items-center justify-center rounded-lg text-white/55 transition hover:bg-[var(--surface-2)] hover:text-white disabled:opacity-40';
  return <form onSubmit={event => { event.preventDefault(); submit(); }}
    onDragOver={event => { if (!reason) event.preventDefault(); }}
    onDrop={event => { if (reason) return; event.preventDefault(); uploads.current?.add(Array.from(event.dataTransfer.files)); }}
    className="relative rounded-2xl border border-white/12 bg-surface shadow-[var(--shadow-card)] transition focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/15">
    {!reason && <UploadPicker key={pickerKey} compact controls={uploads} path={`/api/channels/${channelId}/uploads`} onChange={setFiles} onBusy={setUploading} />}
    {error && <p role="alert" className="px-4 pt-2 text-xs text-rose-500">{error}</p>}
    <textarea ref={box} aria-label="Message" placeholder={reason || placeholder} disabled={!!reason} value={body} maxLength={4000} rows={1}
      className="block max-h-48 min-h-11 w-full resize-none bg-transparent px-4 pt-3 text-[15px] outline-none placeholder:text-white/40 disabled:opacity-60 [field-sizing:content]"
      onChange={event => change(event.target.value)} onBlur={stopTyping}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
      }} />
    <div className="flex items-center gap-1 px-2 pb-2 pt-1">
      <button type="button" className={tool} disabled={!!reason} aria-label="Attach files" title="Attach files" onClick={() => uploads.current?.open()}><Icon name="plus" /></button>
      <button type="button" className={tool} disabled={!!reason} aria-label="Insert emoji" aria-expanded={emoji} onClick={() => setEmoji(value => !value)}>😊</button>
      <button type="button" className={tool} disabled={!!reason} aria-label="Mention someone" onClick={() => insert('@')}><Icon name="at" /></button>
      <span className="ml-2 hidden truncate text-xs text-white/40 sm:inline">
        {reason || (uploading ? 'Uploading…' : body.length > 3500 ? `${body.length}/4000` : 'Enter to send · Shift+Enter for a new line')}</span>
      <button type="submit" disabled={!!reason || uploading || empty} aria-label="Send"
        className="ml-auto flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-white shadow-sm transition hover:bg-brand-strong disabled:opacity-35"><Icon name="send" size={17} /></button>
    </div>
    {emoji && <div role="menu" className="absolute bottom-full left-2 z-20 mb-2 grid grid-cols-6 gap-1 rounded-2xl border border-white/10 bg-surface p-2 shadow-[var(--shadow-pop)]">
      {EMOJI.map(item => <button key={item} type="button" role="menuitem" className="rounded-lg p-1.5 text-xl hover:bg-[var(--surface-2)]"
        onClick={() => { insert(item); setEmoji(false); }}>{item}</button>)}
    </div>}
  </form>;
}
