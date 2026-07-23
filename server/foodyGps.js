'use strict';

/**
 * Đối chiếu GPS quán từ trang Foody (meta place:location:* / Google Maps embed).
 * Dùng cho chỉ đường shipper khi thiếu GPS ShopeeFood crawl.
 */

const axios = require('axios');

const FOODY_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
  Accept: 'text/html,application/xhtml+xml'
};

const CAN_THO_BOUNDS = {
  minLat: 9.85,
  maxLat: 10.25,
  minLon: 105.55,
  maxLon: 105.95
};

function isPlausibleCanThoGps(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= CAN_THO_BOUNDS.minLat &&
    lat <= CAN_THO_BOUNDS.maxLat &&
    lon >= CAN_THO_BOUNDS.minLon &&
    lon <= CAN_THO_BOUNDS.maxLon
  );
}

function extractGpsFromFoodyHtml(html) {
  if (!html || typeof html !== 'string') return null;

  const patterns = [
    /property="place:location:latitude"\s+content="(-?\d+\.\d+)"[\s\S]{0,180}?property="place:location:longitude"\s+content="(-?\d+\.\d+)"/i,
    /property="place:location:longitude"\s+content="(-?\d+\.\d+)"[\s\S]{0,180}?property="place:location:latitude"\s+content="(-?\d+\.\d+)"/i,
    /maps\/embed\/v1\/place\?[^"']*q=(-?\d+\.\d+),(-?\d+\.\d+)/i,
    /"latitude"\s*:\s*(-?\d+\.\d+)\s*,\s*"longitude"\s*:\s*(-?\d+\.\d+)/i,
    /RestaurantLat["\s:=]+(-?\d+\.\d+)[\s\S]{0,120}?RestaurantLng["\s:=]+(-?\d+\.\d+)/i
  ];

  for (let i = 0; i < patterns.length; i++) {
    const m = html.match(patterns[i]);
    if (!m) continue;
    let lat;
    let lon;
    if (i === 1) {
      // lon then lat in pattern
      lon = parseFloat(m[1]);
      lat = parseFloat(m[2]);
    } else {
      lat = parseFloat(m[1]);
      lon = parseFloat(m[2]);
    }
    if (isPlausibleCanThoGps(lat, lon)) {
      return { lat, lon, source: 'foody' };
    }
  }
  return null;
}

function foodyUrlsForSlug(slug) {
  const s = String(slug || '').trim().replace(/^\/+|\/+$/g, '');
  if (!s) return [];
  return [
    `https://www.foody.vn/can-tho/${s}`,
    `https://www.foody.vn/thuong-hieu/${s}?c=can-tho`
  ];
}

/**
 * @param {string} slug foodySlug hoặc shopeefoodSlug
 * @returns {Promise<{lat:number, lon:number, source:string, url?:string}|null>}
 */
async function fetchFoodyGpsBySlug(slug, opts = {}) {
  const timeout = opts.timeoutMs || 12000;
  const urls = foodyUrlsForSlug(slug);
  for (const url of urls) {
    try {
      const res = await axios.get(url, {
        headers: FOODY_HEADERS,
        timeout,
        validateStatus: () => true,
        maxRedirects: 5,
        responseType: 'text',
        transformResponse: [(d) => d]
      });
      if (res.status !== 200 || typeof res.data !== 'string') continue;
      const gps = extractGpsFromFoodyHtml(res.data);
      if (gps) return { ...gps, url };
    } catch (_) {
      /* thử URL kế */
    }
  }
  return null;
}

function resolveFoodySlugFromRestaurant(restaurant) {
  if (!restaurant) return '';
  return String(
    restaurant.foodySlug ||
      restaurant.shopeefoodSlug ||
      ''
  ).trim();
}

module.exports = {
  fetchFoodyGpsBySlug,
  extractGpsFromFoodyHtml,
  resolveFoodySlugFromRestaurant,
  isPlausibleCanThoGps,
  foodyUrlsForSlug
};
