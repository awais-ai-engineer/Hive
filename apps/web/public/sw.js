/* Hive service worker: an offline page for navigations, and Web Push. API responses are never cached. */
const CACHE = 'hive-shell-v1';
const OFFLINE = '/offline.html';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll([OFFLINE, '/icon-192.png'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.mode !== 'navigate') return; // only page loads fall back to the offline page
  event.respondWith(fetch(request).catch(() => caches.match(OFFLINE)));
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Hive';
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof data.body === 'string' ? data.body : '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: typeof data.tag === 'string' ? data.tag : undefined,
    renotify: !!data.tag,
    data: { url: typeof data.url === 'string' ? data.url : '/home' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  let target = new URL('/home', self.location.origin);
  try {
    const wanted = new URL(event.notification.data && event.notification.data.url, self.location.origin);
    if (wanted.origin === self.location.origin) target = wanted; // never open another site
  } catch { /* keep the default */ }
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
        return client.focus().then(focused => ('navigate' in focused ? focused.navigate(target.href) : focused));
      }
    }
    return self.clients.openWindow(target.href);
  }));
});
