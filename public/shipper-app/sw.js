/* ShipFee Tài Xế PWA — SW v3.2 (logo refresh) */
const SW_VERSION = 'shipfee-tx-v3.2';

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
