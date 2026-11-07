import { API_URL } from './api';
import { apiData } from './spaces';

export type FileKind = 'image' | 'video' | 'file' | 'audio';
export type FilterKind = FileKind | 'all';
export type Person = { id: string; username: string; displayName: string | null; avatarUrl: string | null };

export type FileItem = {
  id: string; kind: FileKind; filename: string; size: number; contentType: string; createdAt: string;
  uploader: Person; messageId: string | null; postId: string | null; channelId: string | null;
  channelName: string | null; spaceId: string | null; spaceSlug: string | null; url: string;
};
export type FilePage = { items: FileItem[]; nextCursor: string | null; uploaders: Person[] };

export type FileQuery = { channelId?: string; spaceId?: string; kind: FilterKind; uploaderId: string; q: string; cursor?: string | null };

export function loadFiles(query: FileQuery): Promise<FilePage> {
  const params = new URLSearchParams({ limit: '30' });
  if (query.kind !== 'all') params.set('kind', query.kind);
  if (query.uploaderId) params.set('uploaderId', query.uploaderId);
  if (query.spaceId) params.set('spaceId', query.spaceId);
  if (query.q.trim()) params.set('q', query.q.trim());
  if (query.cursor) params.set('cursor', query.cursor);
  const path = query.channelId ? `/api/channels/${query.channelId}/files` : '/api/files';
  return apiData<FilePage>(`${path}?${params}`);
}

export const fileHref = (url: string) => (/^https?:\/\//.test(url) ? url : `${API_URL}${url}`);

/** Where a file lives: its message in the channel, or the post it was shared in. */
export function fileLocation(file: Pick<FileItem, 'messageId' | 'channelId' | 'spaceSlug' | 'postId'>) {
  if (file.channelId && file.messageId) {
    const params = new URLSearchParams();
    if (file.spaceSlug) params.set('s', file.spaceSlug);
    params.set('c', file.channelId);
    params.set('m', file.messageId);
    return `/home?${params}`;
  }
  return file.postId ? `/p/${file.postId}` : null;
}
