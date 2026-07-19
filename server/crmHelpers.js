'use strict';

const fs = require('fs');
const path = require('path');

const AUDIT_FILE = path.join(__dirname, 'admin-audit-local.json');
const PROMOS_FILE = path.join(__dirname, 'promos-local.json');
const ZONES_FILE = path.join(__dirname, 'delivery-zones-local.json');
const BLACKLIST_FILE = path.join(__dirname, 'customer-blacklist-local.json');
const DISPUTES_FILE = path.join(__dirname, 'disputes-local.json');
const SHIPPER_SUPPORT_FILE = path.join(__dirname, 'shipper-support-local.json');
const COMMISSIONS_FILE = path.join(__dirname, 'restaurant-commissions-local.json');

const SLA_NOTIFIED = new Map(); // orderId -> lastNotifiedAt

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

function resolveAdminRole(user) {
  if (!user) return null;
  if (user.email === 'admin@shipfee.vn') return 'admin';
  const role = user.user_metadata?.role;
  if (role === 'admin' || role === 'ops' || role === 'viewer') return role;
  return null;
}

function requireAdminRole(...allowed) {
  return (req, res, next) => {
    if (!req.adminRole || !allowed.includes(req.adminRole)) {
      return res.status(403).json({ success: false, error: 'Không đủ quyền thực hiện thao tác này.' });
    }
    next();
  };
}

function canMutatePricing(role) {
  return role === 'admin';
}

function canMutateShippers(role) {
  return role === 'admin' || role === 'ops';
}

function canMutateOrders(role) {
  return role === 'admin' || role === 'ops';
}

function logAdminAudit(req, action, details = {}) {
  try {
    const logs = readJson(AUDIT_FILE, []);
    logs.unshift({
      id: `audit-${Date.now()}-${Math.floor(Math.random() * 9999)}`,
      at: Date.now(),
      adminEmail: req.user?.email || 'unknown',
      adminRole: req.adminRole || 'unknown',
      action,
      details
    });
    if (logs.length > 500) logs.length = 500;
    writeJson(AUDIT_FILE, logs);
  } catch (e) {
    console.warn('[Audit Log]', e.message);
  }
}

function readAuditLog(limit = 100) {
  return readJson(AUDIT_FILE, []).slice(0, limit);
}

function readPromos() {
  return readJson(PROMOS_FILE, []);
}

function writePromos(list) {
  writeJson(PROMOS_FILE, list);
}

function validatePromo(code, subtotal) {
  if (!code) return { valid: false, error: 'Thiếu mã giảm giá' };
  const promos = readPromos();
  const promo = promos.find(p => p.code.toUpperCase() === String(code).trim().toUpperCase() && p.active !== false);
  if (!promo) return { valid: false, error: 'Mã không tồn tại hoặc đã hết hạn' };
  if (promo.expiresAt && Date.now() > promo.expiresAt) {
    return { valid: false, error: 'Mã đã hết hạn' };
  }
  if (promo.maxUses != null && (promo.usedCount || 0) >= promo.maxUses) {
    return { valid: false, error: 'Mã đã hết lượt sử dụng' };
  }
  if (promo.minOrder && subtotal < promo.minOrder) {
    return { valid: false, error: `Đơn tối thiểu ${promo.minOrder.toLocaleString('vi-VN')}đ` };
  }
  let discount = 0;
  if (promo.type === 'percent') {
    discount = Math.round(subtotal * (promo.value / 100) / 100) * 100;
    if (promo.maxDiscount) discount = Math.min(discount, promo.maxDiscount);
  } else if (promo.type === 'fixed') {
    discount = promo.value;
  } else if (promo.type === 'free_ship') {
    discount = 0;
  }
  discount = Math.min(discount, subtotal);
  return { valid: true, promo, discount };
}

function incrementPromoUse(code) {
  const promos = readPromos();
  const idx = promos.findIndex(p => p.code.toUpperCase() === String(code).trim().toUpperCase());
  if (idx === -1) return;
  promos[idx].usedCount = (promos[idx].usedCount || 0) + 1;
  writePromos(promos);
}

function readZones() {
  return readJson(ZONES_FILE, []);
}

