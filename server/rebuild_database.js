const fs = require('fs');
const path = require('path');
const dbHelper = require('./dbHelper');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: 'd:\\FOOD DELIVERY\\server\\.env' });

const backupDbPath = 'd:\\FOOD DELIVERY\\_backup\\FOOD DELIVERY_20260623_013109\\server\\restaurants-local.json';
const menusDir = 'd:\\FOOD DELIVERY\\server\\menus';

console.log('🏁 BẮT ĐẦU REBUILD LẠI TOÀN BỘ DATABASE TỪ DỮ LIỆU GỐC...\n');

// 1. Kiểm tra file backup gốc
if (!fs.existsSync(backupDbPath)) {
  console.error('❌ Lỗi: Không tìm thấy file restaurants-local.json gốc ở thư mục _backup!');
  process.exit(1);
}

try {
  // 2. Đọc dữ liệu gốc
  console.log('📖 Đang đọc dữ liệu quán ăn gốc...');
  const rawData = fs.readFileSync(backupDbPath, 'utf8');
  const restaurants = JSON.parse(rawData);
  
  if (!Array.isArray(restaurants) || restaurants.length === 0) {
    console.error('❌ Lỗi: Dữ liệu gốc không hợp lệ hoặc rỗng!');
    process.exit(1);
  }
  
  console.log(`ℹ️ Tìm thấy ${restaurants.length} quán ăn gốc.`);

  // 3. Reset sạch sẽ các quán về trạng thái ban đầu (fallback, chưa cào)
  console.log('🔄 Đang làm sạch và reset các thuộc tính quán về mặc định...');
  restaurants.forEach(r => {
    r.hasRealMenu = false;
    r.menuTemplateFallback = true;
    delete r.menu;
    delete r.menuUpdatedAt;
    r.dishNames = [];
  });

  // 4. Xóa sạch thư mục menus cũ
  if (fs.existsSync(menusDir)) {
    const files = fs.readdirSync(menusDir);
    console.log(`🧹 Đang xóa ${files.length} tệp thực đơn trong thư mục menus...`);
    files.forEach(file => {
      if (file.endsWith('.json')) {
        try {
          fs.unlinkSync(path.join(menusDir, file));
        } catch (e) {}
      }
    });
  }

  // 5. Sử dụng dbHelper để chia nhỏ và ghi đè 15 chunk mới sạch sẽ
  console.log('💾 Đang ghi đè 15 file phân mảnh (chunks) database...');
  const success = dbHelper.write(restaurants);
  if (!success) {
    console.error('❌ Lỗi khi ghi chunks bằng dbHelper!');
    process.exit(1);
  }
  console.log('✅ Đã ghi đè 15 chunk JSON sạch sẽ thành công!');

  // 6. Reset Supabase
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supabaseUrl && supabaseKey) {
    console.log('🌐 Đang đồng bộ reset dữ liệu trên Supabase...');
    const supabase = createClient(supabaseUrl, supabaseKey);
    (async () => {
      const { error } = await supabase
        .from('restaurants')
        .update({ 
          has_real_menu: false, 
          menu: [], 
          updated_at: new Date().toISOString() 
        })
        .neq('id', '');
        
      if (error) {
        console.error('❌ Lỗi reset Supabase:', error.message);
      } else {
        console.log('✅ Đã reset trạng thái has_real_menu = false cho tất cả quán ăn trên Supabase thành công!');
      }
      console.log('\n🎉 TOÀN BỘ TIẾN TRÌNH REBUILD DATABASE HOÀN TẤT THÀNH CÔNG!');
    })();
  } else {
    console.log('⚠️ Supabase chưa được cấu hình, bỏ qua reset online.');
    console.log('\n🎉 TOÀN BỘ TIẾN TRÌNH REBUILD DATABASE HOÀN TẤT THÀNH CÔNG!');
  }

} catch (err) {
  console.error('❌ Lỗi nghiêm trọng:', err.message);
}
