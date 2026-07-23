#!/usr/bin/env node
'use strict';

/**
 * Đối chiếu / backfill GPS quán từ Foody → chunks local.
 *
 * Usage:
 *   node crossref_foody_gps.js --id=r_ct_dannygreen_...
 *   node crossref_foody_gps.js --include-heuristic --limit=300 --concurrency=3
 *   node crossref_foody_gps.js --include-heuristic --all --concurrency=4
 *   node crossref_foody_gps.js --only-missing --limit=500
 */

const dbHelper = require('./dbHelper');
const { fetchFoodyGpsBySlug, resolveFoodySlugFromRestaurant, isPlausibleCanThoGps } = require('./foodyGps');

function parseArgs(argv) {
  const out = {
    id: null,
    limit: 50,
    concurrency: 2,
    onlyMissing: true,
    dryRun: false,
    force: false,
    all: false
  };
  for (const a of argv) {
    if (a.startsWith('--id=')) out.id = a.slice(5);
    else if (a.startsWith('--limit=')) out.limit = Math.max(1, parseInt(a.slice(8), 10) || 50);
    else if (a.startsWith('--concurrency=')) out.concurrency = Math.max(1, parseInt(a.slice(14), 10) || 2);
    else if (a === '--only-missing') out.onlyMissing = true;
    else if (a === '--include-heuristic') out.onlyMissing = false;
    else if (a === '--all') {
      out.all = true;
      out.limit = Number.MAX_SAFE_INTEGER;
    } else if (a === '--dry-run') out.dryRun = true;
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
  return (
    r.coordsSource === 'heuristic' ||
    r.coordsSource == null ||
    r.geoSource === 'nominatim' ||
    r.geoSource === 'photon'
  );
}

/** Ưu tiên quán có foodyHref (slug đáng tin) trước id-fallback. */
function rankTarget(r) {
  if (r && r.foodyHref) return 0;
  if (r && r.foodySlug) return 1;
  if (r && r.shopeefoodSlug) return 2;
  return 3;
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
    targets.sort((a, b) => rankTarget(a) - rankTarget(b));
    if (!args.all) targets = targets.slice(0, args.limit);
  }

  const totalCandidates = all.filter((r) => needsGps(r, args)).length;
  console.log(
    `[Foody GPS] Đối chiếu ${targets.length}/${totalCandidates} quán còn thiếu` +
      ` (concurrency=${args.concurrency}, dryRun=${args.dryRun}, all=${args.all})`
  );

  let ok = 0;
  let fail = 0;
  let skip = 0;
  const started = Date.now();
  let done = 0;

  await mapPool(targets, args.concurrency, async (r) => {
    const slug = resolveFoodySlugFromRestaurant(r);
    if (!slug) {
      skip++;
      done++;
      return;
    }
    const gps = await fetchFoodyGpsBySlug(slug);
    if (!gps || !isPlausibleCanThoGps(gps.lat, gps.lon)) {
      fail++;
      done++;
      console.warn(`  ✗ ${r.id} slug=${slug} — không lấy được GPS`);
      return;
    }

    console.log(
      `  ✓ ${r.name || r.id}\n    ${r.latitude || '∅'},${r.longitude || '∅'} → ${gps.lat},${gps.lon} (${gps.url || 'foody'})`
    );

    if (!args.dryRun) {
      const updated = {
        ...r,
        latitude: gps.lat,
        longitude: gps.lon,
        coordsSource: 'exact',
        geoSource: 'foody',
        foodyGpsAt: new Date().toISOString(),
        foodySlug: slug
      };
      if (!updated.source) updated.source = 'foody-gps';

      const written = dbHelper.updateRestaurant(updated);
      if (written) ok++;
      else {
        fail++;
        console.warn(`  ✗ Lỗi ghi chunk ${r.id}`);
        done++;
        return;
      }
    } else {
      ok++;
    }

    done++;
    if (done % 50 === 0 || done === targets.length) {
      const elapsed = ((Date.now() - started) / 1000).toFixed(0);
      const rate = done / Math.max(1, (Date.now() - started) / 1000);
      const eta = Math.round((targets.length - done) / Math.max(0.01, rate));
      console.log(
        `[Foody GPS] tiến độ ${done}/${targets.length} | ok=${ok} fail=${fail} | ${elapsed}s | ~${eta}s còn lại`
      );
    }
  });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[Foody GPS] Xong: ok=${ok} fail=${fail} skip=${skip} (${elapsed}s)`);
}

main().catch((e) => {
  console.error('[Foody GPS] Fatal:', e.message);
  process.exit(1);
});
