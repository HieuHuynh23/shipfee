#!/usr/bin/env node
/**
 * Discover quán GrabFood Cần Thơ → MERGE chỉ quán CHƯA có trong DB.
 *
 * - Intercept guest/v2/search (rewrite latlng → Cần Thơ)
 * - Dedupe: grabMerchantId / id / norm(name) / fuzzy name / foody+sf slug
 *
 *   node discover_grabfood_restaurants.js
 *   node discover_grabfood_restaurants.js --dry-run
 *   node discover_grabfood_restaurants.js --keywords=cơm,bún --grid=3
 */
'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const dbHelper = require('./dbHelper');
const supaSync = require('./supabaseSync');
const { getGrabFoodKeywords, getGrabFoodKeywordsQuick } = require('./discover_keywords_cantho');
const {
  sleep,
  getBrowserPath,
  normKey,
  extractMerchants,
  normalizeGrabMerchant,
  CANTHO_GRID,
  attachLatlngRewrite
} = require('./grabfoodHelpers');

const DRY_RUN = process.argv.includes('--dry-run');
const FULL = process.argv.includes('--full');
const kwArg = process.argv.find(a => a.startsWith('--keywords='));
const gridArg = process.argv.find(a => a.startsWith('--grid='));
const EXTRA_KEYWORDS = kwArg
  ? kwArg
      .split('=')
      .slice(1)
      .join('=')
      .split(',')
      .map(s => s.trim())
      // giữ '' (nearby) nếu user truyền
      .filter((s, i, arr) => s || arr.length === 1 || s === '')
  : [];
const GRID_LIMIT = gridArg ? Math.max(1, parseInt(gridArg.split('=')[1], 10) || 1) : CANTHO_GRID.length;

const KEYWORDS = EXTRA_KEYWORDS.length
  ? EXTRA_KEYWORDS
  : FULL
    ? getGrabFoodKeywords()
    : getGrabFoodKeywordsQuick();
const REPORT = path.join(__dirname, 'discover_grabfood_report.json');

function buildDbIndex(existing) {
  const byGrab = new Map();
  const byId = new Map();
  const bySlug = new Map();
  const byName = new Map();
  for (const r of existing) {
    if (!r) continue;
    byId.set(String(r.id), r);
    if (r.grabMerchantId) byGrab.set(String(r.grabMerchantId), r);
    if (r.shopeefoodSlug) bySlug.set(String(r.shopeefoodSlug).split('?')[0], r);
    if (r.foodySlug) bySlug.set(String(r.foodySlug).split('?')[0], r);
    const nk = normKey(r.name);
    if (nk) {
      if (!byName.has(nk)) byName.set(nk, []);
      byName.get(nk).push(r);
    }
  }
  return { byGrab, byId, bySlug, byName };
}

function isAlreadyInDb(item, index) {
  if (index.byGrab.has(item.grabMerchantId)) return true;
  if (index.byId.has(item.id)) return true;
  const nk = normKey(item.name);
  if (!nk) return true;
  if (index.byName.has(nk)) return true;
  // fuzzy: tên dài, chứa nhau (chuỗi / chi nhánh)
  if (nk.length >= 10) {
    for (const [key] of index.byName) {
      if (key.length < 10) continue;
      if (key.includes(nk) || nk.includes(key)) return true;
    }
  }
  return false;
}

async function mergeIntoDb(discovered) {
  const existing = dbHelper.read();
  const index = buildDbIndex(existing);
  const addedRows = [];
  let skipped = 0;

  for (const d of discovered) {
    if (isAlreadyInDb(d, index)) {
      skipped += 1;
      continue;
    }
    existing.push({ ...d });
    index.byId.set(d.id, d);
    index.byGrab.set(d.grabMerchantId, d);
    const nk = normKey(d.name);
    if (nk) {
      if (!index.byName.has(nk)) index.byName.set(nk, []);
      index.byName.get(nk).push(d);
    }
    addedRows.push(d);
  }

  if (!DRY_RUN && addedRows.length > 0) {
    dbHelper.write(existing);
    // Mắt xích Render: upsert quán mới phát hiện lên Supabase (menu rỗng, hasRealMenu=false)
    try {
      const rows = addedRows.map(r => supaSync.buildRestaurantRow(r, []));
      const res = await supaSync.upsertRestaurantsBatch(rows);
      if (res.ok) console.log(`  ☁️  Supabase upsert ${rows.length} quán mới`);
      else if (!res.skipped) console.log(`  ⚠️  Supabase upsert lỗi: ${res.error}`);
    } catch (e) {
      console.log(`  ⚠️  Supabase upsert exception: ${e.message}`);
    }
  }

  return { added: addedRows.length, skipped, total: existing.length };
}

