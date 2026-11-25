'use client';
import { Button, Checkbox, Input } from '@hive/ui';
import { useEffect, useState } from 'react';
import { apiData, requestError } from '../lib/spaces';
import { defaultSoundPreferences, normalizeSoundPreferences, previewSound, saveSounds, soundCategories, soundEvents, soundPreferences, type SoundCategory, type SoundEvent, type SoundPreferences } from '../lib/sounds';

export function SoundSettings() {
  const [value, setValue] = useState(soundPreferences);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; void apiData<SoundPreferences>('/api/me/sounds').then(data => { if (active) setValue(normalizeSoundPreferences(data)); }).catch(cause => { if (active) setError(requestError(cause)); }); return () => { active = false; }; }, []);
  const update = (patch: Partial<SoundPreferences>) => { setValue(current => ({ ...current, ...patch })); setSaved(false); };
  async function save() {
    setBusy(true); setError(''); setSaved(false);
    try { await saveSounds(value); setSaved(true); } catch (cause) { setError(requestError(cause)); }
    finally { setBusy(false); }
  }
  return <section aria-labelledby="sound-settings-title" className="space-y-5">
    <div><h2 id="sound-settings-title" className="text-lg font-bold">Sounds &amp; Notifications</h2><p className="mt-1 text-sm text-white/60">A quieter workspace, with distinct cues for the moments that matter.</p></div>
    {error && <p role="alert" className="text-rose-500">{error}</p>}{saved && <p role="status" className="text-sm text-brand">Sound preferences saved</p>}
    <label className="flex items-center justify-between gap-3 text-sm font-medium">Enable optional sounds<Checkbox checked={value.enabled} onChange={event => update({ enabled: event.target.checked })} /></label>
    <label className="flex flex-wrap items-center gap-3 text-sm">Volume<Input aria-label="Notification volume" type="range" className="min-w-24 flex-1" min="0" max="1" step="0.05" value={value.volume} onChange={event => update({ volume: Number(event.target.value) })} /><span className="w-10 text-right tabular-nums">{Math.round(value.volume * 100)}%</span></label>
    <p className="text-xs text-white/60">Do Not Disturb, Quiet Hours, muted conversations, and availability settings silence optional sounds. Privacy disclosures remain audible at a minimum volume and are also shown in your Huddle.</p>
    {(Object.entries(soundCategories) as [SoundCategory, string][]).map(([category, label]) => <details key={category} className="border-t border-white/10 py-3">
      <summary className="cursor-pointer text-sm font-semibold">{label}</summary>
      <div className="mt-3 space-y-2">
        <label className="flex items-center justify-between gap-3 text-sm">Enable {label.toLowerCase()}<Checkbox checked={value[category]} onChange={event => update({ [category]: event.target.checked })} /></label>
        {category === 'announcements' && <p className="text-xs text-white/60">This switch controls optional announcements. Required transcription and recording disclosures always play. Recording and AI notes previews demonstrate wording; they only play in a meeting when that feature actually exists and is active.</p>}
        {(Object.keys(soundEvents) as SoundEvent[]).filter(event => soundEvents[event].category === category).map(event => <div key={event} className="flex items-center gap-3 py-1">
          <label className="flex min-w-0 flex-1 items-center gap-3 text-sm"><Checkbox checked={value.events[event] !== false} onChange={change => update({ events: { ...value.events, [event]: change.target.checked } })} /><span>{soundEvents[event].label}</span></label>
          <Button type="button" className="btn-ghost shrink-0 !px-2 !py-1 text-xs" aria-label={`Preview ${soundEvents[event].label}`} onClick={() => previewSound(event, value.volume)}>Preview</Button>
        </div>)}
      </div>
    </details>)}
    <div className="flex flex-wrap gap-3"><Button type="button" disabled={busy} className="auth-button" onClick={() => void save()}>Save sound preferences</Button><Button type="button" className="btn-ghost" onClick={() => { setValue(normalizeSoundPreferences(defaultSoundPreferences)); setSaved(false); }}>Reset to defaults</Button></div>
  </section>;
}
