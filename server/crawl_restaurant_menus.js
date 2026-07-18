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
 *   --portals-only    chỉ xử lý portal "Hệ thống" (address = N chi nhánh)
 *   --expand-only     portal: chỉ thêm chi nhánh vào DB, không cào menu
 *   --sf-priority     ưu tiên quán đã discover từ ShopeeFood / có shopeefoodSlug
 */

'use strict';

process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  if (!msg.includes('Target closed') && !msg.includes('Protocol error')) {
    console.warn(`[UnhandledRejection] ${msg}`);
  }
});

process.on('uncaughtException', (err) => {
  console.error(`[UncaughtException] ${err.message}`);
});

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const dbHelper = require('./dbHelper');
const menuScraper = require('./menuScraper');
const { analyzeMenuQuality } = require('./menuQuality');
const {
  slugFromRestaurant,
  rewriteSlug,
  isGenericBrandPortal,
  looksLikeBrandChainName
} = require('./slugMap');
const {
  resolveBranchesForRestaurant,
  resolveShopeefoodSlugFromFoody
} = require('./brandResolver');

// ── CLI ─────────────────────────────────────────────────
function argVal(name, fallback) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const THREADS = Math.max(1, parseInt(argVal('threads', '1'), 10) || 1);
const DELAY_MS = Math.max(400, parseInt(argVal('delay', '1500'), 10) || 1500);
const LIMIT = parseInt(argVal('limit', '0'), 10) || 0;
const ONLY_ID = argVal('id', '') || '';
const ONLY_FALLBACK = hasFlag('only-fallback');
const OPEN_ONLY = hasFlag('open-only');
const FORCE = hasFlag('force');
const DRY_RUN = hasFlag('dry-run');
const SKIP_SUPABASE = hasFlag('skip-supabase');
const PORTALS_ONLY = hasFlag('portals-only');
const EXPAND_ONLY = hasFlag('expand-only');
const SF_PRIORITY = hasFlag('sf-priority');

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
async function resolveRestaurantSlug(restaurant) {
  let slug = slugFromRestaurant(restaurant);
  slug = rewriteSlug(slug);

  // Always try Foody resolve when no trusted slug stored
  if (!restaurant.shopeefoodSlug) {
    const resolved = await resolveShopeefoodSlugFromFoody(slug);
    if (resolved) slug = rewriteSlug(resolved);
  }
  return slug;
}

/**
 * Upsert chi nhánh phát hiện từ portal vào DB (không ghi đè menu thật).
 */
