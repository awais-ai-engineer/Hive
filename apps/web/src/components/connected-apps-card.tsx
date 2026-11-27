'use client';

import { Button as UiButton, EmptyState, LoadingState } from '@hive/ui';
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { apiData, requestError } from '../lib/spaces';

type ConnectedApp = {
  id: string;
  client_id: string;
  client_name: string;
  scopes: string[];
  space_ids: string[];
  created_at: string | null;
};

export function ConnectedAppsCard() {
  const [apps, setApps] = useState<ConnectedApp[] | null>(null);
  const [error, setError] = useState('');
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    apiData<ConnectedApp[]>('/api/mcp/grants')
      .then(setApps)
      .catch(cause => setError(requestError(cause)));
  }, []);

  async function revoke(grantId: string) {
    setError('');
    setRevoking(grantId);
    try {
      const response = await apiFetch(`/api/mcp/grants/${grantId}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Could not revoke access. Please try again.');
      setApps(current => current?.filter(item => item.id !== grantId) ?? null);
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setRevoking(null);
    }
  }

  return (
    <section className="card p-5 sm:p-6">
      <h2 className="text-lg font-bold">Connected MCP Apps</h2>
      <p className="mt-1 text-sm text-white/60">
        Apps and AI assistants authorized to access your Hive account.
      </p>
      {error && <p role="alert" className="mt-2 text-sm text-rose-500">{error}</p>}
      {apps === null ? (
        !error && <LoadingState layout="inline" label="Loading connected apps" />
      ) : apps.length === 0 ? (
        <EmptyState
          layout="compact"
          title="No connected apps"
          description="Apps you authorize via OAuth will appear here."
        />
      ) : (
        <ul className="mt-4 divide-y divide-white/10">
          {apps.map(app => (
            <li key={app.id} className="flex items-start justify-between gap-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-white">{app.client_name}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {app.scopes.map(s => (
                    <span
                      key={s}
                      className="rounded-md bg-[var(--surface-2)] px-2 py-0.5 text-xs text-white/70"
                    >
                      {s}
                    </span>
                  ))}
                </div>
              </div>
              <UiButton
                type="button"
                disabled={revoking === app.id}
                onClick={() => void revoke(app.id)}
                className="btn-ghost shrink-0 text-rose-400 hover:text-rose-300"
              >
                {revoking === app.id ? 'Revoking…' : 'Revoke'}
              </UiButton>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
