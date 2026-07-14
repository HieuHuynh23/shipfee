/**
 * 🚀 LOCAL BULK CRAWLER — Cào Menu 3 Luồng Song Song
 * 
 * Chạy trực tiếp trên máy local để đối chiếu và cào menu ShopeeFood
 * cho tất cả quán ăn chưa có menu thật trong database.
 * 
 * Cách chạy:
 *   node local_bulk_crawler.js
 *   node local_bulk_crawler.js --threads=3
 *   node local_bulk_crawler.js --threads=5
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

// ── CONFIG ──────────────────────────────────────────────
const THREADS = parseInt(process.argv.find(a => a.startsWith('--threads='))?.split('=')[1] || '3');
const DELAY_BETWEEN_MS = 2000; // Delay giữa các quán trong cùng 1 luồng
const MARKUP_RATE = 0.28;

// ── DATABASE HELPERS ────────────────────────────────────
const dbHelper = require('./dbHelper');
const menuScraper = require('./menuScraper');

const MENUS_DIR = path.join(__dirname, 'menus');
if (!fs.existsSync(MENUS_DIR)) fs.mkdirSync(MENUS_DIR, { recursive: true });

// ── SUPABASE CLIENT ─────────────────────────────────────
let supabase = null;
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    console.log('[Supabase] ✅ Client khởi tạo thành công.');
  } else {
    console.log('[Supabase] ⚠️ Không tìm thấy biến môi trường. Sẽ chỉ lưu local.');
  }
} catch (e) {
  console.log('[Supabase] ⚠️ Không thể tải .env:', e.message);
}

// ── SLUG RESOLVER ───────────────────────────────────────
async function getShopeeFoodSlugFromFoody(foodySlug) {
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
          'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8',
        },
        timeout: 8000
      });
      if (res.status === 200) {
        const $ = cheerio.load(res.data);
        let shopeefoodUrl = '';
        $('a').each((i, el) => {
          const href = $(el).attr('href') || '';
          if (href.includes('shopeefood.vn/can-tho/') && !href.includes('/can-tho/fresh') && !href.includes('/can-tho/food')) {
            shopeefoodUrl = href;
          }
        });
        if (shopeefoodUrl) {
          const parts = shopeefoodUrl.split('?')[0].split('/');
          const resolvedSlug = parts.pop() || parts.pop();
          if (resolvedSlug) return resolvedSlug;
        }
      }
    } catch (err) { /* bỏ qua */ }
  }
  return foodySlug;
}

// ── SLUG REWRITER MAP ───────────────────────────────────
const SLUG_REWRITER_MAP = {
  'he-thong-lumos-coffee-cake': 'lumos-bakery-joy-banh-au-tra',
  'he-thong-lau-bang-chuyen-kichi-kichi': 'kichi-kichi-lotte-mart-can-tho',
  'he-thong-quan-itada-am-thuc-han-quoc': 'itada-mi-cay-han-quoc-duong-3-thang-2',
  'jollibee-can-tho': 'ga-ran-va-mi-y-jollibee-duong-30-thang-4',
  'highlands-coffee-can-tho': 'highlands-coffee-go-can-tho',
  'kfc-can-tho': 'ga-ran-kfc-lotte-mart-can-tho',
  'lotteria-can-tho': 'ga-ran-burger-lotteria-can-tho-nguyen-van-cu',
};

// ── HELPERS ─────────────────────────────────────────────
function round100(n) { return Math.round(n / 100) * 100; }

function getMenuFilePath(id) {
  return path.join(MENUS_DIR, `${id}.json`);
}

function writeMenu(id, menu) {
  fs.writeFileSync(getMenuFilePath(id), JSON.stringify(menu, null, 2), 'utf8');
}

function readMenu(id) {
  const fp = getMenuFilePath(id);
  if (!fs.existsSync(fp)) return [];
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return []; }
}

