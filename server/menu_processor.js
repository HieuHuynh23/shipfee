/**
 * Menu Processor - Tạo menu đa dạng cho 5673+ quán có template menu.
 * 
 * Mỗi quán nhận 8-15 món dựa trên category + tên quán.
 * Giá ngẫu nhiên trong khoảng hợp lý. appPrice = inStorePrice * 1.28
 */
const fs = require('fs');
const path = require('path');

const LOCAL_JSON_FILE = path.join(__dirname, 'restaurants-local.json');
const MENUS_DIR = path.join(__dirname, 'menus');
const MARKUP = 0.28;

function round100(v) { return Math.round(v / 100) * 100; }
function calcApp(store) { return round100(store * (1 + MARKUP)); }
function randBetween(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

// ══════════════════════════════════════════════════════════════
// 15+ DANH MỤC MENU ĐA DẠNG
// ══════════════════════════════════════════════════════════════
const MENU_TEMPLATES = {
  'Cà phê': [
    { name: 'Cà Phê Sữa Đá', priceRange: [18000, 30000], desc: 'Cà phê sữa đá truyền thống Việt Nam' },
    { name: 'Cà Phê Đen Đá', priceRange: [15000, 25000], desc: 'Cà phê đen nguyên chất đậm vị' },
    { name: 'Bạc Xỉu', priceRange: [22000, 35000], desc: 'Bạc xỉu béo ngậy, vị nhẹ nhàng' },
    { name: 'Cappuccino', priceRange: [35000, 55000], desc: 'Cappuccino Ý cổ điển, foam mịn' },
    { name: 'Latte', priceRange: [35000, 55000], desc: 'Cafe Latte kem sữa mềm mại' },
    { name: 'Americano', priceRange: [30000, 45000], desc: 'Americano thanh nhẹ, đậm đà' },
    { name: 'Espresso', priceRange: [25000, 40000], desc: 'Espresso nguyên chất Ý' },
    { name: 'Cà Phê Muối', priceRange: [25000, 38000], desc: 'Cà phê muối Huế, vị mặn ngọt hài hòa' },
    { name: 'Cà Phê Trứng', priceRange: [30000, 45000], desc: 'Cà phê trứng Hà Nội, kem trứng béo ngậy' },
    { name: 'Trà Đào Cam Sả', priceRange: [25000, 40000], desc: 'Trà đào cam sả tươi mát' },
    { name: 'Trà Sen Vàng', priceRange: [30000, 45000], desc: 'Trà sen vàng thanh nhiệt' },
    { name: 'Sinh Tố Bơ', priceRange: [30000, 45000], desc: 'Sinh tố bơ sáp béo mịn' },
    { name: 'Nước Ép Cam', priceRange: [25000, 35000], desc: 'Nước ép cam tươi nguyên chất' },
    { name: 'Matcha Latte', priceRange: [40000, 55000], desc: 'Matcha Nhật Bản pha sữa' },
    { name: 'Socola Đá Xay', priceRange: [35000, 50000], desc: 'Socola đá xay mát lạnh' },
    { name: 'Bánh Mì Bơ Tỏi', priceRange: [20000, 30000], desc: 'Bánh mì nướng bơ tỏi thơm giòn' },
    { name: 'Croissant', priceRange: [25000, 40000], desc: 'Croissant Pháp giòn xốp' },
    { name: 'Bánh Flan', priceRange: [15000, 25000], desc: 'Bánh flan caramel mềm mịn' },
  ],
  'Trà sữa': [
    { name: 'Trà Sữa Truyền Thống', priceRange: [22000, 35000], desc: 'Trà sữa truyền thống thơm béo' },
    { name: 'Trà Sữa Trân Châu Đường Đen', priceRange: [30000, 45000], desc: 'Trà sữa trân châu đường đen dai giòn' },
    { name: 'Trà Sữa Matcha', priceRange: [32000, 48000], desc: 'Trà sữa vị matcha Nhật Bản' },
    { name: 'Trà Sữa Socola', priceRange: [28000, 42000], desc: 'Trà sữa socola đậm vị Bỉ' },
    { name: 'Trà Sữa Khoai Môn', priceRange: [30000, 45000], desc: 'Trà sữa khoai môn tím béo ngậy' },
    { name: 'Trà Sữa Hokkaido', priceRange: [35000, 55000], desc: 'Trà sữa Hokkaido Nhật Bản' },
    { name: 'Trà Oolong Sữa', priceRange: [30000, 45000], desc: 'Trà Oolong pha sữa tươi' },
    { name: 'Trà Đào', priceRange: [25000, 40000], desc: 'Trà đào cam sả tươi mát' },
    { name: 'Trà Vải', priceRange: [28000, 42000], desc: 'Trà vải Lychee thanh ngọt tự nhiên' },
    { name: 'Sữa Tươi Trân Châu', priceRange: [25000, 38000], desc: 'Sữa tươi trân châu đường đen' },
    { name: 'Kem Cheese Trà Xanh', priceRange: [35000, 50000], desc: 'Trà xanh phủ kem cheese béo mặn' },
    { name: 'Yakult Đào', priceRange: [30000, 42000], desc: 'Yakult đào tươi vitamin C' },
    { name: 'Topping Trân Châu', priceRange: [5000, 10000], desc: 'Thêm trân châu dai giòn' },
    { name: 'Topping Pudding', priceRange: [8000, 12000], desc: 'Thêm pudding trứng mềm mịn' },
  ],
  'Cơm tấm': [
    { name: 'Cơm Tấm Sườn Bì Chả', priceRange: [35000, 50000], desc: 'Cơm tấm sườn nướng, bì, chả trứng' },
    { name: 'Cơm Tấm Sườn Nướng', priceRange: [30000, 45000], desc: 'Cơm tấm sườn nướng than hoa' },
    { name: 'Cơm Tấm Sườn Ốp La', priceRange: [35000, 50000], desc: 'Cơm tấm sườn kèm trứng ốp la' },
    { name: 'Cơm Tấm Bì Chả', priceRange: [25000, 38000], desc: 'Cơm tấm bì chả thanh nhẹ' },
    { name: 'Cơm Tấm Đặc Biệt', priceRange: [45000, 65000], desc: 'Cơm tấm full topping đặc biệt' },
    { name: 'Cơm Chiên Dương Châu', priceRange: [30000, 45000], desc: 'Cơm chiên Dương Châu thập cẩm' },
    { name: 'Cơm Gà Xối Mỡ', priceRange: [35000, 50000], desc: 'Cơm gà xối mỡ da giòn' },
    { name: 'Cơm Sườn Ram', priceRange: [32000, 45000], desc: 'Cơm sườn ram mặn ngọt' },
    { name: 'Canh Chua', priceRange: [15000, 25000], desc: 'Canh chua miền Tây đậm đà' },
    { name: 'Nước Ngọt', priceRange: [10000, 15000], desc: 'Pepsi / Coca / 7Up / Sting' },
    { name: 'Trà Đá', priceRange: [3000, 5000], desc: 'Trà đá miễn phí hoặc giá rẻ' },
  ],
  'Bún/Phở': [
    { name: 'Phở Bò Tái', priceRange: [35000, 55000], desc: 'Phở bò tái nước dùng ninh xương 8h' },
    { name: 'Phở Bò Chín', priceRange: [35000, 55000], desc: 'Phở bò chín nạm gầu' },
    { name: 'Phở Gà', priceRange: [30000, 50000], desc: 'Phở gà ta nước trong' },
    { name: 'Bún Bò Huế', priceRange: [30000, 50000], desc: 'Bún bò Huế cay nồng đặc trưng' },
    { name: 'Bún Riêu Cua', priceRange: [30000, 45000], desc: 'Bún riêu cua đồng ngọt thanh' },
    { name: 'Bún Mắm', priceRange: [35000, 55000], desc: 'Bún mắm miền Tây đậm đà' },
    { name: 'Bún Thịt Nướng', priceRange: [30000, 45000], desc: 'Bún thịt nướng chả giò' },
    { name: 'Bún Chả Hà Nội', priceRange: [35000, 50000], desc: 'Bún chả nướng than kiểu Hà Nội' },
    { name: 'Hủ Tiếu Nam Vang', priceRange: [30000, 50000], desc: 'Hủ tiếu Nam Vang nước dùng trong' },
    { name: 'Hủ Tiếu Mì', priceRange: [28000, 45000], desc: 'Hủ tiếu mì hỗn hợp' },
    { name: 'Mì Quảng', priceRange: [30000, 45000], desc: 'Mì Quảng Đà Nẵng tôm thịt' },
    { name: 'Bánh Canh Cua', priceRange: [35000, 55000], desc: 'Bánh canh cua đồng béo ngậy' },
    { name: 'Nước Mía', priceRange: [10000, 15000], desc: 'Nước mía tươi ép tại chỗ' },
  ],
  'Lẩu': [
    { name: 'Lẩu Thái Tom Yum', priceRange: [150000, 250000], desc: 'Lẩu Thái chua cay Tom Yum' },
    { name: 'Lẩu Hải Sản', priceRange: [180000, 300000], desc: 'Lẩu hải sản tổng hợp' },
    { name: 'Lẩu Gà Lá É', priceRange: [150000, 220000], desc: 'Lẩu gà lá é thơm nức' },
    { name: 'Lẩu Mắm Miền Tây', priceRange: [150000, 250000], desc: 'Lẩu mắm cá linh đặc sản' },
    { name: 'Lẩu Cá Kèo', priceRange: [180000, 280000], desc: 'Lẩu cá kèo lá giang' },
    { name: 'Lẩu Bò', priceRange: [180000, 280000], desc: 'Lẩu bò sa tế đậm đà' },
    { name: 'Lẩu Nấm Chay', priceRange: [120000, 200000], desc: 'Lẩu nấm chay thanh đạm' },
    { name: 'Set Rau Lẩu', priceRange: [30000, 50000], desc: 'Đĩa rau lẩu tổng hợp tươi' },
    { name: 'Mì Lẩu', priceRange: [10000, 15000], desc: 'Mì hoặc bún lẩu' },
    { name: 'Bia Sài Gòn', priceRange: [15000, 20000], desc: 'Bia Sài Gòn lạnh' },
    { name: 'Bia Tiger', priceRange: [18000, 25000], desc: 'Bia Tiger Crystal' },
  ],
  'Nướng/BBQ': [
    { name: 'Combo Nướng 2 Người', priceRange: [200000, 350000], desc: 'Set nướng hỗn hợp cho 2' },
    { name: 'Bò Nướng Lá Lốt', priceRange: [50000, 80000], desc: 'Bò cuốn lá lốt nướng than' },
    { name: 'Sườn Nướng BBQ', priceRange: [60000, 100000], desc: 'Sườn nướng BBQ sốt đặc biệt' },
    { name: 'Gà Nướng Muối Ớt', priceRange: [80000, 150000], desc: 'Gà nướng muối ớt da giòn' },
    { name: 'Tôm Nướng Muối Ớt', priceRange: [80000, 120000], desc: 'Tôm sú nướng muối ớt' },
    { name: 'Mực Nướng Sa Tế', priceRange: [60000, 100000], desc: 'Mực nướng sa tế cay thơm' },
    { name: 'Xiên Nướng Thập Cẩm', priceRange: [30000, 50000], desc: 'Xiên nướng đủ loại' },
    { name: 'Cánh Gà Nướng', priceRange: [40000, 65000], desc: 'Cánh gà nướng mật ong' },
    { name: 'Rau Nướng', priceRange: [20000, 35000], desc: 'Rau củ nướng tổng hợp' },
    { name: 'Cơm Trắng', priceRange: [5000, 10000], desc: 'Cơm trắng nóng' },
    { name: 'Nước Ngọt', priceRange: [10000, 15000], desc: 'Pepsi / Coca / 7Up' },
  ],
  'Fast Food': [
    { name: 'Hamburger Bò Phô Mai', priceRange: [35000, 65000], desc: 'Hamburger bò Úc phô mai tan chảy' },
    { name: 'Hamburger Gà Giòn', priceRange: [30000, 55000], desc: 'Hamburger gà giòn sốt mayo' },
    { name: 'Pizza Hải Sản', priceRange: [80000, 150000], desc: 'Pizza hải sản size vừa' },
    { name: 'Pizza Pepperoni', priceRange: [75000, 140000], desc: 'Pizza pepperoni phô mai kéo sợi' },
    { name: 'Gà Rán Giòn (3 miếng)', priceRange: [55000, 80000], desc: 'Gà rán giòn tan 3 miếng' },
    { name: 'Gà Rán Cay (5 miếng)', priceRange: [80000, 120000], desc: 'Gà rán cay 5 miếng' },
    { name: 'Khoai Tây Chiên', priceRange: [25000, 40000], desc: 'Khoai tây chiên giòn' },
    { name: 'Combo 1 Người', priceRange: [65000, 99000], desc: 'Combo tiết kiệm 1 người' },
    { name: 'Combo Gia Đình', priceRange: [180000, 300000], desc: 'Combo gia đình 3-4 người' },
    { name: 'Onion Rings', priceRange: [25000, 40000], desc: 'Hành tây chiên giòn vòng' },
    { name: 'Nước Ngọt Lớn', priceRange: [15000, 25000], desc: 'Nước ngọt size lớn' },
  ],
  'Hải sản': [
    { name: 'Tôm Hùm Nướng Bơ Tỏi', priceRange: [300000, 500000], desc: 'Tôm hùm nướng bơ tỏi' },
    { name: 'Cua Rang Me', priceRange: [200000, 350000], desc: 'Cua biển rang me chua ngọt' },
    { name: 'Ghẹ Hấp Bia', priceRange: [150000, 250000], desc: 'Ghẹ hấp bia tươi ngon' },
    { name: 'Mực Chiên Giòn', priceRange: [60000, 100000], desc: 'Mực chiên bột giòn rụm' },
    { name: 'Tôm Sú Nướng', priceRange: [80000, 150000], desc: 'Tôm sú nướng muối ớt' },
    { name: 'Ốc Hương Rang Bơ', priceRange: [80000, 130000], desc: 'Ốc hương rang bơ tỏi' },
    { name: 'Cá Chẽm Hấp Xì Dầu', priceRange: [120000, 200000], desc: 'Cá chẽm hấp Hồng Kông' },
    { name: 'Nghêu Hấp Sả', priceRange: [40000, 65000], desc: 'Nghêu hấp sả ớt' },
    { name: 'Lẩu Hải Sản', priceRange: [200000, 350000], desc: 'Lẩu hải sản tổng hợp cho 2' },
    { name: 'Cơm Chiên Hải Sản', priceRange: [40000, 60000], desc: 'Cơm chiên hải sản thập cẩm' },
  ],
  'Gà': [
    { name: 'Gà Nướng Nguyên Con', priceRange: [180000, 280000], desc: 'Gà ta nướng nguyên con da giòn' },
    { name: 'Gà Chiên Nước Mắm', priceRange: [60000, 100000], desc: 'Gà chiên nước mắm tỏi ớt' },
    { name: 'Cánh Gà Chiên Mắm', priceRange: [40000, 65000], desc: 'Cánh gà chiên mắm giòn' },
    { name: 'Gà Kho Gừng', priceRange: [50000, 80000], desc: 'Gà kho gừng nghệ thơm' },
    { name: 'Gà Xé Phay', priceRange: [45000, 70000], desc: 'Gà xé phay rau răm' },
    { name: 'Cơm Gà Hải Nam', priceRange: [40000, 60000], desc: 'Cơm gà Hải Nam da luộc mềm' },
    { name: 'Phở Gà', priceRange: [30000, 50000], desc: 'Phở gà nước trong thanh' },
    { name: 'Lẩu Gà Lá É', priceRange: [150000, 230000], desc: 'Lẩu gà lá é cho 2 người' },
    { name: 'Gỏi Gà', priceRange: [35000, 55000], desc: 'Gỏi gà bắp cải hành tây' },
    { name: 'Cháo Gà', priceRange: [25000, 40000], desc: 'Cháo gà nóng hổi' },
  ],
  'Nhà hàng': [
    { name: 'Bò Bít Tết', priceRange: [80000, 150000], desc: 'Bò bít tết Úc áp chảo medium' },
    { name: 'Sườn Cừu Nướng', priceRange: [150000, 250000], desc: 'Sườn cừu nướng rosemary' },
    { name: 'Cá Hồi Áp Chảo', priceRange: [120000, 200000], desc: 'Cá hồi Na Uy áp chảo' },
    { name: 'Pasta Carbonara', priceRange: [60000, 100000], desc: 'Mì Ý sốt carbonara kem trứng' },
    { name: 'Salad Caesar', priceRange: [45000, 75000], desc: 'Salad Caesar gà nướng' },
    { name: 'Soup Nấm Truffle', priceRange: [50000, 80000], desc: 'Soup kem nấm truffle Pháp' },
    { name: 'Cơm Bò Kobe', priceRange: [150000, 300000], desc: 'Cơm bò Kobe wagyu' },
    { name: 'Tôm Hùm Thermidor', priceRange: [350000, 600000], desc: 'Tôm hùm Thermidor phô mai' },
    { name: 'Tiramisu', priceRange: [45000, 75000], desc: 'Tiramisu Ý truyền thống' },
    { name: 'Rượu Vang (ly)', priceRange: [80000, 150000], desc: 'Rượu vang đỏ/trắng 1 ly' },
    { name: 'Nước Suối', priceRange: [10000, 15000], desc: 'Nước suối Aquafina / Lavie' },
  ],
  'Chay': [
    { name: 'Cơm Chay Đặc Biệt', priceRange: [25000, 40000], desc: 'Cơm chay đặc biệt full topping' },
    { name: 'Phở Chay', priceRange: [25000, 40000], desc: 'Phở chay nấm rau củ' },
    { name: 'Bún Chay', priceRange: [22000, 35000], desc: 'Bún chay nước dùng rau củ' },
    { name: 'Lẩu Nấm Chay', priceRange: [100000, 180000], desc: 'Lẩu nấm chay thanh đạm' },
    { name: 'Gỏi Cuốn Chay', priceRange: [20000, 30000], desc: 'Gỏi cuốn rau củ chay' },
    { name: 'Đậu Hũ Sốt Cà', priceRange: [20000, 35000], desc: 'Đậu hũ non sốt cà chua' },
    { name: 'Mì Xào Chay', priceRange: [25000, 38000], desc: 'Mì xào rau củ chay' },
    { name: 'Chả Giò Chay', priceRange: [20000, 30000], desc: 'Chả giò chay giòn rụm' },
    { name: 'Canh Rau Củ', priceRange: [15000, 25000], desc: 'Canh rau củ thanh đạm' },
    { name: 'Nước Rau Má', priceRange: [10000, 18000], desc: 'Nước rau má thanh mát' },
  ],
  'Tráng miệng': [
    { name: 'Chè Thái', priceRange: [15000, 25000], desc: 'Chè Thái nước cốt dừa' },
    { name: 'Chè Đậu Đỏ', priceRange: [12000, 20000], desc: 'Chè đậu đỏ nếp cẩm' },
    { name: 'Chè Bưởi', priceRange: [12000, 22000], desc: 'Chè bưởi nước cốt dừa' },
    { name: 'Kem Bơ', priceRange: [20000, 35000], desc: 'Kem bơ sáp béo mịn' },
    { name: 'Kem Dừa', priceRange: [18000, 30000], desc: 'Kem dừa tươi miền Tây' },
    { name: 'Sữa Chua Trân Châu', priceRange: [15000, 25000], desc: 'Sữa chua trân châu đường đen' },
    { name: 'Tàu Hũ Nước Đường', priceRange: [8000, 15000], desc: 'Tàu hũ nước đường gừng nóng' },
    { name: 'Rau Câu Dừa', priceRange: [10000, 18000], desc: 'Rau câu dừa lá dứa' },
    { name: 'Bánh Flan', priceRange: [12000, 22000], desc: 'Bánh flan caramel mềm mịn' },
    { name: 'Sương Sáo', priceRange: [10000, 18000], desc: 'Sương sáo nước cốt dừa' },
  ],
  'Bánh Mì': [
    { name: 'Bánh Mì Thịt', priceRange: [15000, 30000], desc: 'Bánh mì thịt đặc biệt' },
    { name: 'Bánh Mì Bì Chả', priceRange: [12000, 25000], desc: 'Bánh mì bì chả lụa' },
    { name: 'Bánh Mì Chả Cá', priceRange: [15000, 28000], desc: 'Bánh mì chả cá Nha Trang' },
    { name: 'Bánh Mì Gà Xé', priceRange: [18000, 30000], desc: 'Bánh mì gà xé phay rau răm' },
    { name: 'Bánh Mì Ốp La', priceRange: [15000, 25000], desc: 'Bánh mì kẹp trứng ốp la' },
    { name: 'Bánh Mì Bơ Tỏi', priceRange: [12000, 20000], desc: 'Bánh mì nướng bơ tỏi' },
    { name: 'Bánh Mì Sốt Vang', priceRange: [25000, 40000], desc: 'Bánh mì bò sốt vang đặc biệt' },
    { name: 'Xôi Mặn', priceRange: [15000, 25000], desc: 'Xôi mặn thịt/gà/trứng' },
    { name: 'Nước Mía', priceRange: [8000, 12000], desc: 'Nước mía ép tươi' },
  ],
  'Bánh': [
    { name: 'Bánh Xèo', priceRange: [20000, 35000], desc: 'Bánh xèo giòn nhân tôm thịt' },
    { name: 'Bánh Khọt', priceRange: [25000, 40000], desc: 'Bánh khọt Vũng Tàu giòn rụm' },
    { name: 'Bánh Cuốn', priceRange: [20000, 35000], desc: 'Bánh cuốn nóng nhân thịt' },
    { name: 'Bánh Bèo', priceRange: [15000, 25000], desc: 'Bánh bèo chén tôm chấy' },
    { name: 'Bánh Bao', priceRange: [10000, 20000], desc: 'Bánh bao nhân thịt/trứng muối' },
    { name: 'Bánh Tráng Trộn', priceRange: [15000, 25000], desc: 'Bánh tráng trộn đủ vị' },
    { name: 'Bánh Cống', priceRange: [10000, 18000], desc: 'Bánh cống đặc sản Cần Thơ' },
    { name: 'Bánh Tầm Bì', priceRange: [20000, 30000], desc: 'Bánh tầm bì nước cốt dừa' },
    { name: 'Bánh Canh', priceRange: [25000, 40000], desc: 'Bánh canh giò heo / cua' },
    { name: 'Chè Đậu', priceRange: [10000, 18000], desc: 'Chè đậu xanh/đỏ nếp cẩm' },
  ],
  'Đồ ăn': [  // Default category
    { name: 'Cơm Tấm Sườn', priceRange: [30000, 45000], desc: 'Cơm tấm sườn nướng' },
    { name: 'Phở Bò', priceRange: [30000, 50000], desc: 'Phở bò tái chín' },
    { name: 'Bún Bò Huế', priceRange: [30000, 45000], desc: 'Bún bò Huế đặc biệt' },
    { name: 'Hủ Tiếu Nam Vang', priceRange: [28000, 42000], desc: 'Hủ tiếu Nam Vang nước dùng trong' },
    { name: 'Mì Xào Bò', priceRange: [30000, 45000], desc: 'Mì xào bò rau củ' },
    { name: 'Cháo Lòng', priceRange: [20000, 32000], desc: 'Cháo lòng heo nóng hổi' },
    { name: 'Bánh Mì Thịt', priceRange: [15000, 25000], desc: 'Bánh mì thịt đặc biệt' },
    { name: 'Gỏi Cuốn', priceRange: [20000, 30000], desc: 'Gỏi cuốn tôm thịt tươi' },
    { name: 'Chả Giò', priceRange: [20000, 35000], desc: 'Chả giò giòn rụm' },
    { name: 'Cà Phê Sữa Đá', priceRange: [18000, 28000], desc: 'Cà phê sữa đá truyền thống' },
    { name: 'Nước Ngọt', priceRange: [10000, 15000], desc: 'Pepsi / Coca / 7Up' },
    { name: 'Trà Đá', priceRange: [3000, 5000], desc: 'Trà đá' },
  ],
};

// Map additional categories to template keys
const CATEGORY_MAP = {
  'Bún Bò': 'Bún/Phở', 'Hủ Tiếu': 'Bún/Phở',
};

function getTemplateForCategory(category) {
  return MENU_TEMPLATES[category] || MENU_TEMPLATES[CATEGORY_MAP[category]] || MENU_TEMPLATES['Đồ ăn'];
}

function generateMenuForRestaurant(name, category) {
  const template = getTemplateForCategory(category);
  const menuSize = randBetween(8, Math.min(15, template.length));
  const selected = pick(template, menuSize);
  
  return selected.map(item => {
    const inStorePrice = round100(randBetween(item.priceRange[0], item.priceRange[1]));
    return {
      name: item.name,
      price: inStorePrice,
      appPrice: calcApp(inStorePrice),
      inStorePrice: inStorePrice,
      description: item.desc,
      img: '',
    };
  });
}

async function run() {
  console.log(`[Menu Processor] 🚀 Starting menu processing...\n`);
  
  // Load DB
  let restaurants = JSON.parse(fs.readFileSync(LOCAL_JSON_FILE, 'utf8'));
  if (!Array.isArray(restaurants)) { console.error('Invalid DB'); process.exit(1); }
  
  const templateQuans = restaurants.filter(r => r.menuTemplateFallback === true || (!r.hasRealMenu && !r.menuTemplateFallback));
  console.log(`[Menu Processor] Total restaurants: ${restaurants.length}`);
  console.log(`[Menu Processor] Template/no-menu: ${templateQuans.length}`);
  console.log(`[Menu Processor] Real menus: ${restaurants.length - templateQuans.length}\n`);

  let processed = 0, skipped = 0;

  for (const rest of restaurants) {
    // Skip restaurants with real menus
    if (rest.hasRealMenu && !rest.menuTemplateFallback) {
      skipped++;
      continue;
    }

    const safeId = (rest.id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!safeId) continue;
    
    const menuPath = path.join(MENUS_DIR, `${safeId}.json`);
    
    // Generate diverse menu based on category
    const menu = generateMenuForRestaurant(rest.name, rest.category);
    
    // Write menu file
    fs.writeFileSync(menuPath, JSON.stringify(menu, null, 2), 'utf8');
    
    // Update dishNames
    rest.dishNames = menu.map(m => m.name).filter(Boolean);
    rest.menuTemplateFallback = false;
    rest.hasRealMenu = false; // Still template-generated, but diverse
    rest.menuProcessedAt = new Date().toISOString();
    
    processed++;
    
    if (processed % 1000 === 0) {
      console.log(`[Menu Processor] Progress: ${processed}/${templateQuans.length} processed`);
    }
  }

  // Save updated DB
  restaurants.forEach(r => { delete r.menu; });
  fs.writeFileSync(LOCAL_JSON_FILE, JSON.stringify(restaurants, null, 2), 'utf8');

  const menuFiles = fs.readdirSync(MENUS_DIR).filter(f => f.endsWith('.json')).length;
  const dbSize = (fs.statSync(LOCAL_JSON_FILE).size / 1024).toFixed(1);

  console.log(`\n[Menu Processor] ══════════════════════════════════════════`);
  console.log(`[Menu Processor] 💾 KẾT QUẢ:`);
  console.log(`[Menu Processor]    ✅ Processed: ${processed} quán`);
  console.log(`[Menu Processor]    ⏩ Skipped (real menu): ${skipped} quán`);
  console.log(`[Menu Processor]    📁 Menu files: ${menuFiles}`);
  console.log(`[Menu Processor]    💾 DB size: ${dbSize} KB`);
  console.log(`[Menu Processor] ══════════════════════════════════════════`);
  
  process.exit(0);
}

run().catch(err => { console.error('Error:', err.message); process.exit(1); });
