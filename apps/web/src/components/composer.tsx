'use client';

import { useEffect, useRef, useState } from 'react';
import type { Attachment } from '@hive/shared';
import { apiFetch, responseData } from '../lib/api';
import { socket } from '../lib/socket';
import { requestError } from '../lib/spaces';
import { formatSize } from './message-item';

const MAX_FILES = 5;
const MAX_BYTES = 10 * 1024 * 1024;

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
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState('');
  const picker = useRef<HTMLInputElement>(null);
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

  async function upload(list: FileList | null) {
    if (!list) return;
    setError('');
    const chosen = Array.from(list).slice(0, MAX_FILES - files.length);
    for (const file of chosen) {
      if (file.size > MAX_BYTES) { setError(`${file.name} is larger than 10 MB`); continue; }
      setUploading(count => count + 1);
      try {
        const form = new FormData();
        form.append('file', file);
        const response = await apiFetch(`/api/channels/${channelId}/uploads`, { method: 'POST', body: form });
        const uploaded = await responseData<Attachment>(response);
        setFiles(current => [...current, uploaded]);
      } catch (cause) { setError(requestError(cause)); }
      finally { setUploading(count => count - 1); }
    }
    if (picker.current) picker.current.value = '';
  }

  function submit() {
    if (reason || uploading || (!body.trim() && !files.length)) return;
    stopTyping();
    onSend(body, files);
    setBody(''); setFiles([]); setError('');
  }

  const empty = !body.trim() && !files.length;
  return <form onSubmit={event => { event.preventDefault(); submit(); }}>
    {files.length > 0 && <ul className="mb-2 flex flex-wrap gap-2">{files.map(file => <li key={file.id}
      className="flex max-w-full items-center gap-2 rounded border border-white/15 px-2 py-1 text-xs">
      <span className="truncate">{file.filename}</span><span className="text-white/40">{formatSize(file.size)}</span>
      <button type="button" aria-label={`Remove ${file.filename}`} className="text-rose-400"
        onClick={() => setFiles(current => current.filter(item => item.id !== file.id))}>×</button>
    </li>)}</ul>}
    {error && <p role="alert" className="mb-1 text-xs text-rose-400">{error}</p>}
    <textarea aria-label="Message" placeholder={reason || placeholder} disabled={!!reason} value={body} maxLength={4000} rows={2}
      className="w-full resize-none rounded-lg border border-white/15 bg-[#0b0d12] p-3 text-sm disabled:opacity-60 focus:border-amber-400 focus:outline-none"
      onChange={event => change(event.target.value)} onBlur={stopTyping}
      onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); void upload(event.clipboardData.files); } }}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
      }} />
    <div className="mt-1 flex items-center justify-between gap-2 text-xs text-white/40">
      <span>{reason || (uploading ? 'Uploading…' : body.length > 3500 ? `${body.length}/4000` : 'Enter to send · Shift+Enter for a new line')}</span>
      <div className="flex shrink-0 gap-2">
        <input ref={picker} type="file" multiple hidden onChange={event => void upload(event.target.files)} />
        <button type="button" disabled={!!reason || files.length >= MAX_FILES} onClick={() => picker.current?.click()}
          aria-label="Attach files" className="rounded border border-white/15 px-3 py-2 disabled:opacity-40">📎</button>
        <button type="submit" disabled={!!reason || !!uploading || empty} className="rounded bg-amber-400 px-3 py-2 font-semibold text-black disabled:opacity-40">Send</button>
      </div>
    </div>
  </form>;
}
