import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { spaceSchema, type Space } from '@hive/shared';

const makeSpace = (id: string, name: string, kind: Space['kind'], extra: Partial<Space> = {}): Space => spaceSchema.parse({
  id, name, slug: id, kind, type: kind === 'work' ? 'workspace' : 'community',
  description: null, category: 'other', tags: [], allowed_email_domain: null, public_chat: false,
  created_at: '2026-01-01T00:00:00Z', member_count: 12, my_role: 'owner', role: 'owner',
  muted: false, favorite: false, position: null, unread: 0, unreadCount: 0,
  mentionCount: 0, iconUrl: null, color: '#d9d0fa', ...extra,
});
const fixtures = [makeSpace('studio', 'Studio Team', 'work'), makeSpace('design', 'Design Team', 'work'),
  makeSpace('garden', 'Garden Club', 'community', { unread: 4, unreadCount: 4, mentionCount: 2 })].map((space, index) => ({ ...space, position: index }));

async function mockApi(page: Page, initial = fixtures) {
  let spaces = structuredClone(initial);
  let failOrder = false;
  const saved: string[][] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
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
    else if (path === '/api/tasks/summary') body = { due_count: 0 };
    else if (path === '/api/push/settings') body = { quietStart: null, quietEnd: null };
    else if (path === '/api/push/config') body = { enabled: false };
    else if (path === '/api/me/unreads' || path === '/api/me/threads') body = { items: [], next_cursor: null };
    else if (path === '/api/calls' || path === '/api/dms' || path === '/api/me/stars' || path === '/api/me/conversation-prefs' || path.endsWith('/channels')) body = [];
    else return route.fulfill({ status: 404, json: { detail: 'Not found' } });
    return route.fulfill({ json: body });
  });
  return { saved, errors, failOrder: () => { failOrder = true; } };
}

test('switches by click and shortcuts; expands, pins and restores after reload', async ({ page }) => {
  const { errors } = await mockApi(page);
  await page.goto('/home');
  const rail = page.locator('.space-rail');
  await expect(rail.getByRole('button', { name: /^Studio Team/ })).toHaveAttribute('aria-current', 'page');
  await rail.getByRole('button', { name: 'Garden Club', exact: true }).click();
  await expect(page).toHaveURL(/s=garden/);
  await page.keyboard.press('Meta+2');
  await expect(page).toHaveURL(/s=design/);
  await page.keyboard.press('Control+1');
  await expect(page).toHaveURL(/s=studio/);
  await page.mouse.move(700, 400);
  await expect(rail).toHaveCSS('width', '72px');
  const content = page.locator('.home-sidebar');
  const collapsedX = (await content.boundingBox())!.x;
  await rail.hover();
  await expect(rail).toHaveCSS('width', '260px');
  expect((await content.boundingBox())!.x).toBe(collapsedX);
  await page.mouse.move(700, 400);
  await expect(rail).toHaveCSS('width', '72px');
  await rail.getByRole('button', { name: 'Expand spaces', exact: true }).click();
  await expect(page.locator('.rail-shell')).toHaveCSS('width', '260px');
  await page.reload();
  await expect(page.locator('.rail-shell')).toHaveCSS('width', '260px');
  const first = rail.getByRole('button', { name: /^Studio Team/ });
  await first.focus(); await page.keyboard.press('ArrowDown');
  await expect(rail.getByRole('button', { name: /^Design Team/ })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(rail.getByRole('button', { name: 'Garden Club', exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});

test('keyboard sorting persists within a group and rolls back a failed save', async ({ page }) => {
  const api = await mockApi(page);
  await page.goto('/home');
  const rail = page.locator('.space-rail');
  await rail.getByRole('button', { name: /^Studio Team/ }).focus();
  await page.keyboard.press('Space'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Space');
  await expect.poll(() => api.saved.length).toBe(1);
  expect(api.saved[0]).toEqual(['design', 'studio', 'garden']);
  await page.reload();
  await expect(rail.locator('.space-row').first()).toHaveAttribute('aria-label', 'Design Team');
  api.failOrder();
  await rail.getByRole('button', { name: /^Design Team/ }).focus();
  await page.keyboard.press('Space'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Space');
  await expect(rail.getByRole('alert')).toHaveText('Could not save order');
  await expect(rail.locator('.space-row').first()).toHaveAttribute('aria-label', 'Design Team');
});

test('badges, profile, menus, targets and both themes pass rail accessibility', async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto('/home');
  const rail = page.locator('.space-rail');
  await expect(rail.getByLabel('2 unread mentions', { exact: true })).toBeVisible();
  const profile = rail.getByRole('button', { name: 'Your profile and status: active' });
  await expect(profile).toBeVisible();
  await expect(profile.locator('span[aria-hidden]').first()).toHaveCSS('border-radius', '11.88px');
  await rail.getByRole('button', { name: 'Add a space', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Create a work space' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Create a community' })).toBeVisible();
  await page.keyboard.press('Escape');
  for (const dark of [false, true]) {
    await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark);
    const results = await new AxeBuilder({ page }).include('.space-rail').analyze();
    expect(results.violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(dark ? 'desktop-dark.png' : 'desktop-light.png') });
  }
  for (const button of await rail.locator('button, a').all()) {
    const bounds = await button.boundingBox();
    if (bounds) { expect(bounds.width).toBeGreaterThanOrEqual(44); expect(bounds.height).toBeGreaterThanOrEqual(44); }
  }
});

test('390px space sheet has four columns, switches spaces, and restores focus', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);
  await page.goto('/home');
  const trigger = page.getByRole('button', { name: 'Open spaces' });
  await trigger.click();
  const sheet = page.getByRole('dialog', { name: 'Your spaces' });
  await expect(sheet).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mobile-sheet.png') });
  await expect(sheet.locator('.grid').first()).toHaveCSS('grid-template-columns', /^(\S+ ){3}\S+$/);
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
  await sheet.getByRole('button', { name: 'Garden Club', exact: true }).click();
  await expect(page).toHaveURL(/s=garden/);
  await expect(sheet).not.toBeVisible();
  await trigger.click(); await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('navigation', { name: 'Global navigation' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('zero spaces shows both sidebar actions and a usable mobile sheet', async ({ page }) => {
  await mockApi(page, []);
  await page.goto('/home');
  await expect(page.getByRole('button', { name: 'No space yet' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create a space', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Browse communities', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open spaces' }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Add a space', exact: true })).toBeVisible();
});