// ── SUPABASE SYNC ───────────────────────────────────────
async function syncToSupabase(restaurant) {
  if (!supabase) return;
  try {
    const menu = readMenu(restaurant.id);
    const { error } = await supabase.from('restaurants').upsert({
      id: restaurant.id,
      name: restaurant.name,
      address: restaurant.address || '',
      lat: restaurant.lat,
      lon: restaurant.lon,
      rating: restaurant.rating || 4.5,
      image_url: restaurant.image_url || '',
      is_closed: restaurant.isClosed || false,
      closed_reason: restaurant.closedReason || '',
      has_real_menu: restaurant.hasRealMenu || false,
      dish_names: restaurant.dishNames || [],
      menu: menu,
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' });
    if (error) {
      console.error(`  [Supabase] ❌ Lỗi sync ${restaurant.id}:`, error.message);
    }
  } catch (err) {
    console.error(`  [Supabase] ❌ Lỗi bất ngờ sync ${restaurant.id}:`, err.message);
  }
}

// ── DB WRITE LOCK (tránh tranh chấp ghi file giữa các luồng) ──
let dbWriteQueue = Promise.resolve();
function safeUpdateDB(updaterFn) {
  return new Promise((resolve, reject) => {
    dbWriteQueue = dbWriteQueue.then(() => {
      try {
        const data = dbHelper.read();
        if (Array.isArray(data)) {
          const shouldSave = updaterFn(data);
          if (shouldSave !== false) {
            dbHelper.write(data);
          }
        }
        resolve();
      } catch (err) {
        console.error('[DB] Lỗi ghi:', err.message);
        reject(err);
      }
    });
  });
}

// ── CORE: Xử lý 1 quán ────────────────────────────────
async function processOneRestaurant(target, threadId) {
  const prefix = `[T${threadId}]`;
  
  let slug = target.shopeefoodSlug || target.id.replace('r_ct_', '').split('?')[0].replace(/_/g, '-');
  
  // Bước 1: Phân giải slug thực tế nếu chưa có
  if (!target.shopeefoodSlug) {
    try {
      slug = await getShopeeFoodSlugFromFoody(slug);
    } catch (e) { /* giữ nguyên slug */ }
  }
  
  // Áp dụng slug rewriter
  if (SLUG_REWRITER_MAP[slug]) {
    slug = SLUG_REWRITER_MAP[slug];
  }
  
  // Bước 2: Cào menu từ ShopeeFood
  console.log(`${prefix} ⚡ Cào: "${target.name}" (slug: ${slug})...`);
  
  let realMenu;
  try {
    realMenu = await menuScraper.scrapeMenu(slug);
  } catch (err) {
    console.error(`${prefix} ❌ Lỗi cào "${target.name}": ${err.message}`);
    // Đánh dấu đã kiểm tra để không lặp lại ngay
    await safeUpdateDB(data => {
      const idx = data.findIndex(r => String(r.id) === String(target.id));
      if (idx !== -1) {
        data[idx].menuUpdatedAt = new Date().toISOString();
        return true;
      }
      return false;
    });
    return { status: 'error', name: target.name };
  }
  
  // Bước 3: Phân tích kết quả
  let isClosed = false;
  let closedReason = '';
  let menu = null;
  
  if (realMenu && realMenu.closed === true) {
    isClosed = true;
    closedReason = realMenu.reason || 'Quán hiện đang đóng cửa.';
    if (Array.isArray(realMenu.menu) && realMenu.menu.length > 0) {
      menu = realMenu.menu;
    }
  } else if (Array.isArray(realMenu) && realMenu.length > 0) {
    menu = realMenu;
  }
  
  // Bước 4: Lưu kết quả vào DB local
  if (isClosed) {
    // Quán đóng cửa
    if (menu && menu.length > 0) {
      writeMenu(target.id, menu);
      console.log(`${prefix} 🔒 Đóng cửa nhưng có ${menu.length} món: "${target.name}"`);
    } else {
      console.log(`${prefix} 🔴 Đóng cửa không có menu: "${target.name}"`);
    }
    
    await safeUpdateDB(data => {
      const idx = data.findIndex(r => String(r.id) === String(target.id));
      if (idx !== -1) {
        data[idx].isClosed = true;
        data[idx].closedAt = new Date().toISOString();
        data[idx].closedReason = closedReason;
        data[idx].menuUpdatedAt = new Date().toISOString();
        if (menu && menu.length > 0) {
          data[idx].hasRealMenu = true;
          data[idx].dishNames = menu.map(m => m.name).filter(Boolean);
          delete data[idx].menuTemplateFallback;
        }
        delete data[idx].menu;
        return true;
      }
      return false;
    });
    
    // Sync lên Supabase
    const updated = dbHelper.read().find(r => String(r.id) === String(target.id));
    if (updated) await syncToSupabase(updated);
    
    return { status: 'closed', name: target.name, menuCount: menu ? menu.length : 0 };
    
  } else if (menu && menu.length > 0) {
    // Quán mở cửa, có menu thật
    writeMenu(target.id, menu);
    console.log(`${prefix} ✅ ${menu.length} món: "${target.name}"`);
    
    await safeUpdateDB(data => {
      const idx = data.findIndex(r => String(r.id) === String(target.id));
      if (idx !== -1) {
        data[idx].hasRealMenu = true;
        data[idx].menuUpdatedAt = new Date().toISOString();
        data[idx].dishNames = menu.map(m => m.name).filter(Boolean);
        delete data[idx].menuTemplateFallback;
        delete data[idx].menu;
        if (data[idx].isClosed) {
          data[idx].isClosed = false;
          delete data[idx].closedAt;
          delete data[idx].closedReason;
        }
        return true;
      }
      return false;
    });
    
    // Sync lên Supabase
    const updated = dbHelper.read().find(r => String(r.id) === String(target.id));
    if (updated) await syncToSupabase(updated);
    
    return { status: 'success', name: target.name, menuCount: menu.length };
    
  } else {
    // Không có menu (quán không tồn tại trên ShopeeFood hoặc lỗi)
    console.log(`${prefix} ⚠️ Không có menu: "${target.name}"`);
    
    await safeUpdateDB(data => {
      const idx = data.findIndex(r => String(r.id) === String(target.id));
      if (idx !== -1) {
        data[idx].menuUpdatedAt = new Date().toISOString();
        data[idx].isClosed = true;
        data[idx].closedAt = new Date().toISOString();
        data[idx].closedReason = 'Quán không tồn tại hoặc không hoạt động trên ShopeeFood.';
        delete data[idx].menu;
        return true;
      }
      return false;
    });
    
    return { status: 'not_found', name: target.name };
  }
}

// ── WORKER THREAD ───────────────────────────────────────
async function workerThread(threadId, candidates) {
  console.log(`\n[Thread ${threadId}] 🚀 Bắt đầu xử lý ${candidates.length} quán ăn...`);
  
  const stats = { success: 0, closed: 0, not_found: 0, error: 0 };
  
  for (let i = 0; i < candidates.length; i++) {
    const target = candidates[i];
    const progress = `[${i + 1}/${candidates.length}]`;
    
    try {
      const result = await processOneRestaurant(target, threadId);
      stats[result.status] = (stats[result.status] || 0) + 1;
      
      if ((i + 1) % 10 === 0) {
        console.log(`\n[Thread ${threadId}] 📊 Tiến độ ${progress}: ✅${stats.success} 🔒${stats.closed} 🔴${stats.not_found} ❌${stats.error}\n`);
      }
    } catch (err) {
      stats.error++;
      console.error(`[Thread ${threadId}] ${progress} ❌ Lỗi ngoại lệ cho "${target.name}": ${err.message}`);
    }
    
    // Delay giữa các quán để tránh bị chặn
    if (i < candidates.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_MS));
    }
  }
  
  return stats;
}

