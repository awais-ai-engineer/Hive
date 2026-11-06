'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { docHref, docsApi, makeBlock, timeAgo, type Block, type Doc, type DocUpdate } from '../../lib/docs';
import { socket, chatRequest } from '../../lib/socket';
import { requestError } from '../../lib/spaces';
import { Icon } from '../ui/icons';
import { BlockEditor } from './block-editor';
import { DocHistory } from './doc-history';

const EMOJI = ['📝', '📌', '💡', '🎯', '🚀', '📅', '✅', '📚', '🧠', '🔥', '🛠️', '🎨'];
const SAVE_DELAY = 800;
type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

/** One doc: title, blocks, autosave with a version check, live updates, history and sharing. */
export function DocEditor({ docId, channelId, slug, userId, canWrite, onBack, onGone }: {
  docId: string; channelId: string; slug?: string | null; userId: string; canWrite: boolean; onBack: () => void; onGone: () => void;
}) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [title, setTitle] = useState('');
  const [emoji, setEmoji] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [state, setState] = useState<SaveState>('saved');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Doc | null>(null);
  const [editor, setEditor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [history, setHistory] = useState(false);
  const [picker, setPicker] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [, setTick] = useState(0);

  const version = useRef(0);
  const dirty = useRef(false);
  const saving = useRef(false);
  const edits = useRef(0);
  const conflicted = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ title, emoji, blocks });
  latest.current = { title, emoji, blocks };

  const apply = useCallback((next: Doc) => {
    version.current = next.version;
    dirty.current = false;
    conflicted.current = false;
    setConflict(null);
    setDoc(next); setTitle(next.title); setEmoji(next.emoji);
    setBlocks(next.body.length ? next.body : [makeBlock()]);
    setSavedAt(next.updated_at); setState('saved'); setError('');
  }, []);

  const save = useCallback(async () => {
    if (saving.current || !dirty.current || conflicted.current) return;
    saving.current = true;
    setState('saving');
    const mark = edits.current;
    const { title: nextTitle, emoji: nextEmoji, blocks: nextBlocks } = latest.current;
    let again = false;
    try {
      const result = await docsApi.save(docId, {
        base_version: version.current, title: nextTitle, body: nextBlocks, ...(nextEmoji ? { emoji: nextEmoji } : { clear_emoji: true }),
      });
      if ('conflict' in result) { conflicted.current = true; setConflict(result.conflict); setState('error'); return; }
      version.current = result.doc.version;
      setSavedAt(result.doc.updated_at); setError('');
      if (edits.current === mark) { dirty.current = false; setState('saved'); } else again = true;
    } catch (cause) {
      setError(requestError(cause)); setState('error');
      timer.current = setTimeout(() => void save(), 5000);
    } finally { saving.current = false; }
    if (again) void save();
  }, [docId]);

  const touch = useCallback(() => {
    dirty.current = true; edits.current += 1;
    setState(current => current === 'saving' ? current : 'dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_DELAY);
  }, [save]);

  useEffect(() => {
    let active = true;
    docsApi.get(docId).then(next => { if (active) apply(next); })
      .catch(cause => { if (active) { setError(requestError(cause)); } });
    return () => { active = false; };
  }, [docId, apply]);

  // Live updates: refresh quietly when nobody here has unsaved changes.
  useEffect(() => {
    const onUpdate = (data: DocUpdate) => {
      if (data.docId !== docId) return;
      if (data.action === 'deleted') { onGone(); return; }
      if (data.updatedBy.id !== userId) {
        setEditor(data.updatedBy.username);
        if (editorTimer.current) clearTimeout(editorTimer.current);
        editorTimer.current = setTimeout(() => setEditor(null), 8000);
      }
      if (data.version !== null && data.version <= version.current) return;
      if (!dirty.current && !saving.current) docsApi.get(docId).then(apply).catch(() => {});
    };
    socket.on('doc:updated', onUpdate);
    return () => { socket.off('doc:updated', onUpdate); if (editorTimer.current) clearTimeout(editorTimer.current); };
  }, [docId, userId, apply, onGone]);

  // Save what is pending when leaving, and warn before closing the tab with unsaved changes.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty.current) event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    const clock = setInterval(() => setTick(value => value + 1), 20000);
    return () => {
      window.removeEventListener('beforeunload', warn);
      clearInterval(clock);
      if (timer.current) clearTimeout(timer.current);
      if (dirty.current) void save();
    };
  }, [save]);

  function edit<T>(setter: (value: T) => void) {
    return (value: T) => { setter(value); touch(); };
  }
  const setTitleEdited = edit(setTitle);
  const setEmojiEdited = edit(setEmoji);
  const setBlocksEdited = edit(setBlocks);

  async function share() {
    const url = `${window.location.origin}${docHref(channelId, docId, slug)}`;
    try {
      await chatRequest('message:send', { channelId, body: `📄 ${title || 'Untitled'} — ${url}`, clientMsgId: crypto.randomUUID() });
      setNotice('Shared in the chat.');
    } catch (cause) { setError(requestError(cause)); }
    setTimeout(() => setNotice(''), 3000);
  }
  async function remove() {
    try { await docsApi.remove(docId); onGone(); } catch (cause) { setError(requestError(cause)); setConfirming(false); }
  }
  function keepMine() {
    if (!conflict) return;
    version.current = conflict.version; conflicted.current = false; setConflict(null);
    dirty.current = true; void save();
  }

  if (!doc) return <div className="flex flex-1 items-center justify-center p-8">
    {error ? <div className="text-center"><p role="alert" className="mb-3 text-rose-500">{error}</p><button type="button" onClick={onBack} className="btn-ghost">Back to docs</button></div>
      : <p className="text-white/55">Loading doc…</p>}
  </div>;

  const status = state === 'saving' ? 'Saving…' : state === 'dirty' ? 'Unsaved changes' : state === 'error' ? 'Not saved' : savedAt ? `Saved · ${timeAgo(savedAt)}` : 'Saved';
  const button = 'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-white/70 hover:bg-[var(--surface-2)] hover:text-white';

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <button type="button" onClick={onBack} className={button}><Icon name="chevronRight" size={16} className="rotate-180" />All docs</button>
      <span role="status" aria-live="polite" className={`text-xs ${state === 'error' ? 'text-rose-500' : 'text-white/55'}`}>{canWrite ? status : 'View only'}</span>
      {editor && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-xs font-medium text-brand">{editor} is editing</span>}
      <span className="flex-1" />
      {notice && <span role="status" className="text-xs text-emerald-600">{notice}</span>}
      <button type="button" onClick={() => setHistory(true)} className={button}><Icon name="clock" size={16} />History</button>
      {canWrite && <button type="button" onClick={() => void share()} className={button}><Icon name="share" size={16} />Share in chat</button>}
      {canWrite && (confirming
        ? <span className="flex items-center gap-1 text-sm">Delete this doc?
          <button type="button" onClick={() => void remove()} className="rounded-lg bg-rose-600 px-2.5 py-1 font-medium" style={{ color: '#fff' }}>Delete</button>
          <button type="button" onClick={() => setConfirming(false)} className="btn-ghost !py-1">Keep</button></span>
        : <button type="button" onClick={() => setConfirming(true)} className={button}><Icon name="trash" size={16} />Delete</button>)}
    </div>
    {conflict && <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/40 bg-brand-soft p-3 text-sm">
      <span className="min-w-0 flex-1">Someone else edited this doc ({conflict.updated_by?.username ?? 'another person'}, {timeAgo(conflict.updated_at)}). Reload to see their version, or keep yours and overwrite theirs.</span>
      <button type="button" onClick={() => apply(conflict)} className="btn-ghost">Reload</button>
      <button type="button" onClick={keepMine} className="auth-button !mt-0 !px-4 !py-1.5">Keep mine (overwrite)</button>
    </div>}
    {error && !conflict && <p role="alert" className="mb-3 text-sm text-rose-500">{error}</p>}
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl pb-24">
        <div className="relative mb-4 flex items-start gap-2">
          <button type="button" disabled={!canWrite} aria-label="Choose an emoji" aria-expanded={picker} onClick={() => setPicker(open => !open)}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-3xl hover:bg-[var(--surface-2)] disabled:hover:bg-transparent">{emoji ?? <Icon name="smile" size={26} className="text-white/35" />}</button>
          <input aria-label="Doc title" value={title} readOnly={!canWrite} maxLength={200} placeholder="Untitled"
            onChange={event => setTitleEdited(event.target.value)}
            className="min-w-0 flex-1 border-0 bg-transparent py-1 text-3xl font-bold outline-none placeholder:text-white/30" />
          {picker && canWrite && <div className="on-surface absolute left-0 top-14 z-20 flex w-72 max-w-[85vw] flex-wrap gap-1 rounded-xl border border-white/10 bg-surface p-2 shadow-[var(--shadow-pop)]">
            {EMOJI.map(item => <button key={item} type="button" onClick={() => { setEmojiEdited(item); setPicker(false); }} className="h-9 w-9 rounded-lg text-xl hover:bg-[var(--surface-2)]">{item}</button>)}
            <button type="button" onClick={() => { setEmojiEdited(null); setPicker(false); }} className="btn-ghost !py-1 text-sm">No emoji</button>
          </div>}
        </div>
        <BlockEditor blocks={blocks} onChange={setBlocksEdited} readOnly={!canWrite} />
      </div>
    </div>
    {history && <DocHistory docId={docId} canWrite={canWrite} currentVersion={version.current}
      onRestored={apply} onClose={() => setHistory(false)} />}
  </div>;
}
