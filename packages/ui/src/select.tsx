'use client';

import { Children, Fragment, forwardRef, isValidElement, useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode, type SelectHTMLAttributes } from 'react';
import * as Primitive from '@radix-ui/react-select';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Button, Input } from './controls';

export type SelectOption = { value: string; label: string; disabled?: boolean };
type OptionProps = { children?: ReactNode; value?: string | number; disabled?: boolean };
const text = (node: ReactNode): string => Children.toArray(node).map(child => isValidElement<OptionProps>(child) ? text(child.props.children) : String(child ?? '')).join('');
function readOptions(children: ReactNode): SelectOption[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<OptionProps>(child)) return [];
    if (child.type === Fragment || child.type === 'optgroup') return readOptions(child.props.children);
    return [{ value: String(child.props.value ?? text(child.props.children)), label: text(child.props.children), disabled: child.props.disabled }];
  });
}

/** Radix select, retaining native form names and change-handler signatures. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { options?: SelectOption[] }>(function Select({ options: supplied, children, value, defaultValue, onChange, name, disabled, required, className = '', id, 'aria-label': label, ...props }, ref) {
  const options = supplied ?? readOptions(children);
  const [local, setLocal] = useState(String(defaultValue ?? options[0]?.value ?? ''));
  const current = String(value ?? local);
  const sink = useRef<HTMLSelectElement | null>(null);
  const empty = '__hive_empty__';
  useEffect(() => { const form = sink.current?.form; const reset = () => setLocal(String(defaultValue ?? options[0]?.value ?? '')); form?.addEventListener('reset', reset); return () => form?.removeEventListener('reset', reset); }, [defaultValue, options[0]?.value]);
  return <>
    <select ref={element => { sink.current = element; if (typeof ref === 'function') ref(element); else if (ref) ref.current = element; }} name={name} disabled={disabled} value={current} onChange={() => {}} tabIndex={-1} aria-hidden className="ui-form-value">{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
    <Primitive.Root value={current || empty} disabled={disabled} required={required} onValueChange={selected => {
      const next = selected === empty ? '' : selected; setLocal(next);
      if (sink.current) { sink.current.value = next; onChange?.({ target: sink.current, currentTarget: sink.current, type: 'change' } as ChangeEvent<HTMLSelectElement>); }
    }}>
      <Primitive.Trigger id={id} aria-label={label} aria-describedby={props['aria-describedby']} aria-invalid={props['aria-invalid']} className={`ui-select-trigger ${className}`}><Primitive.Value /><Primitive.Icon aria-hidden>⌄</Primitive.Icon></Primitive.Trigger>
      <Primitive.Portal><Primitive.Content position="popper" sideOffset={5} className="ui-select-content"><Primitive.ScrollUpButton className="ui-select-scroll">↑</Primitive.ScrollUpButton><Primitive.Viewport>{options.map(option => <Primitive.Item key={option.value} value={option.value || empty} disabled={option.disabled} className="ui-select-item"><Primitive.ItemText>{option.label || 'None'}</Primitive.ItemText><Primitive.ItemIndicator aria-hidden>✓</Primitive.ItemIndicator></Primitive.Item>)}</Primitive.Viewport><Primitive.ScrollDownButton className="ui-select-scroll">↓</Primitive.ScrollDownButton></Primitive.Content></Primitive.Portal>
    </Primitive.Root>
  </>;
});

export type ComboboxProps = { /** Options may be supplied locally or loaded as the query changes. */ options?: SelectOption[]; loadOptions?: (query: string, signal: AbortSignal) => Promise<SelectOption[]>; value?: string; onValueChange: (value: string) => void; label: string; placeholder?: string; disabled?: boolean; className?: string };

/** Searchable asynchronous picker with arrow, Enter, Home, End, and Escape support. */
export const Combobox = forwardRef<HTMLButtonElement, ComboboxProps>(function Combobox({ options = [], loadOptions, value, onValueChange, label, placeholder = 'Choose…', disabled, className = '' }, ref) {
  const [open, setOpen] = useState(false); const [query, setQuery] = useState(''); const [remote, setRemote] = useState<SelectOption[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [active, setActive] = useState(0);
  const list = (loadOptions ? remote : options).filter(option => option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const id = useId(); const input = useRef<HTMLInputElement>(null);
  const [selectedLabel, setSelectedLabel] = useState('');
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    if (!loadOptions || !open) return;
    const controller = new AbortController(); setBusy(true); setError('');
    const timer = setTimeout(() => { loadOptions(query, controller.signal).then(values => { if (!controller.signal.aborted) setRemote(values); }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load options.'); }).finally(() => { if (!controller.signal.aborted) setBusy(false); }); }, 150);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [query, open, loadOptions]);
  const choose = (option: SelectOption) => { if (option.disabled) return; setSelectedLabel(option.label); onValueChange(option.value); setOpen(false); setQuery(''); };
  return <PopoverPrimitive.Root open={open} onOpenChange={setOpen}><PopoverPrimitive.Trigger asChild><Button ref={ref} type="button" variant="secondary" disabled={disabled} role="combobox" aria-label={label} aria-controls={open ? id : undefined} aria-haspopup="listbox" aria-expanded={open} className={className}>{options.find(option => option.value === value)?.label ?? (selectedLabel || placeholder)} ⌄</Button></PopoverPrimitive.Trigger><PopoverPrimitive.Portal><PopoverPrimitive.Content className="ui-popover" sideOffset={5} onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus(); }}>
    <Input ref={input} role="combobox" aria-label={`Search ${label}`} aria-expanded={open} aria-autocomplete="list" aria-controls={id} aria-activedescendant={list[active] ? `${id}-${active}` : undefined} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); let next = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : (active + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length; for (let i = 0; i < list.length && list[next]?.disabled; i++) next = (next + (event.key === 'ArrowUp' ? -1 : 1) + list.length) % list.length; setActive(next); }
      if (event.key === 'Enter') { event.preventDefault(); if (list[active]) choose(list[active]); }
    }} />
    <div id={id} role="listbox" aria-label={label} className="ui-combobox-list">{list.map((option, index) => <button key={option.value} type="button" role="option" id={`${id}-${index}`} aria-selected={option.value === value} aria-disabled={option.disabled} tabIndex={-1} data-active={active === index} className="ui-select-item" onPointerMove={() => setActive(index)} onClick={() => choose(option)}>{option.label}</button>)}</div>
    {(busy || error || !list.length) && <p role="status" className="ui-help">{busy ? 'Loading…' : error || 'No matches'}</p>}
  </PopoverPrimitive.Content></PopoverPrimitive.Portal></PopoverPrimitive.Root>;
});
