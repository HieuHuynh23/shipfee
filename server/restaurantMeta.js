'use strict';

/**
 * Shared helpers for restaurant phone / address / identity / permanent-close.
 * Used by menuScraper, crawl_restaurant_menus, server.js.
 */

const PERMANENT_CLOSE_KEYWORDS = [
  'vĩnh viễn',
  'vinh vien',
  'permanently',
  'permanent',
  'ngưng hợp tác',
  'ngung hop tac',
  'ngưng hoạt động',
  'ngung hoat dong',
  'ngừng hoạt động',
  'ngung dich vu',
  'ngưng dịch vụ',
  'không tồn tại',
  'khong ton tai',
  'đã đóng cửa vĩnh',
  'da dong cua vinh',
  'ngừng phục vụ',
  'ngung phuc vu',
  'delisted',
  'not_on_shopeefood',
  'chưa có hoặc đã ngưng dịch vụ'
];

function digitsOnly(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function normalizePhone(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return '';
  let d = digitsOnly(raw);
  if (!d) return '';
  // +84 / 84 → 0…
  if (d.startsWith('84') && d.length >= 10) d = '0' + d.slice(2);
  if (d.length === 10 || d.length === 11) {
    if (d.startsWith('02')) {
      return `${d.slice(0, 4)} ${d.slice(4)}`;
    }
    return d;
  }
  return d;
}

/**
 * Legacy Foody list scrape invented phones as '0292 3'+random.
 * Cannot distinguish from real CT landlines by digits alone — only trust explicit source flags.
 */
function isFakeRestaurantPhone(phone, phoneSource) {
  const src = String(phoneSource || '').toLowerCase();
  if (src === 'fabricated' || src === 'random' || src === 'legacy_fake') return true;
  if (src === 'shopeefood' || src === 'foody' || src === 'manual' || src === 'admin') return false;
  return false;
}

function isRealRestaurantPhone(phone, phoneSource) {
  const n = normalizePhone(phone);
  if (!n) return false;
  if (isFakeRestaurantPhone(n, phoneSource)) return false;
  const d = digitsOnly(n);
  return d.length >= 9 && d.length <= 11;
}

function pickFirstPhone(...candidates) {
  for (const c of candidates) {
    if (Array.isArray(c)) {
      for (const item of c) {
        const p = pickFirstPhone(item);
        if (p) return p;
      }
      continue;
    }
    if (c && typeof c === 'object') {
      const nested = pickFirstPhone(
        c.phone,
        c.Phone,
        c.phones,
        c.hotline,
        c.tel,
        c.telephone,
        c.contact_phone,
        c.value,
        c.number
      );
      if (nested) return nested;
      continue;
    }
    const n = normalizePhone(c);
    if (isRealRestaurantPhone(n)) return n;
  }
  return '';
}

/**
 * Extract contact + identity fields from DeliveryNow get_detail / dishes reply.
 */
function extractRestaurantMetaFromDetail(apiData) {
  const reply = (apiData && apiData.reply) || apiData || {};
  const delivery = reply.delivery_detail || reply.delivery || {};
  const restaurant =
    reply.restaurant ||
    reply.restaurant_info ||
    delivery.restaurant ||
    delivery.restaurant_info ||
    reply.store ||
    {};

  const phone = pickFirstPhone(
    reply.phone,
    reply.phones,
    reply.hotline,
    delivery.phone,
    delivery.phones,
    delivery.hotline,
    restaurant.phone,
    restaurant.phones,
    restaurant.hotline,
    restaurant.phone_number,
    restaurant.res_phone,
    reply.contact?.phone,
    reply.contact?.phones
  );

  const name = String(
    reply.name ||
      reply.restaurant_name ||
      delivery.name ||
      restaurant.name ||
      restaurant.restaurant_name ||
      ''
  ).trim();

  const address = String(
    reply.address ||
      reply.full_address ||
      delivery.address ||
      delivery.full_address ||
      restaurant.address ||
      restaurant.full_address ||
      ''
  ).trim();

  let lat = null;
  let lon = null;
  const pos =
    reply.position ||
    delivery.position ||
    restaurant.position ||
    reply.location ||
    delivery.location ||
    null;
  if (pos) {
    const la = parseFloat(pos.latitude ?? pos.lat);
    const lo = parseFloat(pos.longitude ?? pos.lon ?? pos.lng);
    if (Number.isFinite(la) && Number.isFinite(lo)) {
      lat = la;
      lon = lo;
    }
  }

  return {
    phone: phone || '',
    name,
    address,
    lat,
    lon
  };
}

function extractPhoneFromFoodyHtml(html) {
  if (!html || typeof html !== 'string') return '';
  const patterns = [
    /(?:tel|phone|hotline|điện thoại|dien thoai)[^0-9+]{0,40}(\+?84[\s.\-]?\d{8,10}|0\d{8,10}|0\d{1,3}[\s.\-]?\d{3,4}[\s.\-]?\d{3,4})/i,
    /href=["']tel:([^"']+)["']/i,
    /property=["']og:phone_number["']\s+content=["']([^"']+)["']/i,
    /"phone(?:Number|s)?"\s*:\s*"([^"]+)"/i
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (!m) continue;
    const n = normalizePhone(m[1]);
    if (isRealRestaurantPhone(n)) return n;
  }
  return '';
}

function foldVi(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');
}

function tokenizeForMatch(s) {
  return foldVi(s)
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1);
}

