#!/usr/bin/env node
/**
 * Quét Foody Cần Thơ tối đa phủ → resolve ShopeeFood → MERGE DB.
 *
 * - Từ khóa món + đường + họ tên + prefix chữ cái
 * - Gap-fill: ưu tiên quán CHƯA có trong DB; --full = resolve hết missing (không cắt)
 *
 *   node discover_foody_shopeefood.js --full
 *   node discover_foody_shopeefood.js --pages=20 --detail-limit=0
 *   node discover_foody_shopeefood.js --dry-run
 */
'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const dbHelper = require('./dbHelper');
const { rewriteSlug } = require('./slugMap');
const { resolveBrandBranches, resolveShopeefoodSlugFromFoody } = require('./brandResolver');
const { getFoodyKeywords } = require('./discover_keywords_cantho');

const DRY_RUN = process.argv.includes('--dry-run');
const FULL = process.argv.includes('--full');
const GAP_FILL = process.argv.includes('--gap-fill') || !process.argv.includes('--no-gap-fill');
const pagesArg = process.argv.find(a => a.startsWith('--pages='));
const detailArg = process.argv.find(a => a.startsWith('--detail-limit='));
const concArg = process.argv.find(a => a.startsWith('--concurrency='));
const MAX_PAGES = Math.max(1, parseInt(pagesArg ? pagesArg.split('=')[1] : FULL ? '20' : '15', 10) || 15);
// 0 = không giới hạn (resolve hết missing + brand)
const DETAIL_LIMIT = detailArg
  ? Math.max(0, parseInt(detailArg.split('=')[1], 10) || 0)
  : FULL
    ? 0
    : 5000;
const RESOLVE_CONCURRENCY = Math.max(1, parseInt(concArg ? concArg.split('=')[1] : '4', 10) || 4);

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8',
  Accept: 'text/html,application/xhtml+xml'
};

const LIST_SEEDS = [
  'https://www.foody.vn/can-tho/dia-diem',
  'https://www.foody.vn/can-tho/dia-diem?ds=Delivery',
  'https://www.foody.vn/can-tho/food/dia-diem',
  'https://www.foody.vn/can-tho/food/dia-diem?ds=Delivery',
  'https://www.foody.vn/can-tho/food/dia-diem?categorygroup=food&ds=Delivery',
  'https://www.foody.vn/can-tho/nha-hang',
  'https://www.foody.vn/can-tho/nha-hang?ds=Delivery',
  'https://www.foody.vn/can-tho/cafe',
  'https://www.foody.vn/can-tho/cafe?ds=Delivery',
  'https://www.foody.vn/can-tho/quan-an',
  'https://www.foody.vn/can-tho/quan-an?ds=Delivery',
  'https://www.foody.vn/can-tho/an-vat',
  'https://www.foody.vn/can-tho/an-vat/dia-diem',
  'https://www.foody.vn/can-tho/an-vat/dia-diem?ds=Delivery'
];

const SEARCH_KEYWORDS = getFoodyKeywords();

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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

async function fetchHtml(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.get(url, {
        headers: HEADERS,
        timeout: 18000,
        validateStatus: () => true
      });
      if (res.status === 200) return res.data;
      if (res.status === 503 || res.status === 429) {
        await sleep(800 + i * 700);
        continue;
      }
      return null;
    } catch (_) {
      await sleep(500 + i * 400);
    }
  }
  return null;
}

function parseListHtml(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('.row-item, .ldc-item').each((_, el) => {
    const nameEl = $(el).find('h2 a, .ldc-item-h-name h2 a, .row-item-title a').first();
    let name = nameEl.text().trim();
    const href =
      nameEl.attr('href') ||
      $(el).find('a[href*="/can-tho/"], a[href*="/thuong-hieu/"]').first().attr('href') ||
      '';
    if (!name || name === '...') {
      name = ($(el).find('img[alt]').attr('alt') || '').replace(/&amp;/g, '&').trim();
    }
    if (!name || !href || href.includes('{{')) return;

    let address = $(el)
      .find('.address, .row-item-address, .ldc-item-h-address span')
      .first()
      .text()
      .trim()
      .replace(/\s+/g, ' ');
    let img = $(el).find('img').first().attr('src') || '';
    if (img.includes('ratin-rank') || img.includes('{{')) img = '';

    const isBrand = href.includes('/thuong-hieu/');
    items.push({
      name,
      href: href.split('?')[0],
      address,
      img,
      isBrand,
      brandSlug: isBrand ? href.split('?')[0].split('/').pop() : '',
      foodySlug: !isBrand ? href.split('?')[0].split('/').pop() : ''
    });
  });
  return items;
}

