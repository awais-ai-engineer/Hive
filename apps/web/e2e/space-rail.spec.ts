import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { makeSpace, mockApi } from './fixtures';

test('one space hides the strip and the current tile opens the shared space menu', async ({ page }) => {
  await mockApi(page, [makeSpace('solo', 'Solo Studio', 'work')]);
  await page.goto('/home');
  await expect(page.locator('.rail-switcher-width')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByRole('button', { name: 'Show space switcher' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Current space: Solo Studio' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByText('12 members')).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Invite people' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Switch space' })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: 'Add a space' })).toBeVisible();
  await page.keyboard.press('Escape');
  expect((await new AxeBuilder({ page }).include('[aria-label="Main"]').analyze()).violations).toEqual([]);
});

test('two-space strip toggles, switches by tile and Cmd+2, and remains in sync with sidebar', async ({ page }) => {
  const { errors } = await mockApi(page);
  await page.goto('/home');
  const strip = page.locator('.rail-switcher-width nav[aria-label="Spaces"]');
  const rail = page.getByRole('navigation', { name: 'Main' });
  await expect(strip).toBeVisible();
  await expect(strip.getByRole('button', { name: 'Studio Team' })).toHaveAttribute('aria-current', 'page');
  await strip.getByRole('button', { name: 'Garden Club', exact: true }).click();
  await expect(page).toHaveURL(/s=garden/);
  await expect(rail.getByRole('button', { name: 'Current space: Garden Club' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Conversations' }).getByRole('button', { name: 'Garden Club' })).toBeVisible();
  await page.keyboard.press('Meta+2');
  await expect(page).toHaveURL(/s=design/);
  await expect(rail.getByRole('button', { name: 'Current space: Design Team' })).toBeVisible();
  const toggle = page.getByRole('button', { name: 'Hide space switcher' });
  await toggle.click();
  await expect(page.locator('.rail-switcher-width')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByRole('button', { name: 'Show space switcher' })).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(page.locator('.rail-switcher-width')).toHaveAttribute('aria-hidden', 'true');
  await page.keyboard.press('Control+Shift+S');
  await expect(page.getByRole('navigation', { name: 'Spaces' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.rail-switcher-width')).toHaveAttribute('aria-hidden', 'true');
  expect(errors).toEqual([]);
});

test('space shortcuts do not steal key presses from text fields', async ({ page }) => {
  await mockApi(page, undefined, true);
  await page.goto('/home?s=studio');
  const message = page.getByRole('textbox', { name: 'Message' });
  await message.focus();
  await page.keyboard.press('Meta+2');
  await expect(page).toHaveURL(/s=studio/);
  await message.fill('hello');
  await expect(message).toHaveText('hello');
  await message.blur();
  await page.keyboard.press('Meta+2');
  await expect(page).toHaveURL(/s=design/);
});

test('the sidebar header uses the shared menu and its Switch space action opens the strip', async ({ page }) => {
  await mockApi(page);
  await page.goto('/home');
  const sidebarHeading = page.getByRole('navigation', { name: 'Conversations' }).getByRole('button', { name: 'Studio Team' });
  await sidebarHeading.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.getByRole('menuitem', { name: 'Switch space' }).click();
  await expect(page.getByRole('navigation', { name: 'Spaces' })).toBeVisible();
});

test('keyboard sorting persists within a group; rail and strip pass axe', async ({ page }) => {
  const api = await mockApi(page);
  await page.goto('/home');
  const strip = page.getByRole('navigation', { name: 'Spaces' });
  await strip.getByRole('button', { name: 'Studio Team' }).focus();
  await page.keyboard.press('Space'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Space');
  await expect.poll(() => api.saved.length).toBe(1);
  expect(api.saved[0]).toEqual(['design', 'studio', 'garden']);
  await page.reload();
  await expect(strip.locator('.space-row').first()).toHaveAttribute('aria-label', 'Design Team');
  for (const selector of ['[aria-label="Spaces"]', '[aria-label="Main"]']) {
    expect((await new AxeBuilder({ page }).include(selector).analyze()).violations).toEqual([]);
  }
  for (const button of await page.locator('[aria-label="Spaces"] button, [aria-label="Main"] button').all()) {
    const bounds = await button.boundingBox();
    if (bounds) { expect(bounds.width).toBeGreaterThanOrEqual(40); expect(bounds.height).toBeGreaterThanOrEqual(40); }
  }
});

test('390px mobile sheet switches spaces and the five-tab bar includes More', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);
  await page.goto('/home');
  await expect(page.locator('.rail-shell')).toBeHidden();
  await expect(page.locator('.rail-switcher-width')).toBeHidden();
  await page.getByRole('button', { name: 'Current space: Studio Team' }).click();
  const sheet = page.getByRole('dialog', { name: 'Your spaces' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.grid').first()).toHaveCSS('grid-template-columns', /^(\S+ ){3}\S+$/);
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
  await sheet.getByRole('button', { name: 'Garden Club', exact: true }).click();
  await expect(page).toHaveURL(/s=garden/);
  await expect(sheet).not.toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Global navigation' }).getByRole('button', { name: 'More' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('zero spaces still has useful empty-state actions', async ({ page }) => {
  await mockApi(page, []);
  await page.goto('/home');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'No space yet' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create a space', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Browse communities', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open spaces' }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Add a space', exact: true })).toBeVisible();
});
