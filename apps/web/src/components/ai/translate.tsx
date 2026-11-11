'use client';

import { Tooltip as UiTooltip } from '@hive/ui';

import { Button as UiButton, Checkbox as UiCheckbox } from '@hive/ui';

import { useEffect, useState } from 'react';
import { aiPost, setTranslateAll, TRANSLATE_ALL_EVENT, translateAll, translateMessage, useAiStatus } from '../../lib/ai';
import { useAuth } from '../../lib/auth';
import { requestError } from '../../lib/spaces';
import { Icon } from '../ui/icons';

type Shown = { text: string | null; same: boolean };

/** Small "Translate" link under a message (or post or comment) with the translation shown below it. */
export function TranslateLink({ targetType = 'message', targetId, channelId, enabled = true }: {
  targetType?: 'message' | 'post' | 'comment'; targetId: string; channelId?: string; enabled?: boolean;
}) {
  const { user } = useAuth();
  const ai = useAiStatus(!!user?.translate_language);
  const language = user?.translate_language;
  const [shown, setShown] = useState<Shown | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [auto, setAuto] = useState(false);

  useEffect(() => {
    if (!channelId) return;
    const sync = () => setAuto(translateAll(channelId));
    sync();
    window.addEventListener(TRANSLATE_ALL_EVENT, sync);
    return () => window.removeEventListener(TRANSLATE_ALL_EVENT, sync);
  }, [channelId]);

  async function load() {
    if (!language) return;
    setBusy(true); setError('');
    try {
      if (targetType === 'message') {
        const result = await translateMessage(targetId, language);
        setShown({ text: result.translation, same: result.alreadyInLanguage });
      } else {
        const result = await aiPost<{ translation: string | null; alreadyInLanguage: boolean }>('/translate', { targetType, targetId, language });
        setShown({ text: result.translation, same: result.alreadyInLanguage });
      }
      setOpen(true);
    } catch (cause) { setError(requestError(cause)); } finally { setBusy(false); }
  }
  useEffect(() => { if (auto && !shown && !busy && !error && enabled) void load(); }, [auto, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ai || !language || !enabled) return null;
  const name = ai.languages.find(item => item.code === language)?.name ?? language;
  return <div className="mt-0.5 text-xs">
    {!open && <UiButton type="button" onClick={() => shown ? setOpen(true) : void load()} disabled={busy}
      tooltip={`Translate into ${name}`} className="inline-flex items-center gap-1 font-medium text-brand hover:underline">
      <Icon name="translate" size={12} />{busy ? 'Translating…' : 'Translate'}</UiButton>}
    {error && <span role="alert" className="ml-2 text-rose-500">{error}</span>}
    {open && shown && <div className="mt-1 rounded-lg border border-white/10 bg-[var(--surface-2)] px-3 py-2 text-sm">
      {shown.same ? <p className="text-white/60">This is already in {name}.</p>
        : <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{shown.text}</p>}
      <UiButton type="button" onClick={() => setOpen(false)} className="mt-1 text-xs font-medium text-brand hover:underline">Show original</UiButton>
    </div>}
  </div>;
}

/** Header switch: translate every message of this channel as it appears. */
export function TranslateAllToggle({ channelId }: { channelId: string }) {
  const { user } = useAuth();
  const ai = useAiStatus(!!user?.translate_language);
  const [on, setOn] = useState(false);
  useEffect(() => setOn(translateAll(channelId)), [channelId]);
  if (!ai || !user?.translate_language) return null;
  const name = ai.languages.find(item => item.code === user.translate_language)?.name ?? '';
  return <UiTooltip content={`Translate every message here into ${name}`}><label className="flex cursor-pointer items-center gap-1.5 text-sm text-white/70">
    <UiCheckbox checked={on} onChange={event => { setOn(event.target.checked); setTranslateAll(channelId, event.target.checked); }} />
    Translate all</label></UiTooltip>;
}
