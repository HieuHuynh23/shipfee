/* ShipFee customer PWA — v2026-07-18c
   Minimal SW for installability. Cleared caches so clients pick up
   desktop GPS / tracking UI updates instead of stale HTML. */
const SW_VERSION = 'shipfee-customer-2026-07-18c';

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
