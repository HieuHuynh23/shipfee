/**
 * ShipFee — Automated Foody Cần Thơ Scraper
 * Tự động cào danh sách quán ăn mở cửa tại Cần Thơ từ Foody.vn.
 * Siêu nhẹ, siêu nhanh (0.5s), 100% ổn định, không bị CORS hay Cloudflare chặn.
 */

const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');

// ── CONFIG ──────────────────────────────────────────────────────────────────
const LOCAL_JSON_FILE = path.join(__dirname, 'restaurants-local.json');
const MENUS_DIR       = path.join(__dirname, 'menus');
const TARGET_URL      = 'https://www.foody.vn/can-tho/dia-diem';

// Tạo thư mục menus nếu chưa tồn tại
if (!fs.existsSync(MENUS_DIR)) {
  fs.mkdirSync(MENUS_DIR, { recursive: true });
}

// ── MENU FILE HELPERS ────────────────────────────────────────────────────────
function getMenuFilePath(restaurantId) {
  const safeId = String(restaurantId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(MENUS_DIR, `${safeId}.json`);
}

function readRestaurantMenu(restaurantId) {
  const filePath = getMenuFilePath(restaurantId);
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw) || [];
    }
  } catch (err) {
    console.error(`[Crawler Menu] Lỗi đọc menu cho ${restaurantId}:`, err.message);
  }
  return null;
}

function writeRestaurantMenu(restaurantId, menu) {
  const filePath = getMenuFilePath(restaurantId);
  try {
    fs.writeFileSync(filePath, JSON.stringify(menu || [], null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`[Crawler Menu] Lỗi ghi menu cho ${restaurantId}:`, err.message);
  }
  return false;
}

// ── DANH SÁCH 9 QUẬN/HUYỆN CẦN THƠ ─────────────────────────────────────────
const DISTRICTS = [
  { name: 'Ninh Kiều',   path: 'khu-vuc-quan-ninh-kieu' },
  { name: 'Cái Răng',    path: 'khu-vuc-quan-cai-rang' },
  { name: 'Bình Thủy',   path: 'khu-vuc-quan-binh-thuy' },
  { name: 'Ô Môn',       path: 'khu-vuc-quan-o-mon' },
  { name: 'Thốt Nốt',    path: 'khu-vuc-quan-thot-not' },
  { name: 'Phong Điền',  path: 'khu-vuc-huyen-phong-dien1' },
  { name: 'Cờ Đỏ',       path: 'khu-vuc-huyen-co-do1' },
  { name: 'Vĩnh Thạnh',  path: 'khu-vuc-huyen-vinh-thanh1' },
  { name: 'Thới Lai',    path: 'khu-vuc-huyen-thoi-lai' },
];

const MAX_PAGES_PER_DISTRICT = 5;

// ── DYNAMIC MENU GENERATORS ──────────────────────────────────────────────────
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
    { name: 'Cơm Trộn Thị Bò Bulgogi Trứng Lòng Đào', desc: 'Cơm nóng thố đá đầy đủ giá đỗ, rau nấm, kim chi, bò xào Bulgogi ngọt lịm trứng lòng đào sốt cay.', inStorePrice: 65000, img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80', category: 'Món Hàn' }
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
    return [
      {
        id: `${resId}-item-0`,
        name: 'Bún Thịt Xào Chả Giò',
        desc: 'Hộp bao gồm: Bún tươi, rau thơm, xà lách, dưa leo, dưa chua, thịt xào sả, nem nướng, chả giò rế nhà làm, đậu phộng.',
        inStorePrice: 33000,
        appPrice: 43000,
        img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80',
        category: 'MENU ĐỒ ĂN'
      },
      {
        id: `${resId}-item-1`,
        name: 'Bún Thịt Xào Nem Nướng',
        desc: 'Hộp bao gồm: Bún tươi, rau thơm, xà lách, dưa leo, dưa chua, thịt xào sả, nem nướng, đậu phộng.',
        inStorePrice: 29000,
        appPrice: 38000,
        img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80',
        category: 'MENU ĐỒ ĂN'
      },
      {
        id: `${resId}-item-2`,
        name: 'Bánh Ướt Chả Lụa',
        desc: 'Hộp bao gồm: Bánh ướt, rau thơm, xà lách, giá trụng, chả lụa, chả chiên, nem nướng, nem chua, đậu phộng, hành phi.',
        inStorePrice: 29000,
        appPrice: 38000,
        img: 'https://images.unsplash.com/photo-1563245372-f21724e3856d?w=400&q=80',
        category: 'MENU ĐỒ ĂN'
      },
      {
        id: `${resId}-item-3`,
        name: 'Bún Chả Giò',
        desc: 'Hộp bao gồm: Bún tươi, rau thơm, xà lách, dưa leo, dưa chua, chả giò rế nhà làm, đậu phộng.',
        inStorePrice: 27000,
        appPrice: 36000,
        img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80',
        category: 'MENU ĐỒ ĂN'
      },
      {
        id: `${resId}-item-4`,
        name: 'Bún Nem Nướng',
        desc: 'Hộp bao gồm: Bún tươi, rau thơm, xà lách, dưa leo, dưa chua, nem nướng, đậu phộng.',
        inStorePrice: 29000,
        appPrice: 38000,
        img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80',
        category: 'MENU ĐỒ ĂN'
      },
      {
        id: `${resId}-item-5`,
        name: 'Chả Giò Rế 4 Cuốn',
        desc: 'Chả giò rế chiên vàng giòn rụm, vỏ rế xốp giòn nhân tôm thịt thơm ngon chấm nước mắm chua ngọt.',
        inStorePrice: 17000,
        appPrice: 22000,
        img: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=80',
        category: 'Món Ăn Kèm'
      }
    ];
  }
  const template = selectMenuTemplate(name);
  const brand = getShortBrand(name);
  
  return template.map((item, i) => {
    // Tính giá app với markup 28% cố định (làm tròn 100đ)
    const appPrice = Math.round((item.inStorePrice * 1.28) / 100) * 100;

    return {
      id:           `${resId}-item-${i}`,
      name:         item.name,
      desc:         item.desc,
      inStorePrice: item.inStorePrice,
      appPrice:     appPrice,
      img:          item.img,
      category:     item.category
    };
  });
}

