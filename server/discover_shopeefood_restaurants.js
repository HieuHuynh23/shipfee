#!/usr/bin/env node
/**
 * Discover quán THẬT đang giao trên ShopeeFood Cần Thơ → MERGE DB.
 *
 * SF ký request (x-sap-ri...) nên KHÔNG gọi POST giả — chỉ browse tự nhiên
 * + intercept get_browsing_infos / search / collection.
 *
 *   node discover_shopeefood_restaurants.js
 *   node discover_shopeefood_restaurants.js --dry-run
 *   node discover_shopeefood_restaurants.js --keywords=cơm,bún
 */
'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const dbHelper = require('./dbHelper');
const { rewriteSlug } = require('./slugMap');
const { getShopeeFoodKeywords } = require('./discover_keywords_cantho');

const DRY_RUN = process.argv.includes('--dry-run');
const kwArg = process.argv.find(a => a.startsWith('--keywords='));
const EXTRA_KEYWORDS = kwArg
  ? kwArg.split('=').slice(1).join('=').split(',').map(s => s.trim()).filter(Boolean)
  : [];

const DEFAULT_KEYWORDS = getShopeeFoodKeywords();

const BLOCKED_SLUGS = new Set([
  'food', 'fresh', 'drink', 'flowers', 'medicine', 'market', 'khac', 'other',
  'do-an', 'thuc-pham', 'hoa', 'sieu-thi', 'thuoc', 'fmcg', 'pets',
  'danh-sach-dia-diem-giao-tan-noi'
]);

const CATEGORY_PAGES = [
  'https://shopeefood.vn/can-tho/food',
  'https://shopeefood.vn/can-tho/drink',
  'https://shopeefood.vn/can-tho/danh-sach-dia-diem-phuc-vu-food-giao-tan-noi',
  'https://shopeefood.vn/can-tho/danh-sach-dia-diem-phuc-vu-drink-giao-tan-noi',
  'https://shopeefood.vn/can-tho/danh-sach-dia-diem-phuc-vu-rice-giao-tan-noi',
  'https://shopeefood.vn/can-tho/danh-sach-dia-diem-phuc-vu-soup-based-giao-tan-noi',
  'https://shopeefood.vn/can-tho/danh-sach-dia-diem-phuc-vu-hotpot-giao-tan-noi',
  'https://shopeefood.vn/can-tho/danh-sach-dia-diem-phuc-vu-sushi-giao-tan-noi',
  'https://shopeefood.vn/can-tho/danh-sach-dia-diem-phuc-vu-pizza-pasta-burger-giao-tan-noi',
  'https://shopeefood.vn/can-tho/danh-sach-dia-diem-phuc-vu-cake-pastry-giao-tan-noi',
  'https://shopeefood.vn/can-tho/danh-sach-dia-diem-phuc-vu-desserts-giao-tan-noi',
  'https://shopeefood.vn/can-tho/danh-sach-dia-diem-phuc-vu-vegetarian-giao-tan-noi',
  'https://shopeefood.vn/can-tho/danh-sach-dia-diem-giao-tan-noi',
  'https://shopeefood.vn/can-tho/danh-sach-dia-diem-phuc-vu-noodles-giao-tan-noi',
  'https://shopeefood.vn/can-tho/danh-sach-dia-diem-phuc-vu-chicken-giao-tan-noi',
  'https://shopeefood.vn/can-tho/danh-sach-dia-diem-phuc-vu-fastfood-giao-tan-noi',
  'https://shopeefood.vn/can-tho/danh-sach-dia-diem-phuc-vu-milk-tea-giao-tan-noi',
  'https://shopeefood.vn/can-tho/danh-sach-dia-diem-phuc-vu-coffee-giao-tan-noi'
];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getBrowserPath() {
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ];
  for (const p of paths) if (fs.existsSync(p)) return p;
  return null;
}

