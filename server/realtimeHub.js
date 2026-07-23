'use strict';

/**
 * ShipFee realtime hub — Server-Sent Events (SSE).
 * Push order/GPS/message/ops events to customer, shipper, and CRM clients
 * so apps do not need short-interval REST polling.
 */

const clients = new Set();

function writeEvent(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (_) {
    /* client gone */
  }
}

/**
 * @param {import('http').ServerResponse} res
 * @param {{ role: 'shipper'|'customer'|'admin', phone?: string, orderId?: string }} meta
 */
function addClient(res, meta) {
  const client = { res, meta: meta || {}, alive: true };
  clients.add(client);
  writeEvent(res, 'connected', { ok: true, at: Date.now(), role: meta && meta.role });
  return client;
}

function removeClient(client) {
  if (!client) return;
  client.alive = false;
  clients.delete(client);
  try { client.res.end(); } catch (_) {}
}

function publish(event, payload, predicate) {
  const data = payload == null ? {} : payload;
  for (const client of [...clients]) {
    if (!client.alive) {
      clients.delete(client);
      continue;
    }
    try {
      if (typeof predicate === 'function' && !predicate(client.meta, data)) continue;
      writeEvent(client.res, event, data);
    } catch (_) {
      removeClient(client);
    }
  }
}

function normalizePhoneDigits(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('84') && digits.length >= 11) digits = '0' + digits.slice(2);
  return digits;
}

function publishOrderUpdate(order) {
  if (!order || !order.id) return;
  const slim = {
    id: order.id,
    status: order.status,
    shipperPhone: order.shipperPhone || null,
    assignedShipperPhone: order.assignedShipperPhone || null,
    offerExpiresAt: order.offerExpiresAt || null,
    shipperLat: order.shipperLat != null ? order.shipperLat : null,
    shipperLon: order.shipperLon != null ? order.shipperLon : null,
    shipperName: order.shipperName || null,
    restaurantName: order.restaurantName || null,
    appTotal: order.appTotal,
    storeTotal: order.storeTotal,
    shipperEarning: order.shipperEarning,
    messages: Array.isArray(order.messages) ? order.messages.slice(-20) : [],
    updatedAt: Date.now()
  };
  publish('order_updated', slim, (meta) => {
    if (!meta) return false;
    if (meta.role === 'admin') return true;
    if (meta.role === 'customer' && meta.orderId && String(meta.orderId) === String(order.id)) return true;
    if (meta.role === 'shipper') {
      const phone = normalizePhoneDigits(meta.phone);
      if (!phone) return false;
      const assigned = normalizePhoneDigits(order.assignedShipperPhone);
      const shipper = normalizePhoneDigits(order.shipperPhone);
      return phone === assigned || phone === shipper || order.status === 'PENDING';
    }
    return false;
  });
}

function publishOpsTick(extra) {
  publish('ops_tick', { at: Date.now(), ...(extra || {}) }, (meta) => meta && meta.role === 'admin');
}

function publishCallUpdate(orderId, call) {
  if (!orderId || !call) return;
  publish('call_updated', { orderId, call }, (meta) => {
    if (!meta) return false;
    if (meta.role === 'admin') return true;
    if (meta.role === 'customer' && String(meta.orderId) === String(orderId)) return true;
    if (meta.role === 'shipper') return true;
    return false;
  });
}

function clientCount() {
  return clients.size;
}

module.exports = {
  addClient,
  removeClient,
  publish,
  publishOrderUpdate,
  publishOpsTick,
  publishCallUpdate,
  clientCount
};
