/**
 * ShipFee — Proxy Server
 * Tự động lấy data quán ăn từ ShopeeFood Cần Thơ
 * Cache 10 phút, fallback về data local nếu API fail
 */

const express     = require('express');
const cors        = require('cors');
const compression = require('compression');
const axios       = require('axios');
const fs          = require('fs');
const path        = require('path');
const { exec }    = require('child_process');
const cheerio     = require('cheerio');
const menuScraper = require('./menuScraper');

// ── PRICING CONFIG (Admin-adjustable) ────────────────────────────────────────
const PRICING_CONFIG = {
  MARKUP_RATE: 0.28,           // 28% markup trên giá gốc
  FREE_DISTANCE_KM: 1.5,      // Miễn phụ thu dưới 1.5km
  SURCHARGE_COEFFICIENT: 7000, // Hệ số đường cong sqrt
  MIN_SHIPPER_EARNING: 15000,  // Sàn thu nhập shipper/đơn (đ)
  MULTI_ITEM_DISCOUNT: 0.15,   // 15% giảm surcharge cho món 2+
};

// Helper: Làm tròn đến 100đ
function round100(value) {
  return Math.round(value / 100) * 100;
}

// Helper: Tính giá app từ giá gốc (markup 28%)
function calcAppPrice(inStorePrice) {
  return round100(inStorePrice * (1 + PRICING_CONFIG.MARKUP_RATE));
}

// ── CONCURRENCY LIMITER & REQUEST COLLAPSING ────────────────────────────────
class ConcurrencyLimiter {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
    this.activeCount = 0;
    this.queue = [];
  }

  async run(fn) {
    if (this.activeCount >= this.maxConcurrent) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.activeCount++;
    try {
      return await fn();
    } finally {
      this.activeCount--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        next();
      }
    }
  }
}

const scraperLimiter = new ConcurrencyLimiter(3); // Giới hạn tối đa 3 trình duyệt Puppeteer chạy đồng thời toàn hệ thống
const ACTIVE_SCRAPE_PROMISES = new Map(); // id -> Promise để gộp các request chi tiết trùng lặp (Request Collapsing)

const app  = express();
const PORT = 3001;

// ── PERFORMANCE MIDDLEWARE ───────────────────────────────────────────────────
// Gzip compression: giảm ~70% bandwidth cho tất cả JSON responses
app.use(compression({
  level: 6,          // Mức nén cân bằng tốc độ vs kích thước (1-9)
  threshold: 1024,   // Chỉ nén response > 1KB
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// CORS: cho phép localhost và các tên miền Vercel gọi API
const whitelist = [
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'https://shipfee.vercel.app'
];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    const isVercel = origin.endsWith('.vercel.app');
    const isWhitelisted = whitelist.indexOf(origin) !== -1;
    if (isWhitelisted || isVercel) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST'],
  optionsSuccessStatus: 200
}));

app.use(express.json());

function triggerCrawler() {
  console.log('[Server] Kích hoạt Crawler chạy ngầm để cập nhật dữ liệu từ Foody...');
  exec(`node "${path.join(__dirname, 'crawler.js')}"`, (err, stdout, stderr) => {
    if (err) {
      console.error('[Server] ❌ Lỗi khi chạy crawler ngầm:', err.message);
      return;
    }
    console.log('[Server] ✅ Crawler ngầm hoàn tất cập nhật dữ liệu!');
  });
}

function removeVietnameseTones(str) {
  if (!str) return '';
  str = str.replace(/à|á|ạ|ả|ã|â|ầ|ấ|ậ|ẩ|ẫ|ă|ằ|ắ|ặ|ẳ|ẵ/g, "a");
  str = str.replace(/è|é|ẹ|ẻ|ẽ|ê|ề|ế|ệ|ể|ễ/g, "e");
  str = str.replace(/ì|í|ị|ỉ|ĩ/g, "i");
  str = str.replace(/ò|ó|ọ|ỏ|õ|ô|ồ|ố|ộ|ổ|ỗ|ơ|ờ|ớ|ợ|ở|ỡ/g, "o");
  str = str.replace(/ù|ú|ụ|ủ|ũ|ư|ừ|ứ|ự|ử|ữ/g, "u");
  str = str.replace(/ỳ|ý|ỵ|ỷ|ỹ/g, "y");
  str = str.replace(/đ/g, "d");
  str = str.replace(/À|Á|Ạ|Ả|Ã|Â|Ầ|Ấ|Ậ|Ẩ|Ẫ|Ă|Ằ|Ắ|Ặ|Ẳ|Ẵ/g, "A");
  str = str.replace(/È|É|Ẹ|Ẻ|Ẽ|Ê|Ề|Ế|Ệ|Ể|Ễ/g, "E");
  str = str.replace(/Ì|Í|Ị|Ỉ|Ĩ/g, "I");
  str = str.replace(/Ò|Ó|Ọ|Ỏ|Õ|Ô|Ồ|Ố|Ộ|Ổ|Ỗ|Ơ|Ờ|Ớ|Ợ|Ở|Ỡ/g, "O");
  str = str.replace(/Ù|Ú|Ụ|Ủ|Ũ|Ư|Ừ|Ứ|Ự|Ử|Ữ/g, "U");
  str = str.replace(/Ỳ|Ý|Ỵ|Ỷ|Ỹ/g, "Y");
  str = str.replace(/Đ/g, "D");
  str = str.normalize('NFD').replace(/[\u0300-\u036f]/g, "");
  return str;
}

function normalizeText(str) {
  if (!str) return '';
  let res = str.toLowerCase();
  res = removeVietnameseTones(res);
  // Thay đổi y thành i để xử lý đồng âm
  res = res.replace(/y/g, 'i');
  // Thay thế ký tự đặc biệt thành khoảng trắng
  res = res.replace(/[^a-z0-9\s]/g, ' ');
  return res.trim().replace(/\s+/g, ' ');
}

function hasReopenTime(reason) {
  if (!reason) return false;
  const lower = reason.toLowerCase();
  
  const permanentKeywords = [
    'ngưng hoạt động',
    'không tồn tại',
    'địa điểm này chưa có',
    'bài viết không tồn tại',
    'chưa có dịch vụ',
    'tạm ngưng dịch vụ trực tuyến',
    'tạm ngưng hoạt động'
  ];
  if (permanentKeywords.some(kw => lower.includes(kw))) {
    return false;
  }

  const tempKeywords = [
    'ngày mai',
    'hôm sau',
    'giờ làm việc',
    'trở lại sau',
    'quay lại',
    'hẹn đơn',
    'mở cửa',
    'ngoài giờ',
    'khung giờ'
  ];
  
  const timePattern = /\d{1,2}[:h]\d{2}/;
  
  return tempKeywords.some(kw => lower.includes(kw)) || timePattern.test(lower);
}

function resetClosedIfNextAttemptReached(restaurant) {
  if (restaurant && restaurant.isClosed && restaurant.crawlNextAttempt) {
    if (new Date() >= new Date(restaurant.crawlNextAttempt)) {
      console.log(`[Database] 🔄 Resetting closed state for "${restaurant.name}" as crawlNextAttempt (${restaurant.crawlNextAttempt}) has been reached.`);
      restaurant.isClosed = false;
      delete restaurant.closedAt;
      delete restaurant.closedReason;
      delete restaurant.crawlNextAttempt;
      return true;
    }
  }
  return false;
}


// ── DYNAMIC MENU GENERATORS (Bản sao đồng bộ để chạy Search trực tiếp) ───────
const SEARCHED_RESTAURANTS_CACHE = new Map(); // id -> restaurant object

// Bản đồ dịch ngược Slug Hệ thống sang Slug chi nhánh ShopeeFood thực tế
const SLUG_REWRITER_MAP = {
  // Brand portals maps
  'he-thong-lumos-coffee-cake': 'lumos-bakery-joy-banh-au-tra',
  'he-thong-lau-bang-chuyen-kichi-kichi': 'kichi-kichi-lotte-mart-can-tho',
  'he-thong-quan-itada-am-thuc-han-quoc': 'itada-mi-cay-han-quoc-duong-3-thang-2',
  'jollibee-can-tho': 'ga-ran-va-mi-y-jollibee-duong-30-thang-4',
  'highlands-coffee-can-tho': 'highlands-coffee-go-can-tho',
  'kfc-can-tho': 'ga-ran-kfc-lotte-mart-can-tho',
  'lotteria-can-tho': 'ga-ran-burger-lotteria-can-tho-nguyen-van-cu',

  // Jollibee branch legacy slug maps
  'jollibee-duong-30-thang-4': 'ga-ran-va-mi-y-jollibee-duong-30-thang-4',
  'jollibee-cach-mang-thang-8': 'ga-ran-va-mi-y-jollibee-cach-mang-thang-8',
  'jollibee-ec-tran-hung-dao-can-tho': 'ga-ran-va-mi-y-jollibee-ec-tran-hung-dao-can-tho',
  'jollibee-ec-ba-thang-hai-can-tho': 'ga-ran-va-mi-y-jollibee-ec-ba-thang-hai-can-tho',
  'jollibee-nguyen-van-cu': 'ga-ran-va-mi-y-jollibee-nguyen-van-cu',
  'jollibee-ec-nguyen-van-cu-noi-dai-can-tho': 'ga-ran-va-my-y-jollibee-ec-nguyen-van-cu-noi-dai-can-tho',
  'jollibee-ec-sts-tower-hoa-binh': 'ga-ran-va-my-y-jollibee-ec-sts-tower-hoa-binh',

  // Highlands Coffee branch legacy slug maps
  'highlands-coffee-vincom-can-tho': 'highlands-coffee-tra-ca-phe-banh-vincom-can-tho',
  'highlands-coffee-go': 'highlands-coffee-go-can-tho',
  'highlands-coffee-nguyen-van-cu-can-tho': 'highlands-coffee-tra-ca-phe-banh-nguyen-van-cu-can-tho',
  'highlands-coffee-cv-song-hau-can-tho': 'highlands-coffee-tra-ca-phe-banh-cv-song-hau-can-tho',
  'highlands-coffee-huynh-cuong-can-tho': 'highlands-coffee-tra-ca-phe-banh-huynh-cuong-can-tho',
  'highlands-coffee-tra-ca-phe-banh-vincom-can-tho': 'highlands-coffee-tra-ca-phe-banh-vincom-can-tho',
  'highlands-coffee-tra-ca-phe-banh-lotte-mart-can-tho': 'highlands-coffee-tra-ca-phe-banh-lotte-mart-can-tho',
  'highlands-coffee-tra-ca-phe-banh-sense-city-can-tho': 'highlands-coffee-tra-ca-phe-banh-sense-city-can-tho',
  'highlands-coffee-tra-ca-phe-banh-vincom-xuan-khanh': 'highlands-coffee-tra-ca-phe-banh-vincom-xuan-khanh',
  'highlands-coffee-tra-ca-phe-banh-1-3-2-can-tho': 'highlands-coffee-tra-ca-phe-banh-1-3-2-can-tho',
  'highlands-coffee-tra-ca-phe-banh-nguyen-van-cu-can-tho': 'highlands-coffee-tra-ca-phe-banh-nguyen-van-cu-can-tho',
  'highlands-coffee-tra-ca-phe-banh-ttc-hotel-can-tho': 'highlands-coffee-tra-ca-phe-banh-ttc-hotel-can-tho',
  'highlands-coffee-tra-ca-phe-banh-cv-song-hau-can-tho': 'highlands-coffee-tra-ca-phe-banh-cv-song-hau-can-tho',
  'highlands-coffee-tra-ca-phe-banh-tran-van-kheo-can-tho': 'highlands-coffee-tra-ca-phe-banh-tran-van-kheo-can-tho',
  'highlands-coffee-tra-ca-phe-banh-huynh-cuong-can-tho': 'highlands-coffee-tra-ca-phe-banh-huynh-cuong-can-tho',
  'highlands-coffee-tra-ca-phe-banh-91-3-2-can-tho': 'highlands-coffee-tra-ca-phe-banh-91-3-2-can-tho',
  'highlands-coffee-tra-ca-phe-banh-bv-hoan-my-cuu-long': 'highlands-coffee-tra-ca-phe-banh-bv-hoan-my-cuu-long',

  // KFC branch legacy slug maps
  'kfc-big-c-hung-phu': 'ga-ran-kfc-big-c-hung-phu-can-tho',
  'kfc-tran-hoang-na': 'ga-ran-kfc-duong-tran-hoang-na-can-tho',
  'kfc-lotte-mart-can-tho': 'ga-ran-kfc-lotte-mart-can-tho',
  'ga-ran-kfc-vinmart-vinatex-can-tho': 'ga-ran-kfc-vinmart-vinatex-can-tho',
  'ga-ran-kfc-big-c-hung-phu-can-tho': 'ga-ran-kfc-big-c-hung-phu-can-tho',
  'ga-ran-kfc-lotte-mart-can-tho': 'ga-ran-kfc-lotte-mart-can-tho',
  'ga-ran-kfc-duong-tran-hoang-na-can-tho': 'ga-ran-kfc-duong-tran-hoang-na-can-tho',
  'ga-ran-kfc-kfc-ba-thang-hai': 'ga-ran-kfc-kfc-ba-thang-hai',

  // Lotteria branch legacy slug maps
  'lotteria-can-tho-big-c': 'ga-ran-burger-lotteria-can-tho-big-c',
  'lotteria-can-tho-nguyen-van-cu': 'ga-ran-burger-lotteria-can-tho-nguyen-van-cu',
  'lotteria-can-tho-lotte-mart': 'lotteria-can-tho-lottemart',
  'ga-ran-burger-lotteria-can-tho-big-c': 'ga-ran-burger-lotteria-can-tho-big-c',
  'ga-ran-burger-lotteria-cach-mang-thang-8': 'ga-ran-burger-lotteria-cach-mang-thang-8',
  'ga-ran-burger-lotteria-can-tho-nguyen-van-cu': 'ga-ran-burger-lotteria-can-tho-nguyen-van-cu',
  'lotteria-can-tho-lottemart': 'lotteria-can-tho-lottemart',
  'lotteria-vincom-xuan-khanh': 'lotteria-vincom-xuan-khanh',

  // Jollibee additional branch slug maps
  'ga-ran-va-mi-y-jollibee-ec-o-mon-can-tho': 'ga-ran-va-mi-y-jollibee-ec-o-mon-can-tho',
  'jollibee-coopmart-thot-not': 'jollibee-coopmart-thot-not',
  'jollibee-ec-vincom-can-tho': 'ga-ran-va-mi-y-jollibee-ec-vincom-can-tho',

  // Generic fallback: map COCO-specific old IDs
  'he-thong-coko': 'coko-tra-ca-phe-nguyen-van-cu',
  'he-thong-two-ti': 'two-ti-tra-sua-bap-xao-nguyen-van-cu'
};

