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
      try {
        const raw = fs.readFileSync(chunkPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          all.push(...parsed);
          foundChunks++;
        }
      } catch (err) {
        console.error(`[dbHelper] Lỗi đọc chunk ${i}:`, err.message);
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

function writeAll(restaurants) {
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

module.exports = {
  read: readAll,
  write: writeAll,
  getChunkIndex,
  getChunkPath,
  NUM_CHUNKS
};
