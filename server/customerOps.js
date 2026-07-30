'use strict';

/**
 * Customer ops: delivery hints, prefer-shipper, per-shipper blacklist,
 * loyalty points, CSAT follow-up queue, heatmap aggregates.
 */
const fs = require('fs');
const path = require('path');

const SHIPPER_BL_FILE = path.join(__dirname, 'shipper-blacklist-local.json');
const LOYALTY_FILE = path.join(__dirname, 'loyalty-local.json');
const CSAT_FILE = path.join(__dirname, 'csat-followups-local.json');

const PREFER_SHIPPER_SCORE_MULT = 0.72; // lower score = better
const LOYALTY_BASE_POINTS = 10;
const LOYALTY_REPEAT_BONUS = 5;
const LOYALTY_PER_100K = 2;

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function cleanPhone(phone) {
  return String(phone || '').trim().replace(/\s+/g, '');
}

// ── Enrich order for shipper UI ────────────────────────────────────────────
function enrichOrderForShipper(order, crm) {
  if (!order || !crm) return order;
  const phone = cleanPhone(order.deliveryPhone || order.ordererPhone);
  if (!phone) {
    order.deliveryHint = order.deliveryHint || '';
    order.shipperNotes = order.shipperNotes || [];
    return order;
  }
  const profile = crm.getCustomerCrmProfile(phone);
  order.deliveryHint = profile.deliveryHint || '';
  order.shipperNotes = (profile.notes || [])
    .filter((n) => n && n.visibility === 'shipper' && n.text)
    .slice(0, 5)
    .map((n) => ({ text: n.text, at: n.at }));
  const loyalty = getLoyaltyProfile(phone);
  order.customerLoyalty = {
    points: loyalty.points,
    tier: loyalty.tier,
    ordersCount: loyalty.ordersCount
  };
  return order;
}

// ── Prefer shipper (past DELIVERED to same customer) ────────────────────────
function countPastDeliveries(orders, shipperPhone, customerPhone, cleanPhoneFn) {
  const sp = cleanPhoneFn(shipperPhone);
  const cp = cleanPhoneFn(customerPhone);
  if (!sp || !cp) return 0;
  let n = 0;
  for (const o of orders || []) {
    if (o.status !== 'DELIVERED') continue;
    if (cleanPhoneFn(o.shipperPhone) !== sp) continue;
    const cust = cleanPhoneFn(o.deliveryPhone || o.ordererPhone);
    if (cust === cp) n += 1;
  }
  return n;
}

function applyPreferShipperBoost(score, shipperPhone, candidateOrder, orders, cleanPhoneFn) {
  const customerPhone = cleanPhoneFn(candidateOrder?.deliveryPhone || candidateOrder?.ordererPhone);
  if (!customerPhone || !Number.isFinite(score)) return { score, preferCount: 0 };
  const n = countPastDeliveries(orders, shipperPhone, customerPhone, cleanPhoneFn);
  if (n <= 0) return { score, preferCount: 0 };
  // Stronger boost for more history (cap)
  const mult = Math.max(0.55, PREFER_SHIPPER_SCORE_MULT - Math.min(n, 5) * 0.03);
  return { score: score * mult, preferCount: n };
}

// ── Per-shipper blacklist ──────────────────────────────────────────────────
function readShipperBlacklistStore() {
  return readJson(SHIPPER_BL_FILE, {});
}

function writeShipperBlacklistStore(store) {
  writeJson(SHIPPER_BL_FILE, store);
}

function isShipperBlacklistedCustomer(shipperPhone, customerPhone) {
  const sp = cleanPhone(shipperPhone);
  const cp = cleanPhone(customerPhone);
  if (!sp || !cp) return null;
  const store = readShipperBlacklistStore();
  const list = store[sp] || [];
  return list.find((e) => cleanPhone(e.customerPhone) === cp) || null;
}

function addShipperBlacklist(shipperPhone, customerPhone, reason = '', by = 'admin') {
  const sp = cleanPhone(shipperPhone);
  const cp = cleanPhone(customerPhone);
  if (!sp || !cp) return null;
  const store = readShipperBlacklistStore();
  const list = store[sp] || [];
  if (list.some((e) => cleanPhone(e.customerPhone) === cp)) return null;
  const entry = {
    customerPhone: cp,
    reason: reason || 'Shipper blacklist',
    at: Date.now(),
    by
  };
  list.unshift(entry);
  store[sp] = list;
  writeShipperBlacklistStore(store);
  return entry;
}

function removeShipperBlacklist(shipperPhone, customerPhone) {
  const sp = cleanPhone(shipperPhone);
  const cp = cleanPhone(customerPhone);
  const store = readShipperBlacklistStore();
  const before = (store[sp] || []).length;
  store[sp] = (store[sp] || []).filter((e) => cleanPhone(e.customerPhone) !== cp);
  writeShipperBlacklistStore(store);
  return before !== store[sp].length;
}

