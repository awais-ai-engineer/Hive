'use client';

import { useEffect, useState } from 'react';
import type { AppNotification, NotificationType } from '@hive/shared';
import { useAuth } from './auth';
import { socket } from './socket';
import { apiData } from './spaces';

export const TYPE_LABELS: Record<NotificationType, { title: string; hint: string }> = {
  mention: { title: 'Mentions', hint: 'Someone mentions you in a message.' },
  reply: { title: 'Replies', hint: 'Replies in threads you started or joined.' },
  reaction: { title: 'Reactions', hint: 'Someone reacts to your message.' },
  post_comment: { title: 'Post comments', hint: 'Comments on your posts and replies to your comments.' },
  invite_accepted: { title: 'Accepted invites', hint: 'Someone joins a space with your invite link.' },
  dm: { title: 'Direct messages', hint: 'Messages that arrive while you are not connected.' },
};

/** Live unread count for the bell (rail and top bar). */
export function useNotificationCount() {
  const { user } = useAuth();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!user) { setCount(0); return; }
    let live = true;
    const load = () => apiData<{ count: number }>('/api/notifications/unread-count').then(result => { if (live) setCount(result.count); }).catch(() => {});
    const onCount = (data: { count: number }) => setCount(data.count);
    void load();
    socket.on('notification:count', onCount).on('connect', load);
    return () => { live = false; socket.off('notification:count', onCount).off('connect', load); };
  }, [user]);
  return count;
}

const place = (item: AppNotification) => item.isDm ? (item.channelName ? `your chat with ${item.channelName}` : 'a conversation') : item.channelName ? `#${item.channelName}` : item.spaceName ?? 'a space';

export function actorName(item: AppNotification) {
  return item.actor?.displayName || item.actor?.username || 'Someone';
}

/** The sentence shown in the inbox, such as "Bob mentioned you in #general". */
export function describe(item: AppNotification) {
  const who = actorName(item);
  const others = item.count > 1 ? ` and ${item.count - 1} ${item.count === 2 ? 'other' : 'others'}` : '';
  switch (item.type) {
    case 'mention': return `${who} mentioned you in ${place(item)}`;
    case 'reply': return `${who} replied in a thread in ${place(item)}`;
    case 'reaction': return `${who}${others} reacted to your message in ${place(item)}`;
    case 'post_comment': return `${who} commented${item.spaceName ? ` in ${item.spaceName}` : ''}`;
    case 'invite_accepted': return `${who} joined ${item.spaceName ?? 'your space'} with your invite`;
    case 'dm': return `${who} sent you a message`;
  }
}

export function notificationHref(item: AppNotification) {
  if (item.channelId) {
    const params = new URLSearchParams();
    if (item.spaceSlug) params.set('s', item.spaceSlug);
    params.set('c', item.channelId);
    if (item.messageId) params.set('m', item.messageId);
    return `/home?${params}`;
  }
  if (item.postId) return `/p/${item.postId}`;
  return item.spaceSlug ? `/s/${item.spaceSlug}` : '/home';
}