function extractSlug(item) {
  let slug =
    item.url_rewrite_name ||
    item.url_routing ||
    item.restaurant_url ||
    item.delivery?.url_rewrite_name ||
    item.url ||
    '';
  slug = String(slug).split('?')[0];
  if (slug.includes('/')) slug = slug.split('/').filter(Boolean).pop() || '';
  return rewriteSlug(slug);
}

function looksLikeRealRestaurant(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.is_group || item.is_category || item.category_type != null) return false;
  if (item.cuisine_id && !item.restaurant_id && !item.delivery_id && !item.url_rewrite_name) return false;

  const name = item.name || item.restaurant_name || item.display_name || '';
  if (!name || String(name).length < 3) return false;

  const slug = extractSlug(item);
  if (!slug || slug.length < 3 || BLOCKED_SLUGS.has(slug)) return false;
  if (/^danh-sach-dia-diem/i.test(slug)) return false;
  return true;
}

function normalizeItem(raw) {
  if (!looksLikeRealRestaurant(raw)) return null;
  const slug = extractSlug(raw);
  const name = raw.name || raw.restaurant_name || raw.display_name;
  const address = raw.address || raw.restaurant?.address || 'Cần Thơ';
  const pos = raw.position || raw.restaurant?.position || {};
  const lat = Number(pos.latitude ?? raw.latitude);
  const lon = Number(pos.longitude ?? raw.longitude);
  const photos = raw.photos || raw.restaurant?.photos || [];
  const img =
    (Array.isArray(photos) && (photos[0]?.value || photos[0])) ||
    raw.image ||
    raw.avatar ||
    '';
  const rid = raw.restaurant_id || raw.delivery_id || raw.id;
  return {
    id: String(rid || slug),
    name: String(name).trim(),
    address: String(address).trim(),
    latitude: Number.isFinite(lat) ? lat : 10.0452,
    longitude: Number.isFinite(lon) ? lon : 105.7469,
    img: String(img || ''),
    shopeefoodSlug: slug,
    sfRestaurantId: rid ? Number(rid) || rid : undefined,
    source: 'shopeefood',
    sfDiscoveredAt: new Date().toISOString()
  };
}

function harvestInfos(data, into, idSet) {
  let added = 0;
  const reply = data?.reply || data;
  const lists = [];
  if (Array.isArray(reply?.delivery_infos)) lists.push(reply.delivery_infos);
  if (Array.isArray(reply?.restaurants)) lists.push(reply.restaurants);
  if (Array.isArray(reply?.delivery_restaurants)) lists.push(reply.delivery_restaurants);
  if (Array.isArray(reply?.search_results)) lists.push(reply.search_results);
  if (Array.isArray(reply?.infos)) lists.push(reply.infos);
  if (Array.isArray(reply)) lists.push(reply);

  for (const list of lists) {
    for (const raw of list) {
      const item = raw?.restaurant || raw?.delivery
        ? {
            ...raw.restaurant,
            ...raw.delivery,
            restaurant_id: raw.restaurant_id || raw.restaurant?.id,
            url_rewrite_name:
              raw.delivery?.url_rewrite_name || raw.restaurant?.url_rewrite_name || raw.url_rewrite_name,
            address: raw.address || raw.restaurant?.address,
            photos: raw.photos || raw.restaurant?.photos,
            position: raw.position || raw.restaurant?.position
          }
        : raw;
      const n = normalizeItem(item);
      if (!n) continue;
      if (!into.has(n.shopeefoodSlug)) {
        into.set(n.shopeefoodSlug, n);
        added += 1;
      }
      const id = item.restaurant_id || item.delivery_id || item.id;
      if (id && idSet) idSet.add(Number(id) || id);
    }
  }

  const ids = reply?.delivery_ids || reply?.restaurant_ids || reply?.ids;
  if (Array.isArray(ids) && idSet) ids.forEach(id => idSet.add(Number(id) || id));
  return added;
}

async function scrollPage(page, times, step = 1100, pause = 650) {
  for (let i = 0; i < times; i++) {
    await page.evaluate(s => window.scrollBy(0, s), step);
    await sleep(pause);
  }
}

