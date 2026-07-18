/**
 * Từ khóa discover Cần Thơ — dùng chung Foody + ShopeeFood.
 * Mục tiêu: phủ món, đường phố, họ tên, tiền tố chữ cái (tránh sót quán đặt tên riêng).
 */
'use strict';

const FOOD_KEYWORDS = [
  // nhóm cơm
  'cơm', 'cơm gà', 'cơm tấm', 'cơm chiên', 'cơm văn phòng', 'cơm niêu', 'cơm sườn',
  'cơm gà xối mỡ', 'cơm gà rút xương', 'cơm gà kim', 'cơm rang', 'cơm bình dân',
  'cơm chay', 'cơm hộp', 'cơm phần', 'cơm trộn', 'cơm cá', 'cơm heo quay',
  // bún / phở / hủ tiếu / mì
  'bún', 'bún bò', 'bún riêu', 'bún đậu', 'bún thịt nướng', 'bún mắm', 'bún cá',
  'bún chả', 'bún ốc', 'bún thang', 'bún đậu mắm tôm', 'phở', 'phở bò', 'phở gà',
  'hủ tiếu', 'hủ tiếu nam vang', 'hủ tiếu xương', 'mì', 'mì cay', 'mì quảng', 'mì ý',
  'mì xào', 'hoành thánh', 'bánh canh', 'bánh canh cua', 'bánh canh bột lọc',
  // nước / trà phẩm
  'trà sữa', 'trà trái cây', 'cà phê', 'cafe', 'coffee', 'sinh tố', 'nước ép',
  'chè', 'chè khúc bạch', 'kem', 'yogurt', 'matcha', 'trà đào', 'trà chanh',
  'nước mía', 'sữa chua', 'đá me', 'rà rượu',
  // gà / thịt / hải sản
  'gà', 'gà rán', 'gà nướng', 'gà ủ muối', 'gà ta', 'vịt', 'vịt nướng', 'heo quay',
  'bò', 'bò né', 'bò kho', 'bò lúc lắc', 'hải sản', 'tôm', 'cua', 'ốc', 'nghêu',
  'lẩu', 'lẩu thái', 'lẩu nướng', 'lẩu gà', 'lẩu hải sản', 'hotpot', 'buffet',
  // bánh / ăn vặt
  'bánh mì', 'bánh cuốn', 'bánh xèo', 'bánh ướt', 'bánh hỏi', 'bánh tráng',
  'bánh tráng trộn', 'bánh ngọt', 'bánh flan', 'bánh bao', 'bánh bèo', 'bánh bột lọc',
  'ăn vặt', 'đồ ăn vặt', 'xiên que', 'khoai tây', 'nem', 'nem nướng', 'gỏi',
  'gỏi cuốn', 'salad', 'kimbap', 'tokbokki', 'há cảo', 'dimsum', 'sushi',
  'pizza', 'burger', 'hotdog', 'gà viên', 'cá viên', 'xôi', 'xôi gà', 'xôi mặn',
  'cháo', 'cháo lòng', 'chả cá', 'chả giò', 'bò bía', 'háu ăn',
  // phong cách / loại hình
  'nhà hàng', 'quán ăn', 'tiệm', 'bếp', 'street food', 'đồ uống', 'nhậu',
  'nướng', 'quay', 'hấp', 'chiên', 'xào', 'healthy', 'eat clean', 'chay',
  'hàn quốc', 'nhật bản', 'thái', 'trung hoa', 'âu', 'ý', 'đài loan',
  // chuỗi
  'highlands', 'highland', 'kfc', 'jollibee', 'lotteria', 'phúc long', 'tocotoco',
  'toco', 'five star', 'ong vàng', 'milano', 'passio', 'starbucks', 'the coffee house',
  'gong cha', 'koi thé', 'phê la', 'trung nguyên', 'cong caphe', 'phúc long',
  'texas', 'popeyes', 'mcdonald', 'pizza hut', 'domino', 'ministop', 'gs25',
  'circle k', 'family mart'
];

/** Quận / phường / khu vực Cần Thơ */
const AREA_KEYWORDS = [
  'ninh kiều', 'bình thủy', 'cái răng', 'ô môn', 'thốt nốt', 'phong điền',
  'vĩnh thạnh', 'cờ đỏ', 'thới lai', 'an khánh', 'an hòa', 'an bình', 'an cư',
  'an thới', 'hưng lợi', 'hưng thạnh', 'cái khế', 'tân an', 'xuân khánh',
  'thới bình', 'an nghiệp', 'long tuyên', 'trà nóc', 'thường thạnh'
];

