/**
 * test_checkout_tracking.js
 * 
 * Tự động kiểm thử luồng: Checkout → Đặt hàng → Tracking → Mô phỏng Shipper
 * Sử dụng Puppeteer (đã có sẵn trong server/node_modules)
 * 
 * Chạy: node test_checkout_tracking.js
 */

'use strict';

const puppeteer = require('./server/node_modules/puppeteer-core');
const path = require('path');
const fs = require('fs');

const BASE_URL = 'http://localhost:8000/customer-app';
const SCREENSHOT_DIR = path.join(__dirname, 'test_screenshots');
const CHROME_PATH = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

// Tạo thư mục screenshots
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ── Helpers ──────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m', gray: '\x1b[90m'
};

let passed = 0, failed = 0, warnings = 0;

function pass(msg) {
  console.log(`  ${C.green}[PASS]${C.reset} ${msg}`);
  passed++;
}
function fail(msg) {
  console.log(`  ${C.red}[FAIL]${C.reset} ${msg}`);
  failed++;
}
function warn(msg) {
  console.log(`  ${C.yellow}[WARN]${C.reset} ${msg}`);
  warnings++;
}
function info(msg) {
  console.log(`  ${C.cyan}[INFO]${C.reset} ${msg}`);
}
function section(title) {
  console.log(`\n  ${C.bold}--- ${title} ---${C.reset}`);
}

