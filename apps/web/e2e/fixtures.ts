import type { Page } from '@playwright/test';
import { spaceSchema, type Space } from '@hive/shared';

export const makeSpace = (id: string, name: string, kind: Space['kind'], extra: Partial<Space> = {}): Space => spaceSchema.parse({
  id, name, slug: id, kind, type: kind === 'work' ? 'workspace' : 'community',
  description: null, category: 'other', tags: [], allowed_email_domain: null, public_chat: false,
  created_at: '2026-01-01T00:00:00Z', member_count: 12, my_role: 'owner', role: 'owner',
  muted: false, favorite: false, position: null, unread: 0, unreadCount: 0,
  mentionCount: 0, iconUrl: null, color: '#d9d0fa', ...extra,
});
const fixtures = [makeSpace('studio', 'Studio Team', 'work'), makeSpace('design', 'Design Team', 'work'),
  makeSpace('garden', 'Garden Club', 'community', { unread: 4, unreadCount: 4, mentionCount: 2 })].map((space, index) => ({ ...space, position: index }));

export async function mockApi(page: Page, initial: Space[] = fixtures, withChannel = false) {
  let spaces = structuredClone(initial);
  let failOrder = false;
  const saved: string[][] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') { const location = message.location(); errors.push(`${message.text()} (${location.url}:${location.lineNumber})`); } });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path === '/api/auth/refresh') body = { access_token: 'fixture-session', token_type: 'bearer', user: { id: 'alice', username: 'alice', email: 'alice@hive.test', avatar_url: null, created_at: '2026-01-01T00:00:00Z', appear_offline: false } };
    else if (path === '/api/me/spaces') body = spaces;
    else if (path === '/api/me/preferences') {
      const ids = route.request().postDataJSON().spaceOrder as string[];
      if (failOrder) return route.fulfill({ status: 503, json: { detail: 'Could not save order' } });
      saved.push(ids);
      spaces = spaces.map(space => ({ ...space, position: ids.indexOf(space.id) }));
      body = { spaceOrder: ids };
    } else if (path === '/api/me/sidebar') body = { sections: [], collapsed: [] };
    else if (path === '/api/notifications/unread-count') body = { count: 3 };
    else if (path === '/api/ai/status') body = { enabled: false, languages: [] };
    else if (path === '/api/tasks/summary') body = { due_count: 0 };
    else if (path === '/api/push/settings') body = { quietStart: null, quietEnd: null };
    else if (path === '/api/push/config') body = { enabled: false };
    else if (path === '/api/me/unreads' || path === '/api/me/threads') body = { items: [], next_cursor: null };
    else if (path.endsWith('/channels')) {
      const slug = path.split('/')[3];
      body = withChannel ? [{ id: `${slug}-channel`, space_id: spaces.find(space => space.slug === slug)?.id ?? slug,
        type: 'text', name: 'general', topic: null, position: 0, unread: 0, is_private: false }] : [];
    } else if (/^\/api\/channels\/[^/]+\/messages$/.test(path)) body = { items: [], has_more: false };
    else if (path === '/api/calls' || path === '/api/dms' || path === '/api/drafts' || path === '/api/scheduled' || path === '/api/reminders' || path === '/api/me/stars' || path === '/api/me/conversation-prefs') body = [];
    else return route.fulfill({ status: 404, json: { detail: 'Not found' } });
    return route.fulfill({ json: body });
  });
  return { saved, errors, failOrder: () => { failOrder = true; } };
}