/** Đường phố lớn — bắt quán gắn địa chỉ trong tên */
const STREET_KEYWORDS = [
  'nguyễn văn cừ', 'mậu thân', 'trần hưng đạo', 'hòa bình', '30 tháng 4', '30/4',
  '3 tháng 2', '3/2', 'nguyễn văn linh', 'trần việt châu', 'phạm ngũ lão',
  'lý tự trọng', 'ngô quyền', 'trần hoàng na', 'võ văn kiệt', 'cách mạng tháng 8',
  'hai bà trưng', 'phan đăng lưu', 'nguyễn thị minh khai', 'đề thám', 'châu văn liêm',
  'trần văn khổ', 'nguyễn trãi', 'hoàng quốc việt', 'lê hồng phong', 'nguyễn việt hồng',
  'trần quang diệu', 'võ trường toản', 'nguyễn đệ', 'bùi hữu nghĩa', 'mạc thiên tích',
  'xuân hồng', 'tầm vu', 'quốc lộ 91', 'tỉnh lộ 922', 'vincom', 'sense city',
  'lottemart', 'mega market', 'đại học cần thơ', 'bến ninh kiều', 'cái khế'
];

/** Họ / tiền tố tên quán phổ biến */
const NAME_PREFIX_KEYWORDS = [
  'quán', 'tiệm', 'nhà', 'bếp', 'cô', 'chú', 'anh', 'chị', 'ba', 'má', 'út',
  'nguyễn', 'trần', 'lê', 'phạm', 'hoàng', 'huỳnh', 'võ', 'phan', 'vũ', 'đặng',
  'bùi', 'đỗ', 'hồ', 'ngô', 'dương', 'lý', 'đinh', 'trương', 'mai', 'lâm',
  'kim', 'minh', 'thanh', 'hồng', 'lan', 'hương', 'thu', 'hà', 'linh', 'trang',
  'phúc', 'phượng', 'ngọc', 'bích', 'uyên', 'my', 'vy', 'na', 'nhi', 'anh'
];

/** Prefix chữ cái / âm tiết — Foody search "a", "an", "ba"... phân trang được */
const ALPHA_PREFIXES = [
  'a', 'an', 'anh', 'ba', 'be', 'bi', 'bo', 'bu', 'bun', 'ca', 'cafe', 'can',
  'che', 'chi', 'cho', 'chu', 'co', 'com', 'cu', 'da', 'de', 'di', 'do', 'du',
  'ga', 'gi', 'go', 'ha', 'he', 'hi', 'ho', 'hu', 'ke', 'ki', 'ko', 'la', 'le',
  'li', 'lo', 'lu', 'ma', 'me', 'mi', 'mo', 'mu', 'na', 'ne', 'ng', 'nh', 'ni',
  'no', 'nu', 'oc', 'ong', 'pa', 'pe', 'ph', 'pi', 'po', 'qu', 'ra', 're', 'ri',
  'ro', 'sa', 'se', 'si', 'so', 'su', 'ta', 'te', 'th', 'ti', 'to', 'tr', 'tu',
  'va', 've', 'vi', 'vo', 'vu', 'xa', 'xe', 'xo', 'xu', 'ya', 'ye', 'yo',
  'bánh', 'trà', 'phở', 'chè', 'xôi', 'lẩu', 'nem', 'gỏi', 'sushi', 'pizza'
];

function unique(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    const k = String(x || '').trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(String(x).trim());
  }
  return out;
}

/** Bộ đầy đủ cho Foody (chậm nhưng phủ rộng). */
function getFoodyKeywords() {
  return unique([
    ...FOOD_KEYWORDS,
    ...AREA_KEYWORDS,
    ...STREET_KEYWORDS,
    ...NAME_PREFIX_KEYWORDS,
    ...ALPHA_PREFIXES
  ]);
}

/** Bộ gọn hơn cho ShopeeFood UI search (mỗi từ khóa ~ vài giây). */
function getShopeeFoodKeywords() {
  return unique([
    ...FOOD_KEYWORDS,
    ...AREA_KEYWORDS.slice(0, 12),
    ...STREET_KEYWORDS.slice(0, 25),
    ...NAME_PREFIX_KEYWORDS.slice(0, 30),
    ...ALPHA_PREFIXES.filter(p => p.length >= 2).slice(0, 40)
  ]);
}

module.exports = {
  FOOD_KEYWORDS,
  AREA_KEYWORDS,
  STREET_KEYWORDS,
  NAME_PREFIX_KEYWORDS,
  ALPHA_PREFIXES,
  getFoodyKeywords,
  getShopeeFoodKeywords
};
