#!/usr/bin/env node
/**
 * enrich_restaurant_phones.js
 * ─────────────────────────────────────────────────────────────
 * Quét danh sách quán trong DB, cào bổ sung số điện thoại (SĐT)
 * từ Foody / ShopeeFood detail page cho các quán chưa có SĐT thật.
 *
 * Chạy với 3 luồng (workers):
 *   node enrich_restaurant_phones.js [--threads=3] [--limit=50] [--force]
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const dbHelper = require('./dbHelper');
const foodyGps = require('./foodyGps');
const {
  isRealRestaurantPhone,
  normalizePhone,
  applyScrapedMetaToRestaurant
} = require('./restaurantMeta');

function argVal(name, fallback) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const THREADS = Math.max(1, parseInt(argVal('threads', '3'), 10) || 3);
const LIMIT = parseInt(argVal('limit', '0'), 10) || 0;
const FORCE = hasFlag('force');
const DRY_RUN = hasFlag('dry-run');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function enrichOne(restaurant) {
  const slug = foodyGps.resolveFoodySlugFromRestaurant(restaurant);
  if (!slug) return { ok: false, reason: 'no_slug' };

  try {
    const data = await foodyGps.fetchFoodyGpsBySlug(slug, { timeoutMs: 9000 });
    if (!data || !data.phone) return { ok: false, reason: 'phone_not_found' };

    const norm = normalizePhone(data.phone);
    if (!isRealRestaurantPhone(norm)) return { ok: false, reason: 'invalid_phone' };

    if (!DRY_RUN) {
      dbHelper.updateRestaurant({
        ...restaurant,
        phone: norm,
        phoneSource: 'foody',
        phoneUpdatedAt: new Date().toISOString()
      });
    }
    return { ok: true, phone: norm, slug };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function main() {
  console.log(`\n========================================`);
  console.log(`  ShipFee - Enrich Restaurant Phones (${THREADS} Threads)`);
  console.log(`========================================\n`);

  const all = dbHelper.read();
  let target = all.filter(r => {
    if (!r || !r.id) return false;
    if (r.permanentlyClosed === true) return false;
    if (FORCE) return true;
    return !isRealRestaurantPhone(r.phone, r.phoneSource);
  });

  console.log(`Tổng số quán trong DB: ${all.length}`);
  console.log(`Số quán thiếu SĐT cần enrich: ${target.length}`);

  if (LIMIT > 0) {
    target = target.slice(0, LIMIT);
    console.log(`Giới hạn xử lý: ${LIMIT} quán`);
  }

  if (target.length === 0) {
    console.log('✅ Tất cả quán đã có SĐT thật. Không cần enrich thêm.');
    return;
  }

  let enrichedCount = 0;
  let failedCount = 0;
  let index = 0;

  async function worker(workerId) {
    while (index < target.length) {
      const myIdx = index++;
      const r = target[myIdx];
      const tag = `[W${workerId}] [${myIdx + 1}/${target.length}]`;

      const res = await enrichOne(r);
      if (res.ok) {
        enrichedCount++;
        console.log(`${tag} ✅ "${r.name}" → SĐT: ${res.phone} (slug=${res.slug})`);
      } else {
        failedCount++;
        console.log(`${tag} ⚠️ "${r.name}": không lấy được SĐT (${res.reason})`);
      }
      await sleep(1000);
    }
  }

  const workers = Array.from({ length: THREADS }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  console.log(`\n========================================`);
  console.log(`  Hoàn thành! Đã enrich SĐT cho ${enrichedCount} quán. Thất bại: ${failedCount}`);
  console.log(`========================================\n`);
}

main().catch(err => {
  console.error('Fatal error in enrich_restaurant_phones:', err);
});