function writeZones(list) {
  writeJson(ZONES_FILE, list);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some(v => typeof v !== 'number')) return Infinity;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isInDeliveryZone(lat, lon) {
  const zones = readZones().filter(z => z.active !== false);
  if (zones.length === 0) return { ok: true };
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    return { ok: false, error: 'Thiếu tọa độ giao hàng để kiểm tra khu vực.' };
  }
  for (const z of zones) {
    const dist = haversineKm(lat, lon, z.centerLat, z.centerLon);
    if (dist <= (z.radiusKm || 3)) {
      return { ok: true, zone: z };
    }
  }
  return { ok: false, error: 'Địa chỉ giao hàng nằm ngoài khu vực phục vụ.' };
}

function readBlacklist() {
  return readJson(BLACKLIST_FILE, []);
}

function writeBlacklist(list) {
  writeJson(BLACKLIST_FILE, list);
}

function cleanPhone(phone) {
  return String(phone || '').trim().replace(/\s+/g, '');
}

function isBlacklisted(phone) {
  const p = cleanPhone(phone);
  if (!p) return null;
  return readBlacklist().find(b => cleanPhone(b.phone) === p) || null;
}

function addToBlacklist(phone, reason = 'Admin', by = 'telegram-admin') {
  const cleaned = cleanPhone(phone);
  if (!cleaned) return null;
  const list = readBlacklist();
  if (list.some(b => cleanPhone(b.phone) === cleaned)) return null;
  const entry = {
    phone: cleaned,
    reason: reason || 'Admin',
    blacklistedAt: Date.now(),
    blacklistedBy: by
  };
  list.unshift(entry);
  writeBlacklist(list);
  return entry;
}

function readDisputes() {
  return readJson(DISPUTES_FILE, []);
}

function writeDisputes(list) {
  writeJson(DISPUTES_FILE, list);
}

function readShipperSupportThreads() {
  return readJson(SHIPPER_SUPPORT_FILE, []);
}

function writeShipperSupportThreads(list) {
  writeJson(SHIPPER_SUPPORT_FILE, list);
}

/**
 * Lấy (hoặc tạo) thread hỗ trợ đang mở của tài xế — 1 thread open / shipper.
 */
function getOrCreateShipperSupportThread(shipper, { priority = 'normal', orderId = null } = {}) {
  const phone = cleanPhone(shipper?.phone);
  if (!phone) return null;

  const threads = readShipperSupportThreads();
  let thread = threads.find(t => cleanPhone(t.shipperPhone) === phone && t.status === 'open');

  if (!thread) {
    thread = {
      id: 'sst-' + Date.now() + '-' + Math.floor(1000 + Math.random() * 9000),
      type: 'shipper_support',
      shipperPhone: phone,
      shipperName: shipper.name || '',
      status: 'open',
      priority: priority === 'emergency' ? 'emergency' : 'normal',
      orderId: orderId || null,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      unreadForAdmin: 0,
      unreadForShipper: 0
    };
    threads.unshift(thread);
  } else {
    if (priority === 'emergency') thread.priority = 'emergency';
    if (orderId) thread.orderId = orderId;
    thread.shipperName = shipper.name || thread.shipperName;
    thread.updatedAt = Date.now();
  }

  writeShipperSupportThreads(threads);
  return thread;
}

function appendShipperSupportMessage(threadId, message) {
  const threads = readShipperSupportThreads();
  const idx = threads.findIndex(t => t.id === threadId);
  if (idx === -1) return null;

  const msg = {
    id: 'ssm-' + Date.now() + '-' + Math.floor(100 + Math.random() * 900),
    sender: message.sender, // shipper | admin
    role: message.role || message.sender,
    text: String(message.text || '').trim(),
    timestamp: Date.now(),
    adminEmail: message.adminEmail || null
  };
  if (!msg.text) return null;

  threads[idx].messages = threads[idx].messages || [];
  threads[idx].messages.push(msg);
  threads[idx].updatedAt = Date.now();
  if (message.priority === 'emergency') threads[idx].priority = 'emergency';
  if (message.orderId) threads[idx].orderId = message.orderId;

  if (msg.sender === 'shipper') {
    threads[idx].unreadForAdmin = (threads[idx].unreadForAdmin || 0) + 1;
  } else {
    threads[idx].unreadForShipper = (threads[idx].unreadForShipper || 0) + 1;
  }

  writeShipperSupportThreads(threads);
  return threads[idx];
}

