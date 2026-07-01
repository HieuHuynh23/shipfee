/**
 * Keyword-based crawler for Foody.vn Can Tho.
 * Searches for hundreds of Vietnamese food/drink keywords to discover restaurants.
 * Each keyword returns a different set of up to 60 results.
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

// Vietnamese food/drink/restaurant keywords
const KEYWORDS = [
  // Món chính
  'cơm', 'phở', 'bún', 'mì', 'hủ tiếu', 'cháo', 'xôi', 'bánh canh', 'bánh cuốn',
  'bánh mì', 'bánh xèo', 'bánh tráng', 'bánh bao', 'bánh bèo', 'bánh khọt',
  'cơm tấm', 'cơm gà', 'cơm chiên', 'cơm niêu', 'cơm rang', 'cơm văn phòng',
  'bún bò', 'bún riêu', 'bún chả', 'bún mắm', 'bún thịt nướng', 'bún đậu',
  'phở bò', 'phở gà', 'mì quảng', 'mì xào', 'mì cay',
  // Đồ ăn nhanh
  'pizza', 'burger', 'gà rán', 'khoai tây', 'hotdog', 'sandwich',
  'sushi', 'sashimi', 'tokbokki', 'kimbap', 'ramen',
  // Protein
  'gà', 'vịt', 'heo', 'bò', 'cá', 'tôm', 'cua', 'mực', 'ốc',
  'gà nướng', 'gà chiên', 'sườn', 'thịt nướng', 'thịt kho',
  'hải sản', 'lươn', 'ếch', 'dê', 'bê', 'bồ câu',
  // Lẩu / Nướng
  'lẩu', 'nướng', 'BBQ', 'buffet', 'lẩu thái', 'lẩu hải sản', 'lẩu gà',
  'nướng hàn quốc', 'nướng nhật', 'xiên nướng', 'thịt nướng',
  // Đồ uống
  'cà phê', 'coffee', 'cafe', 'trà sữa', 'trà', 'nước ép', 'sinh tố',
  'bia', 'rượu', 'cocktail', 'smoothie', 'matcha', 'sữa chua',
  'nước mía', 'trà đào', 'trà vải', 'trà chanh',
  // Tráng miệng
  'kem', 'chè', 'bánh', 'yogurt', 'pudding', 'flan', 'mousse',
  'bánh kem', 'tiramisu', 'macaron', 'donut', 'waffle', 'crepe',
  // Ăn vặt
  'ăn vặt', 'snack', 'xiên que', 'dimsum', 'há cảo', 'hoành thánh',
  'nem', 'chả giò', 'gỏi cuốn', 'bò bía', 'tokbokki',
  // Loại quán
  'nhà hàng', 'quán ăn', 'quán nhậu', 'quán nướng', 'quán chay',
  'tiệm', 'quán cơm', 'quán bún', 'quán phở', 'quán cafe',
  'beer club', 'bar', 'pub', 'karaoke',
  // Thương hiệu lớn
  'highlands', 'phúc long', 'the coffee house', 'tocotoco', 'gong cha',
  'kfc', 'lotteria', 'jollibee', 'mcdonalds', 'dominos',
  'pizza hut', 'burger king', 'starbucks', 'circle k',
  // Ẩm thực vùng miền
  'huế', 'đà nẵng', 'sài gòn', 'hà nội', 'miền tây', 'miền trung',
  'thái', 'hàn quốc', 'nhật bản', 'trung quốc', 'ý', 'pháp',
  'ấn độ', 'mexico', 'đài loan', 'hồng kông',
  // Đặc sản Cần Thơ
  'bánh tầm', 'lẩu mắm', 'cá lóc', 'cá kèo', 'cá linh',
  'bánh cống', 'bún mắm', 'bún nước lèo', 'hủ tiếu nam vang',
  'lẩu cá kèo', 'cơm cháy', 'gỏi', 'canh chua',
  // Chữ cái / Tên phổ biến
  'quán A', 'quán B', 'quán C', 'quán D', 'quán E',
  'quán ngon', 'quán mới', 'quán đẹp', 'quán hot',
  // Phong cách
  'chay', 'organic', 'healthy', 'diet', 'vegetarian', 'vegan',
  // Thêm từ khóa phổ biến
  'trưa', 'sáng', 'tối', 'khuya', 'delivery', 'giao hàng',
  'giá rẻ', 'ngon', 'mới mở', 'khuyến mãi', 'giảm giá',
  // Đường phố phổ biến ở Cần Thơ
  'Ninh Kiều', 'Cái Răng', 'Bình Thủy', 'Ô Môn', 'Thốt Nốt',
  '30 tháng 4', 'Nguyễn Văn Cừ', 'Trần Hưng Đạo', 'Mậu Thân',
  'Hòa Bình', 'Phan Đình Phùng', 'Lý Tự Trọng', 'Nguyễn Trãi',
  '3 tháng 2', 'CMT8', 'Đại lộ Hòa Bình', 'Trần Phú',
  'Võ Văn Kiệt', 'Nguyễn Văn Linh', 'Cách Mạng',
];

const MAX_PAGES_PER_KEYWORD = 5;
const DELAY_MS = 250;

function parseRestaurants(html) {
  const $ = cheerio.load(html);
  const items = [];
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
  return items;
}

function categorize(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('coffee') || n.includes('café') || n.includes('cà phê') || n.includes('cafe')) return 'Cà phê';
  if (n.includes('trà sữa') || n.includes('milk tea')) return 'Trà sữa';
  if (n.includes('bún bò')) return 'Bún Bò';
  if (n.includes('hủ tiếu')) return 'Hủ Tiếu';
  if (n.includes('bánh mì')) return 'Bánh Mì';
  if (n.includes('lẩu')) return 'Lẩu';
  if (n.includes('pizza') || n.includes('burger')) return 'Fast Food';
  if (n.includes('cơm')) return 'Cơm tấm';
  if (n.includes('chè') || n.includes('kem')) return 'Tráng miệng';
  if (n.includes('bún') || n.includes('phở') || n.includes('mì')) return 'Bún/Phở';
  if (n.includes('gà') || n.includes('chicken')) return 'Gà';
  if (n.includes('nướng') || n.includes('bbq')) return 'Nướng/BBQ';
  if (n.includes('hải sản')) return 'Hải sản';
  if (n.includes('nhà hàng')) return 'Nhà hàng';
  if (n.includes('chay')) return 'Chay';
  return 'Đồ ăn';
}

function generateSimpleMenu(name) {
  const n = name.toLowerCase();
  if (n.includes('cà phê') || n.includes('coffee') || n.includes('café') || n.includes('cafe')) {
    return [
      { name: 'Cà Phê Sữa Đá', price: 25000, appPrice: 32000, inStorePrice: 25000, description: 'Cà phê sữa đá truyền thống', img: '' },
      { name: 'Cà Phê Đen Đá', price: 20000, appPrice: 25600, inStorePrice: 20000, description: 'Cà phê đen nguyên chất', img: '' },
      { name: 'Bạc Xỉu', price: 28000, appPrice: 35800, inStorePrice: 28000, description: 'Bạc xỉu béo ngậy', img: '' },
      { name: 'Trà Đào Cam Sả', price: 30000, appPrice: 38400, inStorePrice: 30000, description: 'Trà đào cam sả tươi mát', img: '' },
    ];
  }
  if (n.includes('trà sữa') || n.includes('milk tea')) {
    return [
      { name: 'Trà Sữa Truyền Thống', price: 25000, appPrice: 32000, inStorePrice: 25000, description: 'Trà sữa truyền thống', img: '' },
      { name: 'Trà Sữa Matcha', price: 32000, appPrice: 41000, inStorePrice: 32000, description: 'Trà sữa vị matcha Nhật', img: '' },
      { name: 'Trà Sữa Socola', price: 30000, appPrice: 38400, inStorePrice: 30000, description: 'Trà sữa socola đậm vị', img: '' },
    ];
  }
  const shortName = name.split('-')[0].trim().substring(0, 30);
  return [
    { name: `Đặc sản ${shortName}`, price: 35000, appPrice: 44800, inStorePrice: 35000, description: 'Món đặc biệt của quán', img: '' },
    { name: 'Cơm Tấm Sườn Bì Chả', price: 35000, appPrice: 44800, inStorePrice: 35000, description: 'Cơm tấm sườn bì chả trứng', img: '' },
    { name: 'Bún Bò Huế', price: 30000, appPrice: 38400, inStorePrice: 30000, description: 'Bún bò Huế đặc biệt', img: '' },
    { name: 'Nước Ngọt', price: 10000, appPrice: 12800, inStorePrice: 10000, description: 'Pepsi / Coca / 7Up', img: '' },
  ];
}

async function run() {
  const startTime = Date.now();
  console.log(`\n[${new Date().toLocaleTimeString('vi-VN')}] [Keyword Crawler] 🚀 Starting keyword-based crawl...`);
  console.log(`[Crawler] Keywords: ${KEYWORDS.length} | Max ${MAX_PAGES_PER_KEYWORD} pages each\n`);

  if (!fs.existsSync(MENUS_DIR)) fs.mkdirSync(MENUS_DIR, { recursive: true });

  const allItems = new Map(); // href -> restaurant data
  let totalFetched = 0;
  let keywordsWithNew = 0;

  for (let ki = 0; ki < KEYWORDS.length; ki++) {
    const keyword = KEYWORDS[ki];
    const prevUnique = allItems.size;
    let consecutiveDup = 0;

    for (let page = 1; page <= MAX_PAGES_PER_KEYWORD; page++) {
      const url = `https://www.foody.vn/can-tho/dia-diem?q=${encodeURIComponent(keyword)}&ds=Restaurant&vt=row&st=1&page=${page}&provinceId=221`;
      
      try {
        const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
        if (!res.ok) break;
        
        const html = await res.text();
        const items = parseRestaurants(html);
        totalFetched += items.length;
        
        if (items.length === 0) break;
        
        let newCount = 0;
        for (const item of items) {
          const key = item.href || item.name;
          if (!allItems.has(key)) {
            allItems.set(key, item);
            newCount++;
          }
        }
        
        if (newCount === 0) {
          consecutiveDup++;
          if (consecutiveDup >= 2) break;
        } else {
          consecutiveDup = 0;
        }
        
      } catch(err) {
        break;
      }
      
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
    
    const gained = allItems.size - prevUnique;
    if (gained > 0) {
      keywordsWithNew++;
      if (ki < 20 || gained >= 5 || ki % 20 === 0) {
        console.log(`[${ki + 1}/${KEYWORDS.length}] "${keyword}": +${gained} new | Total: ${allItems.size}`);
      }
    }
    
    // Progress report every 30 keywords
    if ((ki + 1) % 30 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`\n[Progress] ${ki + 1}/${KEYWORDS.length} keywords | ${allItems.size} unique | ${elapsed}s\n`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n[Crawler] ══════════════════════════════════════════`);
  console.log(`[Crawler] Keyword crawl complete: ${allItems.size} unique from ${totalFetched} fetched`);
  console.log(`[Crawler] Keywords with new results: ${keywordsWithNew}/${KEYWORDS.length}`);
  console.log(`[Crawler] Time: ${elapsed}s`);
  console.log(`[Crawler] ══════════════════════════════════════════\n`);

  // Process
  console.log('[Crawler] Processing and merging...');
  
  let existing = [];
  try {
    existing = dbHelper.read();
  } catch (e) { existing = []; }

  const existingCount = existing.length;
  const existingIds = new Set(existing.map(r => r.id));
  let newCount = 0, updatedCount = 0, menuGenCount = 0;

  for (const [key, raw] of allItems) {
    let resId = 'r_ct_';
    if (raw.href) {
      try {
        const href = raw.href.startsWith('http') ? raw.href : `https://www.foody.vn${raw.href}`;
        resId += new URL(href).pathname.split('/').pop().replace(/-/g, '_');
      } catch {
        resId += raw.href.split('?')[0].split('/').pop().replace(/-/g, '_');
      }
    } else {
      resId += raw.name.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 40);
    }

    const rating = raw.rating > 0 ? raw.rating : parseFloat((4 + Math.random() * 1.5).toFixed(1));
    const reviews = raw.reviews > 0 ? raw.reviews : (50 + Math.floor(Math.random() * 400));
    const dv = (Math.random() * 4 + 0.3);

    const newRes = {
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
    };

    // Generate menu if not exists
    const safeId = resId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const menuPath = path.join(MENUS_DIR, `${safeId}.json`);
    if (fs.existsSync(menuPath)) {
      try {
        const menu = JSON.parse(fs.readFileSync(menuPath, 'utf8'));
        newRes.dishNames = menu.map(m => m.name).filter(Boolean);
        newRes.hasRealMenu = true;
        delete newRes.menuTemplateFallback;
      } catch (e) { newRes.dishNames = []; }
    } else {
      const menu = generateSimpleMenu(raw.name);
      fs.writeFileSync(menuPath, JSON.stringify(menu, null, 2), 'utf8');
      newRes.dishNames = menu.map(m => m.name).filter(Boolean);
      menuGenCount++;
    }

    // Merge
    const idx = existing.findIndex(r => r.id === resId);
    if (idx !== -1) {
      const old = existing[idx];
      if (old.hasRealMenu) { newRes.hasRealMenu = true; newRes.dishNames = old.dishNames || newRes.dishNames; delete newRes.menuTemplateFallback; }
      if (old.isClosed) newRes.isClosed = old.isClosed;
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
  console.log(`[Crawler]    📁 Menu files mới:          ${menuGenCount}`);
  console.log(`[Crawler]    📁 Tổng menu files:         ${menuFiles}`);
  console.log(`[Crawler]    💾 DB size:                 ${finalSize} KB`);
  console.log(`[Crawler]    ⏱️ Thời gian:               ${totalElapsed}s`);
  console.log(`[Crawler] ══════════════════════════════════════════════════`);

  process.exit(0);
}

run().catch(err => {
  console.error('[Crawler] ❌ Fatal:', err.message);
  process.exit(1);
});
