'use client';

import { useEffect, useState } from 'react';
import { InterestPicker } from '../interest-picker';
import { apiData, requestError } from '../../lib/spaces';

export function InterestsSettings() {
  const [value, setValue] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { apiData<{ categories: string[] }>('/api/me/interests').then(data => setValue(data.categories)).catch(cause => setError(requestError(cause))); }, []);
  return <section className="card space-y-4 p-5 sm:p-6"><h2 className="text-xl font-bold">Interests</h2><p className="text-sm text-white/65">Pick what you like and we will suggest communities.</p>
    {value === null ? !error && <div role="status" aria-label="Fetching interests" className="h-48 animate-pulse rounded-xl bg-white/5" /> : <><fieldset disabled={busy}><legend className="sr-only">Choose your interests</legend><InterestPicker value={value} onChange={next => { setValue(next); setSaved(false); }} /></fieldset><button type="button" disabled={busy} className="auth-button" onClick={async () => {
      setBusy(true); setError(''); setSaved(false);
      try { setValue((await apiData<{ categories: string[] }>('/api/me/interests', { method: 'PUT', body: JSON.stringify({ categories: value }) })).categories); setSaved(true); }
      catch (cause) { setError(requestError(cause)); } finally { setBusy(false); }
    }}>Save interests</button></>}{saved && <p role="status" className="text-sm text-brand">Interests saved</p>}{error && <p role="alert" className="text-sm text-rose-500">{error}</p>}
  </section>;
}
