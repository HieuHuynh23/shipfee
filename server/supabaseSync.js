'use strict';

/**
 * supabaseSync.js — Module dùng chung để đẩy quán/menu + thông báo biến động lên Supabase.
 *
 * Dùng bởi:
 *   - server.js (luồng ShopeeFood — delegate qua đây để nhất quán schema)
 *   - crawl_grabfood_menus.js (cào menu GrabFood → đẩy + notification biến động)
 *   - discover_grabfood_restaurants.js (upsert quán mới phát hiện)
 *   - sync_menus_to_supabase.js (đồng bộ hàng loạt)
 *
 * Ghi chú: KHÔNG chạm vào logic scrape ShopeeFood. Chỉ chuẩn hoá phần ĐẨY Supabase.
 */

const path = require('path');

let _client;
let _tried = false;

/**
 * Lấy Supabase service-role client.
 * @param {object} [injected] Client có sẵn (server truyền vào để tái dùng). Nếu không có → tự tạo từ env.
 */
function getSupabaseClient(injected) {
  if (injected) return injected;
  if (_client) return _client;
  if (_tried) return _client || null;
  _tried = true;

  // Best-effort: nạp .env cạnh module nếu script gọi chưa nạp
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      require('dotenv').config({ path: path.join(__dirname, '.env') });
    } catch (_) {
      /* dotenv không bắt buộc */
    }
  }

  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key || url === 'your_supabase_url_here') {
    _client = null;
    return null;
  }
  try {
    const { createClient } = require('@supabase/supabase-js');
    _client = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  } catch (err) {
    console.warn('[supabaseSync] Không khởi tạo được client:', err.message);
    _client = null;
  }
  return _client;
}

/**
 * Chuẩn hoá 1 dòng restaurant cho bảng Supabase `restaurants`.
 * Hỗ trợ cả field local (latitude/longitude/img) lẫn field cũ (lat/lon/image_url).
 */
function buildRestaurantRow(restaurant, menu) {
  const menuArr = Array.isArray(menu) ? menu : [];
  const dishNames = Array.isArray(restaurant.dishNames) && restaurant.dishNames.length
    ? restaurant.dishNames
    : menuArr.map(m => m && m.name).filter(Boolean);
  return {
    id: restaurant.id,
    name: restaurant.name || '',
    address: restaurant.address || '',
    lat: restaurant.latitude ?? restaurant.lat ?? null,
    lon: restaurant.longitude ?? restaurant.lon ?? null,
    rating: restaurant.rating || 4.5,
    image_url: restaurant.img || restaurant.image_url || '',
    is_closed: !!restaurant.isClosed,
    closed_reason: restaurant.closedReason || '',
    has_real_menu: restaurant.hasRealMenu === true,
    dish_names: dishNames,
    menu: menuArr,
    updated_at: new Date().toISOString()
  };
}

/**
 * Upsert 1 quán + menu lên Supabase.
 * @param {object} restaurant
 * @param {Array} menu
 * @param {{ client?: object, hasRealMenu?: boolean }} [opts]
 */
