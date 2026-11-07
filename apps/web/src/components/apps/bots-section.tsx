'use client';

import { useState, type FormEvent } from 'react';
import { botCreateSchema } from '@hive/shared';
import { API_URL } from '../../lib/api';
import { apiData, requestError } from '../../lib/spaces';
import { base, botExample, commandReplyExample, signatureExample, type AppChannel, type Bot, type Delivery } from '../../lib/apps';
import { Code, Empty, SecretBox, Section } from './parts';

export function BotsSection({ slug, channels, bots, reload, fail }: {
  slug: string; channels: AppChannel[]; bots: Bot[]; reload: () => Promise<void>; fail: (message: string) => void;
}) {
  type Secret = { label: string; value: string; note: string };
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [created, setCreated] = useState<Bot | null>(null);
  const [log, setLog] = useState<{ id: string; rows: Delivery[] } | null>(null);

  const show = (bot: Bot) => {
    const list: Secret[] = [];
    if (bot.token) list.push({ label: `API token for "${bot.name}"`, value: bot.token, note: 'Send it as "Authorization: Bearer <token>". Shown only once; Regenerate gives a new one.' });
    if (bot.signingSecret) list.push({ label: `Signing secret for "${bot.name}"`, value: bot.signingSecret, note: 'Use it to check the X-Hive-Signature header on requests Hive sends to your bot.' });
    setSecrets(list);
  };
  async function act(promise: Promise<unknown>) { fail(''); try { await promise; await reload(); } catch (cause) { fail(requestError(cause)); } }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); fail('');
    const form = event.currentTarget; const data = new FormData(form);
    const parsed = botCreateSchema.safeParse({
      name: data.get('name'), description: data.get('description') || '', emoji: data.get('emoji') || undefined,
      webhookUrl: (data.get('webhookUrl') as string) || null, channelIds: data.getAll('channelIds'),
    });
    if (!parsed.success) { fail(parsed.error.issues[0].message); return; }
    try {
      const bot = await apiData<Bot>(`${base(slug)}/bots`, { method: 'POST', body: JSON.stringify(parsed.data) });
      setCreated(bot); show(bot); form.reset(); await reload();
    } catch (cause) { fail(requestError(cause)); }
  }

  async function toggleChannel(bot: Bot, channelId: string, on: boolean) {
    const ids = bot.channels.map(channel => channel.id).filter(id => id !== channelId);
    await act(apiData(`${base(slug)}/bots/${bot.id}`, { method: 'PATCH', body: JSON.stringify({ channelIds: on ? [...ids, channelId] : ids }) }));
  }
  async function saveUrl(bot: Bot, value: string) {
    if (value.trim() === (bot.webhookUrl ?? '')) return;
    await act(apiData(`${base(slug)}/bots/${bot.id}`, { method: 'PATCH', body: JSON.stringify({ webhookUrl: value.trim() || null }) }));
  }

  return <Section id="bots" title="Bots" intro="A bot is a program with its own name and a secret token. It can post in, and read, only the channels you tick for it. Give it a web address and Hive also tells it about new messages and about its slash commands.">
    {secrets.map(item => <SecretBox key={item.label} {...item} onClose={() => { setSecrets(secrets.filter(other => other !== item)); setCreated(null); }} />)}
    {secrets.some(item => item.label.startsWith('API')) && <Code label="Post a message as a bot">{botExample(API_URL, created?.channels[0]?.id ?? bots[0]?.channels[0]?.id ?? 'CHANNEL_ID')}</Code>}
    {!bots.length ? <Empty>No bots yet. Create one below; you can add it to channels afterwards.</Empty> :
      <ul className="space-y-3">{bots.map(bot => <li key={bot.id} className="space-y-3 rounded-xl border border-white/10 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xl" aria-hidden>{bot.emoji}</span>
          <div className="min-w-0 flex-1"><p className="truncate font-medium">{bot.name}</p><p className="text-xs text-white/60">{bot.description || 'No description'} · token ends in …{bot.tokenHint}</p></div>
          <button type="button" className="btn-ghost" onClick={() => { if (window.confirm('The old token stops working immediately. Continue?')) void act(apiData<Bot>(`${base(slug)}/bots/${bot.id}/regenerate`, { method: 'POST' }).then(show)); }}>Regenerate token</button>
          <button type="button" className="btn-ghost" onClick={() => void act(apiData<Bot>(`${base(slug)}/bots/${bot.id}/rotate-secret`, { method: 'POST' }).then(show))}>Rotate signing secret</button>
          <button type="button" className="text-rose-500" onClick={() => { if (window.confirm(`Delete ${bot.name}? Its token and slash commands are removed.`)) void act(apiData(`${base(slug)}/bots/${bot.id}`, { method: 'DELETE' })); }}>Delete</button>
        </div>
        <fieldset><legend className="text-sm font-medium">Channels this bot may use</legend>
          <div className="mt-1 flex flex-wrap gap-2">{channels.map(channel => {
            const on = bot.channels.some(item => item.id === channel.id);
            return <label key={channel.id} className={`flex cursor-pointer items-center gap-1 rounded-full border px-3 py-1 text-sm ${on ? 'border-brand bg-brand-soft' : 'border-white/15'}`}>
              <input type="checkbox" checked={on} onChange={event => void toggleChannel(bot, channel.id, event.target.checked)} />#{channel.name}</label>;
          })}</div></fieldset>
        <label className="block text-sm">Address Hive sends events to (optional)
          <input className="auth-input" type="url" defaultValue={bot.webhookUrl ?? ''} placeholder="https://example.com/hive" onBlur={event => void saveUrl(bot, event.target.value)} /></label>
        {bot.webhookUrl && <div><button type="button" className="text-sm text-brand underline" onClick={async () => {
          if (log?.id === bot.id) { setLog(null); return; }
          try { setLog({ id: bot.id, rows: await apiData<Delivery[]>(`${base(slug)}/bots/${bot.id}/deliveries`) }); } catch (cause) { fail(requestError(cause)); }
        }}>{log?.id === bot.id ? 'Hide' : 'Show'} recent deliveries</button>
          {log?.id === bot.id && (log.rows.length ? <ul className="mt-2 space-y-1 text-xs">{log.rows.map(row => <li key={row.id}>
            <span className={row.status === 'ok' ? 'text-emerald-500' : row.status === 'failed' ? 'text-rose-500' : 'text-white/60'}>{row.status}</span> · {row.event} · {row.attempts} {row.attempts === 1 ? 'try' : 'tries'}{row.error ? ` · ${row.error}` : ''} · {new Date(row.createdAt).toLocaleString()}</li>)}</ul> : <p className="mt-2 text-xs text-white/60">Nothing sent yet.</p>)}</div>}
      </li>)}</ul>}
    <form onSubmit={create} className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-40 flex-1 text-sm">Name<input name="name" className="auth-input" maxLength={80} required placeholder="Helper" /></label>
        <label className="w-24 text-sm">Icon<input name="emoji" className="auth-input" maxLength={16} defaultValue="🤖" /></label>
      </div>
      <label className="block text-sm">What does it do?<input name="description" className="auth-input" maxLength={300} /></label>
      <label className="block text-sm">Address Hive sends events to (optional)<input name="webhookUrl" type="url" className="auth-input" placeholder="https://example.com/hive" /></label>
      <fieldset><legend className="text-sm font-medium">Channels</legend><div className="mt-1 flex flex-wrap gap-2">{channels.map(channel =>
        <label key={channel.id} className="flex items-center gap-1 rounded-full border border-white/15 px-3 py-1 text-sm"><input type="checkbox" name="channelIds" value={channel.id} />#{channel.name}</label>)}</div></fieldset>
      <button className="auth-button">Create bot</button>
    </form>
    <details className="text-sm"><summary className="cursor-pointer font-medium">For developers: events and signatures</summary>
      <div className="mt-3 space-y-3">
        <p className="text-white/70">Hive sends <code>POST</code> requests with a JSON body and these headers: <code>X-Hive-Event</code> (message.created or command), <code>X-Hive-Timestamp</code> and <code>X-Hive-Signature</code> (HMAC-SHA256 of the raw body with the signing secret, prefixed by sha256=). Failed deliveries are retried a few times. Only public https/http addresses on ports 80 and 443 are allowed.</p>
        <Code label="Example: post a message as a bot">{botExample(API_URL, bots[0]?.channels[0]?.id ?? 'CHANNEL_ID')}</Code>
        <Code label="Verify a request">{signatureExample}</Code>
        <p className="text-white/70">Read recent messages with <code>GET /api/bot/channels/CHANNEL_ID/messages</code> and list the bot&apos;s channels with <code>GET /api/bot/channels</code>, using the same Bearer token.</p>
        <Code label="Answering a slash command">{commandReplyExample}</Code>
      </div></details>
  </Section>;
}
