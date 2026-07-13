const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');
const path = require('path');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

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

function getHighQualityImg(photos) {
  if (!photos || photos.length === 0) return '';
  const match = photos.find(p => p.width >= 350 && p.width <= 600);
  if (match) return match.value;
  return photos[photos.length - 1]?.value || photos[0]?.value || '';
}

/**
 * Trích xuất menu từ dữ liệu API ShopeeFood (menu_infos)
 */
function extractMenuFromApiData(apiData, slug) {
  const reply = apiData.reply || {};
  const menu_infos = reply.menu_infos || [];
  console.log(`[menuScraper] [API] Bắt đầu phân tích thực đơn ShopeeFood (${menu_infos.length} danh mục)...`);

  const cleanDishes = [];
  let itemIndex = 0;

  menu_infos.forEach(cat => {
    const categoryName = cat.dish_type_name || 'Món ăn';
    const dishes = cat.dishes || [];

    dishes.forEach(dish => {
      // Lọc bỏ món đã xóa khỏi thực đơn
      if (dish.is_deleted) return;

      // Ưu tiên giá trị giảm giá (sale price) trên ShopeeFood nếu có
      const inStorePrice = (dish.discount_price && dish.discount_price.value > 0)
        ? dish.discount_price.value
        : (dish.price?.value || 35000);

      if (inStorePrice <= 100) return; // Bỏ qua các món ghi chú/admin 1đ

      // Thêm 28% markup cố định (làm tròn 100đ)
      const appPrice = Math.round((inStorePrice * 1.28) / 100) * 100;

      // Lấy ảnh CDN chất lượng cao
      let img = getHighQualityImg(dish.photos);
      if (!img || img.includes('placeholder') || img.startsWith('data:')) {
        img = `https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80`;
      }

      // Trích xuất tùy chọn topping/options nếu có
      const options = (dish.options || []).map(opt => ({
        name: opt.name,
        mandatory: opt.mandatory === true || opt.mandatory === 1,
        min_select: opt.option_items?.min_select || 0,
        max_select: opt.option_items?.max_select || 1,
        items: (opt.option_items?.items || []).map(item => ({
          name: item.name,
          price: item.price?.value || 0
        }))
      }));

      cleanDishes.push({
        id: `${slug}-item-${itemIndex++}`,
        name: dish.name,
        desc: dish.description || `Món ăn đặc trưng được chuẩn bị nóng hổi tại cửa hàng.`,
        inStorePrice: inStorePrice,
        appPrice: appPrice,
        img: img,
        category: categoryName,
        isAvailable: dish.is_available !== false && dish.is_active !== false,
        options: options
      });
    });
  });

  console.log(`[menuScraper] [API] ✅ Trích xuất thành công ${cleanDishes.length} món ăn từ API!`);
  return cleanDishes;
}

/**
 * Kết quả trả về:
 *   - Array (menu items): Cào thành công
 *   - { closed: true }: Phát hiện quán đóng cửa
 *   - []: Lỗi kỹ thuật / không xác định được
 */
