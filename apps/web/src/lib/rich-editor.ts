/*
 * The message box is a rich-text editor: people see bold as bold, never Markdown symbols.
 * Messages are still stored as the safe Markdown subset, so this file converts both ways:
 * editor HTML -> Markdown when sending or saving a draft, and Markdown -> HTML when a draft
 * or a rewrite is loaded back into the box.
 */
export type FormatAction = 'bold' | 'italic' | 'strike' | 'code' | 'block' | 'bullet' | 'number' | 'quote';

const BLOCKS = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE']);

/** Keeps spaces outside markers: "** bold **" is not valid Markdown, " **bold** " is. */
function wrap(inner: string, mark: string) {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
  return match[2] ? `${match[1]}${mark}${match[2]}${mark}${match[3]}` : inner;
}

function inline(node: Node, tokens: boolean): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/​/g, '').replace(/ /g, ' ');
  if (!(node instanceof HTMLElement)) return '';
  if (node.dataset.token) return tokens ? node.dataset.token : node.textContent ?? '';
  if (node.tagName === 'BR') return '\n';
  const children = () => Array.from(node.childNodes).map(child => convert(child, tokens)).join('');
  switch (node.tagName) {
    case 'B': case 'STRONG': return wrap(children(), '**');
    case 'I': case 'EM': return wrap(children(), '_');
    case 'S': case 'STRIKE': case 'DEL': return wrap(children(), '~~');
    case 'CODE': return wrap((node.textContent ?? '').replace(/​/g, ''), '`');
    case 'A': { const text = children(); const href = node.getAttribute('href') ?? ''; return href ? `[${text || href}](${href})` : text; }
    case 'SPAN': {
      let text = children();
      if (/bold|[6-9]00/.test(node.style.fontWeight)) text = wrap(text, '**');
      if (node.style.fontStyle === 'italic') text = wrap(text, '_');
      if (/line-through/.test(node.style.textDecoration)) text = wrap(text, '~~');
      return text;
    }
    default: return children();
  }
}

function convert(node: Node, tokens: boolean): string {
  if (!(node instanceof HTMLElement) || !BLOCKS.has(node.tagName)) return inline(node, tokens);
  const body = () => Array.from(node.childNodes).map(child => convert(child, tokens)).join('');
  switch (node.tagName) {
    case 'PRE': return `\n\`\`\`\n${(node.textContent ?? '').replace(/​/g, '').replace(/\n$/, '')}\n\`\`\`\n`;
    case 'UL': case 'OL': {
      const items = Array.from(node.children).filter(child => child.tagName === 'LI');
      return '\n' + items.map((item, index) => `${node.tagName === 'OL' ? `${index + 1}.` : '-'} ${convert(item, tokens).trim()}`).join('\n') + '\n';
    }
    case 'BLOCKQUOTE': return '\n' + body().trim().split('\n').map(line => `> ${line}`).join('\n') + '\n';
    case 'LI': return body();
    default: { const text = body(); return text.endsWith('\n') ? `\n${text}` : `\n${text}\n`; }
  }
}

