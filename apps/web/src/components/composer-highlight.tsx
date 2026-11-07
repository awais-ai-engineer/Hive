import { Fragment, type ReactNode } from 'react';

/*
 * Live formatting for the message box. The textarea's text is transparent and this layer sits
 * exactly underneath it with the same characters, so styles must never change character widths:
 * bold uses a text shadow, code a background, and the Markdown markers are only dimmed.
 */
const PATTERN = /(```[\s\S]*?(?:```|$)|`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|(?<![\w*])\*[^*\s][^*\n]*\*(?![\w*])|(?<![\w_])_[^_\s][^_\n]*_(?![\w_])|^>[^\n]*|@[\w-]+|#[\w-]+|https?:\/\/[^\s<>]+)/gm;

const bold = { textShadow: '0.35px 0 0 currentColor, -0.35px 0 0 currentColor' };
const marker = 'opacity-35';

function wrap(text: string, open: number, close: number, style: string, css?: object) {
  return <>
    <span className={marker}>{text.slice(0, open)}</span>
    <span className={style} style={css}>{text.slice(open, text.length - close)}</span>
    <span className={marker}>{text.slice(text.length - close)}</span>
  </>;
}

function piece(text: string): ReactNode {
  if (text.startsWith('```')) return <span className="rounded bg-white/10">{text}</span>;
  if (text.startsWith('`')) return wrap(text, 1, 1, 'rounded bg-white/10 text-rose-500');
  if (text.startsWith('**')) return wrap(text, 2, 2, '', bold);
  if (text.startsWith('~~')) return wrap(text, 2, 2, 'line-through');
  if (text.startsWith('*') || text.startsWith('_')) return wrap(text, 1, 1, 'italic');
  if (text.startsWith('>')) return <><span className={marker}>&gt;</span><span className="text-white/70">{text.slice(1)}</span></>;
  if (text.startsWith('@') || text.startsWith('#')) return <span className="rounded bg-brand-soft text-brand">{text}</span>;
  return <span className="text-brand underline">{text}</span>;
}

export function highlight(source: string): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of source.matchAll(PATTERN)) {
    const start = match.index ?? 0;
    if (start > last) parts.push(source.slice(last, start));
    parts.push(<Fragment key={start}>{piece(match[0])}</Fragment>);
    last = start + match[0].length;
  }
  parts.push(source.slice(last));
  // A trailing newline needs a character after it to take up a line, like the textarea does.
  parts.push('​');
  return parts;
}
