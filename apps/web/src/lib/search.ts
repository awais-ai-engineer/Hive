import { loadSetting, saveSetting } from './home';
import { apiData } from './spaces';

export type Segment = { text: string; match: boolean };
export type HitType = 'message' | 'post' | 'comment' | 'person' | 'channel' | 'file';
export type SearchType = 'all' | 'messages' | 'posts' | 'comments' | 'people' | 'channels' | 'files';
export type Hit = {
  type: HitType; id: string; createdAt: string | null; title: Segment[]; snippet: Segment[];
  author: { id: string; username: string; displayName: string | null; avatarUrl: string | null } | null;
  place: { spaceId: string | null; spaceSlug: string | null; spaceName: string | null; channelId: string | null; channelName: string | null; isDm: boolean } | null;
  messageId: string | null; parentId: string | null; postId: string | null; commentId: string | null;
  url: string | null; fileKind: string | null; size: number | null;
};
export type SearchResponse = { q: string; type: SearchType; groups: Record<string, Hit[]> | null; items: Hit[] | null; nextCursor: string | null };
export type SearchFilters = { spaceId: string; authorId: string; from: string; to: string };
export const NO_FILTERS: SearchFilters = { spaceId: '', authorId: '', from: '', to: '' };

export const TYPE_TABS: [SearchType, string][] = [
  ['all', 'All'], ['messages', 'Messages'], ['posts', 'Posts'], ['comments', 'Comments'],
  ['people', 'People'], ['channels', 'Channels'], ['files', 'Files'],
];
export const GROUP_LABELS: Record<string, string> = {
  messages: 'Messages', posts: 'Posts', comments: 'Comments', people: 'People', channels: 'Channels', files: 'Files',
};

export function runSearch(q: string, type: SearchType, filters: SearchFilters, cursor?: string | null): Promise<SearchResponse> {
  const params = new URLSearchParams({ q, type, limit: '20' });
  if (filters.spaceId) params.set('spaceId', filters.spaceId);
  if (filters.authorId) params.set('authorId', filters.authorId);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (cursor) params.set('cursor', cursor);
  return apiData<SearchResponse>(`/api/search?${params}`);
}

export function hitHref(hit: Hit): string | null {
  const place = hit.place;
  if (hit.type === 'person') return hit.author ? `/u/${hit.author.username}` : null;
  if (hit.type === 'post') return `/p/${hit.id}`;
  if (hit.type === 'comment') return `/p/${hit.postId}`;
  if (hit.type === 'channel' || hit.type === 'message' || (hit.type === 'file' && hit.messageId)) {
    if (!place?.channelId) return null;
    const params = new URLSearchParams();
    if (place.spaceSlug) params.set('s', place.spaceSlug);
    params.set('c', place.channelId);
    if (hit.parentId) params.set('t', hit.parentId);
    if (hit.messageId) params.set('m', hit.messageId);
    return `/home?${params}`;
  }
  return hit.postId ? `/p/${hit.postId}` : null;
}

export function hitPlace(hit: Hit): string {
  const place = hit.place;
  if (!place) return '';
  if (place.isDm) return `Chat with ${place.channelName}`;
  if (hit.type === 'message' || hit.type === 'file' || hit.type === 'channel') {
    return [place.channelName ? `#${place.channelName}` : '', place.spaceName].filter(Boolean).join(' · ');
  }
  return place.spaceName ?? '';
}

const RECENT = 'hive:recent-searches';
export const recentSearches = () => loadSetting<string[]>(RECENT, []);
export function rememberSearch(q: string) {
  const term = q.trim();
  if (term.length < 2) return;
  saveSetting(RECENT, [term, ...recentSearches().filter(item => item !== term)].slice(0, 6));
}
export const clearRecentSearches = () => saveSetting(RECENT, []);
