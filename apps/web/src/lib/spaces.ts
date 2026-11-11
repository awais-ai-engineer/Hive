import type { StatusFields } from './status';

import type { Space } from '@hive/shared';
export type { Space } from '@hive/shared';

export type Channel = {
  id: string;
  space_id: string;
  type: 'text' | 'voice';
  name: string;
  topic: string | null;
  position: number;
  unread: number;
  is_private: boolean;
  disappear_after?: number | null;
};

export type Member = {
  user: { id: string; username: string; avatar_url: string | null } & StatusFields;
  role: Space['my_role'];
  joined_at: string;
  online: boolean;
  top_player?: boolean;
};

export async function apiData<T>(path: string, init?: RequestInit): Promise<T> {
  const { apiFetch, responseData } = await import('./api');
  return responseData<T>(await apiFetch(path, init));
}

export function requestError(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export const spaceKindLabel = (space: Pick<Space, 'type'>) => space.type === 'workspace' ? 'Private workspace' : 'Public community';

export const SPACES_CHANGED = 'hive:spaces';
export const sortSpaces = (spaces: Space[]) => [...spaces].sort((a, b) => Number(b.favorite) - Number(a.favorite) || (a.position ?? Infinity) - (b.position ?? Infinity) || a.name.localeCompare(b.name));
