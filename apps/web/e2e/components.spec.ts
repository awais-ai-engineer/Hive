import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockApi } from './fixtures';

test('all component groups render in both themes without accessibility or runtime errors', async ({ page }, testInfo) => {
  const { errors } = await mockApi(page);
  await page.goto('/components');
  await expect(page.getByRole('heading', { name: 'Hive components' })).toBeVisible();
  await expect(page.locator('main > .grid > section')).toHaveCount(14);
  for (const theme of ['Light', 'Dark']) {
    await page.getByRole('button', { name: `${theme} theme`, exact: true }).click();
    const result = await new AxeBuilder({ page }).include('main').analyze();
    expect(result.violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`components-${theme.toLowerCase()}.png`), fullPage: true });
  }
  const iconButton = page.getByRole('button', { name: 'Search', exact: true });
  const desktopBounds = await iconButton.boundingBox();
  expect(desktopBounds?.width).toBe(32);
  expect(desktopBounds?.height).toBe(32);
  await page.setViewportSize({ width: 390, height: 844 });
  const touchBounds = await iconButton.boundingBox();
  expect(touchBounds?.width).toBe(44);
  expect(touchBounds?.height).toBe(44);
  expect(errors).toEqual([]);
});

test('select preserves FormData and the async combobox supports keyboard selection', async ({ page }) => {
  await mockApi(page); await page.goto('/components');
  const select = page.getByRole('combobox', { name: 'Example select', exact: true });
  await select.focus(); await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await expect(select).toHaveText(/Second option/);
  expect(await page.getByTestId('selection-form').evaluate(form => new FormData(form as HTMLFormElement).get('example'))).toBe('two');
  await page.getByRole('button', { name: 'Submit selection' }).click();
  await expect(page.getByText('Selected two', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Async member', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search Async member' }).fill('bo');
  await expect(page.getByRole('option', { name: 'Bob' })).toBeVisible();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(page.getByRole('combobox', { name: 'Async member', exact: true })).toContainText('Bob');
});

test('confirmation is cancel-first and file rejection shows a toast', async ({ page }) => {
  await mockApi(page); await page.goto('/components');
  await page.getByRole('button', { name: 'Open confirmation' }).click();
  const alert = page.getByRole('alertdialog', { name: 'Delete example' });
  await expect(alert.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(alert).not.toBeVisible();
  await page.getByRole('button', { name: 'Open confirmation' }).click();
  await alert.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('Example deleted', { exact: true })).toBeVisible();
  await page.getByRole('region', { name: '12. FileDropzone' }).locator('input[type="file"]').setInputFiles({ name: 'test.txt', mimeType: 'text/plain', buffer: Buffer.from('test') });
  await expect(page.getByText(/test.txt: this file type is not allowed/)).toBeVisible();
});

test('schedule message chooses date and time using only the keyboard and shows a toast', async ({ page }) => {
  await mockApi(page); await page.goto('/components');
  const composer = page.getByRole('region', { name: 'Schedule message preview' });
  await expect(composer.getByRole('textbox')).toHaveAttribute('contenteditable', 'true');
  await composer.getByRole('textbox').fill('A message for later');
  const later = composer.getByRole('button', { name: /Send later/ });
  await later.focus(); await page.keyboard.press('Enter');
  const schedule = composer.getByRole('region', { name: 'Send later', exact: true });
  const date = schedule.getByRole('button', { name: /date: Choose date/i });
  await date.focus(); await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
  const hour = schedule.getByRole('combobox', { name: /time hour/i });
  await hour.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('End'); await page.keyboard.press('Enter');
  const minutes = schedule.getByRole('combobox', { name: /time minute/i });
  await minutes.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await schedule.getByRole('button', { name: 'Schedule message', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Message scheduled', { exact: true })).toBeVisible();
});
