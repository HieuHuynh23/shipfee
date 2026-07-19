/**
 * Shared GrabFood helpers — norm, merchant parse, menu normalize, browser path.
 */
'use strict';

const fs = require('fs');

const MARKUP = 1.28;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getBrowserPath() {
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ];
  for (const p of paths) if (fs.existsSync(p)) return p;
  return null;
}

function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function slugifyName(name) {
  return normKey(name)
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'restaurant';
}

function grabRestaurantId(merchantId) {
  const safe = String(merchantId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `r_ct_grab_${safe}`;
}

function extractMerchants(body) {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.searchResult?.searchMerchants)) return body.searchResult.searchMerchants;
  if (Array.isArray(body.searchMerchants)) return body.searchMerchants;
  if (Array.isArray(body.merchantList)) return body.merchantList;
  if (Array.isArray(body.merchants)) return body.merchants;
  return [];
}

function merchantName(m) {
  return (
    m?.address?.name ||
    m?.merchantBrief?.displayInfo?.primaryText ||
    m?.name ||
    m?.branchName ||
    ''
  ).trim();
}

function merchantAddress(m) {
  const a = m?.address || {};
  return (
    a.combined_address ||
    a.combinedAddress ||
    a.street ||
    [a.street, a.city].filter(Boolean).join(', ') ||
    ''
  ).trim();
}

function merchantImg(m) {
  const b = m?.merchantBrief || m || {};
  return (
    b.photoHref ||
    b.photoHrefFallback ||
    b.smallPhotoHref ||
    b.smallPhotoHrefFallback ||
    m?.photoHref ||
    ''
  );
}

function merchantRating(m) {
  const r = m?.merchantBrief?.rating ?? m?.rating;
  const n = Number(r);
  return Number.isFinite(n) && n > 0 ? n : 4.5;
}

function round100(n) {
  return Math.round(Number(n) / 100) * 100;
}

function normalizeGrabMerchant(m, { lat, lng } = {}) {
  const id = m?.id || m?.ID || m?.merchantID;
  if (!id) return null;
  const name = merchantName(m);
  if (!name || name.length < 2) return null;
  const address = merchantAddress(m) || 'Cần Thơ';
  const img = merchantImg(m);
  const open = m?.merchantBrief?.openHours?.open;
  return {
    id: grabRestaurantId(id),
    grabMerchantId: String(id),
    name,
    address,
    img,
    rating: merchantRating(m),
    latitude: typeof lat === 'number' ? lat : null,
    longitude: typeof lng === 'number' ? lng : null,
    source: 'grabfood',
    grabDiscoveredAt: new Date().toISOString(),
    hasRealMenu: false,
    menuTemplateFallback: true,
    dishNames: [],
    isClosed: open === false ? true : false,
    closedReason: open === false ? 'Tạm đóng trên GrabFood' : undefined
  };
}

function parseGrabMenuItems(merchantPayload, restaurantId) {
  const merchant = merchantPayload?.merchant || merchantPayload || {};
  const categories = merchant.menu?.categories || merchant.categories || merchantPayload?.categories || [];
  const dishes = [];
  let idx = 0;

  for (const cat of categories) {
    const catName = cat?.name || 'Món';
    const items = cat?.items || cat?.menuItems || [];
    for (const item of items) {
      if (!item || item.available === false) continue;
      const inStorePrice = Number(
        item.priceInMinorUnit ??
          item.priceV2?.amountInMinor ??
          item.discountedPriceInMin ??
          0
      );
      if (!Number.isFinite(inStorePrice) || inStorePrice < 1000) continue;

      const options = [];
      for (const g of item.modifierGroups || []) {
        const mods = (g.modifiers || [])
          .filter(mod => mod && mod.available !== false)
          .map(mod => ({
            name: mod.name,
            price: Number(mod.priceInMinorUnit ?? mod.priceV2?.amountInMinor ?? 0) || 0
          }));
        if (mods.length) {
          options.push({
            name: g.name || 'Tuỳ chọn',
            required: Number(g.selectionRangeMin || 0) > 0,
            min: Number(g.selectionRangeMin || 0) || 0,
            max: Number(g.selectionRangeMax || 1) || 1,
            choices: mods
          });
        }
      }

      dishes.push({
        id: `${String(restaurantId).replace(/[^a-zA-Z0-9_-]/g, '_')}-item-${idx}`,
        name: item.name || `Món ${idx + 1}`,
        desc: item.description || '',
        inStorePrice,
        appPrice: round100(inStorePrice * MARKUP),
        img: item.imgHref || (item.images && item.images[0]) || (item.thumbImages && item.thumbImages[0]) || '',
        category: catName,
        isAvailable: item.available !== false,
        options
      });
      idx += 1;
    }
  }
  return dishes;
}

