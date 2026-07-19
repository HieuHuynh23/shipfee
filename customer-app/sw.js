/* ShipFee customer PWA — v2026-07-19d
   Minimal SW for installability. Cleared caches so clients pick up
   Chrome/Windows two-step location permission + gesture-safe GPS. */
const SW_VERSION = 'shipfee-customer-2026-07-19d';

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
