/* ShipFee customer PWA — v2026-07-23a
   Minimal SW for installability + install prompt UX. */
const SW_VERSION = 'shipfee-customer-2026-07-23a';

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
