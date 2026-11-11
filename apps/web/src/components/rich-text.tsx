'use client';

import { Tooltip as UiTooltip } from '@hive/ui';

import { Button as UiButton } from '@hive/ui';

import { Fragment, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { parseMarkdown, type MarkdownNode } from '@hive/shared';

type Mention = { userId: string; username: string; displayName?: string | null };
type Channel = { id: string; name: string; href: string };
type Props = { source: string; mentions?: Mention[]; channels?: Channel[] };

function CodeBlock({ value, language }: { value: string; language?: string }) {
  const [status, setStatus] = useState('Copy');
  async function copy() {
    try { await navigator.clipboard.writeText(value); setStatus('Copied'); }
    catch { setStatus('Copy failed'); }
  }
  return <div className="my-2 overflow-hidden rounded-lg border border-white/10 bg-canvas">
    <div className="flex items-center justify-between gap-3 border-b border-white/10 px-3 py-1 text-xs text-white/55">
      <span>{language || 'Code'}</span>
      <UiButton type="button" onClick={() => void copy()} aria-label="Copy code" tooltip="Copy code"
        className="rounded px-2 py-1 hover:bg-white/10">{status}</UiButton>
      <span className="sr-only" role="status">{status === 'Copy' ? '' : status}</span>
    </div>
    <pre className="overflow-x-auto p-3 text-sm"><code>{value}</code></pre>
  </div>;
}

export function RichText({ source, mentions = [], channels = [] }: Props) {
  const users = new Map(mentions.map(user => [user.userId, user]));
  const destinations = new Map(channels.map(channel => [channel.id, channel]));
  function text(value: string, inLink: boolean): ReactNode {
    if (inLink) return value;
    return value.split(/([@#]\[(?:user|channel):[^\]\s]+\])/g).map((part, index) => {
      const token = /^([@#])\[(user|channel):([^\]\s]+)\]$/.exec(part);
      if (!token) return part;
      if (token[1] === '@' && token[2] === 'user') {
        const user = users.get(token[3]);
        return user ? <UiTooltip content={user.displayName || user.username} key={index}><Link key={index} href={`/u/${encodeURIComponent(user.username)}`}
          className="rounded bg-brand-soft px-1 font-medium text-brand hover:underline">@{user.username}</Link></UiTooltip> : part;
      }
      if (token[1] !== '#' || token[2] !== 'channel') return part;
      const channel = destinations.get(token[3]);
      // Channel destinations are application routes, never arbitrary URL schemes.
      return channel && channel.href.startsWith('/') && !channel.href.startsWith('//') && !/[\\\u0000-\u0020]/.test(channel.href)
        ? <Link key={index} href={channel.href} className="rounded bg-brand-soft px-1 font-medium text-brand hover:underline">#{channel.name}</Link>
        : <span key={index} className="rounded bg-white/5 px-1 text-white/55">private channel</span>;
    });
  }
  function render(nodes: MarkdownNode[], inLink = false): ReactNode {
    return nodes.map((node, index) => {
      switch (node.type) {
        case 'text': return <Fragment key={index}>{text(node.value, inLink)}</Fragment>;
        case 'break': return <br key={index} />;
        case 'code': return <code key={index} className="rounded bg-white/5 px-1 py-0.5 font-mono text-[0.9em]">{node.value}</code>;
        case 'codeBlock': return <CodeBlock key={index} value={node.value} language={node.language} />;
        case 'paragraph': return <div key={index}>{render(node.children, inLink)}</div>;
        case 'bold': return <strong key={index}>{render(node.children, inLink)}</strong>;
        case 'italic': return <em key={index}>{render(node.children, inLink)}</em>;
        case 'strike': return <s key={index}>{render(node.children, inLink)}</s>;
        case 'quote': return <blockquote key={index} className="my-1 border-s-2 border-brand/40 ps-3 text-white/65">{render(node.children, inLink)}</blockquote>;
        case 'link': return inLink ? <Fragment key={index}>{render(node.children, true)}</Fragment>
          : typeof window !== 'undefined' && node.href.startsWith(`${window.location.origin}/`)
            // Links to Hive itself (like saved huddle notes) stay in the same tab.
            ? <Link key={index} href={node.href.slice(window.location.origin.length)} className="text-brand underline underline-offset-2">{render(node.children, true)}</Link>
            : <a key={index} href={node.href} target="_blank" rel="noopener noreferrer nofollow ugc" className="text-brand underline underline-offset-2">{render(node.children, true)}</a>;
        case 'list': {
          const List = node.ordered ? 'ol' : 'ul';
          return <List key={index} className={`my-1 ps-6 ${node.ordered ? 'list-decimal' : 'list-disc'}`}>
            {node.items.map((item, itemIndex) => <li key={itemIndex}>{render(item, inLink)}</li>)}
          </List>;
        }
      }
    });
  }
  return <div className="min-w-0 whitespace-pre-wrap break-words leading-relaxed text-white/90 [overflow-wrap:anywhere]">{render(parseMarkdown(source))}</div>;
}
