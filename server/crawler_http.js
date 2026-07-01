/**
 * Smart multi-category HTTP crawler for Foody.vn.
 * 
 * Strategy: 
 * - Use different category groups (food, drink, snack, coffee, etc.)
 * - Use different sort types (st=1 default, st=2 most reviewed, st=3 new, etc.)
 * - Each combination yields unique sets of 12 items per page
 * - Deduplicate across all results
 * 
 * Also try district-specific URLs for additional coverage.
 */
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const dbHelper = require('./dbHelper');
const MENUS_DIR = path.join(__dirname, 'menus');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'vi-VN,vi;q=0.9',
  'Cookie': 'flg=vn; floc=221',
};

// All possible URL patterns for Can Tho
const URL_PATTERNS = [
  // Main listing with different sort types
  { base: 'https://www.foody.vn/can-tho/dia-diem', params: { ds: 'Restaurant', vt: 'row', st: '1', provinceId: '221', categoryId: '' }, label: 'All - Default sort' },
  { base: 'https://www.foody.vn/can-tho/dia-diem', params: { ds: 'Restaurant', vt: 'row', st: '2', provinceId: '221', categoryId: '' }, label: 'All - Most reviews' },
  { base: 'https://www.foody.vn/can-tho/dia-diem', params: { ds: 'Restaurant', vt: 'row', st: '3', provinceId: '221', categoryId: '' }, label: 'All - Newest' },
  { base: 'https://www.foody.vn/can-tho/dia-diem', params: { ds: 'Restaurant', vt: 'row', st: '4', provinceId: '221', categoryId: '' }, label: 'All - Highest rated' },
  { base: 'https://www.foody.vn/can-tho/dia-diem', params: { ds: 'Restaurant', vt: 'row', st: '5', provinceId: '221', categoryId: '' }, label: 'All - Sort 5' },
  { base: 'https://www.foody.vn/can-tho/dia-diem', params: { ds: 'Restaurant', vt: 'row', st: '6', provinceId: '221', categoryId: '' }, label: 'All - Sort 6' },

  // Category-specific pages
  { base: 'https://www.foody.vn/can-tho/an-uong', params: {}, label: 'Ăn uống' },
  { base: 'https://www.foody.vn/can-tho/cafe', params: {}, label: 'Cafe' },
  { base: 'https://www.foody.vn/can-tho/tra-sua', params: {}, label: 'Trà sữa' },
  { base: 'https://www.foody.vn/can-tho/com-trua', params: {}, label: 'Cơm trưa' },
  { base: 'https://www.foody.vn/can-tho/an-vat', params: {}, label: 'Ăn vặt' },
  { base: 'https://www.foody.vn/can-tho/lau', params: {}, label: 'Lẩu' },
  { base: 'https://www.foody.vn/can-tho/pizza', params: {}, label: 'Pizza' },
  { base: 'https://www.foody.vn/can-tho/bun-pho', params: {}, label: 'Bún Phở' },
  { base: 'https://www.foody.vn/can-tho/com-tam', params: {}, label: 'Cơm tấm' },
  { base: 'https://www.foody.vn/can-tho/banh-mi', params: {}, label: 'Bánh mì' },
  { base: 'https://www.foody.vn/can-tho/hai-san', params: {}, label: 'Hải sản' },
  { base: 'https://www.foody.vn/can-tho/ga', params: {}, label: 'Gà' },
  { base: 'https://www.foody.vn/can-tho/chay', params: {}, label: 'Chay' },
  { base: 'https://www.foody.vn/can-tho/do-uong', params: {}, label: 'Đồ uống' },
  { base: 'https://www.foody.vn/can-tho/banh-kem', params: {}, label: 'Bánh kem' },
  { base: 'https://www.foody.vn/can-tho/nuoc-ep', params: {}, label: 'Nước ép' },
  { base: 'https://www.foody.vn/can-tho/nha-hang', params: {}, label: 'Nhà hàng' },
  { base: 'https://www.foody.vn/can-tho/buffet', params: {}, label: 'Buffet' },
  { base: 'https://www.foody.vn/can-tho/kem', params: {}, label: 'Kem' },
  { base: 'https://www.foody.vn/can-tho/che', params: {}, label: 'Chè' },
  { base: 'https://www.foody.vn/can-tho/tiem-banh', params: {}, label: 'Tiệm bánh' },
  
  // District-specific pages
  { base: 'https://www.foody.vn/can-tho/quan-ninh-kieu/dia-diem', params: { ds: 'Restaurant', vt: 'row', st: '1', provinceId: '221' }, label: 'Q. Ninh Kiều' },
  { base: 'https://www.foody.vn/can-tho/quan-cai-rang/dia-diem', params: { ds: 'Restaurant', vt: 'row', st: '1', provinceId: '221' }, label: 'Q. Cái Răng' },
  { base: 'https://www.foody.vn/can-tho/quan-binh-thuy/dia-diem', params: { ds: 'Restaurant', vt: 'row', st: '1', provinceId: '221' }, label: 'Q. Bình Thủy' },
  { base: 'https://www.foody.vn/can-tho/quan-o-mon/dia-diem', params: { ds: 'Restaurant', vt: 'row', st: '1', provinceId: '221' }, label: 'Q. Ô Môn' },
  { base: 'https://www.foody.vn/can-tho/quan-thot-not/dia-diem', params: { ds: 'Restaurant', vt: 'row', st: '1', provinceId: '221' }, label: 'Q. Thốt Nốt' },
  { base: 'https://www.foody.vn/can-tho/huyen-phong-dien/dia-diem', params: { ds: 'Restaurant', vt: 'row', st: '1', provinceId: '221' }, label: 'H. Phong Điền' },
  { base: 'https://www.foody.vn/can-tho/huyen-co-do/dia-diem', params: { ds: 'Restaurant', vt: 'row', st: '1', provinceId: '221' }, label: 'H. Cờ Đỏ' },
  { base: 'https://www.foody.vn/can-tho/huyen-vinh-thanh/dia-diem', params: { ds: 'Restaurant', vt: 'row', st: '1', provinceId: '221' }, label: 'H. Vĩnh Thạnh' },
  { base: 'https://www.foody.vn/can-tho/huyen-thoi-lai/dia-diem', params: { ds: 'Restaurant', vt: 'row', st: '1', provinceId: '221' }, label: 'H. Thới Lai' },
];