function listShipperBlacklist(shipperPhone) {
  const sp = cleanPhone(shipperPhone);
  if (!sp) {
    const store = readShipperBlacklistStore();
    return Object.entries(store).flatMap(([phone, list]) =>
      (list || []).map((e) => ({ shipperPhone: phone, ...e }))
    );
  }
  return (readShipperBlacklistStore()[sp] || []).map((e) => ({ shipperPhone: sp, ...e }));
}

// ── Loyalty ────────────────────────────────────────────────────────────────
function tierFromPoints(points) {
  if (points >= 500) return 'gold';
  if (points >= 200) return 'silver';
  if (points >= 50) return 'bronze';
  return 'member';
}

function getLoyaltyProfile(phone) {
  const p = cleanPhone(phone);
  const store = readJson(LOYALTY_FILE, {});
  const row = store[p] || { points: 0, ordersCount: 0, history: [], redeemed: 0 };
  return {
    phone: p,
    points: row.points || 0,
    ordersCount: row.ordersCount || 0,
    redeemed: row.redeemed || 0,
    tier: tierFromPoints(row.points || 0),
    history: Array.isArray(row.history) ? row.history.slice(0, 30) : []
  };
}

function awardLoyaltyForDelivery(order) {
  const phone = cleanPhone(order?.ordererPhone || order?.deliveryPhone);
  if (!phone || !order) return null;
  const store = readJson(LOYALTY_FILE, {});
  const row = store[phone] || { points: 0, ordersCount: 0, history: [], redeemed: 0 };
  if (row.history?.some((h) => h.orderId === order.id && h.type === 'earn')) {
    return getLoyaltyProfile(phone); // idempotent
  }
  const spend = Number(order.appTotal) || 0;
  let earned = LOYALTY_BASE_POINTS + Math.floor(spend / 100000) * LOYALTY_PER_100K;
  if ((row.ordersCount || 0) >= 1) earned += LOYALTY_REPEAT_BONUS;
  row.points = (row.points || 0) + earned;
  row.ordersCount = (row.ordersCount || 0) + 1;
  row.history = row.history || [];
  row.history.unshift({
    type: 'earn',
    orderId: order.id,
    points: earned,
    at: Date.now(),
    note: `Giao xong +${earned}đ`
  });
  if (row.history.length > 100) row.history.length = 100;
  store[phone] = row;
  writeJson(LOYALTY_FILE, store);
  return getLoyaltyProfile(phone);
}

function redeemLoyaltyPoints(phone, points, note = 'Đổi điểm') {
  const p = cleanPhone(phone);
  const want = Math.max(0, Math.floor(Number(points) || 0));
  if (!p || want <= 0) return { ok: false, error: 'Điểm không hợp lệ' };
  const store = readJson(LOYALTY_FILE, {});
  const row = store[p] || { points: 0, ordersCount: 0, history: [], redeemed: 0 };
  if ((row.points || 0) < want) return { ok: false, error: 'Không đủ điểm' };
  row.points -= want;
  row.redeemed = (row.redeemed || 0) + want;
  row.history = row.history || [];
  row.history.unshift({ type: 'redeem', points: -want, at: Date.now(), note });
  store[p] = row;
  writeJson(LOYALTY_FILE, store);
  // 1 point ≈ 100đ discount value suggestion
  return { ok: true, profile: getLoyaltyProfile(p), discountSuggestion: want * 100 };
}

function applyLoyaltyDiscountToOrder(order, pointsToRedeem) {
  const phone = cleanPhone(order?.ordererPhone || order?.deliveryPhone);
  const result = redeemLoyaltyPoints(phone, pointsToRedeem, `Đổi điểm đơn ${order?.id || ''}`);
  if (!result.ok) return result;
  const discount = Math.min(result.discountSuggestion, order.appTotal || 0);
  order.loyaltyPointsRedeemed = pointsToRedeem;
  order.loyaltyDiscount = discount;
  order.discountValue = (order.discountValue || 0) + discount;
  order.appTotal = Math.max(0, (order.appTotal || 0) - discount);
  order.shipperEarning = Math.max(0, (order.appTotal || 0) - (order.storeTotal || 0));
  return { ok: true, discount, profile: result.profile };
}

// ── CSAT follow-up ─────────────────────────────────────────────────────────
function enqueueCsatFollowup(order, opts = {}) {
  if (!order?.id) return null;
  const store = readJson(CSAT_FILE, []);
  if (store.some((e) => e.orderId === order.id)) return store.find((e) => e.orderId === order.id);
  const customerPhone = cleanPhone(order.deliveryPhone || order.ordererPhone);
  const trackingBase = opts.trackingBaseUrl || process.env.CUSTOMER_APP_URL || 'https://shipfee.vercel.app/customer-app';
  const token = order.trackingToken || '';
  const surveyUrl = `${trackingBase.replace(/\/$/, '')}/tracking.html?orderId=${encodeURIComponent(order.id)}${token ? `&token=${encodeURIComponent(token)}` : ''}&csat=1`;
  const entry = {
    id: `csat-${Date.now()}`,
    orderId: order.id,
    customerPhone,
    customerName: order.deliveryName || '',
    shipperPhone: order.shipperPhone || '',
    surveyUrl,
    channel: opts.channel || 'telegram_admin', // telegram_admin | webhook | pending_sms
    status: 'pending',
    createdAt: Date.now(),
    sentAt: null,
    message: `ShipFee: Cảm ơn bạn đã đặt đơn ${order.id}. Đánh giá nhanh: ${surveyUrl}`
  };
  store.unshift(entry);
  if (store.length > 500) store.length = 500;
  writeJson(CSAT_FILE, store);
  return entry;
}

