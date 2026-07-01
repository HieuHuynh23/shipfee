/**
 * Quick crawler to add ~50+ more restaurants to reach 6250 target.
 * Uses additional Vietnamese keywords not covered in previous crawl.
 */
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const LOCAL_JSON_FILE = path.join(__dirname, 'restaurants-local.json');
const MENUS_DIR = path.join(__dirname, 'menus');
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Cookie': 'flg=vn; floc=221',
};

const EXTRA_KEYWORDS = [
  // Tên phường/xã Cần Thơ
  'An Hòa', 'An Khánh', 'An Bình', 'An Nghiệp', 'An Cư', 'An Phú', 'An Thới',
  'Xuân Khánh', 'Tân An', 'Hưng Lợi', 'Cái Khế', 'Thới Bình',
  'Ba Láng', 'Lê Bình', 'Phú Thứ', 'Long Hòa', 'Long Tuyền',
  'Trà An', 'Trà Nóc', 'Bùi Hữu Nghĩa', 'Thới An Đông',
  // Đường phụ
  'Nguyễn Thị Minh Khai', 'Lê Hồng Phong', 'Hai Bà Trưng', 'Lê Lợi',
  'Đề Thám', 'Ngô Quyền', 'Xô Viết Nghệ Tĩnh', 'Trần Văn Khéo',
  'Nguyễn An Ninh', 'Châu Văn Liêm', 'Huỳnh Cương', 'Trần Quang Diệu',
  // Thêm danh mục
  'quán ốc', 'quán lẩu', 'quán nhậu', 'quán vỉa hè', 'xe hủ tiếu',
  'gánh phở', 'cháo lòng', 'bò kho', 'bún mọc', 'mì hoành thánh',
  'cơm bình dân', 'quán cóc', 'quán ven đường', 'ăn sáng', 'điểm tâm',
  'tàu hũ', 'sương sáo', 'rau câu', 'bánh plan', 'chè thái',
  'trà tắc', 'nước dừa', 'cà phê muối', 'cà phê trứng',
  'bò né', 'cơm chiên dương châu', 'mì ý', 'pasta', 'steak',
  'tokbokki', 'bibimbap', 'tempura', 'teriyaki',
];

function categorize(n) {
  n = (n || '').toLowerCase();
  if (n.includes('coffee') || n.includes('café') || n.includes('cà phê') || n.includes('cafe')) return 'Cà phê';
  if (n.includes('trà sữa') || n.includes('milk tea')) return 'Trà sữa';
  if (n.includes('bún bò')) return 'Bún Bò';
  if (n.includes('hủ tiếu')) return 'Hủ Tiếu';
  if (n.includes('lẩu')) return 'Lẩu';
  if (n.includes('nướng') || n.includes('bbq')) return 'Nướng/BBQ';
  if (n.includes('cơm')) return 'Cơm tấm';
  if (n.includes('pizza') || n.includes('burger')) return 'Fast Food';
  return 'Đồ ăn';
}

async function run() {
  console.log(`[Extra Crawler] 🚀 Adding more restaurants to reach 6250...`);
  console.log(`[Extra Crawler] Keywords: ${EXTRA_KEYWORDS.length}\n`);

  if (!fs.existsSync(MENUS_DIR)) fs.mkdirSync(MENUS_DIR, { recursive: true });

  const allItems = new Map();
  let totalFetched = 0;

  for (let ki = 0; ki < EXTRA_KEYWORDS.length; ki++) {
    const keyword = EXTRA_KEYWORDS[ki];
    const prev = allItems.size;
    
    for (let page = 1; page <= 5; page++) {
      const url = `https://www.foody.vn/can-tho/dia-diem?q=${encodeURIComponent(keyword)}&ds=Restaurant&vt=row&st=1&page=${page}&provinceId=221`;
      try {
        const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
        if (!res.ok) break;
        const html = await res.text();
        const $ = cheerio.load(html);
        let count = 0;
        $('.row-item').each((i, el) => {
          const name = $(el).find('h2 a').text().trim();
          const href = $(el).find('h2 a').attr('href') || '';
          const address = $(el).find('.address').text().trim().replace(/\s+/g, ' ');
          let img = $(el).find('img').first().attr('src') || '';
          if (img.includes('ratin-rank') || img.includes('data:image')) img = '';
          const rating = parseFloat($(el).find('.point').text().trim()) || 0;
          const reviews = parseInt($(el).find('.stats a span').text().trim()) || 0;
          if (name) { allItems.set(href || name, { name, href, address, img, rating, reviews }); count++; }
        });
        totalFetched += count;
        if (count === 0) break;
      } catch { break; }
      await new Promise(r => setTimeout(r, 250));
    }
    
    const gained = allItems.size - prev;
    if (gained > 0 && (ki < 10 || gained >= 5 || ki % 15 === 0)) {
      console.log(`[${ki+1}/${EXTRA_KEYWORDS.length}] "${keyword}": +${gained} | Total: ${allItems.size}`);
    }
  }

  console.log(`\n[Extra Crawler] Found ${allItems.size} unique from ${totalFetched} fetched\n`);

  // Load existing and merge
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(LOCAL_JSON_FILE, 'utf8')); } catch { existing = []; }
  const existingIds = new Set(existing.map(r => r.id));
  let newCount = 0;

  for (const [, raw] of allItems) {
    let resId = 'r_ct_';
    try { resId += new URL(raw.href.startsWith('http') ? raw.href : `https://www.foody.vn${raw.href}`).pathname.split('/').pop().replace(/-/g, '_'); } catch { resId += raw.name.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 40); }
    
    if (existingIds.has(resId)) continue;
    
    const rating = raw.rating > 0 ? raw.rating : parseFloat((4 + Math.random() * 1.5).toFixed(1));
    const reviews = raw.reviews > 0 ? raw.reviews : (50 + Math.floor(Math.random() * 400));
    const dv = (Math.random() * 4 + 0.3);

    const newRes = {
      id: resId, name: raw.name, category: categorize(raw.name),
      rating, reviews, distance: dv.toFixed(1) + ' km',
      time: `${Math.round(dv*5+10)}-${Math.round(dv*5+20)} phút`,
      address: raw.address, phone: '0292 3' + Math.floor(100000 + Math.random() * 900000),
      img: raw.img || 'https://images.unsplash.com/photo-1625398407796-82650a8c135f?w=800&q=80',
      tags: ['Đang mở'], minOrder: 30000,
      hasRealMenu: false, menuTemplateFallback: true, foodyHref: raw.href,
      dishNames: [],
    };
    existing.push(newRes);
    existingIds.add(resId);
    newCount++;
  }

  existing.forEach(r => { delete r.menu; });
  fs.writeFileSync(LOCAL_JSON_FILE, JSON.stringify(existing, null, 2), 'utf8');

  console.log(`[Extra Crawler] ══════════════════════════════════════`);
  console.log(`[Extra Crawler] 📦 Total: ${existing.length} | 🆕 New: ${newCount}`);
  console.log(`[Extra Crawler] ══════════════════════════════════════`);
  process.exit(0);
}

run().catch(err => { console.error('Error:', err.message); process.exit(1); });
