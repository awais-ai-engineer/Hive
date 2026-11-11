'use client';

import { forwardRef, useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes, type ReactNode, type HTMLAttributes, type ComponentPropsWithoutRef, type ComponentRef } from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as RadioPrimitive from '@radix-ui/react-radio-group';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Tooltip } from './tooltip';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Visual emphasis and control size. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' | 'lg'; loading?: boolean; tooltip?: ReactNode;
} & ({ iconOnly: true; 'aria-label': string } | { iconOnly?: false });

/** Themed action with a busy state and an optional focus/hover tooltip. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'ghost', size = 'md', loading, tooltip, title, iconOnly, children, className = '', disabled, ...props }, ref) {
  const button = <button ref={ref} className={`ui-button ${className}`} data-variant={variant} data-size={size} data-icon-only={iconOnly || undefined} aria-busy={loading || undefined} disabled={disabled || loading} {...props}>{loading && <span aria-hidden className="ui-spinner" />}{children}</button>;
  return tooltip || title ? <Tooltip content={tooltip || title}>{button}</Tooltip> : button;
});

type FieldProps = { /** Optional field text; existing wrapping labels also work. */ label?: ReactNode; helpText?: string; error?: string; leadingIcon?: ReactNode };
export type InputProps = InputHTMLAttributes<HTMLInputElement> & FieldProps;

/** Text field with associated help/error text and an accessible password toggle. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, helpText, error, leadingIcon, type, className = '', id: provided, ...props }, ref) {
  const generated = useId(); const id = provided ?? generated;
  const [visible, setVisible] = useState(false);
  const describedBy = [props['aria-describedby'], helpText && `${id}-help`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  const input = <input {...props} ref={ref} id={id} type={type === 'password' && visible ? 'text' : type} aria-invalid={!!error || props['aria-invalid']} aria-describedby={describedBy} className={`ui-input ${className}`} />;
  if (!label && !helpText && !error && !leadingIcon && type !== 'password') return input;
  return <span className="ui-field">{label && <label htmlFor={id} className="ui-label">{label}</label>}<span className="ui-input-wrap">{leadingIcon && <span className="ui-leading" aria-hidden>{leadingIcon}</span>}{input}{type === 'password' && <Button type="button" className="ui-password" aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible(value => !value)}>{visible ? 'Hide' : 'Show'}</Button>}</span>{helpText && <span id={`${id}-help`} className="ui-help">{helpText}</span>}{error && <span id={`${id}-error`} role="alert" className="ui-error">{error}</span>}</span>;
});

/** Multiline field with the same label, help, and error contract as Input. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & FieldProps>(function Textarea({ label, helpText, error, leadingIcon: _icon, className = '', id: provided, ...props }, ref) {
  const generated = useId(); const id = provided ?? generated;
  const field = <textarea {...props} ref={ref} id={id} aria-invalid={!!error || props['aria-invalid']} aria-describedby={[props['aria-describedby'], helpText && `${id}-help`, error && `${id}-error`].filter(Boolean).join(' ') || undefined} className={`ui-textarea ${className}`} />;
  return label || helpText || error ? <span className="ui-field">{label && <label htmlFor={id} className="ui-label">{label}</label>}{field}{helpText && <span id={`${id}-help`} className="ui-help">{helpText}</span>}{error && <span role="alert" id={`${id}-error`} className="ui-error">{error}</span>}</span> : field;
});

/** Native form semantics inside a themed checkbox. */
export const Checkbox = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(function Checkbox({ className = '', ...props }, ref) { return <input {...props} ref={ref} type="checkbox" className={`ui-checkbox ${className}`} />; });
/** Native radio usable within existing form fieldsets. */
export const Radio = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(function Radio({ className = '', ...props }, ref) { return <input {...props} ref={ref} type="radio" className={`ui-radio ${className}`} />; });
/** Radix switch with form support and keyboard activation. */
export const Switch = forwardRef<ComponentRef<typeof SwitchPrimitive.Root>, ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>>(function Switch({ className = '', ...props }, ref) { return <SwitchPrimitive.Root {...props} ref={ref} className={`ui-switch ${className}`}><SwitchPrimitive.Thumb className="ui-switch-thumb" /></SwitchPrimitive.Root>; });
/** Arrow-key navigable radio group. */
export const RadioGroup = forwardRef<ComponentRef<typeof RadioPrimitive.Root>, ComponentPropsWithoutRef<typeof RadioPrimitive.Root> & { options: { value: string; label: string; disabled?: boolean }[] }>(function RadioGroup({ options, className = '', ...props }, ref) { const id = useId(); return <RadioPrimitive.Root {...props} ref={ref} className={`ui-radio-group ${className}`}>{options.map(option => <label key={option.value} htmlFor={`${id}-${option.value}`}><RadioPrimitive.Item id={`${id}-${option.value}`} value={option.value} disabled={option.disabled} className="ui-radio"><RadioPrimitive.Indicator className="ui-radio-indicator" /></RadioPrimitive.Item>{option.label}</label>)}</RadioPrimitive.Root>; });
/** Range input with native arrow-key support. */
export const Slider = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(function Slider({ className = '', ...props }, ref) { return <input min={0} max={100} {...props} ref={ref} type="range" className={`ui-slider ${className}`} />; });
/** Compact non-interactive status label. */
export const Badge = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement> & { tone?: 'neutral' | 'accent' | 'danger' }>(function Badge({ tone = 'neutral', className = '', ...props }, ref) { return <span {...props} ref={ref} data-tone={tone} className={`ui-badge ${className}`} />; });
/** Reduced-motion-aware loading placeholder. */
export const Skeleton = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function Skeleton({ className = '', ...props }, ref) { return <div {...props} ref={ref} aria-hidden className={`ui-skeleton ${className}`} />; });
/** Decorative or semantic horizontal divider. */
export const Separator = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function Separator({ className = '', ...props }, ref) { return <div role="separator" {...props} ref={ref} className={`ui-separator ${className}`} />; });
/** Keyboard accessible tabbed content. */
export const Tabs = forwardRef<ComponentRef<typeof TabsPrimitive.Root>, ComponentPropsWithoutRef<typeof TabsPrimitive.Root> & { items: { value: string; label: string; content: ReactNode; disabled?: boolean }[]; label: string }>(function Tabs({ items, label, className = '', ...props }, ref) { return <TabsPrimitive.Root {...props} ref={ref} className={className}><TabsPrimitive.List aria-label={label} className="ui-tab-list">{items.map(item => <TabsPrimitive.Trigger key={item.value} value={item.value} disabled={item.disabled} className="ui-tab">{item.label}</TabsPrimitive.Trigger>)}</TabsPrimitive.List>{items.map(item => <TabsPrimitive.Content key={item.value} value={item.value} className="ui-tab-panel">{item.content}</TabsPrimitive.Content>)}</TabsPrimitive.Root>; });
/** Anchored, dismissible content with focus restoration. */
export const Popover = forwardRef<ComponentRef<typeof PopoverPrimitive.Content>, ComponentPropsWithoutRef<typeof PopoverPrimitive.Root> & { trigger: ReactNode; children: ReactNode; className?: string; label: string }>(function Popover({ trigger, children, className = '', label, ...props }, ref) { return <PopoverPrimitive.Root {...props}><PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger><PopoverPrimitive.Portal><PopoverPrimitive.Content ref={ref} aria-label={label} sideOffset={6} className={`ui-popover ${className}`}>{children}</PopoverPrimitive.Content></PopoverPrimitive.Portal></PopoverPrimitive.Root>; });
