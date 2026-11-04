'use client';

import { useEffect, useRef, useState } from 'react';
import type { Attachment } from '@hive/shared';
import { UploadPicker } from './upload-picker';
import { socket } from '../lib/socket';



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

  const empty = !body.trim() && !files.length;
  return <form onSubmit={event => { event.preventDefault(); submit(); }}>
    {!reason && <UploadPicker key={pickerKey} path={`/api/channels/${channelId}/uploads`} onChange={setFiles} onBusy={setUploading} />}
    {error && <p role="alert" className="mb-1 text-xs text-rose-400">{error}</p>}
    <textarea aria-label="Message" placeholder={reason || placeholder} disabled={!!reason} value={body} maxLength={4000} rows={2}
      className="w-full resize-none rounded-lg border border-white/15 bg-[#0b0d12] p-3 text-sm disabled:opacity-60 focus:border-amber-400 focus:outline-none"
      onChange={event => change(event.target.value)} onBlur={stopTyping}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
      }} />
    <div className="mt-1 flex items-center justify-between gap-2 text-xs text-white/40">
      <span>{reason || (uploading ? 'Uploading…' : body.length > 3500 ? `${body.length}/4000` : 'Enter to send · Shift+Enter for a new line')}</span>
      <div className="flex shrink-0 gap-2">
        <button type="submit" disabled={!!reason || !!uploading || empty} className="rounded bg-amber-400 px-3 py-2 font-semibold text-black disabled:opacity-40">Send</button>
      </div>
    </div>
  </form>;
}
