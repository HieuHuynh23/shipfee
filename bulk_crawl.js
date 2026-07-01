/**
 * bulk_crawl.js — Triggers ShopeeFood menu crawling for all restaurants
 * without real menu data by calling the internal API in controlled batches.
 *
 * Usage: node bulk_crawl.js [--concurrency=2] [--start=0] [--limit=999]
 *
 * The script calls GET /api/restaurants/:id for each restaurant missing a real menu.
 * The server's scraping logic (menuScraper.scrapeMenu) runs automatically when
 * hasRealMenu is false. Results are saved to restaurants-local.json by the server.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const dbHelper = require('./server/dbHelper');

// ── Configuration ──────────────────────────────────────────────────────────────
const API_BASE = 'http://localhost:3001';
const CONCURRENCY = parseInt(process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1] || '2', 10);
const START_IDX   = parseInt(process.argv.find(a => a.startsWith('--start='))?.split('=')[1] || '0', 10);
const LIMIT       = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '9999', 10);
const TIMEOUT_MS  = 90_000; // 90s per restaurant (scraping can be slow)

// ── Colors ─────────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m', bold: '\x1b[1m',
};

function log(icon, msg, color = C.reset) {
  const ts = new Date().toLocaleTimeString('vi-VN');
  console.log(`${C.gray}[${ts}]${C.reset} ${icon} ${color}${msg}${C.reset}`);
}

// ── HTTP helper ────────────────────────────────────────────────────────────────
function get(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TIMEOUT')), TIMEOUT_MS);
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timer);
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    }).on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ── Load local restaurant list ─────────────────────────────────────────────────
function loadRestaurants() {
  try {
    const raw = dbHelper.read();
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    console.error(`❌ Lỗi khi đọc dữ liệu quán ăn:`, e.message);
    process.exit(1);
  }
}

// ── Concurrency pool ──────────────────────────────────────────────────────────
async function runWithConcurrency(tasks, concurrency) {
  const results = [];
  let index = 0;

  async function runNext() {
    while (index < tasks.length) {
      const taskIndex = index++;
      const result = await tasks[taskIndex]();
      results[taskIndex] = result;
    }
  }

  const workers = Array.from({ length: concurrency }, () => runNext());
  await Promise.all(workers);
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════════════════════╗`);
  console.log(`║  ShipFee — Bulk ShopeeFood Menu Crawler             ║`);
  console.log(`╚══════════════════════════════════════════════════════╝${C.reset}\n`);

  // Load restaurants
  const allRestaurants = loadRestaurants();
  const targets = allRestaurants
    .filter(r => r && r.id && r.hasRealMenu !== true && r.isClosed !== true)
    .slice(START_IDX, START_IDX + LIMIT);

  log('📊', `Tổng cộng: ${allRestaurants.length} quán | Cần crawl: ${targets.length} quán | Concurrency: ${CONCURRENCY}`, C.cyan);

  if (targets.length === 0) {
    log('✨', 'Tất cả quán ăn đã có menu thực tế!', C.green);
    return;
  }

  // Stats
  let success = 0, failed = 0, closed = 0, skipped = 0;
  const failedList = [];
  const startTime = Date.now();

  // Create crawl tasks
  const tasks = targets.map((restaurant, i) => async () => {
    const num = `[${START_IDX + i + 1}/${allRestaurants.filter(r => r && r.hasRealMenu !== true && r.isClosed !== true).length}]`;
    const label = `${num} ${restaurant.name}`;

    try {
      log('🔍', `Đang crawl: ${label}`, C.yellow);
      const result = await get(`${API_BASE}/api/restaurants/${encodeURIComponent(restaurant.id)}`);

      if (result.status === 200 && result.body && result.body.data) {
        const data = result.body.data;
        if (data.isClosed) {
          closed++;
          log('🔴', `ĐÓNG CỬA: ${restaurant.name} (${data.menu?.length || 0} món lưu lại)`, C.gray);
        } else if (data.hasRealMenu) {
          success++;
          log('✅', `Thành công: ${restaurant.name} — ${data.menu?.length || 0} món`, C.green);
        } else {
          skipped++;
          log('⚠️', `Không có menu thực: ${restaurant.name}`, C.yellow);
        }
      } else {
        failed++;
        failedList.push(restaurant.id);
        log('❌', `Lỗi HTTP ${result.status}: ${restaurant.name}`, C.red);
      }
    } catch (err) {
      failed++;
      failedList.push(restaurant.id);
      const errMsg = err.message === 'TIMEOUT' ? 'TIMEOUT (90s)' : err.message;
      log('❌', `Lỗi: ${restaurant.name} — ${errMsg}`, C.red);
    }
  });

  // Run all tasks with controlled concurrency
  await runWithConcurrency(tasks, CONCURRENCY);

  // Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════════════════════╗`);
  console.log(`║  KẾT QUẢ CRAWL SHOPEE FOOD                          ║`);
  console.log(`╚══════════════════════════════════════════════════════╝${C.reset}`);
  console.log(`  ✅ Thành công  : ${C.green}${success}${C.reset} quán`);
  console.log(`  🔴 Đóng cửa   : ${C.gray}${closed}${C.reset} quán`);
  console.log(`  ⚠️  Không menu : ${C.yellow}${skipped}${C.reset} quán`);
  console.log(`  ❌ Lỗi        : ${C.red}${failed}${C.reset} quán`);
  console.log(`  ⏱️  Thời gian  : ${elapsed}s`);

  // Re-count from file after all done
  try {
    const finalRests = dbHelper.read();
    const realCount = finalRests.filter(r => r.hasRealMenu).length;
    const closedCount = finalRests.filter(r => r.isClosed).length;
    const pending = finalRests.filter(r => !r.hasRealMenu && !r.isClosed).length;
    console.log(`\n  📦 Database hiện tại:`);
    console.log(`     Tổng       : ${finalRests.length} quán`);
    console.log(`     Có menu    : ${C.green}${realCount}${C.reset} quán`);
    console.log(`     Đóng cửa   : ${C.gray}${closedCount}${C.reset} quán`);
    console.log(`     Còn thiếu  : ${C.yellow}${pending}${C.reset} quán`);
  } catch (e) {}

  if (failedList.length > 0) {
    console.log(`\n  ❌ Danh sách quán lỗi:`);
    failedList.forEach(id => console.log(`     - ${id}`));
  }
  console.log('');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
