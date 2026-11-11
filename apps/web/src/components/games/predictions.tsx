'use client';

import { Button as UiButton, Input as UiInput, DateTimePicker as UiDateTimePicker } from '@hive/ui';

import { useCallback, useEffect, useState } from 'react';
import { gamesPath, post, type PredictionItem } from '../../lib/games';
import { apiData, requestError } from '../../lib/spaces';
import { Icon } from '../ui/icons';

function localInput(hours: number) {
  const date = new Date(Date.now() + hours * 3600000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

export function Predictions({ slug, canManage, onScored }: { slug: string; canManage: boolean; onScored: () => void }) {
  const [items, setItems] = useState<PredictionItem[] | null>(null);
  const [error, setError] = useState('');
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [closes, setCloses] = useState(localInput(24));
  const base = gamesPath(slug, '/predictions');
  const load = useCallback(() => apiData<PredictionItem[]>(base).then(setItems).catch(cause => setError(requestError(cause))), [base]);
  useEffect(() => { void load(); }, [load]);
  async function run(task: () => Promise<unknown>, scored = false) {
    setError('');
    try { await task(); await load(); if (scored) onScored(); } catch (cause) { setError(requestError(cause)); }
  }
  return <div className="space-y-4">
    {error && <p role="alert" className="text-sm text-rose-500">{error}</p>}
    {!items ? <div aria-busy="true" className="h-24 animate-pulse rounded-2xl bg-white/5" />
      : !items.length ? <div className="card p-6 text-center"><Icon name="trending" size={28} className="mx-auto text-brand" />
        <p className="mt-2 font-medium">No predictions yet</p><p className="text-sm text-white/60">{canManage ? 'Ask the community a question below.' : 'When an admin asks a question, you can vote here.'}</p></div>
      : <ul className="space-y-3">{items.map(item => <li key={item.id} className="card p-4">
        <p className="font-semibold [overflow-wrap:anywhere]">{item.question}</p>
        <p className="text-xs text-white/55">{item.status === 'open' ? (item.votingOpen ? `Voting closes ${new Date(item.closesAt).toLocaleString()}` : 'Voting has closed') : item.status === 'resolved' ? 'Settled' : 'Canceled'} · {item.points} points for a correct vote</p>
        <ul className="mt-2 space-y-1.5">{item.options.map(option => {
          const mine = item.myOptionId === option.id, won = item.resolvedOptionId === option.id;
          return <li key={option.id}><UiButton type="button" disabled={!item.votingOpen} onClick={() => void run(() => post(`${base}/${item.id}/vote`, { optionId: option.id }))} aria-pressed={mine}
            className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left justify-start text-sm transition disabled:cursor-default ${mine ? 'border-brand bg-brand-soft' : 'border-white/15 hover:bg-[var(--surface-2)]'}`}>
            <span>{option.label}{mine && <span className="ml-2 text-xs text-brand">Your vote</span>}{won && <span className="ml-2 text-xs text-emerald-600">Winner</span>}</span>
            <span className="text-xs text-white/55">{option.votes} {option.votes === 1 ? 'vote' : 'votes'}</span></UiButton></li>;
        })}</ul>
        {canManage && item.status === 'open' && <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/10 pt-3 text-sm">
          <span className="text-white/60">Settle it:</span>
          {item.options.map(option => <UiButton key={option.id} type="button" className="btn-ghost" onClick={() => { if (confirm(`Award points to everyone who voted "${option.label}"?`)) void run(() => post(`${base}/${item.id}/resolve`, { optionId: option.id }), true); }}>{option.label} won</UiButton>)}
          <UiButton type="button" className="btn-ghost" onClick={() => { if (confirm('Cancel this prediction? Nobody gets points.')) void run(() => post(`${base}/${item.id}/cancel`)); }}>Cancel</UiButton></div>}
      </li>)}</ul>}
    {canManage && <form className="card space-y-2 p-4" onSubmit={event => { event.preventDefault();
      void run(async () => { await post(base, { question, options, closesAt: new Date(closes).toISOString(), points: 10 }); setQuestion(''); setOptions(['', '']); }); }}>
      <h3 className="font-semibold">Ask a prediction question</h3>
      <label className="block text-sm font-medium">Question<UiInput className="auth-input" required maxLength={200} value={question} onChange={event => setQuestion(event.target.value)} placeholder="Who will win on Saturday?" /></label>
      {options.map((option, i) => <UiInput key={i} className="auth-input" required maxLength={80} aria-label={`Option ${i + 1}`} placeholder={`Option ${i + 1}`} value={option}
        onChange={event => setOptions(list => list.map((item, j) => j === i ? event.target.value : item))} />)}
      <div className="flex flex-wrap items-end gap-2">
        {options.length < 6 && <UiButton type="button" className="btn-ghost" onClick={() => setOptions(list => [...list, ''])}>Add option</UiButton>}
        <label className="text-sm font-medium">Voting closes<UiDateTimePicker label="Voting closes" className="auth-input" required value={closes} onChange={event => setCloses(event.target.value)} /></label>
        <UiButton className="auth-button !w-auto px-4">Create</UiButton></div>
    </form>}
  </div>;
}
