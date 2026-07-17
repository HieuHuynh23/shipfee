/* ShipFee Tài Xế PWA — minimal SW for installability (separate from customer-app). */
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