async function crawlListUrl(baseUrl, maxPages, seenHref, listed) {
  let emptyStreak = 0;
  for (let p = 1; p <= maxPages; p++) {
    const url =
      p <= 1
        ? baseUrl
        : baseUrl.includes('?')
          ? `${baseUrl}&page=${p}`
          : `${baseUrl}?page=${p}`;
    try {
      const html = await fetchHtml(url);
      if (!html) {
        emptyStreak += 1;
        if (emptyStreak >= 3) break;
        continue;
      }
      const items = parseListHtml(html);
      let added = 0;
      for (const it of items) {
        if (seenHref.has(it.href)) continue;
        seenHref.add(it.href);
        listed.push(it);
        added += 1;
      }
      if (added > 0 || p === 1) {
        console.log(`  ${url.replace('https://www.foody.vn', '')}: +${added} (listed ${listed.length})`);
      }
      if (added === 0) {
        emptyStreak += 1;
        if (emptyStreak >= 2) break;
      } else emptyStreak = 0;
    } catch (e) {
      console.log(`  fail ${url}: ${e.message}`);
      emptyStreak += 1;
      if (emptyStreak >= 3) break;
    }
    await sleep(220);
  }
}

function buildDbIndex(existing) {
  const bySlug = new Set();
  const byFoody = new Set();
  const byName = new Set();
  for (const r of existing) {
    if (!r) continue;
    if (r.shopeefoodSlug) bySlug.add(String(r.shopeefoodSlug).split('?')[0].toLowerCase());
    if (r.foodySlug) byFoody.add(String(r.foodySlug).toLowerCase());
    const nk = normKey(r.name);
    if (nk) byName.add(nk);
    const id = String(r.id || '');
    if (id.startsWith('r_ct_')) bySlug.add(id.slice(5).replace(/_/g, '-'));
  }
  return { bySlug, byFoody, byName };
}

function isAlreadyInDb(item, index) {
  if (item.foodySlug && index.byFoody.has(item.foodySlug.toLowerCase())) return true;
  if (item.foodySlug && index.bySlug.has(item.foodySlug.toLowerCase())) return true;
  const nk = normKey(item.name);
  if (nk && index.byName.has(nk)) return true;
  if (nk && nk.length >= 10) {
    for (const n of index.byName) {
      if (n.length >= 10 && (n.includes(nk) || nk.includes(n))) return true;
    }
  }
  return false;
}

function prioritizeForResolve(listed, index) {
  const missing = [];
  const brands = [];
  const known = [];
  for (const it of listed) {
    if (it.isBrand) {
      brands.push(it);
      continue;
    }
    if (GAP_FILL && !isAlreadyInDb(it, index)) missing.push(it);
    else known.push(it);
  }
  console.log(
    `  gap-fill queue: missing=${missing.length} brands=${brands.length} known=${known.length} limit=${DETAIL_LIMIT || '∞'}`
  );

  const ordered = [...missing, ...brands, ...known];
  if (DETAIL_LIMIT > 0) return ordered.slice(0, DETAIL_LIMIT);
  // full: lấy hết missing + brand; known chỉ khi còn budget ảo không cắt
  return [...missing, ...brands];
}

