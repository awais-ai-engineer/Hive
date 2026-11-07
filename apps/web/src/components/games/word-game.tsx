'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LetterState, WordState } from '@hive/shared';
import { requestError } from '../../lib/spaces';
import { gamesPath, post } from '../../lib/games';
import { apiData } from '../../lib/spaces';

const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const COLOURS: Record<LetterState, string> = { correct: '#16a34a', present: '#d97706', absent: '#6b7280' };
const MARKS: Record<LetterState, string> = { correct: '✓', present: '~', absent: '' };
const LABELS: Record<LetterState, string> = { correct: 'right place', present: 'wrong place', absent: 'not in the word' };

function Tile({ letter, state }: { letter: string; state?: LetterState }) {
  const style = state ? { background: COLOURS[state], borderColor: COLOURS[state], color: '#fff' } : undefined;
  return <div role="img" aria-label={letter ? `${letter.toUpperCase()}, ${state ? LABELS[state] : 'not checked yet'}` : 'empty'}
    style={style} className={`relative flex aspect-square items-center justify-center rounded-lg border-2 text-2xl font-bold uppercase ${state ? '' : letter ? 'border-white/40' : 'border-white/15'}`}>
    {letter}{state && <span aria-hidden className="absolute right-1 top-0.5 text-[10px] opacity-90">{MARKS[state]}</span>}
  </div>;
}

/** Daily Word: six tries to find today's five-letter word, same puzzle for the whole community. */
export function WordGame({ slug, onFinished }: { slug: string; onFinished: () => void }) {
  const [state, setState] = useState<WordState | null>(null);
  const [typed, setTyped] = useState('');
  const [message, setMessage] = useState('');
  const [shake, setShake] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const typedRef = useRef(typed); typedRef.current = typed;

  useEffect(() => {
    apiData<WordState>(gamesPath(slug, '/word/today')).then(setState).catch(cause => setMessage(requestError(cause)));
  }, [slug]);

  const submit = useCallback(async () => {
    if (!state || state.status !== 'playing' || busy) return;
    if (typedRef.current.length !== 5) { setMessage('Type a five-letter word first.'); setShake(true); return; }
    setBusy(true); setMessage('');
    try {
      const next = await post<WordState>(gamesPath(slug, '/word/guess'), { guess: typedRef.current });
      setState(next); setTyped('');
      if (next.status !== 'playing') onFinished();
    } catch (cause) { setMessage(requestError(cause)); setShake(true); } finally { setBusy(false); }
  }, [state, busy, slug, onFinished]);

  const press = useCallback((key: string) => {
    if (!state || state.status !== 'playing') return;
    setMessage('');
    if (key === 'enter') void submit();
    else if (key === 'backspace') setTyped(value => value.slice(0, -1));
    else if (/^[a-z]$/.test(key)) setTyped(value => value.length < 5 ? value + key : value);
  }, [state, submit]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const key = event.key.toLowerCase();
      if (key === 'enter' && target.tagName === 'BUTTON') return;
      if (key === 'enter' || key === 'backspace' || /^[a-z]$/.test(key)) { event.preventDefault(); press(key); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press]);

  if (!state) return message ? <p role="alert" className="text-rose-500">{message}</p>
    : <div aria-busy="true" className="mx-auto grid w-72 grid-cols-5 gap-1.5">{Array.from({ length: 30 }, (_, index) => <div key={index} className="aspect-square animate-pulse rounded-lg bg-white/10" />)}</div>;

  const best: Record<string, LetterState> = {};
  for (const row of state.guesses) for (const cell of row) {
    const rank = { absent: 0, present: 1, correct: 2 };
    if (!best[cell.letter] || rank[cell.state] > rank[best[cell.letter]]) best[cell.letter] = cell.state;
  }
  const rows = Array.from({ length: state.maxGuesses }, (_, index) => {
    if (state.guesses[index]) return state.guesses[index];
    if (index === state.guesses.length && state.status === 'playing') return Array.from({ length: 5 }, (_, i) => ({ letter: typed[i] ?? '', state: undefined }));
    return Array.from({ length: 5 }, () => ({ letter: '', state: undefined }));
  });
  async function copy() {
    try { await navigator.clipboard.writeText(state?.share ?? ''); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { setMessage('Copying is blocked in this browser. Select the result and copy it by hand.'); }
  }
  return <div className="mx-auto max-w-sm">
    <div role="group" aria-label="Guesses" className={`mx-auto grid w-72 max-w-full gap-1.5 ${shake ? 'animate-[shake_0.4s]' : ''}`} onAnimationEnd={() => setShake(false)}>
      {rows.map((row, index) => <div key={index} className="grid grid-cols-5 gap-1.5">{row.map((cell, i) => <Tile key={i} letter={cell.letter} state={cell.state} />)}</div>)}
    </div>
    <p role="status" aria-live="polite" className="mt-3 min-h-6 text-center text-sm text-rose-500">{message}</p>
    {state.status === 'playing' ? <div className="mt-2 space-y-1.5" aria-label="Keyboard">
      {ROWS.map((letters, index) => <div key={letters} className="flex justify-center gap-1">
        {index === 2 && <button type="button" onClick={() => press('enter')} className="btn-ghost px-2 text-xs font-semibold" aria-label="Enter">Enter</button>}
        {[...letters].map(letter => <button key={letter} type="button" onClick={() => press(letter)} aria-label={best[letter] ? `${letter}, ${LABELS[best[letter]]}` : letter}
          style={best[letter] ? { background: COLOURS[best[letter]], color: '#fff' } : undefined}
          className="h-11 w-8 rounded-md border border-white/15 text-sm font-semibold uppercase hover:bg-[var(--surface-2)] sm:w-9">{letter}</button>)}
        {index === 2 && <button type="button" onClick={() => press('backspace')} className="btn-ghost px-2 text-xs font-semibold" aria-label="Delete last letter">Delete</button>}
      </div>)}
    </div> : <section className="card mt-3 p-4 text-center">
      <h3 className="text-lg font-bold">{state.status === 'won' ? `You got it in ${state.guesses.length}!` : 'Not this time'}</h3>
      <p className="mt-1 text-sm text-white/65">{state.status === 'won' ? `You earned ${state.points} ${state.points === 1 ? 'point' : 'points'}.` : <>The word was <strong className="uppercase">{state.answer}</strong>.</>} A new word arrives tomorrow.</p>
      <button type="button" onClick={() => void copy()} className="auth-button mt-3 !w-auto px-5">{copied ? 'Copied' : 'Copy result'}</button>
    </section>}
  </div>;
}
