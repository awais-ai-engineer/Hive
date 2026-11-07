'use client';

import { useState, type FormEvent } from 'react';
import { webhookCreateSchema } from '@hive/shared';
import { API_URL } from '../../lib/api';
import { apiData, requestError } from '../../lib/spaces';
import { base, curlExample, type AppChannel, type Webhook } from '../../lib/apps';
import { Code, Empty, SecretBox, Section } from './parts';

export function WebhooksSection({ slug, channels, hooks, reload, fail }: {
  slug: string; channels: AppChannel[]; hooks: Webhook[]; reload: () => Promise<void>; fail: (message: string) => void;
}) {
  const [secret, setSecret] = useState<Webhook | null>(null);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); fail('');
    const form = event.currentTarget; const data = new FormData(form);
    const parsed = webhookCreateSchema.safeParse({ name: data.get('name'), channelId: data.get('channelId'), emoji: data.get('emoji') || undefined });
    if (!parsed.success) { fail(parsed.error.issues[0].message); return; }
    try { setSecret(await apiData<Webhook>(`${base(slug)}/webhooks`, { method: 'POST', body: JSON.stringify(parsed.data) })); form.reset(); await reload(); }
    catch (cause) { fail(requestError(cause)); }
  }
  async function act(promise: Promise<unknown>) { fail(''); try { await promise; await reload(); } catch (cause) { fail(requestError(cause)); } }

  return <Section id="webhooks" title="Incoming webhooks" intro="A webhook is a secret web address. Anything that can send it a message (a build server, a form, a monitoring tool) can post into one channel. Treat the address like a password.">
    {secret?.token && <>
      <SecretBox label={`Webhook address for "${secret.name}"`} value={`${API_URL}${secret.path}`} note="Copy it now. For safety Hive only shows it once; if you lose it, create a new address with Regenerate." onClose={() => setSecret(null)} />
      <Code label="Try it from a terminal">{curlExample(`${API_URL}${secret.path}`)}</Code>
    </>}
    <Code label="Example: send a message with curl">{curlExample(`${API_URL}/api/hooks/YOUR_WEBHOOK_TOKEN`)}</Code>
    {!hooks.length ? <Empty>No webhooks yet. Create one below, then paste its address into the tool you want to hear from.</Empty> :
      <ul className="space-y-2">{hooks.map(hook => <li key={hook.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 p-3">
        <span className="text-xl" aria-hidden>{hook.emoji}</span>
        <div className="min-w-0 flex-1"><p className="truncate font-medium">{hook.name}</p>
          <p className="text-xs text-white/60">Posts in #{hook.channelName} · ends in …{hook.tokenHint} · {hook.lastUsedAt ? `last used ${new Date(hook.lastUsedAt).toLocaleString()}` : 'never used'}</p></div>
        <button type="button" className="btn-ghost" onClick={() => { if (window.confirm('The old address stops working immediately. Continue?')) void act(apiData<Webhook>(`${base(slug)}/webhooks/${hook.id}/regenerate`, { method: 'POST' }).then(setSecret)); }}>Regenerate</button>
        <button type="button" className="text-rose-500" onClick={() => { if (window.confirm(`Delete ${hook.name}? Its address stops working.`)) void act(apiData(`${base(slug)}/webhooks/${hook.id}`, { method: 'DELETE' })); }}>Delete</button>
      </li>)}</ul>}
    <form onSubmit={create} className="flex flex-wrap items-end gap-3">
      <label className="min-w-40 flex-1 text-sm">Name<input name="name" className="auth-input" maxLength={80} required placeholder="Deploy notices" /></label>
      <label className="text-sm">Post in<select name="channelId" className="auth-input" required defaultValue="">
        <option value="" disabled>Choose a channel</option>{channels.map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}</select></label>
      <label className="w-24 text-sm">Icon<input name="emoji" className="auth-input" maxLength={16} defaultValue="🔔" /></label>
      <button className="auth-button">Create webhook</button>
    </form>
  </Section>;
}
