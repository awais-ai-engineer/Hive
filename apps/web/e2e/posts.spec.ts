import { expect, test } from '@playwright/test';
import { makeSpace, mockApi } from './fixtures';

test('member can publish a formatted post from Feed and sees it immediately', async ({ page }, testInfo) => {
  const space = makeSpace('studio', 'Studio Team', 'work');
  const draftPost = {
    id: 'post-1', space: { id: 'studio', slug: 'studio', name: 'Studio Team', type: 'workspace' },
    author: { id: 'alice', username: 'alice', avatar_url: null }, title: 'Release update',
    body: '## Progress\n**The upload fix is ready.**', url: null, domain: null, media: [], score: 0,
    upvotes: 0, downvotes: 0, comment_count: 0, repost_count: 0, my_vote: 0,
    created_at: new Date().toISOString(), edited_at: null, deleted: false,
  };
  const { errors } = await mockApi(page, [space]);
  await page.route('**/api/feed*', route => route.fulfill({ json: { items: [], next_cursor: null } }));
  await page.route('**/api/spaces/studio/posts', async route => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 201, json: draftPost });
    return route.fulfill({ json: { items: [], next_cursor: null } });
  });
  await page.goto('/feed');
  await page.getByRole('button', { name: 'Create Post' }).click();
  await expect(page.getByRole('dialog', { name: 'Create a post' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Title' }).fill('Release update');
  await page.getByRole('textbox', { name: 'Content' }).fill('The upload fix is ready.');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await page.getByRole('button', { name: 'Publish post' }).click();
  await expect(page.getByRole('heading', { name: 'Release update' })).toBeVisible();
  await expect(page.getByText('Post published')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('published-post.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('composer warns before discarding an edited draft', async ({ page }) => {
  await mockApi(page, [makeSpace('studio', 'Studio Team', 'work')]);
  await page.route('**/api/feed*', route => route.fulfill({ json: { items: [], next_cursor: null } }));
  await page.goto('/feed');
  await page.getByRole('button', { name: 'Create Post' }).click();
  await page.getByRole('textbox', { name: 'Title' }).fill('Keep this draft');
  await page.getByRole('button', { name: 'Close Create a post' }).click();
  const discard = page.getByRole('alertdialog', { name: 'Discard this draft?' });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Create a post' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Keep this draft');
});
