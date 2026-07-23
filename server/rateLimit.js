'use strict';

/**
 * Lightweight in-memory rate limiter (no extra dependency).
 * Suitable for single-instance Render Free.
 */

function getIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = xf || req.headers['cf-connecting-ip'] || req.ip || req.socket?.remoteAddress || '';
  return String(ip).replace(/^::ffff:/, '') || 'unknown';
}

/**
 * @param {{ windowMs?: number, max?: number, keyFn?: Function, message?: string }} opts
 */
function createRateLimiter(opts = {}) {
  const windowMs = Math.max(1000, opts.windowMs || 60_000);
  const max = Math.max(1, opts.max || 60);
  const keyFn = opts.keyFn || ((req) => getIp(req));
  const message = opts.message || 'Quá nhiều yêu cầu. Vui lòng thử lại sau.';
  const hits = new Map();

  // Periodic cleanup
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) {
      if (!v || v.resetAt <= now) hits.delete(k);
    }
  }, Math.min(windowMs, 60_000)).unref?.();

  return function rateLimit(req, res, next) {
    const key = String(keyFn(req) || getIp(req));
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
    if (entry.count > max) {
      return res.status(429).json({ success: false, error: message });
    }
    return next();
  };
}

module.exports = { createRateLimiter, getIp };
