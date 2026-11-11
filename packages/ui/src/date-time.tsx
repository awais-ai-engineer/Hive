'use client';

import { forwardRef, useEffect, useRef, useState, type ChangeEvent, type InputHTMLAttributes, type ComponentProps } from 'react';
import { DayPicker } from 'react-day-picker';
import * as Popover from '@radix-ui/react-popover';
import { Button } from './controls';
import { Select } from './select';

/** Local calendar values deliberately avoid UTC conversion. */
export const localDateValue = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const parseDate = (value: string) => { const [year, month, day] = value.slice(0, 10).split('-').map(Number); const date = new Date(year, month - 1, day); return Number.isNaN(date.getTime()) ? undefined : date; };
function useLocale(explicit?: string) { const [locale, setLocale] = useState(explicit ?? 'en-US'); useEffect(() => setLocale(explicit ?? (document.documentElement.lang || navigator.language)), [explicit]); return locale; }
type PickerProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> & { /** Optional locale override; otherwise follows the document language. */ locale?: string; label?: string };

/** DayPicker calendar with native day-grid keyboard behaviour. */
export const Calendar = forwardRef<HTMLDivElement, ComponentProps<typeof DayPicker>>(function Calendar(props, ref) { return <div ref={ref} className="ui-calendar"><DayPicker {...props} labels={{ labelDayButton: day => day.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }), ...props.labels }} /></div>; });

/** Calendar popover retaining the existing YYYY-MM-DD form/change contract. */
export const DatePicker = forwardRef<HTMLInputElement, PickerProps>(function DatePicker({ value, defaultValue, onChange, name, disabled, required, min, max, locale: explicit, label, className = '', id, 'aria-label': ariaLabel, ...props }, ref) {
  const [local, setLocal] = useState(String(defaultValue ?? '')); const [open, setOpen] = useState(false);
  const current = String(value ?? local); const locale = useLocale(explicit); const sink = useRef<HTMLInputElement | null>(null);
  const date = parseDate(current); const formatted = date ? date.toLocaleDateString(locale) : 'Choose date'; const title = label ?? ariaLabel ?? 'Date';
  const bounds = [...(min ? [{ before: parseDate(String(min))! }] : []), ...(max ? [{ after: parseDate(String(max))! }] : [])];
  return <span className="ui-picker"><input {...props} ref={element => { sink.current = element; if (typeof ref === 'function') ref(element); else if (ref) ref.current = element; }} type="hidden" name={name} value={current} disabled={disabled} />
    <Popover.Root open={open} onOpenChange={setOpen}><Popover.Trigger asChild><Button id={id} type="button" variant="secondary" disabled={disabled} aria-label={`${title}: ${formatted}`} aria-description={required ? 'Required' : undefined} className={`ui-picker-trigger ${className}`}>{formatted}<span aria-hidden>▦</span></Button></Popover.Trigger><Popover.Portal><Popover.Content className="ui-popover" aria-label={`${title} calendar`} sideOffset={5}>
      <Calendar mode="single" autoFocus selected={date} defaultMonth={date} disabled={bounds} onSelect={selected => {
        if (!selected) return; const next = localDateValue(selected); setLocal(next); setOpen(false);
        if (sink.current) { sink.current.value = next; onChange?.({ target: sink.current, currentTarget: sink.current, type: 'change' } as ChangeEvent<HTMLInputElement>); }
      }} />
      {!required && current && <Button type="button" onClick={() => { setLocal(''); setOpen(false); if (sink.current) { sink.current.value = ''; onChange?.({ target: sink.current, currentTarget: sink.current } as ChangeEvent<HTMLInputElement>); } }}>Clear date</Button>}
    </Popover.Content></Popover.Portal></Popover.Root>
  </span>;
});

