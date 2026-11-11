'use client';

import { forwardRef, useRef, type ComponentRef, type ReactNode } from 'react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import * as Context from '@radix-ui/react-context-menu';
import { Tooltip } from './tooltip';

export type MenuAction = { /** Accessible action text and callback. */ label: string; onSelect?: () => void; disabled?: boolean; danger?: boolean; separator?: boolean; children?: MenuAction[] };

/** Click/keyboard menu with roving focus and Escape dismissal. */
export const DropdownMenu = forwardRef<ComponentRef<typeof Dropdown.Content>, { trigger: ReactNode; items: MenuAction[]; label: string; header?: ReactNode; triggerTooltip?: ReactNode; className?: string }>(function DropdownMenu({ trigger, items, label, header, triggerTooltip, className = '' }, ref) {
  const renderItem = (item: MenuAction, index: number) => item.separator
    ? <Dropdown.Separator key={index} className="ui-separator" />
    : item.children
      ? <Dropdown.Sub key={index}><Dropdown.SubTrigger disabled={item.disabled} data-danger={item.danger} className="ui-menu-item">{item.label}<span aria-hidden>›</span></Dropdown.SubTrigger><Dropdown.Portal><Dropdown.SubContent sideOffset={6} className="ui-menu">{item.children.map(renderItem)}</Dropdown.SubContent></Dropdown.Portal></Dropdown.Sub>
      : <Dropdown.Item key={index} disabled={item.disabled} onSelect={() => item.onSelect?.()} data-danger={item.danger} className="ui-menu-item">{item.label}</Dropdown.Item>;
  const triggerElement = <Dropdown.Trigger asChild>{trigger}</Dropdown.Trigger>;
  return <Dropdown.Root>{triggerTooltip ? <Tooltip content={triggerTooltip}>{triggerElement}</Tooltip> : triggerElement}<Dropdown.Portal><Dropdown.Content ref={ref} aria-label={label} sideOffset={5} className={`ui-menu ${className}`}>{header && <Dropdown.Label className="ui-menu-header">{header}</Dropdown.Label>}{items.map(renderItem)}</Dropdown.Content></Dropdown.Portal></Dropdown.Root>;
});
/** Pointer right-click and keyboard context menu using the same action model. */
export const ContextMenu = forwardRef<ComponentRef<typeof Context.Content>, { children: ReactNode; items: MenuAction[]; label: string; className?: string; disabled?: boolean }>(function ContextMenu({ children, items, label, className = '', disabled }, ref) {
  return <Context.Root><Context.Trigger asChild disabled={disabled}>{children}</Context.Trigger><Context.Portal><Context.Content ref={ref} aria-label={label} className={`ui-menu ${className}`}>{items.map((item, index) => <Context.Item key={index} disabled={item.disabled} onSelect={() => item.onSelect?.()} data-danger={item.danger} className="ui-menu-item">{item.label}</Context.Item>)}</Context.Content></Context.Portal></Context.Root>;
});

export type PointMenuItem = { heading: string } | { separator: true } | (MenuAction & { icon?: ReactNode; checked?: boolean });

/** Radix menu anchored to a pointer/button position for existing action menus. */
export const PointMenu = forwardRef<ComponentRef<typeof Dropdown.Content>, { at: { x: number; y: number }; items: PointMenuItem[]; label: string; onClose: () => void; className?: string }>(function PointMenu({ at, items, label, onClose, className = '' }, ref) {
  const previous = useRef<HTMLElement | null>(typeof document === 'undefined' ? null : document.activeElement as HTMLElement);
  return <Dropdown.Root open onOpenChange={open => { if (!open) onClose(); }}><Dropdown.Trigger aria-hidden tabIndex={-1} style={{ position: 'fixed', left: at.x, top: at.y, width: 1, height: 1, pointerEvents: 'none', opacity: 0 }} /><Dropdown.Portal><Dropdown.Content ref={ref} aria-label={label} align="start" sideOffset={0} collisionPadding={8} className={`ui-menu ${className}`} onCloseAutoFocus={event => { event.preventDefault(); previous.current?.focus(); }}>
    {items.map((item, index) => 'heading' in item ? <Dropdown.Label key={index} className="ui-help">{item.heading}</Dropdown.Label> : 'separator' in item ? <Dropdown.Separator key={index} className="ui-separator" /> : item.checked === undefined
      ? <Dropdown.Item key={index} disabled={item.disabled} onSelect={() => { onClose(); item.onSelect?.(); }} data-danger={item.danger} className="ui-menu-item">{item.icon}<span>{item.label}</span></Dropdown.Item>
      : <Dropdown.CheckboxItem key={index} checked={item.checked} disabled={item.disabled} onSelect={() => { onClose(); item.onSelect?.(); }} className="ui-menu-item"><span>{item.label}</span><Dropdown.ItemIndicator>✓</Dropdown.ItemIndicator></Dropdown.CheckboxItem>)}
  </Dropdown.Content></Dropdown.Portal></Dropdown.Root>;
});