/** Markdown for the editor's content. `tokens` turns mention chips into their id tokens. */
export function toMarkdown(root: HTMLElement, tokens = false): string {
  return Array.from(root.childNodes).map(child => convert(child, tokens)).join('')
    .replace(/\n{3,}/g, '\n\n').replace(/^\n+|\s+$/g, '');
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inlineHtml(text: string) {
  return escape(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1<i>$2</i>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

/** Editor HTML for Markdown (drafts and rewrites). */
export function fromMarkdown(source: string): string {
  const out: string[] = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith('```')) {
      const code: string[] = [];
      while (++index < lines.length && !lines[index].startsWith('```')) code.push(lines[index]);
      out.push(`<pre>${escape(code.join('\n'))}</pre>`);
    } else if (/^(- |\d+\. )/.test(line)) {
      const ordered = /^\d+\. /.test(line);
      const items: string[] = [];
      while (index < lines.length && (ordered ? /^\d+\. /.test(lines[index]) : lines[index].startsWith('- '))) items.push(lines[index++].replace(/^(- |\d+\. )/, ''));
      index--;
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map(item => `<li>${inlineHtml(item)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
    } else if (line.startsWith('> ')) {
      out.push(`<blockquote>${inlineHtml(line.slice(2))}</blockquote>`);
    } else {
      out.push(`<div>${inlineHtml(line) || '<br>'}</div>`);
    }
  }
  return out.join('');
}

/** Plain text from the start of the editor up to the caret (for @, # and / suggestions). */
export function textBeforeCaret(root: HTMLElement): string {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode)) return '';
  const range = selection.getRangeAt(0).cloneRange();
  range.setStart(root, 0);
  return range.toString().replace(/​/g, '');
}

/** Removes `count` characters just before the caret (they must be in the caret's text node). */
export function deleteBeforeCaret(count: number) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !count) return;
  const range = selection.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE || range.startOffset < count) return;
  range.setStart(node, range.startOffset - count);
  range.deleteContents();
}

/** Inserts a node at the caret and moves the caret after it. */
export function insertNodeAtCaret(node: Node) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** A mention or channel chip: shows "@name", sends its id token. */
export function chip(label: string, token: string) {
  const element = document.createElement('span');
  element.dataset.token = token;
  element.contentEditable = 'false';
  element.className = 'rounded bg-brand-soft px-0.5 font-medium text-brand';
  element.textContent = label;
  return element;
}

/** Applies a toolbar action to the selection, or to what is typed next when nothing is selected. */
export function applyFormat(action: FormatAction) {
  const command: Partial<Record<FormatAction, string>> = { bold: 'bold', italic: 'italic', strike: 'strikeThrough', bullet: 'insertUnorderedList', number: 'insertOrderedList' };
  if (command[action]) { document.execCommand(command[action]!); return; }
  if (action === 'quote') {
    const inQuote = !!window.getSelection()?.anchorNode?.parentElement?.closest('blockquote');
    document.execCommand('formatBlock', false, inQuote ? 'div' : 'blockquote');
    return;
  }
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  const current = (selection.anchorNode instanceof HTMLElement ? selection.anchorNode : selection.anchorNode?.parentElement)?.closest(action === 'code' ? 'code' : 'pre');
  if (current) { // toggle off: unwrap
    const text = document.createTextNode(current.textContent?.replace(/​/g, '') ?? '');
    current.replaceWith(text);
    return;
  }
  const element = document.createElement(action === 'code' ? 'code' : 'pre');
  element.textContent = range.toString() || '​';
  range.deleteContents();
  range.insertNode(element);
  const inside = document.createRange();
  inside.selectNodeContents(element);
  inside.collapse(false);
  selection.removeAllRanges();
  selection.addRange(inside);
}

/** Which toolbar buttons should look pressed at the caret. */
export function activeFormats(root: HTMLElement): Set<FormatAction> {
  const active = new Set<FormatAction>();
  const selection = window.getSelection();
  if (!selection?.anchorNode || !root.contains(selection.anchorNode)) return active;
  try {
    if (document.queryCommandState('bold')) active.add('bold');
    if (document.queryCommandState('italic')) active.add('italic');
    if (document.queryCommandState('strikeThrough')) active.add('strike');
    if (document.queryCommandState('insertUnorderedList')) active.add('bullet');
    if (document.queryCommandState('insertOrderedList')) active.add('number');
  } catch { /* older browsers */ }
  const element = selection.anchorNode instanceof HTMLElement ? selection.anchorNode : selection.anchorNode.parentElement;
  if (element?.closest('code')) active.add('code');
  if (element?.closest('pre')) active.add('block');
  if (element?.closest('blockquote')) active.add('quote');
  return active;
}