async function upsertBranchRestaurants(branches, portalId) {
  if (!branches || branches.length === 0) return [];
  const added = [];
  await withDb(data => {
    let changed = false;
    for (const b of branches) {
      const bySlug = data.findIndex(
        r => r && (r.shopeefoodSlug === b.shopeefoodSlug || String(r.id) === String(b.id))
      );
      if (bySlug >= 0) {
        const row = data[bySlug];
        if (!row.shopeefoodSlug) row.shopeefoodSlug = b.shopeefoodSlug;
        if (!row.address && b.address) row.address = b.address;
        row.brandPortalId = portalId;
        changed = true;
        added.push(row);
        continue;
      }
      const neu = {
        id: b.id,
        name: b.name,
        address: b.address || '',
        img: b.img || '',
        shopeefoodSlug: b.shopeefoodSlug,
        hasRealMenu: false,
        menuTemplateFallback: true,
        brandPortalId: portalId,
        rating: 4.6,
        reviews: 50,
        isClosed: false
      };
      data.push(neu);
      added.push(neu);
      changed = true;
    }
    return { save: changed, value: added };
  });
  return added;
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

function menuFromRaw(raw) {
  if (!raw) return null;
  if (raw && raw.closed === true && Array.isArray(raw.menu)) return raw.menu;
  if (Array.isArray(raw)) return raw;
  return null;
}

async function scrapeWithSlugFallback(restaurant, workerId) {
  const tag = `[W${workerId}]`;
  const primary = await resolveRestaurantSlug(restaurant);
  const candidates = buildSlugCandidates(restaurant, primary);

  // Foody resolve sớm nếu chưa có slug tin cậy
  if (!restaurant.shopeefoodSlug) {
    const foodyHint = slugFromRestaurant(restaurant);
    const alt = await resolveShopeefoodSlugFromFoody(foodyHint);
    if (alt && !candidates.includes(alt)) candidates.push(alt);
  }

  const primarySlug = candidates[0] || primary;
  const altSlugs = candidates.slice(1);
  log(`${tag} ⚡ Cào slug chính: ${primarySlug}${altSlugs.length ? ` (+${altSlugs.length} ứng viên)` : ''}`);

  let lastRaw = null;
  let usedSlug = primarySlug;
  try {
    lastRaw = await menuScraper.scrapeMenu(primarySlug, {
      name: restaurant.name || '',
      address: restaurant.address || '',
      altSlugs
    });
  } catch (e) {
    log(`${tag} ⚠️ Lỗi scrape: ${e.message}`);
    return { raw: null, slug: usedSlug };
  }

  if (lastRaw && lastRaw.usedSlug) usedSlug = lastRaw.usedSlug;
  else if (lastRaw && lastRaw.recoveredFromSearch && lastRaw.usedSlug) usedSlug = lastRaw.usedSlug;

  // Search gợi ý thêm slug — thử tuần tự nếu vẫn chưa có menu
  let menu = menuFromRaw(lastRaw);
  if ((!menu || menu.length === 0) && lastRaw && Array.isArray(lastRaw.altSlugs)) {
    for (const alt of lastRaw.altSlugs) {
      if (!alt || candidates.includes(alt) || alt === usedSlug) continue;
      log(`${tag} 🔁 Thử slug search: ${alt}`);
      try {
        const raw2 = await menuScraper.scrapeMenu(alt, { name: restaurant.name || '', address: restaurant.address || '' });
        const m2 = menuFromRaw(raw2);
        if (m2 && m2.length > 0) {
          return { raw: raw2, slug: (raw2 && raw2.usedSlug) || alt };
        }
        lastRaw = raw2 || lastRaw;
      } catch (_) {}
    }
  }

  menu = menuFromRaw(lastRaw);
  if (menu && menu.length > 0) {
    return { raw: lastRaw, slug: usedSlug };
  }
  return { raw: lastRaw, slug: usedSlug };
}

/**
 * Khi chi nhánh không còn trên SF — mượn menu chi nhánh cùng portal (cùng thương hiệu).
 */
async function trySiblingBrandMenu(restaurant, workerId) {
  const tag = `[W${workerId}]`;
  if (!restaurant.brandPortalId && !isGenericBrandPortal(restaurant.name, restaurant.address)) {
    // cùng chuỗi theo tên gốc (bỏ địa chỉ sau dấu -)
    const base = String(restaurant.name || '').split(/\s*[-–]\s*/)[0].trim().toLowerCase();
    if (base.length < 4) return null;
  }

  const sibling = await withDb(data => {
    const portalId = restaurant.brandPortalId;
    let pool = [];
    if (portalId) {
      pool = data.filter(
        r =>
          r &&
          String(r.id) !== String(restaurant.id) &&
          r.hasRealMenu === true &&
          (String(r.brandPortalId) === String(portalId) || String(r.id) === String(portalId))
      );
    }
    if (pool.length === 0) {
      const base = String(restaurant.name || '')
        .split(/\s*[-–]\s*/)[0]
        .trim()
        .toLowerCase();
      pool = data.filter(
        r =>
          r &&
          String(r.id) !== String(restaurant.id) &&
          r.hasRealMenu === true &&
          String(r.name || '').toLowerCase().startsWith(base)
      );
    }
    // ưu tiên có file menu
    const hit = pool.find(r => {
      try {
        return fs.existsSync(menuPath(r.id));
      } catch (_) {
        return false;
      }
    }) || pool[0];
    return { save: false, value: hit || null };
  });

  if (!sibling) return null;

  let menu = [];
  try {
    const p = menuPath(sibling.id);
    if (fs.existsSync(p)) menu = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {}
  if (!Array.isArray(menu) || menu.length === 0) return null;

  const quality = analyzeMenuQuality(menu);
  if (!quality.isReal) return null;

  log(`${tag} 🧩 Mượn menu từ chi nhánh cùng chuỗi: ${sibling.name} (${menu.length} món)`);
  return { menu, sibling, slug: sibling.shopeefoodSlug || slugFromRestaurant(sibling) };
}

/**
 * Portal "Hệ thống" → phân giải chi nhánh Cần Thơ, thêm vào DB, cào menu từng chi nhánh.
 */
async function expandAndCrawlPortal(restaurant, workerId) {
  const tag = `[W${workerId}]`;
  const name = restaurant.name || restaurant.id;
  log(`${tag} 🏷️ Portal chuỗi: "${name}" — đang phân giải chi nhánh Foody...`);

  const { brandSlug, branches } = await resolveBranchesForRestaurant(restaurant);
  if (!branches.length) {
    log(`${tag} ⚠️ Không tìm thấy chi nhánh Cần Thơ cho portal "${name}" (brand=${brandSlug})`);
    await markChecked(restaurant.id, {
      isBrandPortal: true,
      lastCrawlError: 'portal_no_branches',
      brandSlug: brandSlug || ''
    });
    return { status: 'portal_no_branches' };
  }

  log(`${tag} ✅ Portal "${name}": ${branches.length} chi nhánh — ${branches.map(b => b.shopeefoodSlug).join(', ')}`);
  const upserted = await upsertBranchRestaurants(branches, restaurant.id);

  await markChecked(restaurant.id, {
    isBrandPortal: true,
    brandSlug: brandSlug || '',
    brandBranchIds: upserted.map(b => b.id),
    brandBranchCount: upserted.length,
    lastCrawlError: '',
    hasRealMenu: false,
    menuTemplateFallback: true
  });

  let branchSuccess = 0;
  let branchEmpty = 0;
  const branchStats = {};

  if (EXPAND_ONLY) {
    log(`${tag} 🏷️ expand-only: đã thêm ${upserted.length} chi nhánh, bỏ qua cào menu`);
    return {
      status: 'portal_expanded',
      branchSuccess: 0,
      branchTotal: upserted.length,
      branchEmpty: 0,
      branchStats: { expand_only: upserted.length }
    };
  }

  for (const branch of upserted) {
    // Tránh cào lại portal chính nếu id trùng
    if (String(branch.id) === String(restaurant.id)) continue;
    if (branch.hasRealMenu === true && !FORCE) {
      branchSuccess += 1;
      continue;
    }
    log(`${tag} ↳ Cào chi nhánh: ${branch.name} (${branch.shopeefoodSlug})`);
    try {
      const result = await crawlOne(branch, workerId, { skipPortalCheck: true });
      branchStats[result.status] = (branchStats[result.status] || 0) + 1;
      if (result.status === 'success' || result.status === 'closed_with_menu') branchSuccess += 1;
      else branchEmpty += 1;
    } catch (e) {
      branchEmpty += 1;
      log(`${tag} ❌ Lỗi cào chi nhánh "${branch.name}": ${e.message}`);
    }
    await sleep(Math.min(DELAY_MS, 1500));
  }

  log(`${tag} 🏷️ Portal xong "${name}": ${branchSuccess} chi nhánh có menu / ${upserted.length}`);

  if (branchSuccess === 0) {
    await markChecked(restaurant.id, {
      isBrandPortal: true,
      lastCrawlError: 'portal_no_menu',
      crawlNextAttempt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    });
  }

  return {
    status: branchSuccess > 0 ? 'portal_expanded' : 'portal_no_menu',
    branchSuccess,
    branchTotal: upserted.length,
    branchEmpty,
    branchStats
  };
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
async function crawlOne(restaurant, workerId, opts = {}) {
  const tag = `[W${workerId}]`;
  const name = restaurant.name || restaurant.id;

  // Portal cha ("2 chi nhánh") → phân giải & cào chi nhánh, không skip im lặng
  if (!opts.skipPortalCheck && isGenericBrandPortal(restaurant.name, restaurant.address)) {
    return expandAndCrawlPortal(restaurant, workerId);
  }

  // Tên "Hệ thống …" nhưng có địa chỉ thật → vẫn cào như chi nhánh
  if (!opts.skipPortalCheck && looksLikeBrandChainName(restaurant.name) && !restaurant.shopeefoodSlug) {
    log(`${tag} ℹ️ Chi nhánh chuỗi (có địa chỉ): "${name}"`);
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
  let notFound = false;
  let apiBlocked = false;

  if (raw && raw.blocked === true) {
    apiBlocked = true;
  } else if (raw && raw.closed === true) {
    closed = true;
    closedReason = raw.reason || '';
    notFound = raw.notFound === true;
    if (Array.isArray(raw.menu) && raw.menu.length > 0) menu = raw.menu;
  } else if (Array.isArray(raw) && raw.length > 0) {
    menu = raw;
  }

  // 403/429: quán tồn tại — không đánh closed / empty / not_on_shopeefood
  if (apiBlocked && (!menu || menu.length === 0)) {
    log(`${tag} ⏳ API bị chặn nhưng quán tồn tại — xếp lịch cào lại: "${name}" (slug=${slug})`);
    await markChecked(restaurant.id, {
      lastCrawlError: 'api_blocked',
      shopeefoodSlug: slug,
      crawlNextAttempt: new Date(Date.now() + 20 * 60 * 1000).toISOString()
    });
    return { status: 'api_blocked' };
  }

  if (!menu || menu.length === 0) {
    // Fallback: mượn menu chi nhánh cùng thương hiệu (Foody còn, SF slug chết)
    if (notFound || !menu || menu.length === 0) {
      const borrowed = await trySiblingBrandMenu(restaurant, workerId);
      if (borrowed && borrowed.menu.length > 0) {
        const rebound = borrowed.menu.map((item, i) => ({
          ...item,
          id: `${safeMenuId(restaurant.id)}-item-${i}`
        }));
        const saved = await persistSuccess(restaurant, rebound, borrowed.slug || slug, {
          closed: false,
          closedReason: ''
        });
        if (saved.ok) {
          await markChecked(restaurant.id, {
            menuFromSiblingId: borrowed.sibling.id,
            lastCrawlError: '',
            shopeefoodSlug: restaurant.shopeefoodSlug || slug
          });
          log(`${tag} ✅ ${saved.dishCount} món [sibling:${borrowed.sibling.id}] "${name}"`);
          return { status: 'success', dishCount: saved.dishCount, fromSibling: true };
        }
      }
    }

    if (notFound) {
      log(`${tag} 🚫 Không có trên ShopeeFood: "${name}" (slug=${slug})`);
      await markChecked(restaurant.id, {
        lastCrawlError: 'not_on_shopeefood',
        shopeefoodSlug: slug,
        // Ngoài giờ / delist — không đánh isClosed vĩnh viễn; ghi nhận để bỏ qua sớm lần sau
        crawlNextAttempt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      });
      return { status: 'not_found' };
    }
    if (closed) {
      log(`${tag} 🔒 Đóng cửa / không menu: "${name}" (slug=${slug})`);
      await markChecked(restaurant.id, {
        lastCrawlError: 'closed_no_menu',
        shopeefoodSlug: slug,
        isClosed: true,
        closedAt: new Date().toISOString(),
        closedReason: closedReason || 'Đóng cửa trên ShopeeFood'
      });
      return { status: 'closed_no_menu' };
    }
    log(`${tag} ⚠️ Không có menu API cho "${name}" (slug=${slug})`);
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

  if (PORTALS_ONLY) {
    list = list.filter(r => isGenericBrandPortal(r.name, r.address));
    if (!FORCE) {
      list = list.filter(r => !r.brandBranchCount);
    }
  }

  if (OPEN_ONLY) {
    list = list.filter(r => !r.isClosed);
  }

  if (!FORCE) {
    // Bỏ qua quán vừa xác nhận không có trên ShopeeFood (chờ crawlNextAttempt)
    const now = Date.now();
    list = list.filter(r => {
      if (r.crawlNextAttempt) {
        if (
          r.lastCrawlError === 'not_on_shopeefood' ||
          r.lastCrawlError === 'portal_no_branches' ||
          r.lastCrawlError === 'portal_no_menu' ||
          r.lastCrawlError === 'api_blocked'
        ) {
          return new Date(r.crawlNextAttempt).getTime() <= now;
        }
      }
      // Tránh đốt thời gian cào lại empty vừa fail trong 24h
      if (r.lastCrawlError === 'empty_menu' && r.menuUpdatedAt) {
        const age = now - new Date(r.menuUpdatedAt).getTime();
        if (age < 24 * 60 * 60 * 1000) return false;
      }
      // api_blocked vừa ghi — chờ crawlNextAttempt (kể cả thiếu field cũ)
      if (r.lastCrawlError === 'api_blocked' && !r.crawlNextAttempt) {
        return false;
      }
      return true;
    });

    if (ONLY_FALLBACK) {
      list = list.filter(r => {
        // Portal chưa expand vẫn cần xử lý
        if (isGenericBrandPortal(r.name, r.address) && !r.brandBranchCount) return true;
        return r.hasRealMenu !== true || r.menuTemplateFallback === true;
      });
    } else {
      list = list.filter(r => {
        if (isGenericBrandPortal(r.name, r.address) && !r.brandBranchCount) return true;
        if (r.hasRealMenu !== true || r.menuTemplateFallback === true) return true;
        if (!r.menuUpdatedAt) return true;
        const age = Date.now() - new Date(r.menuUpdatedAt).getTime();
        return age > 7 * 24 * 60 * 60 * 1000;
      });
    }
  }

  // Ưu tiên: SF discovered → portal chưa expand → chưa từng cào → fallback mở cửa
  list.sort((a, b) => {
    const score = (r) => {
      let s = 0;
      if (SF_PRIORITY) {
        if (r.sfDiscoveredAt || r.source === 'shopeefood') s += 300;
        if (r.shopeefoodSlug) s += 80;
      }
      if (isGenericBrandPortal(r.name, r.address) && !r.brandBranchCount) s += 200;
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
        log(
          `[Progress] ${stats.done}/${stats.total} | ` +
          `✅${stats.success || 0} 🔒${stats.closed_with_menu || 0} ` +
          `🏷️${(stats.portal_expanded || 0) + (stats.portal_no_menu || 0)} ` +
          `∅${stats.empty || 0} ⏳${stats.api_blocked || 0} 🚫${stats.not_found || 0} ❌${stats.error || 0}`
        );
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
  log(`flags: only-fallback=${ONLY_FALLBACK} open-only=${OPEN_ONLY} portals-only=${PORTALS_ONLY} expand-only=${EXPAND_ONLY} sf-priority=${SF_PRIORITY} force=${FORCE} dry-run=${DRY_RUN}`);
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
  console.log(`  portal_expanded:   ${stats.portal_expanded || 0}`);
  console.log(`  portal_no_menu:    ${stats.portal_no_menu || 0}`);
  console.log(`  portal_no_branches:${stats.portal_no_branches || 0}`);
  console.log(`  empty:             ${stats.empty || 0}`);
  console.log(`  not_found:         ${stats.not_found || 0}`);
  console.log(`  closed_no_menu:    ${stats.closed_no_menu || 0}`);
  console.log(`  rejected_template: ${stats.rejected_template || 0}`);
  console.log(`  error:             ${stats.error || 0}`);
  console.log(`  time:              ${Math.floor(sec / 60)}m ${sec % 60}s`);
  console.log(`  DB hasRealMenu:    ${real}/${final.length}`);
  console.log('═════════════════════════\n');
  log(`Done in ${sec}s — see ${LOG_FILE}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('FATAL', err);
    process.exit(1);
  });
}

module.exports = { selectCandidates, crawlOne, expandAndCrawlPortal };
