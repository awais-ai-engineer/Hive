'use client';

import type { FormEvent } from 'react';
import { commandCreateSchema } from '@hive/shared';
import { apiData, requestError } from '../../lib/spaces';
import { base, type Bot, type SlashCommand } from '../../lib/apps';
import { Empty, Section } from './parts';

export function CommandsSection({ slug, bots, commands, reload, fail }: {
  slug: string; bots: Bot[]; commands: SlashCommand[]; reload: () => Promise<void>; fail: (message: string) => void;
}) {
  const usable = bots.filter(bot => bot.webhookUrl);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); fail('');
    const form = event.currentTarget; const data = new FormData(form);
    const parsed = commandCreateSchema.safeParse({ name: data.get('name'), botId: data.get('botId'), description: data.get('description') || '', usage: data.get('usage') || '' });
    if (!parsed.success) { fail(parsed.error.issues[0].message); return; }
    try { await apiData(`${base(slug)}/commands`, { method: 'POST', body: JSON.stringify(parsed.data) }); form.reset(); await reload(); }
    catch (cause) { fail(requestError(cause)); }
  }
  async function remove(command: SlashCommand) {
    fail(''); try { await apiData(`${base(slug)}/commands/${command.id}`, { method: 'DELETE' }); await reload(); } catch (cause) { fail(requestError(cause)); }
  }
  return <Section id="commands" title="Slash commands" intro="Add your own /commands. When someone types one, Hive sends it to the bot you pick, and the bot's answer is posted in the channel (or shown only to the person who asked). The bot must have an address and be added to the channel where the command is used.">
    {!commands.length ? <Empty>No custom commands yet. Built-in ones (/poll, /remind, /status, /shrug) always work.</Empty> :
      <ul className="space-y-2">{commands.map(command => <li key={command.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 p-3">
        <div className="min-w-0 flex-1"><p className="font-medium">/{command.name} <span className="font-normal text-white/60">{command.usage !== `/${command.name}` ? command.usage : ''}</span></p>
          <p className="text-xs text-white/60">{command.description || 'No description'} · answered by {command.botName}</p></div>
        <button type="button" className="text-rose-500" onClick={() => void remove(command)}>Delete</button>
      </li>)}</ul>}
    {!usable.length ? <p className="text-sm text-white/60">Create a bot with an address first: commands are sent there.</p> :
      <form onSubmit={create} className="flex flex-wrap items-end gap-3">
        <label className="w-36 text-sm">Command<input name="name" className="auth-input" required maxLength={33} placeholder="/standup" /></label>
        <label className="text-sm">Answered by<select name="botId" className="auth-input" required>{usable.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
        <label className="min-w-40 flex-1 text-sm">Description<input name="description" className="auth-input" maxLength={200} placeholder="Post today's stand-up notes" /></label>
        <label className="min-w-40 flex-1 text-sm">Example<input name="usage" className="auth-input" maxLength={120} placeholder="/standup done: …" /></label>
        <button className="auth-button">Add command</button>
      </form>}
  </Section>;
}
