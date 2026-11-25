import { expect, test } from '@playwright/test';
import { mockApi } from './fixtures';

test('individual previews decode bundled assets and preferences save without preview side effects', async ({ page }) => {
  const { errors } = await mockApi(page);
  let saved: Record<string, unknown> | undefined;
  await page.route('**/api/me/sounds', route => {
    if (route.request().method() === 'PUT') saved = route.request().postDataJSON();
    return route.fulfill({ json: saved ?? { enabled: true, volume: .35, messages: true, huddles: false, activity: true, feedback: true } });
  });
  await page.addInitScript(() => {
    const original = AudioContext.prototype.createBufferSource;
    const state = window as unknown as { audioStarts: number; audioDurations: number[] };
    state.audioStarts = 0; state.audioDurations = [];
    AudioContext.prototype.createBufferSource = function () {
      const source = original.call(this); const start = source.start.bind(source);
      source.start = (...args: Parameters<typeof source.start>) => { state.audioStarts++; state.audioDurations.push(source.buffer?.duration ?? 0); start(...args); };
      return source;
    };
  });
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Sounds & availability', exact: true }).click();
  await page.locator('summary').filter({ hasText: /^Messages$/ }).click();
  await expect(page.getByRole('button', { name: 'Preview Message delivered', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Preview Message delivered', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { audioStarts: number }).audioStarts)).toBe(1);
  expect(saved).toBeUndefined();
  await page.getByLabel('Incoming direct message', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save sound preferences', exact: true }).click();
  await expect(page.getByText('Sound preferences saved', { exact: true })).toBeVisible();
  expect((saved?.events as Record<string, boolean>)?.incoming).toBe(false);
  expect(saved?.controls).toBe(false); // inherited from the legacy Huddle switch
  await page.reload();
  await page.getByRole('button', { name: 'Sounds & availability', exact: true }).click();
  await page.locator('summary').filter({ hasText: /^Messages$/ }).click();
  await expect(page.getByLabel('Incoming direct message', { exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'Reset to defaults', exact: true }).click();
  await expect(page.getByLabel('Incoming direct message', { exact: true })).toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('listening room exposes real voice and sound files with one-at-a-time playback', async ({ page }) => {
  await page.goto('/sounds/v2/preview.html');
  await expect(page.getByRole('heading', { name: /Sound listening room/ })).toBeVisible();
  expect(await page.locator('audio').count()).toBe(46);
  await page.getByRole('heading', { name: /Sound listening room/ }).click();
  await page.evaluate(async () => {
    const first = document.querySelector<HTMLAudioElement>('#transcription_started')!;
    first.volume = 0; await first.play();
    const second = document.querySelector<HTMLAudioElement>('#invitation')!;
    second.volume = 0; await second.play();
  });
  await expect.poll(() => page.locator('#transcription_started').evaluate((node: HTMLAudioElement) => node.paused)).toBe(true);
  expect(await page.locator('#invitation').evaluate((node: HTMLAudioElement) => node.duration)).toBeGreaterThan(1);
});