// ── MAIN ────────────────────────────────────────────────
async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log(`║  🛵 LOCAL BULK CRAWLER — ${THREADS} Luồng Song Song             ║`);
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  Đối chiếu ShopeeFood + Cào menu + Sync Supabase     ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  
  // Đọc database
  const allData = dbHelper.read();
  console.log(`\n📦 Tổng số quán trong DB: ${allData.length}`);
  
  // Lọc các quán cần đối chiếu (chưa có menu thật hoặc chưa kiểm tra trong 24h)
  const candidates = allData.filter(r => {
    if (!r || !r.id) return false;
    // Bỏ qua quán đã có menu thật và đã kiểm tra trong 24h gần đây
    if (r.hasRealMenu && r.menuUpdatedAt) {
      const diff = Date.now() - new Date(r.menuUpdatedAt).getTime();
      if (diff < 24 * 60 * 60 * 1000) return false;
    }
    return true;
  });
  
  // Sắp xếp: ưu tiên quán chưa từng kiểm tra (menuUpdatedAt = null)
  candidates.sort((a, b) => {
    const timeA = a.menuUpdatedAt ? new Date(a.menuUpdatedAt).getTime() : 0;
    const timeB = b.menuUpdatedAt ? new Date(b.menuUpdatedAt).getTime() : 0;
    return timeA - timeB;
  });
  
  console.log(`🎯 Số quán cần đối chiếu: ${candidates.length}`);
  console.log(`🧵 Số luồng: ${THREADS}`);
  console.log(`⏱️  Delay giữa các quán: ${DELAY_BETWEEN_MS}ms`);
  
  if (candidates.length === 0) {
    console.log('\n✨ Tuyệt vời! Tất cả quán ăn đã được đối chiếu trong 24 giờ qua.');
    process.exit(0);
  }
  
  // Chia đều danh sách ứng viên cho các luồng
  const chunks = [];
  for (let i = 0; i < THREADS; i++) {
    chunks.push([]);
  }
  candidates.forEach((c, i) => {
    chunks[i % THREADS].push(c);
  });
  
  console.log(`\n📋 Phân bổ công việc:`);
  chunks.forEach((chunk, i) => {
    console.log(`   Thread ${i + 1}: ${chunk.length} quán`);
  });
  
  const startTime = Date.now();
  console.log(`\n🏁 Bắt đầu cào lúc: ${new Date().toLocaleTimeString('vi-VN')}\n`);
  console.log('─'.repeat(60));
  
  // Chạy tất cả các luồng song song
  const results = await Promise.all(
    chunks.map((chunk, i) => workerThread(i + 1, chunk))
  );
  
  // Tổng hợp kết quả
  const totalStats = { success: 0, closed: 0, not_found: 0, error: 0 };
  results.forEach(stats => {
    Object.keys(stats).forEach(key => {
      totalStats[key] = (totalStats[key] || 0) + stats[key];
    });
  });
  
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  
  console.log('\n' + '═'.repeat(60));
  console.log('📊 KẾT QUẢ TỔNG HỢP');
  console.log('═'.repeat(60));
  console.log(`   ✅ Cào thành công (có menu thật):  ${totalStats.success}`);
  console.log(`   🔒 Đóng cửa (có/không có menu):   ${totalStats.closed}`);
  console.log(`   🔴 Không tồn tại trên ShopeeFood:  ${totalStats.not_found}`);
  console.log(`   ❌ Lỗi kỹ thuật:                   ${totalStats.error}`);
  console.log(`   ⏱️  Thời gian: ${minutes} phút ${seconds} giây`);
  console.log('═'.repeat(60));
  
  // Kiểm tra lại database cuối cùng
  const finalData = dbHelper.read();
  const finalHasReal = finalData.filter(r => r.hasRealMenu).length;
  const finalClosed = finalData.filter(r => r.isClosed).length;
  console.log(`\n📦 Trạng thái DB sau khi cào:`);
  console.log(`   Tổng quán: ${finalData.length}`);
  console.log(`   Có menu thật: ${finalHasReal}`);
  console.log(`   Đóng cửa: ${finalClosed}`);
  console.log(`   Chưa có menu: ${finalData.length - finalHasReal - finalClosed}`);
  
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Lỗi nghiêm trọng:', err);
  process.exit(1);
});
