'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { spaceRulesSchema } from '@hive/shared';
import { useAuth } from '../../lib/auth';
import { apiData, requestError, type Space } from '../../lib/spaces';
import { Icon } from '../ui/icons';

export type CommunityRule = { id?: string; title: string; description: string };
export function RulesList({ rules }: { rules: CommunityRule[] }) {
  return <ol role="list" className="space-y-3">{rules.map((rule, index) => <li key={rule.id ?? index} className="flex gap-2 text-sm"><span aria-hidden className="shrink-0 text-white/60">{index+1}.</span><details className="min-w-0 flex-1"><summary className="cursor-pointer break-words font-medium">{rule.title}</summary><p className="mt-2 whitespace-pre-wrap break-words text-white/70">{rule.description || 'Follow this rule when taking part.'}</p></details></li>)}</ol>;
}

export function RulesCard({ slug }: { slug: string }) {
  const [rules, setRules] = useState<CommunityRule[] | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const load = async () => {
    const version = ++generation.current;
    try { const data = await apiData<{ rules: CommunityRule[] }>(`/api/spaces/${slug}/rules`); if (version === generation.current) { setRules(data.rules); setError(''); } }
    catch (cause) { if (version === generation.current) setError(requestError(cause)); }
  };
  useEffect(() => { setRules(null); setError(''); void load(); return () => { generation.current++; }; }, [slug]);
  return <section className="mt-6 border-t border-white/10 pt-5"><h2 className="mb-3 font-semibold">Community rules</h2>
    {error ? <p role="alert" className="text-sm">{error} <button type="button" onClick={() => void load()} className="text-brand underline">Retry</button></p>
      : rules === null ? <div role="status" aria-label="Fetching rules" className="h-20 animate-pulse rounded-xl bg-white/5" />
      : rules.length ? <RulesList rules={rules} /> : <p className="flex items-start gap-2 text-sm text-white/60"><Icon name="file" />No extra rules here. Read the <a className="underline" href="/policies/guidelines">Community Guidelines</a>.</p>}
  </section>;
}

export function JoinCommunity({ space, onJoined }: { space: Space; onJoined: (space: Space) => void }) {
  const { user } = useAuth();
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [rules, setRules] = useState<CommunityRule[] | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  async function open() {
    if (!user) { router.push(`/login?next=${encodeURIComponent(`/s/${space.slug}`)}`); return; }
    const version = ++request.current;
    setRules(null); setAgreed(false); setError(''); dialog.current?.showModal();
    try { const result = await apiData<{ rules: CommunityRule[] }>(`/api/spaces/${space.slug}/rules`); if (version === request.current) setRules(result.rules); }
    catch (cause) { if (version === request.current) setError(requestError(cause)); }
  }
  async function join() {
    setBusy(true); setError('');
    try {
      const result = await apiData<Space>(`/api/spaces/${space.slug}/join`, { method: 'POST', body: JSON.stringify({ agreedToRules: agreed }) });
      onJoined(result); window.dispatchEvent(new Event('hive:spaces')); dialog.current?.close();
    } catch (cause) { setError(requestError(cause)); }
    finally { setBusy(false); }
  }
  return <>
    <button type="button" className="auth-button" disabled={busy} onClick={() => void open()}>Join community</button>
    <dialog ref={dialog} onCancel={event => { if (busy) event.preventDefault(); }} aria-labelledby={`join-${space.id}`} className="m-auto max-h-[85dvh] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto rounded-2xl border border-white/10 bg-surface p-5 text-white shadow-xl backdrop:bg-[rgb(0_0_0/0.5)]">
      <h2 id={`join-${space.id}`} className="text-xl font-bold">Join {space.name}</h2><p className="my-4 text-sm text-white/70">Read the community rules before taking part.</p>
      {rules === null && !error && <div role="status" aria-label="Fetching rules" className="h-24 animate-pulse rounded-xl bg-white/5" />}
      {rules && (rules.length ? <><RulesList rules={rules} /><label className="mt-5 flex items-center gap-3"><input type="checkbox" checked={agreed} onChange={event => setAgreed(event.target.checked)} />I agree to these rules</label></> : <p className="text-sm text-white/70">This community follows the <a href="/policies/guidelines" className="text-brand underline">Community Guidelines</a>.</p>)}
      {error && <p role="alert" className="mt-3 text-sm text-rose-500">{error}</p>}
      <div className="mt-5 flex flex-wrap gap-3"><button type="button" className="auth-button" disabled={busy || rules === null || (rules.length > 0 && !agreed)} onClick={() => void join()}>{busy ? 'Joining…' : 'Join community'}</button><button type="button" className="btn-ghost" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button></div>
    </dialog>
  </>;
}

