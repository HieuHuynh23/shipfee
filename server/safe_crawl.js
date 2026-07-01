/**
 * safe_crawl.js — Safe sequential menu crawler that updates the sharded database.
 * Run this from the server/ directory.
 * Usage: node safe_crawl.js [--limit=100]
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const dbHelper = require('./dbHelper');
const menuScraper = require('./menuScraper');

const ARGS = process.argv.slice(2);
const LIMIT_ARG = ARGS.find(a => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1]) : 100;

const CHUNKS_ARG = ARGS.find(a => a.startsWith('--chunks='));
let chunkRange = null;
if (CHUNKS_ARG) {
  const rangeStr = CHUNKS_ARG.split('=')[1];
  const parts = rangeStr.split('-');
  chunkRange = {
    start: parseInt(parts[0]),
    end: parseInt(parts[1])
  };
}

const DELAY_MS = 5000; // 5 seconds delay between requests

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
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        },
        timeout: 6000
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
          if (resolvedSlug) {
            return resolvedSlug;
          }
        }
      }
    } catch (err) {
      // Ignore and try next URL
    }
  }
  return foodySlug;
}

async function run() {
  console.log('\n======================================================');
  console.log('       ShipFee -- Safe Sequential Menu Crawler');
  console.log('======================================================');
  console.log(` Giới hạn cào đợt này : ${LIMIT} quán`);
  console.log(` Độ trễ an toàn      : ${DELAY_MS / 1000} giây`);
  if (chunkRange) {
    console.log(` Phân mảnh mục tiêu  : Chunks ${chunkRange.start} đến ${chunkRange.end}`);
  }
  console.log('======================================================\n');

  const restaurants = dbHelper.read();
  const candidates = restaurants.filter(r => {
    if (!r || !r.id || r.hasRealMenu || r.isClosed) return false;
    if (chunkRange) {
      const idx = dbHelper.getChunkIndex(r.id);
      return idx >= chunkRange.start && idx <= chunkRange.end;
    }
    return true;
  });

  console.log(`📊 Tổng số quán cần cào menu thực tế: ${candidates.length} quán`);

  if (candidates.length === 0) {
    console.log('✨ Tất cả quán ăn đã có menu thực tế!');
    process.exit(0);
  }

  const targets = candidates.slice(0, LIMIT);
  let successCount = 0;
  let closedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const indexStr = `[${i + 1}/${targets.length}]`;
    console.log(`\n⏳ ${indexStr} Đang xử lý: "${target.name}" (ID: ${target.id})...`);

    let slug = target.shopeefoodSlug || target.id.replace('r_ct_', '').split('?')[0].replace(/_/g, '-');
    
    // Phân giải slug ShopeeFood thực tế
    if (!target.shopeefoodSlug) {
      console.log(`   🔍 Phân giải slug từ Foody cho: ${slug}`);
      const resolved = await getShopeeFoodSlugFromFoody(slug);
      if (resolved !== slug) {
        target.shopeefoodSlug = resolved;
        slug = resolved;
        console.log(`   ✅ Đã phân giải thành công slug mới: "${slug}"`);
      }
    }

    try {
      console.log(`   🚀 Bắt đầu cào menu từ ShopeeFood slug: "${slug}"...`);
      const realMenu = await menuScraper.scrapeMenu(slug);

      let isClosed = false;
      let closedReason = '';
      let menu = null;

      if (realMenu && realMenu.closed === true) {
        isClosed = true;
        closedReason = realMenu.reason || 'Quán hiện đang đóng cửa ngoài giờ phục vụ.';
        if (Array.isArray(realMenu.menu) && realMenu.menu.length > 0) {
          menu = realMenu.menu;
        }
      } else if (Array.isArray(realMenu) && realMenu.length > 0) {
        isClosed = false;
        menu = realMenu;
      }

      // Đọc toàn bộ danh sách để cập nhật an toàn
      const currentDB = dbHelper.read();
      const dbIdx = currentDB.findIndex(r => String(r.id) === String(target.id));

      if (dbIdx !== -1) {
        if (isClosed && !menu) {
          // Quán đóng cửa và không có menu
          console.log(`   🔴 Quán đóng cửa: "${target.name}"`);
          currentDB[dbIdx].isClosed = true;
          currentDB[dbIdx].closedAt = new Date().toISOString();
          currentDB[dbIdx].closedReason = closedReason;
          closedCount++;
        } else {
          // Có thực đơn thực tế
          console.log(`   ✅ Cào thành công thực đơn: ${menu.length} món`);
          currentDB[dbIdx].hasRealMenu = true;
          currentDB[dbIdx].menuUpdatedAt = new Date().toISOString();
          currentDB[dbIdx].dishNames = menu.map(m => m.name).filter(Boolean);
          currentDB[dbIdx].menuTemplateFallback = false;
          
          if (isClosed) {
            currentDB[dbIdx].isClosed = true;
            currentDB[dbIdx].closedAt = new Date().toISOString();
            currentDB[dbIdx].closedReason = closedReason;
            closedCount++;
          } else {
            currentDB[dbIdx].isClosed = false;
            delete currentDB[dbIdx].closedAt;
            delete currentDB[dbIdx].closedReason;
          }

          successCount++;
        }

        // Lưu lại vào tệp phân mảnh qua dbHelper
        dbHelper.write(currentDB);
        console.log(`   💾 Đã cập nhật vào cơ sở dữ liệu phân mảnh.`);
      }

    } catch (err) {
      console.error(`   ❌ Lỗi khi cào quán "${target.name}":`, err.message);
      errorCount++;
    }

    // Nghỉ DELAY_MS giây để bảo vệ IP
    if (i < targets.length - 1) {
      console.log(`   💤 Nghỉ ${DELAY_MS / 1000}s trước khi chuyển sang quán tiếp theo...`);
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  console.log('\n======================================================');
  console.log('📊 KẾT QUẢ ĐỢT CRAWL AN TOÀN:');
  console.log(` - Thành công (Có menu)  : ${successCount} quán`);
  console.log(` - Phát hiện Đóng cửa   : ${closedCount} quán`);
  console.log(` - Gặp lỗi              : ${errorCount} quán`);
  console.log('======================================================\n');
  process.exit(0);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