function markShipperSupportRead(threadId, reader) {
  const threads = readShipperSupportThreads();
  const idx = threads.findIndex(t => t.id === threadId);
  if (idx === -1) return null;
  const beforeAdmin = threads[idx].unreadForAdmin || 0;
  const beforeShipper = threads[idx].unreadForShipper || 0;
  if (reader === 'admin') threads[idx].unreadForAdmin = 0;
  if (reader === 'shipper') threads[idx].unreadForShipper = 0;
  // Skip disk write when nothing changed — reduces race with concurrent send/reply
  if (
    (reader === 'admin' && beforeAdmin === 0) ||
    (reader === 'shipper' && beforeShipper === 0)
  ) {
    return threads[idx];
  }
  writeShipperSupportThreads(threads);
  return threads[idx];
}

function readCommissions() {
  return readJson(COMMISSIONS_FILE, { defaultRate: 0.28, restaurants: {} });
}

function writeCommissions(data) {
  writeJson(COMMISSIONS_FILE, data);
}

function getRestaurantCommissionRate(restaurantId) {
  const cfg = readCommissions();
  if (cfg.restaurants && cfg.restaurants[restaurantId] != null) {
    return cfg.restaurants[restaurantId];
  }
  return cfg.defaultRate ?? 0.28;
}

function parseRangeDays(range) {
  const map = { '7d': 7, '30d': 30, '90d': 90 };
  return map[range] || 7;
}

function computeAnalytics(orders, shippers, range = '7d') {
  const days = parseRangeDays(range);
  const now = Date.now();
  const start = now - days * 86400000;
  const prevStart = start - days * 86400000;

  const inRange = (o, from, to) => (o.createdAt || 0) >= from && (o.createdAt || 0) < to;
  const current = orders.filter(o => inRange(o, start, now));
  const previous = orders.filter(o => inRange(o, prevStart, start));

  const completed = current.filter(o => o.status === 'DELIVERED');
  const prevCompleted = previous.filter(o => o.status === 'DELIVERED');
  const revenue = completed.reduce((s, o) => s + (o.appTotal || 0), 0);
  const prevRevenue = prevCompleted.reduce((s, o) => s + (o.appTotal || 0), 0);
  const cancelled = current.filter(o => o.status === 'CANCELLED').length;

  const restMap = {};
  completed.forEach(o => {
    const id = o.restaurantId || o.restaurantName || 'unknown';
    if (!restMap[id]) restMap[id] = { id, name: o.restaurantName || id, orders: 0, revenue: 0 };
    restMap[id].orders += 1;
    restMap[id].revenue += o.appTotal || 0;
  });
  const topRestaurants = Object.values(restMap).sort((a, b) => b.revenue - a.revenue).slice(0, 10);

  const shipperStats = shippers.map(s => ({
    phone: s.phone,
    name: s.name,
    status: s.status,
    totalOrders: s.totalOrders || 0,
    totalEarnings: s.totalEarnings || 0,
    acceptanceRate: s.acceptanceRate ?? 100,
    completionRate: s.completionRate ?? 100
  })).sort((a, b) => b.totalEarnings - a.totalEarnings).slice(0, 20);

  const wow = (cur, prev) => {
    if (!prev) return cur ? 100 : 0;
    return Math.round(((cur - prev) / prev) * 100);
  };

  return {
    range,
    days,
    totalOrders: current.length,
    completedOrders: completed.length,
    cancelledOrders: cancelled,
    completionRate: current.length ? Math.round((completed.length / current.length) * 100) : 0,
    totalRevenue: revenue,
    aov: completed.length ? Math.round(revenue / completed.length) : 0,
    wow: {
      orders: wow(current.length, previous.length),
      revenue: wow(revenue, prevRevenue),
      completed: wow(completed.length, prevCompleted.length)
    },
    topRestaurants,
    shipperStats,
    daily: buildDailySeries(completed, days)
  };
}

function buildDailySeries(completedOrders, days) {
  const series = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    d.setHours(0, 0, 0, 0);
    const end = d.getTime() + 86400000;
    const dayOrders = completedOrders.filter(o => o.createdAt >= d.getTime() && o.createdAt < end);
    series.push({
      date: d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }),
      orders: dayOrders.length,
      revenue: dayOrders.reduce((s, o) => s + (o.appTotal || 0), 0)
    });
  }
  return series;
}