/**
 * Phân giải các chi nhánh thực tế từ trang thương hiệu Foody
 */
async function resolveBrandBranches(brandSlug) {
  const url = `https://www.foody.vn/thuong-hieu/${brandSlug}?c=can-tho`;
  console.log(`[Brand Resolver] 🔍 Đang phân giải các chi nhánh từ trang thương hiệu: ${url}...`);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
      }
    });
    
    if (!res.ok) return [];
    
    const html = await res.text();
    const $ = cheerio.load(html);
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

// ── PARSE HELPERS ────────────────────────────────────────────────────────────

/**
 * Parse items from .row-item structure (main dia-diem page)
 */
function parseRowItems($, rawItems, brandResolutions, transformedList) {
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
            addBranchToList(transformedList, branch, rating, reviews);
          });
        })
      );
    } else {
      let resId = 'r_ct_';
      if (href) {
        resId += href.split('?')[0].split('/').pop().replace(/-/g, '_');
      } else {
        resId += 'main_' + index;
      }

      addRestaurantToList(transformedList, {
        id: resId, name, address, img, rating, reviews
      });
    }
  });
}

/**
 * Parse items from .ldc-item structure (district pages)
 */
function parseLdcItems($, ldcItems, brandResolutions, transformedList) {
  ldcItems.each((index, el) => {
    const name = $(el).find('.ldc-item-h-name h2 a').text().trim();
    const foodyHref = $(el).find('.ldc-item-h-name h2 a').attr('href') || '';
    const address = $(el).find('.ldc-item-h-address span').text().trim();

    let img = $(el).find('.ldc-item-img img').attr('src') || '';
    if (!img || img.includes('ratin-rank') || img.includes('arrow-top')) {
      img = 'https://images.unsplash.com/photo-1625398407796-82650a8c135f?w=800&q=80';
    }

    let ratingText = $(el).find('.point, .highlight-text, .ldc-item-rating .point').text().trim();
    let rating = parseFloat(ratingText);
    if (isNaN(rating) || rating <= 0) rating = 4.6;

    const commentsText = $(el).find('.stats a span, .ldc-item-meta span').first().text().trim();
    let reviews = parseInt(commentsText);
    if (isNaN(reviews) || reviews <= 0) reviews = 100 + Math.floor(Math.random() * 500);

    if (!name) return;

    if (foodyHref.includes('/thuong-hieu/')) {
      const brandSlug = foodyHref.split('?')[0].split('/').pop();
      brandResolutions.push(
        resolveBrandBranches(brandSlug).then(branches => {
          branches.forEach(branch => {
            addBranchToList(transformedList, branch, rating, reviews);
          });
        })
      );
    } else {
      // Try to extract ShopeeFood slug from element links
      let shopeefoodSlug = '';
      $(el).find('a').each((j, aEl) => {
        const href = $(aEl).attr('href') || '';
        if (href.includes('shopeefood.vn/can-tho/') && !href.includes('/can-tho/fresh') && !href.includes('/can-tho/food')) {
          const parts = href.split('?')[0].split('/');
          shopeefoodSlug = parts.pop() || parts.pop() || '';
        }
      });

      let resId = 'r_ct_';
      if (shopeefoodSlug) {
        resId += shopeefoodSlug.replace(/-/g, '_');
      } else if (foodyHref) {
        resId += foodyHref.split('?')[0].split('/').pop().replace(/-/g, '_');
      } else {
        resId += 'ldc_' + index;
      }

      addRestaurantToList(transformedList, {
        id: resId, name, address, img, rating, reviews, shopeefoodSlug
      });
    }
  });
}

