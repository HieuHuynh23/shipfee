#!/usr/bin/env node
/**
 * Quét Foody Cần Thơ (category + từ khóa rộng + gap-fill) → resolve ShopeeFood → MERGE DB.
 *
 * Ưu tiên resolve quán CHƯA có trong DB (tránh bỏ sót kiểu "Cơm Gà Kim - Nguyễn Văn Cừ"
 * khi detail-limit cắt danh sách dài).
 *
 *   node discover_foody_shopeefood.js
 *   node discover_foody_shopeefood.js --pages=15 --detail-limit=2000
 *   node discover_foody_shopeefood.js --gap-fill
 *   node discover_foody_shopeefood.js --dry-run
 */
'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const dbHelper = require('./dbHelper');
const { rewriteSlug } = require('./slugMap');
const { resolveBrandBranches, resolveShopeefoodSlugFromFoody } = require('./brandResolver');

const DRY_RUN = process.argv.includes('--dry-run');
const GAP_FILL = process.argv.includes('--gap-fill') || !process.argv.includes('--no-gap-fill');
const pagesArg = process.argv.find(a => a.startsWith('--pages='));
const detailArg = process.argv.find(a => a.startsWith('--detail-limit='));
const MAX_PAGES = Math.max(1, parseInt(pagesArg ? pagesArg.split('=')[1] : '15', 10) || 15);
const DETAIL_LIMIT = Math.max(1, parseInt(detailArg ? detailArg.split('=')[1] : '2000', 10) || 2000);

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
  'https://www.foody.vn/can-tho/nha-hang',
  'https://www.foody.vn/can-tho/cafe',
  'https://www.foody.vn/can-tho/quan-an',
  'https://www.foody.vn/can-tho/an-vat',
  'https://www.foody.vn/can-tho/an-vat/dia-diem'
];

/** Từ khóa rộng + cụm 2 từ để bắt quán đặt tên theo món (vd: cơm gà kim). */
const SEARCH_KEYWORDS = [
  // món phổ biến
  'cơm', 'bún', 'phở', 'trà sữa', 'gà', 'lẩu', 'bánh mì', 'pizza', 'hải sản', 'cà phê',
  'chè', 'xôi', 'hủ tiếu', 'mì', 'ốc', 'chay', 'kem', 'sushi', 'burger', 'nướng',
  'bánh cuốn', 'bánh xèo', 'gỏi', 'nem', 'bò', 'cá', 'dimsum', 'hotpot', 'tokbokki',
  'bún đậu', 'bún bò', 'bún riêu', 'bún thịt nướng', 'hủ tiếu', 'mì cay', 'gỏi cuốn',
  'cơm gà', 'cơm tấm', 'cơm chiên', 'cơm văn phòng', 'gà rán', 'gà nướng', 'bò né',
  'nem nướng', 'bánh canh', 'cháo', 'sinh tố', 'nước ép', 'bánh ngọt', 'đồ ăn vặt',
  'ăn vặt', 'xiên que', 'lẩu nướng', 'buffet', 'dimsum', 'hotpot',
  // chuỗi / thương hiệu
  'highlands', 'kfc', 'jollibee', 'lotteria', 'phúc long', 'tocotoco', 'highland',
  'five star', 'ong vàng', 'milano', 'passio', 'starbucks', 'the coffee house',
  // cụm hay bị sót (tên quán = món + tên riêng)
  'cơm gà kim', 'cơm gà xối mỡ', 'cơm gà rút xương', 'bún đậu mắm tôm',
  'trà sữa nhà làm', 'chè khúc bạch', 'bánh tráng trộn', 'bánh ướt', 'bánh hỏi',
  'hủ tiếu nam vang', 'phở bò', 'mì quảng', 'bánh canh cua', 'lẩu thái',
  'cơm niêu', 'cơm sườn', 'bún mắm', 'bún cá', 'chả cá', 'gà ủ muối'
];

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

async function fetchHtml(url) {
  const res = await axios.get(url, { headers: HEADERS, timeout: 15000, validateStatus: () => true });
  if (res.status !== 200) return null;
  return res.data;
}

