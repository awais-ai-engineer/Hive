'use client';

import { AlertDialog, Button, Dialog, Input, Select, Textarea, toast } from '@hive/ui';
import { postCreateSchema } from '@hive/shared';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Attachment } from '@hive/shared';
import { apiData, requestError, type Space } from '../../lib/spaces';
import type { Post } from '../../lib/posts';
import { UploadPicker } from '../upload-picker';
import { Icon } from '../ui/icons';

type Draft = { title: string; body: string; url: string; kind: 'text' | 'link' | 'media' };
const emptyDraft: Draft = { title: '', body: '', url: '', kind: 'text' };

export function PostComposerDialog({ open, onOpenChange, spaces, initialSpace, userId, onPublished }: {
  open: boolean; onOpenChange: (open: boolean) => void; spaces: Space[]; initialSpace?: Space; userId: string;
  onPublished?: (post: Post) => void;
}) {
  const available = useMemo(() => spaces.filter(space => !!space.my_role && space.my_role !== 'guest'), [spaces]);
  const [spaceId, setSpaceId] = useState(initialSpace?.id ?? available[0]?.id ?? '');
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const space = available.find(item => item.id === spaceId);
  const uploads = useRef({ files, space });
  uploads.current = { files, space };
  const dirty = !!(draft.title.trim() || draft.body.trim() || draft.url.trim() || files.length);
  const storageKey = `hive:post-draft:${userId}:${spaceId || 'default'}`;

  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<Draft>;
        setDraft({ ...emptyDraft, ...parsed, kind: ['text', 'link', 'media'].includes(parsed.kind ?? '') ? parsed.kind as Draft['kind'] : 'text' });
      } else setDraft(emptyDraft);
    } catch { setDraft(emptyDraft); }
    setError(''); setFiles([]); setUploading(false); setConfirmClose(false);
  }, [open, storageKey]);

  useEffect(() => {
    if (!open || !dirty || typeof window === 'undefined') return;
    try { window.localStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* Draft persistence is best effort. */ }
  }, [open, dirty, storageKey, draft]);

  useEffect(() => () => {
    const current = uploads.current;
    if (current.space && current.files.length) {
      void Promise.allSettled(current.files.map(file => apiData(`/api/spaces/${encodeURIComponent(current.space!.slug)}/uploads/${encodeURIComponent(file.id)}`, { method: 'DELETE' })));
    }
  }, []);

  function requestClose(next: boolean) {
    if (!next && dirty && !busy) { setConfirmClose(true); return; }
    if (next) onOpenChange(true);
    else onOpenChange(false);
  }
  async function removeUnclaimedUploads() {
    if (!space) return;
    await Promise.allSettled(files.map(file => apiData(`/api/spaces/${encodeURIComponent(space.slug)}/uploads/${encodeURIComponent(file.id)}`, { method: 'DELETE' })));
  }
  async function discardAndClose() {
    await removeUnclaimedUploads();
    try { window.localStorage.removeItem(storageKey); } catch { /* ignore */ }
    setDraft(emptyDraft); setFiles([]); setConfirmClose(false); onOpenChange(false);
  }
  function insertMarkup(prefix: string, suffix = '') {
    const input = bodyRef.current;
    if (!input) return;
    const start = input.selectionStart; const end = input.selectionEnd;
    const selected = draft.body.slice(start, end);
    const insertion = `${prefix}${selected || (suffix ? 'text' : '')}${suffix}`;
    const next = `${draft.body.slice(0, start)}${insertion}${draft.body.slice(end)}`;
    setDraft(value => ({ ...value, body: next }));
    requestAnimationFrame(() => { input.focus(); const caret = start + prefix.length + (selected ? selected.length : suffix ? 4 : 0); input.setSelectionRange(caret, selected ? caret : caret); });
  }
  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    if (!space) { setError('Choose a workspace or community where you can post.'); return; }
    if (draft.kind === 'media' && (uploading || !files.length)) { setError(uploading ? 'Wait for uploads to finish.' : 'Add at least one image or video.'); return; }
    const parsed = postCreateSchema.safeParse({
      title: draft.title,
      body: draft.kind === 'link' ? null : draft.body,
      mediaIds: draft.kind === 'media' ? files.map(file => file.id) : [],
      url: draft.kind === 'link' && draft.url.trim() ? draft.url.trim() : null,
    });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the post details.'); return; }
    setBusy(true);
    try {
      const post = await apiData<Post>(`/api/spaces/${encodeURIComponent(space.slug)}/posts`, { method: 'POST', body: JSON.stringify(parsed.data) });
      if (draft.kind !== 'media') await removeUnclaimedUploads();
      try { window.localStorage.removeItem(storageKey); } catch { /* ignore */ }
      setDraft(emptyDraft); setFiles([]); onPublished?.(post); onOpenChange(false);
      toast.success('Post published');
    } catch (cause) { setError(requestError(cause)); }
    finally { setBusy(false); }
  }

  return <Dialog open={open} onOpenChange={requestClose} title="Create a post" description="Share an update, idea, link, or media with a space." className="max-w-2xl">
    {!available.length ? <div className="space-y-3"><p className="text-sm text-white/65">You need member access to a workspace or community before you can publish a post.</p><Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Close</Button></div> : <form className="space-y-4" onSubmit={event => void publish(event)}>
      {available.length > 1 && <label className="block text-sm font-medium">Post to
        <Select className="mt-1 w-full" aria-label="Post to" value={spaceId} onChange={event => setSpaceId(event.target.value)}>
          {available.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>
      </label>}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Post type">
        {([['text', 'Post'], ['link', 'Link'], ['media', 'Attachments']] as const).map(([kind, label]) => <Button key={kind} type="button" disabled={uploading} aria-pressed={draft.kind === kind} variant={draft.kind === kind ? 'primary' : 'secondary'} size="sm" onClick={async () => {
          if (draft.kind === 'media' && kind !== 'media' && files.length) { await removeUnclaimedUploads(); setFiles([]); }
          setDraft(value => ({ ...value, kind }));
        }}>{label}</Button>)}
      </div>
      <label className="block text-sm font-medium">Title
        <Input className="mt-1" value={draft.title} maxLength={300} required autoFocus placeholder="Give your post a clear title" onChange={event => setDraft(value => ({ ...value, title: event.target.value }))} />
        <span className="mt-1 block text-right text-xs text-white/45">{draft.title.length}/300</span>
      </label>
      {draft.kind === 'link' ? <label className="block text-sm font-medium">Link
        <Input type="url" className="mt-1" maxLength={2000} value={draft.url} placeholder="https://example.com" onChange={event => setDraft(value => ({ ...value, url: event.target.value }))} />
      </label> : <div className="text-sm font-medium">Content
        <span role="toolbar" aria-label="Content formatting" className="mt-2 flex flex-wrap gap-1 rounded-t-lg border border-b-0 border-white/10 bg-[var(--surface-2)] p-1">
          {([['Bold', '**', '**'], ['Italic', '*', '*'], ['Underline', '++', '++'], ['Strikethrough', '~~', '~~'], ['Heading', '## ', ''], ['Quote', '> ', ''], ['Bulleted list', '- ', ''], ['Numbered list', '1. ', ''], ['Code block', '```\n', '\n```'], ['Link', '[', '](https://example.com)']] as const).map(([label, prefix, suffix]) => <Button key={label} type="button" variant="ghost" size="sm" aria-label={label} tooltip={label} className="h-8 min-w-8 px-2 text-xs" onClick={() => insertMarkup(prefix, suffix)}>{label === 'Bold' ? <strong>B</strong> : label === 'Italic' ? <em>I</em> : label === 'Underline' ? <u>U</u> : label === 'Strikethrough' ? <s>S</s> : label === 'Code block' ? '</>' : label}</Button>)}
          <Button type="button" variant="ghost" size="sm" aria-label="Insert emoji" tooltip="Insert emoji" className="h-8 min-w-8 px-2" onClick={() => insertMarkup('🙂')}>🙂</Button>
        </span>
        <Textarea ref={bodyRef} aria-label="Content" className="mt-0 min-h-40 resize-y rounded-t-none" maxLength={40000} value={draft.body} placeholder="Add context or start a discussion…" onChange={event => setDraft(value => ({ ...value, body: event.target.value }))} />
        <span className="mt-1 block text-right text-xs text-white/45">{draft.body.length}/40,000</span>
      </div>}
      {draft.kind === 'media' && space && <UploadPicker path={`/api/spaces/${encodeURIComponent(space.slug)}/uploads`} maxFiles={10} onChange={setFiles} onBusy={setUploading} />}
      {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}
      <div className="flex flex-col-reverse justify-end gap-2 border-t border-white/10 pt-3 sm:flex-row">
        <Button type="button" variant="secondary" disabled={busy} onClick={() => requestClose(false)}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy} disabled={busy || uploading || !space || (draft.kind === 'media' && !files.length)}><Icon name="send" size={15} />{busy ? 'Publishing…' : 'Publish post'}</Button>
      </div>
    </form>}
    <AlertDialog open={confirmClose} onOpenChange={setConfirmClose} title="Discard this draft?" description="Your unpublished changes will be removed." confirmLabel="Discard" onConfirm={discardAndClose} />
  </Dialog>;
}
