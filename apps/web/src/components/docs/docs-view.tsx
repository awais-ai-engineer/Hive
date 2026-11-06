'use client';

import { useCallback, useEffect, useState } from 'react';
import { docsApi, timeAgo, type DocSummary, type DocUpdate } from '../../lib/docs';
import { socket } from '../../lib/socket';
import { requestError } from '../../lib/spaces';
import { Icon } from '../ui/icons';
import { DocEditor } from './doc-editor';

/** The Docs tab of a channel or conversation: a list of docs, and the editor for the open one. */
export function DocsView({ channelId, slug, userId, canWrite, docId, onOpen }: {
  channelId: string; slug?: string | null; userId: string; canWrite: boolean; docId: string | null; onOpen: (docId: string | null) => void;
}) {
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    docsApi.list(channelId).then(list => { setDocs(list); setError(''); }).catch(cause => setError(requestError(cause)));
  }, [channelId]);
  useEffect(() => { setDocs(null); load(); }, [load]);
  useEffect(() => {
    const onUpdate = (data: DocUpdate) => { if (data.channelId === channelId) load(); };
    socket.on('doc:updated', onUpdate).on('connect', load);
    return () => { socket.off('doc:updated', onUpdate).off('connect', load); };
  }, [channelId, load]);

  async function create() {
    setBusy(true); setError('');
    try { onOpen((await docsApi.create(channelId, {})).id); }
    catch (cause) { setError(requestError(cause)); }
    setBusy(false);
  }

  if (docId) {
    return <DocEditor key={docId} docId={docId} channelId={channelId} slug={slug} userId={userId} canWrite={canWrite}
      onBack={() => { load(); onOpen(null); }} onGone={() => { load(); onOpen(null); }} />;
  }
  const newButton = canWrite && <button type="button" onClick={() => void create()} disabled={busy} className="auth-button !mt-0 flex items-center gap-1.5 !px-4 !py-2">
    <Icon name="plus" size={16} />New doc</button>;
  return <div className="min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto w-full max-w-3xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-white/60">Docs keep notes, plans and checklists next to the chat.</p>
        {docs && docs.length > 0 && newButton}
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-rose-500">{error}</p>}
      {docs === null && !error && <p className="text-white/55">Loading docs…</p>}
      {docs?.length === 0 && <div className="card flex flex-col items-center gap-3 p-8 text-center">
        <Icon name="file" size={32} className="text-white/35" />
        <p className="font-semibold">No docs yet</p>
        <p className="max-w-sm text-sm text-white/60">Docs keep notes, plans and checklists next to the chat.{canWrite ? ' Start one for this conversation.' : ' Someone with posting access can start one.'}</p>
        {newButton}
      </div>}
      <ul className="space-y-2">
        {docs?.map(doc => <li key={doc.id}>
          <button type="button" onClick={() => onOpen(doc.id)} className="card flex w-full items-center gap-3 p-3 text-left transition hover:border-brand/50">
            <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-xl">{doc.emoji ?? <Icon name="file" size={20} className="text-brand" />}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">{doc.title || 'Untitled'}</span>
              <span className="block truncate text-xs text-white/55">Edited {timeAgo(doc.updated_at)}{doc.updated_by ? ` by ${doc.updated_by.username}` : ''}</span>
            </span>
            <Icon name="chevronRight" size={16} className="shrink-0 text-white/40" />
          </button>
        </li>)}
      </ul>
    </div>
  </div>;
}