export function RulesEditor({ slug }: { slug: string }) {
  const [rules, setRules] = useState<CommunityRule[] | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setRules(null); setError(''); setSaved(false);
    apiData<{ rules: CommunityRule[] }>(`/api/spaces/${slug}/rules`).then(data => { if (active) setRules(data.rules); }).catch(cause => { if (active) setError(requestError(cause)); });
    return () => { active = false; };
  }, [slug]);
  function update(index: number, patch: Partial<CommunityRule>) { setSaved(false); setRules(values => values!.map((value, i) => i === index ? { ...value, ...patch } : value)); }
  function move(index: number, offset: number) { const next = [...rules!]; [next[index], next[index+offset]] = [next[index+offset], next[index]]; setRules(next); setSaved(false); }
  return <section className="card space-y-4 p-5"><h2 className="text-xl font-semibold">Community rules</h2>
    <p className="text-sm text-white/60">New members agree before joining. Existing members keep their access.</p>
    {rules === null ? !error && <div role="status" aria-label="Fetching rules" className="h-20 animate-pulse rounded-xl bg-white/5" /> : <>
      <p className="text-sm text-white/60">{rules.length} of 15</p>
      {rules.map((rule, index) => <fieldset key={rule.id ?? index} disabled={busy} className="space-y-2 rounded-xl border border-white/10 p-3"><legend className="px-1 text-sm">Rule {index+1}</legend>
        <label className="block text-sm">Title<input className="auth-input" value={rule.title} required maxLength={80} onChange={event => update(index, { title: event.target.value })} /></label>
        <label className="block text-sm">Description<textarea className="auth-input" value={rule.description} maxLength={500} onChange={event => update(index, { description: event.target.value })} /></label>
        <div className="flex flex-wrap gap-2"><button type="button" className="btn-ghost" title={`Move rule ${index+1} up`} aria-label={`Move rule ${index+1} up`} disabled={!index} onClick={() => move(index, -1)}>Move up</button><button type="button" className="btn-ghost" title={`Move rule ${index+1} down`} aria-label={`Move rule ${index+1} down`} disabled={index === rules.length-1} onClick={() => move(index, 1)}>Move down</button><button type="button" className="btn-ghost" onClick={() => { setRules(rules.filter((_, i) => i !== index)); setSaved(false); }}>Remove</button></div>
      </fieldset>)}
      {!rules.length && <p className="flex items-center gap-2 text-sm text-white/60"><Icon name="file" />Add a rule to help people feel welcome.</p>}
      <div className="flex flex-wrap items-center gap-3"><button type="button" className="btn-ghost" disabled={rules.length >= 15 || busy} onClick={() => { setRules([...rules, { id: crypto.randomUUID(), title: '', description: '' }]); setSaved(false); }}>Add rule</button>
        <button type="button" className="auth-button" disabled={busy} onClick={async () => {
          const parsed = spaceRulesSchema.safeParse({ rules });
          if (!parsed.success) { setError(parsed.error.issues[0].message); return; }
          setBusy(true); setError(''); setSaved(false);
          try { setRules((await apiData<{ rules: CommunityRule[] }>(`/api/spaces/${slug}/rules`, { method: 'PUT', body: JSON.stringify(parsed.data) })).rules); setSaved(true); }
          catch (cause) { setError(requestError(cause)); } finally { setBusy(false); }
        }}>Save rules</button>{saved && <span role="status" className="text-sm text-brand">Rules saved</span>}</div>
    </>}{error && <p role="alert" className="text-sm text-rose-500">{error}</p>}
  </section>;
}
