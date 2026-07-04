/**
 * crawl_open_fallbacks.js — Target open restaurants using fallback templates.
 * Run this from the server/ directory.
 * Usage: node crawl_open_fallbacks.js [--limit=50] [--delay=4000]
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const dbHelper = require('./dbHelper');
const menuScraper = require('./menuScraper');

const ARGS = process.argv.slice(2);
const LIMIT_ARG = ARGS.find(a => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1]) : 50;

const DELAY_ARG = ARGS.find(a => a.startsWith('--delay='));
const DELAY_MS = DELAY_ARG ? parseInt(DELAY_ARG.split('=')[1]) : 4000;

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
      // Ignore
    }
  }
  return foodySlug;
}

async function run() {
  console.log('\n======================================================');
  console.log('    ShipFee -- Crawl Real Menus for Open Fallbacks');
  console.log('======================================================');
  console.log(` Giới hạn cào đợt này : ${LIMIT} quán`);
  console.log(` Độ trễ an toàn      : ${DELAY_MS / 1000} giây`);
  console.log('======================================================\n');

  const restaurants = dbHelper.read();
  
  // Lọc quán đang MỞ (isClosed = false) và CHƯA có menu thực tế (hasRealMenu = false)
  const candidates = restaurants.filter(r => {
    return r && r.id && !r.isClosed && !r.hasRealMenu;
  });

  console.log(`📊 Tổng số quán đang mở chưa có menu thực tế: ${candidates.length} quán`);

  if (candidates.length === 0) {
    console.log('✨ Không còn quán nào đang mở sử dụng menu fallback!');
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

    if (!target.shopeefoodSlug) {
      console.log(`   🔍 Phân giải slug từ Foody cho: ${slug}`);
      const resolved = await getShopeeFoodSlugFromFoody(slug);
      if (resolved !== slug) {
        target.shopeefoodSlug = resolved;
        slug = resolved;
        console.log(`   ✅ Đã phân giải slug mới: "${slug}"`);
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
        closedReason = realMenu.reason || 'Quán hiện đang đóng cửa hoặc ngưng trực tuyến.';
        if (Array.isArray(realMenu.menu) && realMenu.menu.length > 0) {
          menu = realMenu.menu;
        }
      } else if (Array.isArray(realMenu) && realMenu.length > 0) {
        isClosed = false;
        menu = realMenu;
      }

      if (isClosed && !menu) {
        // Quán đã đóng cửa hoàn toàn hoặc tạm ngưng trên ShopeeFood
        console.log(`   🔴 Quán đóng cửa/ngưng bán: "${target.name}" (${closedReason})`);
        target.isClosed = true;
        target.closedAt = new Date().toISOString();
        target.closedReason = closedReason;
        closedCount++;
      } else if (menu && menu.length > 0) {
        // Cào menu thực tế thành công
        console.log(`   ✅ Cào thành công thực đơn: ${menu.length} món`);
        target.hasRealMenu = true;
        target.menuUpdatedAt = new Date().toISOString();
        target.dishNames = menu.map(m => m.name).filter(Boolean);
        target.menuTemplateFallback = false;
        target.menu = menu;

        if (isClosed) {
          target.isClosed = true;
          target.closedAt = new Date().toISOString();
          target.closedReason = closedReason;
          closedCount++;
        } else {
          target.isClosed = false;
          delete target.closedAt;
          delete target.closedReason;
        }

        successCount++;
      } else {
        console.log(`   ⚠️ Không bắt được menu thực tế cho quán này (danh sách món rỗng).`);
        errorCount++;
      }

      // Lưu lại vào tệp phân mảnh qua dbHelper
      dbHelper.updateRestaurant(target);
      console.log(`   💾 Đã cập nhật quán "${target.name}" vào database.`);

    } catch (err) {
      console.error(`   ❌ Lỗi khi cào quán "${target.name}":`, err.message);
      errorCount++;
    }

    // Nghỉ delay để bảo vệ IP
    if (i < targets.length - 1) {
      console.log(`   💤 Nghỉ ${DELAY_MS / 1000}s trước khi chuyển sang quán tiếp theo...`);
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  console.log('\n======================================================');
  console.log('📊 KẾT QUẢ ĐỢT CRAWL AN TOÀN:');
  console.log(` - Thành công (Có menu)  : ${successCount} quán`);
  console.log(` - Phát hiện Đóng cửa   : ${closedCount} quán`);
  console.log(` - Thất bại/Lỗi         : ${errorCount} quán`);
  console.log('======================================================\n');
  process.exit(0);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