async function screenshot(page, name) {
  const file = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  info(`Screenshot saved: test_screenshots/${name}.png`);
  return file;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Inject fake state into localStorage ──────────────────────────────────────
async function injectTestState(page, restaurantId, menuItemId) {
  await page.evaluate((rId, mId) => {
    // Set up a complete state: relative order with valid data
    const state = {
      cart: {
        restaurantId: rId,
        items: { [mId]: 1 }
      },
      activeOrder: null,
      deliveryAddress: '123 Mậu Thân, Ninh Kiều, Cần Thơ',
      deliveryName: 'Nguyễn Thị Bé',
      deliveryPhone: '0912345678',
      ordererPhone: '0987654321',
      isRelative: true,
      userLat: 10.0276,
      userLon: 105.7725
    };
    localStorage.setItem('shipfree_state', JSON.stringify(state));
    console.log('[TEST] State injected:', JSON.stringify(state));
  }, restaurantId, menuItemId);
}

// ── Main Test ─────────────────────────────────────────────────────────────────
async function runTest() {
  console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════════════════════╗`);
  console.log(`║  ShipFree — Kiểm thử Checkout → Tracking             ║`);
  console.log(`╚══════════════════════════════════════════════════════╝${C.reset}\n`);

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
           '--disable-dev-shm-usage', '--lang=vi-VN'],
    defaultViewport: { width: 390, height: 844 }
  });

  try {
    const page = await browser.newPage();

    // Intercept console logs from the page
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.log(`  ${C.red}[PAGE ERROR]${C.reset} ${msg.text()}`);
      }
    });

    // ── STEP 1: Load index.html and find a restaurant+menu item ──────────────
    section('BƯỚC 1: Lấy thông tin quán ăn và món ăn');

    await page.goto(`${BASE_URL}/index.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(2000);

    // Read restaurants from API
    const apiData = await page.evaluate(async () => {
      try {
        const res = await fetch('http://localhost:3001/api/restaurants');
        const json = await res.json();
        if (json.data && json.data.length > 0) {
          const r = json.data[0];
          const menu = r.menu || [];
          return { id: r.id, name: r.name, menu: menu.slice(0, 1) };
        }
      } catch (e) {}
      // fallback: read from page's ACTIVE_RESTAURANTS
      if (typeof SF !== 'undefined' && SF.RESTAURANTS && SF.RESTAURANTS.length > 0) {
        const r = SF.RESTAURANTS[0];
        return { id: r.id, name: r.name, menu: (r.menu || []).slice(0, 1) };
      }
      return null;
    });

    if (!apiData || !apiData.id || !apiData.menu || apiData.menu.length === 0) {
      fail('Không lấy được thông tin quán ăn từ API');
      return;
    }

    const restaurantId = apiData.id;
    const menuItem = apiData.menu[0];
    const menuItemId = menuItem.id;

    pass(`Quán ăn: "${apiData.name}" (ID: ${restaurantId})`);
    pass(`Món ăn: "${menuItem.name}" (ID: ${menuItemId})`);

    // ── STEP 2: Inject state → Go to checkout.html ────────────────────────────
    section('BƯỚC 2: Khởi tạo trạng thái và mở checkout.html');

    await injectTestState(page, restaurantId, menuItemId);
    pass('Đã inject trạng thái đặt hàng cho người thân vào localStorage');

    await page.goto(`${BASE_URL}/checkout.html`, { waitUntil: 'networkidle2', timeout: 20000 });
    await sleep(2500);
    await screenshot(page, '01_checkout_loaded');

    // ── STEP 3: Verify checkout page content ──────────────────────────────────
    section('BƯỚC 3: Kiểm tra trang Checkout');

    // 3a. Check page title
    const pageTitle = await page.title();
    if (pageTitle.includes('Xác Nhận')) {
      pass(`Tiêu đề trang đúng: "${pageTitle}"`);
    } else {
      warn(`Tiêu đề trang không rõ: "${pageTitle}"`);
    }

    // 3b. Check relative banner
    const bannerVisible = await page.evaluate(() => {
      const banner = document.getElementById('relative-order-banner');
      if (!banner) return false;
      return banner.style.display !== 'none' && banner.style.display !== '';
    });
    if (bannerVisible) {
      pass('Banner "Đặt hàng cho người thân" hiển thị đúng');
    } else {
      fail('Banner "Đặt hàng cho người thân" KHÔNG hiển thị');
    }

    // 3c. Check relative details rendered
    const relativeInfo = await page.evaluate(() => {
      const nameEl = document.getElementById('addr-name');
      const addrEl = document.getElementById('addr-address');
      const phoneEl = document.getElementById('addr-phone');
      return {
        name: nameEl ? nameEl.innerHTML : '',
        addr: addrEl ? addrEl.innerHTML : '',
        phone: phoneEl ? phoneEl.innerHTML : ''
      };
    });

    if (relativeInfo.name.includes('Nguyễn Thị Bé') || relativeInfo.name.includes('Bé')) {
      pass(`Tên người thân hiển thị: "${relativeInfo.name.replace(/<[^>]+>/g, '').trim()}"`);
    } else {
      fail(`Tên người thân KHÔNG hiển thị đúng: "${relativeInfo.name.replace(/<[^>]+>/g, '').trim()}"`);
    }

    if (relativeInfo.phone.includes('0912345678')) {
      pass('SĐT người thân hiển thị: 0912345678');
    } else {
      warn(`SĐT người thân: "${relativeInfo.phone.replace(/<[^>]+>/g, '').trim()}"`);
    }

    if (relativeInfo.phone.includes('0987654321')) {
      pass('SĐT người đặt hiển thị: 0987654321');
    } else {
      warn(`SĐT người đặt: "${relativeInfo.phone.replace(/<[^>]+>/g, '').trim()}"`);
    }

    // 3d. Check Leaflet map
    const mapLoaded = await page.evaluate(() => {
      const mapEl = document.getElementById('checkout-map');
      if (!mapEl) return false;
      return mapEl.children.length > 0;
    });
    if (mapLoaded) {
      pass('Bản đồ Leaflet trên checkout.html đã load');
    } else {
      warn('Bản đồ Leaflet có thể chưa load xong (CDN/network)');
    }

    // 3e. Check order items
    const orderItemsCount = await page.evaluate(() => {
      const list = document.getElementById('order-items-list');
      return list ? list.children.length : 0;
    });
    if (orderItemsCount > 0) {
      pass(`Danh sách món ăn hiển thị: ${orderItemsCount} món`);
    } else {
      fail('Danh sách món ăn TRỐNG hoặc không tìm thấy');
    }

    // 3f. Check place order button
    const placeOrderBtn = await page.$('#place-order-btn');
    if (placeOrderBtn) {
      pass('Nút "Xác Nhận Đặt Hàng" tồn tại');
    } else {
      fail('Nút "Xác Nhận Đặt Hàng" KHÔNG tìm thấy');
      return;
    }

    // ── STEP 4: Click Place Order ─────────────────────────────────────────────
    section('BƯỚC 4: Nhấn nút Đặt Hàng');

    await page.click('#place-order-btn');
    info('Đã click nút "Xác Nhận Đặt Hàng", đang chờ xử lý...');
    await sleep(2000);
    await screenshot(page, '02_after_place_order_click');

    // Wait for success overlay
    const successOverlayVisible = await page.evaluate(() => {
      const overlay = document.getElementById('success-overlay');
      return overlay && overlay.classList.contains('active');
    });

    if (successOverlayVisible) {
      pass('Modal thành công "Đặt hàng thành công!" hiển thị');

      // Get order ID from modal
      const orderId = await page.evaluate(() => {
        const el = document.getElementById('modal-order-id');
        return el ? el.textContent : '';
      });
      const orderTotal = await page.evaluate(() => {
        const el = document.getElementById('modal-total');
        return el ? el.textContent : '';
      });

      if (orderId && orderId.startsWith('SPF-')) {
        pass(`Mã đơn hàng: ${orderId}`);
      } else {
        warn(`Mã đơn hàng không đúng format: "${orderId}"`);
      }
      info(`Tổng tiền đơn hàng: ${orderTotal}`);
    } else {
      warn('Modal thành công chưa xuất hiện sau 2s — có thể cần thêm thời gian');
    }

    await sleep(500);
    await screenshot(page, '03_success_modal');

    // ── STEP 5: Navigate to tracking ─────────────────────────────────────────
    section('BƯỚC 5: Chuyển đến trang Tracking');

    // Click "Theo dõi đơn hàng" button
    const trackingBtn = await page.$('#success-overlay button[onclick="goToTracking()"], #success-overlay .btn--primary');
    if (trackingBtn) {
      await trackingBtn.click();
      info('Đã click nút "Theo dõi đơn hàng"');
    } else {
      // Navigate directly
      info('Không tìm thấy nút tracking, điều hướng trực tiếp...');
      await page.evaluate(() => SF.navigate('tracking.html'));
    }

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
    await sleep(3000);
    await screenshot(page, '04_tracking_loaded');

    const currentUrl = page.url();
    if (currentUrl.includes('tracking.html')) {
      pass(`Đã chuyển đến tracking.html: ${currentUrl}`);
    } else {
      fail(`Chưa đến tracking.html, URL hiện tại: ${currentUrl}`);
    }

    // ── STEP 6: Verify tracking page ─────────────────────────────────────────
    section('BƯỚC 6: Kiểm tra trang Tracking');

    // 6a. Order ID
    const trackOrderId = await page.evaluate(() => {
      const el = document.getElementById('order-id-display');
      return el ? el.textContent : '';
    });
    if (trackOrderId && trackOrderId.startsWith('SPF-')) {
      pass(`Mã đơn hàng trên tracking: ${trackOrderId}`);
    } else {
      warn(`Mã đơn hàng tracking không rõ: "${trackOrderId}"`);
    }

    // 6b. Check relative info on tracking
    const trackRelInfo = await page.evaluate(() => {
      const nameEl = document.getElementById('track-addr-name');
      const phoneEl = document.getElementById('track-addr-phone');
      return {
        name: nameEl ? nameEl.innerHTML : '',
        phone: phoneEl ? phoneEl.innerHTML : ''
      };
    });

    if (trackRelInfo.name.includes('Bé') || trackRelInfo.name.includes('Người thân')) {
      pass(`Thông tin người thân trên tracking hiển thị đúng`);
    } else {
      warn(`Tên người thân tracking: "${trackRelInfo.name.replace(/<[^>]+>/g, '').trim()}"`);
    }

    if (trackRelInfo.phone.includes('0987654321')) {
      pass('SĐT người đặt hiển thị trên tracking: 0987654321');
    } else {
      warn(`SĐT người đặt tracking: "${trackRelInfo.phone.replace(/<[^>]+>/g, '').trim()}"`);
    }

    // 6c. Check status badge
    const statusBadge = await page.evaluate(() => {
      const badge = document.getElementById('order-status-badge');
      return badge ? badge.textContent.trim() : '';
    });
    info(`Trạng thái đơn hàng: "${statusBadge}"`);
    if (statusBadge) {
      pass(`Badge trạng thái hiển thị: "${statusBadge}"`);
    } else {
      warn('Badge trạng thái không tìm thấy');
    }

    // 6d. Check Leaflet map on tracking
    const trackMapLoaded = await page.evaluate(() => {
      const mapEl = document.getElementById('tracking-map');
      return mapEl && mapEl.children.length > 0;
    });
    if (trackMapLoaded) {
      pass('Bản đồ Leaflet tracking đã load');
    } else {
      warn('Bản đồ Leaflet tracking có thể chưa load (CDN)');
    }

    // 6e. Check timeline steps
    const timelineSteps = await page.evaluate(() => {
      const steps = document.querySelectorAll('.timeline__step');
      return {
        count: steps.length,
        active: Array.from(steps).find(s => s.classList.contains('active'))?.id || ''
      };
    });
    if (timelineSteps.count >= 4) {
      pass(`Timeline có ${timelineSteps.count} bước, đang active: ${timelineSteps.active || 'step-PENDING'}`);
    } else {
      warn(`Timeline chỉ có ${timelineSteps.count} bước`);
    }

    // 6f. Check demo simulation buttons
    const demoBtns = await page.evaluate(() => {
      const btns = document.querySelectorAll('.demo-step-btn');
      return Array.from(btns).map(b => ({ id: b.id, text: b.textContent.trim().substring(0, 30) }));
    });
    if (demoBtns.length >= 3) {
      pass(`Nút mô phỏng shipper có ${demoBtns.length} bước`);
      demoBtns.forEach(b => info(`  - ${b.id}: ${b.text}`));
    } else {
      warn('Nút mô phỏng shipper không đủ số lượng');
    }

    // ── STEP 7: Run Shipper Simulation ────────────────────────────────────────
    section('BƯỚC 7: Mô phỏng Shipper di chuyển');

    const simSteps = ['ACCEPTED', 'PURCHASED', 'DELIVERED'];
    for (const status of simSteps) {
      const btnId = `demo-btn-${status}`;
      const btn = await page.$(`#${btnId}`);

      if (btn) {
        // Get shipper position BEFORE click
        const beforePos = await page.evaluate(() => {
          if (typeof shipperMarker !== 'undefined' && shipperMarker) {
            const latlng = shipperMarker.getLatLng();
            return { lat: latlng.lat, lng: latlng.lng };
          }
          return null;
        });

        await btn.click();
        info(`Đã click nút mô phỏng → ${status}`);
        await sleep(1800);

        // Get shipper position AFTER click
        const afterPos = await page.evaluate(() => {
          if (typeof shipperMarker !== 'undefined' && shipperMarker) {
            const latlng = shipperMarker.getLatLng();
            return { lat: latlng.lat, lng: latlng.lng };
          }
          return null;
        });

        // Check status updated
        const newStatus = await page.evaluate(() => {
          const badge = document.getElementById('order-status-badge');
          return badge ? badge.textContent.trim() : '';
        });

        if (beforePos && afterPos && (beforePos.lat !== afterPos.lat || beforePos.lng !== afterPos.lng)) {
          pass(`[${status}] Shipper di chuyển: (${beforePos.lat.toFixed(4)},${beforePos.lng.toFixed(4)}) → (${afterPos.lat.toFixed(4)},${afterPos.lng.toFixed(4)})`);
        } else if (!beforePos || !afterPos) {
          warn(`[${status}] Không đọc được tọa độ shipper (có thể Leaflet chưa load)`);
        } else {
          warn(`[${status}] Tọa độ shipper không thay đổi`);
        }

        info(`[${status}] Badge trạng thái: "${newStatus}"`);
        await screenshot(page, `05_sim_${status.toLowerCase()}`);

      } else {
        warn(`Không tìm thấy nút mô phỏng #${btnId}`);
      }
    }

    // Check final delivered state
    const finalStatus = await page.evaluate(() => {
      const badge = document.getElementById('order-status-badge');
      const ratingSec = document.getElementById('rating-section');
      return {
        badge: badge ? badge.textContent.trim() : '',
        ratingVisible: ratingSec ? ratingSec.style.display !== 'none' : false
      };
    });

    if (finalStatus.badge.includes('Đã giao') || finalStatus.badge.includes('DELIVERED') || finalStatus.badge.includes('Giao')) {
      pass(`Trạng thái cuối: "${finalStatus.badge}" ✅`);
    } else {
      warn(`Trạng thái cuối: "${finalStatus.badge}"`);
    }

    if (finalStatus.ratingVisible) {
      pass('Phần đánh giá sao hiển thị sau khi giao hàng thành công');
    } else {
      warn('Phần đánh giá sao chưa hiển thị');
    }

    await screenshot(page, '06_delivered_final');

    // ── SUMMARY ───────────────────────────────────────────────────────────────
    console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════════════════════╗`);
    console.log(`║  KẾT QUẢ KIỂM THỬ CHECKOUT → TRACKING               ║`);
    console.log(`╚══════════════════════════════════════════════════════╝${C.reset}`);
    console.log(`  ${C.green}PASS   : ${passed}${C.reset}`);
    console.log(`  ${C.red}FAIL   : ${failed}${C.reset}`);
    console.log(`  ${C.yellow}WARN   : ${warnings}${C.reset}`);
    console.log(`  📸 Screenshots lưu tại: ./test_screenshots/`);
    console.log('');

    if (failed === 0) {
      console.log(`  ${C.bold}${C.green}✅ LUỒNG CHECKOUT → TRACKING HOẠT ĐỘNG TỐT!${C.reset}`);
    } else {
      console.log(`  ${C.bold}${C.red}❌ CÓ ${failed} LỖI CẦN XEM LẠI${C.reset}`);
    }
    console.log('');

  } finally {
    await browser.close();
  }
}

runTest().catch(err => {
  console.error(`${C.red}[FATAL]${C.reset}`, err.message);
  process.exit(1);
});
