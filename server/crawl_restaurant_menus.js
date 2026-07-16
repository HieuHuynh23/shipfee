#!/usr/bin/env node
/**
 * crawl_restaurant_menus.js
 * ─────────────────────────────────────────────────────────────
 * Cào menu ShopeeFood CHÍNH XÁC TỪNG QUÁN → lưu menus/<id>.json
 * + cập nhật hasRealMenu / dishNames / shopeefoodSlug trong chunks
 * + sync Supabase (nếu có service role).
 *
 * Chỉ lưu khi menu đạt tín hiệu scraped thật (options / CDN Shopee).
 * Không ghi template Unsplash, không đánh dấu real bừa.
 *
 * Cách chạy (trên máy local / VPS — không chạy trên free Render):
 *
 *   cd server
 *   node crawl_restaurant_menus.js --only-fallback --open-only --threads=2
 *   node crawl_restaurant_menus.js --id=r_ct_kfc_lotte_mart_can_tho
 *   node crawl_restaurant_menus.js --limit=50 --threads=1
 *   node crawl_restaurant_menus.js --force --only-fallback --limit=20
 *
 * Flags:
 *   --only-fallback   chỉ quán chưa có menu thật / đang template
 *   --open-only       bỏ quán isClosed
 *   --force           cào lại cả quán đã có real menu
 *   --id=<id>         chỉ 1 quán
 *   --limit=N         giới hạn số quán
 *   --threads=N       số worker song song (mặc định 1 — an toàn hơn)
 *   --delay=MS        nghỉ giữa 2 quán trong 1 worker (mặc định 2500)
 *   --dry-run         chỉ in danh sách, không cào
 *   --skip-supabase   không sync online
 */

'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const dbHelper = require('./dbHelper');
const menuScraper = require('./menuScraper');
const { analyzeMenuQuality } = require('./menuQuality');
const {
  slugFromRestaurant,
  rewriteSlug,
  isGenericBrandPortal
} = require('./slugMap');

// ── CLI ─────────────────────────────────────────────────
function argVal(name, fallback) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const THREADS = Math.max(1, parseInt(argVal('threads', '1'), 10) || 1);
const DELAY_MS = Math.max(500, parseInt(argVal('delay', '2500'), 10) || 2500);
const LIMIT = parseInt(argVal('limit', '0'), 10) || 0;
const ONLY_ID = argVal('id', '') || '';
const ONLY_FALLBACK = hasFlag('only-fallback');
const OPEN_ONLY = hasFlag('open-only');
const FORCE = hasFlag('force');
const DRY_RUN = hasFlag('dry-run');
const SKIP_SUPABASE = hasFlag('skip-supabase');

const MENUS_DIR = path.join(__dirname, 'menus');
const STATE_FILE = path.join(__dirname, 'crawl_restaurant_menus.state.json');
const LOG_FILE = path.join(__dirname, 'crawl_restaurant_menus.log');

if (!fs.existsSync(MENUS_DIR)) fs.mkdirSync(MENUS_DIR, { recursive: true });