async function scrollPage(page, times = 6, wait = 900) {
  for (let i = 0; i < times; i++) {
    await page.evaluate(() => window.scrollBy(0, 1400));
    await sleep(wait);
  }
}

async function discover() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  ShipFee — Discover GrabFood Cần Thơ (add-missing only) ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`mode: ${DRY_RUN ? 'DRY-RUN' : 'MERGE'} | keywords=${KEYWORDS.length} | grid=${GRID_LIMIT}`);

  const harvested = new Map();
  let geo = { ...CANTHO_GRID[0] };

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: getBrowserPath() || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--lang=vi-VN,vi,en-US,en',
      '--window-size=1280,900'
    ]
  });

  try {
    const context = browser.defaultBrowserContext();
    await context.overridePermissions('https://food.grab.com', ['geolocation']);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9' });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    );

    await attachLatlngRewrite(page, () => geo);
    await page.setGeolocation({ latitude: geo.lat, longitude: geo.lng, accuracy: 30 });

    page.on('response', async response => {
      try {
        const url = response.url();
        if (!/portal\.grab\.com\/foodweb\/guest\/v2\/search/i.test(url)) return;
        if (response.status() !== 200) return;
        const body = await response.json().catch(() => null);
        const merchants = extractMerchants(body);
        for (const m of merchants) {
          const row = normalizeGrabMerchant(m, { lat: geo.lat, lng: geo.lng });
          if (!row) continue;
          if (!harvested.has(row.grabMerchantId)) harvested.set(row.grabMerchantId, row);
        }
      } catch (_) {}
    });

    let addedTotal = 0;
    let skippedTotal = 0;

    for (let gi = 0; gi < GRID_LIMIT; gi++) {
      geo = { ...CANTHO_GRID[gi] };
      await page.setGeolocation({ latitude: geo.lat, longitude: geo.lng, accuracy: 30 });
      console.log(`\n📍 Grid ${gi + 1}/${GRID_LIMIT} ${geo.label} (${geo.lat},${geo.lng})`);

      for (let ki = 0; ki < KEYWORDS.length; ki++) {
        const kw = KEYWORDS[ki];
        const before = harvested.size;
        const q = kw ? `search=${encodeURIComponent(kw)}&` : '';
        const url = `https://food.grab.com/vn/vi/restaurants?${q}latlng=${geo.lat},${geo.lng}`;
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
        await sleep(1400);
        await scrollPage(page, kw ? 4 : 6, 750);
        const gained = harvested.size - before;
        if ((ki + 1) % 10 === 0 || gained > 0) {
          console.log(`  [${ki + 1}/${KEYWORDS.length}] "${kw || '(nearby)'}" +${gained} total=${harvested.size}`);
        }
        await sleep(400);
      }

      // Checkpoint merge sau mỗi lưới — tránh mất dữ liệu nếu dừng giữa chừng
      const list = [...harvested.values()];
      const { added, skipped, total } = await mergeIntoDb(list);
      addedTotal += added;
      skippedTotal = skipped;
      console.log(`  💾 checkpoint grid ${geo.label}: +${added} new (dbTotal=${total})`);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const list = [...harvested.values()];
  console.log(`\nHarvested unique Grab merchants: ${list.length}`);

  const existing = dbHelper.read();
  const index = buildDbIndex(existing);
  const missing = list.filter(d => !isAlreadyInDb(d, index));
  console.log(`Already in DB (skip): ${list.length - missing.length}`);
  console.log(`Still missing after checkpoints: ${missing.length}`);

  const finalMerge = await mergeIntoDb(list);
  const report = {
    at: new Date().toISOString(),
    dryRun: DRY_RUN,
    harvested: list.length,
    missingBeforeFinal: missing.length,
    added: finalMerge.added,
    skipped: finalMerge.skipped,
    totalAfter: finalMerge.total,
    sampleNew: missing.slice(0, 20).map(r => ({ id: r.id, name: r.name, grabMerchantId: r.grabMerchantId }))
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n✅ ${DRY_RUN ? 'DRY-RUN' : 'MERGED'} added=${finalMerge.added} skipped=${finalMerge.skipped} dbTotal=${finalMerge.total}`);
  console.log(`Report: ${REPORT}`);
}

discover().catch(err => {
  console.error(err);
  process.exit(1);
});
