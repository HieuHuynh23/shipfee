/**
 * crawl_scheduler.js — Scheduled bulk ShopeeFood menu crawler daemon.
 *
 * Runs daily from 10:00 AM to 6:00 PM (18:00), processing restaurants lacking real menu data.
 * Outputs stats of successful, failed, closed and remaining restaurants on stopping or finishing.
 *
 * Usage:
 *   node crawl_scheduler.js [--concurrency=2] [--force]
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const dbHelper = require('./server/dbHelper');

// ── Configuration ──────────────────────────────────────────────────────────────
const API_BASE = 'http://localhost:3001';
const CONCURRENCY = parseInt(process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1] || '2', 10);
const FORCE = process.argv.includes('--force');
const TIMEOUT_MS = 120_000; // 120s timeout per restaurant scrape

const LOG_FILE = path.join(__dirname, 'server', 'crawl_scheduler.log');

const C = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m', bold: '\x1b[1m'
};

function writeLog(msg, color = C.reset) {
  const ts = new Date().toLocaleString('vi-VN');
  const rawLine = `[${ts}] ${msg}\n`;
  console.log(`${C.gray}[${new Date().toLocaleTimeString('vi-VN')}]${C.reset} ${color}${msg}${C.reset}`);
  try {
    fs.appendFileSync(LOG_FILE, rawLine, 'utf8');
  } catch (e) {
    console.error('Failed to write to crawl_scheduler.log:', e.message);
  }
}

// HTTP Helper
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

// State
let activeWorkers = 0;
let isCrawling = false;
let shouldStop = false;

let stats = {
  success: 0,
  failed: 0,
  closed: 0,
  skipped: 0,
  totalAttempted: 0,
  date: ''
};

function checkDateReset() {
  const todayStr = new Date().toLocaleDateString('vi-VN');
  if (stats.date !== todayStr) {
    stats = {
      success: 0,
      failed: 0,
      closed: 0,
      skipped: 0,
      totalAttempted: 0,
      date: todayStr
    };
  }
}

async function crawlBatch() {
  if (isCrawling) return;
  isCrawling = true;
  shouldStop = false;
  
  checkDateReset();
  
  writeLog(`▶️ BẮT ĐẦU TIẾN TRÌNH CÀO MENU SHOPEEFOOD (Khung giờ vàng 10h - 18h)`, C.cyan);
  
  const allRestaurants = dbHelper.read();
  const targets = allRestaurants.filter(r => r && r.id && r.hasRealMenu !== true && r.isClosed !== true);
  
  writeLog(`📊 Số lượng quán trong DB: ${allRestaurants.length} | Chưa có menu real: ${targets.length} quán`);
  
  if (targets.length === 0) {
    writeLog(`✨ Tất cả các quán ăn đã có dữ liệu thực tế! Hoàn tất cào dữ liệu.`);
    isCrawling = false;
    return;
  }

  let index = 0;
  
  // Worker loop
  async function worker() {
    activeWorkers++;
    while (index < targets.length && !shouldStop) {
      // Check time limit
      const now = new Date();
      const hour = now.getHours();
      if (!FORCE && (hour < 10 || hour >= 18)) {
        writeLog(`⏰ Ngoài khung giờ 10h - 18h. Yêu cầu dừng tiến trình cào dữ liệu...`, C.yellow);
        shouldStop = true;
        break;
      }
      
      const r = targets[index++];
      if (!r) continue;
      
      stats.totalAttempted++;
      const num = `[${stats.totalAttempted}/${targets.length}]`;
      
      try {
        writeLog(`🔍 ${num} Đang cào menu: ${r.name} (ID: ${r.id})...`);
        const result = await get(`${API_BASE}/api/restaurants/${encodeURIComponent(r.id)}`);
        
        if (result.status === 200 && result.body && result.body.data) {
          const data = result.body.data;
          if (data.isClosed) {
            stats.closed++;
            writeLog(`🔴 ĐÓNG CỬA: ${r.name}`, C.gray);
          } else if (data.hasRealMenu) {
            stats.success++;
            writeLog(`✅ THÀNH CÔNG: ${r.name} — ${data.dishNames?.length || 0} món`, C.green);
          } else {
            stats.skipped++;
            writeLog(`⚠️ KHÔNG CÓ MENU THỰC: ${r.name}`, C.yellow);
          }
        } else {
          stats.failed++;
          writeLog(`❌ LỖI API ${result.status}: ${r.name}`, C.red);
        }
      } catch (err) {
        stats.failed++;
        const errMsg = err.message === 'TIMEOUT' ? 'TIMEOUT (120s)' : err.message;
        writeLog(`❌ LỖI CÀO: ${r.name} — ${errMsg}`, C.red);
      }
    }
    activeWorkers--;
  }

  // Start concurrent workers
  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);
  
  isCrawling = false;
  printDailyReport();
}

function printDailyReport() {
  const finalRests = dbHelper.read();
  const remaining = finalRests.filter(r => r && r.hasRealMenu !== true && r.isClosed !== true).length;
  
  writeLog(`\n╔══════════════════════════════════════════════════════╗`, C.cyan);
  writeLog(`║  BÁO CÁO KẾT QUẢ CÀO HẰNG NGÀY                      ║`, C.cyan);
  writeLog(`╚══════════════════════════════════════════════════════╝`, C.cyan);
  writeLog(`  ✅ Thành công hôm nay : ${stats.success} quán`, C.green);
  writeLog(`  🔴 Quán đóng cửa      : ${stats.closed} quán`, C.gray);
  writeLog(`  ⚠️  Không có menu thực : ${stats.skipped} quán`, C.yellow);
  writeLog(`  ❌ Thất bại/Lỗi cào   : ${stats.failed} quán`);
  writeLog(`  📊 Tổng số đã thử     : ${stats.totalAttempted} quán`);
  writeLog(`  Remaining (Chưa cào)  : ${remaining} quán`, C.yellow);
  writeLog(`========================================================\n`, C.cyan);
}

// Tick loop running every 10 seconds to check schedule
function tick() {
  const now = new Date();
  const hour = now.getHours();
  
  const isInsideWindow = (hour >= 10 && hour < 18);
  
  if (FORCE || isInsideWindow) {
    if (!isCrawling) {
      crawlBatch().catch(err => {
        writeLog(`❌ Lỗi nghiêm trọng: ${err.message}`, C.red);
        isCrawling = false;
      });
    }
  } else {
    if (isCrawling) {
      writeLog(`⏰ Hết giờ cào dữ liệu (sau 18h). Đang tiến hành dừng và báo cáo...`, C.yellow);
      shouldStop = true;
    }
  }
}

// Startup info
writeLog(`🤖 Khởi động Trình Hẹn Giờ Cào Dữ Liệu Tự Động (ShopeeFood Menu Scheduler)`);
writeLog(`📅 Khung giờ làm việc: Hằng ngày từ 10:00 sáng đến 18:00 tối`);
writeLog(`⚙️  Thiết lập: Concurrency=${CONCURRENCY} | Chế độ ép buộc=${FORCE ? 'BẬT' : 'TẮT'}`);

const initialRests = dbHelper.read();
const missing = initialRests.filter(r => r && r.hasRealMenu !== true && r.isClosed !== true).length;
writeLog(`📊 Trạng thái Database hiện tại: ${initialRests.length} quán | Còn thiếu: ${missing} quán`);

// Run first check immediately
tick();

// Check every 10 seconds
setInterval(tick, 10_000);
