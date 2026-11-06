import { apiData } from './spaces';
import { apiFetch, responseData } from './api';

export type BlockType = 'heading' | 'paragraph' | 'bullet' | 'numbered' | 'checklist' | 'quote' | 'code' | 'divider' | 'callout';

export type Block = {
  id: string;
  type: BlockType;
  text: string;
  level?: number;
  checked?: boolean;
  emoji?: string;
};

export type Person = { id: string; username: string; avatar_url: string | null };

export type DocSummary = {
  id: string;
  channel_id: string;
  title: string;
  emoji: string | null;
  version: number;
  created_by: Person | null;
  updated_by: Person | null;
  created_at: string;
  updated_at: string;
};
export type Doc = DocSummary & { body: Block[] };
export type DocVersionSummary = {
  id: string; version: number; title: string; emoji: string | null; saved_by: Person | null; created_at: string;
};
export type DocVersion = DocVersionSummary & { body: Block[] };

export type DocUpdate = {
  action: 'created' | 'updated' | 'deleted';
  docId: string;
  channelId: string;
  version: number | null;
  updatedBy: { id: string; username: string };
};

export const MAX_BLOCKS = 500;
export const MAX_TEXT = 5000;

export const BLOCK_CHOICES: { type: BlockType; level?: number; label: string; hint: string; keywords: string }[] = [
  { type: 'paragraph', label: 'Text', hint: 'Plain paragraph', keywords: 'text paragraph plain' },
  { type: 'heading', level: 1, label: 'Heading 1', hint: 'Big section title  #', keywords: 'heading h1 title' },
  { type: 'heading', level: 2, label: 'Heading 2', hint: 'Medium title  ##', keywords: 'heading h2 subtitle' },
  { type: 'heading', level: 3, label: 'Heading 3', hint: 'Small title  ###', keywords: 'heading h3' },
  { type: 'bullet', label: 'Bulleted list', hint: 'Simple list  -', keywords: 'bullet list unordered' },
  { type: 'numbered', label: 'Numbered list', hint: 'Ordered list  1.', keywords: 'numbered list ordered' },
  { type: 'checklist', label: 'Checklist', hint: 'Tick things off  []', keywords: 'checklist todo task checkbox' },
  { type: 'quote', label: 'Quote', hint: 'Highlight a quote  >', keywords: 'quote' },
  { type: 'code', label: 'Code', hint: 'Fixed-width text  ```', keywords: 'code snippet' },
  { type: 'callout', label: 'Callout', hint: 'Call attention to a note', keywords: 'callout note info' },
  { type: 'divider', label: 'Divider', hint: 'A line between sections', keywords: 'divider line separator' },
];

export function newBlockId() {
  try { return crypto.randomUUID().replace(/-/g, '').slice(0, 12); }
  catch { return Math.random().toString(36).slice(2, 14); }
}

export function makeBlock(type: BlockType = 'paragraph', text = '', extra: Partial<Block> = {}): Block {
  const block: Block = { id: newBlockId(), type, text, ...extra };
  if (type === 'heading') block.level = extra.level ?? 1;
  if (type === 'checklist') block.checked = false;
  if (type === 'callout') block.emoji = extra.emoji ?? '💡';
  return block;
}

/** Returns a block of another type, keeping its id and text and dropping fields that no longer apply. */
export function convertBlock(block: Block, type: BlockType, level?: number): Block {
  const next = makeBlock(type, type === 'divider' ? '' : block.text, { level });
  return { ...next, id: block.id, checked: type === 'checklist' ? block.checked ?? false : undefined, emoji: type === 'callout' ? block.emoji ?? '💡' : undefined };
}

export const docsApi = {
  list: (channelId: string) => apiData<DocSummary[]>(`/api/channels/${channelId}/docs`),
  create: (channelId: string, body: { title?: string; emoji?: string | null; body?: Block[] }) =>
    apiData<Doc>(`/api/channels/${channelId}/docs`, { method: 'POST', body: JSON.stringify(body) }),
  get: (id: string) => apiData<Doc>(`/api/docs/${id}`),
  remove: (id: string) => apiData<void>(`/api/docs/${id}`, { method: 'DELETE' }),
  versions: (id: string) => apiData<DocVersionSummary[]>(`/api/docs/${id}/versions`),
  version: (id: string, versionId: string) => apiData<DocVersion>(`/api/docs/${id}/versions/${versionId}`),
  restore: (id: string, versionId: string) =>
    apiData<Doc>(`/api/docs/${id}/versions/${versionId}/restore`, { method: 'POST' }),
  /** Saves with the version the edit was based on; a stale base comes back as `{ conflict: latest }`. */
  async save(id: string, body: object): Promise<{ doc: Doc } | { conflict: Doc }> {
    const response = await apiFetch(`/api/docs/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    if (response.status === 409) return { conflict: (await response.json()).doc as Doc };
    return { doc: await responseData<Doc>(response) };
  },
};

export const docHref = (channelId: string, docId: string, slug?: string | null) => {
  const params = new URLSearchParams();
  if (slug) params.set('s', slug);
  params.set('c', channelId);
  params.set('doc', docId);
  return `/home?${params}`;
};

export function timeAgo(iso: string, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