async function harvestDomSlugs(page, into) {
  const hrefs = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('a[href*="/can-tho/"]').forEach(a => {
      const h = (a.getAttribute('href') || '').split('?')[0];
      const m = h.match(/\/can-tho\/([a-z0-9][a-z0-9-]{2,})$/i);
      if (!m) return;
      const slug = m[1].toLowerCase();
      if (/^danh-sach-dia-diem/i.test(slug)) return;
      const name = (a.textContent || a.getAttribute('title') || '').trim().replace(/\s+/g, ' ');
      out.push({ slug, name, href: h });
    });
    return out;
  });

  let added = 0;
  for (const { slug, name } of hrefs) {
    if (BLOCKED_SLUGS.has(slug) || into.has(slug)) continue;
    if (!name || name.length < 3) continue;
    into.set(slug, {
      id: slug,
      name,
      address: 'Cần Thơ',
      latitude: 10.0452,
      longitude: 105.7469,
      img: '',
      shopeefoodSlug: slug,
      source: 'shopeefood',
      sfDiscoveredAt: new Date().toISOString()
    });
    added += 1;
  }
  return added;
}

async function uiSearch(page, keyword) {
  await page.goto('https://shopeefood.vn/can-tho/food', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
  await sleep(700);
  const typed = await page.evaluate(q => {
    const input =
      document.querySelector('input[type="search"]') ||
      document.querySelector('input[placeholder*="Tìm"]') ||
      document.querySelector('input[placeholder*="tìm"]') ||
      document.querySelector('input[class*="search"]') ||
      document.querySelector('input[name*="search"]');
    if (!input) return false;
    input.focus();
    const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    native.set.call(input, q);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, keyword);
  if (!typed) {
    // Fallback: URL search (vẫn kích hoạt signed API từ app)
    await page.goto(
      `https://shopeefood.vn/can-tho/food?q=${encodeURIComponent(keyword)}`,
      { waitUntil: 'networkidle2', timeout: 30000 }
    ).catch(() => {});
  } else {
    await page.keyboard.press('Enter').catch(() => {});
    await sleep(2200);
  }
  await scrollPage(page, 8, 900, 450);
}

function mergeIntoDb(discovered) {
  const existing = dbHelper.read();
  const byId = new Map(existing.map(r => [String(r.id), r]));
  const bySlug = new Map();
  for (const r of existing) {
    if (r.shopeefoodSlug) bySlug.set(String(r.shopeefoodSlug).split('?')[0], r);
  }

  let added = 0;
  let updated = 0;
  for (const d of discovered) {
    const hit = byId.get(d.id) || bySlug.get(d.shopeefoodSlug);
    if (hit) {
      let changed = false;
      if (!hit.shopeefoodSlug) {
        hit.shopeefoodSlug = d.shopeefoodSlug;
        changed = true;
      }
      if (d.address && d.address !== 'Cần Thơ' && (!hit.address || /^\d+\s*chi\s*nh/i.test(hit.address))) {
        hit.address = d.address;
        changed = true;
      }
      if (typeof d.latitude === 'number' && typeof hit.latitude !== 'number') {
        hit.latitude = d.latitude;
        hit.longitude = d.longitude;
        changed = true;
      }
      if (d.img && (!hit.img || String(hit.img).includes('unsplash'))) {
        hit.img = d.img;
        changed = true;
      }
      if (d.sfRestaurantId && !hit.sfRestaurantId) {
        hit.sfRestaurantId = d.sfRestaurantId;
        changed = true;
      }
      hit.sfDiscoveredAt = d.sfDiscoveredAt;
      hit.source = 'shopeefood';
      if (hit.lastCrawlError === 'not_on_shopeefood' || hit.lastCrawlError === 'empty_menu') {
        delete hit.lastCrawlError;
        delete hit.crawlNextAttempt;
        changed = true;
      }
      if (hit.isClosed && hit.closedReason && /ShopeeFood|ngưng dịch vụ|không tồn tại/i.test(hit.closedReason)) {
        hit.isClosed = false;
        delete hit.closedReason;
        delete hit.closedAt;
        changed = true;
      }
      if (changed) updated += 1;
      continue;
    }
    existing.push({
      ...d,
      hasRealMenu: false,
      menuTemplateFallback: true,
      dishNames: []
    });
    byId.set(d.id, d);
    bySlug.set(d.shopeefoodSlug, d);
    added += 1;
  }
  dbHelper.write(existing);
  return { added, updated, total: existing.length };
}

async function discover() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  ShipFee — Discover quán THẬT ShopeeFood Cần Thơ        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`mode: ${DRY_RUN ? 'DRY-RUN' : 'MERGE-INTO-DB'}`);
  console.log('strategy: browse + intercept (no fake POST)');

  const found = new Map();
  const idSet = new Set();
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: getBrowserPath() || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--lang=vi-VN,vi,en-US,en',
      '--window-size=1280,900'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9' });

    page.on('response', async response => {
      const url = response.url();
      if (!url.includes('deliverynow.vn/api/')) return;
      if (url.includes('get_metadata') || url.includes('/meta/')) return;
      if (!/browsing_infos|search_global|get_infos|get_detail|get_ids/i.test(url)) return;
      try {
        if (response.status() !== 200) return;
        const data = JSON.parse(await response.text());
        const before = found.size;
        harvestInfos(data, found, idSet);
        const added = found.size - before;
        if (added > 0) console.log(`  [intercept] +${added} (total ${found.size}, ids=${idSet.size})`);
      } catch (_) {}
    });

    // Warm-up
    await page.goto('https://shopeefood.vn/can-tho', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(1200);

    console.log(`\n📍 Browse ${CATEGORY_PAGES.length} category pages + scroll...`);
    for (const url of CATEGORY_PAGES) {
      const before = found.size;
      console.log(`  → ${url.replace('https://shopeefood.vn', '')}`);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
      await sleep(1000);
      await scrollPage(page, 22, 1100, 600);
      const domAdded = await harvestDomSlugs(page, found);
      console.log(`    +${found.size - before} (dom+${domAdded}, total ${found.size})`);
    }

    const keywords = [...new Set([...DEFAULT_KEYWORDS, ...EXTRA_KEYWORDS])];
    console.log(`\n📍 UI search ${keywords.length} từ khóa (kích hoạt API đã ký)...`);
    for (const kw of keywords) {
      const before = found.size;
      try {
        await uiSearch(page, kw);
        await harvestDomSlugs(page, found);
      } catch (e) {
        console.log(`  "${kw}": err ${e.message}`);
      }
      console.log(`  "${kw}": +${found.size - before} (total ${found.size})`);
      await sleep(500);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const discovered = [...found.values()];
  console.log(`\n✅ Discover xong: ${discovered.length} quán THẬT`);

  const reportPath = path.join(__dirname, 'discover_shopeefood_report.json');
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        count: discovered.length,
        sample: discovered.slice(0, 40),
        slugs: discovered.map(d => d.shopeefoodSlug)
      },
      null,
      2
    )
  );
  console.log(`💾 ${reportPath}`);

  if (DRY_RUN) {
    discovered.slice(0, 20).forEach(d => console.log(' -', d.name, '|', d.shopeefoodSlug));
    return { added: 0, updated: 0, total: discovered.length };
  }

  const { added, updated, total } = mergeIntoDb(discovered);
  console.log(`\n════════ MERGE DB ════════`);
  console.log(`  discovered: ${discovered.length}`);
  console.log(`  added:      ${added}`);
  console.log(`  updated:    ${updated}`);
  console.log(`  DB total:   ${total}`);
  console.log('══════════════════════════\n');
  return { added, updated, total: discovered.length };
}

if (require.main === module) {
  discover().catch(err => {
    console.error('FATAL', err);
    process.exit(1);
  });
}

module.exports = { discover };
