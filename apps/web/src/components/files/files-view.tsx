'use client';

import { Tooltip as UiTooltip } from '@hive/ui';

import { Button as UiButton, Select as UiSelect, Input as UiInput } from '@hive/ui';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fileHref, fileLocation, loadFiles, type FileItem, type FilterKind, type Person } from '../../lib/files';
import { requestError, type Space } from '../../lib/spaces';
import { formatSize } from '../message-item';
import { Avatar } from '../ui/avatar';
import { Icon } from '../ui/icons';
import { Lightbox } from './lightbox';

const KINDS: [FilterKind, string][] = [['all', 'All'], ['image', 'Images'], ['video', 'Videos'], ['file', 'Documents'], ['audio', 'Audio']];

const day = (value: string) => new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const who = (person: Person) => person.displayName || person.username;

/** Files tab of a channel or conversation, and the All files page (with a space filter). */
export function FilesView({ channelId, spaces }: { channelId?: string; spaces?: Space[] }) {
  const [kind, setKind] = useState<FilterKind>('all');
  const [uploaderId, setUploaderId] = useState('');
  const [spaceId, setSpaceId] = useState('');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<FileItem[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const run = useRef(0);

  useEffect(() => { const timer = setTimeout(() => setQ(text), 300); return () => clearTimeout(timer); }, [text]);

  const fetchPage = useCallback(async (next: string | null) => {
    const id = ++run.current;
    if (next) setMore(true); else setReady(false);
    try {
      const page = await loadFiles({ channelId, spaceId, kind, uploaderId, q, cursor: next });
      if (id !== run.current) return;
      setItems(current => next ? [...current, ...page.items] : page.items);
      setPeople(page.uploaders);
      setCursor(page.nextCursor);
      setError('');
    } catch (cause) { if (id === run.current) setError(requestError(cause)); }
    finally { if (id === run.current) { setReady(true); setMore(false); } }
  }, [channelId, spaceId, kind, uploaderId, q]);
  useEffect(() => { void fetchPage(null); }, [fetchPage]);
  useEffect(() => { setKind('all'); setUploaderId(''); setText(''); setQ(''); }, [channelId]);

  const media = items.filter(file => file.kind === 'image' || file.kind === 'video');
  const rest = items.filter(file => file.kind !== 'image' && file.kind !== 'video');
  const filtered = kind !== 'all' || !!uploaderId || !!q || !!spaceId;
  const chip = (active: boolean) => `rounded-full border px-3 py-1 text-sm font-medium transition ${active ? 'border-brand bg-brand-soft text-brand' : 'border-white/10 text-white/65 hover:bg-[var(--surface-2)]'}`;

  return <div className="min-h-0 flex-1 overflow-y-auto pr-1">
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div role="group" aria-label="File type" className="flex flex-wrap gap-1.5">
        {KINDS.map(([value, label]) => <UiButton key={value} type="button" aria-pressed={kind === value} className={chip(kind === value)} onClick={() => setKind(value)}>{label}</UiButton>)}
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {spaces && <UiSelect aria-label="Space" className="auth-input !mt-0 !w-auto" value={spaceId} onChange={event => setSpaceId(event.target.value)}>
          <option value="">All spaces</option>
          {spaces.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}
        </UiSelect>}
        <UiSelect aria-label="Uploaded by" className="auth-input !mt-0 !w-auto" value={uploaderId} onChange={event => setUploaderId(event.target.value)}>
          <option value="">Everyone</option>
          {people.map(person => <option key={person.id} value={person.id}>{who(person)}</option>)}
          {uploaderId && !people.some(person => person.id === uploaderId) && <option value={uploaderId}>Selected person</option>}
        </UiSelect>
        <UiInput type="search" aria-label="Search file names" placeholder="Search file names" value={text} maxLength={100}
          className="auth-input !mt-0 !w-48" onChange={event => setText(event.target.value)} />
      </div>
    </div>
    {error && <p role="alert" className="mb-3 text-sm text-rose-500">{error}</p>}

    {!ready ? <div role="status" aria-label="Loading files" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: 8 }, (_, index) => <div key={index} className="aspect-square animate-pulse rounded-xl bg-white/5" />)}
    </div>
      : !items.length ? <div className="mt-16 flex flex-col items-center gap-2 text-center text-white/55">
        <Icon name="folder" size={36} />
        <p>{filtered ? 'No files match these filters.' : channelId ? 'No files yet. Files shared here appear in this tab.' : 'No files yet. Files shared in your conversations appear here.'}</p>
        {filtered && <UiButton type="button" className="btn-ghost" onClick={() => { setKind('all'); setUploaderId(''); setSpaceId(''); setText(''); }}>Clear filters</UiButton>}
      </div> : <>
        {media.length > 0 && <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {media.map(file => <li key={file.id}>
            <UiButton tooltip={`Open ${file.filename}`} type="button" aria-label={`Open ${file.filename}`} onClick={() => setOpen(media.indexOf(file))}
              className="group relative block aspect-square w-full overflow-hidden rounded-xl border border-white/10 bg-[var(--surface-2)]">
              {file.kind === 'image' ? <img src={fileHref(file.url)} alt={file.filename} loading="lazy" className="h-full w-full object-cover transition group-hover:scale-105" />
                : <video src={fileHref(file.url)} preload="metadata" muted playsInline className="h-full w-full object-cover" />}
              {file.kind === 'video' && <span aria-hidden className="absolute inset-0 flex items-center justify-center bg-[rgb(0_0_0/0.25)]"><Icon name="video" size={30} className="text-[var(--rail-fg)]" /></span>}
              <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-[rgb(0_0_0/0.7)] px-2 pb-1.5 pt-5 text-left justify-start text-xs" style={{ color: 'var(--rail-fg)' }}>{file.filename}</span>
            </UiButton>
          </li>)}
        </ul>}
        {rest.length > 0 && <ul className={`divide-y divide-white/10 rounded-xl border border-white/10 ${media.length ? 'mt-4' : ''}`}>
          {rest.map(file => <li key={file.id} className="flex items-center gap-3 px-3 py-2.5">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand"><Icon name={file.kind === 'audio' ? 'mic' : 'file'} /></span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{file.filename}</p>
              <p className="flex flex-wrap items-center gap-x-2 text-xs text-white/55">
                <span>{formatSize(file.size)}</span><span>{day(file.createdAt)}</span>
                <span className="flex items-center gap-1"><Avatar name={file.uploader.username} src={file.uploader.avatarUrl} size={14} />{who(file.uploader)}</span>
                {!channelId && file.channelName && <span>#{file.channelName}</span>}
              </p>
            </div>
            {fileLocation(file) && <Link href={fileLocation(file)!} className="btn-ghost hidden text-sm sm:inline-flex">Go to message</Link>}
            <UiTooltip content="Download"><a href={fileHref(file.url)} download={file.filename} className="btn-ghost" aria-label={`Download ${file.filename}`}><Icon name="download" size={16} /><span className="hidden sm:inline">Download</span></a></UiTooltip>
          </li>)}
        </ul>}
        {cursor && <div className="mt-4 text-center"><UiButton type="button" className="btn-ghost" disabled={more} onClick={() => void fetchPage(cursor)}>{more ? 'Loading…' : 'Load more'}</UiButton></div>}
      </>}
    {open !== null && media[open] && <Lightbox items={media} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
  </div>;
}
