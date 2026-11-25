import { expect, test } from '@playwright/test';
import { mockApi } from './fixtures';

test('sound and availability settings save UTC schedules and account preferences', async ({ page }) => {
  const { errors } = await mockApi(page);
  let schedule: Record<string, unknown> | undefined;
  let sounds: Record<string, unknown> | undefined;
  await page.route('**/api/me/availability', async route => {
    if (route.request().method() === 'POST') { schedule = route.request().postDataJSON(); return route.fulfill({ status: 201, json: { id: 'schedule', ...schedule } }); }
    return route.fulfill({ json: [] });
  });
  await page.route('**/api/me/sounds', async route => {
    if (route.request().method() === 'PUT') sounds = route.request().postDataJSON();
    return route.fulfill({ json: sounds ?? { enabled: true, volume: 0.35, messages: true, huddles: true, activity: true, feedback: true } });
  });
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Sounds & availability', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Smart availability' })).toBeVisible();
  await page.getByRole('button', { name: 'Save sound preferences' }).click();
  await expect(page.getByText('Sound preferences saved')).toBeVisible();
  expect(sounds?.volume).toBe(0.35);
  await page.getByRole('button', { name: 'Save availability', exact: true }).click();
  await expect(page.getByText('Availability saved', { exact: true })).toBeVisible();
  expect(schedule?.starts_at).toMatch(/Z$/);
  expect(schedule?.restrictions).toEqual(['messages', 'media', 'voice', 'huddles']);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '../../output/playwright/communication-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});


test('text-only availability restrictions leave permitted voice and media controls available', async ({ page }) => {
  await mockApi(page, undefined, true);
  await page.route('**/api/dms', route => route.fulfill({ json: [{ id: 'direct', participants: [{ id: 'bob', username: 'bob', avatar_url: null, online: true }], is_group: false, last_message: null, unread: 0, created_at: '2026-01-01T00:00:00Z' }] }));
  await page.route('**/api/channels/direct/availability', route => route.fulfill({ json: [{ userId: 'bob', status: 'in_a_meeting', message: null, until: '2027-01-01T00:00:00Z', blocked: ['messages'], suppressNotifications: true }] }));
  await page.goto('/home?c=direct');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveAttribute('contenteditable', 'false');
  await expect(page.getByRole('button', { name: 'Record a voice message', exact: true })).toBeEnabled();
  await expect(page.getByText(/This user is currently in a meeting/).first()).toBeVisible();
});