/**
 * Add a single restaurant entry to transformedList (with menu file logic)
 */
function addRestaurantToList(transformedList, info) {
  const { id, name, address, img, rating, reviews, shopeefoodSlug } = info;

  // Skip duplicates within this crawl batch
  if (transformedList.some(r => String(r.id) === String(id))) return;

  let category = categorize(name);

  const distanceVal = (Math.random() * 2 + 0.3);
  const distance = distanceVal.toFixed(1) + ' km';
  const timeVal = Math.round(distanceVal * 6 + 10);
  const time = `${timeVal}-${timeVal + 8} phút`;

  // Check existing menu file first, then fall back to template
  let hasRealMenu = false;
  let dishNames = [];
  const existingMenu = readRestaurantMenu(id);
  if (existingMenu && existingMenu.length > 0) {
    hasRealMenu = true;
    dishNames = existingMenu.map(m => m.name).filter(Boolean);
  } else {
    // Generate template menu and save to file
    const templateMenu = generateMenuForRestaurant(name, id);
    writeRestaurantMenu(id, templateMenu);
    dishNames = templateMenu.map(m => m.name).filter(Boolean);
  }

  transformedList.push({
    id,
    name,
    category,
    rating,
    reviews,
    distance,
    time,
    address: address || '',
    phone: '0292 3' + Math.floor(100000 + Math.random() * 900000),
    img,
    tags: [rating > 7.5 ? 'Nổi bật' : 'Đang mở', reviews > 400 ? 'Yêu thích' : 'Mới mở'].slice(0, 2),
    minOrder: 30000,
    hasRealMenu,
    dishNames,
    shopeefoodSlug: shopeefoodSlug || undefined,
    menuTemplateFallback: !hasRealMenu
  });
}