function enrichFromMerchantDetail(row, payload) {
  const merchant = payload?.merchant || {};
  const addr = merchant.address || {};
  const combined = addr.combined_address || addr.combinedAddress || '';
  if (combined) row.address = combined;
  else if (addr.street) row.address = [addr.street, addr.city || 'Cần Thơ'].filter(Boolean).join(', ');
  if (merchant.photoHref) row.img = merchant.photoHref;
  if (merchant.name) row.name = merchant.name;
  const lat = Number(addr.latitude ?? addr.lat ?? merchant.latitude);
  const lng = Number(addr.longitude ?? addr.lng ?? merchant.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    row.latitude = lat;
    row.longitude = lng;
  }
  const open = merchant.openingHours?.open;
  if (open === false) {
    row.isClosed = true;
    row.closedReason = 'Tạm đóng trên GrabFood';
  } else if (open === true && row.closedReason === 'Tạm đóng trên GrabFood') {
    row.isClosed = false;
    delete row.closedReason;
  }
  return row;
}

function detailUrl(merchantId, name, lat, lng) {
  // Grab tự redirect slug đúng từ id — tránh encode tên tiếng Việt sai
  const q = lat && lng ? `?latlng=${lat},${lng}` : '';
  return `https://food.grab.com/vn/vi/restaurant/restaurant-delivery/${merchantId}${q}`;
}

/** Điểm lưới Cần Thơ — phủ Ninh Kiều / Bình Thủy / Cái Răng / Ô Môn. */
const CANTHO_GRID = [
  { lat: 10.045158, lng: 105.746857, label: 'ninh-kieu' },
  { lat: 10.0345, lng: 105.761, label: 'an-khanh' },
  { lat: 10.029, lng: 105.772, label: 'an-hoa' },
  { lat: 10.018, lng: 105.758, label: 'hung-loi' },
  { lat: 10.002, lng: 105.785, label: 'cai-rang' },
  { lat: 10.068, lng: 105.732, label: 'binh-thuy' },
  { lat: 10.055, lng: 105.755, label: 'cai-khe' },
  { lat: 10.04, lng: 105.73, label: 'an-cu' },
  { lat: 10.115, lng: 105.62, label: 'o-mon' },
  { lat: 10.01, lng: 105.75, label: 'an-binh' }
];

function rewriteUrlLatlng(url, lat, lng) {
  return String(url)
    .replace(/latlng=[^&]+/i, `latlng=${lat},${lng}`)
    .replace(/latitude=[^&]+/i, `latitude=${lat}`)
    .replace(/longitude=[^&]+/i, `longitude=${lng}`);
}

function attachLatlngRewrite(page, getLatLng) {
  return page.setRequestInterception(true).then(() => {
    page.on('request', req => {
      const url = req.url();
      if (!/portal\.grab\.com\/foodweb/i.test(url)) {
        req.continue().catch(() => {});
        return;
      }
      const { lat, lng } = getLatLng();
      try {
        if (req.method() === 'POST' && /\/search/i.test(url)) {
          let data = req.postData() || '{}';
          try {
            const j = JSON.parse(data);
            j.latlng = `${lat},${lng}`;
            if (j.latitude != null) j.latitude = lat;
            if (j.longitude != null) j.longitude = lng;
            j.countryCode = 'VN';
            data = JSON.stringify(j);
          } catch (_) {}
          req.continue({
            postData: data,
            headers: { ...req.headers(), 'content-type': 'application/json' }
          }).catch(() => {});
          return;
        }
        if (/latlng=|latitude=/i.test(url)) {
          req.continue({ url: rewriteUrlLatlng(url, lat, lng) }).catch(() => {});
          return;
        }
      } catch (_) {}
      req.continue().catch(() => {});
    });
  });
}

module.exports = {
  sleep,
  getBrowserPath,
  normKey,
  slugifyName,
  grabRestaurantId,
  extractMerchants,
  merchantName,
  merchantAddress,
  merchantImg,
  normalizeGrabMerchant,
  parseGrabMenuItems,
  enrichFromMerchantDetail,
  detailUrl,
  CANTHO_GRID,
  attachLatlngRewrite,
  MARKUP,
  round100
};
