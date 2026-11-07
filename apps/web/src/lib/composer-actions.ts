import type { CiphertextBox } from '@hive/shared';
export type FormatAction = 'bold' | 'italic' | 'strike' | 'code' | 'block' | 'bullet' | 'number' | 'quote';
export type ComposerSendOptions = {
  kind?: 'text' | 'poll' | 'voice'; poll?: { question: string; options: string[] };
  /** Photos and videos that each recipient can open only once. */
  viewOnce?: boolean;
  /** Secret conversations: the encrypted message, and the text it was made from (kept on this device only). */
  ciphertext?: CiphertextBox; plain?: string;
};
export const formats: { id: FormatAction; label: string; mark: string; shortcut: string }[] = [
  { id: 'bold', label: 'Bold', mark: 'B', shortcut: 'Ctrl/Cmd+B' }, { id: 'italic', label: 'Italic', mark: 'I', shortcut: 'Ctrl/Cmd+I' },
  { id: 'strike', label: 'Strike', mark: 'S', shortcut: 'Ctrl/Cmd+Shift+X' }, { id: 'code', label: 'Code', mark: '<>', shortcut: 'Ctrl/Cmd+E' },
  { id: 'block', label: 'Code block', mark: '{ }', shortcut: 'Ctrl/Cmd+Shift+C' }, { id: 'bullet', label: 'Bulleted list', mark: '•', shortcut: 'Ctrl/Cmd+Shift+8' },
  { id: 'number', label: 'Numbered list', mark: '1.', shortcut: 'Ctrl/Cmd+Shift+7' }, { id: 'quote', label: 'Quote', mark: '❯', shortcut: 'Ctrl/Cmd+Shift+9' },
];
export function formatSelection(value: string, start: number, end: number, action: FormatAction) {
  const markers: Partial<Record<FormatAction, string>> = { bold: '**', italic: '*', strike: '~~', code: '`' };
  const mark = markers[action];
  const selected = value.slice(start, end);
  if (mark) {
    if (value.slice(Math.max(0,start-mark.length),start) === mark && value.slice(end,end+mark.length) === mark) return { value: value.slice(0,start-mark.length)+selected+value.slice(end+mark.length), start: start-mark.length, end: end-mark.length };
    if (selected.startsWith(mark) && selected.endsWith(mark) && selected.length >= mark.length*2) return { value: value.slice(0,start)+selected.slice(mark.length,-mark.length)+value.slice(end), start, end:end-mark.length*2 };
    return { value: value.slice(0,start)+mark+selected+mark+value.slice(end), start:start+mark.length, end:end+mark.length };
  }
  if (action === 'block') {
    const prefix = '```\n', suffix = '\n```';
    if (value.slice(Math.max(0,start-prefix.length),start) === prefix && value.slice(end,end+suffix.length) === suffix) return { value:value.slice(0,start-prefix.length)+selected+value.slice(end+suffix.length), start:start-prefix.length, end:end-prefix.length };
    return { value: value.slice(0,start)+prefix+selected+suffix+value.slice(end), start:start+prefix.length, end:end+prefix.length };
  }
  const from = value.lastIndexOf('\n',start-1)+1;
  const nextLine = value.indexOf('\n',end); const to = nextLine < 0 ? value.length : nextLine;
  const lines = value.slice(from,to).split('\n');
  const prefix = action === 'bullet' ? '- ' : action === 'number' ? '1. ' : '> ';
  const remove = lines.every(line => line.startsWith(prefix));
  const text = lines.map(line => remove ? line.slice(prefix.length) : prefix+line).join('\n');
  return { value:value.slice(0,from)+text+value.slice(to), start:from, end:from+text.length };
}
export function pollCommand(source: string) {
  const words: string[] = [];
  const expression = /"([^"\\]*(?:\\.[^"\\]*)*)"/g;
  let end = 0;
  for (const match of source.matchAll(expression)) {
    if (source.slice(end,match.index).trim()) throw new Error('Use /poll "Question" "A" "B" (2–10 options).');
    words.push(match[1].replace(/\\(["\\])/g,'$1')); end=match.index!+match[0].length;
  }
  if (source.slice(end).trim() || words.length<3 || words.length>11 || words.some(word => !word.trim()) || words[0].length>200 || words.slice(1).some(word => word.length>80)) throw new Error('Use /poll "Question" "A" "B" (2–10 options).');
  return { question:words[0], options:words.slice(1) };
}