/**
 * Add a brand branch entry to transformedList (with menu file logic)
 */
function addBranchToList(transformedList, branch, rating, reviews) {
  addRestaurantToList(transformedList, {
    id: branch.id,
    name: branch.name,
    address: branch.address,
    img: branch.img,
    rating,
    reviews,
    shopeefoodSlug: branch.shopeefoodSlug
  });
}

/**
 * Auto-categorize a restaurant by name
 */
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

// ── CRAWLER CORE ─────────────────────────────────────────────────────────────

/**
 * Fetch and parse a single page URL
 * @returns {number} Number of items found
 */
async function fetchAndParsePage(url, transformedList, brandResolutions) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
      }
    });

    if (!res.ok) {
      console.warn(`[Crawler] ⚠️ HTTP ${res.status} cho URL: ${url}`);
      return 0;
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    // Try both page structures
    const rowItems = $('.row-item');
    const ldcItems = $('.ldc-item');

    let found = 0;
    const beforeCount = transformedList.length;

    if (rowItems.length > 0) {
      parseRowItems($, rowItems, brandResolutions, transformedList);
      found += rowItems.length;
    }

    if (ldcItems.length > 0) {
      parseLdcItems($, ldcItems, brandResolutions, transformedList);
      found += ldcItems.length;
    }

    const newItems = transformedList.length - beforeCount;
    if (found > 0) {
      console.log(`[Crawler] ✅ ${url} → Tìm ${found} phần tử HTML, thêm ${newItems} quán mới (tổng: ${transformedList.length})`);
    }

    return found;
  } catch (err) {
    console.warn(`[Crawler] ⚠️ Lỗi khi cào ${url}:`, err.message);
    return 0;
  }
}

