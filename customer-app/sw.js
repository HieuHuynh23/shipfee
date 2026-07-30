/* ShipFee customer PWA — v2026-07-30checkout
   Installability + Web Push notifications. */
const SW_VERSION = 'shipfee-customer-2026-07-30cartsnap';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('push', (event) => {
  let data = { title: 'ShipFee', body: 'Có cập nhật đơn hàng', url: './' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (_) {
    try {
      data.body = event.data ? event.data.text() : data.body;
    } catch (_) {}
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'ShipFee', {
      body: data.body || '',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-96.png',
      data: { url: data.url || './tracking.html' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