const MENU_TEMPLATES = {
  com_tam: [
    { name: 'Cơm Tấm Sườn Nướng Lu', desc: 'Sườn heo cốt lết dày được tẩm mật ong nướng lu thơm lừng, thịt mềm mọng nước.', inStorePrice: 40000, img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80', category: 'Cơm Tấm' },
    { name: 'Cơm Tấm Sườn Bì Chả Đặc Biệt', desc: 'Đầy đủ sườn nướng mật ong, bì thính vàng thơm, chả trứng hấp béo ngậy.', inStorePrice: 48000, img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80', category: 'Cơm Tấm' },
    { name: 'Cơm Tấm Ba Chỉ Heo Quay Giòn Bì', desc: 'Ba chỉ quay lu da siêu giòn rụm chấm nước mắm tỏi ớt kẹo.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=400&q=80', category: 'Cơm Tấm' },
    { name: 'Cơm Tấm Đùi Gà Xối Mỡ', desc: 'Đùi gà xối mỡ giòn rụm ăn kèm cơm tấm thơm béo mỡ hành.', inStorePrice: 42000, img: 'https://images.unsplash.com/photo-1598515213692-80e7c7e4c47c?w=400&q=80', category: 'Cơm Tấm' },
    { name: 'Canh Khổ Qua Nhồi Thịt Heo', desc: 'Khổ qua nhồi nhân thịt băm mộc nhĩ ngọt thanh giải nhiệt.', inStorePrice: 15000, img: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=80', category: 'Canh & Ăn Kèm' }
  ],
  com_ga: [
    { name: 'Cơm Gà Xối Mỡ Da Giòn (Đùi)', desc: 'Cơm chiên hạt vàng dẻo ăn kèm đùi gà góc tư xối mỡ nóng da giòn rụm.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1598515213692-80e7c7e4c47c?w=400&q=80', category: 'Cơm Gà' },
    { name: 'Cơm Gà Hải Nam Luộc', desc: 'Thịt gà ta luộc da vàng óng chắc thịt chấm mắm gừng sả.', inStorePrice: 40000, img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80', category: 'Cơm Gà' },
    { name: 'Cơm Gà Quay Chảo Sốt Mật Ong', desc: 'Đùi gà quay chảo tẩm sốt mật ong đậm đà thơm ngậy.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1598515213692-80e7c7e4c47c?w=400&q=80', category: 'Cơm Gà' },
    { name: 'Cơm Gà Xé Phay Hành Tây', desc: 'Lườn gà xé phay bóp gỏi rau răm hành tây tắc chua ngọt.', inStorePrice: 38000, img: 'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=400&q=80', category: 'Cơm Gà' },
    { name: 'Canh Gà Lá Giang Lá Chanh', desc: 'Nước dùng chua thanh thơm mùi lá giang và thịt băm ngọt nước.', inStorePrice: 15000, img: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=80', category: 'Món Ăn Kèm' }
  ],
  com_general: [
    { name: 'Cơm Chiên Dương Châu Đặc Biệt', desc: 'Cơm chiên tơi hạt thơm bùi lạp xưởng, đậu cô ve, cá rốt và trứng.', inStorePrice: 40000, img: 'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=400&q=80', category: 'Cơm Đĩa' },
    { name: 'Cơm Sườn Rim Chua Ngọt Vị Quê', desc: 'Sườn heo rim chua ngọt mặn mà đưa cơm cực kỳ.', inStorePrice: 42000, img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80', category: 'Cơm Đĩa' },
    { name: 'Cơm Thịt Kho Tàu Trứng Cút', desc: 'Thịt ba chỉ heo kho mềm nhừ với nước dừa xiêm thơm béo ngọt ngào.', inStorePrice: 40000, img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80', category: 'Cơm Đĩa' },
    { name: 'Cơm Bò Xào Bông Cải Xanh', desc: 'Bò phi lê mềm xào bông cải ngọt giòn mướt.', inStorePrice: 48000, img: 'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=400&q=80', category: 'Cơm Đĩa' },
    { name: 'Canh Chua Cá Lóc Nam Bộ', desc: 'Nước canh chua cay đậm vị me, thơm, dọc mùng cá lóc tươi.', inStorePrice: 20000, img: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=80', category: 'Canh Thêm' }
  ],
  bun_bo: [
    { name: 'Bún Bò Huế Đặc Biệt Giò Chả', desc: 'Sợi bún to chuẩn Huế, nước dùng ninh xương bò thơm nồng mùi ruốc sả, giò khoanh mềm ngon kèm chả cua béo ngậy.', inStorePrice: 50000, img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80', category: 'Bún Bò' },
    { name: 'Bún Bò Tái Nạm Gầu Bò', desc: 'Thịt bò tái mềm kết hợp nạm gầu giòn béo thơm phức.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43?w=400&q=80', category: 'Bún Bò' },
    { name: 'Bún Bò Huế Thường (Thịt + Chả)', desc: 'Thịt bò chín lát mỏng kèm chả Huế giòn dai.', inStorePrice: 40000, img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80', category: 'Bún Bò' },
    { name: 'Đĩa Chả Cua / Chả Huế Thêm', desc: 'Topping nhúng thêm tăng phần ngon miệng béo ngậy.', inStorePrice: 15000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Topping' },
    { name: 'Bánh Quẩy Chiên Giòn (2 cái)', desc: 'Chiên vàng giòn rụm chấm nước bún bò ăn cực hợp vị.', inStorePrice: 8000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Ăn Kèm' }
  ],
  hu_tieu_muc: [
    { name: 'Hủ Tiếu Mực Ống Tươi Sườn Heo', desc: 'Nước dùng trong thơm mực nướng hành phi, mực ống tươi giòn sần sật kèm sườn non hầm.', inStorePrice: 48000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Hủ Tiếu Mực' },
    { name: 'Hủ Tiếu Mực Tôm Trứng Cút', desc: 'Mực ống giòn ngọt kết hợp tôm sú đỏ au trứng cút nhỏ bùi béo.', inStorePrice: 50000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Hủ Tiếu Mực' },
    { name: 'Hủ Tiếu Mực Trộn Khô Sốt Đặc Biệt', desc: 'Hủ tiếu dai trộn sốt đặc trưng, mực tôm sườn để bát riêng nước dùng ngọt lịm.', inStorePrice: 52000, img: 'https://images.unsplash.com/photo-1552611052-33e04de081de?w=400&q=80', category: 'Hủ Tiếu Mực' },
    { name: 'Đĩa Mực Ống Tươi Nhúng Thêm', desc: 'Thêm đĩa mực ống làm sạch trụng chín giòn ngọt.', inStorePrice: 25000, img: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=80', category: 'Topping' },
    { name: 'Nước Sâm Dứa Lá Nếp Mát Lạnh', desc: 'Nước giải khát mát ngọt thanh hương lá dứa nếp phảng phất.', inStorePrice: 10000, img: 'https://images.unsplash.com/photo-1621263764928-df1444c5e859?w=400&q=80', category: 'Giải Khát' }
  ],
  hu_tieu: [
    { name: 'Hủ Tiếu Nam Vang Sườn Tôm Thịt Bằm', desc: 'Hủ tiếu Nam Vang nước xương hầm sườn non, tôm sú tươi, gan tim heo bùi ngậy và thịt bằm nhuyễn.', inStorePrice: 42000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Hủ Tiếu' },
    { name: 'Hủ Tiếu Nam Vang Khô Trộn Sốt', desc: 'Hủ tiếu trộn sốt dầu hào tỏi phi thơm đậm vị, kèm bát nước lèo sườn tôm thơm ngọt.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1552611052-33e04de081de?w=400&q=80', category: 'Hủ Tiếu' },
    { name: 'Hủ Tiếu Hoành Thánh Xá Xíu', desc: 'Thịt xá xíu thái lát mềm ngọt, hoành thánh nhân tôm thịt vỏ mỏng chín mướt.', inStorePrice: 40000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Hủ Tiếu Mì' },
    { name: 'Xương Ống Hầm Mềm Thêm', desc: 'Bát xương ống tủy ngọt ngào nhúng hành trần béo bùi ngon tuyệt.', inStorePrice: 20000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Topping' },
    { name: 'Bánh Quẩy Chiên Giòn (2 cái)', desc: 'Ăn kèm nước hủ tiếu chấm mắm ớt cay ngon tuyệt hảo.', inStorePrice: 8000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Ăn Kèm' }
  ],
  pho: [
    { name: 'Phở Bò Đặc Biệt (Tái, Nạm, Gầu, Gân)', desc: 'Phở truyền thống nước dùng hầm xương 12 tiếng thơm quế hồi, đầy đủ tái nạm gầu gân.', inStorePrice: 50000, img: 'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43?w=400&q=80', category: 'Phở Bò' },
    { name: 'Phở Bò Tái Bắp Hoa Tươi', desc: 'Thịt bò bắp hoa giòn ngọt thái mỏng trụng chín vừa thơm lừng.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43?w=400&q=80', category: 'Phở Bò' },
    { name: 'Phở Gà Ta Xé Đùi Trứng Non', desc: 'Nước dùng gà ngọt thanh, thịt đùi gà ta xé giòn dai kèm trứng non béo ngậy.', inStorePrice: 48000, img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80', category: 'Phở Gà' },
    { name: 'Đĩa Thịt Bò Tái Thêm', desc: 'Thêm đĩa bò tái phi lê ngọt lịm nhúng lèo.', inStorePrice: 20000, img: 'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43?w=400&q=80', category: 'Topping' },
    { name: 'Quẩy Giòn Chấm Phở (2 cái)', desc: 'Quẩy dài vàng ruộm chiên giòn tan.', inStorePrice: 8000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Ăn Kèm' }
  ],
  bun_rieu: [
    { name: 'Bún Riêu Cua Giò Heo Ốc Đặc Biệt', desc: 'Nước riêu chua thanh dịu dấm bỗng thơm nồng, riêu cua béo múp, giò heo hầm mềm dẻo, ốc giòn sần sật.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80', category: 'Bún Riêu' },
    { name: 'Bún Riêu Bắp Bò Chả Huế', desc: 'Thịt bò bắp thái mỏng trần tái giòn kết hợp chả Huế thơm nồng sa tế.', inStorePrice: 42000, img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80', category: 'Bún Riêu' },
    { name: 'Bún Riêu Ốc Đậu Hũ Chiên Giòn', desc: 'Ốc nhồi dai giòn sần sật kết hợp đậu hũ chiên phồng thấm đẫm nước riêu.', inStorePrice: 38000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Bún Riêu' },
    { name: 'Khoanh Giò Heo Hầm Mềm Thêm', desc: 'Giò heo khoanh tròn nạc mỡ đan xen hầm nhừ dẻo thơm.', inStorePrice: 15000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Topping' },
    { name: 'Trà Đá Nhài Thanh Mát', desc: 'Nước trà xanh hương nhài đá giải khát cực mát mẻ.', inStorePrice: 5000, img: 'https://images.unsplash.com/photo-1621263764928-df1444c5e859?w=400&q=80', category: 'Giải Khát' }
  ],
  banh_mi: [
    { name: 'Bánh Mì Heo Quay Giòn Bì Đặc Biệt', desc: 'Vỏ bánh mì nướng nóng giòn tan, nhân ba chỉ heo quay lu da giòn sần sật sốt ớt kẹo đặc trưng.', inStorePrice: 25000, img: 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?w=400&q=80', category: 'Bánh Mì' },
    { name: 'Bánh Mì Xá Xíu Pâté Bơ Tươi', desc: 'Thịt xá xíu thái mỏng ngọt đậm đà, pâté gan béo ngậy quết bơ béo bùi hành dưa.', inStorePrice: 22000, img: 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?w=400&q=80', category: 'Bánh Mì' },
    { name: 'Bánh Mì Chả Lụa Thịt Nguội Pâté', desc: 'Bánh mì kẹp chả lụa thủ công dăm bông heo ngọt vị quết đầy đặn bơ sốt.', inStorePrice: 20000, img: 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?w=400&q=80', category: 'Bánh Mì' },
    { name: 'Bánh Mì Ốp La 2 Trứng Xúc Xích', desc: '2 trứng ốp la lòng đào chảy mềm kèm xúc xích heo chiên rạch múi.', inStorePrice: 18000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Bánh Mì' },
    { name: 'Sữa Đậu Nành Nguyên Chất Mát Lạnh', desc: 'Sữa đậu nành tự nấu ngọt béo thơm ngậy hạt đậu nành hữu cơ.', inStorePrice: 10000, img: 'https://images.unsplash.com/photo-1621263764928-df1444c5e859?w=400&q=80', category: 'Đồ Uống' }
  ],
  banh_canh: [
    { name: 'Bánh Canh Cua Bột Gạo Đặc Biệt', desc: 'Sợi bánh canh bột gạo nước sốt gạch cua sệt đỏ cam, thịt cua bể béo ngậy chả cá thác lác sần sật.', inStorePrice: 48000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Bánh Canh' },
    { name: 'Bánh Canh Giò Heo Sườn Non', desc: 'Sườn non heo chặt khúc ngọt thịt kèm khoanh giò heo hầm mềm giòn da.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Bánh Canh' },
    { name: 'Bánh Canh Tôm Thịt Chả Cá Thác Lác', desc: 'Tôm sú tươi đỏ au chả cá thác lác dai giòn sần sật vị ngọt thanh.', inStorePrice: 40000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Bánh Canh' },
    { name: 'Bánh Quẩy Chiên Giòn Thêm (2 cái)', desc: 'Quẩy giòn tan cắt khoanh chấm nước lèo bánh canh sền sệt.', inStorePrice: 8000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Ăn Kèm' },
    { name: 'Nước Sâm La Hán Quả Mát Lạnh', desc: 'Nước sâm la hán quả nấu thanh nhiệt giải độc ngày hè.', inStorePrice: 12000, img: 'https://images.unsplash.com/photo-1621263764928-df1444c5e859?w=400&q=80', category: 'Giải Khát' }
  ],
  ga_ran: [
    { name: 'Set 2 Miếng Gà Giòn Cay Rụm', desc: '2 miếng gà giòn rụm cay nhẹ đậm đà thấm vị tẩm bột chiên vàng.', inStorePrice: 69000, img: 'https://images.unsplash.com/photo-1606755962773-d324e0a13086?w=400&q=80', category: 'Gà Rán' },
    { name: 'Combo Gà Giòn + Khoai Tây + Pepsi', desc: '1 miếng gà giòn rụm kèm 1 đĩa khoai tây chiên muối thơm lừng lon Pepsi lạnh.', inStorePrice: 89000, img: 'https://images.unsplash.com/photo-1606755962773-d324e0a13086?w=400&q=80', category: 'Combo' },
    { name: 'Burger Gà Giòn Sốt Mayo', desc: 'Burger kẹp đùi gà chiên xù xà lách tươi béo bùi sốt mayo sữa.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400&q=80', category: 'Burger' },
    { name: 'Khoai Tây Chiên Lắc Bột Phô Mai', desc: 'Khoai tây cắt thanh chiên vàng giòn rụm lắc đẫm bột phô mai cam béo ngậy.', inStorePrice: 32000, img: 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=400&q=80', category: 'Món Phụ' },
    { name: 'Mỳ Ý Sốt Bò Bằm Bolognaise', desc: 'Sợi mỳ Ý dai mềm phủ sốt bò bằm cà chua thơm ngào ngạt bột phô mai.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=400&q=80', category: 'Món Phụ' }
  ],
  western: [
    { name: 'Pizza Thập Cẩm Phô Mai Mozzarella (M)', desc: 'Pizza đế mỏng lò đất giòn rụm, xúc xích pepperoni, giăm bông thịt heo, dứa, phô mai kéo sợi đặc trưng.', inStorePrice: 129000, img: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=400&q=80', category: 'Pizza' },
    { name: 'Pizza Hải Sản Sốt Pesto (Size M)', desc: 'Tôm sú mực tươi xào bơ tỏi sốt pesto xanh ngát ngập phô mai Mozzarella.', inStorePrice: 149000, img: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=400&q=80', category: 'Pizza' },
    { name: 'Mỳ Ý Sốt Bò Bằm Bolognaise', desc: 'Mì Ý truyền thống sốt cà chua thịt bò bằm phi thơm dầu oliu bột phô mai cam.', inStorePrice: 65000, img: 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=400&q=80', category: 'Mỳ Ý' },
    { name: 'Burger Bò Phô Mai Double Cheesy', desc: '2 lớp bò áp chảo thơm lừng kẹp phô mai Cheddar béo ngậy sốt BBQ khói.', inStorePrice: 60000, img: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400&q=80', category: 'Burger' },
    { name: 'Khoai Tây Bổ Múi Bơ Tỏi (Lớn)', desc: 'Khoai tây bổ múi cau dày giòn da thơm lừng mùi bơ tỏi.', inStorePrice: 35000, img: 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=400&q=80', category: 'Món Kèm' }
  ],
  tra_sua: [
    { name: 'Trà Sữa Trân Châu Hoàng Kim', desc: 'Trà đen đậm vị kết hợp sữa béo ngậy kèm trân châu hoàng kim giòn dai ngọt nhẹ.', inStorePrice: 35000, img: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&q=80', category: 'Trà Sữa' },
    { name: 'Trà Sữa Matcha Đậu Đỏ Dẻo', desc: 'Matcha Nhật Bản kết hợp sữa thơm mát và đậu đỏ ngọt béo bùi vị.', inStorePrice: 38000, img: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&q=80', category: 'Trà Sữa' },
    { name: 'Lục Trà Nhài Sữa Kem Macchiato', desc: 'Lục trà nhài thanh mát phủ lớp kem sữa muối mằn mặn béo ngậy.', inStorePrice: 32000, img: 'https://images.unsplash.com/photo-1556881286-fc6915169721?w=400&q=80', category: 'Trà Trái Cây' },
    { name: 'Trà Đào Cam Sả Tươi Mát', desc: 'Trà đào sả tươi ngọt thanh kèm 3 miếng đào giòn dai ngâm.', inStorePrice: 32000, img: 'https://images.unsplash.com/photo-1556881286-fc6915169721?w=400&q=80', category: 'Trà Trái Cây' },
    { name: 'Thạch Trân Châu Hoàng Kim Thêm', desc: 'Trân châu giòn sật rim mật ong vàng óng.', inStorePrice: 8000, img: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&q=80', category: 'Topping' }
  ],
  cafe: [
    { name: 'Cà Phê Sữa Đá Truyền Thống', desc: 'Robusta Tây Nguyên pha phin chậm thơm đắng nồng kết hợp sữa đặc ngọt béo.', inStorePrice: 22000, img: 'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?w=400&q=80', category: 'Cà Phê' },
    { name: 'Bạc Xỉu Sương Sáo Cốt Dừa', desc: 'Nhiều sữa ít cà phê béo ngậy nước cốt dừa xiêm cùng thạch sương sáo thanh mát.', inStorePrice: 25000, img: 'https://images.unsplash.com/photo-1541167760496-1628856ab772?w=400&q=80', category: 'Cà Phê' },
    { name: 'Cà Phê Muối Kem Bông Thơm Béo', desc: 'Cà phê nâu pha muối biển và lớp kem mặn mằn mặn ngậy béo thơm ngon.', inStorePrice: 28000, img: 'https://images.unsplash.com/photo-1541167760496-1628856ab772?w=400&q=80', category: 'Cà Phê' },
    { name: 'Trà Đào Cam Sả Hạt Chia', desc: 'Trà đào sả tươi ngọt thanh kết hợp hạt chia bổ dưỡng.', inStorePrice: 32000, img: 'https://images.unsplash.com/photo-1556881286-fc6915169721?w=400&q=80', category: 'Trà Trái Cây' },
    { name: 'Bánh Croissant Bơ Tỏi Nướng Giòn', desc: 'Bánh sừng bò ngập bơ tỏi đút lò giòn tan thơm phức.', inStorePrice: 25000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Bánh Ngọt' }
  ],
  an_vat: [
    { name: 'Mẹt Cá Viên Chiên Thập Cẩm Sốt Mắm', desc: 'Đầy đủ cá viên, bò viên, tôm viên, xúc xích, đậu hũ chiên xối sốt tỏi ớt kẹo.', inStorePrice: 55000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Ăn Vặt' },
    { name: 'Bánh Tráng Trộn Sa Tế Tôm Trứng Cút', desc: 'Bánh tráng trộn muối tôm sa tế cay nồng xoài xanh khô bò khô mực lạc rang trứng cút.', inStorePrice: 20000, img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80', category: 'Bánh Tráng' },
    { name: 'Bánh Tráng Cuộn Bơ Hành Phi', desc: 'Bánh tráng cuộn nhân bơ lòng đỏ trứng béo ngậy hành phi thơm giòn ruộm.', inStorePrice: 22000, img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80', category: 'Bánh Tráng' },
    { name: 'Tokbokki Phô Mai Cay Ly Lớn', desc: 'Bánh gạo cay dẻo quánh ngập sốt Gochujang đỏ rực chả cá phô mai kéo sợi.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Món Hàn' },
    { name: 'Trà Tắc Hạt Chia Giải Khát', desc: 'Trà xanh nhài pha mật ong chanh sả tắc chua ngọt giải khát.', inStorePrice: 15000, img: 'https://images.unsplash.com/photo-1621263764928-df1444c5e859?w=400&q=80', category: 'Nước Giải Khát' }
  ],
  lau_nuong: [
    { name: 'Set Lẩu Thái Hải Sản Chua Cay (2 Người)', desc: 'Nước lẩu Thái chua cay cốt dừa béo nhẹ đầy tôm mực ngao chả viên mỳ tôm.', inStorePrice: 189000, img: 'https://images.unsplash.com/photo-1547592180-85f173990554?w=400&q=80', category: 'Lẩu' },
    { name: 'Set Lẩu Gà Lá Giang Lá Chanh (2 Người)', desc: 'Lẩu gà ta chặt khúc thịt dai ngọt nước chua chua lá giang lá chanh sả.', inStorePrice: 169000, img: 'https://images.unsplash.com/photo-1547592180-85f173990554?w=400&q=80', category: 'Lẩu' },
    { name: 'Ba Chỉ Bò Mỹ Cuộn Nhúng Lẩu (150g)', desc: 'Thịt ba chỉ bò Mỹ vân mỡ đẹp dẻo mềm béo nhúng ngọt lịm.', inStorePrice: 79000, img: 'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43?w=400&q=80', category: 'Nhúng Kèm' },
    { name: 'Đĩa Hải Sản Tổng Hợp Nhúng Kèm', desc: 'Mực tươi khoanh tròn, tôm thẻ đỏ au và ngao sần sật nhúng lèo.', inStorePrice: 95000, img: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=80', category: 'Nhúng Kèm' },
    { name: 'Rau Nấm Lẩu Thập Cẩm Sạch', desc: 'Cải thảo, rau muống, nấm kim châm nấm đùi gà cải cúc.', inStorePrice: 25000, img: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=80', category: 'Nhúng Kèm' }
  ],
  oc_hai_san: [
    { name: 'Ốc Hương Rang Muối Ớt Cay Nồng', desc: 'Ốc hương tươi giòn ngọt béo rang đẫm muối tôm tỏi ớt cay xè dậy mùi.', inStorePrice: 65000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Món Ốc' },
    { name: 'Ốc Móng Tay Xào Tỏi Hành Thơm Lừng', desc: 'Ốc móng tay dai béo ngọt tự nhiên xào cháy tỏi hành bơ ngậy thơm.', inStorePrice: 55000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Món Ốc' },
    { name: 'Sò Huyết Cháy Tỏi Bơ Ngọt Béo', desc: 'Sò huyết tươi sống xào chín tái bơ cháy tỏi ngọt nước thịt béo ngậy.', inStorePrice: 60000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Món Ốc' },
    { name: 'Mực Trứng Hấp Sả Hành Gừng Tươi', desc: 'Mực trứng ngọt đầy ụ trứng hấp nồng nàn vị sả gừng cay ấm.', inStorePrice: 95000, img: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=80', category: 'Hải Sản' },
    { name: 'Càng Ghẹ Rang Muối Cay Kéo Sợi', desc: 'Càng ghẹ dày thịt rang phủ muối ớt cay kéo sợi.', inStorePrice: 85000, img: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=80', category: 'Hải Sản' }
  ],
  japanese_korean: [
    { name: 'Set Sushi Thập Cẩm Premium (10 Viên)', desc: 'Sushi cá hồi, tôm sú, trứng cuộn ngọt, lươn nướng Nhật cùng gừng hồng mù tạt cay nồng.', inStorePrice: 120000, img: 'https://images.unsplash.com/photo-1563245372-f21724e3856d?w=400&q=80', category: 'Sushi' },
    { name: 'Tokbokki Phô Mai Cay Kéo Sợi', desc: 'Bánh gạo cay dẻo quánh ngập sốt Gochujang đỏ rực chả cá phô mai kéo sợi.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Món Hàn' },
    { name: 'Kimbap Chiên Xù Giòn Rụm Lớn', desc: 'Cơm cuộn Hàn Quốc chiên xù xốp giòn vỏ bên trong nhân xúc xích củ cải vàng sốt mayo.', inStorePrice: 35000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Món Hàn' },
    { name: 'Mỳ Tương Đen Jajangmyeon Đặc Trưng', desc: 'Sợi mỳ to dai trộn nước sốt tương đen thịt băm ngọt bùi hành tây.', inStorePrice: 55000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Món Hàn' },
    { name: 'Cơm Trộn Thịt Bò Bulgogi Trứng Lòng Đào', desc: 'Cơm nóng thố đá đầy đủ giá đỗ, rau nấm, kim chi, bò xào Bulgogi ngọt lịm trứng lòng đào sốt cay.', inStorePrice: 65000, img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80', category: 'Món Hàn' }
  ],
  noodles_general: [
    { name: 'Mì Cay Thập Cẩm 7 Cấp Độ', desc: 'Mì Hàn Quốc dai ngon, hải sản tôm mực bắp bò súp kim chi cay nồng hấp dẫn.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Mì Cay' },
    { name: 'Mì Xào Giòn Hải Sản Đặc Biệt', desc: 'Sợi mì trứng chiên vàng giòn rụm rưới sốt hải sản tôm mực cải ngọt sền sệt béo bùi.', inStorePrice: 48000, img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80', category: 'Món Xào' },
    { name: 'Hủ Tiếu Gõ Khô Trộn Tỏi Phi', desc: 'Hủ tiếu bình dân mà thơm ngon nức nở trộn tỏi phi thơm xá xíu trứng cút.', inStorePrice: 25000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Hủ Tiếu Gõ' },
    { name: 'Mì Trộn Trứng Lòng Đào Tóp Mỡ', desc: 'Mì gói trụng dai dai trộn sốt sa tế cay cay lòng đào tóp mỡ giòn rụm.', inStorePrice: 32000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Mì Trộn' },
    { name: 'Nước Sâm Lạnh Râu Ngô Đường Phèn', desc: 'Nước sâm mát lạnh nấu từ râu ngô và lá dứa đường phèn giải nhiệt.', inStorePrice: 8000, img: 'https://images.unsplash.com/photo-1621263764928-df1444c5e859?w=400&q=80', category: 'Giải Khát' }
  ],
  bun_xao: [
    { name: 'Bún Xào Thịt Nướng Đặc Biệt', desc: 'Thịt nướng tẩm vị sa tế, chả giò chiên giòn rụm kèm nước mắm tỏi ớt đặc trưng.', inStorePrice: 35000, img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80', category: 'Bún Xào' },
    { name: 'Bún Xào Ba Chỉ Heo Cực Ngon', desc: 'Thịt ba chỉ heo thái mỏng xào lăn tỏi hành thơm béo bùi.', inStorePrice: 38000, img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80', category: 'Bún Xào' },
    { name: 'Bún Xào Hải Sản Tôm Mực Tươi', desc: 'Tôm mực tươi xào tỏi hành tây cải ngọt ngọt lịm dai giòn.', inStorePrice: 42000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Bún Xào' },
    { name: 'Bún Xào Chay Đậu Hũ Rau Củ', desc: 'Đậu hũ chiên phồng xào cùng cải ngọt, nấm đùi gà thanh đạm tốt cho sức khỏe.', inStorePrice: 28000, img: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=80', category: 'Món Chay' },
    { name: 'Nước Sâm Lạnh Râu Ngô Đường Phèn', desc: 'Nước sâm tự nấu ngọt dịu mát thanh giải nhiệt cực đã ngày hè.', inStorePrice: 10000, img: 'https://images.unsplash.com/photo-1621263764928-df1444c5e859?w=400&q=80', category: 'Giải Khát' }
  ],
  default: [
    { name: 'Bánh Xèo Miền Tây Khổng Lồ', desc: 'Vỏ bánh xèo giòn rụm bột nghệ nước cốt dừa, nhân thịt heo tôm sú giá đỗ hành tây, ăn kèm rau rừng nước mắm chua ngọt.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1563245372-f21724e3856d?w=400&q=80', category: 'Món Việt' },
    { name: 'Gỏi Cuốn Tôm Thịt Heo (3 cái)', desc: 'Tôm sú hấp đỏ, thịt ba chỉ luộc mỏng cuộn bún tươi rau thơm hẹ lá bánh tráng phơi sương, chấm tương đậu phộng.', inStorePrice: 30000, img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80', category: 'Khai vị' },
    { name: 'Nem Nướng Nha Trang (Set 1 người)', desc: 'Nem heo nướng sả, bánh tráng giòn chiên phồng cuộn rau sống xoài xanh dưa chuột chấm nước sốt sệt độc quyền.', inStorePrice: 55000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Món cuốn' },
    { name: 'Trà Đá Chanh Sả Mát Lạnh', desc: 'Trà xanh nhài pha mật ong chanh sả đá mát giải khát ngày hè cực đã.', inStorePrice: 10000, img: 'https://images.unsplash.com/photo-1621263764928-df1444c5e859?w=400&q=80', category: 'Đồ uống' }
  ]
};

function getShortBrand(name) {
  let brand = (name || '').split(/[-|,|(|]/)[0].trim();
  // Loại bỏ các tiền tố chung chung để lấy thương hiệu ngắn gọn
  brand = brand.replace(/^(hệ thống|quán cơm|quán bún|quán phở|quán|tiệm cơm|tiệm bánh|tiệm|bánh mì|bánh mỳ|cơm tấm|cơm gà|bún bò huế|bún bò|hủ tiếu mực|hủ tiếu|phở bò|phở|bún riêu|bánh canh|gà rán|sushi|ốc|lẩu nướng|lẩu|nướng|trà sữa|cà phê|càphê|cafe|coffee|ăn vặt)\s+/i, '');
  return brand.trim() || 'ShipFee';
}

function selectMenuTemplate(name) {
  const n = (name || '').toLowerCase();
  
  if (n.includes('cơm tấm') || n.includes('com tam')) {
    return MENU_TEMPLATES.com_tam;
  }
  if (n.includes('cơm gà') || n.includes('com ga')) {
    return MENU_TEMPLATES.com_ga;
  }
  if (n.includes('cơm') || n.includes('com') || n.includes('quán cơm') || n.includes('rice')) {
    return MENU_TEMPLATES.com_general;
  }
  if (n.includes('bún bò') || n.includes('bun bo')) {
    return MENU_TEMPLATES.bun_bo;
  }
  if (n.includes('hủ tiếu mực') || n.includes('hu tieu muc')) {
    return MENU_TEMPLATES.hu_tieu_muc;
  }
  if (n.includes('hủ tiếu') || n.includes('hu tieu') || n.includes('hủ tiêú')) {
    return MENU_TEMPLATES.hu_tieu;
  }
  if (n.includes('phở') || n.includes('pho')) {
    return MENU_TEMPLATES.pho;
  }
  if (n.includes('bún riêu') || n.includes('bun rieu')) {
    return MENU_TEMPLATES.bun_rieu;
  }
  if (n.includes('bánh mì') || n.includes('bánh mỳ') || n.includes('banh mi') || n.includes('xôi') || n.includes('xoi')) {
    return MENU_TEMPLATES.banh_mi;
  }
  if (n.includes('bánh canh') || n.includes('banh canh')) {
    return MENU_TEMPLATES.banh_canh;
  }
  if (n.includes('gà rán') || n.includes('ga ran') || n.includes('kfc') || n.includes('jollibee') || n.includes('lotteria') || n.includes('mcdonald')) {
    return MENU_TEMPLATES.ga_ran;
  }
  if (n.includes('pizza') || n.includes('burger') || n.includes('mỳ ý') || n.includes('spaghetti') || n.includes('pasta') || n.includes('mì ý') || n.includes('italia') || n.split(/[\s,.\-\(\)]+/).includes('ý')) {
    return MENU_TEMPLATES.western;
  }
  if (n.includes('trà sữa') || n.includes('tra sua') || n.includes('milk tea') || n.includes('chè') || n.includes('che') || n.includes('bingsu') || n.includes('kem')) {
    return MENU_TEMPLATES.tra_sua;
  }
  if (n.includes('coffee') || n.includes('cà phê') || n.includes('ca phe') || n.includes('café') || n.includes('sinh tố')) {
    return MENU_TEMPLATES.cafe;
  }
  if (n.includes('bún xào') || n.includes('bun xao')) {
    return MENU_TEMPLATES.bun_xao;
  }
  if (n.includes('mì cay') || n.includes('mi cay') || n.includes('mì xào') || n.includes('mỳ xào') || n.includes('xào') || n.includes('xao') || n.includes('mì gõ') || n.includes('mi go')) {
    return MENU_TEMPLATES.noodles_general;
  }
  if (n.includes('ăn vặt') || n.includes('an vat') || n.includes('cá viên') || n.includes('ca vien') || n.includes('bánh tráng') || n.includes('banh trang') || n.includes('tokbokki')) {
    return MENU_TEMPLATES.an_vat;
  }
  if (n.includes('lẩu') || n.includes('nướng') || n.includes('hotpot') || n.includes('bbq') || n.includes('buffet')) {
    return MENU_TEMPLATES.lau_nuong;
  }
  if (n.includes('ốc') || n.includes('oc') || n.includes('hải sản') || n.includes('hai san') || n.includes('tôm') || n.includes('mực') || n.includes('ghẹ')) {
    return MENU_TEMPLATES.oc_hai_san;
  }
  if (n.includes('sushi') || n.includes('kimbap') || n.includes('nhật') || n.includes('hàn quốc') || n.includes('món hàn') || n.split(/[\s,.\-\(\)]+/).includes('hàn') || n.includes('sashimi')) {
    return MENU_TEMPLATES.japanese_korean;
  }
  return MENU_TEMPLATES.default;
}

function generateMenuForRestaurant(name, resId) {
  if (String(resId).includes('bun_xao_khang')) {
    const items = [
      {
        id: `${resId}-item-0`,
        name: 'Bún Thịt Xào Chả Giò',
        desc: 'Hộp bao gồm: Bún tươi, rau thơm, xà lách, dưa leo, dưa chua, thịt xào sả, nem nướng, chả giò rế nhà làm, đậu phộng.',
        inStorePrice: 33000,
        img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80',
        category: 'MENU ĐỒ ĂN'
      },
      {
        id: `${resId}-item-1`,
        name: 'Bún Thịt Xào Nem Nướng',
        desc: 'Hộp bao gồm: Bún tươi, rau thơm, xà lách, dưa leo, dưa chua, thịt xào sả, nem nướng, đậu phộng.',
        inStorePrice: 29000,
        img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80',
        category: 'MENU ĐỒ ĂN'
      },
      {
        id: `${resId}-item-2`,
        name: 'Bánh Ướt Chả Lụa',
        desc: 'Hộp bao gồm: Bánh ướt, rau thơm, xà lách, giá trụng, chả lụa, chả chiên, nem nướng, nem chua, đậu phộng, hành phi.',
        inStorePrice: 29000,
        img: 'https://images.unsplash.com/photo-1563245372-f21724e3856d?w=400&q=80',
        category: 'MENU ĐỒ ĂN'
      },
      {
        id: `${resId}-item-3`,
        name: 'Bún Chả Giò',
        desc: 'Hộp bao gồm: Bún tươi, rau thơm, xà lách, dưa leo, dưa chua, chả giò rế nhà làm, đậu phộng.',
        inStorePrice: 27000,
        img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80',
        category: 'MENU ĐỒ ĂN'
      },
      {
        id: `${resId}-item-4`,
        name: 'Bún Nem Nướng',
        desc: 'Hộp bao gồm: Bún tươi, rau thơm, xà lách, dưa leo, dưa chua, nem nướng, đậu phộng.',
        inStorePrice: 29000,
        img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80',
        category: 'MENU ĐỒ ĂN'
      },
      {
        id: `${resId}-item-5`,
        name: 'Chả Giò Rế 4 Cuốn',
        desc: 'Chả giò rế chiên vàng giòn rụm, vỏ rế xốp giòn nhân tôm thịt thơm ngon chấm nước mắm chua ngọt.',
        inStorePrice: 17000,
        img: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=80',
        category: 'Món Ăn Kèm'
      }
    ];
    return items.map(item => ({
      ...item,
      appPrice: calcAppPrice(item.inStorePrice)
    }));
  }
  const template = selectMenuTemplate(name);
  const brand = getShortBrand(name);
  
  return template.map((item, i) => {
    // Tính giá app cố định 28% markup (làm tròn 100đ)
    const appPrice = calcAppPrice(item.inStorePrice);

    // Cá nhân hóa tên món ăn theo thương hiệu quán
    let itemName = item.name;
    if (i === 0 || i === 1 || item.name.includes('Đặc Biệt') || item.name.includes('Truyền Thống') || item.name.includes('Đặc Trưng')) {
      if (item.name.includes('Đặc Biệt')) {
        itemName = item.name.replace('Đặc Biệt', `${brand} Đặc Biệt`);
      } else if (item.name.includes('Truyền Thống')) {
        itemName = item.name.replace('Truyền Thống', `${brand} Gia Truyền`);
      } else {
        itemName = `${item.name} ${brand}`;
      }
    }
    
    // Tránh bị trùng lặp thương hiệu
    itemName = itemName.replace(new RegExp(`${brand}\\s+${brand}`, 'ig'), brand).trim();

    return {
      id:           `${resId}-item-${i}`,
      name:         itemName,
      desc:         item.desc.replace(/gia truyền|truyền thống|trứ danh/ig, `gia truyền của hiệu ${brand}`),
      inStorePrice: item.inStorePrice,
      appPrice:     appPrice,
      img:          item.img,
      category:     item.category
    };
  });
}

const DB_FILE_PATH = path.join(__dirname, 'restaurants-local.json');
let dbQueuePromise = Promise.resolve();

/**
 * Cập nhật cơ sở dữ liệu local JSON một cách an toàn (tránh tranh chấp ghi file ghi đè dữ liệu)
 * @param {Function} updaterFn Nhận vào array restaurants, thực hiện thay đổi và trả về true nếu cần lưu
 */
function updateLocalDatabase(updaterFn) {
  return new Promise((resolve, reject) => {
    dbQueuePromise = dbQueuePromise.then(() => {
      try {
        if (!fs.existsSync(DB_FILE_PATH)) {
          fs.writeFileSync(DB_FILE_PATH, '[]', 'utf8');
        }
        const raw = fs.readFileSync(DB_FILE_PATH, 'utf8');
        let data = [];
        try {
          data = JSON.parse(raw);
        } catch (e) {
          console.error('[DB Queue] Lỗi parse JSON:', e.message);
          data = [];
        }
        if (Array.isArray(data)) {
          const shouldSave = updaterFn(data);
          if (shouldSave !== false) {
            fs.writeFileSync(DB_FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
          }
        }
        resolve();
      } catch (err) {
        console.error('[DB Queue] Lỗi thực thi hàng đợi DB:', err.message);
        reject(err);
      }
    });
  });
}
function getHaversineDistance(coords1, coords2) {
  const R = 6371; // Earth's radius in km
  const dLat = (coords2.lat - coords1.lat) * Math.PI / 180;
  const dLon = (coords2.lon - coords1.lon) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(coords1.lat * Math.PI / 180) * Math.cos(coords2.lat * Math.PI / 180) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function geocodeAddress(address, name) {
  const text = ((address || '') + ' ' + (name || '')).toLowerCase();
  
  // Basic Vietnamese tone removal to improve matching
  const cleanText = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const mappings = [
    { keys: ['nguyen van cu'], lat: 10.0298, lon: 105.7584 },
    { keys: ['mau than'], lat: 10.0276, lon: 105.7725 },
    { keys: ['ba thang hai', '3 thang 2', '3/2'], lat: 10.0244, lon: 105.7676 },
    { keys: ['30 thang 4', 'ba muoi thang tu', '30/4'], lat: 10.0165, lon: 105.7708 },
    { keys: ['tran hung dao'], lat: 10.0381, lon: 105.7801 },
    { keys: ['ly tu trong'], lat: 10.0354, lon: 105.7825 },
    { keys: ['cach mang thang 8', 'cmt8'], lat: 10.0492, lon: 105.7615 },
    { keys: ['hung vuong'], lat: 10.0415, lon: 105.7818 },
    { keys: ['tran van hoai'], lat: 10.0261, lon: 105.7772 },
    { keys: ['tam vu'], lat: 10.0182, lon: 105.7720 },
    { keys: ['de tham'], lat: 10.0336, lon: 105.7828 },
    { keys: ['quang trung'], lat: 10.0229, lon: 105.7905 },
    { keys: ['vo van kiet'], lat: 10.0526, lon: 105.7502 },
    { keys: ['cai rang'], lat: 9.9968, lon: 105.7505 },
    { keys: ['o mon'], lat: 10.1205, lon: 105.6292 },
    { keys: ['binh thuy'], lat: 10.0763, lon: 105.7289 }
  ];

  for (const mapping of mappings) {
    if (mapping.keys.some(key => cleanText.includes(key))) {
      // Add a small jitter (up to ~200m) to differentiate restaurants on the same street
      const jitterLat = (Math.random() - 0.5) * 0.003;
      const jitterLon = (Math.random() - 0.5) * 0.003;
      return { lat: mapping.lat + jitterLat, lon: mapping.lon + jitterLon };
    }
  }

  // Default Ninh Kieu Center + jitter
  const jitterLat = (Math.random() - 0.5) * 0.005;
  const jitterLon = (Math.random() - 0.5) * 0.005;
  return { lat: 10.0345 + jitterLat, lon: 105.7876 + jitterLon };
}

function applyDistanceMarkupToMenu(restaurant, lat, lon) {
  if (!restaurant) return restaurant;
  const userLat = parseFloat(lat);
  const userLon = parseFloat(lon);
  
  if (isNaN(userLat) || isNaN(userLon)) {
    // Không có tọa độ → chỉ áp dụng markup 28% cơ sở, không có surcharge
    const cloned = {
      ...restaurant,
      distanceSurchargePerItem: 0,
      menu: (restaurant.menu || []).map(item => ({
        ...item,
        appPrice: calcAppPrice(item.inStorePrice)
      }))
    };
    return cloned;
  }

  const userCoords = { lat: userLat, lon: userLon };
  const restCoords = geocodeAddress(restaurant.address || '', restaurant.name || '');
  const distKm = getHaversineDistance(userCoords, restCoords);

  // Compute progressive distance surcharge per item using square root function
  let extraMarkupPerItem = 0;
  if (distKm > PRICING_CONFIG.FREE_DISTANCE_KM) {
    extraMarkupPerItem = PRICING_CONFIG.SURCHARGE_COEFFICIENT * Math.sqrt(distKm - PRICING_CONFIG.FREE_DISTANCE_KM);
  }

  // Round surcharge to the nearest 100đ
  extraMarkupPerItem = round100(extraMarkupPerItem);

  // Clone the restaurant object to avoid mutating memory cache/database
  const clonedRestaurant = {
    ...restaurant,
    latitude: restCoords.lat,
    longitude: restCoords.lon,
    distanceValue: distKm,
    distance: distKm < 1 ? `${Math.round(distKm * 1000)} m` : `${distKm.toFixed(1)} km`,
    time: `${12 + Math.round(distKm * 5)}-${20 + Math.round(distKm * 5)} phút`,
    distanceSurchargePerItem: extraMarkupPerItem,
    menu: (restaurant.menu || []).map(item => {
      // Giá app = markup 28% cơ sở + distance surcharge
      const baseAppPrice = calcAppPrice(item.inStorePrice);
      return {
        ...item,
        appPrice: baseAppPrice + extraMarkupPerItem
      };
    })
  };

  if (extraMarkupPerItem > 0) {
    console.log(`[Dynamic Pricing] "${restaurant.name}" cách ${distKm.toFixed(2)} km. Markup 28%: +${PRICING_CONFIG.MARKUP_RATE * 100}% | Surcharge: +${extraMarkupPerItem.toLocaleString('vi-VN')}đ/món`);
  }
  return clonedRestaurant;
}

function processRestaurantsWithLocation(localData, lat, lon) {
  if (!Array.isArray(localData)) return [];
  
  const userLat = parseFloat(lat) || 10.0345;
  const userLon = parseFloat(lon) || 105.7876;
  const userCoords = { lat: userLat, lon: userLon };

  const processed = localData.map(r => {
    if (!r) return null;
    
    // Copy/clone to avoid mutating shared cache objects unexpectedly
    const item = { ...r };
    
    // Geocode restaurant address to get lat/lon
    const coords = geocodeAddress(item.address || '', item.name || '');
    item.latitude = coords.lat;
    item.longitude = coords.lon;
    
    // Calculate distance in km
    const distKm = getHaversineDistance(userCoords, coords);
    item.distanceValue = distKm;
    
    // Format distance string
    if (distKm < 1) {
      item.distance = `${Math.round(distKm * 1000)} m`;
    } else {
      item.distance = `${distKm.toFixed(1)} km`;
    }
    
    // Update estimated delivery time based on distance (e.g. 15 mins base + 5 mins per km)
    const estMins = 12 + Math.round(distKm * 5);
    item.time = `${estMins}-${estMins + 8} phút`;
    
    return item;
  }).filter(Boolean);

  // Filter: Only include restaurants within 3.0 km
  let filteredData = processed.filter(r => r.distanceValue <= 3.0);
  if (filteredData.length === 0) {
    // Fallback: if empty, return the closest 10 restaurants
    filteredData = [...processed].sort((a, b) => a.distanceValue - b.distanceValue).slice(0, 10);
  }

  // Sort: Open stores first, then sorted by distance value.
  const openRests = filteredData.filter(r => !r.isClosed).sort((a, b) => a.distanceValue - b.distanceValue);
  const closedRests = filteredData.filter(r => r.isClosed).sort((a, b) => a.distanceValue - b.distanceValue);
  return [...openRests, ...closedRests];
}

function sanitizeLocalJsonData() {
  const localJsonPath = path.join(__dirname, 'restaurants-local.json');
  console.log('[Sanitization] 🔍 Đang quét và làm sạch dữ liệu trong restaurants-local.json...');
  try {
    if (fs.existsSync(localJsonPath)) {
      const raw = fs.readFileSync(localJsonPath, 'utf8');
      const localData = JSON.parse(raw);
      if (Array.isArray(localData)) {
        let changed = false;

        // Lọc bỏ các quán đã đóng cửa hoàn toàn
        const cleanData = localData.filter(restaurant => {
          if (restaurant.isClosed) {
            if (!hasReopenTime(restaurant.closedReason)) {
              console.log(`[Sanitization] 🗑️ Xóa quán đóng cửa hoàn toàn khỏi database: "${restaurant.name}" (${restaurant.closedReason || 'Không rõ lý do'})`);
              changed = true;
              return false; // Remove
            }
          }
          return true; // Keep
        });

        cleanData.forEach(restaurant => {
          // Reset trạng thái đóng cửa nếu đã đến giờ hẹn
          if (resetClosedIfNextAttemptReached(restaurant)) {
            changed = true;
          }

          // Bỏ qua quán đang đóng cửa - không gán template menu
          if (restaurant.isClosed) return;
          // Bỏ qua quán menu rỗng - để scraper detect đóng cửa khi client vào trang
          if (!restaurant.menu || restaurant.menu.length === 0) return;
          if (!restaurant.hasRealMenu) {
            const oldMenu = restaurant.menu;
            const newMenu = generateMenuForRestaurant(restaurant.name, restaurant.id);
            if (!oldMenu || oldMenu.length !== newMenu.length || oldMenu[0]?.name !== newMenu[0]?.name) {
              restaurant.menu = newMenu;
              changed = true;
              console.log(`[Sanitization] 🔄 Đã cập nhật menu giả lập chính xác cho: "${restaurant.name}"`);
            }
          }
        });

        if (changed) {
          fs.writeFileSync(localJsonPath, JSON.stringify(cleanData, null, 2), 'utf8');
          console.log('[Sanitization] 💾 Đã lưu thay đổi làm sạch vào restaurants-local.json');
        } else {
          console.log('[Sanitization] ✨ Không phát hiện sai sót menu hay quán đóng cửa cần xử lý!');
        }
      }
    }
  } catch (err) {
    console.error('[Sanitization] ❌ Lỗi làm sạch dữ liệu local JSON:', err.message);
  }
}

/**
 * Phân giải Slug ShopeeFood thực tế bằng cách cào trang chi tiết Foody
 */
async function getShopeeFoodSlugFromFoody(foodySlug) {
  const tryUrls = [
    `https://www.foody.vn/can-tho/${foodySlug}`,
    `https://www.foody.vn/thuong-hieu/${foodySlug}?c=can-tho`
  ];

  for (const url of tryUrls) {
    try {
      console.log(`[Slug Resolver] 🔍 Đang phân giải slug ShopeeFood từ Foody: ${url}...`);
      
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
        
        // Tìm liên kết ShopeeFood chứa /can-tho/
        $('a').each((i, el) => {
          const href = $(el).attr('href') || '';
          if (href.includes('shopeefood.vn/can-tho/') && !href.includes('/can-tho/fresh') && !href.includes('/can-tho/food')) {
            shopeefoodUrl = href;
          }
        });
        
        if (shopeefoodUrl) {
          // Tách lấy slug
          const parts = shopeefoodUrl.split('?')[0].split('/');
          const resolvedSlug = parts.pop() || parts.pop();
          if (resolvedSlug) {
            console.log(`[Slug Resolver] ✅ Tìm thấy slug thực tế trên ShopeeFood từ ${url}: "${resolvedSlug}"`);
            return resolvedSlug;
          }
        }
      }
    } catch (err) {
      console.warn(`[Slug Resolver] ⚠️ Thử phân giải từ ${url} không thành công:`, err.message);
    }
  }
  
  // Fallback về slug mặc định ban đầu
  return foodySlug;
}

/**
 * Phân giải các chi nhánh thực tế từ trang thương hiệu Foody
 */
async function resolveBrandBranches(brandSlug) {
  const url = `https://www.foody.vn/thuong-hieu/${brandSlug}?c=can-tho`;
  console.log(`[Brand Resolver] 🔍 Đang phân giải các chi nhánh từ trang thương hiệu: ${url}...`);
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      timeout: 10000
    });
    
    if (res.status !== 200) return [];
    
    const $ = cheerio.load(res.data);
    const branches = [];
    
    $('.ldc-item').each((i, el) => {
      const name = $(el).find('.ldc-item-h-name h2 a').text().trim();
      const foodyHref = $(el).find('.ldc-item-h-name h2 a').attr('href') || '';
      const address = $(el).find('.ldc-item-h-address span').text().trim();
      
      let img = $(el).find('.ldc-item-img img').attr('src') || '';
      if (!img || img.includes('ratin-rank') || img.includes('arrow-top')) {
        img = 'https://images.unsplash.com/photo-1625398407796-82650a8c135f?w=800&q=80';
      }
      
      let shopeefoodUrl = '';
      $(el).find('a').each((j, aEl) => {
        const href = $(aEl).attr('href') || '';
        if (href.includes('shopeefood.vn/can-tho/') && !href.includes('/can-tho/fresh') && !href.includes('/can-tho/food')) {
          shopeefoodUrl = href;
        }
      });
      
      if (name && shopeefoodUrl) {
        const parts = shopeefoodUrl.split('?')[0].split('/');
        const shopeefoodSlug = parts.pop() || parts.pop();
        
        let resId = 'r_ct_';
        if (shopeefoodSlug) {
          resId += shopeefoodSlug.replace(/-/g, '_');
        } else if (foodyHref) {
          resId += foodyHref.split('/').pop().replace(/-/g, '_');
        } else {
          resId += i;
        }
        
        branches.push({
          id: resId,
          name: name,
          address: address,
          img: img,
          shopeefoodSlug: shopeefoodSlug
        });
      }
    });
    
    console.log(`[Brand Resolver] ✅ Tìm thấy ${branches.length} chi nhánh từ thương hiệu: ${brandSlug}`);
    return branches;
  } catch (err) {
    console.warn(`[Brand Resolver] ⚠️ Lỗi phân giải chi nhánh từ thương hiệu ${brandSlug}:`, err.message);
    return [];
  }
}

async function fetchAndParseFromFoody(q = '') {
  const url = q ? `https://www.foody.vn/can-tho/dia-diem?q=${encodeURIComponent(q)}` : `https://www.foody.vn/can-tho/dia-diem`;
  console.log(`[Scraper] Gọi tới Foody: ${url}`);
  
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    }
  });
  
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const rawItems = $('.row-item');
  const list = [];
  const brandResolutions = [];

  // Đọc dữ liệu local trước để bảo tồn thực đơn thực tế và trạng thái nếu đã có
  const localJsonPath = path.join(__dirname, 'restaurants-local.json');
  let localData = [];
  try {
    if (fs.existsSync(localJsonPath)) {
      localData = JSON.parse(fs.readFileSync(localJsonPath, 'utf8'));
    }
  } catch (e) {}
  
  rawItems.each((index, el) => {
    const name = $(el).find('h2 a, .row-item-title a, a[class*="title"]').text().trim();
    const href = $(el).find('h2 a, .row-item-title a, a[class*="title"]').attr('href') || '';
    
    let img = $(el).find('.ri-avatar img, img').attr('src') || '';
    if (!img || img.includes('ratin-rank') || img.includes('arrow-top')) {
      img = 'https://images.unsplash.com/photo-1625398407796-82650a8c135f?w=800&q=80';
    }

    let ratingText = $(el).find('.point, .highlight-text').text().trim();
    let rating = parseFloat(ratingText);
    if (isNaN(rating) || rating <= 0) rating = 4.6;

    let address = $(el).find('.address, .row-item-address').text().trim();
    address = address.replace(/\s+/g, ' ').replace(/ ,/g, ',').trim();

    const commentsText = $(el).find('.stats a span').first().text().trim();
    let reviews = parseInt(commentsText);
    if (isNaN(reviews) || reviews <= 0) reviews = 100 + Math.floor(Math.random() * 500);

    if (href.includes('/thuong-hieu/')) {
      const brandSlug = href.split('?')[0].split('/').pop();
      brandResolutions.push(
        resolveBrandBranches(brandSlug).then(branches => {
          branches.forEach(branch => {
            let cat = 'Đồ ăn';
            const bn = branch.name.toLowerCase();
            if (bn.includes('coffee') || bn.includes('café') || bn.includes('cà phê')) cat = 'Cà phê';
            else if (bn.includes('trà sữa') || bn.includes('milk tea')) cat = 'Trà sữa';
            else if (bn.includes('bún bò')) cat = 'Bún Bò';
            else if (bn.includes('hủ tiếu')) cat = 'Hủ Tiếu';
            else if (bn.includes('bánh mì')) cat = 'Bánh Mì';
            else if (bn.includes('lẩu')) cat = 'Lẩu';
            else if (bn.includes('pizza') || bn.includes('burger')) cat = 'Fast Food';
            else if (bn.includes('cơm')) cat = 'Cơm tấm';

            // Bảo tồn dữ liệu thực tế đã có trong database
            let existingMenu = null;
            let hasRealMenu = false;
            let isClosed = false;
            let closedAt = null;
            let closedReason = null;
            let menuTemplateFallback = false;

            const existing = Array.isArray(localData) ? localData.find(r => String(r.id) === String(branch.id)) : null;
            if (existing) {
              if (existing.hasRealMenu) {
                existingMenu = existing.menu;
                hasRealMenu = true;
              }
              if (existing.isClosed) {
                isClosed = true;
                closedAt = existing.closedAt;
                closedReason = existing.closedReason;
              }
              if (existing.menuTemplateFallback) {
                menuTemplateFallback = true;
              }
            }

            const menu = existingMenu || generateMenuForRestaurant(branch.name, branch.id);
            if (!existingMenu) {
              menuTemplateFallback = true;
            }
            const menuUpdatedAt = existing ? existing.menuUpdatedAt : null;

            list.push({
              id:       branch.id,
              name:     branch.name,
              category: cat,
              rating:   rating,
              reviews:  reviews,
              distance: (Math.random() * 2 + 0.3).toFixed(1) + ' km',
              time:     `${15 + Math.floor(Math.random() * 20)}-${25 + Math.floor(Math.random() * 20)} phút`,
              address:  branch.address,
              phone:    '0292 3' + Math.floor(100000 + Math.random() * 900000),
              img:      branch.img,
              tags:     [rating > 7.5 ? 'Nổi bật' : 'Đang mở', reviews > 400 ? 'Yêu thích' : 'Mới mở'].slice(0, 2),
              minOrder: 30000,
              menu,
              hasRealMenu,
              isClosed,
              closedAt,
              closedReason,
              menuTemplateFallback,
              menuUpdatedAt,
              shopeefoodSlug: branch.shopeefoodSlug
            });
          });
        })
      );
    } else {
      let resId = 'r_ct_';
      if (href) {
        // Loại bỏ phần query parameter (ví dụ: ?c=can-tho) trước khi split lấy slug làm ID
        resId += href.split('?')[0].split('/').pop().replace(/-/g, '_');
      } else {
        resId += index;
      }

      const distanceVal = (Math.random() * 2 + 0.3);
      const distance = distanceVal.toFixed(1) + ' km';
      const timeVal = Math.round(distanceVal * 6 + 10);
      const time = `${timeVal}-${timeVal + 8} phút`;

      let category = 'Đồ ăn';
      const n = name.toLowerCase();
      if (n.includes('coffee') || n.includes('café') || n.includes('cà phê')) category = 'Cà phê';
      else if (n.includes('trà sữa') || n.includes('milk tea')) category = 'Trà sữa';
      else if (n.includes('bún bò')) category = 'Bún Bò';
      else if (n.includes('hủ tiếu')) category = 'Hủ Tiếu';
      else if (n.includes('bánh mì')) category = 'Bánh Mì';
      else if (n.includes('lẩu')) category = 'Lẩu';
      else if (n.includes('pizza') || n.includes('burger')) category = 'Fast Food';
      else if (n.includes('cơm')) category = 'Cơm tấm';

      // Bảo tồn dữ liệu thực tế đã có trong database
      let existingMenu = null;
      let hasRealMenu = false;
      let isClosed = false;
      let closedAt = null;
      let closedReason = null;
      let menuTemplateFallback = false;

      const existing = Array.isArray(localData) ? localData.find(r => String(r.id) === String(resId)) : null;
      if (existing) {
        if (existing.hasRealMenu) {
          existingMenu = existing.menu;
          hasRealMenu = true;
        }
        if (existing.isClosed) {
          isClosed = true;
          closedAt = existing.closedAt;
          closedReason = existing.closedReason;
        }
        if (existing.menuTemplateFallback) {
          menuTemplateFallback = true;
        }
      }

      const menu = existingMenu || generateMenuForRestaurant(name, resId);
      if (!existingMenu) {
        menuTemplateFallback = true;
      }
      const menuUpdatedAt = existing ? existing.menuUpdatedAt : null;

      list.push({
        id:       resId,
        name,
        category,
        rating,
        reviews,
        distance,
        time,
        address,
        phone:    '0292 3' + Math.floor(100000 + Math.random() * 900000),
        img,
        tags:     [rating > 7.5 ? 'Nổi bật' : 'Đang mở', reviews > 400 ? 'Yêu thích' : 'Mới mở'].slice(0, 2),
        minOrder: 30000,
        menu,
        hasRealMenu,
        isClosed,
        closedAt,
        closedReason,
        menuTemplateFallback,
        menuUpdatedAt
      });
    }
  });
  
  await Promise.all(brandResolutions);
  return list;
}

// ── CONFIG ──────────────────────────────────────────────────────────────────
const CACHE_FILE     = path.join(__dirname, 'cache.json');
const FALLBACK_FILE  = path.join(__dirname, '..', 'customer-app', 'restaurants-data.js');
const CACHE_DURATION = 10 * 60 * 1000; // 10 phút

// Cần Thơ city ID trên ShopeeFood = 59
// Tọa độ trung tâm Cần Thơ
const CAN_THO_LAT  = 10.0452;
const CAN_THO_LNG  = 105.7469;
const CAN_THO_CITY = 59;

// Headers giả lập browser thật
const SHOPEEFOOD_HEADERS = {
  'User-Agent':               'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept':                   'application/json, text/plain, */*',
  'Accept-Language':          'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding':          'gzip, deflate, br',
  'Referer':                  'https://shopeefood.vn/',
  'Origin':                   'https://shopeefood.vn',
  'x-foody-client-id':        '',
  'x-foody-client-language':  'vi',
  'x-foody-client-type':      '1',
  'x-foody-api-version':      '1',
  'x-foody-client-version':   '3',
  'x-foody-support-chef-show':'true',
};

// ── CORS — cho phép web app local gọi vào ──────────────────────────────────
app.use(cors({
  origin: ['http://localhost:3001', 'http://127.0.0.1:3001', 'null', '*'],
  methods: ['GET']
}));
app.use(express.json());

// Phục vụ thư mục customer-app tĩnh (để không cần mở file:// trực tiếp)
app.use('/app', express.static(path.join(__dirname, '..', 'customer-app')));

// ── CACHE HELPERS ────────────────────────────────────────────────────────────
function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (Date.now() - data.timestamp < CACHE_DURATION) {
        return data.restaurants;
      }
    }
  } catch {}
  return null;
}

function writeCache(restaurants) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      timestamp: Date.now(),
      restaurants
    }, null, 2), 'utf8');
  } catch(e) {
    console.warn('[Cache] Không thể ghi cache:', e.message);
  }
}

// ── DATA TRANSFORMERS ────────────────────────────────────────────────────────
/**
 * Chuyển đổi từ format ShopeeFood → format web app
 */
function transformRestaurant(r, index) {
  const menu = (r.menu_items || r.dishes || []).map((item, i) => {
    const storePrice = item.price || item.display_price || 50000;
    // Thêm 28% markup cố định (làm tròn 100đ)
    const appPrice   = calcAppPrice(storePrice);

    return {
      id:           `${r.id || index}-item-${i}`,
      name:         item.name || item.dish_name || 'Món ăn',
      desc:         item.description || item.dish_description || '',
      inStorePrice: storePrice,
      appPrice:     appPrice,
      img:          item.photos?.[0]?.value || item.photo_url || getFoodPlaceholder(i),
      category:     item.category_name || item.group_name || 'Thực đơn'
    };
  });

  // Nếu không có menu từ API, tạo menu mẫu từ category
  if (menu.length === 0) {
    const defaultStorePrice = r.min_price || 45000;
    menu.push({
      id:           `${r.id || index}-item-0`,
      name:         `${r.display_type || 'Món'} Đặc Biệt`,
      desc:         `Món đặc trưng của ${r.name}`,
      inStorePrice: defaultStorePrice,
      appPrice:     calcAppPrice(defaultStorePrice),
      img:          r.photos?.[0]?.value || r.cover_photo || getRestaurantPlaceholder(r.name),
      category:     'Món chính'
    });
  }

  const distance = r.distance_display || r.distance
    ? (typeof r.distance === 'number' ? (r.distance / 1000).toFixed(1) + ' km' : r.distance_display)
    : `${(Math.random() * 2 + 0.3).toFixed(1)} km`;

  return {
    id:       String(r.id || `r${index}`),
    name:     r.name,
    category: r.display_type || r.cuisine_type || 'Đồ ăn',
    rating:   parseFloat(r.rating?.total_review || r.rating || 4.5),
    reviews:  parseInt(r.rating?.total_reviews || r.review_count || 100),
    distance: distance,
    time:     r.delivery_time || `${15 + Math.floor(Math.random() * 20)}-${25 + Math.floor(Math.random() * 20)} phút`,
    address:  r.address || r.full_address || 'Cần Thơ',
    phone:    r.phone || '',
    img:      r.photos?.[0]?.value || r.logo_img || r.cover_photo || getRestaurantPlaceholder(r.name),
    tags:     buildTags(r),
    minOrder: r.min_order_price || 30000,
    menu
  };
}

function buildTags(r) {
  const tags = [];
  if (r.is_quality_merchant) tags.push('Nổi bật');
  if (r.rating?.total_review > 200) tags.push('Yêu thích');
  if (r.is_new_restaurant) tags.push('Mới mở');
  if (r.promo_info?.has_discount) tags.push('Giảm giá');
  if (tags.length === 0) tags.push('Đang mở');
  return tags.slice(0, 2);
}

function getFoodPlaceholder(i) {
  const imgs = [
    'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80',
    'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80',
    'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80',
    'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80',
    'https://images.unsplash.com/photo-1563245372-f21724e3856d?w=400&q=80',
  ];
  return imgs[i % imgs.length];
}

function getRestaurantPlaceholder(name) {
  const imgs = [
    'https://images.unsplash.com/photo-1625398407796-82650a8c135f?w=800&q=80',
    'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=800&q=80',
    'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=800&q=80',
    'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=800&q=80',
    'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43?w=800&q=80',
    'https://images.unsplash.com/photo-1547592180-85f173990554?w=800&q=80',
    'https://images.unsplash.com/photo-1606755962773-d324e0a13086?w=800&q=80',
  ];
  const hash = (name || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return imgs[hash % imgs.length];
}

// ── FETCH FROM SHOPEEFOOD ────────────────────────────────────────────────────
async function fetchFromShopeeFood() {
  const endpoints = [
    // Endpoint 1: Danh sách quán theo tọa độ
    {
      url: `https://gappapi.deliverynow.vn/api/delivery/get_delivery_list`,
      params: {
        id_city:         CAN_THO_CITY,
        discovery_type:  1,
        foody_services:  1,
        keyword:         '',
        sort_type:       0,
        offset:          0,
        limit:           30,
        latitude:        CAN_THO_LAT,
        longitude:       CAN_THO_LNG
      }
    },
    // Endpoint 2: Quán theo khu vực
    {
      url: `https://gappapi.deliverynow.vn/api/delivery/get_restaurants_by_city`,
      params: {
        id_city:         CAN_THO_CITY,
        discovery_type:  1,
        foody_services:  1,
        keyword:         '',
        sort_type:       1,
        offset:          0,
        limit:           30
      }
    },
    // Endpoint 3: Tìm kiếm chung
    {
      url: `https://gappapi.deliverynow.vn/api/delivery/get_delivery_home`,
      params: {
        id_city:  CAN_THO_CITY,
        latitude: CAN_THO_LAT,
        longitude: CAN_THO_LNG
      }
    }
  ];

  for (const ep of endpoints) {
    try {
      console.log(`[ShopeeFood] Đang thử: ${ep.url}`);
      const res = await axios.get(ep.url, {
        headers: SHOPEEFOOD_HEADERS,
        params:  ep.params,
        timeout: 12000
      });

      const data = res.data;

      // Tìm mảng restaurants trong response
      const rawList =
        data?.result?.restaurants ||
        data?.result?.items ||
        data?.reply?.delivery_items ||
        data?.reply?.restaurants ||
        data?.data?.restaurants ||
        data?.restaurants ||
        [];

      if (rawList && rawList.length > 0) {
        console.log(`[ShopeeFood] ✅ Lấy được ${rawList.length} quán từ ${ep.url}`);
        return rawList.map(transformRestaurant);
      }
    } catch (err) {
      console.warn(`[ShopeeFood] ❌ ${ep.url}: ${err.response?.status || err.message}`);
    }
  }

  return null;
}

// ── ROUTES ───────────────────────────────────────────────────────────────────

function stripMenus(restaurants) {
  if (!Array.isArray(restaurants)) return restaurants;
  return restaurants.map(r => {
    const { menu, ...rest } = r;
    return rest;
  });
}

/**
 * GET /api/restaurants
 * Ưu tiên: Cache → ShopeeFood API → Fallback local data
 */
app.get('/api/restaurants', async (req, res) => {
  const query = req.query.q ? String(req.query.q).trim() : '';
  console.log(`\n[${new Date().toLocaleTimeString('vi-VN')}] GET /api/restaurants${query ? ' ?q=' + query : ''}`);

  // Nếu là yêu cầu tìm kiếm từ khóa thời gian thực
  if (query) {
    console.log(`[Search] Đang thực hiện tìm kiếm gộp cho từ khóa: "${query}"...`);
    
    // 1. Tìm kiếm trong cơ sở dữ liệu local file restaurants-local.json
    const localJsonPath = path.join(__dirname, 'restaurants-local.json');
    let localMatches = [];
    if (fs.existsSync(localJsonPath)) {
      try {
        const localData = JSON.parse(fs.readFileSync(localJsonPath, 'utf8'));
        if (Array.isArray(localData)) {
          const normQuery = normalizeText(query);
          const tokens = normQuery.split(/\s+/).filter(t => t.length > 0);
          
          localMatches = localData.filter(r => {
            const normName = normalizeText(r.name);
            const normCat = normalizeText(r.category);
            return tokens.every(token => 
              normName.includes(token) || 
              normCat.includes(token) ||
              (r.menu && r.menu.some(m => normalizeText(m.name).includes(token)))
            );
          });
          console.log(`[Search] 💾 Tìm thấy ${localMatches.length} quán trùng khớp trong local database.`);
        }
      } catch (e) {
        console.error('[Search] Lỗi đọc local JSON:', e.message);
      }
    }

    // 2. Tìm kiếm trực tuyến từ Foody (ĐÃ VÔ HIỆU HÓA để tránh quá tải/IP block, đảm bảo chịu tải 1000+ user cùng lúc)
    let onlineResults = [];

    // 3. Gộp kết quả (Ưu tiên bản ghi local có menu thực/giả lập chất lượng hơn, tránh trùng lặp)
    let mergedResults = [...localMatches];
    onlineResults.forEach(r => {
      if (r && r.id && !mergedResults.some(m => String(m.id) === String(r.id))) {
        mergedResults.push(r);
      }
    });

    // 3.5. Mở rộng kết quả cho các chuỗi hệ thống lớn
    // Nếu phát hiện từ khóa chuỗi lớn hoặc có quán thuộc chuỗi lớn, tự động mở rộng hiển thị toàn bộ chi nhánh
    const chainKeywords = ['jollibee', 'highlands', 'kfc', 'lotteria', 'lumos', 'xo', 'anh beo em u', 'phuc tea'];
    const chainsFound = new Set();
    
    const normQuery = normalizeText(query);
    chainKeywords.forEach(kw => {
      if (normQuery.includes(kw)) chainsFound.add(kw);
    });

    mergedResults.forEach(r => {
      const normName = normalizeText(r.name);
      chainKeywords.forEach(kw => {
        if (normName.includes(kw)) chainsFound.add(kw);
      });
    });

    if (chainsFound.size > 0) {
      console.log(`[Search Expansion] 🔄 Phát hiện từ khóa chuỗi lớn: [${Array.from(chainsFound).join(', ')}]. Tự động nạp toàn bộ chi nhánh...`);
      if (fs.existsSync(localJsonPath)) {
        try {
          const localData = JSON.parse(fs.readFileSync(localJsonPath, 'utf8'));
          if (Array.isArray(localData)) {
            localData.forEach(r => {
              const normName = normalizeText(r.name);
              let matchChain = false;
              chainsFound.forEach(kw => {
                if (normName.includes(kw)) matchChain = true;
              });
              if (matchChain) {
                if (!mergedResults.some(m => String(m.id) === String(r.id))) {
                  mergedResults.push(r);
                }
              }
            });
          }
        } catch (e) {}
      }

      // Lọc bỏ nút "Hệ thống" cha chung chung để khách đặt hàng trực tiếp tại chi nhánh cụ thể
      mergedResults = mergedResults.filter(r => {
        const normName = normalizeText(r.name);
        const addr = (r.address || '').toLowerCase();
        const isGenericParent = (normName.includes('he thong') || addr.includes('chi nhánh') || addr.includes('chi nhanh') || addr === '2 chi nhánh' || addr === '3 chi nhánh') &&
          (normName.includes('jollibee') || normName.includes('highlands') || normName.includes('kfc') || normName.includes('lotteria') || normName.includes('lumos') || normName.includes('xo') || normName.includes('anh beo em u') || normName.includes('phuc tea'));
        return !isGenericParent;
      });
    }

    // Sắp xếp kết quả: quán đang mở trước, quán đóng cửa sau
    mergedResults = [
      ...mergedResults.filter(r => !r.isClosed),
      ...mergedResults.filter(r => r.isClosed)
    ];

    // 4. Đồng bộ các kết quả search này vào SEARCHED_RESTAURANTS_CACHE phía server
    mergedResults.forEach(r => {
      if (r && r.id) {
        SEARCHED_RESTAURANTS_CACHE.set(String(r.id), r);
      }
    });

    // 5. Tự động lưu tất cả các quán ăn mới được cào từ Foody vào local database file restaurants-local.json một cách an toàn
    if (onlineResults && onlineResults.length > 0) {
      try {
        await updateLocalDatabase((localData) => {
          let hasNew = false;
          onlineResults.forEach(r => {
            const idx = localData.findIndex(item => String(item.id) === String(r.id));
            if (idx === -1) {
              localData.push(r);
              hasNew = true;
              console.log(`[Auto-Save] 📥 Tự động lưu quán ăn mới cào: "${r.name}"`);
            } else {
              // Đối chiếu và tự động cập nhật nếu có thay đổi từ online cào mới
              const localRest = localData[idx];
              let hasChanged = false;
              
              if (r.name && localRest.name !== r.name) {
                console.log(`[Comparison] 🔄 Cập nhật Tên quán: "${localRest.name}" -> "${r.name}"`);
                localRest.name = r.name;
                hasChanged = true;
              }
              if (r.category && localRest.category !== r.category) {
                console.log(`[Comparison] 🔄 Cập nhật Danh mục: "${localRest.category}" -> "${r.category}"`);
                localRest.category = r.category;
                hasChanged = true;
              }
              if (r.address && localRest.address !== r.address) {
                console.log(`[Comparison] 🔄 Cập nhật Địa chỉ: "${localRest.address}" -> "${r.address}"`);
                localRest.address = r.address;
                hasChanged = true;
              }
              if (r.img && localRest.img !== r.img) {
                localRest.img = r.img;
                hasChanged = true;
              }
              if (r.rating !== undefined && localRest.rating !== r.rating) {
                console.log(`[Comparison] 🔄 Cập nhật Điểm đánh giá cho "${localRest.name}": ${localRest.rating} -> ${r.rating}`);
                localRest.rating = r.rating;
                hasChanged = true;
              }
              if (r.reviews !== undefined && localRest.reviews !== r.reviews) {
                console.log(`[Comparison] 🔄 Cập nhật Số đánh giá cho "${localRest.name}": ${localRest.reviews} -> ${r.reviews}`);
                localRest.reviews = r.reviews;
                hasChanged = true;
              }
              if (r.isClosed !== undefined && localRest.isClosed !== r.isClosed) {
                console.log(`[Comparison] 🔄 Cập nhật Trạng thái đóng cửa cho "${localRest.name}": ${localRest.isClosed} -> ${r.isClosed}`);
                localRest.isClosed = r.isClosed;
                hasChanged = true;
              }

              if (hasChanged) {
                hasNew = true;
                // Đồng bộ thay đổi này ngược lại mergedResults và cache
                const mIdx = mergedResults.findIndex(m => String(m.id) === String(r.id));
                if (mIdx !== -1) {
                  // Giữ lại menu thực tế đã có trong database
                  mergedResults[mIdx] = { ...mergedResults[mIdx], ...localRest };
                }
                SEARCHED_RESTAURANTS_CACHE.set(String(r.id), localRest);
              }

              // (Background refresh disabled to ensure ShopeeFood independence)
            }
          });
          return hasNew;
        });
      } catch (err) {
        console.error('[Auto-Save] Lỗi tự động lưu quán ăn mới cào:', err.message);
      }
    }

    const processedResults = processRestaurantsWithLocation(mergedResults, req.query.lat, req.query.lon);
    console.log(`[Search] ✅ Trả về tổng cộng ${processedResults.length} quán ăn sau khi gộp và lọc khoảng cách.`);
    // Tìm kiếm thời gian thực: không cache vì kết quả thay đổi theo từ khóa
    res.set('Cache-Control', 'no-cache, no-store');
    return res.json({ source: 'merged_search', data: stripMenus(processedResults), total: processedResults.length });
  }

  const localJsonPath = path.join(__dirname, 'restaurants-local.json');
  let shouldTrigger = false;

  // 1. Kiểm tra xem file local có tồn tại và còn mới không (10 phút)
  try {
    if (fs.existsSync(localJsonPath)) {
      const stats = fs.statSync(localJsonPath);
      const ageMs = Date.now() - stats.mtimeMs;
      if (ageMs > 10 * 60 * 1000) { // 10 phút
        console.log(`[Cache] Dữ liệu local đã cũ (${Math.round(ageMs / 60000)} phút)`);
        shouldTrigger = true;
      }
    } else {
      console.log('[Cache] Chưa có dữ liệu local JSON');
      shouldTrigger = true;
    }
  } catch (e) {
    shouldTrigger = true;
  }

  // Nếu dữ liệu cũ hoặc chưa có, kích hoạt crawler chạy ngầm
  if (shouldTrigger && !query) {
    triggerCrawler();
  }

  // 2. Trả ngay dữ liệu đang có (Stale-While-Revalidate) để phản hồi siêu tốc dưới 10ms
  try {
    if (fs.existsSync(localJsonPath)) {
      const localData = JSON.parse(fs.readFileSync(localJsonPath, 'utf8'));
      if (Array.isArray(localData) && localData.length > 0) {
        let responseData = [];
        if (query) {
          // Fallback lọc dữ liệu local nếu cào search thất bại
          const qLower = query.toLowerCase();
          const matches = localData.filter(r =>
            r.name.toLowerCase().includes(qLower) ||
            (r.category && r.category.toLowerCase().includes(qLower)) ||
            (r.menu && r.menu.some(m => m.name && m.name.toLowerCase().includes(qLower)))
          );
          responseData = processRestaurantsWithLocation(matches, req.query.lat, req.query.lon);
          console.log(`[Response Fallback] Lọc từ local JSON: ${responseData.length} kết quả cho "${query}"`);
        } else {
          responseData = processRestaurantsWithLocation(localData, req.query.lat, req.query.lon);
          console.log(`[Response] ✅ Trả ngay ${responseData.length} quán từ restaurants-local.json sau khi lọc khoảng cách (mở: ${responseData.filter(r=>!r.isClosed).length}, đóng: ${responseData.filter(r=>r.isClosed).length})`);
        }
        // Danh sách không tìm kiếm: cache 30s ở client, stale-while-revalidate 60s
        if (!query) res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
        return res.json({ source: query ? 'local_search_fallback' : 'local', data: stripMenus(responseData), total: responseData.length });
      }
    }
  } catch (jsonErr) {
    console.error('[Fallback] Lỗi đọc restaurants-local.json:', jsonErr.message);
  }

  // 3. Fallback: nếu chưa có local JSON, đọc từ restaurants-data.js bằng eval
  console.log('[Fallback] Đọc dữ liệu mẫu từ restaurants-data.js');
  try {
    const rawJs = fs.readFileSync(FALLBACK_FILE, 'utf8');
    const sandboxFn = new Function('module', 'exports', rawJs + '\n return RESTAURANTS;');
    const localData = sandboxFn({}, {});
    if (Array.isArray(localData) && localData.length > 0) {
      let responseData = [];
      if (query) {
        const qLower = query.toLowerCase();
        const matches = localData.filter(r =>
          r.name.toLowerCase().includes(qLower) ||
          r.category.toLowerCase().includes(qLower) ||
          r.menu.some(m => m.name.toLowerCase().includes(qLower))
        );
        responseData = processRestaurantsWithLocation(matches, req.query.lat, req.query.lon);
      } else {
        responseData = processRestaurantsWithLocation(localData, req.query.lat, req.query.lon);
      }
      console.log(`[Fallback] ✅ ${responseData.length} quán từ restaurants-data.js sau khi lọc khoảng cách`);
      return res.json({ source: 'local', data: stripMenus(responseData), total: responseData.length });
    }
  } catch (evalErr) {
    console.error('[Fallback] Lỗi đọc restaurants-data.js:', evalErr.message);
  }

  res.json({ source: 'emergency', data: [], total: 0 });
});

function triggerBackgroundMenuScrape(restaurant) {
  if (!restaurant || !restaurant.id) return;
  if (restaurant._isScraping) return;
  restaurant._isScraping = true;

  let slug = restaurant.shopeefoodSlug || restaurant.id.replace('r_ct_', '').split('?')[0].replace(/_/g, '-');
  
  console.log(`[Background Scraper] ⏳ Đang phân giải slug thực tế chạy ngầm cho: "${restaurant.name}"...`);

  const resolvePromise = restaurant.shopeefoodSlug
    ? Promise.resolve(restaurant.shopeefoodSlug)
    : getShopeeFoodSlugFromFoody(slug);

  resolvePromise.then(resolvedSlug => {
    let finalSlug = resolvedSlug;
    if (SLUG_REWRITER_MAP[finalSlug]) {
      console.log(`[Slug Rewriter] 🔄 Chuyển hướng slug chi nhánh thực tế: "${finalSlug}" → "${SLUG_REWRITER_MAP[finalSlug]}"`);
      finalSlug = SLUG_REWRITER_MAP[finalSlug];
    }
    
    console.log(`[Background Scraper] ⏳ Đang cào menu thực tế chạy ngầm cho: "${restaurant.name}" (${finalSlug})...`);
    return menuScraper.scrapeMenu(finalSlug);
  }).then(realMenu => {
    restaurant._isScraping = false;

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

    if (isClosed) {
      console.log(`[Background Scraper] 🔴 Xác nhận quán ĐÓNG CỬA: "${restaurant.name}"`);
      
      if (!hasReopenTime(closedReason)) {
        console.log(`[Background Scraper] 🗑️ Xóa quán đóng cửa hoàn toàn khỏi cache & DB: "${restaurant.name}"`);
        SEARCHED_RESTAURANTS_CACHE.delete(restaurant.id);
        updateLocalDatabase((localData) => {
          const idx = localData.findIndex(r => String(r.id) === String(restaurant.id));
          if (idx !== -1) {
            localData.splice(idx, 1);
            return true;
          }
          return false;
        }).catch(err => {
          console.error('[Background Scraper] Lỗi khi xóa quán khỏi database:', err.message);
        });
        return;
      }

      // Quán đóng cửa tạm thời
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(7, 0, 0, 0);

      restaurant.isClosed = true;
      restaurant.closedAt = new Date().toISOString();
      restaurant.closedReason = closedReason;
      restaurant.crawlNextAttempt = tomorrow.toISOString();

      if (menu) {
        restaurant.menu = menu;
        restaurant.hasRealMenu = true;
        restaurant.menuUpdatedAt = new Date().toISOString();
        delete restaurant.menuTemplateFallback;
        console.log(`[Background Scraper] ⚡ Cập nhật menu thực tế thành công cho quán ĐÓNG CỬA TẠM THỜI: "${restaurant.name}" (${menu.length} món)`);
      }

      SEARCHED_RESTAURANTS_CACHE.set(restaurant.id, restaurant);

      updateLocalDatabase((localData) => {
        const idx = localData.findIndex(r => String(r.id) === String(restaurant.id));
        if (idx !== -1) {
          localData[idx].isClosed = true;
          localData[idx].closedAt = restaurant.closedAt;
          localData[idx].closedReason = restaurant.closedReason;
          localData[idx].crawlNextAttempt = restaurant.crawlNextAttempt;
          if (menu) {
            localData[idx].menu = menu;
            localData[idx].hasRealMenu = true;
            localData[idx].menuUpdatedAt = restaurant.menuUpdatedAt;
            delete localData[idx].menuTemplateFallback;
          }
          return true;
        } else {
          const toSave = { ...restaurant };
          delete toSave._isScraping;
          localData.push(toSave);
          return true;
        }
      }).then(() => {
        console.log(`[Background Scraper] 💾 Đã lưu trạng thái đóng cửa tạm thời cho "${restaurant.name}"`);
      }).catch(err => {
        console.error('[Background Scraper] Lỗi khi ghi đè cập nhật restaurants-local.json:', err.message);
      });

    } else if (menu) {
      restaurant.menu = menu;
      restaurant.hasRealMenu = true;
      restaurant.menuUpdatedAt = new Date().toISOString();
      if (restaurant.isClosed) {
        console.log(`[Background Scraper] 🟢 Xóa trạng thái đóng cửa SAI cho: "${restaurant.name}" - quán có menu thực tế!`);
        restaurant.isClosed = false;
        delete restaurant.closedAt;
        delete restaurant.closedReason;
      }
      delete restaurant.menuTemplateFallback;
      console.log(`[Background Scraper] ⚡ Cập nhật menu thực tế thành công cho: "${restaurant.name}" (${menu.length} món)`);

      SEARCHED_RESTAURANTS_CACHE.set(restaurant.id, restaurant);

      updateLocalDatabase((localData) => {
        const idx = localData.findIndex(r => String(r.id) === String(restaurant.id));
        if (idx !== -1) {
          localData[idx].menu = menu;
          localData[idx].hasRealMenu = true;
          localData[idx].menuUpdatedAt = restaurant.menuUpdatedAt;
          if (localData[idx].isClosed) {
            localData[idx].isClosed = false;
            delete localData[idx].closedAt;
            delete localData[idx].closedReason;
          }
          delete localData[idx].menuTemplateFallback;
          return true;
        } else {
          const toSave = { ...restaurant };
          delete toSave._isScraping;
          localData.push(toSave);
          return true;
        }
      }).then(() => {
        console.log(`[Background Scraper] 💾 Đã lưu menu thực tế của "${restaurant.name}" vào restaurants-local.json`);
      }).catch(err => {
        console.error('[Background Scraper] Lỗi khi ghi đè cập nhật restaurants-local.json:', err.message);
      });

    } else {
      console.warn(`[Background Scraper] ⚠️ Lỗi kỹ thuật khi cào "${restaurant.name}". Dùng menu template thay thế.`);
      const templateMenu = generateMenuForRestaurant(restaurant.name, restaurant.id);
      restaurant.menuUpdatedAt = new Date().toISOString();
      if (!restaurant.menu || restaurant.menu.length < templateMenu.length) {
        restaurant.menu = templateMenu;
        restaurant.menuTemplateFallback = true;
      }
      SEARCHED_RESTAURANTS_CACHE.set(restaurant.id, restaurant);

      updateLocalDatabase((localData) => {
        const idx = localData.findIndex(r => String(r.id) === String(restaurant.id));
        if (idx !== -1) {
          if (!localData[idx].menu || localData[idx].menu.length < templateMenu.length) {
            localData[idx].menu = templateMenu;
            localData[idx].menuTemplateFallback = true;
          }
          localData[idx].menuUpdatedAt = restaurant.menuUpdatedAt;
          return true;
        } else {
          const toSave = { ...restaurant };
          delete toSave._isScraping;
          localData.push(toSave);
          return true;
        }
      }).then(() => {
        console.log(`[Background Scraper] 💾 Đã lưu menu template của "${restaurant.name}" vào restaurants-local.json`);
      }).catch(err => {
        console.error('[Background Scraper] Lỗi khi ghi đè cập nhật restaurants-local.json:', err.message);
      });
    }
  }).catch(err => {
    restaurant._isScraping = false;
    console.error(`[Background Scraper] Lỗi luồng cào ngầm cho "${restaurant.name}":`, err.message);
    // Fallback nếu lỗi: gán template
    if (!restaurant.menu || restaurant.menu.length === 0) {
      restaurant.menu = generateMenuForRestaurant(restaurant.name, restaurant.id);
      SEARCHED_RESTAURANTS_CACHE.set(restaurant.id, restaurant);
    }
  });
}

/**
 * GET /api/restaurants/:id
 * Thông tin chi tiết + menu của 1 quán
 */
app.get('/api/restaurants/:id', async (req, res) => {
  const id = String(req.params.id);
  console.log(`[Details] Yêu cầu chi tiết quán ăn ID: "${id}"`);

  let found = null;
  let source = '';

  // 1. Kiểm tra trong bộ nhớ tạm SEARCHED_RESTAURANTS_CACHE trước tiên
  if (SEARCHED_RESTAURANTS_CACHE.has(id)) {
    console.log(`[Details] ✅ Tìm thấy quán trong SEARCHED_RESTAURANTS_CACHE: ${id}`);
    found = SEARCHED_RESTAURANTS_CACHE.get(id);
    source = 'search_cache';
  }

  // 2. Kiểm tra trong file restaurants-local.json
  if (!found) {
    const localJsonPath = path.join(__dirname, 'restaurants-local.json');
    try {
      if (fs.existsSync(localJsonPath)) {
        const localData = JSON.parse(fs.readFileSync(localJsonPath, 'utf8'));
        if (Array.isArray(localData)) {
          const matched = localData.find(r => String(r.id) === id);
          if (matched) {
            console.log(`[Details] ✅ Tìm thấy quán trong restaurants-local.json: ${id}`);
            found = matched;
            source = 'local_file';
          }
        }
      }
    } catch (err) {
      console.error('[Details] Lỗi khi đọc restaurants-local.json:', err.message);
    }
  }

  // 3. Kiểm tra trong cache mặc định (readCache())
  if (!found) {
    const cached = readCache();
    if (cached) {
      const matched = cached.find(r => String(r.id) === id);
      if (matched) {
        console.log(`[Details] ✅ Tìm thấy quán trong readCache(): ${id}`);
        found = matched;
        source = 'cache';
      }
    }
  }

  // 4. Kiểm tra trong restaurants-data.js mẫu
  if (!found) {
    try {
      const rawJs = fs.readFileSync(FALLBACK_FILE, 'utf8');
      const sandboxFn = new Function('module', 'exports', rawJs + '\n return RESTAURANTS;');
      const localData = sandboxFn({}, {});
      if (Array.isArray(localData)) {
        const matched = localData.find(r => String(r.id) === id);
        if (matched) {
          console.log(`[Details] ✅ Tìm thấy quán trong restaurants-data.js: ${id}`);
          found = matched;
          source = 'fallback_file';
        }
      }
    } catch (err) {
      console.error('[Details] Lỗi khi đọc restaurants-data.js:', err.message);
    }
  }

  if (found) {
    if (resetClosedIfNextAttemptReached(found)) {
      await updateLocalDatabase((localData) => {
        const idx = localData.findIndex(r => String(r.id) === String(found.id));
        if (idx !== -1) {
          localData[idx].isClosed = false;
          delete localData[idx].closedAt;
          delete localData[idx].closedReason;
          delete localData[idx].crawlNextAttempt;
          return true;
        }
        return false;
      });
      SEARCHED_RESTAURANTS_CACHE.set(found.id, found);
    }

    // Nếu chưa có menu trong database, tạo menu mẫu để phục vụ lập tức (Độc lập ShopeeFood)
    if (!found.menu || found.menu.length === 0) {
      console.log(`[Details] ℹ️ Quán "${found.name}" chưa có thực đơn. Tạo menu mẫu thay thế...`);
      const templateMenu = generateMenuForRestaurant(found.name, found.id);
      found.menu = templateMenu;
      found.menuTemplateFallback = true;
      found.hasRealMenu = false;
      
      await updateLocalDatabase((localData) => {
        const idx = localData.findIndex(r => String(r.id) === String(found.id));
        if (idx !== -1) {
          localData[idx].menu = templateMenu;
          localData[idx].menuTemplateFallback = true;
          localData[idx].hasRealMenu = false;
          return true;
        }
        return false;
      });
      SEARCHED_RESTAURANTS_CACHE.set(found.id, found);
    }
    return res.json({ source, data: applyDistanceMarkupToMenu(found, req.query.lat, req.query.lon) });
  }

  console.log(`[Details] ❌ Không tìm thấy quán ăn với ID: "${id}"`);
  res.status(404).json({ error: 'Không tìm thấy quán ăn với ID được cung cấp' });
});

/**
 * POST /api/cache/clear
 * Xóa cache để force reload từ ShopeeFood
 */
app.post('/api/cache/clear', (req, res) => {
  try {
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
    console.log('[Cache] Đã xóa cache');
    res.json({ success: true, message: 'Cache đã được xóa. Lần sau load sẽ fetch từ ShopeeFood.' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ORDER DATABASE & API ENDPOINTS ──────────────────────────────────────────
let ordersQueuePromise = Promise.resolve();
const ORDERS_FILE_PATH = path.join(__dirname, 'orders-local.json');

function readOrdersDatabase() {
  try {
    if (!fs.existsSync(ORDERS_FILE_PATH)) {
      return [];
    }
    const raw = fs.readFileSync(ORDERS_FILE_PATH, 'utf8');
    return JSON.parse(raw) || [];
  } catch (e) {
    console.error('[Orders DB] Lỗi đọc database:', e.message);
    return [];
  }
}

function updateOrdersDatabase(updaterFn) {
  return new Promise((resolve, reject) => {
    ordersQueuePromise = ordersQueuePromise.then(() => {
      try {
        if (!fs.existsSync(ORDERS_FILE_PATH)) {
          fs.writeFileSync(ORDERS_FILE_PATH, '[]', 'utf8');
        }
        const raw = fs.readFileSync(ORDERS_FILE_PATH, 'utf8');
        let data = [];
        try {
          data = JSON.parse(raw);
        } catch (e) {
          console.error('[Orders DB Queue] Lỗi parse JSON:', e.message);
          data = [];
        }
        if (Array.isArray(data)) {
          const result = updaterFn(data);
          if (result !== false) {
            fs.writeFileSync(ORDERS_FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
          }
        }
        resolve();
      } catch (err) {
        console.error('[Orders DB Queue] Lỗi thực thi hàng đợi DB:', err.message);
        reject(err);
      }
    });
  });
}

/**
 * POST /api/orders
 * Khách hàng gửi đơn hàng lên server (lưu vào orders-local.json)
 */
app.post('/api/orders', async (req, res) => {
  try {
    const orderData = req.body;
    if (!orderData || typeof orderData !== 'object') {
      return res.status(400).json({ error: 'Đơn hàng không hợp lệ' });
    }

    const orderId = orderData.id || 'SPF-' + Math.floor(100000 + Math.random() * 900000);
    const newOrder = {
      id: orderId,
      restaurantId: orderData.restaurantId || null,
      restaurantName: orderData.restaurantName || '',
      restaurantAddress: orderData.restaurantAddress || '',
      restaurantLat: typeof orderData.restaurantLat === 'number' ? orderData.restaurantLat : null,
      restaurantLon: typeof orderData.restaurantLon === 'number' ? orderData.restaurantLon : null,
      items: Array.isArray(orderData.items) ? orderData.items : [],
      storeTotal: typeof orderData.storeTotal === 'number' ? orderData.storeTotal : 0,
      appTotal: typeof orderData.appTotal === 'number' ? orderData.appTotal : 0,
      shipperEarning: typeof orderData.shipperEarning === 'number' ? orderData.shipperEarning : 0,
      discountValue: typeof orderData.discountValue === 'number' ? orderData.discountValue : 0,
      minServiceFee: typeof orderData.minServiceFee === 'number' ? orderData.minServiceFee : 0,
      status: 'PENDING',
      shipperId: null,
      shipperName: null,
      shipperPhone: null,
      shipperLat: null,
      shipperLon: null,
      deliveryAddress: orderData.deliveryAddress || '',
      deliveryName: orderData.deliveryName || '',
      deliveryPhone: orderData.deliveryPhone || '',
      ordererPhone: orderData.ordererPhone || '',
      pinnedLat: typeof orderData.pinnedLat === 'number' ? orderData.pinnedLat : null,
      pinnedLon: typeof orderData.pinnedLon === 'number' ? orderData.pinnedLon : null,
      isRelative: orderData.isRelative === true,
      note: orderData.note || '',
      createdAt: orderData.createdAt || Date.now(),
      acceptedAt: null,
      purchasedAt: null,
      deliveredAt: null,
      rating: null,
      comment: null
    };

    await updateOrdersDatabase((orders) => {
      orders.push(newOrder);
    });

    console.log(`[Order Server] 📝 Đã lưu đơn hàng mới: ${newOrder.id}`);
    res.json({ success: true, data: newOrder });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/orders
 * Shipper/Khách hàng lấy danh sách đơn hàng (hỗ trợ filter trạng thái ?status=PENDING)
 */
app.get('/api/orders', (req, res) => {
  try {
    const { status } = req.query;
    const orders = readOrdersDatabase();
    if (status) {
      const filtered = orders.filter(o => o.status === status);
      return res.json({ success: true, data: filtered });
    }
    res.json({ success: true, data: orders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/orders/:id
 * Lấy thông tin chi tiết một đơn hàng kèm tọa độ shipper hiện tại
 */
app.get('/api/orders/:id', (req, res) => {
  try {
    const { id } = req.params;
    const orders = readOrdersDatabase();
    const order = orders.find(o => o.id === id);
    if (!order) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }
    res.json({ success: true, data: order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/orders/:id/accept
 * Shipper nhận đơn hàng (chuyển sang ACCEPTED, cập nhật thông tin tài xế và acceptedAt)
 */
app.post('/api/orders/:id/accept', async (req, res) => {
  try {
    const { id } = req.params;
    const { shipperId, shipperName, shipperPhone } = req.body;

    let updatedOrder = null;
    let found = false;

    await updateOrdersDatabase((orders) => {
      const idx = orders.findIndex(o => o.id === id);
      if (idx !== -1) {
        found = true;
        orders[idx].status = 'ACCEPTED';
        orders[idx].acceptedAt = Date.now();
        orders[idx].shipperId = shipperId || 'shipper-default';
        orders[idx].shipperName = shipperName || 'Nguyễn Văn Tài';
        orders[idx].shipperPhone = shipperPhone || '0901 234 567';
        updatedOrder = orders[idx];
      } else {
        return false;
      }
    });

    if (!found) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }

    console.log(`[Order Server] 🛵 Shipper đã nhận đơn: ${id}`);
    res.json({ success: true, data: updatedOrder });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/orders/:id/status
 * Shipper cập nhật trạng thái đơn (PURCHASED hoặc DELIVERED, ghi nhận thời gian tương ứng)
 */
app.post('/api/orders/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['ACCEPTED', 'PURCHASED', 'DELIVERED', 'PENDING'].includes(status)) {
      return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
    }

    let updatedOrder = null;
    let found = false;

    await updateOrdersDatabase((orders) => {
      const idx = orders.findIndex(o => o.id === id);
      if (idx !== -1) {
        found = true;
        orders[idx].status = status;
        if (status === 'PURCHASED') {
          orders[idx].purchasedAt = Date.now();
        } else if (status === 'DELIVERED') {
          orders[idx].deliveredAt = Date.now();
        }
        updatedOrder = orders[idx];
      } else {
        return false;
      }
    });

    if (!found) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }

    console.log(`[Order Server] 🔄 Cập nhật trạng thái đơn ${id} thành: ${status}`);
    res.json({ success: true, data: updatedOrder });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/orders/:id/location
 * Shipper cập nhật tọa độ GPS thời gian thực (shipperLat, shipperLon) lên server
 */
app.post('/api/orders/:id/location', async (req, res) => {
  try {
    const { id } = req.params;
    const { lat, lon } = req.body;

    if (typeof lat !== 'number' || typeof lon !== 'number') {
      return res.status(400).json({ error: 'Tọa độ không hợp lệ' });
    }

    let found = false;
    let updatedOrder = null;

    await updateOrdersDatabase((orders) => {
      const idx = orders.findIndex(o => o.id === id);
      if (idx !== -1) {
        found = true;
        orders[idx].shipperLat = lat;
        orders[idx].shipperLon = lon;
        updatedOrder = orders[idx];
      } else {
        return false;
      }
    });

    if (!found) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }

    res.json({ success: true, data: updatedOrder });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/orders/:id/rate
 * Khách hàng gửi đánh giá chất lượng shipper (rating và comment)
 */
app.post('/api/orders/:id/rate', async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, comment } = req.body;

    if (typeof rating !== 'number') {
      return res.status(400).json({ error: 'Đánh giá rating không hợp lệ' });
    }

    let found = false;
    let updatedOrder = null;

    await updateOrdersDatabase((orders) => {
      const idx = orders.findIndex(o => o.id === id);
      if (idx !== -1) {
        found = true;
        orders[idx].rating = rating;
        orders[idx].comment = comment || '';
        updatedOrder = orders[idx];
      } else {
        return false;
      }
    });

    if (!found) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }

    console.log(`[Order Server] ⭐ Khách hàng đánh giá đơn ${id}: ${rating} sao`);
    res.json({ success: true, data: updatedOrder });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/orders/:id/messages
 * Gửi tin nhắn mới cho đơn hàng (được lưu trong mảng messages của đơn hàng)
 */
app.post('/api/orders/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    const { sender, text } = req.body;

    if (!sender || !text) {
      return res.status(400).json({ error: 'Thiếu người gửi (sender) hoặc nội dung tin nhắn (text)' });
    }

    let updatedOrder = null;
    let found = false;

    await updateOrdersDatabase((orders) => {
      const idx = orders.findIndex(o => o.id === id);
      if (idx !== -1) {
        found = true;
        if (!orders[idx].messages) {
          orders[idx].messages = [];
        }
        orders[idx].messages.push({
          sender,
          text,
          timestamp: Date.now()
        });
        updatedOrder = orders[idx];
      } else {
        return false;
      }
    });

    if (!found) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }

    console.log(`[Order Server] 💬 [Đơn ${id}] ${sender}: ${text}`);
    res.json({ success: true, messages: updatedOrder.messages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WebRTC VoIP CALL SIGNALING REGISTRY ───────────────────────────────────
const activeCalls = {};

/**
 * POST /api/orders/:id/call/initiate
 * Bắt đầu một cuộc gọi từ customer hoặc shipper
 */
app.post('/api/orders/:id/call/initiate', (req, res) => {
  const { id } = req.params;
  const { caller, offer } = req.body;
  
  if (!caller) {
    return res.status(400).json({ error: 'Thiếu người gọi (caller)' });
  }

  activeCalls[id] = {
    status: 'ringing',
    caller,
    offer: offer || null,
    answer: null,
    callerCandidates: [],
    calleeCandidates: [],
    timestamp: Date.now(),
    lastPollCustomer: Date.now(),
    lastPollShipper: Date.now()
  };

  console.log(`[Call Server] 📞 Khởi tạo cuộc gọi cho đơn ${id} bởi ${caller}`);
  res.json({ success: true, call: activeCalls[id] });
});

/**
 * POST /api/orders/:id/call/respond
 * Trả lời hoặc xử lý cuộc gọi (accept/decline/end)
 */
app.post('/api/orders/:id/call/respond', (req, res) => {
  const { id } = req.params;
  const { action, answer } = req.body; // action: 'accept' | 'decline' | 'end'
  
  const call = activeCalls[id];
  if (!call) {
    return res.status(404).json({ error: 'Không có cuộc gọi hoạt động cho đơn hàng này' });
  }

  if (action === 'accept') {
    call.status = 'connected';
    if (answer) call.answer = answer;
    console.log(`[Call Server] 📞 Cuộc gọi cho đơn ${id} đã được chấp nhận`);
  } else if (action === 'decline') {
    call.status = 'ended';
    console.log(`[Call Server] 📞 Cuộc gọi cho đơn ${id} bị từ chối`);
  } else if (action === 'end') {
    call.status = 'ended';
    console.log(`[Call Server] 📞 Cuộc gọi cho đơn ${id} kết thúc`);
  }

  res.json({ success: true, call });
});

/**
 * POST /api/orders/:id/call/candidate
 * Gửi ứng viên ICE candidate
 */
app.post('/api/orders/:id/call/candidate', (req, res) => {
  const { id } = req.params;
  const { sender, candidate } = req.body; // sender: 'customer' | 'shipper'
  
  const call = activeCalls[id];
  if (!call) {
    return res.status(404).json({ error: 'Không có cuộc gọi hoạt động' });
  }

  if (sender === call.caller) {
    call.callerCandidates.push(candidate);
  } else {
    call.calleeCandidates.push(candidate);
  }

  res.json({ success: true });
});

/**
 * GET /api/orders/:id/call/poll
 * Thăm dò trạng thái cuộc gọi
 */
app.get('/api/orders/:id/call/poll', (req, res) => {
  const { id } = req.params;
  const { role } = req.query; // 'customer' | 'shipper'
  const call = activeCalls[id] || null;
  
  if (call) {
    const now = Date.now();
    if (role === 'customer') {
      call.lastPollCustomer = now;
    } else if (role === 'shipper') {
      call.lastPollShipper = now;
    }
    
    // Auto-timeout detection
    if (call.status === 'ringing' || call.status === 'connected') {
      const customerTimeout = call.lastPollCustomer && (now - call.lastPollCustomer > 6000);
      const shipperTimeout = call.lastPollShipper && (now - call.lastPollShipper > 6000);
      const ringTimeout = call.status === 'ringing' && (now - call.timestamp > 30000);
      
      if (customerTimeout || shipperTimeout || ringTimeout) {
        console.log(`[Call Server] 📞 Auto-ending call for order ${id} due to connection timeout or inactive polling`);
        call.status = 'ended';
      }
    }
  }
  
  res.json({ success: true, call });
});

// ── SHIPPER AUTHENTICATION & SHIFT LOGS ────────────────────────────────────
const SHIPPERS_FILE_PATH = path.join(__dirname, 'shippers-local.json');

function readShippersDatabase() {
  try {
    if (!fs.existsSync(SHIPPERS_FILE_PATH)) {
      return [];
    }
    const raw = fs.readFileSync(SHIPPERS_FILE_PATH, 'utf8');
    return JSON.parse(raw) || [];
  } catch (e) {
    console.error('[Shippers DB] Lỗi đọc database:', e.message);
    return [];
  }
}

function writeShippersDatabase(data) {
  try {
    fs.writeFileSync(SHIPPERS_FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[Shippers DB] Lỗi ghi database:', e.message);
    return false;
  }
}

/**
 * POST /api/shippers/login
 * Xác thực trùng khớp cả SĐT và Họ tên tài xế (không phân biệt chữ hoa/thường, loại bỏ khoảng trắng thừa)
 */
app.post('/api/shippers/login', (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ success: false, error: 'Thiếu thông tin Họ tên hoặc Số điện thoại!' });
    }

    const shippers = readShippersDatabase();
    const cleanedInputPhone = phone.trim().replace(/\s+/g, '');
    const cleanedInputName = name.trim().toLowerCase().replace(/\s+/g, ' ');

    // Tìm shipper trùng số điện thoại
    const matchedPhoneShipper = shippers.find(s => s.phone.trim().replace(/\s+/g, '') === cleanedInputPhone);

    if (!matchedPhoneShipper) {
      return res.status(404).json({ success: false, error: 'Số điện thoại tài xế không tồn tại trên hệ thống!' });
    }

    // So sánh tiếp họ tên (không phân biệt hoa thường, dọn khoảng trắng thừa)
    const dbCleanedName = matchedPhoneShipper.name.trim().toLowerCase().replace(/\s+/g, ' ');
    if (dbCleanedName !== cleanedInputName) {
      return res.status(400).json({ success: false, error: 'Họ tên tài xế không trùng khớp với số điện thoại đăng ký!' });
    }

    res.json({ success: true, shipper: { name: matchedPhoneShipper.name, phone: matchedPhoneShipper.phone } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/shippers/shift
 * Cập nhật trạng thái ca làm việc (Vào ca/Ra ca - Check-in/Check-out)
 */
app.post('/api/shippers/shift', (req, res) => {
  try {
    const { phone, status } = req.body;
    if (!phone || !['ONLINE', 'OFFLINE'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Thông tin không hợp lệ!' });
    }

    const shippers = readShippersDatabase();
    const cleanedPhone = phone.trim().replace(/\s+/g, '');
    const idx = shippers.findIndex(s => s.phone.trim().replace(/\s+/g, '') === cleanedPhone);

    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Số điện thoại tài xế không tồn tại!' });
    }

    shippers[idx].status = status;
    if (status === 'ONLINE') {
      shippers[idx].lastCheckIn = new Date().toISOString();
    } else {
      shippers[idx].lastCheckOut = new Date().toISOString();
    }

    writeShippersDatabase(shippers);
    console.log(`[Shippers DB] 🛵 Tài xế ${shippers[idx].name} (${phone}) đã ${status === 'ONLINE' ? 'Vào ca (Check-in)' : 'Tắt ca (Check-out)'}`);
    
    res.json({ success: true, shipper: shippers[idx] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/shippers
 * Lấy danh sách tài xế cùng lịch sử check-in/out phục vụ CRM
 */
app.get('/api/shippers', (req, res) => {
  try {
    const shippers = readShippersDatabase();
    res.json({ success: true, data: shippers });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/status
 * Health check + trạng thái cache
 */
app.get('/api/status', (req, res) => {
  let cacheInfo = null;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      const ageMs  = Date.now() - data.timestamp;
      const ageMins = Math.round(ageMs / 60000);
      cacheInfo = {
        valid:       ageMs < CACHE_DURATION,
        ageMinutes:  ageMins,
        restaurants: data.restaurants?.length || 0,
        expiresIn:   Math.max(0, Math.round((CACHE_DURATION - ageMs) / 60000)) + ' phút'
      };
    }
  } catch {}

  res.json({
    status:  'online',
    version: '1.0.0',
    city:    'Cần Thơ',
    cache:   cacheInfo,
    endpoints: {
      restaurants:  '/api/restaurants',
      clearCache:   'POST /api/cache/clear',
      webApp:       '/app/index.html'
    }
  });
});

/**
 * GET /api/webrtc/ice-servers
 * Trả về danh sách ICE/TURN servers động cho WebRTC
 */
let cachedIceServers = null;
let cachedIceServersExpiry = 0;

app.get('/api/webrtc/ice-servers', async (req, res) => {
  // Trả về cache nếu còn hạn
  if (cachedIceServers && Date.now() < cachedIceServersExpiry) {
    return res.json(cachedIceServers);
  }

  // 1. Kiểm tra METERED_API_KEY
  const meteredApiKey = process.env.METERED_API_KEY;
  if (meteredApiKey) {
    try {
      console.log('[WebRTC] Requesting fresh TURN credentials from Metered.ca...');
      const apiFetch = globalThis.fetch || fetch;
      const meteredResponse = await apiFetch(`https://openrelay.metered.ca/api/v1/turn/credentials?apiKey=${meteredApiKey}`);
      if (meteredResponse.ok) {
        const data = await meteredResponse.json();
        if (Array.isArray(data)) {
          cachedIceServers = data;
          cachedIceServersExpiry = Date.now() + 5 * 60 * 1000; // Cache 5 phút
          console.log('[WebRTC] Successfully loaded TURN servers from Metered.ca');
          return res.json(data);
        }
      }
      console.warn('[WebRTC] Metered.ca API responded with status:', meteredResponse.status);
    } catch (e) {
      console.error('[WebRTC] Failed to fetch TURN credentials from Metered.ca:', e);
    }
  }

  // 2. Kiểm tra TURN_USERNAME và TURN_CREDENTIAL tĩnh
  const turnUsername = process.env.TURN_USERNAME;
  const turnCredential = process.env.TURN_CREDENTIAL || process.env.TURN_PASSWORD;
  const turnUrls = (process.env.TURN_URLS || '')
    .split(',')
    .map(url => url.trim())
    .filter(Boolean);

  if (turnUsername && turnCredential && turnUrls.length > 0) {
    const configuredTurnServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      ...turnUrls.map(url => ({
        urls: url,
        username: turnUsername,
        credential: turnCredential
      }))
    ];
    cachedIceServers = configuredTurnServers;
    cachedIceServersExpiry = Date.now() + 5 * 60 * 1000;
    return res.json(configuredTurnServers);
  }

  if (turnUsername && turnCredential) {
    const staticTurnServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:openrelay.metered.ca:80' },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: turnUsername,
        credential: turnCredential
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: turnUsername,
        credential: turnCredential
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: turnUsername,
        credential: turnCredential
      }
    ];
    return res.json(staticTurnServers);
  }

  // 3. Fallback: Trả về danh sách STUN servers công cộng mặc định
  const defaultStunServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.stunprotocol.org:3478' }
  ];
  res.json(defaultStunServers);
});

// ── DATABASE SWEEP WORKER DEAMON ──────────────────────────────────────────────
function startBackgroundDatabaseSweepWorker() {
  console.log('[Sweep Worker] 🚀 Khởi động luồng quét tự động toàn bộ cơ sở dữ liệu để làm mới thực đơn...');
  setTimeout(runSweepIteration, 10000); // Bắt đầu sau 10 giây
}

function runSweepIteration() {
  const localJsonPath = path.join(__dirname, 'restaurants-local.json');
  if (!fs.existsSync(localJsonPath)) {
    setTimeout(runSweepIteration, 5 * 60 * 1000);
    return;
  }

  try {
    const localData = JSON.parse(fs.readFileSync(localJsonPath, 'utf8'));
    if (!Array.isArray(localData)) {
      setTimeout(runSweepIteration, 5 * 60 * 1000);
      return;
    }

    let dbChanged = false;
    localData.forEach(r => {
      if (resetClosedIfNextAttemptReached(r)) {
        dbChanged = true;
      }
    });

    if (dbChanged) {
      updateLocalDatabase((dbData) => {
        let changed = false;
        dbData.forEach(r => {
          if (resetClosedIfNextAttemptReached(r)) {
            changed = true;
          }
        });
        return changed;
      }).then(() => {
        console.log('[Sweep Worker] 💾 Đã lưu thay đổi reset các quán hết hạn đóng cửa tạm thời.');
      });
    }

    // Chọn quán chưa có menu thực tế HOẶC quán đã có menu nhưng chưa được cập nhật trong vòng 24 giờ qua (Độc lập ShopeeFood)
    const candidates = localData.filter(r => {
      if (!r || !r.id || r._isScraping) return false;
      if (r.isClosed) return false; // Không quét quán đang đóng cửa hoàn toàn
      if (!r.hasRealMenu) return true; // Chưa có menu thực tế -> cần quét gấp
      
      // Đã có menu: kiểm tra xem lần cập nhật cuối cùng có quá 24 giờ không
      const lastCheck = r.menuUpdatedAt ? new Date(r.menuUpdatedAt).getTime() : 0;
      const diffMs = Date.now() - lastCheck;
      return diffMs > 24 * 60 * 60 * 1000; // 24 giờ
    });
    
    // Sắp xếp: ưu tiên r.menuUpdatedAt chưa có (null), sau đó đến r.menuUpdatedAt cũ nhất
    candidates.sort((a, b) => {
      const timeA = a.menuUpdatedAt ? new Date(a.menuUpdatedAt).getTime() : 0;
      const timeB = b.menuUpdatedAt ? new Date(b.menuUpdatedAt).getTime() : 0;
      return timeA - timeB;
    });

    if (candidates.length === 0) {
      console.log('[Sweep Worker] ✨ Tuyệt vời! Tất cả các quán ăn trong database đã được đối chiếu thực đơn trong vòng 24 giờ.');
      setTimeout(runSweepIteration, 30 * 60 * 1000); // Quét lại sau 30 phút
      return;
    }

    const target = candidates[0];
    
    // Tránh spam quét lặp lại quá nhanh khi toàn bộ DB đều đã được quét gần đây
    if (target.menuUpdatedAt) {
      const lastCheck = new Date(target.menuUpdatedAt).getTime();
      const diffMs = Date.now() - lastCheck;
      if (diffMs < 2 * 60 * 60 * 1000) { // 2 giờ
        console.log(`[Sweep Worker] ℹ️ Quán cần đối chiếu cũ nhất "${target.name}" mới được kiểm tra cách đây ${Math.round(diffMs / 60000)} phút. Tạm dừng đối chiếu 10 phút...`);
        setTimeout(runSweepIteration, 10 * 60 * 1000);
        return;
      }
    }

    console.log(`[Sweep Worker] 🔍 Tìm thấy ${candidates.length} quán ăn cần đối chiếu giá. Tiến hành cào ngầm tuần tự...`);
    console.log(`[Sweep Worker] ⚡ Đang tiến hành đối chiếu giá cho: "${target.name}" (ID: ${target.id})...`);
    
    target._isScraping = true;
    
    let slug = target.shopeefoodSlug || target.id.replace('r_ct_', '').split('?')[0].replace(/_/g, '-');
    
    const resolvePromise = target.shopeefoodSlug
      ? Promise.resolve(target.shopeefoodSlug)
      : getShopeeFoodSlugFromFoody(slug);

    resolvePromise.then(resolvedSlug => {
      let finalSlug = resolvedSlug;
      if (SLUG_REWRITER_MAP[finalSlug]) {
        finalSlug = SLUG_REWRITER_MAP[finalSlug];
      }
      return menuScraper.scrapeMenu(finalSlug);
    }).then(realMenu => {
      target._isScraping = false;
      
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

      if (isClosed) {
        // Thay vì xóa khỏi database, chúng ta giữ lại quán và chỉ cập nhật trạng thái đóng cửa (Độc lập ShopeeFood)
        console.log(`[Sweep Worker] 🔒 Đánh dấu quán đóng cửa trong DB (không xóa): "${target.name}"`);
        target.isClosed = true;
        target.closedAt = new Date().toISOString();
        target.closedReason = closedReason || 'Cửa hàng tạm ngưng phục vụ.';
        
        // Đặt lịch cào lại vào ngày mai để đối chiếu tiếp
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(7, 0, 0, 0);
        target.crawlNextAttempt = tomorrow.toISOString();
        target.menuUpdatedAt = new Date().toISOString();

        updateLocalDatabase((dbData) => {
          const idx = dbData.findIndex(r => String(r.id) === String(target.id));
          if (idx !== -1) {
            dbData[idx].isClosed = true;
            dbData[idx].closedAt = target.closedAt;
            dbData[idx].closedReason = target.closedReason;
            dbData[idx].crawlNextAttempt = target.crawlNextAttempt;
            dbData[idx].menuUpdatedAt = target.menuUpdatedAt;
            return true;
          }
          return false;
        }).then(() => {
          console.log(`[Sweep Worker] 💾 Đã lưu trạng thái đóng cửa của "${target.name}" vào database local.`);
        });
        
        setTimeout(runSweepIteration, 30 * 1000);
        return;

      } else if (menu) {
        // Tiến hành so khớp món ăn và đối chiếu cập nhật giá (ShopeeFood Price Sync)
        let priceUpdatedCount = 0;
        const localMenu = target.menu || [];
        
        if (localMenu.length === 0) {
          // Nếu menu local trống, gán toàn bộ menu cào được
          target.menu = menu;
          target.hasRealMenu = true;
          console.log(`[Sweep Worker] 🆕 Gán thực đơn mới cào (${menu.length} món) cho quán: "${target.name}"`);
        } else {
          // Đối chiếu và cập nhật giá món ăn cũ
          localMenu.forEach(localItem => {
            const scrapedItem = menu.find(m => m.name && localItem.name && m.name.trim().toLowerCase() === localItem.name.trim().toLowerCase());
            if (scrapedItem) {
              const oldInStore = localItem.inStorePrice;
              const newInStore = scrapedItem.inStorePrice;
              if (oldInStore !== newInStore) {
                localItem.inStorePrice = newInStore;
                localItem.appPrice = round100(newInStore * (1 + PRICING_CONFIG.MARKUP_RATE));
                priceUpdatedCount++;
              }
            }
          });
          target.menu = localMenu;
          target.hasRealMenu = true;
        }

        target.menuUpdatedAt = new Date().toISOString();
        delete target.menuTemplateFallback;
        if (target.isClosed) {
          target.isClosed = false;
          delete target.closedAt;
          delete target.closedReason;
        }

        updateLocalDatabase((dbData) => {
          const idx = dbData.findIndex(r => String(r.id) === String(target.id));
          if (idx !== -1) {
            dbData[idx].menu = target.menu;
            dbData[idx].hasRealMenu = true;
            dbData[idx].menuUpdatedAt = target.menuUpdatedAt;
            delete dbData[idx].menuTemplateFallback;
            if (dbData[idx].isClosed) {
              dbData[idx].isClosed = false;
              delete dbData[idx].closedAt;
              delete dbData[idx].closedReason;
            }
            return true;
          }
          return false;
        }).then(() => {
          console.log(`[Sweep Worker] ✅ Đối chiếu hoàn tất cho "${target.name}": Đã cập nhật giá ${priceUpdatedCount} món.`);
        });
      } else {
        target.menuUpdatedAt = new Date().toISOString();

        updateLocalDatabase((dbData) => {
          const idx = dbData.findIndex(r => String(r.id) === String(target.id));
          if (idx !== -1) {
            dbData[idx].menuUpdatedAt = target.menuUpdatedAt;
            return true;
          }
          return false;
        }).then(() => {
          console.log(`[Sweep Worker] ⚠️ Không có menu hoặc lỗi cho: "${target.name}". Sẽ thử lại ở chu kỳ sau.`);
        });
      }
      
      setTimeout(runSweepIteration, 30 * 1000); // Chờ 30 giây để tránh spam ShopeeFood
    }).catch(err => {
      target._isScraping = false;
      console.error(`[Sweep Worker] ❌ Lỗi luồng cào ngầm cho "${target.name}":`, err.message);
      
      // Vẫn cập nhật menuUpdatedAt để lượt quét tiếp theo không bị lặp lại quán lỗi này ngay lập tức
      target.menuUpdatedAt = new Date().toISOString();
      updateLocalDatabase((dbData) => {
        const idx = dbData.findIndex(r => String(r.id) === String(target.id));
        if (idx !== -1) {
          dbData[idx].menuUpdatedAt = target.menuUpdatedAt;
          return true;
        }
        return false;
      }).finally(() => {
        setTimeout(runSweepIteration, 30 * 1000);
      });
    });
    
  } catch (err) {
    console.error('[Sweep Worker] Lỗi phân tích database:', err.message);
    setTimeout(runSweepIteration, 60 * 1000);
  }
}

// ── START SERVER ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║     🛵  ShipFee Proxy Server — Cần Thơ             ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  API:    http://localhost:${PORT}/api/restaurants       ║`);
  console.log(`║  App:    http://localhost:${PORT}/app/index.html        ║`);
  console.log(`║  Status: http://localhost:${PORT}/api/status            ║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  Cache tự động 10 phút | Fallback local data        ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log('👉 Mở trình duyệt tại: http://localhost:3001/app/index.html');
  console.log('   (hoặc nhấn Ctrl+Click vào link trên)');
  console.log('');

  // Làm sạch cơ sở dữ liệu đơn hàng (orders-local.json) khi khởi chạy server để bắt đầu phiên mới
  if (fs.existsSync(ORDERS_FILE_PATH)) {
    try {
      fs.writeFileSync(ORDERS_FILE_PATH, '[]', 'utf8');
      console.log('[Sanitization] 🧹 Đã làm sạch cơ sở dữ liệu đơn hàng (orders-local.json) khi khởi chạy server.');
    } catch (e) {
      console.error('[Sanitization] Lỗi dọn dẹp orders-local.json:', e.message);
    }
  }

  // Đặt lại trạng thái tất cả tài xế thành OFFLINE khi khởi chạy server
  if (fs.existsSync(SHIPPERS_FILE_PATH)) {
    try {
      const raw = fs.readFileSync(SHIPPERS_FILE_PATH, 'utf8');
      const shippers = JSON.parse(raw);
      if (Array.isArray(shippers)) {
        let changed = false;
        shippers.forEach(s => {
          if (s.status !== 'OFFLINE') {
            s.status = 'OFFLINE';
            changed = true;
          }
        });
        if (changed) {
          fs.writeFileSync(SHIPPERS_FILE_PATH, JSON.stringify(shippers, null, 2), 'utf8');
          console.log('[Sanitization] 🧹 Đã đặt lại trạng thái tất cả tài xế thành OFFLINE khi khởi chạy server.');
        }
      }
    } catch (e) {
      console.error('[Sanitization] Lỗi dọn dẹp shippers-local.json:', e.message);
    }
  }

  // Tự động quét và làm sạch dữ liệu trong file local JSON tránh menu sai lệch do lỗi cũ
  sanitizeLocalJsonData();

  // Tự động kích hoạt Crawler lấy dữ liệu mới nhất ngay khi bật server
  triggerCrawler();

  // Khởi động luồng quét tự động toàn bộ cơ sở dữ liệu làm mới thực đơn chuẩn
  startBackgroundDatabaseSweepWorker();
});
