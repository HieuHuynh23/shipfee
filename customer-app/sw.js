/* ShipFee customer PWA — v2026-07-19e
   Minimal SW for installability. Cleared caches so clients pick up
   desktop cached geolocation + clearer site-permission messaging. */
const SW_VERSION = 'shipfee-customer-2026-07-19e';

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
