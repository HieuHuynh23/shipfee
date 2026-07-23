#!/usr/bin/env node
'use strict';

/**
 * Đối chiếu / backfill GPS quán từ Foody → chunks local.
 *
 * Usage:
 *   node crossref_foody_gps.js --id=r_ct_dannygreen_...
 *   node crossref_foody_gps.js --limit=30 --concurrency=3
 *   node crossref_foody_gps.js --only-missing --limit=100
 */

const path = require('path');
const dbHelper = require('./dbHelper');
const { fetchFoodyGpsBySlug, resolveFoodySlugFromRestaurant, isPlausibleCanThoGps } = require('./foodyGps');

function parseArgs(argv) {
  const out = {
    id: null,
    limit: 50,
    concurrency: 2,
    onlyMissing: true,
    dryRun: false,
    force: false
  };
  for (const a of argv) {
    if (a.startsWith('--id=')) out.id = a.slice(5);
    else if (a.startsWith('--limit=')) out.limit = Math.max(1, parseInt(a.slice(8), 10) || 50);
    else if (a.startsWith('--concurrency=')) out.concurrency = Math.max(1, parseInt(a.slice(14), 10) || 2);
    else if (a === '--only-missing') out.onlyMissing = true;
    else if (a === '--include-heuristic') out.onlyMissing = false;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
  }
  return out;
}

function needsGps(r, { onlyMissing, force }) {
  if (!r || !r.id) return false;
  if (!resolveFoodySlugFromRestaurant(r)) return false;
  if (force) return true;
  const lat = Number(r.latitude);
  const lon = Number(r.longitude);
  const hasNum = Number.isFinite(lat) && Number.isFinite(lon);
  if (!hasNum) return true;
  if (onlyMissing) return false;
  // include-heuristic: ghi đè khi chưa exact / đang heuristic
  if (r.coordsSource === 'exact' && r.geoSource === 'foody') return false;
  if (r.coordsSource === 'exact' && (r.source === 'shopeefood' || r.sfRestaurantId)) return false;
  return r.coordsSource === 'heuristic' || r.coordsSource == null || r.geoSource === 'nominatim' || r.geoSource === 'photon';
}

async function mapPool(items, concurrency, worker) {
  const results = [];
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await worker(items[cur], cur);
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => run());
  await Promise.all(runners);
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const all = dbHelper.read();
  let targets = all.filter((r) => needsGps(r, args));
  if (args.id) {
    targets = all.filter((r) => r && String(r.id) === String(args.id));
    if (targets.length === 0) {
      console.error(`[Foody GPS] Không tìm thấy quán id=${args.id}`);
      process.exit(1);
    }
  } else {
    targets = targets.slice(0, args.limit);
  }

  console.log(
    `[Foody GPS] Đối chiếu ${targets.length} quán (concurrency=${args.concurrency}, dryRun=${args.dryRun})`
  );

  let ok = 0;
  let fail = 0;
  let skip = 0;

  await mapPool(targets, args.concurrency, async (r) => {
    const slug = resolveFoodySlugFromRestaurant(r);
    if (!slug) {
      skip++;
      return;
    }
    const gps = await fetchFoodyGpsBySlug(slug);
    if (!gps || !isPlausibleCanThoGps(gps.lat, gps.lon)) {
      fail++;
      console.warn(`  ✗ ${r.id} slug=${slug} — không lấy được GPS`);
      return;
    }

    console.log(
      `  ✓ ${r.name || r.id}\n    ${r.latitude || '∅'},${r.longitude || '∅'} → ${gps.lat},${gps.lon} (${gps.url || 'foody'})`
    );

    if (args.dryRun) {
      ok++;
      return;
    }

    const updated = {
      ...r,
      latitude: gps.lat,
      longitude: gps.lon,
      coordsSource: 'exact',
      geoSource: 'foody',
      foodyGpsAt: new Date().toISOString(),
      foodySlug: r.foodySlug || slug
    };
    // giữ source cũ nếu đã có; đánh dấu đã đối chiếu GPS
    if (!updated.source) updated.source = 'foody-gps';

    const written = dbHelper.updateRestaurant(updated);
    if (written) ok++;
    else {
      fail++;
      console.warn(`  ✗ Lỗi ghi chunk ${r.id}`);
    }
  });

  console.log(`[Foody GPS] Xong: ok=${ok} fail=${fail} skip=${skip}`);
}

main().catch((e) => {
  console.error('[Foody GPS] Fatal:', e.message);
  process.exit(1);
});
