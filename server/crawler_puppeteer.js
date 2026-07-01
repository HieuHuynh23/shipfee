/**
 * FULL Puppeteer crawler - clicks #scrollLoadingPage to load ALL 12,033 restaurants.
 * 
 * Discovery: Foody.vn shows "369/12.033" in the load-more button.
 * The button #scrollLoadingPage triggers AJAX loads when clicked.
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const TARGET_URL = 'https://www.foody.vn/can-tho/dia-diem';
const dbHelper = require('./dbHelper');
const MENUS_DIR = path.join(__dirname, 'menus');

function categorize(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('coffee') || n.includes('café') || n.includes('cà phê')) return 'Cà phê';
  if (n.includes('trà sữa') || n.includes('milk tea')) return 'Trà sữa';
  if (n.includes('bún bò')) return 'Bún Bò';
  if (n.includes('hủ tiếu')) return 'Hủ Tiếu';
  if (n.includes('bánh mì')) return 'Bánh Mì';
  if (n.includes('lẩu')) return 'Lẩu';
  if (n.includes('pizza') || n.includes('burger')) return 'Fast Food';
  if (n.includes('cơm')) return 'Cơm tấm';
  return 'Đồ ăn';
}

function generateSimpleMenu(name) {
  const n = name.toLowerCase();
  const items = [];
  if (n.includes('cà phê') || n.includes('coffee') || n.includes('café')) {
    items.push({ name: 'Cà Phê Sữa Đá', price: 25000, appPrice: 32000, inStorePrice: 25000, description: 'Cà phê sữa đá truyền thống', img: '' });
    items.push({ name: 'Cà Phê Đen Đá', price: 20000, appPrice: 25600, inStorePrice: 20000, description: 'Cà phê đen nguyên chất', img: '' });
    items.push({ name: 'Bạc Xỉu', price: 28000, appPrice: 35800, inStorePrice: 28000, description: 'Bạc xỉu béo ngậy', img: '' });
    items.push({ name: 'Trà Đào Cam Sả', price: 30000, appPrice: 38400, inStorePrice: 30000, description: 'Trà đào cam sả tươi mát', img: '' });
  } else if (n.includes('trà sữa') || n.includes('milk tea')) {
    items.push({ name: 'Trà Sữa Truyền Thống', price: 25000, appPrice: 32000, inStorePrice: 25000, description: 'Trà sữa truyền thống thơm béo', img: '' });
    items.push({ name: 'Trà Sữa Matcha', price: 32000, appPrice: 41000, inStorePrice: 32000, description: 'Trà sữa vị matcha Nhật', img: '' });
    items.push({ name: 'Trà Sữa Socola', price: 30000, appPrice: 38400, inStorePrice: 30000, description: 'Trà sữa socola đậm vị', img: '' });
  } else {
    items.push({ name: `Đặc sản ${name.split('-')[0].trim().substring(0, 30)}`, price: 35000, appPrice: 44800, inStorePrice: 35000, description: 'Món đặc biệt của quán', img: '' });
    items.push({ name: 'Cơm Tấm Sườn Bì Chả', price: 35000, appPrice: 44800, inStorePrice: 35000, description: 'Cơm tấm sườn bì chả trứng', img: '' });
    items.push({ name: 'Bún Bò Huế', price: 30000, appPrice: 38400, inStorePrice: 30000, description: 'Bún bò Huế đặc biệt', img: '' });
    items.push({ name: 'Nước Ngọt', price: 10000, appPrice: 12800, inStorePrice: 10000, description: 'Pepsi / Coca / 7Up', img: '' });
  }
  return items;
}

async function run() {
  const startTime = Date.now();
  console.log(`\n[${new Date().toLocaleTimeString('vi-VN')}] [Crawler] 🚀 Starting Puppeteer crawl of ALL restaurants in Can Tho...`);
  console.log(`[Crawler] Target: ${TARGET_URL}\n`);

  if (!fs.existsSync(MENUS_DIR)) fs.mkdirSync(MENUS_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080', '--disable-gpu',
      '--disable-dev-shm-usage',
      '--js-flags=--max-old-space-size=4096',
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');

  // Block only images and media to save bandwidth (keep CSS/fonts/JS)
  await page.setRequestInterception(true);
  page.on('request', req => {
    const type = req.resourceType();
    if (['image', 'media'].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  // Navigate with retry
  console.log('[Crawler] Navigating to Foody.vn...');
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(TARGET_URL, { waitUntil: 'load', timeout: 90000 });
      // Wait extra time for Angular/jQuery to render content
      await new Promise(r => setTimeout(r, 8000));
      
      // Check if items loaded
      const itemCount = await page.evaluate(() => document.querySelectorAll('.row-item').length);
      if (itemCount > 0) {
        console.log(`[Crawler] Page loaded with ${itemCount} items (attempt ${attempt})`);
        break;
      }
      
      // Debug: check what's on the page
      const debugInfo = await page.evaluate(() => {
        return {
          title: document.title,
          bodyLen: document.body?.innerHTML?.length || 0,
          allDivs: document.querySelectorAll('div').length,
          anyItem: document.querySelector('[class*="item"]')?.className || 'none',
          anyList: document.querySelector('[class*="list"]')?.className || 'none',
          bodyText: document.body?.textContent?.substring(0, 300) || '',
        };
      });
      console.log(`[Crawler] Attempt ${attempt}: No .row-item found. Debug:`, JSON.stringify(debugInfo));
      
      if (attempt === 3) {
        // Last resort: save HTML for debugging
        const html = await page.content();
        const fs2 = require('fs');
        fs2.writeFileSync(path.join(__dirname, '_debug_page.html'), html, 'utf8');
        console.log('[Crawler] Saved debug HTML to _debug_page.html');
        throw new Error('No .row-item elements found after 3 attempts');
      }
      await new Promise(r => setTimeout(r, 5000));
    } catch(e) {
      console.log(`[Crawler] Attempt ${attempt} error: ${e.message}`);
      if (attempt === 3) throw e;
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  await new Promise(r => setTimeout(r, 2000));

  // Read total from load-more button
  const totalInfo = await page.evaluate(() => {
    const btn = document.querySelector('#scrollLoadingPage, .btn-load-more');
    const text = btn?.textContent || '';
    const match = text.match(/(\d[\d.]*)\s*\/\s*(\d[\d.]*)/);
    return {
      buttonText: text.trim(),
      current: match ? parseInt(match[1].replace(/\./g, '')) : 0,
      total: match ? parseInt(match[2].replace(/\./g, '')) : 0,
      items: document.querySelectorAll('.row-item').length,
    };
  });

  console.log(`[Crawler] Button text: "${totalInfo.buttonText}"`);
  console.log(`[Crawler] Total available: ${totalInfo.total} | Current: ${totalInfo.items}\n`);

  // Now repeatedly click load-more and scroll
  let prevCount = totalInfo.items;
  let noNewCount = 0;
  let clickCount = 0;
  const MAX_NO_NEW = 15;

  while (noNewCount < MAX_NO_NEW) {
    clickCount++;

    // Click the load-more button
    const clicked = await page.evaluate(() => {
      const btn = document.querySelector('#scrollLoadingPage, .btn-load-more');
      if (btn && btn.offsetParent !== null) {
        btn.click();
        return true;
      }
      // Also scroll to trigger any scroll-based loading
      window.scrollTo(0, document.body.scrollHeight);
      return false;
    });

    // Wait for content to load
    await new Promise(r => setTimeout(r, 1000));

    // Also scroll to ensure scroll-triggered loads
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(r => setTimeout(r, 500));

    const currentCount = await page.evaluate(() => document.querySelectorAll('.row-item').length);

    if (currentCount > prevCount) {
      const newItems = currentCount - prevCount;
      noNewCount = 0;
      prevCount = currentCount;

      if (clickCount <= 10 || clickCount % 25 === 0 || currentCount % 500 < 15) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const pct = totalInfo.total > 0 ? (currentCount / totalInfo.total * 100).toFixed(1) : '?';
        console.log(`[Click #${clickCount}] ${currentCount}/${totalInfo.total} items (${pct}%) | +${newItems} | ${elapsed}s`);
      }
    } else {
      noNewCount++;
      // Try scrolling to the button to make it visible
      if (noNewCount >= 3) {
        await page.evaluate(() => {
          const btn = document.querySelector('#scrollLoadingPage, .btn-load-more');
          if (btn) btn.scrollIntoView({ behavior: 'instant', block: 'center' });
        });
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // Safety: prevent memory issues by periodically checking
    if (clickCount % 100 === 0) {
      const memUsage = await page.evaluate(() => {
        if (performance.memory) {
          return (performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(0);
        }
        return 'N/A';
      });
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      console.log(`\n[Progress] Click #${clickCount}: ${prevCount} items | ${elapsed} min | Memory: ${memUsage}MB\n`);
    }
  }

  const finalCount = await page.evaluate(() => document.querySelectorAll('.row-item').length);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n[Crawler] ══════════════════════════════════════════`);
  console.log(`[Crawler] Scroll/click complete: ${finalCount} items in ${elapsed}s`);
  console.log(`[Crawler] ══════════════════════════════════════════\n`);

  // Extract all data from DOM
  console.log('[Crawler] Extracting restaurant data from DOM...');

  const rawData = await page.evaluate(() => {
    const items = document.querySelectorAll('.row-item');
    return Array.from(items).map((el, i) => {
      const titleEl = el.querySelector('h2 a, a[class*="title"]');
      const name = titleEl?.textContent?.trim() || '';
      const href = titleEl?.href || '';
      const addressEl = el.querySelector('.address, .row-item-address');
      const address = addressEl?.textContent?.trim()?.replace(/\s+/g, ' ')?.replace(/ ,/g, ',')?.trim() || '';
      const imgEl = el.querySelector('.ri-avatar img, .ldc-item-img img, img');
      let img = imgEl?.src || '';
      if (img.includes('ratin-rank') || img.includes('arrow-top') || img.includes('data:image')) img = '';
      const ratingEl = el.querySelector('.point, .highlight-text');
      const rating = parseFloat(ratingEl?.textContent?.trim()) || 0;
      const statsEl = el.querySelector('.stats a span');
      const reviews = parseInt(statsEl?.textContent?.trim()) || 0;
      return { name, href, address, img, rating, reviews };
    }).filter(d => d.name);
  });

  console.log(`[Crawler] Extracted ${rawData.length} restaurants from DOM`);
  await browser.close();

  // Deduplicate and process
  console.log('[Crawler] Deduplicating...');
  const uniqueMap = new Map();

  for (const raw of rawData) {
    let resId = 'r_ct_';
    if (raw.href) {
      try {
        const urlPath = new URL(raw.href).pathname;
        resId += urlPath.split('/').pop().replace(/-/g, '_');
      } catch {
        resId += raw.href.split('?')[0].split('/').pop().replace(/-/g, '_');
      }
    } else {
      resId += raw.name.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 40);
    }
    if (uniqueMap.has(resId)) continue;

    const rating = raw.rating > 0 ? raw.rating : parseFloat((4 + Math.random() * 1.5).toFixed(1));
    const reviews = raw.reviews > 0 ? raw.reviews : (50 + Math.floor(Math.random() * 400));
    const dv = (Math.random() * 4 + 0.3);

    uniqueMap.set(resId, {
      id: resId, name: raw.name, category: categorize(raw.name),
      rating, reviews,
      distance: dv.toFixed(1) + ' km',
      time: `${Math.round(dv * 5 + 10)}-${Math.round(dv * 5 + 20)} phút`,
      address: raw.address,
      phone: '0292 3' + Math.floor(100000 + Math.random() * 900000),
      img: raw.img || 'https://images.unsplash.com/photo-1625398407796-82650a8c135f?w=800&q=80',
      tags: [rating > 7.5 ? 'Nổi bật' : 'Đang mở', reviews > 400 ? 'Yêu thích' : 'Mới mở'],
      minOrder: 30000,
      hasRealMenu: false, menuTemplateFallback: true,
      foodyHref: raw.href,
    });
  }

  console.log(`[Crawler] ${uniqueMap.size} unique restaurants after dedup`);

  // Generate menus
  console.log('[Crawler] Generating menus...');
  let menuGenCount = 0;
  for (const [id, rest] of uniqueMap) {
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const menuPath = path.join(MENUS_DIR, `${safeId}.json`);
    let dishNames = [];

    if (fs.existsSync(menuPath)) {
      try {
        const menu = JSON.parse(fs.readFileSync(menuPath, 'utf8'));
        dishNames = menu.map(m => m.name).filter(Boolean);
        rest.hasRealMenu = true;
        rest.menuTemplateFallback = false;
      } catch (e) {}
    } else {
      const menu = generateSimpleMenu(rest.name);
      fs.writeFileSync(menuPath, JSON.stringify(menu, null, 2), 'utf8');
      dishNames = menu.map(m => m.name).filter(Boolean);
      menuGenCount++;
    }
    rest.dishNames = dishNames;
  }
  console.log(`[Crawler] Generated ${menuGenCount} new menu files`);

  // Merge with existing DB
  console.log('[Crawler] Merging with existing database...');
  let existing = [];
  try {
    existing = dbHelper.read();
  } catch (e) { existing = []; }

  const existingCount = existing.length;
  let newCount = 0, updatedCount = 0;

  for (const [, newRes] of uniqueMap) {
    const idx = existing.findIndex(r => String(r.id) === String(newRes.id));
    if (idx !== -1) {
      const old = existing[idx];
      if (old.hasRealMenu) { newRes.hasRealMenu = true; newRes.dishNames = old.dishNames || newRes.dishNames; delete newRes.menuTemplateFallback; }
      if (old.isClosed) { newRes.isClosed = old.isClosed; newRes.closedAt = old.closedAt; newRes.closedReason = old.closedReason; }
      if (old.menuUpdatedAt) newRes.menuUpdatedAt = old.menuUpdatedAt;
      if (old.shopeefoodSlug) newRes.shopeefoodSlug = old.shopeefoodSlug;
      existing[idx] = newRes;
      updatedCount++;
    } else {
      existing.push(newRes);
      newCount++;
    }
  }

  // Remove any leftover menu properties
  existing.forEach(r => { delete r.menu; });

  dbHelper.write(existing);

  const finalSize = (fs.statSync(dbHelper.getChunkPath(0)).size / 1024).toFixed(1);
  const menuFiles = fs.readdirSync(MENUS_DIR).filter(f => f.endsWith('.json')).length;
  const totalElapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  console.log(`\n[Crawler] ══════════════════════════════════════════════════`);
  console.log(`[Crawler] 💾 KẾT QUẢ CUỐI CÙNG:`);
  console.log(`[Crawler]    📦 Tổng quán trong database: ${existing.length}`);
  console.log(`[Crawler]    🆕 Quán mới thêm:           ${newCount}`);
  console.log(`[Crawler]    🔄 Quán cập nhật:           ${updatedCount}`);
  console.log(`[Crawler]    📂 Bảo tồn từ trước:        ${existingCount}`);
  console.log(`[Crawler]    📁 Menu files:              ${menuFiles}`);
  console.log(`[Crawler]    💾 DB size:                 ${finalSize} KB`);
  console.log(`[Crawler]    ⏱️ Thời gian:               ${totalElapsed} phút`);
  console.log(`[Crawler] ══════════════════════════════════════════════════`);

  process.exit(0);
}

run().catch(err => {
  console.error('[Crawler] ❌ Fatal:', err.message);
  process.exit(1);
});