// Max pages to try per URL pattern
const MAX_PAGES_PER_PATTERN = 20;
const DELAY_MS = 300;

function parseRestaurants(html) {
  const $ = cheerio.load(html);
  const items = [];
  
  // Try .row-item selector (main listing)
  $('.row-item').each((i, el) => {
    const titleEl = $(el).find('h2 a');
    const name = titleEl.text().trim();
    const href = titleEl.attr('href') || '';
    const address = $(el).find('.address').text().trim().replace(/\s+/g, ' ');
    let img = $(el).find('img').first().attr('src') || '';
    if (img.includes('ratin-rank') || img.includes('arrow') || img.includes('data:image')) img = '';
    const rating = parseFloat($(el).find('.point').text().trim()) || 0;
    const reviews = parseInt($(el).find('.stats a span').text().trim()) || 0;
    if (name) items.push({ name, href, address, img, rating, reviews });
  });
  
  // Also try .ldc-item selector (district pages)
  if (items.length === 0) {
    $('.ldc-item').each((i, el) => {
      const titleEl = $(el).find('.ldc-item-title a, h2 a, a');
      const name = titleEl.text().trim();
      const href = titleEl.attr('href') || '';
      const address = $(el).find('.ldc-item-address, .address').text().trim().replace(/\s+/g, ' ');
      let img = $(el).find('img').first().attr('src') || '';
      if (img.includes('ratin-rank') || img.includes('data:image')) img = '';
      if (name) items.push({ name, href, address, img, rating: 0, reviews: 0 });
    });
  }
  
  // Also try microsite listing
  if (items.length === 0) {
    $('[class*="microsite"] a, .micro-list a, .search-result-item').each((i, el) => {
      const name = $(el).text().trim().split('\n')[0];
      const href = $(el).attr('href') || '';
      if (name && name.length > 3 && name.length < 100) {
        items.push({ name, href, address: '', img: '', rating: 0, reviews: 0 });
      }
    });
  }
  
  return items;
}

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
  if (n.includes('chè') || n.includes('kem')) return 'Tráng miệng';
  if (n.includes('bánh') || n.includes('cake')) return 'Bánh';
  if (n.includes('bún') || n.includes('phở')) return 'Bún/Phở';
  if (n.includes('gà') || n.includes('chicken')) return 'Gà';
  if (n.includes('hải sản') || n.includes('seafood')) return 'Hải sản';
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
    const shortName = name.split('-')[0].trim().substring(0, 30);
    items.push({ name: `Đặc sản ${shortName}`, price: 35000, appPrice: 44800, inStorePrice: 35000, description: 'Món đặc biệt của quán', img: '' });
    items.push({ name: 'Cơm Tấm Sườn Bì Chả', price: 35000, appPrice: 44800, inStorePrice: 35000, description: 'Cơm tấm sườn bì chả trứng', img: '' });
    items.push({ name: 'Bún Bò Huế', price: 30000, appPrice: 38400, inStorePrice: 30000, description: 'Bún bò Huế đặc biệt', img: '' });
    items.push({ name: 'Nước Ngọt', price: 10000, appPrice: 12800, inStorePrice: 10000, description: 'Pepsi / Coca / 7Up', img: '' });
  }
  return items;
}

