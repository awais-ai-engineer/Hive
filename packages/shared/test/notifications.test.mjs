import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationSchema, notificationPreferencesSchema, SocketEvents } from '../dist/index.js';

test('notification payloads validate', () => {
  const item = {
    id: '1', type: 'mention', actor: { id: 'u', username: 'bob', displayName: null, avatarUrl: null },
    spaceId: null, spaceSlug: null, spaceName: null, channelId: null, channelName: null, isDm: false,
    messageId: null, postId: null, commentId: null, snippet: 'hi', count: 1, readAt: null, createdAt: '2026-01-01T00:00:00Z',
  };
  assert.ok(notificationSchema.safeParse(item).success);
  assert.ok(!notificationSchema.safeParse({ ...item, type: 'other' }).success);
  assert.ok(notificationPreferencesSchema.safeParse({ preferences: { mention: false } }).success);
});

test('socket event names exist', () => {
  assert.equal(SocketEvents.NotificationNew, 'notification:new');
  assert.equal(SocketEvents.NotificationCount, 'notification:count');
});
