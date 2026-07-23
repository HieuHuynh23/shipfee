#!/usr/bin/env node
'use strict';

/**
 * Geocode địa chỉ quán còn thiếu GPS Foody (chủ yếu Grab placeholder)
 * → OSM Nominatim. Đánh dấu geoSource=address + coordsSource=exact (nav-grade).
 *
 * Usage:
 *   node crossref_address_gps.js --all
 *   node crossref_address_gps.js --limit=100
 *   node crossref_address_gps.js --dry-run --limit=20
 */

const axios = require('axios');
const dbHelper = require('./dbHelper');
const { isPlausibleCanThoGps } = require('./foodyGps');

const GRAB_PLACEHOLDERS = [
  [10.045158, 105.746857],
  [10.0345, 105.761],
  [10.0452, 105.7469]
];

function parseArgs(argv) {
  const out = { limit: 100, all: false, dryRun: false, delayMs: 1100 };
  for (const a of argv) {
    if (a.startsWith('--limit=')) out.limit = Math.max(1, parseInt(a.slice(8), 10) || 100);
    else if (a === '--all') {
      out.all = true;
      out.limit = Number.MAX_SAFE_INTEGER;
    } else if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--delay=')) out.delayMs = Math.max(200, parseInt(a.slice(8), 10) || 1100);
  }
  return out;
}

function isGrabPlaceholder(lat, lon) {
  const a = Number(lat);
  const b = Number(lon);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return GRAB_PLACEHOLDERS.some(([x, y]) => Math.abs(a - x) < 1e-4 && Math.abs(b - y) < 1e-4);
}

function needsAddressGps(r) {
  if (!r || !r.id) return false;
  if (r.geoSource === 'foody' && r.coordsSource === 'exact') return false;
  if (r.geoSource === 'address' && r.coordsSource === 'exact') return false;
  const addr = String(r.address || '').trim();
  if (addr.length < 8) return false;
  const lat = Number(r.latitude);
  const lon = Number(r.longitude);
  const has = Number.isFinite(lat) && Number.isFinite(lon);
  // Grab placeholder / thiếu lat / heuristic không exact
  if (!has) return true;
  if (isGrabPlaceholder(lat, lon)) return true;
  if (String(r.id).startsWith('r_ct_grab_') || String(r.id).startsWith('r_ct_gf_')) {
    return r.coordsSource !== 'exact';
  }
  // Foody fail còn lại: thử geocode địa chỉ
  return r.coordsSource !== 'exact';
}

function buildQuery(r) {
  let addr = String(r.address || '').trim();
  if (!/cần\s*thơ|can\s*tho/i.test(addr)) addr = `${addr}, Cần Thơ`;
  return addr;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function nominatimGeocode(query) {
  const url = 'https://nominatim.openstreetmap.org/search';
  const res = await axios.get(url, {
    params: {
      format: 'json',
      limit: 1,
      countrycodes: 'vn',
      addressdetails: 1,
      q: query
    },
    headers: {
      'User-Agent': 'ShipFeeGPS/1.0 (shipfee.vercel.app; geo-backfill)',
      Accept: 'application/json'
    },
    timeout: 15000,
    validateStatus: () => true
  });
  if (res.status !== 200 || !Array.isArray(res.data) || !res.data[0]) return null;
  const hit = res.data[0];
  const lat = parseFloat(hit.lat);
  const lon = parseFloat(hit.lon);
  if (!isPlausibleCanThoGps(lat, lon)) return null;
  return {
    lat,
    lon,
    display: hit.display_name || '',
    type: hit.type || hit.addresstype || '',
    importance: hit.importance
  };
}

async function photonGeocode(query) {
  try {
    const res = await axios.get('https://photon.komoot.io/api/', {
      params: { q: query, limit: 1, lang: 'vi' },
      timeout: 12000,
      validateStatus: () => true
    });
    const f = res.data && Array.isArray(res.data.features) ? res.data.features[0] : null;
    if (!f || !f.geometry || !Array.isArray(f.geometry.coordinates)) return null;
    const lon = parseFloat(f.geometry.coordinates[0]);
    const lat = parseFloat(f.geometry.coordinates[1]);
    if (!isPlausibleCanThoGps(lat, lon)) return null;
    const p = f.properties || {};
    return {
      lat,
      lon,
      display: [p.name, p.street, p.district, p.city].filter(Boolean).join(', '),
      type: p.type || p.osm_value || 'photon',
      importance: 0
    };
  } catch (_) {
    return null;
  }
}

async function geocodeAddressQuery(query) {
  const n = await nominatimGeocode(query);
  if (n) return { ...n, provider: 'nominatim' };
  const p = await photonGeocode(query);
  if (p) return { ...p, provider: 'photon' };
  const short = String(query)
    .replace(/^[^,]*,\s*/, '')
    .trim();
  if (short && short !== query && short.length > 10) {
    const q2 = short.includes('Cần Thơ') ? short : `${short}, Cần Thơ`;
    const n2 = await nominatimGeocode(q2);
    if (n2) return { ...n2, provider: 'nominatim-short' };
    const p2 = await photonGeocode(q2);
    if (p2) return { ...p2, provider: 'photon-short' };
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let targets = dbHelper.read().filter(needsAddressGps);
  if (!args.all) targets = targets.slice(0, args.limit);

  console.log(
    `[Address GPS] Geocode ${targets.length} quán (delay=${args.delayMs}ms, dryRun=${args.dryRun})`
  );

  let ok = 0;
  let fail = 0;
  const started = Date.now();

  for (let i = 0; i < targets.length; i++) {
    const r = targets[i];
    const q = buildQuery(r);
    let gps = null;
    try {
      gps = await geocodeAddressQuery(q);
    } catch (e) {
      console.warn(`  ✗ ${r.id} network: ${e.message}`);
    }

    if (!gps) {
      fail++;
      console.warn(`  ✗ ${r.name || r.id} — ${q.slice(0, 70)}`);
    } else {
      console.log(
        `  ✓ ${r.name || r.id}\n    ${r.latitude || '∅'},${r.longitude || '∅'} → ${gps.lat},${gps.lon} (${gps.provider || gps.type})`
      );
      if (!args.dryRun) {
        const updated = {
          ...r,
          latitude: gps.lat,
          longitude: gps.lon,
          coordsSource: 'exact',
          geoSource: 'address',
          addressGpsAt: new Date().toISOString(),
          addressGpsQuery: q,
          addressGpsDisplay: gps.display
        };
        if (!updated.source) updated.source = 'address-gps';
        if (dbHelper.updateRestaurant(updated)) ok++;
        else {
          fail++;
          console.warn(`  ✗ Lỗi ghi ${r.id}`);
        }
      } else {
        ok++;
      }
    }

    const done = i + 1;
    if (done % 25 === 0 || done === targets.length) {
      const elapsed = ((Date.now() - started) / 1000).toFixed(0);
      console.log(`[Address GPS] tiến độ ${done}/${targets.length} | ok=${ok} fail=${fail} | ${elapsed}s`);
    }

    if (i < targets.length - 1) await sleep(args.delayMs);
  }

  console.log(`[Address GPS] Xong: ok=${ok} fail=${fail}`);
}

main().catch((e) => {
  console.error('[Address GPS] Fatal:', e.message);
  process.exit(1);
});
