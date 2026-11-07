'use client';

import { useCallback, useEffect, useState } from 'react';
import { gamesPath, post, type QuizAdmin, type QuizResult, type QuizStart, type QuizSummary } from '../../lib/games';
import { apiData, requestError } from '../../lib/spaces';
import { Icon } from '../ui/icons';

function Ring({ left, total }: { left: number; total: number }) {
  const radius = 22, length = 2 * Math.PI * radius;
  return <div role="timer" aria-label={`${Math.ceil(left)} seconds left`} className="relative h-14 w-14 shrink-0">
    <svg viewBox="0 0 52 52" className="h-14 w-14 -rotate-90"><circle cx="26" cy="26" r={radius} fill="none" strokeWidth="5" stroke="currentColor" className="text-white/15" />
      <circle cx="26" cy="26" r={radius} fill="none" strokeWidth="5" strokeLinecap="round" stroke="currentColor" className={left <= 5 ? 'text-rose-500' : 'text-brand'}
        strokeDasharray={length} strokeDashoffset={length * (1 - Math.max(0, left) / total)} /></svg>
    <span className="absolute inset-0 flex items-center justify-center text-sm font-bold">{Math.ceil(left)}</span>
  </div>;
}

function Play({ slug, quiz, onDone }: { slug: string; quiz: QuizSummary; onDone: () => void }) {
  const [run, setRun] = useState<QuizStart | null>(null);
  const [index, setIndex] = useState(0);
  const [chosen, setChosen] = useState<number | null>(null);
  const [left, setLeft] = useState(quiz.timeLimitS);
  const [result, setResult] = useState<QuizResult | null>(null);
  const [error, setError] = useState('');
  const base = gamesPath(slug, `/quizzes/${quiz.id}`);

  useEffect(() => {
    post<QuizStart>(`${base}/start`).then(started => {
      setRun(started);
      const done = started.answeredIds.length;
      if (done >= started.questions.length) void finish(); else setIndex(done);
    }).catch(cause => setError(requestError(cause)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function finish() {
    try { setResult(await post<QuizResult>(`${base}/finish`)); onDone(); } catch (cause) { setError(requestError(cause)); }
  }
  const answer = useCallback(async (choice: number | null) => {
    if (!run || chosen !== null && choice !== null) return;
    setChosen(choice ?? -1);
    try {
      await post(`${base}/answer`, { questionId: run.questions[index].id, choice });
      setTimeout(() => {
        setChosen(null);
        if (index + 1 >= run.questions.length) void finish(); else { setIndex(index + 1); setLeft(run.timeLimitS); }
      }, 500);
    } catch (cause) { setError(requestError(cause)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, index, chosen]);

  useEffect(() => {
    if (!run || result || chosen !== null) return;
    if (left <= 0) { void answer(null); return; }
    const timer = setTimeout(() => setLeft(value => value - 0.25), 250);
    return () => clearTimeout(timer);
  }, [run, left, result, chosen, answer]);

  if (error) return <p role="alert" className="text-rose-500">{error} <button className="underline" onClick={onDone}>Back</button></p>;
  if (result) return <section className="card p-5 text-center" aria-live="polite">
    <h3 className="text-2xl font-extrabold">{result.score} points</h3>
    <p className="mt-1 text-white/65">{result.correctCount} of {result.total} correct</p>
    <ol className="mt-4 space-y-2 text-left text-sm">{result.results.map(item => <li key={item.id} className="rounded-xl border border-white/10 p-3">
      <p className="font-medium">{item.text}</p>
      <p className={item.correct ? 'text-emerald-600' : 'text-rose-500'}>{item.correct ? 'Correct: ' : `You said ${item.choice === null ? 'nothing (out of time)' : item.options[item.choice]}. Answer: `}{item.correct ? item.options[item.correctIndex!] : item.options[item.correctIndex!]}</p>
    </li>)}</ol>
    <button type="button" className="auth-button mt-4 !w-auto px-5" onClick={onDone}>Back to quizzes</button>
  </section>;
  if (!run) return <div aria-busy="true" className="h-48 animate-pulse rounded-2xl bg-white/5" />;
  const question = run.questions[index];
  return <section className="card p-5" aria-live="polite">
    <div className="mb-4 flex items-center justify-between gap-3"><p className="text-sm text-white/60">Question {index + 1} of {run.questions.length}</p><Ring left={left} total={run.timeLimitS} /></div>
    <h3 className="mb-4 text-xl font-bold [overflow-wrap:anywhere]">{question.text}</h3>
    <div className="grid gap-2 sm:grid-cols-2">{question.options.map((option, choice) => <button key={choice} type="button" disabled={chosen !== null} onClick={() => void answer(choice)}
      className={`min-h-14 rounded-xl border px-4 py-3 text-left font-medium transition [overflow-wrap:anywhere] ${chosen === choice ? 'border-brand bg-brand-soft' : 'border-white/15 hover:bg-[var(--surface-2)]'}`}>
      <span className="mr-2 text-white/45">{'ABCD'[choice]}</span>{option}</button>)}</div>
    {chosen !== null && <p className="mt-3 text-sm text-white/55">Answer locked in.</p>}
  </section>;
}

function Editor({ slug, quizId, onBack }: { slug: string; quizId: string; onBack: () => void }) {
  const base = gamesPath(slug, `/quizzes/${quizId}`);
  const [quiz, setQuiz] = useState<QuizAdmin | null>(null);
  const [text, setText] = useState('');
  const [options, setOptions] = useState(['', '', '', '']);
  const [correct, setCorrect] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => { apiData<QuizAdmin>(`${base}/admin`).then(setQuiz).catch(cause => setError(requestError(cause))); }, [base]);
  async function run(task: () => Promise<QuizAdmin | void>) {
    setError('');
    try { const next = await task(); if (next) setQuiz(next); } catch (cause) { setError(requestError(cause)); }
  }
  if (!quiz) return error ? <p role="alert" className="text-rose-500">{error}</p> : <div className="h-32 animate-pulse rounded-2xl bg-white/5" />;
  return <section className="card p-5">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="text-lg font-bold">{quiz.title} <span className="text-sm font-normal text-white/50">({quiz.status})</span></h3>
      <button type="button" className="btn-ghost" onClick={onBack}>Back</button></div>
    <ol className="space-y-2">{quiz.questions.map(question => <li key={question.id} className="rounded-xl border border-white/10 p-3 text-sm">
      <div className="flex items-start justify-between gap-2"><p className="font-medium">{question.text}</p>
        <button type="button" title="Delete question" aria-label="Delete question" className="text-white/50 hover:text-rose-500"
          onClick={() => void run(() => apiData<QuizAdmin>(`${base}/questions/${question.id}`, { method: 'DELETE' }))}><Icon name="trash" size={15} /></button></div>
      <ul className="mt-1 text-white/65">{question.options.map((option, i) => <li key={i}>{i === question.correctIndex ? '✓ ' : '• '}{option}</li>)}</ul>
    </li>)}</ol>
    {!quiz.questions.length && <p className="text-sm text-white/60">No questions yet. Add the first one below.</p>}
    <form className="mt-4 space-y-2 border-t border-white/10 pt-4" onSubmit={event => { event.preventDefault();
      void run(async () => { const next = await post<QuizAdmin>(`${base}/questions`, { text, options, correctIndex: correct }); setText(''); setOptions(['', '', '', '']); setCorrect(0); return next; }); }}>
      <label className="block text-sm font-medium">Question<input className="auth-input" required maxLength={200} value={text} onChange={event => setText(event.target.value)} /></label>
      <fieldset className="space-y-1.5"><legend className="text-sm font-medium">Answers (select the right one)</legend>
        {options.map((option, i) => <div key={i} className="flex items-center gap-2">
          <input type="radio" name="correct" aria-label={`Answer ${i + 1} is correct`} checked={correct === i} onChange={() => setCorrect(i)} />
          <input className="auth-input !mt-0" required maxLength={80} aria-label={`Answer ${i + 1}`} value={option} onChange={event => setOptions(list => list.map((item, j) => j === i ? event.target.value : item))} /></div>)}</fieldset>
      <div className="flex flex-wrap gap-2"><button className="auth-button !w-auto px-4">Add question</button>
        {quiz.status !== 'published' && <button type="button" className="btn-ghost" onClick={() => void run(() => post<QuizAdmin>(`${base}/publish`))}>Publish quiz</button>}
        {quiz.status === 'published' && <button type="button" className="btn-ghost" onClick={() => void run(() => apiData<QuizAdmin>(base, { method: 'PATCH', body: JSON.stringify({ status: 'archived' }) }))}>Archive</button>}</div>
    </form>
    {error && <p role="alert" className="mt-2 text-sm text-rose-500">{error}</p>}
  </section>;
}

export function Trivia({ slug, canManage, onScored }: { slug: string; canManage: boolean; onScored: () => void }) {
  const [quizzes, setQuizzes] = useState<QuizSummary[] | null>(null);
  const [mode, setMode] = useState<{ type: 'play' | 'edit'; quiz: QuizSummary } | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => apiData<QuizSummary[]>(gamesPath(slug, '/quizzes')).then(setQuizzes).catch(cause => setError(requestError(cause))), [slug]);
  useEffect(() => { void load(); }, [load]);
  async function create(task: () => Promise<{ id: string }>) {
    setError('');
    try { await task(); setTitle(''); await load(); } catch (cause) { setError(requestError(cause)); }
  }
  if (mode?.type === 'play') return <Play slug={slug} quiz={mode.quiz} onDone={() => { setMode(null); void load(); onScored(); }} />;
  if (mode?.type === 'edit') return <Editor slug={slug} quizId={mode.quiz.id} onBack={() => { setMode(null); void load(); }} />;
  return <div className="space-y-4">
    {error && <p role="alert" className="text-sm text-rose-500">{error}</p>}
    {!quizzes ? <div className="h-24 animate-pulse rounded-2xl bg-white/5" aria-busy="true" />
      : !quizzes.length ? <div className="card p-6 text-center"><Icon name="science" size={28} className="mx-auto text-brand" />
        <p className="mt-2 font-medium">No quizzes yet</p><p className="text-sm text-white/60">{canManage ? 'Create one below, or start from a ready-made set of ten questions.' : 'Ask a community admin to add one.'}</p></div>
      : <ul className="space-y-2">{quizzes.map(quiz => <li key={quiz.id} className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0"><p className="font-semibold">{quiz.title}{quiz.status !== 'published' && <span className="ml-2 rounded-full bg-brand-soft px-2 py-0.5 text-xs text-brand">{quiz.status}</span>}</p>
          <p className="text-sm text-white/60">{quiz.questionCount} questions · {quiz.timeLimitS}s each{quiz.myState === 'finished' ? ` · you scored ${quiz.myScore}` : ''}</p></div>
        <div className="flex gap-2">
          {canManage && <button type="button" className="btn-ghost" onClick={() => setMode({ type: 'edit', quiz })}>Edit</button>}
          {quiz.status === 'published' && quiz.myState !== 'finished' && <button type="button" className="auth-button !w-auto px-4" onClick={() => setMode({ type: 'play', quiz })}>{quiz.myState === 'playing' ? 'Continue' : 'Play'}</button>}
        </div></li>)}</ul>}
    {canManage && <section className="card p-4">
      <h3 className="font-semibold">Add a quiz</h3>
      <form className="mt-2 flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void create(() => post<{ id: string }>(gamesPath(slug, '/quizzes'), { title, timeLimitS: 20 })); }}>
        <input className="auth-input !mt-0 min-w-0 flex-1" required maxLength={80} aria-label="Quiz title" placeholder="Quiz title" value={title} onChange={event => setTitle(event.target.value)} />
        <button className="auth-button !w-auto px-4">Create</button></form>
      <p className="mt-3 text-sm text-white/60">Or start with ten ready-made questions:</p>
      <div className="mt-1.5 flex flex-wrap gap-2">{(['general', 'science', 'geography'] as const).map(pack => <button key={pack} type="button" className="btn-ghost capitalize"
        onClick={() => void create(() => post<{ id: string }>(gamesPath(slug, '/quizzes/starter'), { pack }))}>{pack === 'general' ? 'General knowledge' : pack}</button>)}</div>
    </section>}
  </div>;
}
