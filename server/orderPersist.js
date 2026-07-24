'use strict';

/**
 * Order ↔ Supabase row mapping (round-trip, không mất field runtime).
 * Local JSON vẫn là runtime SoT cho đến khi cutover; module này đảm bảo backup đủ field.
 */

function toIso(ts) {
  if (ts == null || ts === '') return null;
  if (typeof ts === 'number' && Number.isFinite(ts)) return new Date(ts).toISOString();
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toMs(iso) {
  if (iso == null || iso === '') return null;
  if (typeof iso === 'number' && Number.isFinite(iso)) return iso;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function orderToSupabaseRow(order) {
  if (!order || !order.id) return null;
  return {
    id: order.id,
    restaurant_id: order.restaurantId || null,
    restaurant_name: order.restaurantName || '',
    restaurant_address: order.restaurantAddress || '',
    restaurant_lat: Number.isFinite(Number(order.restaurantLat)) ? Number(order.restaurantLat) : null,
    restaurant_lon: Number.isFinite(Number(order.restaurantLon)) ? Number(order.restaurantLon) : null,
    restaurant_coords_exact: order.restaurantCoordsExact === true,
    status: order.status || 'PENDING',
    app_total: order.appTotal || 0,
    store_total: order.storeTotal || 0,
    shipper_earning: order.shipperEarning || 0,
    discount_value: order.discountValue || 0,
    min_service_fee: order.minServiceFee || 0,
    surcharge_per_item: order.surchargePerItem || 0,
    promo_code: order.promoCode || null,
    promo_discount: order.promoDiscount || 0,
    shipper_id: order.shipperId || null,
    shipper_name: order.shipperName || null,
    shipper_phone: order.shipperPhone || null,
    assigned_shipper_phone: order.assignedShipperPhone || null,
    offer_expires_at: order.offerExpiresAt != null ? Number(order.offerExpiresAt) : null,
    declined_shippers: asArray(order.declinedShippers),
    delivery_name: order.deliveryName || '',
    delivery_phone: order.deliveryPhone || '',
    delivery_address: order.deliveryAddress || '',
    orderer_phone: order.ordererPhone || '',
    pinned_lat: Number.isFinite(Number(order.pinnedLat)) ? Number(order.pinnedLat) : null,
    pinned_lon: Number.isFinite(Number(order.pinnedLon)) ? Number(order.pinnedLon) : null,
    is_relative: order.isRelative === true,
    note: order.note || '',
    items: asArray(order.items),
    messages: asArray(order.messages),
    tracking_token: order.trackingToken || null,
    rating: order.rating != null ? Number(order.rating) : null,
    comment: order.comment || null,
    created_at: toIso(order.createdAt) || new Date().toISOString(),
    accepted_at: toIso(order.acceptedAt),
    purchased_at: toIso(order.purchasedAt),
    delivered_at: toIso(order.deliveredAt),
    cancelled_at: toIso(order.cancelledAt),
    cancel_reason: order.cancelReason || null,
    updated_at: new Date().toISOString()
  };
}

function mapSupabaseOrderRow(row) {
  if (!row || !row.id) return null;
  return {
    id: row.id,
    trackingToken: row.tracking_token || null,
    restaurantId: row.restaurant_id || null,
    restaurantName: row.restaurant_name || '',
    restaurantAddress: row.restaurant_address || '',
    restaurantLat: row.restaurant_lat != null ? Number(row.restaurant_lat) : null,
    restaurantLon: row.restaurant_lon != null ? Number(row.restaurant_lon) : null,
    restaurantCoordsExact: row.restaurant_coords_exact === true,
    items: asArray(row.items),
    storeTotal: Number(row.store_total) || 0,
    appTotal: Number(row.app_total) || 0,
    shipperEarning: Number(row.shipper_earning) || 0,
    discountValue: Number(row.discount_value) || 0,
    minServiceFee: Number(row.min_service_fee) || 0,
    surchargePerItem: Number(row.surcharge_per_item) || 0,
    promoCode: row.promo_code || null,
    promoDiscount: Number(row.promo_discount) || 0,
    status: row.status || 'PENDING',
    shipperId: row.shipper_id || null,
    shipperName: row.shipper_name || null,
    shipperPhone: row.shipper_phone || null,
    shipperLat: null,
    shipperLon: null,
    deliveryAddress: row.delivery_address || '',
    deliveryName: row.delivery_name || '',
    deliveryPhone: row.delivery_phone || '',
    ordererPhone: row.orderer_phone || '',
    pinnedLat: row.pinned_lat != null ? Number(row.pinned_lat) : null,
    pinnedLon: row.pinned_lon != null ? Number(row.pinned_lon) : null,
    isRelative: row.is_relative === true,
    note: row.note || '',
    messages: asArray(row.messages),
    rating: row.rating != null ? Number(row.rating) : null,
    comment: row.comment || null,
    createdAt: toMs(row.created_at) || Date.now(),
    acceptedAt: toMs(row.accepted_at),
    purchasedAt: toMs(row.purchased_at),
    deliveredAt: toMs(row.delivered_at),
    cancelledAt: toMs(row.cancelled_at),
    cancelReason: row.cancel_reason || null,
    assignedShipperPhone: row.assigned_shipper_phone || null,
    offerExpiresAt: row.offer_expires_at != null ? Number(row.offer_expires_at) : null,
    declinedShippers: asArray(row.declined_shippers)
  };
}

/**
 * Merge remote SoT vào local: remote thắng field persist; GPS live local giữ nếu remote không có.
 */
function mergeOrderRemoteOverLocal(existing, mapped) {
  if (!mapped) return existing || null;
  if (!existing) return mapped;
  return {
    ...existing,
    ...mapped,
    shipperLat: existing.shipperLat != null ? existing.shipperLat : mapped.shipperLat,
    shipperLon: existing.shipperLon != null ? existing.shipperLon : mapped.shipperLon,
    trackingToken: mapped.trackingToken || existing.trackingToken || null,
    messages: (mapped.messages && mapped.messages.length)
      ? mapped.messages
      : (existing.messages || []),
    declinedShippers: (mapped.declinedShippers && mapped.declinedShippers.length)
      ? mapped.declinedShippers
      : (existing.declinedShippers || []),
    assignedShipperPhone: mapped.assignedShipperPhone || existing.assignedShipperPhone || null,
    offerExpiresAt: mapped.offerExpiresAt != null ? mapped.offerExpiresAt : existing.offerExpiresAt
  };
}

/** Smoke: serialize → map phải giữ các field then chốt. */
function assertRoundTrip(order) {
  const row = orderToSupabaseRow(order);
  const back = mapSupabaseOrderRow(row);
  const keys = [
    'id', 'trackingToken', 'status', 'appTotal', 'storeTotal', 'shipperEarning',
    'assignedShipperPhone', 'offerExpiresAt', 'pinnedLat', 'pinnedLon',
    'rating', 'isRelative', 'note', 'ordererPhone'
  ];
  const missing = [];
  for (const k of keys) {
    const a = order[k];
    const b = back[k];
    if (a == null || a === '') continue;
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || b.length !== a.length) missing.push(k);
    } else if (String(a) !== String(b) && Number(a) !== Number(b)) {
      missing.push(k);
    }
  }
  if (Array.isArray(order.messages) && order.messages.length) {
    if (!Array.isArray(back.messages) || back.messages.length !== order.messages.length) {
      missing.push('messages');
    }
  }
  return { ok: missing.length === 0, missing, back };
}

module.exports = {
  orderToSupabaseRow,
  mapSupabaseOrderRow,
  mergeOrderRemoteOverLocal,
  assertRoundTrip
};