function jaccardSimilarity(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function extractStreetNumber(address) {
  const m = String(address || '').match(/(?:^|[,\s])(\d{1,4}[a-zA-Z]?(?:\/\d{1,4}[a-zA-Z]?)?)\s/);
  return m ? foldVi(m[1]) : '';
}

/**
 * Verify scraped store identity against our DB restaurant.
 * @returns {{ ok: boolean, score: number, reason: string }}
 */
function verifyRestaurantIdentity(expected, scraped) {
  const expName = expected && expected.name ? String(expected.name) : '';
  const expAddr = expected && expected.address ? String(expected.address) : '';
  const scName = scraped && scraped.name ? String(scraped.name) : '';
  const scAddr = scraped && scraped.address ? String(scraped.address) : '';

  const portalAddr = /^\d+\s*chi\s*nhánh$/i.test(expAddr.trim());

  if (!scName && !scAddr) {
    return { ok: true, score: 0.4, reason: 'no_scraped_identity' };
  }

  const nameScore = jaccardSimilarity(tokenizeForMatch(expName), tokenizeForMatch(scName));
  let addrScore = 0;
  if (expAddr && scAddr && !portalAddr) {
    addrScore = jaccardSimilarity(tokenizeForMatch(expAddr), tokenizeForMatch(scAddr));
    const n1 = extractStreetNumber(expAddr);
    const n2 = extractStreetNumber(scAddr);
    if (n1 && n2 && n1 === n2) addrScore = Math.max(addrScore, 0.75);
    if (n1 && n2 && n1 !== n2) addrScore = Math.min(addrScore, 0.25);
  } else if (portalAddr || !expAddr) {
    addrScore = 0.5;
  }

  const score =
    expAddr && scAddr && !portalAddr ? nameScore * 0.55 + addrScore * 0.45 : nameScore;

  if (score >= 0.35 || (nameScore >= 0.45 && addrScore >= 0.2)) {
    return { ok: true, score, reason: 'matched' };
  }
  if (expAddr && scAddr && !portalAddr) {
    const n1 = extractStreetNumber(expAddr);
    const n2 = extractStreetNumber(scAddr);
    if (n1 && n2 && n1 !== n2 && nameScore < 0.6) {
      return { ok: false, score, reason: 'street_number_mismatch' };
    }
  }
  if (score < 0.28) {
    return { ok: false, score, reason: 'identity_mismatch' };
  }
  return { ok: true, score, reason: 'weak_match' };
}

function isPermanentCloseReason(reason) {
  const lower = foldVi(reason || '');
  return PERMANENT_CLOSE_KEYWORDS.some(kw => lower.includes(foldVi(kw)));
}

function normalizeClosedReason(reason, { notFound = false } = {}) {
  let r = String(reason || '').trim();
  if (notFound && !r) {
    r = 'Cửa hàng chưa có hoặc đã ngưng dịch vụ đặt món trên ShopeeFood (vĩnh viễn).';
  }
  if (notFound || isPermanentCloseReason(r)) {
    if (!/vĩnh viễn|permanently/i.test(r)) {
      r = (r ? r + ' — ' : '') + 'vĩnh viễn';
    }
  }
  return r;
}

function isPermanentlyUnavailableRestaurant(r) {
  if (!r) return false;
  if (r.permanentlyClosed === true) return true;
  if (isPermanentCloseReason(r.closedReason)) return true;
  if (
    r.lastCrawlError === 'not_on_shopeefood' &&
    (r.notOnShopeefoodCount >= 2 || r.permanentlyClosed === true)
  ) {
    return true;
  }
  return false;
}

/**
 * Apply scraped meta onto restaurant row (mutates).
 */
function applyScrapedMetaToRestaurant(row, meta = {}) {
  if (!row || !meta) return row;
  if (meta.phone && isRealRestaurantPhone(meta.phone, meta.phoneSource)) {
    row.phone = normalizePhone(meta.phone);
    row.phoneSource = meta.phoneSource || 'shopeefood';
    row.phoneUpdatedAt = new Date().toISOString();
  } else if (
    row.phone &&
    isFakeRestaurantPhone(row.phone, row.phoneSource) &&
    meta.clearFakePhone
  ) {
    row.phone = '';
    row.phoneSource = 'cleared_fake';
  }
  if (meta.address && String(meta.address).trim()) {
    const next = String(meta.address).trim();
    if (next !== String(row.address || '').trim() && !/^\d+\s*chi\s*nhánh$/i.test(next)) {
      row.address = next;
      row.addressUpdatedAt = new Date().toISOString();
      row.addressSource = meta.addressSource || 'shopeefood';
    }
  }
  if (
    Number.isFinite(meta.lat) &&
    Number.isFinite(meta.lon) &&
    meta.lat > 0 &&
    meta.lon > 0
  ) {
    row.latitude = Number(meta.lat);
    row.longitude = Number(meta.lon);
    row.coordsSource = 'exact';
    row.geoSource = meta.geoSource || 'shopeefood';
  }
  if (meta.name && String(meta.name).trim() && !row.name) {
    row.name = String(meta.name).trim();
  }
  return row;
}

module.exports = {
  normalizePhone,
  isFakeRestaurantPhone,
  isRealRestaurantPhone,
  pickFirstPhone,
  extractRestaurantMetaFromDetail,
  extractPhoneFromFoodyHtml,
  tokenizeForMatch,
  jaccardSimilarity,
  extractStreetNumber,
  verifyRestaurantIdentity,
  isPermanentCloseReason,
  normalizeClosedReason,
  isPermanentlyUnavailableRestaurant,
  applyScrapedMetaToRestaurant,
  PERMANENT_CLOSE_KEYWORDS
};
