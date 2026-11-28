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

test('post draft survives a page reload', async ({ page }) => {
  await mockApi(page, [makeSpace('studio', 'Studio Team', 'work')]);
  await page.route('**/api/feed*', route => route.fulfill({ json: { items: [], next_cursor: null } }));
  await page.goto('/feed');
  await page.getByRole('button', { name: 'Create Post' }).click();
  await page.getByRole('textbox', { name: 'Title' }).fill('Recovered draft');
  await page.getByRole('textbox', { name: 'Content' }).fill('Draft body');
  await page.reload();
  await page.getByRole('button', { name: 'Create Post' }).click();
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Recovered draft');
  await expect(page.getByRole('textbox', { name: 'Content' })).toHaveValue('Draft body');
});

test('an uploaded attachment is included in the published post', async ({ page }) => {
  const space = makeSpace('studio', 'Studio Team', 'work');
  await mockApi(page, [space]);
  const attachment = { id: 'media-1', filename: 'proof.png', content_type: 'image/png', size: 24,
    kind: 'image', url: '/api/attachments/media-1', viewOnce: false, viewState: null };
  const published = {
    id: 'post-media', space: { id: 'studio', slug: 'studio', name: 'Studio Team', type: 'workspace' },
    author: { id: 'alice', username: 'alice', avatar_url: null }, title: 'Visual proof', body: null,
    url: null, domain: null, media: [attachment], score: 0, upvotes: 0, downvotes: 0,
    comment_count: 0, repost_count: 0, my_vote: 0, created_at: new Date().toISOString(), edited_at: null, deleted: false,
  };
  let postedIds: string[] = [];
  await page.route('**/api/spaces/studio/uploads', route => route.fulfill({ status: 201, json: attachment }));
  await page.route('**/api/spaces/studio/posts', async route => {
    if (route.request().method() === 'POST') {
      postedIds = route.request().postDataJSON().mediaIds;
      return route.fulfill({ status: 201, json: published });
    }
    return route.fulfill({ json: { items: [], next_cursor: null } });
  });
  await page.route('**/api/feed*', route => route.fulfill({ json: { items: [], next_cursor: null } }));
  await page.goto('/feed');
  await page.getByRole('button', { name: 'Create Post' }).click();
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
  await page.getByRole('button', { name: 'Attach files' }).click();
  await page.getByLabel('Choose files').setInputFiles({ name: 'proof.png', mimeType: 'image/png',
    buffer: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex') });
  await expect(page.getByRole('button', { name: 'Publish post' })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Title' }).fill('Visual proof');
  await page.getByRole('button', { name: 'Publish post' }).click();
  await expect(page.getByRole('heading', { name: 'Visual proof' })).toBeVisible();
  expect(postedIds).toEqual(['media-1']);
});

test('workspace channel Posts tab publishes to that channel', async ({ page }, testInfo) => {
  const space = makeSpace('studio', 'Studio Team', 'work');
  const { errors } = await mockApi(page, [space], true);
  let requestPath = '';
  const channelPost = {
    id: 'channel-post-1', space: { id: 'studio', slug: 'studio', name: 'Studio Team', type: 'workspace' },
    channel: { id: 'studio-channel', name: 'general' },
    author: { id: 'alice', username: 'alice', avatar_url: null }, title: 'General update',
    body: 'Published in the channel', url: null, domain: null, media: [], score: 0,
    upvotes: 0, downvotes: 0, comment_count: 0, repost_count: 0, my_vote: 0,
    created_at: new Date().toISOString(), edited_at: null, deleted: false,
  };
  await page.route('**/api/channels/studio-channel/posts*', async route => {
    if (route.request().method() === 'POST') {
      requestPath = new URL(route.request().url()).pathname;
      return route.fulfill({ status: 201, json: channelPost });
    }
    return route.fulfill({ json: { items: [], next_cursor: null } });
  });
  await page.goto('/home?s=studio&c=studio-channel&tab=posts');
  await page.getByRole('button', { name: 'Create Post' }).click();
  await page.getByRole('textbox', { name: 'Title' }).fill('General update');
  await page.getByRole('textbox', { name: 'Content' }).fill('Published in the channel');
  await page.getByRole('button', { name: 'Publish post' }).click();
  await expect(page.getByRole('heading', { name: 'General update' })).toBeVisible();
  await expect(page.getByText('#general')).toBeVisible();
  expect(requestPath).toBe('/api/channels/studio-channel/posts');
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('channel-post.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Create Post' })).toBeVisible();
  await page.getByRole('button', { name: 'Create Post' }).click();
  await expect(page.getByRole('dialog', { name: 'Create a post' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish post' })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('channel-post-mobile.png'), fullPage: true });
});