function computeSettlementReport(orders, from, to) {
  const fromTs = from ? new Date(from).getTime() : 0;
  const toEnd = to ? new Date(to) : new Date();
  if (to) toEnd.setHours(23, 59, 59, 999);
  const toTs = toEnd.getTime();

  const completed = orders.filter(o =>
    o.status === 'DELIVERED' &&
    (o.createdAt || 0) >= fromTs &&
    (o.createdAt || 0) <= toTs
  );

  const byRestaurant = {};
  completed.forEach(o => {
    const id = o.restaurantId || 'unknown';
    if (!byRestaurant[id]) {
      byRestaurant[id] = {
        restaurantId: id,
        restaurantName: o.restaurantName || id,
        orders: 0,
        gmv: 0,
        storeTotal: 0,
        commissionRate: getRestaurantCommissionRate(id),
        commissionAmount: 0,
        platformNet: 0
      };
    }
    const row = byRestaurant[id];
    row.orders += 1;
    row.gmv += o.appTotal || 0;
    row.storeTotal += o.storeTotal || 0;
  });

  Object.values(byRestaurant).forEach(row => {
    const margin = Math.max(0, row.gmv - row.storeTotal);
    row.commissionAmount = Math.round(margin * row.commissionRate);
    row.platformNet = margin - row.commissionAmount;
  });

  return {
    from: from || null,
    to: to || null,
    totalGmv: completed.reduce((s, o) => s + (o.appTotal || 0), 0),
    restaurants: Object.values(byRestaurant).sort((a, b) => b.gmv - a.gmv)
  };
}

function computeShipperPayouts(orders, shippers, from, to) {
  const fromTs = from ? new Date(from).getTime() : 0;
  const toEnd = to ? new Date(to) : new Date();
  if (to) toEnd.setHours(23, 59, 59, 999);
  const toTs = toEnd.getTime();

  const completed = orders.filter(o =>
    o.status === 'DELIVERED' &&
    (o.deliveredAt || o.createdAt || 0) >= fromTs &&
    (o.deliveredAt || o.createdAt || 0) <= toTs
  );

  const map = {};
  completed.forEach(o => {
    const phone = cleanPhone(o.shipperPhone);
    if (!phone) return;
    if (!map[phone]) {
      const s = shippers.find(x => cleanPhone(x.phone) === phone);
      map[phone] = {
        phone,
        name: o.shipperName || s?.name || phone,
        orders: 0,
        earnings: 0
      };
    }
    map[phone].orders += 1;
    map[phone].earnings += o.shipperEarning || 0;
  });

  return Object.values(map).sort((a, b) => b.earnings - a.earnings);
}

function checkSlaAndNotify(activeOrders, getOrderSlaInfo, addNotification) {
  const now = Date.now();
  for (const order of activeOrders) {
    const sla = getOrderSlaInfo(order);
    if (!sla) continue;
    const last = SLA_NOTIFIED.get(order.id) || 0;
    if (now - last < 15 * 60 * 1000) continue;
    SLA_NOTIFIED.set(order.id, now);
    addNotification(
      'sla_breach',
      order.restaurantId || null,
      order.restaurantName || '',
      'Đơn quá SLA',
      `Đơn ${order.id} (${order.status}): ${sla.type} — ${Math.round(sla.ageMs / 60000)} phút`
    );
  }
}

function notifyOrderCancelled(order, addNotification) {
  addNotification(
    'order_cancelled',
    order.restaurantId || null,
    order.restaurantName || '',
    'Đơn đã hủy',
    `Đơn ${order.id} bị hủy${order.cancelReason ? ': ' + order.cancelReason : ''}`
  );
}

function escapeCsvCell(val) {
  const s = val == null ? '' : String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

module.exports = {
  resolveAdminRole,
  requireAdminRole,
  canMutatePricing,
  canMutateShippers,
  canMutateOrders,
  logAdminAudit,
  readAuditLog,
  readPromos,
  writePromos,
  validatePromo,
  incrementPromoUse,
  readZones,
  writeZones,
  isInDeliveryZone,
  readBlacklist,
  writeBlacklist,
  isBlacklisted,
  addToBlacklist,
  cleanPhone,
  readDisputes,
  writeDisputes,
  readShipperSupportThreads,
  writeShipperSupportThreads,
  getOrCreateShipperSupportThread,
  appendShipperSupportMessage,
  markShipperSupportRead,
  readCommissions,
  writeCommissions,
  getRestaurantCommissionRate,
  computeAnalytics,
  computeSettlementReport,
  computeShipperPayouts,
  checkSlaAndNotify,
  notifyOrderCancelled,
  escapeCsvCell,
  parseRangeDays
};
