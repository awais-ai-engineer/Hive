'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { loginSchema, signupSchema } from '@hive/shared';
import { useAuth } from '../lib/auth';

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
      router.push('/me');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <section className="rounded-xl border border-white/10 bg-white/[0.03] p-6">
        <h1 className="mb-6 text-2xl font-bold">{title}</h1>
        <form onSubmit={submit} className="space-y-4">
          {signup && <label className="block">Username
            <input className="auth-input" name="username" autoComplete="username" required minLength={3} maxLength={32} pattern="[a-zA-Z0-9_]+" />
          </label>}
          <label className="block">Email
            <input className="auth-input" name="email" type="email" autoComplete="email" required />
          </label>
          <label className="block">Password
            <input className="auth-input" name="password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} required minLength={8} maxLength={128} />
          </label>
          {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}
          <button className="auth-button w-full" disabled={submitting || auth.loading}>
            {submitting ? 'Please wait…' : title}
          </button>
        </form>
        <p className="mt-5 text-sm text-white/60">
          {signup ? 'Already have an account? ' : 'New to Hive? '}
          <Link className="text-amber-400" href={signup ? '/login' : '/signup'}>{signup ? 'Log in' : 'Sign up'}</Link>
        </p>
      </section>
    </main>
  );
}
