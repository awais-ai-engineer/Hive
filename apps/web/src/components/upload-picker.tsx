'use client';

import { useEffect, useRef, useState } from 'react';
import type { Attachment } from '@hive/shared';
import { uploadFile } from '../lib/api';

type Row = { id: string; file: File; preview: string; controller: AbortController; progress: number; attachment?: Attachment; error?: string };

async function fileKind(file: File) {
  const b = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const starts = (values: number[]) => values.every((value, index) => b[index] === value);
  const text = (start: number, end: number) => String.fromCharCode(...b.slice(start, end));
  if (starts([137, 80, 78, 71, 13, 10, 26, 10]) || starts([255, 216, 255]) || ['GIF87a', 'GIF89a'].includes(text(0, 6)) || (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP')) return 'image';
  if (text(4, 8) === 'ftyp' || starts([26, 69, 223, 163])) return 'video';
  return 'file';
}

export function UploadPicker({ path, mediaOnly = false, maxFiles = 5, onChange, onBusy }: {
  path: string; mediaOnly?: boolean; maxFiles?: number;
  onChange: (files: Attachment[]) => void; onBusy: (busy: boolean) => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const current = useRef<Row[]>([]);
  const [error, setError] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  const callbacks = useRef({ onChange, onBusy }); callbacks.current = { onChange, onBusy };
  function update(next: Row[]) {
    if (!active.current) return;
    current.current = next; setRows(next);
    callbacks.current.onChange(next.flatMap(row => row.attachment ? [row.attachment] : []));
    callbacks.current.onBusy(next.some(row => !row.attachment && !row.error));
  }
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; current.current.forEach(row => { row.controller.abort(); URL.revokeObjectURL(row.preview); }); };
  }, []);
  async function add(files: File[]) {
    setError('');
    for (const file of files) {
      if (!active.current) return;
      if (current.current.length >= maxFiles) { setError(`Choose at most ${maxFiles} files`); break; }
      const kind = await fileKind(file);
      if (!active.current) return;
      const limit = kind === 'video' ? 100 : 10;
      if (!file.size || file.size > limit * 1048576) { setError(`${file.name}: ${kind}s must be non-empty and at most ${limit} MB`); continue; }
      if (mediaOnly && (kind === 'file' || (kind === 'video' && current.current.length > 0) || current.current.some(row => row.file.type.startsWith('video/')))) {
        setError('Choose 1–10 images or one video'); continue;
      }
      const typedFile = new File([file], file.name, { type: kind === 'video' ? 'video/mp4' : kind === 'image' ? 'image/png' : 'application/octet-stream' });
      const row: Row = { id: crypto.randomUUID(), file: typedFile, preview: URL.createObjectURL(file), controller: new AbortController(), progress: 0 };
      update([...current.current, row]);
      void uploadFile<Attachment>(path, file, progress => update(current.current.map(item => item.id === row.id ? { ...item, progress } : item)), row.controller.signal)
        .then(attachment => update(current.current.map(item => item.id === row.id ? { ...item, attachment, progress: 100 } : item)))
        .catch(cause => { if (cause.name !== 'AbortError') update(current.current.map(item => item.id === row.id ? { ...item, error: cause.message } : item)); });
    }
    if (picker.current) picker.current.value = '';
  }
  return <div className="my-3 min-w-0 rounded border border-dashed border-white/20 p-3" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void add(Array.from(event.dataTransfer.files)); }}>
    <input ref={picker} type="file" multiple accept={mediaOnly ? 'image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm' : undefined} aria-label={mediaOnly ? 'Choose media' : 'Choose files'} onChange={event => void add(Array.from(event.target.files ?? []))} className="sr-only" />
    <button type="button" className="text-sm text-amber-400" onClick={() => picker.current?.click()}>{mediaOnly ? 'Choose media' : 'Attach files'}</button>
    <p className="mt-1 text-xs text-white/40">{mediaOnly ? '10 images or 1 video · Images 10 MB · Videos 100 MB' : 'Drop files here · Images/files 10 MB · Videos 100 MB'}</p>
    <ul className="mt-2 flex flex-wrap gap-2">{rows.map(row => <li key={row.id} className="w-36 max-w-full rounded border border-white/10 p-2 text-xs">
      {mediaOnly && row.file.type.startsWith('image/') && <img src={row.preview} alt={row.file.name} className="mb-1 h-20 w-full object-contain" />}
      {mediaOnly && row.file.type.startsWith('video/') && <video src={row.preview} preload="metadata" className="mb-1 h-20 w-full" />}
      <p className="truncate">{row.file.name}</p>
      {!row.attachment && !row.error && <progress aria-label={`Uploading ${row.file.name}`} value={row.progress} max={100} className="w-full accent-amber-400" />}
      {row.error && <p role="alert" className="text-rose-400">{row.error}</p>}
      <button type="button" className="mt-1 text-rose-400" aria-label={`Remove ${row.file.name}`} onClick={() => {
        row.controller.abort(); URL.revokeObjectURL(row.preview); update(current.current.filter(item => item.id !== row.id));
      }}>Remove</button>
    </li>)}</ul>
    {error && <p role="alert" className="mt-2 text-xs text-rose-400">{error}</p>}
  </div>;
}
