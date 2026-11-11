'use client';

import { forwardRef, useEffect, useRef, useState, type InputHTMLAttributes, type HTMLAttributes } from 'react';
import { toast } from 'sonner';
import { Button } from './controls';

/** Hidden native file input; validation and presentation stay inside the shared library. */
export const FileInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(function FileInput({ className = '', ...props }, ref) { return <input {...props} type="file" ref={ref} className={`ui-file-input ${className}`} />; });

type FileRow = { id: string; file: File; url: string; progress: number | null; error?: string; controller: AbortController };
export type FileDropzoneProps = HTMLAttributes<HTMLDivElement> & {
  /** Accepted extensions/MIME types and byte limit come from the caller's upload config. */
  accept?: string; maxBytes?: number; multiple?: boolean; disabled?: boolean;
  onFiles?: (files: File[]) => void;
  onUpload?: (file: File, progress: (percent: number) => void, signal: AbortSignal) => Promise<unknown>;
};
function accepted(file: File, accept?: string) { return !accept || accept.split(',').some(part => { const type = part.trim().toLowerCase(); return type.startsWith('.') ? file.name.toLowerCase().endsWith(type) : type.endsWith('/*') ? file.type.startsWith(type.slice(0, -1)) : file.type === type; }); }

/** Accessible file selection/drop target with media previews, abortable upload progress, and rejection toasts. */
const Dropzone = forwardRef<HTMLDivElement, FileDropzoneProps>(function FileDropzone({ accept, maxBytes = 10 * 1024 * 1024, multiple = true, disabled, onFiles, onUpload, className = '', ...props }, ref) {
  const input = useRef<HTMLInputElement>(null); const [rows, setRows] = useState<FileRow[]>([]); const latest = useRef(rows); latest.current = rows;
  useEffect(() => () => { for (const row of latest.current) { URL.revokeObjectURL(row.url); row.controller.abort(); } }, []);
  const update = (id: string, changes: Partial<FileRow>) => setRows(current => current.map(row => row.id === id ? { ...row, ...changes } : row));
  async function add(files: File[]) {
    if (disabled) return;
    const valid = files.filter(file => { const error = !accepted(file, accept) ? `${file.name}: this file type is not allowed.` : file.size > maxBytes ? `${file.name}: maximum size is ${Math.round(maxBytes / 1024 / 1024)} MB.` : ''; if (error) toast.error(error); return !error; }).slice(0, multiple ? undefined : 1);
    if (!valid.length) return;
    const added = valid.map(file => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file), progress: onUpload ? 0 : null, controller: new AbortController() }));
    if (multiple) setRows(current => [...current, ...added]);
    else {
      for (const row of latest.current) { row.controller.abort(); URL.revokeObjectURL(row.url); }
      setRows(added);
    }
    onFiles?.(valid);
    for (const row of added) {
      if (!onUpload) continue;
      try { await onUpload(row.file, percent => update(row.id, { progress: Math.max(0, Math.min(100, percent)) }), row.controller.signal); update(row.id, { progress: 100 }); }
      catch (reason) { if (!row.controller.signal.aborted) { const error = reason instanceof Error ? reason.message : 'Upload failed.'; update(row.id, { error }); toast.error(error); } }
    }
  }
  return <div {...props} ref={ref} className={`ui-dropzone ${className}`} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void add(Array.from(event.dataTransfer.files)); }}>
    <FileInput ref={input} disabled={disabled} accept={accept} multiple={multiple} aria-label="Choose files" onChange={event => { void add(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
    <Button type="button" variant="secondary" disabled={disabled} onClick={() => input.current?.click()}>Choose files</Button><p className="ui-help">Drop files here · Up to {Math.round(maxBytes / 1024 / 1024)} MB per file</p>
    <ul className="ui-file-list">{rows.map(row => <li key={row.id}>{row.file.type.startsWith('image/') && <img src={row.url} alt={row.file.name} />}{row.file.type.startsWith('video/') && <video src={row.url} controls preload="metadata" aria-label={row.file.name} />}<span>{row.file.name}</span>{row.progress !== null && !row.error && <progress value={row.progress} max={100} aria-label={`Uploading ${row.file.name}`} />}{row.error && <span role="alert" className="ui-error">{row.error}</span>}<Button type="button" aria-label={`Remove ${row.file.name}`} onClick={() => { row.controller.abort(); URL.revokeObjectURL(row.url); setRows(current => current.filter(item => item.id !== row.id)); }}>Remove</Button></li>)}</ul>
  </div>;
});
export const FileDropzone = Object.assign(Dropzone, { Input: FileInput });
