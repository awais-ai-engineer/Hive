'use client';

import { useEffect, useState } from 'react';
import type { Attachment } from '@hive/shared';
import { API_URL, apiFetch, responseData } from '../lib/api';
import { requestError } from '../lib/spaces';
import { Icon } from './ui/icons';

type Opened = { url: string; kind: 'image' | 'video'; expiresIn: number };

/**
 * A photo or video that each recipient can open exactly once. Until then only a blurred card is
 * shown; the file has no address, no download link and no save button.
 */
export function ViewOnce({ file, own }: { file: Attachment; own: boolean }) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const noun = file.kind === 'video' ? 'Video' : 'Photo';
  const seen = file.viewState === 'opened';

  useEffect(() => {
    if (!opened) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpened(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [opened]);

  async function open() {
    setBusy(true); setError('');
    try {
      setOpened(await responseData<Opened>(await apiFetch(`/api/attachments/${file.id}/view-once`, { method: 'POST' })));
    } catch (cause) { setError(requestError(cause)); }
    finally { setBusy(false); }
  }

  const card = 'relative flex h-36 w-52 max-w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border border-white/10 bg-[var(--surface-2)] text-center';
  const blur = <span aria-hidden className="absolute inset-0 bg-gradient-to-br from-brand/30 via-brand-soft to-brand/10 blur-xl" />;
  return <div>
    {own ? <div className={card}>{blur}
      <span className="relative flex items-center gap-1.5 text-sm font-semibold"><Icon name="image" size={16} />{noun} · view once</span>
      <span className="relative text-xs text-white/60" role="status">{seen ? 'Opened' : 'Not opened yet'}</span>
    </div>
      : seen ? <div className={card}>
        <span className="flex items-center gap-1.5 text-sm font-semibold text-white/60"><Icon name="image" size={16} />{noun} · opened</span>
        <span className="px-3 text-xs text-white/50">You already viewed this. It can&apos;t be shown again.</span>
      </div>
        : <button type="button" onClick={() => void open()} disabled={busy} className={`${card} hover:border-brand`} aria-label={`Open ${noun.toLowerCase()}, view once`}>{blur}
          <span className="relative flex items-center gap-1.5 text-sm font-semibold"><Icon name="image" size={16} />{noun} · view once</span>
          <span className="relative px-3 text-xs text-white/70">{busy ? 'Opening…' : 'Tap to open. You can only see it once.'}</span>
        </button>}
    {error && <p role="alert" className="mt-1 max-w-52 text-xs text-rose-500">{error}</p>}
    {opened && <div role="dialog" aria-modal="true" aria-label={`${noun}, view once`} className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[rgb(0_0_0/0.92)] p-4" onContextMenu={event => event.preventDefault()}>
      <p className="mb-3 text-sm" style={{ color: '#fff' }}>View once: this closes for good when you leave it.</p>
      {opened.kind === 'video'
        ? <video src={opened.url.startsWith('/') ? `${API_URL}${opened.url}` : opened.url} autoPlay playsInline controls controlsList="nodownload noremoteplayback" disablePictureInPicture className="max-h-[80vh] max-w-full rounded-xl" />
        : <img src={opened.url.startsWith('/') ? `${API_URL}${opened.url}` : opened.url} alt="" draggable={false} className="max-h-[80vh] max-w-full select-none rounded-xl" />}
      <button type="button" autoFocus onClick={() => setOpened(null)} className="auth-button mt-4">Close</button>
    </div>}
  </div>;
}
