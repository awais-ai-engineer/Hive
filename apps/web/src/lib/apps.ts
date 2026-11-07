import type { Action, Trigger } from '@hive/shared';

export type AppChannel = { id: string; name: string };
export type Webhook = {
  id: string; name: string; emoji: string; channelId: string; channelName: string | null;
  tokenHint: string; lastUsedAt: string | null; createdAt: string; token?: string; path?: string;
};
export type Bot = {
  id: string; name: string; description: string; emoji: string; tokenHint: string; webhookUrl: string | null;
  channels: AppChannel[]; createdAt: string; token?: string; signingSecret?: string;
};
export type SlashCommand = { id: string; name: string; description: string; usage: string; botId: string; botName: string };
export type Delivery = { id: string; event: string; status: 'pending' | 'ok' | 'failed'; attempts: number; error: string | null; createdAt: string };
export type Workflow = {
  id: string; name: string; enabled: boolean; trigger: Trigger; action: Action; nextRunAt: string | null; createdAt: string;
  lastRun: { status: 'ok' | 'error' | 'skipped'; error: string | null; at: string } | null;
};
export type WorkflowRun = { id: string; status: 'ok' | 'error' | 'skipped'; error: string | null; detail: string | null; user: string | null; at: string };
export type SpaceMemberRow = { user: { id: string; username: string }; role: string };

export const base = (slug: string) => `/api/spaces/${encodeURIComponent(slug)}`;

export const hookUrl = (apiUrl: string, path: string) => `${apiUrl}${path}`;

export function curlExample(url: string) {
  return `curl -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"text": "Deploy finished :tada:", "username": "Deploy bot"}'`;
}

export function botExample(apiUrl: string, channelId: string) {
  return `curl -X POST '${apiUrl}/api/bot/messages' \\\n  -H 'Authorization: Bearer YOUR_BOT_TOKEN' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"channelId": "${channelId}", "text": "Hello from my bot"}'`;
}

export const signatureExample = `// Node.js: check that a request really comes from Hive
import crypto from 'node:crypto';
const expected = 'sha256=' + crypto.createHmac('sha256', SIGNING_SECRET)
  .update(rawBody).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-hive-signature']));`;

export const commandReplyExample = `{ "text": "pong", "ephemeral": true }   // ephemeral: only the person who typed the command sees it`;
