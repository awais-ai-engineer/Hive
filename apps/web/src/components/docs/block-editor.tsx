'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  BLOCK_CHOICES, MAX_BLOCKS, MAX_TEXT, convertBlock, makeBlock, type Block, type BlockType,
} from '../../lib/docs';
import { PopupMenu } from '../home/popup-menu';
import { Icon } from '../ui/icons';

/** Typing one of these at the start of a text block turns it into another type. */
const SHORTCUTS: [RegExp, BlockType, number?][] = [
  [/^# $/, 'heading', 1], [/^## $/, 'heading', 2], [/^### $/, 'heading', 3],
  [/^[-*] $/, 'bullet'], [/^1\. $/, 'numbered'], [/^\[\] $/, 'checklist'], [/^> $/, 'quote'], [/^```$/, 'code'],
];
const LIST_TYPES: BlockType[] = ['bullet', 'numbered', 'checklist'];

const STYLES: Record<BlockType, string> = {
  paragraph: 'text-base',
  heading: 'font-bold',
  bullet: 'text-base',
  numbered: 'text-base',
  checklist: 'text-base',
  quote: 'border-l-4 border-brand/60 pl-3 italic text-white/75',
  code: 'rounded-lg bg-[var(--surface-2)] px-3 py-2 font-mono text-sm',
  callout: 'text-base',
  divider: '',
};
const HEADING_SIZE = ['', 'text-3xl', 'text-2xl', 'text-xl'];
const PLACEHOLDERS: Partial<Record<BlockType, string>> = {
  paragraph: "Type '/' for commands", heading: 'Heading', bullet: 'List item', numbered: 'List item',
  checklist: 'To-do', quote: 'Quote', code: 'Code', callout: 'Write a note',
};

type Focus = { id: string; pos?: number | 'end' };

function GrowingText({ value, onChange, onKeyDown, onBlur, readOnly, className, placeholder, label, setRef, maxLength }: {
  value: string; onChange: (value: string) => void; onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void; onBlur?: () => void;
  readOnly: boolean; className: string; placeholder?: string; label: string;
  setRef: (element: HTMLTextAreaElement | null) => void; maxLength: number;
}) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const element = own.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);
  return <textarea ref={element => { own.current = element; setRef(element); }} rows={1} value={value} readOnly={readOnly}
    aria-label={label} placeholder={readOnly ? undefined : placeholder} maxLength={maxLength} spellCheck
    onChange={event => onChange(event.target.value)} onKeyDown={onKeyDown} onBlur={onBlur}
    className={`block w-full resize-none overflow-hidden border-0 bg-transparent p-0 leading-relaxed outline-none placeholder:text-white/35 ${className}`} />;
}

/** A Notion-style block editor: one auto-growing text box per block, no editor library. */
export function BlockEditor({ blocks, onChange, readOnly = false }: {
  blocks: Block[]; onChange: (blocks: Block[]) => void; readOnly?: boolean;
}) {
  const refs = useRef(new Map<string, HTMLTextAreaElement | HTMLElement>());
  const [focus, setFocus] = useState<Focus | null>(null);
  const [slash, setSlash] = useState<{ id: string; index: number } | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!focus) return;
    const element = refs.current.get(focus.id);
    if (element) {
      element.focus();
      if (element instanceof HTMLTextAreaElement) {
        const pos = focus.pos === 'end' || focus.pos === undefined ? element.value.length : focus.pos;
        element.setSelectionRange(pos, pos);
      }
    }
    setFocus(null);
  }, [focus, blocks]);

  const numbers = useMemo(() => {
    let count = 0;
    return blocks.map(block => { count = block.type === 'numbered' ? count + 1 : 0; return count; });
  }, [blocks]);

  const update = (id: string, patch: Partial<Block>) => onChange(blocks.map(block => block.id === id ? { ...block, ...patch } : block));
  const replace = (id: string, next: Block) => onChange(blocks.map(block => block.id === id ? next : block));
  const insertAfter = (index: number, block: Block) => {
    if (blocks.length >= MAX_BLOCKS) return;
    onChange([...blocks.slice(0, index + 1), block, ...blocks.slice(index + 1)]);
    setFocus({ id: block.id, pos: 0 });
  };
  const remove = (index: number, focusPrevious = true) => {
    const next = blocks.filter((_, position) => position !== index);
    onChange(next.length ? next : [makeBlock()]);
    const target = next[index - 1] ?? next[index];
    if (focusPrevious && target) setFocus({ id: target.id, pos: 'end' });
  };
  const move = (index: number, by: number) => {
    const target = index + by;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  function applyChoice(block: Block, choice: typeof BLOCK_CHOICES[number]) {
    setSlash(null);
    const next = convertBlock({ ...block, text: '' }, choice.type, choice.level);
    if (choice.type !== 'divider') { replace(block.id, next); setFocus({ id: block.id }); return; }
    // A divider has no text, so the cursor moves on to the block after it.
    const index = blocks.findIndex(item => item.id === block.id);
    const following = blocks[index + 1] ?? makeBlock();
    onChange([...blocks.slice(0, index), next, following, ...blocks.slice(index + 2)]);
    setFocus({ id: following.id, pos: 0 });
  }

  function changeText(block: Block, value: string) {
    if (block.type === 'paragraph') {
      for (const [pattern, type, level] of SHORTCUTS) {
        if (pattern.test(value)) { replace(block.id, convertBlock({ ...block, text: '' }, type, level)); setFocus({ id: block.id }); return; }
      }
    }
    const filter = value.startsWith('/') && !value.includes(' ') && block.type === 'paragraph';
    setSlash(filter ? { id: block.id, index: 0 } : null);
    update(block.id, { text: value });
  }

  function choicesFor(block: Block) {
    const query = block.text.slice(1).toLowerCase();
    return BLOCK_CHOICES.filter(choice => !query || `${choice.label} ${choice.keywords}`.toLowerCase().includes(query));
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>, block: Block, index: number) {
    const element = event.currentTarget;
    const atStart = element.selectionStart === 0 && element.selectionEnd === 0;
    const atEnd = element.selectionStart === element.value.length && element.selectionEnd === element.value.length;
    if (event.nativeEvent.isComposing) return;

    if (slash?.id === block.id) {
      const choices = choicesFor(block);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setSlash({ id: block.id, index: (slash.index + step + choices.length) % Math.max(choices.length, 1) });
        return;
      }
      if (event.key === 'Enter' && choices.length) { event.preventDefault(); applyChoice(block, choices[Math.min(slash.index, choices.length - 1)]); return; }
      if (event.key === 'Escape') { event.preventDefault(); setSlash(null); return; }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      if (block.type === 'code') return; // a new line inside the code block
      event.preventDefault();
      if (LIST_TYPES.includes(block.type) && block.text === '') { replace(block.id, convertBlock(block, 'paragraph')); setFocus({ id: block.id }); return; }
      const before = block.text.slice(0, element.selectionStart);
      const after = block.text.slice(element.selectionEnd);
      const keep = LIST_TYPES.includes(block.type) ? block.type : block.type === 'quote' || block.type === 'callout' ? block.type : 'paragraph';
      const created = makeBlock(keep, after, keep === 'callout' ? { emoji: block.emoji } : {});
      if (blocks.length >= MAX_BLOCKS) return;
      onChange([...blocks.slice(0, index), { ...block, text: before }, created, ...blocks.slice(index + 1)]);
      setFocus({ id: created.id, pos: 0 });
    } else if (event.key === 'Backspace' && atStart) {
      if (block.text === '') {
        event.preventDefault();
        if (block.type !== 'paragraph') { replace(block.id, convertBlock(block, 'paragraph')); setFocus({ id: block.id }); }
        else if (blocks.length > 1) remove(index);
      } else if (block.type !== 'paragraph' && block.type !== 'code') {
        event.preventDefault();
        replace(block.id, convertBlock(block, 'paragraph'));
        setFocus({ id: block.id, pos: 0 });
      }
    } else if (event.key === 'ArrowUp' && atStart && index > 0) {
      event.preventDefault(); setFocus({ id: blocks[index - 1].id, pos: 'end' });
    } else if (event.key === 'ArrowDown' && atEnd && index < blocks.length - 1) {
      event.preventDefault(); setFocus({ id: blocks[index + 1].id, pos: 0 });
    } else if ((event.altKey || event.metaKey) && event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault(); move(index, event.key === 'ArrowUp' ? -1 : 1);
    }
  }

  function dividerKey(event: KeyboardEvent<HTMLElement>, block: Block, index: number) {
    if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); remove(index); }
    else if (event.key === 'Enter') { event.preventDefault(); insertAfter(index, makeBlock()); }
    else if (event.key === 'ArrowUp' && index > 0) { event.preventDefault(); setFocus({ id: blocks[index - 1].id, pos: 'end' }); }
    else if (event.key === 'ArrowDown' && index < blocks.length - 1) { event.preventDefault(); setFocus({ id: blocks[index + 1].id, pos: 0 }); }
  }

  const register = (id: string) => (element: HTMLElement | null) => { if (element) refs.current.set(id, element); else refs.current.delete(id); };
  const menuBlock = menu ? blocks.find(block => block.id === menu.id) : null;
  const menuIndex = menuBlock ? blocks.indexOf(menuBlock) : -1;

  return <div className="space-y-0.5" role="group" aria-label="Document">
    {blocks.map((block, index) => {
      const text = block.type === 'divider'
        ? <div ref={register(block.id)} tabIndex={readOnly ? -1 : 0} role="separator" aria-label="Divider" onKeyDown={event => !readOnly && dividerKey(event, block, index)}
          className="rounded py-2.5 focus:bg-brand-soft focus:outline-none"><hr className="border-white/20" /></div>
        : <GrowingText value={block.text} readOnly={readOnly} maxLength={MAX_TEXT}
          label={`${block.type === 'heading' ? `Heading ${block.level}` : block.type} block`}
          placeholder={block.type === 'paragraph' && blocks.length > 1 ? undefined : PLACEHOLDERS[block.type]} setRef={register(block.id)}
          className={`${STYLES[block.type]} ${block.type === 'heading' ? HEADING_SIZE[block.level ?? 1] : ''} ${block.type === 'checklist' && block.checked ? 'text-white/45 line-through' : ''}`}
          onChange={value => changeText(block, value)} onKeyDown={event => keyDown(event, block, index)} onBlur={() => setSlash(current => current?.id === block.id ? null : current)} />;
      const slashChoices = slash?.id === block.id ? choicesFor(block) : null;
      return <div key={block.id} className="group/block relative flex items-start gap-1">
        {!readOnly && <button type="button" aria-label="Block options" aria-haspopup="menu" title="Change, move or delete this block"
          onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setMenu({ id: block.id, x: box.left, y: box.bottom + 4 }); }}
          className="mt-1 shrink-0 rounded p-0.5 text-white/30 hover:bg-[var(--surface-2)] hover:text-white focus-visible:text-white sm:opacity-0 sm:group-hover/block:opacity-100 sm:focus-visible:opacity-100">
          <Icon name="grip" size={16} /></button>}
        {readOnly && <span className="w-5 shrink-0" />}
        <div className={`min-w-0 flex-1 py-0.5 ${block.type === 'callout' ? 'flex gap-3 rounded-xl bg-brand-soft p-3' : block.type === 'divider' ? '' : 'flex gap-2'}`}>
          {block.type === 'bullet' && <span aria-hidden className="mt-0.5 w-4 shrink-0 text-center text-white/60">•</span>}
          {block.type === 'numbered' && <span aria-hidden className="mt-0.5 w-5 shrink-0 text-right text-white/60">{numbers[index]}.</span>}
          {block.type === 'checklist' && <input type="checkbox" checked={!!block.checked} disabled={readOnly} aria-label="Done"
            onChange={event => update(block.id, { checked: event.target.checked })} className="mt-1.5 h-4 w-4 shrink-0 accent-[var(--brand)]" />}
          {block.type === 'callout' && <span aria-hidden className="text-xl leading-relaxed">{block.emoji ?? '💡'}</span>}
          <div className="relative min-w-0 flex-1">
            {text}
            {slashChoices && !readOnly && <div role="listbox" aria-label="Block types" className="on-surface absolute left-0 top-full z-20 mt-1 max-h-64 w-64 max-w-[80vw] overflow-y-auto rounded-xl border border-white/10 bg-surface p-1 text-sm shadow-[var(--shadow-pop)]">
              {slashChoices.length === 0 && <p className="px-3 py-2 text-white/55">No matching block type</p>}
              {slashChoices.map((choice, position) => <button key={choice.label} type="button" role="option" aria-selected={position === slash!.index}
                onMouseDown={event => { event.preventDefault(); applyChoice(block, choice); }}
                className={`flex w-full flex-col rounded-lg px-3 py-1.5 text-left ${position === slash!.index ? 'bg-brand-soft' : 'hover:bg-[var(--surface-2)]'}`}>
                <span className="font-medium">{choice.label}</span><span className="text-xs text-white/50">{choice.hint}</span></button>)}
            </div>}
          </div>
        </div>
      </div>;
    })}
    {!readOnly && <button type="button" onClick={() => insertAfter(blocks.length - 1, makeBlock())} disabled={blocks.length >= MAX_BLOCKS}
      className="ml-6 mt-2 flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-white/50 hover:bg-[var(--surface-2)] hover:text-white disabled:opacity-40">
      <Icon name="plus" size={14} />Add a block</button>}
    {menu && menuBlock && <PopupMenu at={menu} label="Block options" onClose={() => setMenu(null)} items={[
      { heading: 'Turn into' },
      ...BLOCK_CHOICES.map(choice => ({
        label: choice.label, checked: menuBlock.type === choice.type && (menuBlock.level ?? 1) === (choice.level ?? 1),
        onSelect: () => { replace(menuBlock.id, convertBlock(menuBlock, choice.type, choice.level)); setFocus({ id: menuBlock.id }); },
      })),
      { separator: true },
      { label: 'Move up', onSelect: () => move(menuIndex, -1) },
      { label: 'Move down', onSelect: () => move(menuIndex, 1) },
      { label: 'Add a block below', icon: 'plus', onSelect: () => insertAfter(menuIndex, makeBlock()) },
      { separator: true },
      { label: 'Delete block', icon: 'trash', danger: true, onSelect: () => remove(menuIndex, false) },
    ]} />}
  </div>;
}
