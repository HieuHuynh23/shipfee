/**
 * crawl_scheduler.js — Scheduled bulk ShopeeFood menu crawler daemon.
 *
 * Daily tasks (10:00 AM to 6:00 PM):
 *   Phase 1: Crawl real menus for active restaurants lacking menu data
 *   Phase 2: Re-check temporarily closed restaurants to see if they've reopened
 *
 * Usage:
 *   node crawl_scheduler.js [--concurrency=2] [--force] [--check-closed]
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const dbHelper = require('./server/dbHelper');
const os = require('os');

function getRamUsage() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return used / total;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Configuration ──────────────────────────────────────────────────────────────
const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const CONCURRENCY = parseInt(process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1] || '2', 10);
const FORCE = process.argv.includes('--force');
const CHECK_CLOSED_ONLY = process.argv.includes('--check-closed');
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
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
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
let currentPhase = ''; // 'menu' or 'closed-check'

let stats = {
  success: 0,
  failed: 0,
  closed: 0,
  skipped: 0,
  totalAttempted: 0,
  reopened: 0,       // Quán tạm đóng nhưng đã mở lại
  stillClosed: 0,    // Quán vẫn đóng cửa
  date: ''
};

function checkDateReset() {
  const todayStr = new Date().toLocaleDateString('vi-VN');
  if (stats.date !== todayStr) {
    stats = {
      success: 0, failed: 0, closed: 0, skipped: 0,
      totalAttempted: 0, reopened: 0, stillClosed: 0,
      date: todayStr
    };
  }
}

// ── Phase 1: Crawl menus for active restaurants ──────────────────────────────
async function crawlMenuBatch() {
  currentPhase = 'menu';
  
  const allRestaurants = dbHelper.read();
  const targets = allRestaurants.filter(r => r && r.id && r.hasRealMenu !== true && r.isClosed !== true);
  
  writeLog(`📊 [Phase 1: Menu] DB: ${allRestaurants.length} quán | Chưa có menu real: ${targets.length} quán`);
  
  if (targets.length === 0) {
    writeLog(`✨ [Phase 1] Tất cả quán đang mở đã có menu thực tế!`, C.green);
    return;
  }

  let index = 0;
  
  async function worker() {
    activeWorkers++;
    while (index < targets.length && !shouldStop) {
      const now = new Date();
      const hour = now.getHours();
      if (!FORCE && (hour < 10 || hour >= 18)) {
        writeLog(`⏰ Ngoài khung giờ 10h - 18h. Dừng Phase 1...`, C.yellow);
        shouldStop = true;
        break;
      }
      
      const r = targets[index++];
      if (!r) continue;

      // RAM Guard: Tự động tạm dừng nếu RAM hệ thống vượt quá 80%
      while (getRamUsage() > 0.8 && !shouldStop) {
        const pct = Math.round(getRamUsage() * 100);
        writeLog(`⚠️ [RAM Guard] Bộ nhớ RAM hệ thống quá tải (${pct}% > 80%)! Tạm dừng cào 5 giây để hạ nhiệt...`, C.yellow);
        await sleep(5000);
      }
      
      stats.totalAttempted++;
      const num = `[${stats.totalAttempted}/${targets.length}]`;
      
      try {
        writeLog(`🔍 ${num} Đang cào menu: ${r.name} (ID: ${r.id})...`);
        const result = await get(`${API_BASE}/api/restaurants/${encodeURIComponent(r.id)}?syncScrape=true`);
        
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

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);
}

// ── Phase 2: Re-check closed restaurants ─────────────────────────────────────
async function checkClosedBatch() {
  currentPhase = 'closed-check';
  
  const allRestaurants = dbHelper.read();
  // Lấy quán tạm đóng (không phải đóng vĩnh viễn)
  const closedTargets = allRestaurants.filter(r => {
    if (!r || !r.id || !r.isClosed) return false;
    // Bỏ qua quán đã đánh dấu đóng vĩnh viễn
    if (r.closedReason && (r.closedReason.includes('permanently') || r.closedReason.includes('vĩnh viễn'))) return false;
    return true;
  });
  
  writeLog(`📊 [Phase 2: Kiểm tra quán đóng] Tìm thấy ${closedTargets.length} quán tạm đóng cần kiểm tra`, C.cyan);
  
  if (closedTargets.length === 0) {
    writeLog(`✨ [Phase 2] Không có quán tạm đóng cần kiểm tra!`, C.green);
    return;
  }

  // Giới hạn kiểm tra 50 quán/ngày để không quá tải
  // Giới hạn kiểm tra quán đóng cửa (mặc định nâng lên 1000 quán để khớp đầy đủ nhanh hơn)
  const limitArg = process.argv.find(a => a.startsWith('--check-limit='));
  const DAILY_CHECK_LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 1000;
  const todayTargets = closedTargets.slice(0, DAILY_CHECK_LIMIT);
  writeLog(`🔄 Kiểm tra ${todayTargets.length}/${closedTargets.length} quán tạm đóng hôm nay (giới hạn ${DAILY_CHECK_LIMIT}/ngày)`);

  let checkIndex = 0;
  
  async function checkWorker() {
    activeWorkers++;
    while (checkIndex < todayTargets.length && !shouldStop) {
      const now = new Date();
      const hour = now.getHours();
      if (!FORCE && (hour < 10 || hour >= 18)) {
        shouldStop = true;
        break;
      }
      
      const r = todayTargets[checkIndex++];
      if (!r) continue;

      // RAM Guard: Tự động tạm dừng nếu RAM hệ thống vượt quá 80%
      while (getRamUsage() > 0.8 && !shouldStop) {
        const pct = Math.round(getRamUsage() * 100);
        writeLog(`⚠️ [RAM Guard] Bộ nhớ RAM hệ thống quá tải (${pct}% > 80%)! Tạm dừng cào 5 giây để hạ nhiệt...`, C.yellow);
        await sleep(5000);
      }
      
      try {
        writeLog(`🔍 [Closed Check ${checkIndex}/${todayTargets.length}] Kiểm tra: ${r.name}...`);
        const result = await get(`${API_BASE}/api/restaurants/${encodeURIComponent(r.id)}?syncScrape=true`);
        
        if (result.status === 200 && result.body && result.body.data) {
          const data = result.body.data;
          if (!data.isClosed && data.hasRealMenu) {
            stats.reopened++;
            writeLog(`🟢 ĐÃ MỞ LẠI: ${r.name} — có ${data.menu?.length || 0} món thực tế`, C.green);
          } else if (!data.isClosed) {
            stats.reopened++;
            writeLog(`🟡 ĐÃ MỞ LẠI (chưa có menu): ${r.name}`, C.yellow);
          } else {
            stats.stillClosed++;
            writeLog(`⬛ VẪN ĐÓNG: ${r.name}`, C.gray);
          }
        } else {
          stats.stillClosed++;
          writeLog(`⬛ KHÔNG THỂ KIỂM TRA: ${r.name} (status: ${result.status})`, C.gray);
        }
      } catch (err) {
        stats.stillClosed++;
        writeLog(`⬛ LỖI KIỂM TRA: ${r.name} — ${err.message}`, C.gray);
      }
      
      // Delay 3s giữa mỗi lần kiểm tra để tránh quá tải
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    activeWorkers--;
  }

  // Chạy song song nhiều worker theo CONCURRENCY để kiểm tra nhanh hơn và khớp đầy đủ hơn
  const workers = Array.from({ length: CONCURRENCY }, () => checkWorker());
  await Promise.all(workers);
}

// ── Phase 3: Sync & Price Check for existing menus ──────────────────────────
async function syncMenuBatch() {
  currentPhase = 'sync-check';
  
  const allRestaurants = dbHelper.read();
  // Lọc ra các quán đã có thực đơn thật và đang mở cửa
  const activeTargets = allRestaurants.filter(r => r && r.id && r.hasRealMenu === true && r.isClosed !== true);
  
  writeLog(`📊 [Phase 3: Đồng bộ giá] Tìm thấy ${activeTargets.length} quán đang hoạt động cần đối chiếu`, C.cyan);
  
  if (activeTargets.length === 0) {
    writeLog(`✨ [Phase 3] Không có quán hoạt động nào cần đối chiếu!`, C.green);
    return;
  }

  // Cấu hình giới hạn đồng bộ mỗi ngày (tránh rate limit)
  const syncLimitArg = process.argv.find(a => a.startsWith('--sync-limit='));
  const DAILY_SYNC_LIMIT = syncLimitArg ? parseInt(syncLimitArg.split('=')[1], 10) : 150;
  
  // Sắp xếp các quán theo thời gian menuUpdatedAt cũ nhất, hoặc chọn ngẫu nhiên để xoay vòng
  const sortedTargets = activeTargets.sort((a, b) => {
    const timeA = a.menuUpdatedAt ? new Date(a.menuUpdatedAt).getTime() : 0;
    const timeB = b.menuUpdatedAt ? new Date(b.menuUpdatedAt).getTime() : 0;
    return timeA - timeB;
  });

  const todayTargets = sortedTargets.slice(0, DAILY_SYNC_LIMIT);
  writeLog(`🔄 Đồng bộ & Đối chiếu ${todayTargets.length}/${activeTargets.length} quán hôm nay (giới hạn ${DAILY_SYNC_LIMIT}/ngày)`);

  let syncIndex = 0;
  
  async function syncWorker() {
    activeWorkers++;
    while (syncIndex < todayTargets.length && !shouldStop) {
      const now = new Date();
      const hour = now.getHours();
      if (!FORCE && (hour < 10 || hour >= 18)) {
        shouldStop = true;
        break;
      }
      
      const r = todayTargets[syncIndex++];
      if (!r) continue;

      // RAM Guard: Tạm dừng nếu RAM > 80%
      while (getRamUsage() > 0.8 && !shouldStop) {
        const pct = Math.round(getRamUsage() * 100);
        writeLog(`⚠️ [RAM Guard] Bộ nhớ RAM hệ thống quá tải (${pct}% > 80%)! Tạm dừng cào 5 giây để hạ nhiệt...`, C.yellow);
        await sleep(5000);
      }
      
      try {
        writeLog(`🔍 [Sync Check ${syncIndex}/${todayTargets.length}] Đối chiếu giá: ${r.name}...`);
        // Gửi tham số forceSync=true để server cào mới thay vì dùng cache
        const result = await get(`${API_BASE}/api/restaurants/${encodeURIComponent(r.id)}?syncScrape=true&forceSync=true`);
        
        if (result.status === 200 && result.body && result.body.data) {
          const data = result.body.data;
          if (data.isClosed) {
            writeLog(`🔴 PHÁT HIỆN ĐÓNG CỬA TRÊN SHOPEE: ${r.name}`, C.gray);
          } else {
            writeLog(`✅ ĐỒNG BỘ THÀNH CÔNG: ${r.name}`, C.green);
          }
        } else {
          writeLog(`⬛ LỖI ĐỒNG BỘ: ${r.name} (status: ${result.status})`, C.gray);
        }
      } catch (err) {
        writeLog(`⬛ LỖI ĐỒNG BỘ: ${r.name} — ${err.message}`, C.gray);
      }
      
      // Delay 5s giữa mỗi lần đồng bộ để tránh rate limit ShopeeFood
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    activeWorkers--;
  }

  const workers = Array.from({ length: CONCURRENCY }, () => syncWorker());
  await Promise.all(workers);
}

// ── Main crawl batch ─────────────────────────────────────────────────────────
async function crawlBatch() {
  if (isCrawling) return;
  isCrawling = true;
  shouldStop = false;
  
  checkDateReset();
  
  writeLog(`\n▶️ BẮT ĐẦU TIẾN TRÌNH CÀO & KIỂM TRA (Khung giờ 10h - 18h)`, C.cyan);
  
  if (!CHECK_CLOSED_ONLY) {
    // Phase 1: Cào menu cho quán chưa có
    await crawlMenuBatch();
  }
  
  // Phase 2: Kiểm tra quán tạm đóng cửa (chạy sau Phase 1 hoặc khi dùng --check-closed)
  if (!shouldStop) {
    await checkClosedBatch();
  }
  
  // Phase 3: Đồng bộ & Đối chiếu giá thực đơn (Sync & Price Check)
  if (!shouldStop && !CHECK_CLOSED_ONLY) {
    await syncMenuBatch();
  }
  
  // Chạy xác thực và dọn dẹp file menu mồ côi dư thừa ngay khi hoàn tất lượt cào
  runDataIntegrityAudit();

  isCrawling = false;
  printDailyReport();
}

function runDataIntegrityAudit() {
  writeLog('🔍 [Audit] Bắt đầu tự động xác thực và dọn dẹp file menu mồ côi...', C.cyan);
  try {
    const allRestaurants = dbHelper.read();
    const MENUS_DIR = path.join(__dirname, 'server', 'menus');
    if (!fs.existsSync(MENUS_DIR)) return;

    const menuFiles = fs.readdirSync(MENUS_DIR).filter(f => f.endsWith('.json'));
    const restaurantMap = new Map();
    allRestaurants.forEach(r => {
      if (r && r.id) {
        const safeId = String(r.id).replace(/[^a-zA-Z0-9_-]/g, '_');
        restaurantMap.set(safeId, r);
      }
    });

    let deletedOrphans = 0;
    menuFiles.forEach(file => {
      const safeId = file.replace('.json', '');
      if (!restaurantMap.has(safeId)) {
        try {
          fs.unlinkSync(path.join(MENUS_DIR, file));
          deletedOrphans++;
        } catch (e) {}
      }
    });
    if (deletedOrphans > 0) {
      writeLog(`🧹 [Audit] Đã tự động dọn sạch ${deletedOrphans} file menu mồ côi dư thừa khỏi đĩa.`, C.green);
    } else {
      writeLog(`✨ [Audit] Không phát hiện file menu dư thừa. Hệ thống sạch sẽ!`, C.green);
    }
  } catch (err) {
    writeLog(`❌ [Audit] Lỗi khi chạy xác thực toàn vẹn: ${err.message}`, C.red);
  }
}

function printDailyReport() {
  const finalRests = dbHelper.read();
  const remaining = finalRests.filter(r => r && r.hasRealMenu !== true && r.isClosed !== true).length;
  const totalClosed = finalRests.filter(r => r && r.isClosed).length;
  const totalActive = finalRests.length - totalClosed;
  
  writeLog(`\n╔══════════════════════════════════════════════════════╗`, C.cyan);
  writeLog(`║  BÁO CÁO KẾT QUẢ CÀO & KIỂM TRA HẰNG NGÀY         ║`, C.cyan);
  writeLog(`╚══════════════════════════════════════════════════════╝`, C.cyan);
  writeLog(`  📊 Tổng quán trong DB  : ${finalRests.length} quán`);
  writeLog(`  🟢 Quán đang hoạt động : ${totalActive} quán`, C.green);
  writeLog(`  🔴 Quán đóng cửa       : ${totalClosed} quán`, C.gray);
  writeLog(`  ────────────────────────────────────────────`);
  writeLog(`  ✅ Menu cào thành công  : ${stats.success} quán`, C.green);
  writeLog(`  🔴 Phát hiện đóng cửa  : ${stats.closed} quán`, C.gray);
  writeLog(`  ⚠️  Không có menu thực  : ${stats.skipped} quán`, C.yellow);
  writeLog(`  ❌ Thất bại/Lỗi cào    : ${stats.failed} quán`);
  writeLog(`  ────────────────────────────────────────────`);
  writeLog(`  🟢 Quán mở lại (reopen): ${stats.reopened} quán`, C.green);
  writeLog(`  ⬛ Vẫn đóng cửa        : ${stats.stillClosed} quán`, C.gray);
  writeLog(`  ────────────────────────────────────────────`);
  writeLog(`  📊 Tổng số đã thử      : ${stats.totalAttempted} quán`);
  writeLog(`  Remaining (Chưa cào)   : ${remaining} quán`, C.yellow);
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
writeLog(`🤖 Khởi động Trình Hẹn Giờ Cào Dữ Liệu & Kiểm Tra Tự Động`);
writeLog(`📅 Khung giờ làm việc: Hằng ngày từ 10:00 sáng đến 18:00 tối`);
writeLog(`⚙️  Thiết lập: Concurrency=${CONCURRENCY} | Force=${FORCE ? 'BẬT' : 'TẮT'} | CheckClosedOnly=${CHECK_CLOSED_ONLY ? 'BẬT' : 'TẮT'}`);

const initialRests = dbHelper.read();
const missingMenu = initialRests.filter(r => r && r.hasRealMenu !== true && r.isClosed !== true).length;
const closedCount = initialRests.filter(r => r && r.isClosed).length;
writeLog(`📊 Database: ${initialRests.length} quán | Thiếu menu: ${missingMenu} | Đóng cửa: ${closedCount}`);

// Run first check immediately
tick();

// Check every 10 seconds
setInterval(tick, 10_000);
