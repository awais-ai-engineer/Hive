export type MarkdownNode =
  | { type: 'text' | 'code'; value: string }
  | { type: 'break' }
  | { type: 'bold' | 'italic' | 'strike' | 'paragraph' | 'quote'; children: MarkdownNode[] }
  | { type: 'link'; href: string; children: MarkdownNode[] }
  | { type: 'codeBlock'; value: string; language?: string }
  | { type: 'list'; ordered: boolean; items: MarkdownNode[][] };

/** Only explicit, safe protocols are accepted; obfuscated schemes are never repaired. */
export function safeLinkUrl(value: string): string | null {
  const url = value.trim();
  if (/[\s\u0000-\u001f\u007f-\u009f<>"'\\]/u.test(url)) return null;
  if (!/^(https?:\/\/|mailto:)/i.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'mailto:') return parsed.pathname ? url : null;
    return parsed.hostname ? url : null;
  } catch { return null; }
}

/** Bounded parser: source is always text, never HTML. Exhausted budgets leave literal text. */
export function parseMarkdown(source: string): MarkdownNode[] {
  let nodes = 0;
  let work = 0;
  const maxNodes = 2048;
  const maxWork = 200000;
  function inline(text: string, depth = 0): MarkdownNode[] {
    if (depth >= 12 || nodes >= maxNodes || work >= maxWork) return [{ type: 'text', value: text }];
    let position = 0;
    function read(stop?: string): { children: MarkdownNode[]; closed: boolean } {
      const children: MarkdownNode[] = [];
      let plain = '';
      function flush() {
        if (plain) { children.push({ type: 'text', value: plain }); nodes++; plain = ''; }
      }
      while (position < text.length) {
        if (++work >= maxWork || nodes >= maxNodes) { plain += text.slice(position); position = text.length; break; }
        const opensNestedBold = stop === '*' && text.startsWith('**', position) && text[position + 2] !== '*';
        if (stop && !opensNestedBold && text.startsWith(stop, position)) { flush(); position += stop.length; return { children, closed: true }; }
        const start = position;
        const char = text[position];
        if (char === '\n') { flush(); children.push({ type: 'break' }); nodes++; position++; continue; }
        // Preserve identity tokens as one literal unit, including their square brackets.
        const token = (char === '@' || char === '#') ? /^[@#]\[(?:user|channel):[^\]\s]+\]/.exec(text.slice(position)) : null;
        if (token) { plain += token[0]; position += token[0].length; continue; }
        if (char === '`') {
          work += text.length - position;
          const end = text.indexOf('`', position + 1);
          if (end > position + 1 && !text.slice(position + 1, end).includes('\n')) {
            flush(); children.push({ type: 'code', value: text.slice(position + 1, end) }); nodes++; position = end + 1; continue;
          }
        }
        if (char === '[') {
          work += text.length - position;
          const labelEnd = text.indexOf('](', position + 1);
          if (labelEnd !== -1) {
            let cursor = labelEnd + 2;
            let balance = 1;
            while (cursor < text.length && balance && work++ < maxWork) {
              if (text[cursor] === '(') balance++;
              if (text[cursor] === ')') balance--;
              cursor++;
            }
            if (!balance) {
              const href = text[position - 1] === '!' ? null : safeLinkUrl(text.slice(labelEnd + 2, cursor - 1));
              if (href) { flush(); children.push({ type: 'link', href, children: inline(text.slice(position + 1, labelEnd), depth + 1) }); nodes++; }
              else plain += text.slice(position, cursor);
              position = cursor; continue;
            }
          }
        }
        if ((char === 'h' || char === 'H') && /^https?:\/\//i.test(text.slice(position, position + 8))) {
          const match = /^https?:\/\/[^\s<>"'`]+/i.exec(text.slice(position));
          if (match) {
            const value = match[0].replace(/[.,!?;:]+$/, '');
            const href = safeLinkUrl(value);
            if (href) { flush(); children.push({ type: 'link', href, children: [{ type: 'text', value }] }); nodes += 2; position += value.length; continue; }
          }
        }
        const marker = text.startsWith('**', position) ? '**' : text.startsWith('~~', position) ? '~~' : char === '*' || char === '_' ? char : null;
        if (marker && depth < 12 && children.length < maxNodes) {
          // Runs without content are literal and cannot create deep recursive trees.
          let runEnd = position;
          while (text[runEnd] === char) runEnd++;
          if (runEnd - position > 3) { plain += text.slice(position, runEnd); position = runEnd; continue; }
          position += marker.length;
          const parsed = inlineDelimited(marker, depth + 1);
          if (parsed.closed && parsed.children.length) {
            flush(); children.push({ type: marker === '**' ? 'bold' : marker === '~~' ? 'strike' : 'italic', children: parsed.children }); nodes++;
          } else plain += text.slice(start, position);
          continue;
        }
        plain += char; position++;
      }
      flush(); return { children, closed: !stop };
    }
    function inlineDelimited(marker: string, level: number): { children: MarkdownNode[]; closed: boolean } {
      if (level >= 12) return { children: [], closed: false };
      // read shares its cursor; depth is additionally bounded by a stack counter.
      depth++;
      const result = read(marker);
      depth--;
      return result;
    }
    return read().children;
  }
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const result: MarkdownNode[] = [];
  let index = 0;
  while (index < lines.length) {
    if (nodes >= maxNodes || work >= maxWork) { result.push({ type: 'text', value: lines.slice(index).join('\n') }); break; }
    const line = lines[index];
    const fence = /^```([\w+-]*)\s*$/.exec(line);
    if (fence) {
      let end = index + 1;
      while (end < lines.length && !/^```\s*$/.test(lines[end])) end++;
      if (end < lines.length) { result.push({ type: 'codeBlock', value: lines.slice(index + 1, end).join('\n'), ...(fence[1] ? { language: fence[1] } : {}) }); nodes++; index = end + 1; continue; }
    }
    const list = /^(- |\d+\. )(.*)$/.exec(line);
    if (list) {
      const ordered = list[1] !== '- ';
      const items: MarkdownNode[][] = [];
      while (index < lines.length && nodes < maxNodes) {
        const item = (ordered ? /^\d+\. (.*)$/ : /^- (.*)$/).exec(lines[index]);
        if (!item) break;
        items.push(inline(item[1])); nodes++; index++;
      }
      result.push({ type: 'list', ordered, items }); nodes++; continue;
    }
    if (line.startsWith('> ')) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].startsWith('> ')) quote.push(lines[index++].slice(2));
      result.push({ type: 'quote', children: inline(quote.join('\n')) }); nodes++; continue;
    }
    const paragraph: string[] = [line]; index++;
    while (index < lines.length && !/^(?:```|> |- |\d+\. )/.test(lines[index])) paragraph.push(lines[index++]);
    result.push({ type: 'paragraph', children: inline(paragraph.join('\n')) }); nodes++;
  }
  return result;
}
