'use client';

import { Button as UiButton, LoadingState } from '@hive/ui';
import { useEffect, useState } from 'react';
import { apiFetch, responseData } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';

type ConsentInfo = {
  client_name: string;
  client_description: string;
  scopes: string[];
  scope_descriptions: Record<string, string>;
  workspaces: { id: string; name: string; slug: string; role: string }[];
};

type ConsentResult = { redirect: string };

const SCOPE_ICONS: Record<string, string> = {
  'read:profile': '👤',
  'read:messages': '💬',
  'write:messages': '✏️',
  'read:channels': '📢',
  'read:members': '👥',
  'read:files': '📁',
  'write:files': '📤',
  'read:tasks': '✅',
  'write:tasks': '📝',
  'read:docs': '📄',
  'write:docs': '📃',
};

export default function OAuthConsentPage() {
  const { user, loading: authLoading } = useAuth();
  const [info, setInfo] = useState<ConsentInfo | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [selectedSpaces, setSelectedSpaces] = useState<Set<string>>(new Set());

  const [params, setParams] = useState<URLSearchParams | null>(null);
  useEffect(() => {
    setParams(new URLSearchParams(window.location.search));
  }, []);

  const clientId = params?.get('client_id') ?? '';
  const redirectUri = params?.get('redirect_uri') ?? '';
  const scope = params?.get('scope') ?? 'read:profile';
  const state = params?.get('state') ?? undefined;
  const codeChallenge = params?.get('code_challenge') ?? undefined;
  const codeChallengeMethod = params?.get('code_challenge_method') ?? 'S256';

  useEffect(() => {
    if (!authLoading && !user && params) {
      const returnUrl = `/oauth/consent?${params.toString()}`;
      window.location.href = `/login?next=${encodeURIComponent(returnUrl)}`;
    }
  }, [authLoading, user, params]);

  useEffect(() => {
    if (!user || !clientId) return;
    (async () => {
      try {
        const data = await responseData<ConsentInfo>(
          await apiFetch(`/api/mcp/consent?client_id=${encodeURIComponent(clientId)}`)
        );
        setInfo(data);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not load app details.');
      }
    })();
  }, [user, clientId]);

  async function submit(approved: boolean) {
    setSubmitting(true);
    setError('');
    try {
      const result = await responseData<ConsentResult>(
        await apiFetch('/api/mcp/consent', {
          method: 'POST',
          body: JSON.stringify({
            client_id: clientId,
            redirect_uri: redirectUri,
            scope,
            state: state ?? null,
            code_challenge: codeChallenge ?? null,
            code_challenge_method: codeChallengeMethod,
            space_ids: Array.from(selectedSpaces),
            approved,
          }),
        })
      );
      window.location.href = result.redirect;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.');
      setSubmitting(false);
    }
  }

  function toggleSpace(id: string) {
    setSelectedSpaces(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (authLoading || !params) return <LoadingState label="Loading" />;
  if (!user) return <LoadingState label="Redirecting to login" />;
  if (!clientId) return <main className="p-16 text-center text-white/60">Invalid authorization request.</main>;
  if (error && !info) return <main className="p-16 text-center"><p role="alert" className="text-rose-500">{error}</p></main>;
  if (!info) return <LoadingState label="Loading app details" />;

  const scopes = scope.split(' ').filter(Boolean);

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand/20 text-3xl">🔗</div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Authorize {info.client_name}</h1>
          {info.client_description && <p className="mt-2 text-white/60">{info.client_description}</p>}
        </div>

        <section className="card p-5 sm:p-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-white/50">Permissions requested</h2>
          <ul className="space-y-2">
            {scopes.map(s => (
              <li key={s} className="flex items-start gap-3 rounded-lg bg-[var(--surface-2)] p-3">
                <span className="mt-0.5 text-lg">{SCOPE_ICONS[s] ?? '🔑'}</span>
                <div>
                  <p className="font-medium text-white">{info.scope_descriptions[s] ?? s}</p>
                  <p className="text-sm text-white/50">{s}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {info.workspaces.length > 0 && (
          <section className="card p-5 sm:p-6">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-white/50">Grant access to workspaces</h2>
            <p className="mb-3 text-sm text-white/60">Select which workspaces this app can access.</p>
            <ul className="space-y-2">
              {info.workspaces.map(ws => (
                <li key={ws.id}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-lg bg-[var(--surface-2)] p-3 transition hover:bg-[var(--surface-2)]/80">
                    <input
                      type="checkbox"
                      checked={selectedSpaces.has(ws.id)}
                      onChange={() => toggleSpace(ws.id)}
                      className="h-4 w-4 rounded border-white/20 bg-transparent text-brand focus:ring-brand"
                    />
                    <div className="flex-1">
                      <p className="font-medium text-white">{ws.name}</p>
                      <p className="text-sm text-white/50">{ws.role}</p>
                    </div>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="rounded-lg bg-[var(--surface-2)] px-4 py-3 text-center text-sm text-white/60">
          Authorizing as <span className="font-semibold text-white">{user.username}</span>
        </div>

        {error && <p role="alert" className="text-center text-sm text-rose-500">{error}</p>}

        <div className="flex gap-3">
          <UiButton
            type="button"
            disabled={submitting}
            onClick={() => void submit(false)}
            className="btn-ghost flex-1 justify-center py-3"
          >
            Deny
          </UiButton>
          <UiButton
            type="button"
            disabled={submitting}
            onClick={() => void submit(true)}
            className="flex-1 justify-center rounded-xl bg-brand py-3 font-semibold text-white transition hover:bg-brand/90 disabled:opacity-50"
          >
            {submitting ? 'Authorizing…' : 'Authorize'}
          </UiButton>
        </div>

        <p className="text-center text-xs text-white/40">
          This app will be able to access your Hive account with the permissions listed above.
          You can revoke access anytime from Settings.
        </p>
      </div>
    </main>
  );
}