function markCsatSent(orderId, meta = {}) {
  const store = readJson(CSAT_FILE, []);
  const idx = store.findIndex((e) => e.orderId === orderId);
  if (idx === -1) return null;
  store[idx].status = 'sent';
  store[idx].sentAt = Date.now();
  Object.assign(store[idx], meta);
  writeJson(CSAT_FILE, store);
  return store[idx];
}

function listCsatFollowups({ status, limit = 50 } = {}) {
  let list = readJson(CSAT_FILE, []);
  if (status) list = list.filter((e) => e.status === status);
  return list.slice(0, limit);
}

async function processCsatFollowup(order, telegramBot) {
  const entry = enqueueCsatFollowup(order);
  if (!entry || entry.status === 'sent') return entry;

  // Prefer webhook if configured (Zalo/SMS gateway)
  const webhook = process.env.CSAT_WEBHOOK_URL;
  if (webhook) {
    try {
      const axios = require('axios');
      await axios.post(webhook, {
        type: 'csat_followup',
        phone: entry.customerPhone,
        message: entry.message,
        surveyUrl: entry.surveyUrl,
        orderId: entry.orderId
      }, { timeout: 8000 });
      return markCsatSent(order.id, { channel: 'webhook' });
    } catch (e) {
      console.warn('[CSAT] webhook failed:', e.message);
    }
  }

  // Fallback: notify admin Telegram with copy-ready SMS/Zalo text
  if (telegramBot && typeof telegramBot.sendMessage === 'function') {
    try {
      const text =
        `📋 <b>CSAT follow-up</b>\n` +
        `Đơn <code>${entry.orderId}</code>\n` +
        `Khách: ${entry.customerName || '—'} · <code>${entry.customerPhone}</code>\n` +
        `Gửi Zalo/SMS:\n<code>${entry.message}</code>`;
      await telegramBot.sendMessage(text);
      return markCsatSent(order.id, { channel: 'telegram_admin' });
    } catch (e) {
      console.warn('[CSAT] telegram failed:', e.message);
    }
  }

  return entry;
}

function onOrderDelivered(order, { telegramBot, crm, addNotification } = {}) {
  const loyalty = awardLoyaltyForDelivery(order);
  processCsatFollowup(order, telegramBot).catch((e) => console.warn('[CSAT]', e.message));
  if (addNotification && loyalty) {
    try {
      addNotification(
        'loyalty_earn',
        order.restaurantId || null,
        order.restaurantName || '',
        'Loyalty điểm',
        `Khách ${loyalty.phone} +điểm → ${loyalty.points} (${loyalty.tier})`
      );
    } catch (_) {}
  }
  return { loyalty };
}

// ── Heatmap ────────────────────────────────────────────────────────────────
function buildCustomerHeatmap(orders, { shipperPhone, from, to } = {}) {
  const sp = cleanPhone(shipperPhone);
  const fromTs = from ? new Date(from).getTime() : 0;
  let toTs = Date.now();
  if (to) {
    const d = new Date(to);
    d.setHours(23, 59, 59, 999);
    toTs = d.getTime();
  }
  const buckets = new Map();
  for (const o of orders || []) {
    if (o.status === 'CANCELLED') continue;
    const at = o.deliveredAt || o.createdAt || 0;
    if (at < fromTs || at > toTs) continue;
    if (sp && cleanPhone(o.shipperPhone) !== sp) continue;
    const lat = Number(o.pinnedLat);
    const lon = Number(o.pinnedLon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // grid ~150m
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        lat: Number(lat.toFixed(3)),
        lon: Number(lon.toFixed(3)),
        weight: 0,
        orders: 0,
        customers: new Set()
      });
    }
    const b = buckets.get(key);
    b.weight += 1;
    b.orders += 1;
    b.customers.add(cleanPhone(o.deliveryPhone || o.ordererPhone));
  }
  return Array.from(buckets.values())
    .map((b) => ({
      lat: b.lat,
      lon: b.lon,
      weight: b.weight,
      orders: b.orders,
      uniqueCustomers: b.customers.size
    }))
    .sort((a, b) => b.weight - a.weight);
}

module.exports = {
  enrichOrderForShipper,
  countPastDeliveries,
  applyPreferShipperBoost,
  isShipperBlacklistedCustomer,
  addShipperBlacklist,
  removeShipperBlacklist,
  listShipperBlacklist,
  getLoyaltyProfile,
  awardLoyaltyForDelivery,
  redeemLoyaltyPoints,
  applyLoyaltyDiscountToOrder,
  enqueueCsatFollowup,
  markCsatSent,
  listCsatFollowups,
  processCsatFollowup,
  onOrderDelivered,
  buildCustomerHeatmap,
  PREFER_SHIPPER_SCORE_MULT
};
