'use client';

import { Button as UiButton, LoadingState } from '@hive/ui';

import { useEffect, useState } from 'react';
import { docsApi, timeAgo, type Doc, type DocVersion, type DocVersionSummary } from '../../lib/docs';
import { requestError } from '../../lib/spaces';
import { Avatar } from '../ui/avatar';
import { Icon } from '../ui/icons';
import { BlockEditor } from './block-editor';

/** Side panel with the last saved versions of a doc: preview any of them and restore it. */
export function DocHistory({ docId, canWrite, currentVersion, onRestored, onClose }: {
  docId: string; canWrite: boolean; currentVersion: number; onRestored: (doc: Doc) => void; onClose: () => void;
}) {
  const [versions, setVersions] = useState<DocVersionSummary[] | null>(null);
  const [preview, setPreview] = useState<DocVersion | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    docsApi.versions(docId).then(setVersions).catch(cause => setError(requestError(cause)));
  }, [docId]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function show(version: DocVersionSummary) {
    setError('');
    try { setPreview(await docsApi.version(docId, version.id)); } catch (cause) { setError(requestError(cause)); }
  }
  async function restore() {
    if (!preview) return;
    setBusy(true); setError('');
    try { onRestored(await docsApi.restore(docId, preview.id)); onClose(); }
    catch (cause) { setError(requestError(cause)); setBusy(false); }
  }

  return <div className="on-surface fixed inset-0 z-50 flex justify-end">
    <UiButton tooltip="Close history" type="button" aria-label="Close history" onClick={onClose} className="fixed inset-0 bg-[rgb(0_0_0/0.5)]" />
    <aside role="dialog" aria-modal="true" aria-label="Version history" className="relative flex h-full w-full max-w-3xl flex-col bg-surface shadow-[var(--shadow-pop)] sm:flex-row">
      <div className="flex max-h-[40%] w-full shrink-0 flex-col border-b border-white/10 sm:max-h-none sm:w-64 sm:border-b-0 sm:border-r">
        <div className="flex items-center justify-between p-4 pb-2">
          <h2 className="font-bold">Version history</h2>
          <UiButton tooltip="Close history" type="button" onClick={onClose} aria-label="Close history" className="rounded p-1 text-white/60 hover:bg-white/10"><Icon name="x" size={18} /></UiButton>
        </div>
        <p className="px-4 pb-2 text-xs text-white/55">The last 20 saves. Pick one to look at it before you restore it.</p>
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
          {versions === null && !error && <li><LoadingState layout="inline" label="Loading history" /></li>}
          {versions?.map(version => <li key={version.id}>
            <UiButton type="button" onClick={() => void show(version)} aria-current={preview?.id === version.id}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left justify-start text-sm ${preview?.id === version.id ? 'bg-brand-soft' : 'hover:bg-[var(--surface-2)]'}`}>
              <Avatar name={version.saved_by?.username ?? '?'} src={version.saved_by?.avatar_url} size={28} />
              <span className="min-w-0"><span className="block truncate font-medium">{version.saved_by?.username ?? 'Someone'}{version.version === currentVersion ? ' · current' : ''}</span>
                <span className="block text-xs text-white/55">{timeAgo(version.created_at)}</span></span>
            </UiButton>
          </li>)}
        </ul>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {error && <p role="alert" className="p-4 text-sm text-rose-500">{error}</p>}
        {preview ? <>
          <div className="flex items-center justify-between gap-2 border-b border-white/10 p-4">
            <p className="min-w-0 truncate font-semibold">{preview.emoji} {preview.title || 'Untitled'}</p>
            {canWrite && preview.version !== currentVersion && <UiButton type="button" disabled={busy} onClick={() => void restore()} className="auth-button !mt-0 shrink-0 !px-4 !py-1.5 text-sm">
              {busy ? 'Restoring…' : 'Restore this version'}</UiButton>}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4"><BlockEditor readOnly blocks={preview.body.length ? preview.body : []} onChange={() => {}} /></div>
        </> : <p className="m-auto max-w-xs p-6 text-center text-sm text-white/55">Select a version on the left to preview it here.</p>}
      </div>
    </aside>
  </div>;
}