// ── Supabase ────────────────────────────────────────────
let supabase = null;
if (!SKIP_SUPABASE && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

function log(line) {
  const ts = new Date().toLocaleTimeString('vi-VN');
  const msg = `[${ts}] ${line}`;
  console.log(msg);
  try { fs.appendFileSync(LOG_FILE, msg + '\n', 'utf8'); } catch (_) {}
}

function safeMenuId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function menuPath(id) {
  return path.join(MENUS_DIR, `${safeMenuId(id)}.json`);
}

function writeMenuFile(id, menu) {
  fs.writeFileSync(menuPath(id), JSON.stringify(menu || [], null, 2), 'utf8');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── DB queue ────────────────────────────────────────────
let dbQueue = Promise.resolve();
function withDb(fn) {
  return new Promise((resolve, reject) => {
    dbQueue = dbQueue.then(async () => {
      try {
        const data = dbHelper.read();
        const result = await fn(data);
        if (result && result.save) dbHelper.write(data);
        resolve(result && result.value);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ── Slug resolve (Foody → ShopeeFood) ───────────────────
async function resolveSlugFromFoody(foodySlug) {
  const tryUrls = [
    `https://www.foody.vn/can-tho/${foodySlug}`,
    `https://www.foody.vn/thuong-hieu/${foodySlug}?c=can-tho`
  ];
  for (const url of tryUrls) {
    try {
      const res = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'vi-VN,vi;q=0.9'
        },
        timeout: 10000
      });
      if (res.status !== 200) continue;
      const $ = cheerio.load(res.data);
      let shopeefoodUrl = '';
      $('a').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (
          href.includes('shopeefood.vn/can-tho/') &&
          !href.includes('/can-tho/fresh') &&
          !href.includes('/can-tho/food')
        ) {
          shopeefoodUrl = href;
        }
      });
      if (!shopeefoodUrl) continue;
      const parts = shopeefoodUrl.split('?')[0].split('/').filter(Boolean);
      const resolved = parts[parts.length - 1];
      if (resolved) return resolved;
    } catch (_) { /* try next */ }
  }
  return foodySlug;
}

async function resolveRestaurantSlug(restaurant) {
  let slug = slugFromRestaurant(restaurant);
  slug = rewriteSlug(slug);

  // Always try Foody resolve when no trusted slug stored
  if (!restaurant.shopeefoodSlug) {
    const resolved = await resolveSlugFromFoody(slug);
    slug = rewriteSlug(resolved);
  }
  return slug;
}

/**
 * Build ordered slug candidates for a restaurant (chi nhánh cụ thể trước).
 */
function buildSlugCandidates(restaurant, primarySlug) {
  const seen = new Set();
  const out = [];
  const push = (s) => {
    const v = rewriteSlug(String(s || '').split('?')[0]);
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };

  push(primarySlug);
  push(restaurant.shopeefoodSlug);
  push(slugFromRestaurant(restaurant));

  const base = slugFromRestaurant(restaurant);
  // Common ShopeeFood title prefixes for chain brands
  if (/lotteria/i.test(restaurant.name || '') || /lotteria/.test(base)) {
    push(`ga-ran-burger-${base.replace(/^ga-ran-burger-/, '')}`);
  }
  if (/jollibee/i.test(restaurant.name || '') || /jollibee/.test(base)) {
    push(`ga-ran-va-mi-y-${base.replace(/^ga-ran-va-mi-y-/, '').replace(/^ga-ran-va-my-y-/, '')}`);
    push(`ga-ran-va-my-y-${base.replace(/^ga-ran-va-mi-y-/, '').replace(/^ga-ran-va-my-y-/, '')}`);
  }
  if (/kfc/i.test(restaurant.name || '') || /(^|-)kfc(-|$)/.test(base)) {
    push(`ga-ran-${base.replace(/^ga-ran-/, '')}`);
  }
  if (/highlands/i.test(restaurant.name || '') || /highlands/.test(base)) {
    push(base.includes('tra-ca-phe-banh') ? base : `highlands-coffee-tra-ca-phe-banh-${base.replace(/^highlands-coffee-/, '')}`);
  }
  return out;
}

async function scrapeWithSlugFallback(restaurant, workerId) {
  const tag = `[W${workerId}]`;
  const primary = await resolveRestaurantSlug(restaurant);
  const candidates = buildSlugCandidates(restaurant, primary);
  let lastRaw = null;
  let usedSlug = primary;

  for (let i = 0; i < candidates.length; i++) {
    const slug = candidates[i];
    usedSlug = slug;
    log(`${tag} ⚡ Thử slug (${i + 1}/${candidates.length}): ${slug}`);
    try {
      lastRaw = await menuScraper.scrapeMenu(slug);
    } catch (e) {
      log(`${tag} ⚠️ Lỗi slug ${slug}: ${e.message}`);
      lastRaw = null;
      continue;
    }

    let menu = null;
    if (lastRaw && lastRaw.closed === true && Array.isArray(lastRaw.menu)) menu = lastRaw.menu;
    else if (Array.isArray(lastRaw)) menu = lastRaw;

    if (menu && menu.length > 0 && analyzeMenuQuality(menu).isReal) {
      return { raw: lastRaw, slug };
    }
    if (menu && menu.length > 0) {
      // Có món nhưng chưa chắc real — vẫn giữ, thử slug khác nếu còn
      const q = analyzeMenuQuality(menu);
      if (q.isReal || i === candidates.length - 1) return { raw: lastRaw, slug };
    }
  }
  return { raw: lastRaw, slug: usedSlug };
}

// ── Persist + sync ──────────────────────────────────────
async function persistSuccess(restaurant, menu, slug, { closed = false, closedReason = '' } = {}) {
  const quality = analyzeMenuQuality(menu);
  if (!quality.isReal) {
    return { ok: false, reason: `menu_not_real:${quality.reason}`, quality };
  }

  writeMenuFile(restaurant.id, menu);
  const dishNames = menu.map(m => m && m.name).filter(Boolean);

  await withDb(data => {
    const idx = data.findIndex(r => String(r.id) === String(restaurant.id));
    if (idx === -1) return { save: false };
    const row = data[idx];
    row.hasRealMenu = true;
    delete row.menuTemplateFallback;
    row.dishNames = dishNames;
    row.menuUpdatedAt = new Date().toISOString();
    row.shopeefoodSlug = slug;
    delete row.menu;
    if (closed) {
      row.isClosed = true;
      row.closedAt = new Date().toISOString();
      row.closedReason = closedReason || 'Ngoài giờ / tạm đóng trên ShopeeFood';
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(7, 0, 0, 0);
      row.crawlNextAttempt = tomorrow.toISOString();
    } else if (row.isClosed) {
      row.isClosed = false;
      delete row.closedAt;
      delete row.closedReason;
      delete row.crawlNextAttempt;
    }
    return { save: true };
  });

  if (supabase) {
    try {
      await supabase.from('restaurants').upsert({
        id: restaurant.id,
        name: restaurant.name,
        address: restaurant.address || '',
        is_closed: !!closed,
        closed_reason: closed ? (closedReason || '') : '',
        has_real_menu: true,
        dish_names: dishNames,
        menu,
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' });
    } catch (e) {
      log(`  [Supabase] sync fail ${restaurant.id}: ${e.message}`);
    }
  }

  return { ok: true, quality, dishCount: menu.length };
}

async function markChecked(restaurantId, patch = {}) {
  await withDb(data => {
    const idx = data.findIndex(r => String(r.id) === String(restaurantId));
    if (idx === -1) return { save: false };
    Object.assign(data[idx], patch, { menuUpdatedAt: new Date().toISOString() });
    return { save: true };
  });
}

// ── One restaurant ──────────────────────────────────────
async function crawlOne(restaurant, workerId) {
  const tag = `[W${workerId}]`;
  const name = restaurant.name || restaurant.id;

  if (isGenericBrandPortal(restaurant.name, restaurant.address)) {
    log(`${tag} ⏭️ Skip portal "Hệ thống": ${name}`);
    return { status: 'skipped_portal' };
  }

  let raw;
  let slug;
  try {
    const scraped = await scrapeWithSlugFallback(restaurant, workerId);
    raw = scraped.raw;
    slug = scraped.slug;
  } catch (e) {
    log(`${tag} ❌ Scrape error "${name}": ${e.message}`);
    await markChecked(restaurant.id, { lastCrawlError: e.message });
    return { status: 'error' };
  }

  let menu = null;
  let closed = false;
  let closedReason = '';

  if (raw && raw.closed === true) {
    closed = true;
    closedReason = raw.reason || '';
    if (Array.isArray(raw.menu) && raw.menu.length > 0) menu = raw.menu;
  } else if (Array.isArray(raw) && raw.length > 0) {
    menu = raw;
  }

  if (!menu || menu.length === 0) {
    log(`${tag} ⚠️ Không có menu API cho "${name}" (slug=${slug})`);
    // Không tự đóng quán vĩnh viễn — chỉ ghi nhận lần kiểm tra
    await markChecked(restaurant.id, {
      lastCrawlError: 'empty_menu',
      shopeefoodSlug: slug
    });
    return { status: 'empty' };
  }

  // Re-bind dish ids to restaurant id for stable cart keys
  menu = menu.map((item, i) => ({
    ...item,
    id: `${safeMenuId(restaurant.id)}-item-${i}`
  }));

  const saved = await persistSuccess(restaurant, menu, slug, { closed, closedReason });
  if (!saved.ok) {
    log(`${tag} 🚫 Bỏ qua menu không đạt chuẩn scraped (${saved.reason}) — "${name}"`);
    await markChecked(restaurant.id, {
      lastCrawlError: saved.reason,
      shopeefoodSlug: slug,
      hasRealMenu: false,
      menuTemplateFallback: true
    });
    return { status: 'rejected_template' };
  }

  log(`${tag} ✅ ${saved.dishCount} món [${saved.quality.reason}] "${name}"${closed ? ' (đóng cửa nhưng có menu)' : ''}`);
  return { status: closed ? 'closed_with_menu' : 'success', dishCount: saved.dishCount };
}

// ── Candidate selection ─────────────────────────────────
function selectCandidates(all) {
  let list = all.filter(r => r && r.id);

  if (ONLY_ID) {
    list = list.filter(r => String(r.id) === ONLY_ID);
  }

  if (OPEN_ONLY) {
    list = list.filter(r => !r.isClosed);
  }

  if (!FORCE) {
    if (ONLY_FALLBACK) {
      list = list.filter(r => r.hasRealMenu !== true || r.menuTemplateFallback === true);
    } else {
      // Default: ưu tiên fallback; real menu chỉ khi > 7 ngày
      list = list.filter(r => {
        if (r.hasRealMenu !== true || r.menuTemplateFallback === true) return true;
        if (!r.menuUpdatedAt) return true;
        const age = Date.now() - new Date(r.menuUpdatedAt).getTime();
        return age > 7 * 24 * 60 * 60 * 1000;
      });
    }
  }

  // Ưu tiên: chưa từng cào → fallback mở cửa → còn lại
  list.sort((a, b) => {
    const score = (r) => {
      let s = 0;
      if (!r.menuUpdatedAt) s += 100;
      if (r.hasRealMenu !== true) s += 50;
      if (!r.isClosed) s += 20;
      if (r.menuTemplateFallback) s += 10;
      return s;
    };
    return score(b) - score(a);
  });

  if (LIMIT > 0) list = list.slice(0, LIMIT);
  return list;
}

async function worker(workerId, queue, stats) {
  while (true) {
    const restaurant = queue.shift();
    if (!restaurant) break;
    try {
      const result = await crawlOne(restaurant, workerId);
      stats[result.status] = (stats[result.status] || 0) + 1;
      stats.done += 1;
      if (stats.done % 5 === 0) {
        log(`[Progress] ${stats.done}/${stats.total} | ✅${stats.success || 0} 🔒${stats.closed_with_menu || 0} ∅${stats.empty || 0} 🚫${stats.rejected_template || 0} ❌${stats.error || 0}`);
      }
    } catch (e) {
      stats.error = (stats.error || 0) + 1;
      stats.done += 1;
      log(`[W${workerId}] 💥 Unhandled "${restaurant.name}": ${e.message}`);
    }
    if (queue.length > 0) await sleep(DELAY_MS);
  }
}

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  ShipFee — Cào menu TỪNG QUÁN (ShopeeFood chính xác)    ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  const all = dbHelper.read();
  if (!Array.isArray(all) || all.length === 0) {
    console.error('DB rỗng — kiểm tra restaurants-chunks/');
    process.exit(1);
  }

  const candidates = selectCandidates(all);
  log(`DB=${all.length} | candidates=${candidates.length} | threads=${THREADS} | delay=${DELAY_MS}ms`);
  log(`flags: only-fallback=${ONLY_FALLBACK} open-only=${OPEN_ONLY} force=${FORCE} dry-run=${DRY_RUN}`);
  log(`supabase=${supabase ? 'ON' : 'OFF'}`);

  if (candidates.length === 0) {
    log('Không còn quán cần cào.');
    process.exit(0);
  }

  if (DRY_RUN) {
    candidates.slice(0, 30).forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.id} | real=${!!r.hasRealMenu} fb=${!!r.menuTemplateFallback} closed=${!!r.isClosed} | ${r.name}`);
    });
    if (candidates.length > 30) console.log(`  … và ${candidates.length - 30} quán nữa`);
    process.exit(0);
  }

  const queue = candidates.slice();
  const stats = { total: candidates.length, done: 0 };
  const t0 = Date.now();

  fs.writeFileSync(STATE_FILE, JSON.stringify({
    startedAt: new Date().toISOString(),
    total: candidates.length,
    ids: candidates.map(r => r.id)
  }, null, 2));

  const workers = [];
  for (let i = 0; i < THREADS; i++) {
    workers.push(worker(i + 1, queue, stats));
  }
  await Promise.all(workers);

  const sec = Math.round((Date.now() - t0) / 1000);
  const final = dbHelper.read();
  const real = final.filter(r => r.hasRealMenu === true).length;

  console.log('\n════════ KẾT QUẢ ════════');
  console.log(`  success:           ${stats.success || 0}`);
  console.log(`  closed_with_menu:  ${stats.closed_with_menu || 0}`);
  console.log(`  empty:             ${stats.empty || 0}`);
  console.log(`  rejected_template: ${stats.rejected_template || 0}`);
  console.log(`  skipped_portal:    ${stats.skipped_portal || 0}`);
  console.log(`  error:             ${stats.error || 0}`);
  console.log(`  time:              ${Math.floor(sec / 60)}m ${sec % 60}s`);
  console.log(`  DB hasRealMenu:    ${real}/${final.length}`);
  console.log('═════════════════════════\n');
  log(`Done in ${sec}s — see ${LOG_FILE}`);
}

main().catch(err => {
  console.error('FATAL', err);
  process.exit(1);
});