/** Locale-aware hour/minute controls; saved values always remain HH:mm. */
export const TimePicker = forwardRef<HTMLInputElement, PickerProps>(function TimePicker({ value, defaultValue, onChange, locale: explicit, name, disabled, label, className = '', id, 'aria-label': ariaLabel, ...props }, ref) {
  const [local, setLocal] = useState(String(defaultValue ?? '')); const current = String(value ?? local);
  const locale = useLocale(explicit); const sink = useRef<HTMLInputElement | null>(null);
  const hour12 = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hour12;
  const hours = current ? Number(current.split(':')[0]) : 0; const minutes = current.split(':')[1] ?? '00'; const title = label ?? ariaLabel ?? 'Time';
  function change(hour: number, minute: string) { const next = `${String(hour).padStart(2, '0')}:${minute}`; setLocal(next); if (sink.current) { sink.current.value = next; onChange?.({ target: sink.current, currentTarget: sink.current, type: 'change' } as ChangeEvent<HTMLInputElement>); } }
  return <span role="group" aria-label={title} className={`ui-time-picker ${className}`} id={id}>
    <input {...props} type="hidden" name={name} disabled={disabled} value={current} ref={element => { sink.current = element; if (typeof ref === 'function') ref(element); else if (ref) ref.current = element; }} />
    <Select disabled={disabled} aria-label={`${title} hour`} value={current ? String(hour12 ? hours % 12 || 12 : hours) : ''} options={[{ value: '', label: 'Hour' }, ...Array.from({ length: hour12 ? 12 : 24 }, (_, index) => ({ value: String(hour12 ? index + 1 : index), label: String(hour12 ? index + 1 : index).padStart(2, '0') }))]} onChange={event => { if (event.target.value) change(hour12 ? Number(event.target.value) % 12 + (hours >= 12 ? 12 : 0) : Number(event.target.value), minutes); }} />
    <span aria-hidden>:</span><Select disabled={disabled} aria-label={`${title} minute`} value={current ? minutes : ''} options={[{ value: '', label: 'Min' }, ...Array.from({ length: 60 }, (_, index) => ({ value: String(index).padStart(2, '0'), label: String(index).padStart(2, '0') }))]} onChange={event => { if (event.target.value) change(hours, event.target.value); }} />
    {hour12 && <Select disabled={disabled} aria-label={`${title} period`} value={hours >= 12 ? 'pm' : 'am'} options={[{ value: 'am', label: 'AM' }, { value: 'pm', label: 'PM' }]} onChange={event => change(hours % 12 + (event.target.value === 'pm' ? 12 : 0), minutes)} />}
  </span>;
});

/** Combined date/time field for scheduling and status expiry. */
export const DateTimePicker = forwardRef<HTMLInputElement, PickerProps>(function DateTimePicker({ value, defaultValue, onChange, name, className = '', label, 'aria-label': ariaLabel, ...props }, ref) {
  const [local, setLocal] = useState(String(defaultValue ?? '')); const current = String(value ?? local); const sink = useRef<HTMLInputElement | null>(null); const title = label ?? ariaLabel ?? 'Date and time';
  const change = (date: string, time: string) => { const next = date ? `${date}T${time}` : ''; setLocal(next); if (sink.current) { sink.current.value = next; onChange?.({ target: sink.current, currentTarget: sink.current, type: 'change' } as ChangeEvent<HTMLInputElement>); } };
  return <span role="group" aria-label={title} className={`ui-date-time ${className}`}><input type="hidden" name={name} value={current} ref={element => { sink.current = element; if (typeof ref === 'function') ref(element); else if (ref) ref.current = element; }} /><DatePicker {...props} value={current.split('T')[0] ?? ''} label={`${title} date`} onChange={event => change(event.target.value, current.split('T')[1] || '09:00')} /><TimePicker {...props} value={current.split('T')[1] ?? ''} label={`${title} time`} onChange={event => change(current.split('T')[0] || localDateValue(new Date()), event.target.value)} /></span>;
});
