'use client';

import * as Primitive from '@radix-ui/react-tooltip';
import type { ReactElement, ReactNode } from 'react';

/** Focus and hover tooltip, portalled above navigation and dialogs. */
export function Tooltip({ children, content, side = 'right' }: { children: ReactElement; content: ReactNode; side?: 'top' | 'right' | 'bottom' | 'left' }) {
  return <Primitive.Provider delayDuration={300}><Primitive.Root>
    <Primitive.Trigger asChild>{children}</Primitive.Trigger>
    <Primitive.Portal><Primitive.Content side={side} sideOffset={8} className="hive-tooltip">{content}<Primitive.Arrow className="hive-tooltip-arrow" /></Primitive.Content></Primitive.Portal>
  </Primitive.Root></Primitive.Provider>;
}
