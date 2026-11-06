'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { emojiData, type EmojiEntry } from '../lib/emoji-data';

const groups = ['recent', 'smileys', 'people', 'nature', 'food', 'activities', 'travel', 'symbols', 'objects'];
export function EmojiPicker({ onSelect, onClose }: { onSelect: (emoji: string) => void; onClose: () => void }) {
  const [category, setCategory] = useState('smileys');
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    input.current?.focus();
    try { const saved = JSON.parse(localStorage.getItem('hive:emoji-recent') || '[]'); if (Array.isArray(saved)) setRecent(saved.filter((item): item is string => typeof item === 'string').slice(0, 24)); } catch { /* Recents are optional. */ }
  }, []);
  const choices = useMemo(() => {
    const words = query.toLowerCase().trim().split(/\s+/);
    const all: EmojiEntry[] = category === 'recent' && !query ? recent.map(emoji => emojiData.find(item => item.emoji === emoji)).filter((item): item is EmojiEntry => !!item) : emojiData;
    return all.filter(item => (query || category === 'recent' || item.category === category) && words.every(word => `${item.name} ${item.keywords.join(' ')}`.includes(word)));
  }, [category, query, recent]);
  useEffect(() => setSelected(0), [query, category]);
  function choose(emoji: string) {
    const values = [emoji, ...recent.filter(item => item !== emoji)].slice(0, 24);
    try { localStorage.setItem('hive:emoji-recent', JSON.stringify(values)); } catch { /* Storage may be unavailable. */ }
    setRecent(values); onSelect(emoji);
  }
  return <section role="dialog" aria-label="Emoji picker" className="on-surface w-80 max-w-[calc(100vw-2rem)] space-y-3 rounded-2xl border border-white/10 bg-surface p-3 text-white shadow-[var(--shadow-pop)]" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <div className="flex items-center gap-2"><label className="min-w-0 flex-1 text-sm">Find an emoji<input ref={input} className="auth-input" value={query} onChange={event => setQuery(event.target.value)} placeholder="Name or keyword" /></label><button type="button" className="btn-ghost" title="Close emoji picker" aria-label="Close emoji picker" onClick={onClose}>×</button></div>
    <div role="tablist" aria-label="Emoji categories" className="flex flex-wrap gap-1">{groups.map(group => <button type="button" key={group} role="tab" aria-selected={category === group} className={`rounded-lg px-2 py-1 text-xs capitalize ${category === group ? 'bg-brand text-white' : 'hover:bg-brand-soft'}`} onClick={() => setCategory(group)}>{group}</button>)}</div>
    <div ref={grid} role="grid" aria-label="Emoji" className="max-h-52 overflow-y-auto" onKeyDown={event => {
      const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' ? 7 : event.key === 'ArrowUp' ? -7 : 0;
      if (!offset) return;
      event.preventDefault(); const next = Math.min(Math.max(0, selected+offset), choices.length-1); setSelected(next); grid.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
    }}>{Array.from({ length: Math.ceil(choices.length/7) }, (_, row) => <div key={row} role="row" className="grid grid-cols-7">{choices.slice(row*7, row*7+7).map((entry, col) => <div key={entry.emoji} role="gridcell"><button type="button" title={entry.name} aria-label={entry.name} tabIndex={row*7+col === selected ? 0 : -1} className="flex h-10 w-10 items-center justify-center rounded-lg text-2xl hover:bg-brand-soft focus:bg-brand-soft" onFocus={() => setSelected(row*7+col)} onClick={() => choose(entry.emoji)}>{entry.emoji}</button></div>)}</div>)}</div>
    {!choices.length && <p className="text-sm text-white/65">No emoji match. Try another word or category.</p>}
  </section>;
}
