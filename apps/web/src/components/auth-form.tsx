'use client';

import { Input as UiInput, Button as UiButton } from '@hive/ui';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { loginSchema, signupSchema } from '@hive/shared';
import { useAuth } from '../lib/auth';
import { Icon, Logo, type IconName } from './ui/icons';

export default function AuthForm({ mode }: { mode: 'signup' | 'login' }) {
  const auth = useAuth();
  const router = useRouter();
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const googleEnabled = process.env.NEXT_PUBLIC_GOOGLE_LOGIN_ENABLED === 'true';
  const signup = mode === 'signup';
  const title = signup ? 'Sign up' : 'Log in';

  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get('authError');
    if (reason === 'unavailable') setError('Google sign-in is not configured yet.');
    else if (reason === 'account') setError('This email is connected to a different Google account. Try that account or log in with email and password.');
    else if (reason === 'failed') setError('Google sign-in could not be completed. Please try again.');
  }, []);

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

  function googleLogin() {
    const next = new URLSearchParams(window.location.search).get('next');
    const query = next ? `?${new URLSearchParams({ next })}` : '';
    window.location.assign(`/api/auth/google/start${query}`);
  }

  const features: [IconName, string, string][] = [
    ['message', 'Real-time chat', 'Channels, threads, DMs and reactions'],
    ['layers', 'Communities', 'Posts, votes and nested discussions'],
    ['phone', 'Calls & huddles', 'Talk face to face, right from a channel'],
  ];
  return (
    <main className="grid min-h-[calc(100dvh-4rem)] lg:grid-cols-2">
      <section className="relative hidden overflow-hidden bg-gradient-to-br from-[var(--rail)] via-[var(--auth-hero-mid)] to-[var(--auth-hero-end)] p-12 lg:flex lg:flex-col lg:justify-center" style={{ color: 'var(--rail-fg)' }}>
        <div aria-hidden className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-[rgb(255_255_255/0.12)] blur-3xl" />
        <div aria-hidden className="absolute -bottom-24 left-10 h-72 w-72 rounded-full bg-amber-400/20 blur-3xl" />
        <div className="relative max-w-md">
          <Logo size={44} />
          <h2 className="mt-6 text-4xl font-extrabold leading-tight">Chat, discuss and build <span style={{ color: 'var(--brand)' }}>together.</span></h2>
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
              <UiInput className="auth-input" name="username" autoComplete="username" required minLength={3} maxLength={32} pattern="[a-zA-Z0-9_]+" placeholder="e.g. awais_dev" />
            </label>}
            <label className="block text-sm font-medium">Email
              <UiInput className="auth-input" name="email" type="email" autoComplete="email" required placeholder="you@example.com" />
            </label>
            <label className="block text-sm font-medium">Password
              <UiInput className="auth-input" name="password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} required minLength={8} maxLength={128} placeholder="At least 8 characters" />
            </label>
            {error && <p role="alert" className="rounded-xl bg-rose-500/10 px-3 py-2 text-sm text-rose-500">{error}</p>}
            <UiButton className="auth-button h-11 w-full" disabled={submitting || auth.loading}>
              {submitting ? 'Please wait…' : title}
            </UiButton>
            {googleEnabled && <>
              <div className="flex items-center gap-3 py-1 text-xs text-white/45"><span className="h-px flex-1 bg-white/10" /><span>or continue with</span><span className="h-px flex-1 bg-white/10" /></div>
              <UiButton type="button" onClick={googleLogin} disabled={submitting || auth.loading} className="btn-ghost h-11 w-full justify-center gap-3">
                <GoogleMark />Continue with Google
              </UiButton>
            </>}
            {!signup && demoEmail && <UiButton type="button" onClick={demo} disabled={submitting || auth.loading} className="btn-ghost h-11 w-full justify-center">Try the demo</UiButton>}
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

function GoogleMark() {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48">
    <path fill="rgb(66 133 244)" d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.2v5h6.6c3.9-3.6 6.1-8.8 6.1-14.9Z" />
    <path fill="rgb(52 168 83)" d="M24 44c5.5 0 10.1-1.8 13.5-4.8l-6.6-5c-1.8 1.2-4.1 2-6.9 2-5.3 0-9.8-3.6-11.4-8.4h-6.8v5.2A20 20 0 0 0 24 44Z" />
    <path fill="rgb(251 188 5)" d="M12.6 27.8a12 12 0 0 1 0-7.6V15H5.8a20 20 0 0 0 0 18Z" />
    <path fill="rgb(234 67 53)" d="M24 11.8c3 0 5.7 1 7.8 3.1l5.8-5.8C34.1 5.8 29.5 4 24 4A20 20 0 0 0 5.8 15l6.8 5.2c1.6-4.8 6.1-8.4 11.4-8.4Z" />
  </svg>;
}