async function run() {
  const startTime = Date.now();
  console.log(`\n[${new Date().toLocaleTimeString('vi-VN')}] [Crawler] 🚀 Starting multi-category HTTP crawl...`);
  console.log(`[Crawler] Patterns: ${URL_PATTERNS.length} | Max ${MAX_PAGES_PER_PATTERN} pages each\n`);

  if (!fs.existsSync(MENUS_DIR)) fs.mkdirSync(MENUS_DIR, { recursive: true });

  const allItems = new Map(); // href -> restaurant data (for dedup)
  let totalFetched = 0;

  for (let pi = 0; pi < URL_PATTERNS.length; pi++) {
    const pattern = URL_PATTERNS[pi];
    const prevUnique = allItems.size;
    let consecutiveEmpty = 0;
    let consecutiveDup = 0;
    
    for (let page = 1; page <= MAX_PAGES_PER_PATTERN; page++) {
      const params = new URLSearchParams({ ...pattern.params, page: String(page) });
      const url = `${pattern.base}?${params.toString()}`;
      
      try {
        const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
        if (!res.ok) {
          console.log(`  [${pattern.label}] Page ${page}: HTTP ${res.status}`);
          break;
        }
        
        const html = await res.text();
        const items = parseRestaurants(html);
        totalFetched += items.length;
        
        if (items.length === 0) {
          consecutiveEmpty++;
          if (consecutiveEmpty >= 2) break;
          continue;
        }
        
        let newCount = 0;
        for (const item of items) {
          // Normalize href for dedup
          const key = item.href || item.name;
          if (!allItems.has(key)) {
            allItems.set(key, item);
            newCount++;
          }
        }
        
        if (newCount === 0) {
          consecutiveDup++;
          if (consecutiveDup >= 3) break;
        } else {
          consecutiveDup = 0;
          consecutiveEmpty = 0;
        }
        
      } catch(err) {
        if (err.name === 'TimeoutError') {
          console.log(`  [${pattern.label}] Page ${page}: Timeout`);
        }
        break;
      }
      
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
    
    const gained = allItems.size - prevUnique;
    if (gained > 0) {
      console.log(`[${pi + 1}/${URL_PATTERNS.length}] ${pattern.label}: +${gained} new | Total unique: ${allItems.size}`);
    } else {
      console.log(`[${pi + 1}/${URL_PATTERNS.length}] ${pattern.label}: no new items`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n[Crawler] ══════════════════════════════════════════`);
  console.log(`[Crawler] HTTP crawl complete: ${allItems.size} unique / ${totalFetched} fetched in ${elapsed}s`);
  console.log(`[Crawler] ══════════════════════════════════════════\n`);

  // Process and save
  console.log('[Crawler] Processing restaurants...');
  
  const newRestaurants = [];
  for (const [key, raw] of allItems) {
    let resId = 'r_ct_';
    if (raw.href) {
      try {
        const urlPath = new URL(raw.href.startsWith('http') ? raw.href : `https://www.foody.vn${raw.href}`).pathname;
        resId += urlPath.split('/').pop().replace(/-/g, '_');
      } catch {
        resId += raw.href.split('?')[0].split('/').pop().replace(/-/g, '_');
      }
    } else {
      resId += raw.name.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 40);
    }

    const rating = raw.rating > 0 ? raw.rating : parseFloat((4 + Math.random() * 1.5).toFixed(1));
    const reviews = raw.reviews > 0 ? raw.reviews : (50 + Math.floor(Math.random() * 400));
    const dv = (Math.random() * 4 + 0.3);

    newRestaurants.push({
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

  // Generate menus
  console.log('[Crawler] Generating menus...');
  let menuGenCount = 0;
  for (const rest of newRestaurants) {
    const safeId = rest.id.replace(/[^a-zA-Z0-9_-]/g, '_');
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
  const existingIds = new Set(existing.map(r => r.id));
  let newCount = 0, updatedCount = 0;

  for (const newRes of newRestaurants) {
    const idx = existing.findIndex(r => r.id === newRes.id);
    if (idx !== -1) {
      const old = existing[idx];
      if (old.hasRealMenu) { newRes.hasRealMenu = true; newRes.dishNames = old.dishNames || newRes.dishNames; delete newRes.menuTemplateFallback; }
      if (old.isClosed) { newRes.isClosed = old.isClosed; }
      if (old.menuUpdatedAt) newRes.menuUpdatedAt = old.menuUpdatedAt;
      existing[idx] = newRes;
      updatedCount++;
    } else {
      existing.push(newRes);
      newCount++;
    }
  }

  existing.forEach(r => { delete r.menu; });
  dbHelper.write(existing);

  const finalSize = (fs.statSync(dbHelper.getChunkPath(0)).size / 1024).toFixed(1);
  const menuFiles = fs.readdirSync(MENUS_DIR).filter(f => f.endsWith('.json')).length;
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n[Crawler] ══════════════════════════════════════════════════`);
  console.log(`[Crawler] 💾 KẾT QUẢ CUỐI CÙNG:`);
  console.log(`[Crawler]    📦 Tổng quán trong database: ${existing.length}`);
  console.log(`[Crawler]    🆕 Quán mới thêm:           ${newCount}`);
  console.log(`[Crawler]    🔄 Quán cập nhật:           ${updatedCount}`);
  console.log(`[Crawler]    📂 Bảo tồn từ trước:        ${existingCount}`);
  console.log(`[Crawler]    📁 Menu files:              ${menuFiles}`);
  console.log(`[Crawler]    💾 DB size:                 ${finalSize} KB`);
  console.log(`[Crawler]    ⏱️ Thời gian:               ${totalElapsed}s`);
  console.log(`[Crawler] ══════════════════════════════════════════════════`);

  process.exit(0);
}

run().catch(err => {
  console.error('[Crawler] ❌ Fatal:', err.message);
  process.exit(1);
});
