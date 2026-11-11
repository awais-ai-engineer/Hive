"use client";

import { PointMenu } from '@hive/ui';
import { Icon, type IconName } from '../ui/icons';

export type MenuItem =
  | { heading: string }
  | { separator: true }
  | { label: string; onSelect: () => void; icon?: IconName; checked?: boolean; danger?: boolean; disabled?: boolean };

/** App icon adapter for the shared Radix action menu. */
export function PopupMenu({ at, items, label, onClose }: {
  at: { x: number; y: number }; items: MenuItem[]; label: string; onClose: () => void;
}) {
  return <PointMenu at={at} label={label} onClose={onClose} items={items.map(item => 'label' in item ? { ...item, icon: item.icon ? <Icon name={item.icon} size={16} /> : undefined } : item)} />;
}
