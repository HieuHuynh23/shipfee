/**
 * Shared ShopeeFood slug rewrites — brand portals → chi nhánh cụ thể.
 */
const SLUG_REWRITER_MAP = {
  'he-thong-lumos-coffee-cake': 'lumos-bakery-joy-banh-au-tra',
  'he-thong-lau-bang-chuyen-kichi-kichi': 'kichi-kichi-lotte-mart-can-tho',
  'he-thong-quan-itada-am-thuc-han-quoc': 'itada-mi-cay-han-quoc-duong-3-thang-2',
  'jollibee-can-tho': 'ga-ran-va-mi-y-jollibee-duong-30-thang-4',
  'highlands-coffee-can-tho': 'highlands-coffee-go-can-tho',
  'kfc-can-tho': 'ga-ran-kfc-lotte-mart-can-tho',
  'lotteria-can-tho': 'ga-ran-burger-lotteria-can-tho-nguyen-van-cu',
  'lotteria-vincom-xuan-khanh': 'ga-ran-burger-lotteria-vincom-xuan-khanh',
  'lotteria-can-tho-big-c': 'ga-ran-burger-lotteria-can-tho-big-c',
  'lotteria-can-tho-nguyen-van-cu': 'ga-ran-burger-lotteria-can-tho-nguyen-van-cu',

  'jollibee-duong-30-thang-4': 'ga-ran-va-mi-y-jollibee-duong-30-thang-4',
  'jollibee-cach-mang-thang-8': 'ga-ran-va-mi-y-jollibee-cach-mang-thang-8',
  'jollibee-ec-tran-hung-dao-can-tho': 'ga-ran-va-mi-y-jollibee-ec-tran-hung-dao-can-tho',
  'jollibee-ec-ba-thang-hai-can-tho': 'ga-ran-va-mi-y-jollibee-ec-ba-thang-hai-can-tho',
  'jollibee-nguyen-van-cu': 'ga-ran-va-mi-y-jollibee-nguyen-van-cu',
  'jollibee-ec-nguyen-van-cu-noi-dai-can-tho': 'ga-ran-va-my-y-jollibee-ec-nguyen-van-cu-noi-dai-can-tho',
  'jollibee-ec-sts-tower-hoa-binh': 'ga-ran-va-my-y-jollibee-ec-sts-tower-hoa-binh',

  'highlands-coffee-vincom-can-tho': 'highlands-coffee-tra-ca-phe-banh-vincom-can-tho',
  'highlands-coffee-go': 'highlands-coffee-go-can-tho',
  'highlands-coffee-nguyen-van-cu-can-tho': 'highlands-coffee-tra-ca-phe-banh-nguyen-van-cu-can-tho',
  'highlands-coffee-cv-song-hau-can-tho': 'highlands-coffee-tra-ca-phe-banh-cv-song-hau-can-tho',
  'highlands-coffee-huynh-cuong-can-tho': 'highlands-coffee-tra-ca-phe-banh-huynh-cuong-can-tho',

  'kfc-big-c-hung-phu': 'ga-ran-kfc-big-c-hung-phu-can-tho',
  'kfc-tran-hoang-na': 'ga-ran-kfc-duong-tran-hoang-na-can-tho',
  'kfc-lotte-mart-can-tho': 'ga-ran-kfc-lotte-mart-can-tho'
};

/**
 * Derive candidate ShopeeFood slug from restaurant id / stored slug.
 */
function slugFromRestaurant(restaurant) {
  if (restaurant.shopeefoodSlug) {
    return String(restaurant.shopeefoodSlug).split('?')[0].trim();
  }
  const raw = String(restaurant.id || '')
    .replace(/^r_ct_/, '')
    .split('?')[0]
    .replace(/_/g, '-');
  return raw;
}

function rewriteSlug(slug) {
  const key = String(slug || '').split('?')[0];
  return SLUG_REWRITER_MAP[key] || key;
}

/**
 * Portal cha "Hệ thống X" trên Foody — address dạng "2 chi nhánh", "3 chi nhánh".
 * KHÔNG coi chi nhánh thật (có địa chỉ đường/phố) là portal dù tên có "Hệ thống".
 */
function isGenericBrandPortal(name, address) {
  const a = String(address || '').toLowerCase().trim();
  if (/^\d+\s*chi\s*nh/.test(a)) return true;
  // Một số portal ghi "Chi nhánh" thuần, không có số nhà
  if (/^chi\s*nh[aá]nh\s*$/i.test(a)) return true;
  return false;
}

function looksLikeBrandChainName(name) {
  const n = String(name || '').toLowerCase();
  return n.includes('hệ thống') || n.includes('he thong');
}

module.exports = {
  SLUG_REWRITER_MAP,
  slugFromRestaurant,
  rewriteSlug,
  isGenericBrandPortal,
  looksLikeBrandChainName
};