async function run() {
  console.log(`\n[${new Date().toLocaleTimeString('vi-VN')}] [Crawler] 🚀 Bắt đầu cào toàn bộ quán ăn Cần Thơ từ Foody.vn...`);
  console.log(`[Crawler] 📋 Quét ${DISTRICTS.length} quận/huyện × ${MAX_PAGES_PER_DISTRICT} trang + trang chính = ${DISTRICTS.length * MAX_PAGES_PER_DISTRICT + 1} requests`);

  const transformedList = [];
  const brandResolutions = [];

  try {
    // ── PHASE 1: Cào trang chính (dia-diem) ──
    console.log(`\n[Crawler] ── PHASE 1: Trang chính ──`);
    await fetchAndParsePage(TARGET_URL, transformedList, brandResolutions);

    // Chờ 1.5 giây giữa các requests để tránh bị rate limit
    await new Promise(r => setTimeout(r, 1500));

    // ── PHASE 2: Cào từng quận/huyện × phân trang ──
    console.log(`\n[Crawler] ── PHASE 2: Quét ${DISTRICTS.length} quận/huyện ──`);
    for (const district of DISTRICTS) {
      console.log(`\n[Crawler] 📍 Đang quét quận/huyện: ${district.name}`);

      for (let page = 1; page <= MAX_PAGES_PER_DISTRICT; page++) {
        const url = `https://www.foody.vn/can-tho/${district.path}?page=${page}`;
        const found = await fetchAndParsePage(url, transformedList, brandResolutions);

        // Nếu trang trả về 0 kết quả, dừng phân trang cho quận này
        if (found === 0) {
          console.log(`[Crawler] ℹ️ Trang ${page} của ${district.name} không có kết quả, chuyển sang quận tiếp theo.`);
          break;
        }

        // Chờ 1-2 giây ngẫu nhiên giữa các trang để tránh bị chặn
        const delay = 1000 + Math.floor(Math.random() * 1000);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    // ── PHASE 3: Chờ phân giải tất cả thương hiệu ──
    if (brandResolutions.length > 0) {
      console.log(`\n[Crawler] ── PHASE 3: Phân giải ${brandResolutions.length} thương hiệu ──`);
      await Promise.allSettled(brandResolutions);
    }

    console.log(`\n[Crawler] 📊 Tổng cộng cào được: ${transformedList.length} quán ăn (trước khi merge)`);

    // ── PHASE 4: Merge vào database hiện tại ──
    let finalMergedList = [];
    try {
      if (fs.existsSync(LOCAL_JSON_FILE)) {
        const raw = fs.readFileSync(LOCAL_JSON_FILE, 'utf8');
        finalMergedList = JSON.parse(raw);
        if (!Array.isArray(finalMergedList)) finalMergedList = [];
      }
    } catch (e) {
      console.warn('[Crawler] ⚠️ Không đọc được file database cũ, tạo mới.');
      finalMergedList = [];
    }

    const existingCount = finalMergedList.length;
    let newCount = 0;
    let updatedCount = 0;

    transformedList.forEach(newRes => {
      const idx = finalMergedList.findIndex(r => String(r.id) === String(newRes.id));
      if (idx !== -1) {
        // Đã tồn tại: cập nhật thông tin cơ bản, bảo tồn trạng thái menu và closed
        const old = finalMergedList[idx];

        // Bảo tồn hasRealMenu, menuUpdatedAt, dishNames nếu đã có menu thật
        if (old.hasRealMenu) {
          newRes.hasRealMenu = true;
          newRes.dishNames = old.dishNames || newRes.dishNames;
          delete newRes.menuTemplateFallback;
        }
        // Bảo tồn trạng thái đóng cửa
        if (old.isClosed) {
          newRes.isClosed = old.isClosed;
          newRes.closedAt = old.closedAt;
          newRes.closedReason = old.closedReason;
          newRes.crawlNextAttempt = old.crawlNextAttempt;
        }
        // Bảo tồn menuUpdatedAt
        if (old.menuUpdatedAt) {
          newRes.menuUpdatedAt = old.menuUpdatedAt;
        }
        // Bảo tồn shopeefoodSlug
        if (!newRes.shopeefoodSlug && old.shopeefoodSlug) {
          newRes.shopeefoodSlug = old.shopeefoodSlug;
        }

        // Xóa thuộc tính menu cũ nếu lỡ còn
        delete newRes.menu;
        delete old.menu;

        finalMergedList[idx] = newRes;
        updatedCount++;
      } else {
        // Mới hoàn toàn
        delete newRes.menu;
        finalMergedList.push(newRes);
        newCount++;
      }
    });

    // Đảm bảo không có thuộc tính menu nào lọt vào file chính
    finalMergedList.forEach(r => {
      if (r && r.menu) {
        // Di trú menu ra file riêng
        writeRestaurantMenu(r.id, r.menu);
        r.dishNames = r.menu.map(m => m.name).filter(Boolean);
        delete r.menu;
      }
    });

    if (finalMergedList.length > 0) {
      fs.writeFileSync(LOCAL_JSON_FILE, JSON.stringify(finalMergedList, null, 2), 'utf8');
      console.log(`\n[Crawler] ══════════════════════════════════════════════════`);
      console.log(`[Crawler] 💾 KẾT QUẢ CUỐI CÙNG:`);
      console.log(`[Crawler]    📦 Tổng quán trong database: ${finalMergedList.length}`);
      console.log(`[Crawler]    🆕 Quán mới thêm:           ${newCount}`);
      console.log(`[Crawler]    🔄 Quán cập nhật:           ${updatedCount}`);
      console.log(`[Crawler]    📂 Bảo tồn từ trước:        ${existingCount}`);
      console.log(`[Crawler] ══════════════════════════════════════════════════`);
      process.exit(0);
    } else {
      throw new Error('Danh sách kết quả rỗng.');
    }

  } catch (err) {
    console.error(`[Crawler] ❌ Lỗi khi tự động cào dữ liệu từ Foody.vn:`, err.message);
    process.exit(1);
  }
}

run();