async function scrapeMenu(slug) {
  const executablePath = getBrowserPath();
  if (!executablePath) {
    console.error('[menuScraper] ❌ Không tìm thấy Chrome hoặc Edge trên hệ thống!');
    return [];
  }

  const url = `https://shopeefood.vn/can-tho/${slug}`;
  console.log(`[menuScraper] 🚀 Bắt đầu cào menu quán: ${slug} (Headless: true)...`);

  const browser = await puppeteer.launch({
    executablePath: executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--js-flags="--max-old-space-size=256"',
      '--use-gl=desktop',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process,TrackingPrevention,EdgeTrackingPrevention',
      '--disable-site-isolation-trials',
      '--no-first-run',
      '--disable-notifications',
      '--lang=vi-VN,vi,en-US,en',
      '--window-size=1280,900'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // Tối ưu hóa RAM tối đa: chặn tải hình ảnh, fonts, media (không chặn stylesheet để tránh treo trang)
    await page.setRequestInterception(true);
    page.on('request', req => {
      const resourceType = req.resourceType();
      if (['image', 'font', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Set ngôn ngữ và timezone Việt Nam
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
    });

    let apiData = null;
    let apiCapturedCount = 0;
    let apiResponded = false; // Flag: API đã phản hồi (dù rỗng hay không)
    let closedDetected = false; // Flag: phát hiện quán đóng cửa
    let closedReason = ''; // Lý do đóng cửa chi tiết từ popup
    let apiPromiseResolve;
    const apiPromise = new Promise(resolve => {
      apiPromiseResolve = resolve;
    });

    // Lắng nghe TẤT CẢ các gói tin có chứa menu
    page.on('response', async response => {
      const respUrl = response.url();

      // Bắt endpoint menu chính
      if (respUrl.includes('get_delivery_dishes')) {
        try {
          const text = await response.text();
          const parsed = JSON.parse(text);
          const items = (parsed?.reply?.menu_infos || []).reduce((acc, c) => acc + (c.dishes || []).length, 0);
          console.log(`[menuScraper] [API] Đã bắt được menu JSON! Status: ${response.status()}, Items: ${items}`);

          // Ghi nhận: API đã phản hồi (kể cả khi 0 items)
          apiResponded = true;
          if (items > apiCapturedCount) {
            apiData = parsed;
            apiCapturedCount = items;
          } else if (items === 0 && !apiData) {
            // API phản hồi rỗng → lưu lại để detect đóng cửa
            apiData = parsed;
          }
          // Resolve promise để thoát khỏi chờ
          apiPromiseResolve(true);
        } catch (e) {
          console.error('[menuScraper] [API] Lỗi khi phân tích JSON menu:', e.message);
        }
      }

      // Fallback: bắt endpoint tìm kiếm quán nếu menu chính fail
      if (respUrl.includes('restaurant_info') || respUrl.includes('get_restaurant')) {
        try {
          const text = await response.text();
          const parsed = JSON.parse(text);
          if (parsed?.reply?.menu_infos?.length > 0 && !apiData) {
            apiData = parsed;
            apiPromiseResolve(true);
          }
        } catch (e) { }
      }
    });

    // ── BƯỚC 1: Vào trang Cần Thơ để thiết lập cookies địa điểm ──
    console.log('[menuScraper] Đi tới trang Can Tho để thiết lập cookies vị trí...');
    await page.goto('https://shopeefood.vn/can-tho', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { });
    await new Promise(r => setTimeout(r, 1000));

    // ── BƯỚC 2: Vào trang chi tiết quán ──
    console.log(`[menuScraper] Đi tới trang chi tiết quán: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 50000 }).catch(async () => {
      // Thử lại với domcontentloaded nếu networkidle2 timeout
      console.log('[menuScraper] ⚠️ networkidle2 timeout, thử lại với domcontentloaded...');
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (e2) {
        console.error('[menuScraper] ❌ Không thể tải trang:', e2.message);
      }
    });

    // ── BƯỚC 3: Phát hiện và xử lý popup đóng cửa ──
    try {
      // Chờ 1.5s xem có popup không
      await new Promise(r => setTimeout(r, 1500));

      // Phát hiện modal đóng cửa và kiểm tra nội dung
      const modalInfo = await page.evaluate(() => {
        const selectors = [
          '[class*="modal"]', '[class*="popup"]', '[class*="dialog"]',
          '[class*="alert"]', '.ReactModal__Overlay', '[role="dialog"]'
        ];

        const closedKeywords = [
          'đóng cửa', 'dong cua', 'closed', 'không phục vụ',
          'ngoài giờ', 'nghỉ', 'tạm ngưng', 'hiện tại không', 'chưa mở',
          'outside working hours', 'not available'
        ];

        let foundClosedModal = false;
        let closedText = '';
        let foundAndClicked = false;

        for (const sel of selectors) {
          const modals = document.querySelectorAll(sel);
          for (const modal of modals) {
            const text = modal.innerText?.toLowerCase() || '';
            const isClosedModal = closedKeywords.some(kw => text.includes(kw));
            if (isClosedModal) {
              foundClosedModal = true;
              closedText = modal.innerText?.trim() || '';
            }
          }
        }

        // Click nút Ok/Đóng để dismiss modal
        const btnSelectors = [
          '[class*="modal"] button', '[class*="popup"] button',
          '[class*="dialog"] button', '[role="dialog"] button',
          '.btn-ok', '.btn-close'
        ];

        for (const sel of btnSelectors) {
          const btns = document.querySelectorAll(sel);
          for (const btn of btns) {
            const text = btn.innerText?.toLowerCase() || '';
            if (text.includes('ok') || text.includes('đóng') || text.includes('dong') ||
              text.includes('đồng ý') || text.includes('tiếp tục') ||
              text === '×' || text === 'x' || text.trim() === '') {
              btn.click();
              foundAndClicked = true;
              break;
            }
          }
          if (foundAndClicked) break;
        }

        return { foundClosedModal, closedText, foundAndClicked };
      });

      if (modalInfo.foundClosedModal) {
        console.log('[menuScraper] 🔴 Phát hiện modal ĐÓNG CỬA trên trang! Lý do:', modalInfo.closedText);
        closedDetected = true;
        closedReason = modalInfo.closedText;
      }
      if (modalInfo.foundAndClicked) {
        console.log('[menuScraper] Đã đóng popup/modal trên trang...');
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (e) { }

    // ── BƯỚC 4: Scroll trang để trigger lazy-load API ──
    console.log('[menuScraper] Đang scroll trang để kích hoạt lazy-load menu...');
    await page.evaluate(async () => {
      // Scroll xuống dần để trigger lazy load
      for (let i = 0; i < 10; i++) {
        window.scrollBy(0, 400);
        await new Promise(r => setTimeout(r, 200));
      }
      // Scroll lên lại
      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 300));
      // Scroll xuống lại lần 2
      for (let i = 0; i < 15; i++) {
        window.scrollBy(0, 500);
        await new Promise(r => setTimeout(r, 150));
      }
    });

    // ── BƯỚC 5: Chờ API được bắt (tối đa 20 giây) ──
    const intercepted = await Promise.race([
      apiPromise,
      new Promise(r => setTimeout(() => r(false), 20000))
    ]);

    // ── ƯU TIÊN: Nếu API đã bắt được menu (dù có modal đóng cửa) → trả về menu thực tế ──
    // Modal "Ngoài giờ phục vụ" = quán tồn tại & có menu, chỉ hiện tại ngoài giờ giao hàng
    // Chúng ta vẫn muốn hiển thị menu để khách hàng xem trước
    if (intercepted && apiResponded && apiCapturedCount > 0 && apiData) {
      console.log(`[menuScraper] ✅ API đã bắt được ${apiCapturedCount} món (dù có modal đóng cửa=${closedDetected}).`);
      const dishes = extractMenuFromApiData(apiData, slug);
      if (dishes.length > 0) {
        if (closedDetected) {
          console.log(`[menuScraper] ℹ️ Quán đang ngoài giờ phục vụ nhưng vẫn có menu ${dishes.length} món. Trả về trạng thái đóng kèm menu.`);
          return { closed: true, reason: closedReason, menu: dishes };
        }
        return dishes;
      }
    }

    if (closedDetected) {
      console.log(`[menuScraper] 🔴 Quán đang đóng cửa (lý do: ${closedReason}). Không có menu API. Trả về thông báo đóng cửa.`);
      return { closed: true, reason: closedReason };
    }

    if (intercepted && apiResponded) {
      if (apiCapturedCount > 0 && apiData) {
        const dishes = extractMenuFromApiData(apiData, slug);
        if (dishes.length > 0) {
          return dishes;
        }
      }

      // API phản hồi 200 OK nhưng menu rỗng hoàn toàn (0 món)
      // → Quán tồn tại nhưng không có menu delivery = đóng cửa hoặc không nhận đơn
      console.log(`[menuScraper] 🔴 API xác nhận: Quán không có menu delivery → Đóng cửa/Không nhận đơn.`);
      return { closed: true, reason: closedReason || 'Quán hiện không nhận đơn giao hàng. Vui lòng quay lại vào giờ làm việc.' };

    } else {
      console.log('[menuScraper] ⚠️ Không bắt được API trong 20 giây. Chuyển sang DOM fallback...');
    }

    // ── FALLBACK: DOM SCROLL & EXTRACT ──
    console.log('[menuScraper] 🔄 Đang dùng DOM Fallback để trích xuất menu...');

    // Scroll adaptive để load virtualized items
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let lastHeight = document.body.scrollHeight;
        let stableCount = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, 300);
          const newHeight = document.body.scrollHeight;
          if (newHeight === lastHeight) {
            stableCount++;
            if (stableCount >= 12) {
              clearInterval(timer);
              resolve();
            }
          } else {
            lastHeight = newHeight;
            stableCount = 0;
          }
        }, 100);
      });
    });

    await new Promise(r => setTimeout(r, 2000));

    const rawDishes = await page.evaluate(() => {
      const list = [];

      // Selector ưu tiên: ShopeeFood mới
      const rows = document.querySelectorAll(
        '.item-restaurant-row, ' +
        '[class*="dish-item"], [class*="food-item"], ' +
        '[class*="menu-item"]:not([class*="menu-item-link"]), ' +
        '[class*="product-item"], [class*="item-card"]'
      );

      rows.forEach(row => {
        const nameEl = row.querySelector(
          '.item-restaurant-name, h2, h3, h4, ' +
          '[class*="name"], [class*="title"], ' +
          '[class*="dish-name"], [class*="food-name"]'
        );
        const priceEl = row.querySelector(
          '.current-price, [class*="price"], [class*="cost"], ' +
          '[class*="amount"]'
        );
        const imgEl = row.querySelector('img[src]:not([src*="icon"]):not([src*="logo"])');
        const descEl = row.querySelector(
          '.item-restaurant-desc, [class*="desc"], [class*="description"]'
        );

        let category = 'Món ăn';
        const menuGroup = row.closest(
          '.menu-group, [class*="group"], [class*="section"], ' +
          '[class*="category"], [class*="type"]'
        );
        if (menuGroup) {
          const catTitleEl = menuGroup.querySelector(
            '.menu-group-title, [class*="title"], [class*="header"], h2, h3'
          );
          if (catTitleEl && catTitleEl !== nameEl) {
            category = catTitleEl.innerText.trim().split('\n')[0];
          }
        }

        const name = nameEl?.innerText?.trim();
        const priceText = priceEl?.innerText?.trim();
        const imgSrc = imgEl?.src || '';
        const desc = descEl?.innerText?.trim() || '';

        // Phát hiện trạng thái hết hàng từ các lớp hoặc văn bản
        const rowText = row.innerText.toLowerCase();
        const btnEl = row.querySelector('button, [class*="btn"], [class*="add"]');
        const btnText = btnEl ? btnEl.innerText.toLowerCase() : '';
        const isOutOfStock =
          rowText.includes('hết') ||
          rowText.includes('tạm hết') ||
          rowText.includes('sold out') ||
          rowText.includes('ngưng bán') ||
          rowText.includes('đã bán hết') ||
          row.classList.contains('is-out-of-stock') ||
          row.classList.contains('sold-out') ||
          (btnEl && (btnEl.disabled || btnEl.classList.contains('disabled') || btnText.includes('hết') || btnText.includes('sold')));

        if (name && name.length > 1 && priceText) {
          list.push({ name, priceText, img: imgSrc, category, desc, isAvailable: !isOutOfStock });
        }
      });

      return list;
    });

    console.log(`[menuScraper] [DOM Fallback] Trích xuất được ${rawDishes.length} món ăn thô.`);

    // Nếu DOM cũng rỗng, kiểm tra thêm trang có dấu hiệu đóng cửa không
    if (rawDishes.length === 0) {
      if (closedDetected) {
        console.log('[menuScraper] 🔴 DOM rỗng + Modal đóng cửa → Xác nhận quán ĐÓNG CỬA.');
        return { closed: true, reason: closedReason || 'Quán hiện đang tạm đóng cửa.' };
      }
      // Kiểm tra text trang lần cuối
      try {
        const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());
        const inactiveKeywords = ['không tồn tại', 'chưa có dịch vụ', 'ngưng hoạt động', 'bài viết không tồn tại', 'địa điểm này chưa có'];
        const closedKeywords = ['đóng cửa', 'dong cua', 'ngoài giờ', 'không phục vụ', 'outside working hours', 'closed'];

        if (inactiveKeywords.some(kw => pageText.includes(kw))) {
          console.log('[menuScraper] 🔴 Phát hiện quán KHÔNG HOẠT ĐỘNG hoặc KHÔNG TỒN TẠI trên ShopeeFood.');
          return { closed: true, reason: 'Cửa hàng hiện đang tạm ngưng dịch vụ trực tuyến.' };
        }

        if (closedKeywords.some(kw => pageText.includes(kw))) {
          console.log('[menuScraper] 🔴 Trang chứa từ khóa đóng cửa → Xác nhận quán ĐÓNG CỬA.');
          return { closed: true, reason: 'Quán hiện đang đóng cửa ngoài giờ phục vụ.' };
        }
      } catch (e) { }
    }

    if (rawDishes.length > 0) {
      const cleanDishes = rawDishes.map((dish, i) => {
        const inStorePrice = parseInt(dish.priceText.replace(/[^\d]/g, '')) || 35000;
        // Thêm 28% markup cố định (làm tròn 100đ)
        const appPrice = Math.round((inStorePrice * 1.28) / 100) * 100;

        let img = dish.img;
        if (!img || img.includes('placeholder') || img.startsWith('data:')) {
          img = `https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80`;
        }

        return {
          id: `${slug}-item-${i}`,
          name: dish.name,
          desc: dish.desc || `Món ăn đặc trưng được chuẩn bị nóng hổi tại cửa hàng.`,
          inStorePrice: inStorePrice,
          appPrice: appPrice,
          img: img,
          category: dish.category || 'Món chính',
          isAvailable: dish.isAvailable
        };
      });
      if (closedDetected) {
        console.log(`[menuScraper] ℹ️ Quán đang ngoài giờ phục vụ (DOM Fallback) nhưng vẫn có menu ${cleanDishes.length} món. Trả về trạng thái đóng kèm menu.`);
        return { closed: true, reason: closedReason, menu: cleanDishes };
      }
      return cleanDishes;
    }

    // ── FALLBACK 2: Lấy toàn bộ text từ trang để debug ──
    console.log('[menuScraper] ⚠️ DOM Fallback cũng thất bại. Không lấy được menu.');
    return [];

  } catch (err) {
    console.error(`[menuScraper] ❌ Thất bại khi cào menu cho "${slug}":`, err.message);
    return [];
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        console.warn('[menuScraper] Lỗi khi đóng browser (bỏ qua):', closeErr.message);
      }
    }
  }
}

module.exports = {
  scrapeMenu
};
