'use strict';

/**
 * Shipper presence — bất kỳ hoạt động xác thực nào (poll đơn, GPS, SSE)
 * đều giữ ca ONLINE. Tránh false OFFLINE khi GPS/auth chập chờn nhưng REST vẫn sống.
 */

const presenceByPhone = new Map(); // phone -> { lastSeen, sseConnected, lastSource }

const DEFAULT_STALE_MS = 20 * 60 * 1000;

function normalizePhone(phone, cleanPhoneFn) {
  if (typeof cleanPhoneFn === 'function') return cleanPhoneFn(phone);
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('84') && digits.length >= 11) digits = '0' + digits.slice(2);
  return digits;
}

function touchPresence(phone, source = 'api', cleanPhoneFn) {
  const key = normalizePhone(phone, cleanPhoneFn);
  if (!key) return null;
  const prev = presenceByPhone.get(key) || {};
  const next = {
    lastSeen: Date.now(),
    sseConnected: !!prev.sseConnected,
    lastSource: String(source || 'api')
  };
  if (source === 'sse') next.sseConnected = true;
  presenceByPhone.set(key, next);
  return next;
}

function setSseConnected(phone, connected, cleanPhoneFn) {
  const key = normalizePhone(phone, cleanPhoneFn);
  if (!key) return;
  const prev = presenceByPhone.get(key) || { lastSeen: 0, lastSource: 'sse' };
  presenceByPhone.set(key, {
    ...prev,
    lastSeen: connected ? Date.now() : prev.lastSeen,
    sseConnected: !!connected,
    lastSource: connected ? 'sse' : (prev.lastSource || 'sse')
  });
}

function getPresence(phone, cleanPhoneFn) {
  const key = normalizePhone(phone, cleanPhoneFn);
  if (!key) return null;
  return presenceByPhone.get(key) || null;
}

function isRecentlyPresent(phone, maxAgeMs = DEFAULT_STALE_MS, cleanPhoneFn) {
  const p = getPresence(phone, cleanPhoneFn);
  if (!p || !p.lastSeen) return false;
  return (Date.now() - p.lastSeen) <= maxAgeMs;
}

function isSseConnected(phone, cleanPhoneFn) {
  const p = getPresence(phone, cleanPhoneFn);
  return !!(p && p.sseConnected);
}

function clearPresence(phone, cleanPhoneFn) {
  const key = normalizePhone(phone, cleanPhoneFn);
  if (key) presenceByPhone.delete(key);
}

module.exports = {
  DEFAULT_STALE_MS,
  touchPresence,
  setSseConnected,
  getPresence,
  isRecentlyPresent,
  isSseConnected,
  clearPresence
};