async function resolvePlace(item) {
  const out = [];
  if (item.isBrand && item.brandSlug) {
    const branches = await resolveBrandBranches(item.brandSlug);
    for (const b of branches) {
      out.push({
        id: b.id,
        name: b.name,
        address: b.address || item.address || 'Cần Thơ',
        img: b.img || item.img || '',
        shopeefoodSlug: b.shopeefoodSlug,
        foodySlug: b.foodySlug,
        sfDiscoveredAt: new Date().toISOString(),
        source: 'foody-brand'
      });
    }
    return out;
  }
  if (!item.foodySlug) return out;

  let slug = await resolveShopeefoodSlugFromFoody(item.foodySlug);
  if (!slug) slug = rewriteSlug(item.foodySlug);

  out.push({
    id: `r_ct_${slug.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    name: item.name,
    address: item.address || 'Cần Thơ',
    img: item.img || '',
    shopeefoodSlug: slug,
    foodySlug: item.foodySlug,
    sfDiscoveredAt: new Date().toISOString(),
    source: 'foody-detail'
  });
  return out;
}

async function mapPool(items, concurrency, worker) {
  let i = 0;
  const results = new Array(items.length);
  async function run() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
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
    if (!d.shopeefoodSlug) continue;
    const hit = byId.get(d.id) || bySlug.get(d.shopeefoodSlug);
    if (hit) {
      let changed = false;
      if (!hit.shopeefoodSlug) {
        hit.shopeefoodSlug = d.shopeefoodSlug;
        changed = true;
      }
      if (d.foodySlug && !hit.foodySlug) {
        hit.foodySlug = d.foodySlug;
        changed = true;
      }
      if (d.address && d.address !== 'Cần Thơ' && (!hit.address || /^\d+\s*chi\s*nh/i.test(hit.address))) {
        hit.address = d.address;
        changed = true;
      }
      if (d.img && (!hit.img || String(hit.img).includes('unsplash'))) {
        hit.img = d.img;
        changed = true;
      }
      hit.sfDiscoveredAt = d.sfDiscoveredAt;
      if (!hit.source) hit.source = d.source;
      if (hit.lastCrawlError === 'not_on_shopeefood' || hit.lastCrawlError === 'empty_menu') {
        delete hit.lastCrawlError;
        delete hit.crawlNextAttempt;
        changed = true;
      }
      if (changed) updated += 1;
      continue;
    }
    existing.push({
      ...d,
      hasRealMenu: false,
      menuTemplateFallback: true,
      dishNames: [],
      rating: 4.6,
      reviews: 50,
      isClosed: false
    });
    byId.set(d.id, d);
    bySlug.set(d.shopeefoodSlug, d);
    added += 1;
  }
  dbHelper.write(existing);
  return { added, updated, total: existing.length };
}

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  ShipFee — Foody FULL coverage → ShopeeFood (MERGE)     ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(
    `pages=${MAX_PAGES} detail-limit=${DETAIL_LIMIT || '∞'} keywords=${SEARCH_KEYWORDS.length} concurrency=${RESOLVE_CONCURRENCY} full=${FULL} gap-fill=${GAP_FILL}`
  );

  const listed = [];
  const seenHref = new Set();

  console.log('\n📍 List seeds + phân trang...');
  for (const seed of LIST_SEEDS) {
    await crawlListUrl(seed, MAX_PAGES, seenHref, listed);
  }

  console.log(`\n📍 Search ${SEARCH_KEYWORDS.length} từ khóa (món/đường/họ/prefix)...`);
  let ki = 0;
  for (const kw of SEARCH_KEYWORDS) {
    ki += 1;
    const base = `https://www.foody.vn/can-tho/dia-diem?q=${encodeURIComponent(kw)}&ds=Delivery`;
    const pages = kw.length <= 2 ? Math.min(MAX_PAGES, 12) : Math.min(MAX_PAGES, 8);
    await crawlListUrl(base, pages, seenHref, listed);
    if (ki % 40 === 0) console.log(`  … keywords ${ki}/${SEARCH_KEYWORDS.length} listed=${listed.length}`);
  }

  const existing = dbHelper.read();
  const index = buildDbIndex(existing);
  const toResolve = prioritizeForResolve(listed, index);
  console.log(`\n🔎 Resolve SF cho ${toResolve.length}/${listed.length} mục (missing-first, x${RESOLVE_CONCURRENCY})...`);

  const found = new Map();
  let done = 0;
  let newResolved = 0;

  await mapPool(toResolve, RESOLVE_CONCURRENCY, async (item) => {
    const wasMissing = !item.isBrand && !isAlreadyInDb(item, index);
    try {
      const resolved = await resolvePlace(item);
      for (const r of resolved) {
        if (!r.shopeefoodSlug) continue;
        if (!found.has(r.shopeefoodSlug)) {
          found.set(r.shopeefoodSlug, r);
          if (wasMissing) newResolved += 1;
        }
      }
    } catch (e) {
      console.log(`  fail ${item.name}: ${e.message}`);
    }
    done += 1;
    if (done % 50 === 0 || done === toResolve.length) {
      console.log(`  progress ${done}/${toResolve.length} → unique ${found.size} (new-ish ${newResolved})`);
    }
    await sleep(120);
  });

  const discovered = [...found.values()];
  console.log(`\n✅ ${discovered.length} quán có slug ShopeeFood`);

  if (DRY_RUN) {
    discovered.slice(0, 30).forEach(d => console.log(' -', d.name, '|', d.shopeefoodSlug, '|', d.source));
    return;
  }

  const { added, updated, total } = mergeIntoDb(discovered);
  console.log(`\n════════ MERGE DB ════════`);
  console.log(`  listed:     ${listed.length}`);
  console.log(`  discovered: ${discovered.length}`);
  console.log(`  added:      ${added}`);
  console.log(`  updated:    ${updated}`);
  console.log(`  DB total:   ${total}`);
  console.log('══════════════════════════\n');
}

if (require.main === module) {
  main().catch(err => {
    console.error('FATAL', err);
    process.exit(1);
  });
}

module.exports = { main };
