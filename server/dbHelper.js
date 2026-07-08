const fs = require('fs');
const path = require('path');

const CHUNKS_DIR = path.join(__dirname, 'restaurants-chunks');
const NUM_CHUNKS = 15;
const MENUS_DIR = path.join(__dirname, 'menus');

if (!fs.existsSync(CHUNKS_DIR)) {
  fs.mkdirSync(CHUNKS_DIR, { recursive: true });
}

if (!fs.existsSync(MENUS_DIR)) {
  fs.mkdirSync(MENUS_DIR, { recursive: true });
}

function getChunkIndex(restaurantId) {
  let hash = 0;
  const str = String(restaurantId);
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % NUM_CHUNKS;
}

function getChunkPath(idx) {
  return path.join(CHUNKS_DIR, `restaurants-chunk-${idx}.json`);
}

function getMenuFilePath(restaurantId) {
  const safeId = String(restaurantId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(MENUS_DIR, `${safeId}.json`);
}

function writeRestaurantMenu(restaurantId, menu) {
  const filePath = getMenuFilePath(restaurantId);
  try {
    fs.writeFileSync(filePath, JSON.stringify(menu || [], null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`[DB Menu] Lỗi ghi menu cho ${restaurantId}:`, err.message);
  }
  return false;
}

function readAll() {
  const all = [];
  let foundChunks = 0;
  for (let i = 0; i < NUM_CHUNKS; i++) {
    const chunkPath = getChunkPath(i);
    if (fs.existsSync(chunkPath)) {
      let parsed = null;
      let retries = 5;
      while (retries > 0) {
        try {
          const raw = fs.readFileSync(chunkPath, 'utf8');
          parsed = JSON.parse(raw);
          break;
        } catch (err) {
          retries--;
          if (retries === 0) {
            throw new Error(`[dbHelper] Không thể đọc hoặc parse chunk ${i} sau nhiều lần thử: ${err.message}`);
          }
          const start = Date.now();
          while (Date.now() - start < 100) {} // sleep 100ms
        }
      }
      if (Array.isArray(parsed)) {
        all.push(...parsed);
        foundChunks++;
      }
    }
  }
  // Nếu chưa có chunk nào, fallback về tệp restaurants-local.json cũ nếu tồn tại
  if (foundChunks === 0) {
    const oldDbPath = path.join(__dirname, 'restaurants-local.json');
    if (fs.existsSync(oldDbPath)) {
      try {
        const raw = fs.readFileSync(oldDbPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      } catch (e) {}
    }
  }
  return all;
}

function updateRestaurant(updated) {
  if (!updated || !updated.id) return false;
  const idx = getChunkIndex(updated.id);
  const chunkPath = getChunkPath(idx);
  try {
    let chunk = [];
    if (fs.existsSync(chunkPath)) {
      let retries = 5;
      while (retries > 0) {
        try {
          const raw = fs.readFileSync(chunkPath, 'utf8');
          chunk = JSON.parse(raw);
          break;
        } catch (err) {
          retries--;
          if (retries === 0) {
            throw err;
          }
          const start = Date.now();
          while (Date.now() - start < 100) {} // sleep 100ms
        }
      }
    }
    if (!Array.isArray(chunk)) chunk = [];
    
    // Tách menu ra file riêng nếu có
    if (updated.menu) {
      writeRestaurantMenu(updated.id, updated.menu);
      updated.dishNames = updated.menu.map(m => m.name).filter(Boolean);
      delete updated.menu;
    }
    
    const itemIdx = chunk.findIndex(r => String(r.id) === String(updated.id));
    if (itemIdx !== -1) {
      chunk[itemIdx] = updated;
    } else {
      chunk.push(updated);
    }
    
    const newContent = JSON.stringify(chunk, null, 2);
    fs.writeFileSync(chunkPath, newContent, 'utf8');
    return true;
  } catch (err) {
    console.error(`[dbHelper] Lỗi cập nhật quán ${updated.id} vào chunk ${idx}:`, err.message);
  }
  return false;
}

function writeAll(restaurants) {
  if (!Array.isArray(restaurants) || restaurants.length < 7000) {
    console.error(`[dbHelper] 🛑 CẢNH BÁO AN TOÀN: Từ chối ghi đè database vì số lượng quán ăn quá thấp (${restaurants ? restaurants.length : 0} < 7000). Tránh làm mất dữ liệu!`);
    return false;
  }
  const chunks = Array.from({ length: NUM_CHUNKS }, () => []);
  
  restaurants.forEach(r => {
    if (r && r.id) {
      // Tách menu ra file riêng giống như interceptor cũ
      if (r.menu) {
        writeRestaurantMenu(r.id, r.menu);
        r.dishNames = r.menu.map(m => m.name).filter(Boolean);
        delete r.menu;
      }
      
      const idx = getChunkIndex(r.id);
      chunks[idx].push(r);
    }
  });

  for (let i = 0; i < NUM_CHUNKS; i++) {
    const chunkPath = getChunkPath(i);
    try {
      const newContent = JSON.stringify(chunks[i], null, 2);
      let currentContent = '';
      if (fs.existsSync(chunkPath)) {
        currentContent = fs.readFileSync(chunkPath, 'utf8');
      }
      if (currentContent !== newContent) {
        fs.writeFileSync(chunkPath, newContent, 'utf8');
      }
    } catch (err) {
      console.error(`[dbHelper] Lỗi ghi chunk ${i}:`, err.message);
    }
  }
  return true;
}

function readActive() {
  const all = readAll();
  return all.filter(r => r && !r.isClosed);
}

function getCrawlQueue() {
  const all = readAll();
  return all.filter(r => {
    if (!r) return false;
    // Lấy quán đóng cửa tạm thời (không phải vĩnh viễn) hoặc quán chưa có menu thực tế
    const isTempClosed = r.isClosed && !(r.closedReason && (r.closedReason.includes('permanently') || r.closedReason.includes('vĩnh viễn')));
    const needMenu = !r.isClosed && !r.hasRealMenu;
    return isTempClosed || needMenu;
  });
}

module.exports = {
  read: readAll,
  readActive,
  getCrawlQueue,
  write: writeAll,
  updateRestaurant,
  getChunkIndex,
  getChunkPath,
  NUM_CHUNKS
};
