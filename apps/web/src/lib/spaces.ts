export type Space = {
  id: string;
  type: 'community' | 'workspace';
  name: string;
  slug: string;
  description: string | null;
  allowed_email_domain: string | null;
  created_at: string;
  member_count: number;
  public_chat: boolean;
  my_role: 'owner' | 'admin' | 'moderator' | 'member' | 'guest' | null;
};

export type Channel = {
  id: string;
  space_id: string;
  type: 'text' | 'voice';
  name: string;
  topic: string | null;
  position: number;
  unread: number;
  is_private: boolean;
};

export type Member = {
  user: { id: string; username: string; avatar_url: string | null };
  role: Space['my_role'];
  joined_at: string;
  online: boolean;
};

export async function apiData<T>(path: string, init?: RequestInit): Promise<T> {
  const { apiFetch, responseData } = await import('./api');
  return responseData<T>(await apiFetch(path, init));
}

export function requestError(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export const spaceKindLabel = (space: Pick<Space, 'type'>) => space.type === 'workspace' ? 'Private workspace' : 'Public community';
