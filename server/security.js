/**
 * ShipFee — Security middleware & helpers
 * Rate limits, bot filter, helmet, input guards
 */
'use strict';

const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');

const BOT_UA_RE = /(bot|crawler|spider|scrapy|httpclient|python-requests|curl\/|wget|go-http|java\/|libwww|ai-?agent|gptbot|claudebot|bytespider|semrush|ahrefs|petalbot|dataforseo|headlesschrome)/i;

const ALLOWED_ORIGINS = new Set([
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'https://shipfee.vercel.app',
  'https://shipfee-hieuhuynh234s-projects.vercel.app',
  'https://shipfee-eo5s.onrender.com'
]);

function isAllowedOrigin(origin) {
  if (!origin) return true; // non-browser / same-origin tools
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Only shipfee-* preview deployments on Vercel, not arbitrary *.vercel.app
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:') return false;
    if (u.hostname === 'shipfee.vercel.app') return true;
    if (/^shipfee-[a-z0-9-]+-hieuhuynh234s-projects\.vercel\.app$/i.test(u.hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

function clientIp(req) {
  return (req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '')
    .toString()
    .split(',')[0]
    .trim();
}

function normalizePhone(phone) {
  let p = (phone || '').toString().trim().replace(/[\s\-.]/g, '');
  if (p.startsWith('+84')) p = '0' + p.slice(3);
  if (p.startsWith('84') && p.length >= 10) p = '0' + p.slice(2);
  return p;
}

function isValidVnPhone(phone) {
  return /^0\d{9,10}$/.test(normalizePhone(phone));
}

function sanitizeMessageText(text, maxLen = 1000) {
  return String(text || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/<[^>]*>/g, '')
    .trim()
    .slice(0, maxLen);
}

function stripShipperPublic(shipper) {
  if (!shipper) return null;
  return {
    name: shipper.name || '',
    phone: shipper.phone || '',
    rating: shipper.rating ?? 5,
    totalOrders: shipper.totalOrders ?? 0,
    status: shipper.status || 'OFFLINE',
    avatarUrl: shipper.avatarUrl || '',
    isApproved: shipper.isApproved !== false
  };
}

/** Validate base64 image; returns { ok, buffer, contentType, error } */
function validateAvatarBase64(base64Data, maxBytes = 1024 * 1024) {
  if (!base64Data || typeof base64Data !== 'string') {
    return { ok: false, error: 'Thiếu dữ liệu ảnh' };
  }
  if (base64Data.length > maxBytes * 1.4) {
    return { ok: false, error: 'Ảnh quá lớn (tối đa 1MB)' };
  }
  const match = base64Data.match(/^data:(image\/(png|jpeg|jpg|webp));base64,/i);
  const contentType = match ? match[1].toLowerCase().replace('jpg', 'jpeg') : null;
  const clean = base64Data.replace(/^data:image\/\w+;base64,/, '');
  let buffer;
  try {
    buffer = Buffer.from(clean, 'base64');
  } catch {
    return { ok: false, error: 'Ảnh không hợp lệ' };
  }
  if (!buffer.length || buffer.length > maxBytes) {
    return { ok: false, error: 'Ảnh quá lớn hoặc rỗng (tối đa 1MB)' };
  }
  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const isJpg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isWebp = buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  if (!isPng && !isJpg && !isWebp) {
    return { ok: false, error: 'Chỉ chấp nhận ảnh PNG/JPEG/WebP' };
  }
  const detected = isPng ? 'image/png' : isJpg ? 'image/jpeg' : 'image/webp';
  return { ok: true, buffer, contentType: contentType || detected };
}

function createSecurityMiddleware() {
  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 180,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.' },
    keyGenerator: (req) => clientIp(req) || 'unknown'
  });

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Quá nhiều lần đăng nhập/đăng ký. Thử lại sau 15 phút.' },
    keyGenerator: (req) => clientIp(req) || 'unknown'
  });

  const writeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Quá nhiều thao tác ghi. Vui lòng chậm lại.' },
    keyGenerator: (req) => clientIp(req) || 'unknown'
  });

  const orderCreateLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Bạn đang tạo đơn quá nhanh. Vui lòng thử lại sau.' },
    keyGenerator: (req) => clientIp(req) || 'unknown'
  });

  const speedLimiter = slowDown({
    windowMs: 60 * 1000,
    delayAfter: 60,
    delayMs: () => 250,
    maxDelayMs: 3000
  });

  function botFilter(req, res, next) {
    // Health checks & local tools
    if (req.path === '/api/status' || req.path === '/api/config') return next();

    const ua = (req.headers['user-agent'] || '').trim();
    if (!ua) {
      // Allow empty UA for some mobile WebViews but throttle via rate limit
      return next();
    }
    if (BOT_UA_RE.test(ua)) {
      // Soft-block: refuse mutating / sensitive APIs; allow static GET of public menus lightly
      if (req.method !== 'GET' || req.path.startsWith('/api/orders') || req.path.startsWith('/api/shippers') || req.path.startsWith('/api/admin')) {
        return res.status(403).json({ success: false, error: 'Truy cập bị từ chối.' });
      }
    }
    next();
  }

  /** Reject honeypot fields filled by bots (_hp, website, company) */
  function honeypotGuard(req, res, next) {
    const body = req.body || {};
    const traps = ['_hp', 'website', 'company', 'fax'];
    for (const key of traps) {
      if (body[key] != null && String(body[key]).trim() !== '') {
        // Fake success to waste bot cycles
        return res.status(200).json({ success: true, ignored: true });
      }
    }
    next();
  }

  function requestId(req, res, next) {
    const id = req.headers['x-request-id'] || crypto.randomBytes(8).toString('hex');
    res.setHeader('X-Request-Id', id);
    req.requestId = id;
    next();
  }

  const helmetMw = helmet({
    contentSecurityPolicy: false, // frontends set their own via Vercel headers
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
  });

  return {
    helmetMw,
    globalLimiter,
    authLimiter,
    writeLimiter,
    orderCreateLimiter,
    speedLimiter,
    botFilter,
    honeypotGuard,
    requestId,
    isAllowedOrigin,
    normalizePhone,
    isValidVnPhone,
    sanitizeMessageText,
    stripShipperPublic,
    validateAvatarBase64,
    clientIp
  };
}

module.exports = {
  createSecurityMiddleware,
  isAllowedOrigin,
  normalizePhone,
  isValidVnPhone,
  sanitizeMessageText,
  stripShipperPublic,
  validateAvatarBase64
};
