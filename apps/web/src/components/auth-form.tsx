'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { loginSchema, signupSchema } from '@hive/shared';
import { useAuth } from '../lib/auth';
import { Icon, Logo, type IconName } from './ui/icons';

export default function AuthForm({ mode }: { mode: 'signup' | 'login' }) {
  const auth = useAuth();
  const router = useRouter();
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const signup = mode === 'signup';
  const title = signup ? 'Sign up' : 'Log in';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const values = Object.fromEntries(new FormData(event.currentTarget));
    setSubmitting(true);
    try {
      if (signup) {
        const parsed = signupSchema.safeParse(values);
        if (!parsed.success) throw new Error(parsed.error.issues[0].message);
        await auth.signup(parsed.data);
      } else {
        const parsed = loginSchema.safeParse(values);
        if (!parsed.success) throw new Error(parsed.error.issues[0].message);
        await auth.login(parsed.data);
      }
      const next = new URLSearchParams(window.location.search).get('next');
      const safe = next && /^\/(?![/\\])/.test(next) ? next : '/home';
      router.push(safe);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const demoEmail = process.env.NEXT_PUBLIC_DEMO_EMAIL;
  const demoPassword = process.env.NEXT_PUBLIC_DEMO_PASSWORD;
  async function demo() {
    if (!demoEmail || !demoPassword) return;
    setError(''); setSubmitting(true);
    try { await auth.login({ email: demoEmail, password: demoPassword }); router.push('/home'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Demo is unavailable right now.'); }
    finally { setSubmitting(false); }
  }

  const features: [IconName, string, string][] = [
    ['message', 'Real-time chat', 'Channels, threads, DMs and reactions'],
    ['layers', 'Communities', 'Posts, votes and nested discussions'],
    ['phone', 'Calls & huddles', 'Talk face to face, right from a channel'],
  ];
  return (
    <main className="grid min-h-[calc(100dvh-4rem)] lg:grid-cols-2">
      <section className="relative hidden overflow-hidden bg-gradient-to-br from-[#15171c] via-[#1f1a10] to-[#3a2a0a] p-12 lg:flex lg:flex-col lg:justify-center" style={{ color: '#fff' }}>
        <div aria-hidden className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-[rgb(255_255_255/0.12)] blur-3xl" />
        <div aria-hidden className="absolute -bottom-24 left-10 h-72 w-72 rounded-full bg-amber-400/20 blur-3xl" />
        <div className="relative max-w-md">
          <Logo size={44} />
          <h2 className="mt-6 text-4xl font-extrabold leading-tight">Chat, discuss and build <span style={{ color: '#f2a516' }}>together.</span></h2>
          <p className="mt-3 text-lg opacity-85">Your team&apos;s chat, your community&apos;s forum and your calls, all in one place.</p>
          <ul className="mt-8 space-y-4">{features.map(([icon, heading, text]) => <li key={heading} className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[rgb(255_255_255/0.15)]"><Icon name={icon} size={20} /></span>
            <span><span className="block font-semibold">{heading}</span><span className="block text-sm opacity-80">{text}</span></span>
          </li>)}</ul>
        </div>
      </section>
      <section className="flex items-center justify-center px-4 py-12">
        <div className="card animate-in w-full max-w-md p-7 sm:p-8">
          <h1 className="text-2xl font-extrabold">{signup ? 'Create your account' : 'Welcome back'}</h1>
          <p className="mt-1 text-sm text-white/55">{signup ? 'It takes less than a minute.' : 'Log in to continue to Hive.'}</p>
          <form onSubmit={submit} className="mt-6 space-y-4">
            {signup && <label className="block text-sm font-medium">Username
              <input className="auth-input" name="username" autoComplete="username" required minLength={3} maxLength={32} pattern="[a-zA-Z0-9_]+" placeholder="e.g. awais_dev" />
            </label>}
            <label className="block text-sm font-medium">Email
              <input className="auth-input" name="email" type="email" autoComplete="email" required placeholder="you@example.com" />
            </label>
            <label className="block text-sm font-medium">Password
              <input className="auth-input" name="password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} required minLength={8} maxLength={128} placeholder="At least 8 characters" />
            </label>
            {error && <p role="alert" className="rounded-xl bg-rose-500/10 px-3 py-2 text-sm text-rose-500">{error}</p>}
            <button className="auth-button h-11 w-full" disabled={submitting || auth.loading}>
              {submitting ? 'Please wait…' : title}
            </button>
            {!signup && demoEmail && <button type="button" onClick={demo} disabled={submitting || auth.loading} className="btn-ghost h-11 w-full justify-center">Try the demo</button>}
            {signup && <p className="text-xs leading-relaxed text-white/65">By signing up you agree to the <Link href="/policies/terms" target="_blank" rel="noopener" className="text-brand underline">Terms of Service</Link> and <Link href="/policies/privacy" target="_blank" rel="noopener" className="text-brand underline">Privacy Policy</Link>, and confirm you have read the <Link href="/policies/guidelines" target="_blank" rel="noopener" className="text-brand underline">Community Guidelines</Link>.</p>}
          </form>
          <p className="mt-6 text-center text-sm text-white/60">
            {signup ? 'Already have an account? ' : 'New to Hive? '}
            <Link className="font-semibold text-brand hover:underline" href={signup ? '/login' : '/signup'}>{signup ? 'Log in' : 'Create an account'}</Link>
          </p>
          <p className="mt-2 text-center text-xs text-white/50"><Link className="hover:underline" href="/guide">How Hive works</Link> · <Link className="hover:underline" href="/policies">Help &amp; policies</Link></p>
        </div>
      </section>
    </main>
  );
}
