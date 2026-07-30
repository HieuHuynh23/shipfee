'use strict';

/**
 * Customer portal: OTP login, session, profile (addresses/favorites),
 * push subscriptions, personalized offers & order suggestions.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const DATA_FILE = path.join(__dirname, 'customer-portal-local.json');
const OTP_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ADDRESSES = 8;
const MAX_FAVORITES = 40;
const MAX_PUSH = 5;

function sessionSecret() {
  return (
    process.env.CUSTOMER_SESSION_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.TELEGRAM_BOT_TOKEN ||
    'shipfee-customer-dev-secret'
  );
}

function cleanPhone(phone) {
  let p = String(phone || '').replace(/\D/g, '');
  if (p.startsWith('84') && p.length >= 11) p = '0' + p.slice(2);
  return p;
}

function isValidVnPhone(phone) {
  return /^0[35789]\d{8}$/.test(cleanPhone(phone));
}

function readStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { otps: {}, sessions: {}, profiles: {} };
    }
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      otps: raw.otps && typeof raw.otps === 'object' ? raw.otps : {},
      sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
      profiles: raw.profiles && typeof raw.profiles === 'object' ? raw.profiles : {}
    };
  } catch {
    return { otps: {}, sessions: {}, profiles: {} };
  }
}

function writeStore(store) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (e) {
    console.error('[CustomerPortal] writeStore failed:', e.message);
  }
}

function pruneExpired(store) {
  const now = Date.now();
  Object.keys(store.otps || {}).forEach((k) => {
    if (!store.otps[k] || store.otps[k].expiresAt < now) delete store.otps[k];
  });
  Object.keys(store.sessions || {}).forEach((k) => {
    if (!store.sessions[k] || store.sessions[k].expiresAt < now) delete store.sessions[k];
  });
}

function defaultProfile(phone) {
  return {
    phone,
    name: '',
    addresses: [],
    favorites: [],
    pushSubscriptions: [],
    theme: 'system',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastLoginAt: null
  };
}

function getProfile(phone) {
  const p = cleanPhone(phone);
  if (!p) return null;
  const store = readStore();
  return store.profiles[p] ? { ...defaultProfile(p), ...store.profiles[p] } : defaultProfile(p);
}

function saveProfile(phone, patch) {
  const p = cleanPhone(phone);
  if (!p) return null;
  const store = readStore();
  const current = { ...defaultProfile(p), ...(store.profiles[p] || {}) };
  const next = { ...current, ...patch, phone: p, updatedAt: Date.now() };
  if (Array.isArray(patch.addresses)) {
    next.addresses = patch.addresses.slice(0, MAX_ADDRESSES).map((a, i) => ({
      id: a.id || `addr-${Date.now()}-${i}`,
      label: String(a.label || 'Địa chỉ').slice(0, 40),
      address: String(a.address || '').slice(0, 300),
      name: String(a.name || '').slice(0, 80),
      phone: cleanPhone(a.phone || p),
      lat: Number.isFinite(Number(a.lat)) ? Number(a.lat) : null,
      lon: Number.isFinite(Number(a.lon)) ? Number(a.lon) : null,
      isDefault: !!a.isDefault
    }));
  }
  if (Array.isArray(patch.favorites)) {
    next.favorites = patch.favorites.slice(0, MAX_FAVORITES);
  }
  store.profiles[p] = next;
  writeStore(store);
  return next;
}

function hashOtp(code) {
  return crypto.createHmac('sha256', sessionSecret()).update(String(code)).digest('hex');
}

async function deliverOtp(phone, code) {
  const webhook = process.env.CUSTOMER_OTP_WEBHOOK_URL || process.env.CSAT_WEBHOOK_URL || '';
  let delivered = false;
  let channel = 'none';

  if (webhook) {
    try {
      await axios.post(
        webhook,
        { type: 'customer_otp', phone, code, message: `ShipFee OTP: ${code}` },
        { timeout: 8000 }
      );
      delivered = true;
      channel = 'webhook';
    } catch (e) {
      console.warn('[CustomerPortal] OTP webhook failed:', e.message);
    }
  }

  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChat) {
    try {
      await axios.post(
        `https://api.telegram.org/bot${tgToken}/sendMessage`,
        {
          chat_id: tgChat,
          text: `🔐 OTP khách ${phone}: ${code}\nHết hạn sau 5 phút.`
        },
        { timeout: 8000 }
      );
      delivered = true;
      channel = channel === 'webhook' ? 'webhook+telegram' : 'telegram';
    } catch (e) {
      console.warn('[CustomerPortal] OTP telegram failed:', e.message);
    }
  }

  const forceInline = process.env.CUSTOMER_OTP_INLINE === '1';
  const allowInline =
    forceInline ||
    !delivered ||
    process.env.NODE_ENV !== 'production' ||
    process.env.CUSTOMER_OTP_INLINE !== '0';

  return { delivered, channel, inline: allowInline };
}

function requestOtp(phoneRaw) {
  const phone = cleanPhone(phoneRaw);
  if (!isValidVnPhone(phone)) {
    return Promise.resolve({ ok: false, error: 'SĐT không hợp lệ (10 số, đầu 03/05/07/08/09)' });
  }
  const code = String(crypto.randomInt(100000, 999999));
  const store = readStore();
  pruneExpired(store);
  store.otps[phone] = {
    hash: hashOtp(code),
    expiresAt: Date.now() + OTP_TTL_MS,
    attempts: 0,
    createdAt: Date.now()
  };
  writeStore(store);

  return deliverOtp(phone, code).then((delivery) => ({
    ok: true,
    phone,
    expiresInSec: Math.floor(OTP_TTL_MS / 1000),
    delivery: delivery.channel,
    demoCode: delivery.inline ? code : undefined,
    message: delivery.inline
      ? 'Mã xác thực đã tạo. Dùng mã bên dưới để đăng nhập (hoặc mã gửi Telegram/SMS nếu có).'
      : 'Mã xác thực đã gửi. Vui lòng kiểm tra tin nhắn / liên hệ hỗ trợ nếu chưa nhận.'
  }));
}

function mintSession(phone) {
  const p = cleanPhone(phone);
  const payload = Buffer.from(
    JSON.stringify({ p, exp: Date.now() + SESSION_TTL_MS, n: crypto.randomBytes(8).toString('hex') })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  const token = `${payload}.${sig}`;
  const store = readStore();
  pruneExpired(store);
  store.sessions[token] = { phone: p, expiresAt: Date.now() + SESSION_TTL_MS };
  writeStore(store);
  return token;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data || !data.p || !data.exp || data.exp < Date.now()) return null;
  return cleanPhone(data.p);
}

function verifyOtp(phoneRaw, codeRaw, { name } = {}) {
  const phone = cleanPhone(phoneRaw);
  const code = String(codeRaw || '').trim();
  if (!isValidVnPhone(phone)) return { ok: false, error: 'SĐT không hợp lệ' };
  if (!/^\d{6}$/.test(code)) return { ok: false, error: 'Mã OTP gồm 6 chữ số' };

  const store = readStore();
  const row = store.otps[phone];
  if (!row) return { ok: false, error: 'Chưa yêu cầu mã hoặc mã đã hết hạn' };
  if (row.expiresAt < Date.now()) {
    delete store.otps[phone];
    writeStore(store);
    return { ok: false, error: 'Mã đã hết hạn, vui lòng gửi lại' };
  }
  row.attempts = (row.attempts || 0) + 1;
  if (row.attempts > 5) {
    delete store.otps[phone];
    writeStore(store);
    return { ok: false, error: 'Nhập sai quá nhiều lần. Gửi lại mã mới.' };
  }
  if (row.hash !== hashOtp(code)) {
    writeStore(store);
    return { ok: false, error: 'Mã OTP không đúng' };
  }
  delete store.otps[phone];
  writeStore(store);

  const existing = getProfile(phone);
  const profile = saveProfile(phone, {
    name: name ? String(name).trim().slice(0, 80) : existing.name,
    lastLoginAt: Date.now()
  });
  const token = mintSession(phone);
  return { ok: true, token, profile: publicProfile(profile) };
}

function publicProfile(profile) {
  if (!profile) return null;
  return {
    phone: profile.phone,
    name: profile.name || '',
    addresses: profile.addresses || [],
    favorites: profile.favorites || [],
    theme: profile.theme || 'system',
    updatedAt: profile.updatedAt || null,
    lastLoginAt: profile.lastLoginAt || null,
    pushEnabled: Array.isArray(profile.pushSubscriptions) && profile.pushSubscriptions.length > 0
  };
}

function extractBearer(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return req.headers['x-customer-token'] || req.query.customerToken || '';
}

function authenticateCustomer(req, res, next) {
  const phone = verifySessionToken(extractBearer(req));
  if (!phone) {
    return res.status(401).json({ success: false, error: 'Chưa đăng nhập hoặc phiên hết hạn' });
  }
  req.customerPhone = phone;
  req.customerProfile = getProfile(phone);
  next();
}

function softAuthenticateCustomer(req) {
  const phone = verifySessionToken(extractBearer(req));
  if (phone) {
    req.customerPhone = phone;
    req.customerProfile = getProfile(phone);
  }
}

function upsertPushSubscription(phone, subscription) {
  const p = cleanPhone(phone);
  if (!p || !subscription || !subscription.endpoint) return null;
  const profile = getProfile(p);
  const list = Array.isArray(profile.pushSubscriptions) ? profile.pushSubscriptions.slice() : [];
  const idx = list.findIndex((s) => s.endpoint === subscription.endpoint);
  const row = {
    endpoint: subscription.endpoint,
    keys: subscription.keys || {},
    expirationTime: subscription.expirationTime || null,
    updatedAt: Date.now()
  };
  if (idx >= 0) list[idx] = row;
  else list.unshift(row);
  return saveProfile(p, { pushSubscriptions: list.slice(0, MAX_PUSH) });
}

function removePushSubscription(phone, endpoint) {
  const profile = getProfile(phone);
  const list = (profile.pushSubscriptions || []).filter((s) => s.endpoint !== endpoint);
  return saveProfile(phone, { pushSubscriptions: list });
}

let _webPush = null;
let _vapidReady = false;

function ensureWebPush() {
  if (_vapidReady) return _webPush;
  _vapidReady = true;
  try {
    _webPush = require('web-push');
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    if (publicKey && privateKey) {
      _webPush.setVapidDetails(
        process.env.VAPID_SUBJECT || 'mailto:support@shipfee.vn',
        publicKey,
        privateKey
      );
    } else {
      _webPush = null;
    }
  } catch {
    _webPush = null;
  }
  return _webPush;
}

function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || '';
}

async function sendPushToPhone(phone, payload) {
  const webpush = ensureWebPush();
  const profile = getProfile(phone);
  const subs = profile.pushSubscriptions || [];
  if (!webpush || !subs.length) {
    return { sent: 0, skipped: true };
  }
  let sent = 0;
  const keep = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
      keep.push(sub);
      sent += 1;
    } catch (e) {
      if (e.statusCode !== 404 && e.statusCode !== 410) keep.push(sub);
    }
  }
  if (keep.length !== subs.length) saveProfile(phone, { pushSubscriptions: keep });
  return { sent, skipped: false };
}

function buildPersonalizedOffers(phone, { orders = [], loyalty = null, promos = [] } = {}) {
  const p = cleanPhone(phone);
  const myOrders = (orders || []).filter(
    (o) => cleanPhone(o.deliveryPhone) === p || cleanPhone(o.ordererPhone) === p
  );
  const delivered = myOrders.filter((o) => o.status === 'DELIVERED');
  const offers = [];

  if (delivered.length === 0) {
    offers.push({
      id: 'welcome',
      title: 'Ưu đãi đơn đầu',
      desc: 'Giảm phí khi đặt đơn đầu — áp mã WELCOME15 nếu còn hiệu lực',
      code: 'WELCOME15',
      badge: 'Mới'
    });
  } else if (delivered.length === 1) {
    offers.push({
      id: 'comeback',
      title: 'Quay lại giảm thêm',
      desc: 'Đơn thứ 2 được ưu đãi theo chính sách khách quay lại',
      code: null,
      badge: 'Dành cho bạn'
    });
  }

  if (loyalty && loyalty.points >= 50) {
    offers.push({
      id: 'loyalty',
      title: `Bạn có ${loyalty.points} điểm`,
      desc: 'Đổi điểm loyalty khi thanh toán để giảm tiền đơn',
      code: null,
      badge: loyalty.tier || 'Loyalty'
    });
  }

  const hour = new Date().getHours();
  if (hour >= 10 && hour < 14) {
    offers.push({
      id: 'lunch',
      title: 'Gợi ý giờ trưa',
      desc: 'Đặt từ 2 món để giảm phí món thứ 2 trở đi',
      code: null,
      badge: 'Trưa'
    });
  } else if (hour >= 17 && hour < 21) {
    offers.push({
      id: 'dinner',
      title: 'Gợi ý giờ tối',
      desc: 'Lưu quán yêu thích để đặt lại nhanh hơn',
      code: null,
      badge: 'Tối'
    });
  }

  const targeted = (promos || []).filter((promo) => {
    if (!promo || promo.active === false) return false;
    if (promo.expiresAt && Date.now() > promo.expiresAt) return false;
    if (Array.isArray(promo.phones) && promo.phones.length) {
      return promo.phones.map(cleanPhone).includes(p);
    }
    if (promo.minOrders != null && delivered.length < promo.minOrders) return false;
    if (promo.maxOrders != null && delivered.length > promo.maxOrders) return false;
    if (promo.forReturning && delivered.length < 1) return false;
    if (promo.forNew && delivered.length > 0) return false;
    return !!(promo.phones || promo.forReturning || promo.forNew || promo.minOrders != null);
  });

  targeted.slice(0, 5).forEach((promo) => {
    offers.push({
      id: `promo-${promo.code}`,
      title: promo.title || `Mã ${promo.code}`,
      desc: promo.description || 'Ưu đãi dành riêng cho bạn',
      code: promo.code,
      badge: 'Riêng bạn'
    });
  });

  return offers.slice(0, 8);
}

function buildSuggestions(phone, { orders = [], favorites = [] } = {}) {
  const p = cleanPhone(phone);
  const myOrders = (orders || [])
    .filter((o) => cleanPhone(o.deliveryPhone) === p || cleanPhone(o.ordererPhone) === p)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const itemFreq = new Map();
  const restFreq = new Map();
  myOrders.forEach((o) => {
    const rid = o.restaurantId;
    if (rid) {
      const prev = restFreq.get(String(rid)) || { id: rid, name: o.restaurantName, count: 0, lastAt: 0 };
      prev.count += 1;
      prev.lastAt = Math.max(prev.lastAt, o.createdAt || 0);
      restFreq.set(String(rid), prev);
    }
    (o.items || []).forEach((it) => {
      const key = `${o.restaurantId}::${it.id || it.name}`;
      const prev = itemFreq.get(key) || {
        restaurantId: o.restaurantId,
        restaurantName: o.restaurantName,
        itemId: it.id || it.realItemId,
        name: it.name,
        count: 0,
        lastAt: 0
      };
      prev.count += (it.quantity || it.qty || 1);
      prev.lastAt = Math.max(prev.lastAt, o.createdAt || 0);
      itemFreq.set(key, prev);
    });
  });

  const hour = new Date().getHours();
  let timeLabel = 'Gợi ý cho bạn';
  if (hour >= 6 && hour < 11) timeLabel = 'Gợi ý buổi sáng';
  else if (hour >= 11 && hour < 14) timeLabel = 'Gợi ý giờ trưa';
  else if (hour >= 17 && hour < 22) timeLabel = 'Gợi ý giờ tối';

  return {
    timeLabel,
    recentOrders: myOrders.slice(0, 5).map((o) => ({
      id: o.id,
      restaurantId: o.restaurantId,
      restaurantName: o.restaurantName,
      restaurantImg: o.restaurantImg || null,
      items: o.items || [],
      appTotal: o.appTotal,
      status: o.status,
      createdAt: o.createdAt,
      trackingToken: o.status !== 'DELIVERED' && o.status !== 'CANCELLED' ? o.trackingToken : null
    })),
    frequentItems: Array.from(itemFreq.values())
      .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
      .slice(0, 6),
    frequentRestaurants: Array.from(restFreq.values())
      .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
      .slice(0, 6),
    favorites: (favorites || []).slice(0, 10)
  };
}

function estimateEtaMinutes(distanceKm, isClosed) {
  if (isClosed) return null;
  const d = Number(distanceKm);
  if (!Number.isFinite(d) || d < 0) return 25;
  return Math.max(18, Math.min(55, Math.round(12 + d * 3.5 + 5)));
}

module.exports = {
  cleanPhone,
  isValidVnPhone,
  requestOtp,
  verifyOtp,
  verifySessionToken,
  authenticateCustomer,
  softAuthenticateCustomer,
  getProfile,
  saveProfile,
  publicProfile,
  upsertPushSubscription,
  removePushSubscription,
  sendPushToPhone,
  getVapidPublicKey,
  buildPersonalizedOffers,
  buildSuggestions,
  estimateEtaMinutes,
  extractBearer
};
