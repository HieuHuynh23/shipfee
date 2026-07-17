/* ShipFee Tài Xế PWA — SW v2.6 (mobile perf/UI cache bust) */
const SW_VERSION = 'shipfee-tx-v2.6';

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
