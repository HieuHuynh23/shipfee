
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: 'd:\\FOOD DELIVERY\\server\\.env' });

const chunkDir = 'd:\\FOOD DELIVERY\\server\\restaurants-chunks';
const menusDir = 'd:\\FOOD DELIVERY\\server\\menus';

console.log('🏁 BẮT ĐẦU CÀO MỚI TOÀN BỘ DANH SÁCH QUÁN ĂN BẰNG PUPPETEER INTERCEPT...\n');

// Tìm Chrome/Edge path
function getBrowserPath() {
  const paths = [
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    // Linux (Render, AWS, etc.)
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

(async () => {
  const browserPath = getBrowserPath();
  if (!browserPath) {
    console.log('ℹ️ Không phát hiện Chrome/Edge hệ thống. Puppeteer sẽ khởi chạy bằng Chromium tích hợp.');
  }

  // 1. Dọn dẹp local chunks
  if (fs.existsSync(chunkDir)) {
    console.log('🧹 Đang xóa sạch các chunk cũ...');
    const files = fs.readdirSync(chunkDir);
    files.forEach(file => {
      fs.unlinkSync(path.join(chunkDir, file));
    });
  } else {
    fs.mkdirSync(chunkDir, { recursive: true });
  }

  // 2. Dọn dẹp folder menus
  if (fs.existsSync(menusDir)) {
    console.log('🧹 Đang xóa sạch các menu cũ...');
    const files = fs.readdirSync(menusDir);
    files.forEach(file => {
      if (file.endsWith('.json')) {
        fs.unlinkSync(path.join(menusDir, file));
      }
    });
  } else {
    fs.mkdirSync(menusDir, { recursive: true });
  }

  console.log('✅ Đã dọn sạch dữ liệu cũ tại local.');

  // 3. Khởi tạo Supabase và xóa sạch quán cũ trên online
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let supabase = null;
  if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log('🌐 Đang xóa sạch dữ liệu quán cũ trên Supabase...');
    const { error: delError } = await supabase
      .from('restaurants')
      .delete()
      .neq('id', '');

    if (delError) {
      console.error('❌ Lỗi khi xóa dữ liệu Supabase:', delError.message);
    } else {
      console.log('✅ Đã dọn sạch database Supabase.');
    }
  }

  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  };

  if (browserPath) {
    launchOptions.executablePath = browserPath;
  }

  const browser = await puppeteer.launch(launchOptions);

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const rawRestaurantsMap = new Map();

  // Lắng nghe các gói tin API get_delivery_list hoặc get_delivery_home
  page.on('response', async response => {
    const respUrl = response.url();
    if (respUrl.includes('get_delivery_list') || respUrl.includes('get_restaurants_by_city') || respUrl.includes('get_delivery_home')) {
      try {
        const text = await response.text();
        const parsed = JSON.parse(text);

        const items =
          parsed?.reply?.delivery_items ||
          parsed?.reply?.restaurants ||
          parsed?.result?.restaurants ||
          parsed?.result?.items ||
          parsed?.data?.restaurants ||
          [];

        if (items.length > 0) {
          let count = 0;
          items.forEach(item => {
            const id = item.restaurant_id || item.id || item.delivery_id;
            if (id && !rawRestaurantsMap.has(id)) {
              rawRestaurantsMap.set(id, item);
              count++;
            }
          });
          if (count > 0) {
            console.log(`   - [API Intercept] Bắt được thêm ${count} quán mới. (Tổng thu thập: ${rawRestaurantsMap.size} quán)`);
          }
        }
      } catch (e) { }
    }
  });

  try {
    console.log('\n🔗 Đang mở trang ShopeeFood Cần Thơ để kích hoạt load danh sách quán...');
    await page.goto('https://shopeefood.vn/can-tho', { waitUntil: 'networkidle2', timeout: 50000 });

    console.log('🔄 Đang tự động scroll trang xuống dưới để kích hoạt lazy-load thêm quán ăn...');
    // Lặp scroll xuống dưới
    for (let i = 0; i < 20; i++) {
      await page.evaluate(() => {
        window.scrollBy(0, 1000);
      });
      console.log(`   * Scroll bước ${i + 1}/20...`);
      await new Promise(r => setTimeout(r, 2000));
    }

  } catch (err) {
    console.error('❌ Lỗi Puppeteer cào:', err.message);
  }

  await browser.close();

  console.log(`\n✅ Thu thập thành công ${rawRestaurantsMap.size} quán từ API ShopeeFood!`);

  const crawledRestaurants = [];
  rawRestaurantsMap.forEach((item, id) => {
    let slug = item.url_routing || item.url_rewrite_name || item.restaurant_url || '';
    if (slug.includes('/')) {
      slug = slug.split('/').pop();
    }
    if (!slug) {
      slug = `restaurant-${id}`;
    }

    const photo = item.photos?.[0]?.value || item.image_url || item.logo || '';

    crawledRestaurants.push({
      id: `r_ct_${slug.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      name: item.name || item.restaurant_name || 'Quán ăn',
      address: item.address || item.full_address || 'Cần Thơ',
      lat: item.position?.latitude || item.latitude || 10.0356,
      lon: item.position?.longitude || item.longitude || 105.7801,
      rating: parseFloat(item.rating?.avg || item.rating || 4.5),
      img: photo,
      isClosed: item.is_closed || false,
      closedReason: '',
      hasRealMenu: false,
      menuTemplateFallback: true,
      dishNames: []
    });
  });

  if (crawledRestaurants.length === 0) {
    console.error('❌ Thất bại: Không thu thập được quán ăn nào từ API!');
    process.exit(1);
  }

  // Ghi local chunks
  const dbHelper = require('./dbHelper');
  console.log('\n💾 Đang ghi đè 15 chunk JSON local...');
  const writeSuccess = dbHelper.write(crawledRestaurants);
  if (!writeSuccess) {
    console.error('❌ Lỗi khi ghi chunks.');
    process.exit(1);
  }
  console.log(`✅ Đã ghi thành công 15 chunk JSON mới cho ${crawledRestaurants.length} quán ăn!`);

  // Upload lên Supabase
  if (supabase) {
    console.log('\n🌐 Đang upload danh sách quán mới lên Supabase...');
    const BATCH_SIZE = 50;
    let successCount = 0;
    for (let i = 0; i < crawledRestaurants.length; i += BATCH_SIZE) {
      const batch = crawledRestaurants.slice(i, i + BATCH_SIZE);
      const upsertData = batch.map(r => ({
        id: r.id,
        name: r.name,
        address: r.address,
        lat: r.lat,
        lon: r.lon,
        rating: r.rating,
        image_url: r.img,
        is_closed: r.isClosed,
        closed_reason: '',
        has_real_menu: false,
        dish_names: [],
        menu: [],
        updated_at: new Date().toISOString()
      }));

      const { error: upsertError } = await supabase
        .from('restaurants')
        .upsert(upsertData, { onConflict: 'id' });

      if (upsertError) {
        console.error(`   ❌ Lỗi upload batch ${i}:`, upsertError.message);
      } else {
        successCount += batch.length;
        console.log(`   - Upload thành công: ${successCount}/${crawledRestaurants.length} quán.`);
      }
    }
  }

  console.log('\n🎉 HOÀN TẤT CÀO MỚI TOÀN BỘ DANH SÁCH QUÁN ĂN!');
})();
