'use client';

import * as Primitive from '@radix-ui/react-tooltip';
import { cloneElement, forwardRef, type ComponentRef, type ReactElement, type ReactNode } from 'react';

/** Focus and hover tooltip, portalled above navigation and dialogs. */
export const Tooltip = forwardRef<ComponentRef<typeof Primitive.Content>, { children: ReactElement; content: ReactNode; side?: 'top' | 'right' | 'bottom' | 'left'; className?: string }>(function Tooltip({ children, content, side = 'right', className = '' }, ref) {
  const child = typeof children.type === 'string' && !['button', 'a', 'input', 'select', 'textarea'].includes(children.type)
    ? cloneElement(children as ReactElement<{ tabIndex?: number }>, { tabIndex: 0 }) : children;
  return <Primitive.Provider delayDuration={300}><Primitive.Root>
    <Primitive.Trigger asChild>{child}</Primitive.Trigger>
    <Primitive.Portal><Primitive.Content ref={ref} side={side} sideOffset={8} className={`hive-tooltip ${className}`}>{content}<Primitive.Arrow className="hive-tooltip-arrow" /></Primitive.Content></Primitive.Portal>
  </Primitive.Root></Primitive.Provider>;
});