async function upsertRestaurant(restaurant, menu, opts = {}) {
  const supabase = getSupabaseClient(opts.client);
  if (!supabase || !restaurant || !restaurant.id) return { ok: false, skipped: true };
  const row = buildRestaurantRow(restaurant, menu);
  if (opts.hasRealMenu != null) row.has_real_menu = opts.hasRealMenu === true;
  try {
    const { error } = await supabase.from('restaurants').upsert(row, { onConflict: 'id' });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Upsert hàng loạt (dùng cho sync_menus_to_supabase.js).
 * @param {Array} rows Mảng row đã build sẵn (hoặc {restaurant, menu}).
 */
async function upsertRestaurantsBatch(rows, opts = {}) {
  const supabase = getSupabaseClient(opts.client);
  if (!supabase || !Array.isArray(rows) || rows.length === 0) return { ok: false, skipped: true };
  try {
    const { error } = await supabase.from('restaurants').upsert(rows, { onConflict: 'id' });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Tạo object notification chuẩn (khớp addNotification của server). */
function buildNotification(type, restaurantId, restaurantName, title, message) {
  return {
    id: 'nt-' + Date.now() + '-' + Math.floor(1000 + Math.random() * 9000),
    type,
    restaurantId,
    restaurantName,
    title,
    message,
    createdAt: Date.now(),
    read: false
  };
}

/** Insert 1 notification lên bảng `system_notifications`. */
async function insertNotification(notif, opts = {}) {
  const supabase = getSupabaseClient(opts.client);
  if (!supabase || !notif || !notif.id) return { ok: false, skipped: true };
  try {
    const { error } = await supabase.from('system_notifications').insert([{
      id: notif.id,
      type: notif.type,
      restaurant_id: notif.restaurantId,
      restaurant_name: notif.restaurantName,
      title: notif.title,
      message: notif.message,
      created_at: notif.createdAt,
      read: notif.read === true
    }]);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * So sánh menu cũ/mới → danh sách chuỗi mô tả thay đổi (đổi giá, món mới, xóa món).
 * Logic khớp diffAndLogMenuChanges của server để CRM hiển thị đồng nhất.
 */
function diffMenuChanges(oldMenu, newMenu) {
  if (!Array.isArray(oldMenu) || oldMenu.length === 0) return [];
  if (!Array.isArray(newMenu) || newMenu.length === 0) return [];

  const oldMap = new Map();
  oldMenu.forEach(item => {
    if (item && item.name) oldMap.set(String(item.name).trim(), item);
  });
  const newMap = new Map();
  newMenu.forEach(item => {
    if (item && item.name) newMap.set(String(item.name).trim(), item);
  });

  const changes = [];
  for (const [name, newItem] of newMap.entries()) {
    const oldItem = oldMap.get(name);
    if (oldItem) {
      const op = Number(oldItem.inStorePrice) || 0;
      const np = Number(newItem.inStorePrice) || 0;
      if (op > 0 && op !== np) {
        const diff = np - op;
        const pct = Math.round((diff / op) * 100);
        changes.push(`Món "${name}" đổi giá: ${op.toLocaleString()}đ -> ${np.toLocaleString()}đ (${diff > 0 ? '+' : ''}${diff.toLocaleString()}đ, ${diff > 0 ? 'tăng' : 'giảm'} ${Math.abs(pct)}%)`);
      }
    } else {
      const np = Number(newItem.inStorePrice) || 0;
      changes.push(`Món mới: "${name}" với giá ${np.toLocaleString()}đ`);
    }
  }
  for (const name of oldMap.keys()) {
    if (!newMap.has(name)) changes.push(`Xóa món: "${name}" khỏi thực đơn`);
  }
  return changes;
}

/**
 * Đẩy quán + menu + notification biến động trong 1 lần gọi (tiện cho crawler).
 * @param {{restaurant, menu, oldMenu?, wasClosed?, source?, client?, hasRealMenu?}} params
 * @returns {{ upserted:boolean, notified:number }}
 */
async function syncRestaurantWithChanges(params = {}) {
  const {
    restaurant,
    menu,
    oldMenu = [],
    wasClosed = false,
    source = '',
    client,
    hasRealMenu
  } = params;
  const result = { upserted: false, notified: 0 };
  if (!restaurant || !restaurant.id) return result;

  const up = await upsertRestaurant(restaurant, menu, { client, hasRealMenu });
  result.upserted = up.ok === true;

  const label = source ? ` (${source})` : '';

  // Đổi trạng thái mở/đóng
  if (wasClosed && restaurant.isClosed !== true) {
    const n = buildNotification('status_change', restaurant.id, restaurant.name, 'Quán hoạt động trở lại', `Cửa hàng đã hoạt động trở lại${label}.`);
    if ((await insertNotification(n, { client })).ok) result.notified++;
  } else if (!wasClosed && restaurant.isClosed === true) {
    const n = buildNotification('status_change', restaurant.id, restaurant.name, 'Quán đóng cửa', `Cửa hàng đã tạm đóng cửa hoặc ngưng phục vụ${label}.`);
    if ((await insertNotification(n, { client })).ok) result.notified++;
  }

  // Biến động giá/món (chỉ khi có menu cũ để so sánh)
  const changes = diffMenuChanges(oldMenu, menu);
  if (changes.length > 0) {
    const n = buildNotification('price_change', restaurant.id, restaurant.name, `Cập nhật thực đơn & Giá bán${label}`, changes.join('\n'));
    if ((await insertNotification(n, { client })).ok) result.notified++;
  }

  return result;
}

module.exports = {
  getSupabaseClient,
  buildRestaurantRow,
  upsertRestaurant,
  upsertRestaurantsBatch,
  buildNotification,
  insertNotification,
  diffMenuChanges,
  syncRestaurantWithChanges
};
