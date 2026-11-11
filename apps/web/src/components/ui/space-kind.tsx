
import { Tooltip as UiTooltip } from '@hive/ui';
import type { Space } from '../../lib/spaces';
import { spaceKindLabel } from '../../lib/spaces';
import { Icon } from './icons';

/** Tiny lock (private workspace) or globe (public community) marker with an accessible label. */
export function SpaceKind({ space, size = 13, className = '' }: { space: Pick<Space, 'type'>; size?: number; className?: string }) {
  const label = spaceKindLabel(space);
  return <UiTooltip content={label}><span role="img" aria-label={label} className={`inline-flex shrink-0 items-center opacity-70 ${className}`}>
    <Icon name={space.type === 'workspace' ? 'lock' : 'globe'} size={size} />
  </span></UiTooltip>;
}
