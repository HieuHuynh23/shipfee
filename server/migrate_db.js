const fs = require('fs');
const path = require('path');
const dbHelper = require('./dbHelper');

const oldDbPath = path.join(__dirname, 'restaurants-local.json');
const backupDbPath = path.join(__dirname, 'restaurants-local.json.backup');

console.log('🚀 Bắt đầu quá trình di trú và phân tách cơ sở dữ liệu...');

if (!fs.existsSync(oldDbPath)) {
  console.error(`❌ Không tìm thấy tệp cơ sở dữ liệu cũ: ${oldDbPath}`);
  process.exit(1);
}

try {
  const raw = fs.readFileSync(oldDbPath, 'utf8');
  const restaurants = JSON.parse(raw);
  
  if (!Array.isArray(restaurants)) {
    console.error('❌ Dữ liệu cũ không đúng định dạng JSON Array.');
    process.exit(1);
  }

  console.log(`📊 Đã đọc thành công ${restaurants.length} quán ăn từ tệp cũ.`);
  console.log('⏳ Đang phân chia dữ liệu vào 15 tệp phân mảnh...');
  
  dbHelper.write(restaurants);
  
  console.log('✅ Đã ghi thành công 15 tệp phân mảnh!');
  
  // Kiểm tra kích thước và số dòng của từng phân mảnh để xác nhận
  console.log('\n📊 Thống kê các tệp phân mảnh vừa tạo:');
  for (let i = 0; i < dbHelper.NUM_CHUNKS; i++) {
    const chunkPath = dbHelper.getChunkPath(i);
    if (fs.existsSync(chunkPath)) {
      const chunkRaw = fs.readFileSync(chunkPath, 'utf8');
      const chunkParsed = JSON.parse(chunkRaw);
      const lineCount = chunkRaw.split('\n').length;
      console.log(`   - Chunk ${i}: ${chunkParsed.length} quán ăn (${lineCount} dòng)`);
    } else {
      console.error(`   - ❌ Không tìm thấy Chunk ${i}!`);
    }
  }

  // Backup tệp cũ để chuyển hoàn toàn sang sử dụng chunk
  console.log(`\n📦 Sao lưu tệp cơ sở dữ liệu cũ thành: ${backupDbPath}`);
  fs.renameSync(oldDbPath, backupDbPath);
  console.log('✨ Di trú cơ sở dữ liệu hoàn tất thành công!');
} catch (err) {
  console.error('❌ Lỗi trong quá trình di trú:', err);
  process.exit(1);
}
