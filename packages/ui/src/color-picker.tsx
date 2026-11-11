'use client';

import { forwardRef, useEffect, useState, type InputHTMLAttributes, type ChangeEvent } from 'react';
import { Button, Input } from './controls';

/** Accent swatches and a validated hex field; preset colours come from theme tokens. */
export const ColorPicker = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { presets?: string[] }>(function ColorPicker({ value, defaultValue, onChange, presets: supplied, className = '', 'aria-label': label = 'Accent colour', ...props }, ref) {
  const [presets, setPresets] = useState<string[]>(supplied ?? []); const [draft, setDraft] = useState(String(value ?? defaultValue ?? '')); const [error, setError] = useState('');
  useEffect(() => { if (value !== undefined) setDraft(String(value)); }, [value]);
  useEffect(() => { if (!supplied) setPresets(['amber', 'blue', 'green', 'purple'].map(name => getComputedStyle(document.documentElement).getPropertyValue(`--accent-preset-${name}`).trim())); }, [supplied]);
  const apply = (next: string) => { if (!/^#[0-9a-f]{6}$/i.test(next)) { setError('Use a six-digit hex colour.'); return; } setError(''); setDraft(next); onChange?.({ target: { value: next }, currentTarget: { value: next } } as ChangeEvent<HTMLInputElement>); };
  return <span className={`ui-field ${className}`}><span role="group" aria-label={`${label} presets`} className="ui-swatches">{presets.map((color, index) => <Button key={color || index} type="button" aria-label={`Accent preset ${index + 1}`} aria-pressed={draft.toLowerCase() === color.toLowerCase()} className="ui-swatch" style={{ background: color }} onClick={() => apply(color)} />)}</span><Input {...props} ref={ref} aria-label={label} value={draft} error={error} onChange={event => setDraft(event.target.value)} onBlur={() => apply(draft)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); apply(draft); } }} /></span>;
});
