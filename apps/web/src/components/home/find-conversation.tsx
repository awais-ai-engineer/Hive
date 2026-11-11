'use client';

import { Button as UiButton } from '@hive/ui';

import { OPEN_SEARCH } from '../search/search-palette';
import { Icon } from '../ui/icons';

/** Sidebar search field: opens the search dialog (Ctrl+K / ⌘K works from anywhere). */
export function FindConversation() {
  return <UiButton tooltip="Search (Ctrl+K)" type="button" aria-haspopup="dialog" aria-label="Search (Ctrl+K)" onClick={() => window.dispatchEvent(new Event(OPEN_SEARCH))}
    className="flex w-full items-center gap-2 rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-left justify-start text-sm text-white/65 hover:border-white/40">
    <Icon name="search" size={15} /><span className="flex-1">Search  (Ctrl+K)</span>
  </UiButton>;
}
