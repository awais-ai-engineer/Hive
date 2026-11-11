'use client';

import { Input as UiInput, Button as UiButton } from '@hive/ui';

import { useState } from 'react';
import { tagsSchema } from '@hive/shared';
import { Icon } from '../ui/icons';

export function TagsInput({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  function add(text: string) {
    const parsed = tagsSchema.safeParse([...value, ...text.split(',').map(item => item.trim()).filter(Boolean)]);
    if (!parsed.success) { setError('Use up to 5 tags, each 2–24 letters, digits or hyphens.'); return; }
    onChange(parsed.data); setInput(''); setError('');
  }
  return <div>
    <label className="block text-sm font-medium">Tags
      <UiInput className="auth-input" value={input} maxLength={150} aria-invalid={!!error} placeholder="Type a tag, then press Enter or comma" onChange={event => {
        if (event.target.value.includes(',')) add(event.target.value); else setInput(event.target.value);
      }} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); if (input.trim()) add(input); }
        if (event.key === 'Backspace' && !input) { onChange(value.slice(0, -1)); setError(''); }
      }} onBlur={() => { if (input.trim()) add(input); }} />
    </label>
    <div className="mt-2 flex flex-wrap items-center gap-2">{value.map(tag => <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-brand-soft pl-3 text-sm text-brand">{tag}<UiButton type="button" tooltip={`Remove ${tag}`} aria-label={`Remove ${tag}`} className="p-2" onClick={() => onChange(value.filter(item => item !== tag))}><Icon name="x" size={14} /></UiButton></span>)}<span className="text-xs text-white/60">{value.length} of 5</span></div>
    {error && <p role="alert" className="mt-2 text-sm text-rose-500">{error}</p>}
  </div>;
}
