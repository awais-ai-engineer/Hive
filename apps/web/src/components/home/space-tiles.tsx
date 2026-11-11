'use client';

import { Button as UiButton } from '@hive/ui';

import { useId, useState, type CSSProperties } from 'react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { colourFor, initials, Tooltip } from '@hive/ui';
import { API_URL } from '../../lib/api';
import type { Space } from '../../lib/spaces';

/** Image or two-letter fallback shared by desktop and mobile space tiles. */
export function SpaceIcon({ space }: { space: Space }) {
  const [failed, setFailed] = useState<string | null>(null);
  const src = space.iconUrl?.startsWith('/') ? `${API_URL}${space.iconUrl}` : space.iconUrl;
  const tileColor = /^#[0-9a-fA-F]{6}$/.test(space.color) ? space.color : colourFor(space.name);
  return <span role="img" aria-label={space.name} className="space-icon" style={{ '--space-icon-color': tileColor, color: 'var(--avatar-fg)' } as CSSProperties}>
    {src && failed !== src ? <img src={src} alt="" onError={() => setFailed(src)} className="h-full w-full rounded-[12px] object-cover" /> : <span aria-hidden className="hive-initials" data-initials={initials(space.name)} />}
    {space.mentionCount > 0 ? <span role="img" className="space-mention" data-count={space.mentionCount > 99 ? '99+' : space.mentionCount} aria-label={`${space.mentionCount} unread mentions`} />
      : space.unreadCount > 0 && <span role="img" className="space-unread" aria-label={`${space.unreadCount} unread messages`} />}
  </span>;
}

function SortableTile({ space, active, expanded, onSwitch, disabled }: { space: Space; active: boolean; expanded: boolean; onSwitch: (slug: string) => void; disabled: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: space.id, disabled });
  return <Tooltip content={space.name}><UiButton ref={setNodeRef} type="button" {...attributes} {...listeners}
    aria-label={expanded ? undefined : space.name} aria-current={active ? 'page' : undefined} onClick={() => onSwitch(space.slug)}
    style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 2 : undefined } as CSSProperties}
    className={`space-row ${active ? 'space-current' : ''} ${isDragging ? 'opacity-70' : ''}`}>
    <SpaceIcon space={space} />
    {expanded && <><span className="min-w-0 flex-1 text-left justify-start"><span className="block truncate text-sm font-semibold">{space.name}</span><span className="block text-xs text-rail-muted">{space.member_count} members</span></span>
      {space.unreadCount > 0 && <span className="text-xs text-rail-muted">{space.unreadCount > 99 ? '99+' : space.unreadCount}</span>}</>}
  </UiButton></Tooltip>;
}

/** Each group owns its drag context so a tile cannot cross the work/social divider. */
export function SpaceTiles({ spaces, current, expanded, onSwitch, onOrder, disabled }: {
  spaces: Space[]; current: string | null; expanded: boolean; onSwitch: (slug: string) => void; onOrder: (ids: string[]) => void; disabled: boolean;
}) {
  const id = useId();
  const [dragging, setDragging] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  return <div className="space-group" data-dragging={dragging}>
    <DndContext id={id} sensors={sensors} collisionDetection={closestCenter} onDragStart={() => setDragging(true)} onDragCancel={() => setDragging(false)}
      onDragEnd={({ active, over }) => {
        setDragging(false);
        if (!over || active.id === over.id) return;
        const ids = spaces.map(space => space.id);
        onOrder(arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))));
      }}>
      <SortableContext items={spaces.map(space => space.id)} strategy={verticalListSortingStrategy}>
        {spaces.map(space => <SortableTile key={space.id} space={space} active={space.slug === current} expanded={expanded} onSwitch={onSwitch} disabled={disabled} />)}
      </SortableContext>
    </DndContext>
  </div>;
}