function parseListHtml(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('.row-item, .ldc-item').each((_, el) => {
    const nameEl = $(el).find('h2 a, .ldc-item-h-name h2 a, .row-item-title a').first();
    let name = nameEl.text().trim();
    const href = nameEl.attr('href') || $(el).find('a[href*="/can-tho/"], a[href*="/thuong-hieu/"]').first().attr('href') || '';
    if (!name || name === '...') {
      name = ($(el).find('img[alt]').attr('alt') || '').replace(/&amp;/g, '&').trim();
    }
    if (!name || !href || href.includes('{{')) return;

    let address = $(el).find('.address, .row-item-address, .ldc-item-h-address span').first().text().trim().replace(/\s+/g, ' ');
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
        if (emptyStreak >= 2) break;
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
      console.log(`  ${url.replace('https://www.foody.vn', '')}: +${added} (listed ${listed.length})`);
      if (added === 0) {
        emptyStreak += 1;
        if (emptyStreak >= 2) break;
      } else emptyStreak = 0;
    } catch (e) {
      console.log(`  fail ${url}: ${e.message}`);
      emptyStreak += 1;
      if (emptyStreak >= 2) break;
    }
    await sleep(300);
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
    // id dạng r_ct_<slug>
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
  // khớp gần: tên Foody chứa trong DB hoặc ngược lại (chi nhánh)
  if (nk && nk.length >= 8) {
    for (const n of index.byName) {
      if (n.includes(nk) || nk.includes(n)) {
        // tránh match quá rộng với tên ngắn
        if (Math.min(n.length, nk.length) >= 10) return true;
      }
    }
  }
  return false;
}

/** Ưu tiên quán chưa có trong DB (gap-fill), rồi brand, rồi còn lại. */
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
    `  gap-fill queue: missing=${missing.length} brands=${brands.length} known=${known.length} (limit=${DETAIL_LIMIT})`
  );
  return [...missing, ...brands, ...known].slice(0, DETAIL_LIMIT);
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
  console.log('║  ShipFee — Foody gap-fill → ShopeeFood (MERGE)          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`pages/seed=${MAX_PAGES} detail-limit=${DETAIL_LIMIT} gap-fill=${GAP_FILL} dry-run=${DRY_RUN}`);

  const listed = [];
  const seenHref = new Set();

  console.log('\n📍 List seeds + phân trang...');
  for (const seed of LIST_SEEDS) {
    await crawlListUrl(seed, MAX_PAGES, seenHref, listed);
  }

  console.log(`\n📍 Search ${SEARCH_KEYWORDS.length} từ khóa (ưu tiên Delivery)...`);
  for (const kw of SEARCH_KEYWORDS) {
    const base = `https://www.foody.vn/can-tho/dia-diem?q=${encodeURIComponent(kw)}&ds=Delivery`;
    await crawlListUrl(base, Math.min(MAX_PAGES, 8), seenHref, listed);
  }

  const existing = dbHelper.read();
  const index = buildDbIndex(existing);
  const toResolve = prioritizeForResolve(listed, index);
  console.log(`\n🔎 Resolve SF cho ${toResolve.length}/${listed.length} mục (missing-first)...`);

  const found = new Map();
  let newResolved = 0;
  for (let i = 0; i < toResolve.length; i++) {
    const item = toResolve[i];
    const wasMissing = !item.isBrand && !isAlreadyInDb(item, index);
    try {
      const resolved = await resolvePlace(item);
      for (const r of resolved) {
        if (r.shopeefoodSlug) {
          if (!found.has(r.shopeefoodSlug)) {
            found.set(r.shopeefoodSlug, r);
            if (wasMissing) newResolved += 1;
          }
        }
      }
    } catch (e) {
      console.log(`  fail ${item.name}: ${e.message}`);
    }
    if ((i + 1) % 25 === 0 || i === toResolve.length - 1) {
      console.log(`  progress ${i + 1}/${toResolve.length} → unique ${found.size} (new-ish ${newResolved})`);
    }
    await sleep(180);
  }

  const discovered = [...found.values()];
  console.log(`\n✅ ${discovered.length} quán có slug ShopeeFood`);

  if (DRY_RUN) {
    discovered.slice(0, 25).forEach(d => console.log(' -', d.name, '|', d.shopeefoodSlug, '|', d.source));
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
