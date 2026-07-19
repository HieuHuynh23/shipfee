/* ==========================================================================
   SHIPFEE — Customer App JavaScript Logic
   ========================================================================== */

'use strict';

const defaultApiUrl = 'https://shipfee-eo5s.onrender.com';

if (localStorage.getItem('shipfee_api_url')) {
  localStorage.removeItem('shipfee_api_url');
}
const _API_BASE = defaultApiUrl;

/* --------------------------------------------------------------------------
   Data: slim restaurant index + per-restaurant menu cache (TTL)
   -------------------------------------------------------------------------- */
const INDEX_CACHE_KEY = 'shipfee_restaurants_index';
const LEGACY_CACHE_KEY = 'shipfee_restaurants';
const MENU_CACHE_PREFIX = 'shipfee_menu_';
const MENU_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const INDEX_CACHE_MAX = 200;

let MARKUP_RATE = 0.28;
let MIN_SHIPPER_EARNING = 15000;

function round100(n) {
  return Math.round(Number(n) / 100) * 100;
}

function calcToppingAppPrice(price) {
  return round100((Number(price) || 0) * (1 + MARKUP_RATE));
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeMenuItem(m) {
  if (!m || typeof m !== 'object' || !m.id || !m.name) return null;
  const item = {
    id: String(m.id),
    name: String(m.name),
    desc: String(m.desc || ''),
    inStorePrice: typeof m.inStorePrice === 'number' ? m.inStorePrice : 30000,
    appPrice: typeof m.appPrice === 'number' ? m.appPrice : 39000,
    img: String(m.img || ''),
    category: String(m.category || 'Thực đơn')
  };
  if (m.isAvailable === false || m.available === false) {
    item.isAvailable = false;
    item.available = false;
  } else if (m.isAvailable === true || m.available === true) {
    item.isAvailable = true;
    item.available = true;
  }
  if (Array.isArray(m.options)) {
    item.options = m.options;
  }
  return item;
}

function normalizeRestaurant(r, { includeMenu = true } = {}) {
  if (!r || typeof r !== 'object') return null;
  if (!r.id || !r.name) return null;

  const dishNames = Array.isArray(r.dishNames)
    ? r.dishNames.map(String).slice(0, 40)
    : [];

  const out = {
    id: String(r.id),
    name: String(r.name),
    category: String(r.category || 'Đồ ăn'),
    rating: typeof r.rating === 'number' ? r.rating : 4.5,
    reviews: typeof r.reviews === 'number' ? r.reviews : 100,
    distance: String(r.distance || '1.0 km'),
    time: String(r.time || '15-25 phút'),
    address: String(r.address || ''),
    phone: String(r.phone || ''),
    img: String(r.img || 'https://images.unsplash.com/photo-1625398407796-82650a8c135f?w=800&q=80'),
    tags: Array.isArray(r.tags) ? r.tags.map(String) : ['Đang mở'],
    minOrder: typeof r.minOrder === 'number' ? r.minOrder : 30000,
    hasRealMenu: r.hasRealMenu === true,
    menuTemplateFallback: r.menuTemplateFallback === true,
    menuStatus: r.menuStatus ? String(r.menuStatus) : null,
    isClosed: r.isClosed === true,
    closedAt: r.closedAt ? String(r.closedAt) : null,
    closedReason: r.closedReason ? String(r.closedReason) : null,
    menuUpdatedAt: r.menuUpdatedAt ? String(r.menuUpdatedAt) : null,
    latitude: typeof r.latitude === 'number' ? r.latitude : (typeof r.lat === 'number' ? r.lat : null),
    longitude: typeof r.longitude === 'number' ? r.longitude : (typeof r.lon === 'number' ? r.lon : null),
    distanceValue: typeof r.distanceValue === 'number' ? r.distanceValue : null,
    distanceSurchargePerItem: typeof r.distanceSurchargePerItem === 'number' ? r.distanceSurchargePerItem : 0,
    dishNames
  };

  if (includeMenu) {
    out.menu = Array.isArray(r.menu) ? r.menu.map(normalizeMenuItem).filter(Boolean) : [];
  } else {
    out.menu = [];
  }
  return out;
}

function toSlimRestaurant(r) {
  const n = normalizeRestaurant(r, { includeMenu: false });
  if (!n) return null;
  // Keep dishNames slim for local search; never persist full menus in the index
  return n;
}

function menuCacheKey(id) {
  return MENU_CACHE_PREFIX + String(id);
}

function saveMenuCache(restaurant) {
  if (!restaurant || !restaurant.id) return;
  const menu = Array.isArray(restaurant.menu) ? restaurant.menu.map(normalizeMenuItem).filter(Boolean) : [];
  if (menu.length === 0) return;
  try {
    localStorage.setItem(menuCacheKey(restaurant.id), JSON.stringify({
      savedAt: Date.now(),
      menuUpdatedAt: restaurant.menuUpdatedAt || null,
      hasRealMenu: restaurant.hasRealMenu === true,
      menuTemplateFallback: restaurant.menuTemplateFallback === true,
      menuStatus: restaurant.menuStatus || null,
      distanceSurchargePerItem: restaurant.distanceSurchargePerItem || 0,
      menu
    }));
  } catch (e) {
    // Quota exceeded — drop oldest menu caches
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(MENU_CACHE_PREFIX)) keys.push(k);
      }
      keys.slice(0, Math.ceil(keys.length / 2)).forEach(k => localStorage.removeItem(k));
      localStorage.setItem(menuCacheKey(restaurant.id), JSON.stringify({
        savedAt: Date.now(),
        menuUpdatedAt: restaurant.menuUpdatedAt || null,
        hasRealMenu: restaurant.hasRealMenu === true,
        menuTemplateFallback: restaurant.menuTemplateFallback === true,
        menuStatus: restaurant.menuStatus || null,
        distanceSurchargePerItem: restaurant.distanceSurchargePerItem || 0,
        menu
      }));
    } catch (e2) {}
  }
}

function loadMenuCache(id) {
  try {
    const raw = localStorage.getItem(menuCacheKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.menu)) return null;
    if (Date.now() - (parsed.savedAt || 0) > MENU_CACHE_TTL_MS) {
      localStorage.removeItem(menuCacheKey(id));
      return null;
    }
    return parsed;
  } catch (e) {
    return null;
  }
}

function hydrateRestaurantFromCaches(base) {
  if (!base) return null;
  const r = normalizeRestaurant(base, { includeMenu: true });
  if (!r) return null;
  if (!r.menu || r.menu.length === 0) {
    const cached = loadMenuCache(r.id);
    if (cached) {
      r.menu = cached.menu.map(normalizeMenuItem).filter(Boolean);
      if (cached.menuUpdatedAt) r.menuUpdatedAt = cached.menuUpdatedAt;
      if (cached.hasRealMenu != null) r.hasRealMenu = cached.hasRealMenu;
      if (cached.menuTemplateFallback != null) r.menuTemplateFallback = cached.menuTemplateFallback;
      if (cached.menuStatus) r.menuStatus = cached.menuStatus;
      if (typeof cached.distanceSurchargePerItem === 'number') {
        r.distanceSurchargePerItem = cached.distanceSurchargePerItem;
      }
    }
  }
  return r;
}

function persistIndex() {
  try {
    const slim = ACTIVE_RESTAURANTS.slice(0, INDEX_CACHE_MAX).map(toSlimRestaurant).filter(Boolean);
    localStorage.setItem(INDEX_CACHE_KEY, JSON.stringify(slim));
    localStorage.removeItem(LEGACY_CACHE_KEY);
  } catch (e) {
    try { localStorage.removeItem(LEGACY_CACHE_KEY); } catch (e2) {}
  }
}

let ACTIVE_RESTAURANTS = [];
try {
  const cached = localStorage.getItem(INDEX_CACHE_KEY) || localStorage.getItem(LEGACY_CACHE_KEY);
  if (cached) {
    const parsed = JSON.parse(cached);
    if (Array.isArray(parsed)) {
      ACTIVE_RESTAURANTS = parsed.map(r => hydrateRestaurantFromCaches(r)).filter(Boolean);
    }
  }
} catch (e) {}

if (!ACTIVE_RESTAURANTS || ACTIVE_RESTAURANTS.length === 0) {
  const defaultList = typeof RESTAURANTS !== 'undefined' ? RESTAURANTS : [];
  ACTIVE_RESTAURANTS = defaultList.map(r => normalizeRestaurant(r)).filter(Boolean);
}

function setRestaurants(list) {
  const incoming = Array.isArray(list) ? list : [];
  // Preserve menus already in memory / detail cache when replacing the index
  const prevById = new Map(ACTIVE_RESTAURANTS.map(r => [String(r.id), r]));
  ACTIVE_RESTAURANTS = incoming.map(r => {
    const slim = toSlimRestaurant(r);
    if (!slim) return null;
    const prev = prevById.get(slim.id);
    if (Array.isArray(r.menu) && r.menu.length > 0) {
      slim.menu = r.menu.map(normalizeMenuItem).filter(Boolean);
      saveMenuCache({ ...slim, menu: slim.menu });
    } else if (prev && Array.isArray(prev.menu) && prev.menu.length > 0) {
      slim.menu = prev.menu;
    } else {
      const cached = loadMenuCache(slim.id);
      slim.menu = cached ? cached.menu.map(normalizeMenuItem).filter(Boolean) : [];
    }
    return slim;
  }).filter(Boolean);
  persistIndex();
}

function upsertRestaurant(restaurant) {
  const normalized = normalizeRestaurant(restaurant, { includeMenu: true });
  if (!normalized) return null;
  if (normalized.menu && normalized.menu.length > 0) {
    saveMenuCache(normalized);
  }
  const idx = ACTIVE_RESTAURANTS.findIndex(r => String(r.id) === normalized.id);
  if (idx === -1) {
    ACTIVE_RESTAURANTS.unshift(normalized);
    if (ACTIVE_RESTAURANTS.length > INDEX_CACHE_MAX) {
      ACTIVE_RESTAURANTS.length = INDEX_CACHE_MAX;
    }
  } else {
    const prev = ACTIVE_RESTAURANTS[idx];
    if ((!normalized.menu || normalized.menu.length === 0) && prev.menu && prev.menu.length > 0) {
      normalized.menu = prev.menu;
    }
    ACTIVE_RESTAURANTS[idx] = { ...prev, ...normalized };
  }
  persistIndex();
  return ACTIVE_RESTAURANTS.find(r => String(r.id) === normalized.id) || normalized;
}

function getRestaurantById(id) {
  const base = ACTIVE_RESTAURANTS.find(r => String(r.id) === String(id));
  return hydrateRestaurantFromCaches(base);
}

async function loadPricingConfig() {
  try {
    const res = await fetch(`${_API_BASE}/api/config`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const json = await res.json();
    if (typeof json.markupRate === 'number' && json.markupRate >= 0) {
      MARKUP_RATE = json.markupRate;
    }
    if (typeof json.minShipperEarning === 'number' && json.minShipperEarning > 0) {
      MIN_SHIPPER_EARNING = json.minShipperEarning;
    }
  } catch (e) {}
}

// Warm pricing config in background
loadPricingConfig();

/* --------------------------------------------------------------------------
   State Management (localStorage-backed)
   -------------------------------------------------------------------------- */
const STATE_KEY = 'shipfee_state';

function getState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    return raw ? JSON.parse(raw) : getDefaultState();
  } catch { return getDefaultState(); }
}

function getDefaultState() {
  return {
    cart: { restaurantId: null, items: {}, itemNotes: {} },
    activeOrder: null,
    deliveryAddress: '',
    deliveryName: '',
    deliveryPhone: '',
    ordererPhone: '',
    isRelative: false,
    userLat: 10.0345,
    userLon: 105.7876
  };
}

function saveState(state) {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch {}
}

/* Cart helpers */
function getCart() { return getState().cart; }

function getCartTotal() {
  const cart = getCart();
  const restaurant = getRestaurantById(cart.restaurantId);
  if (!restaurant || !Array.isArray(restaurant.menu)) {
    return { storeTotal: 0, appTotal: 0, shipperEarning: 0, itemCount: 0, discountValue: 0, minServiceFee: 0 };
  }

  let storeTotal = 0, appTotalRaw = 0, itemCount = 0;
  Object.entries(cart.items).forEach(([cartKey, qty]) => {
    const [itemId, optionsStr] = cartKey.split('::');
    const item = restaurant.menu.find(m => m.id === itemId);
    if (item && qty > 0) {
      let toppingsInStore = 0;
      let toppingsApp = 0;
      if (optionsStr) {
        try {
          const selected = JSON.parse(optionsStr);
          selected.forEach(opt => {
            toppingsInStore += opt.price;
            toppingsApp += calcToppingAppPrice(opt.price);
          });
        } catch (e) {}
      }
      storeTotal += (item.inStorePrice + toppingsInStore) * qty;
      appTotalRaw += (item.appPrice + toppingsApp) * qty;
      itemCount  += qty;
    }
  });

  const surchargePerItem = restaurant.distanceSurchargePerItem || 0;
  const shipperEarningBeforeDiscount = appTotalRaw - storeTotal;

  // Calculate dynamic multi-item discount:
  let discountValue = 0;
  
  const itemsList = [];
  Object.entries(cart.items).forEach(([cartKey, qty]) => {
    if (qty <= 0) return;
    const [itemId, optionsStr] = cartKey.split('::');
    const item = restaurant.menu.find(m => m.id === itemId);
    if (item) {
      let toppingsInStore = 0;
      let toppingsApp = 0;
      if (optionsStr) {
        try {
          const selected = JSON.parse(optionsStr);
          selected.forEach(opt => {
            toppingsInStore += opt.price;
            toppingsApp += calcToppingAppPrice(opt.price);
          });
        } catch (e) {}
      }
      for (let i = 0; i < qty; i++) {
        itemsList.push({
          cartKey,
          inStorePrice: item.inStorePrice + toppingsInStore,
          appPrice: item.appPrice + toppingsApp
        });
      }
    }
  });

  if (itemsList.length > 1) {
    // Sort items by appPrice descending so the most expensive item is the primary item
    itemsList.sort((a, b) => b.appPrice - a.appPrice);
    
    const surchargeDiscount = round100(surchargePerItem * 0.30);
    
    itemsList.slice(1).forEach(item => {
      // Refund the actual markup for items from the 2nd onwards
      const markupDiscount = Math.max(0, item.appPrice - surchargePerItem - item.inStorePrice);
      discountValue += (markupDiscount + surchargeDiscount);
    });
  }

  let minServiceFee = 0;
  let appTotal = appTotalRaw;

  // Cân đối giảm giá đa món và phí hỗ trợ shipper đơn nhỏ
  if (itemCount > 0) {
    if (shipperEarningBeforeDiscount >= MIN_SHIPPER_EARNING) {
      minServiceFee = 0;
      discountValue = Math.min(discountValue, shipperEarningBeforeDiscount - MIN_SHIPPER_EARNING);
      appTotal = Math.max(0, appTotalRaw - discountValue);
    } else {
      discountValue = 0;
      minServiceFee = round100(MIN_SHIPPER_EARNING - shipperEarningBeforeDiscount);
      appTotal = appTotalRaw + minServiceFee;
    }
  }

  const shipperEarning = appTotal - storeTotal;

  return { storeTotal, appTotal, shipperEarning, itemCount, discountValue, minServiceFee };
}

function addToCart(restaurantId, itemId, selectedOptions) {
  const state = getState();
  if (state.cart.restaurantId && state.cart.restaurantId !== restaurantId) {
    // Different restaurant — clear old cart
    state.cart = { restaurantId, items: {} };
  }
  state.cart.restaurantId = restaurantId;
  
  const optionsKey = selectedOptions && selectedOptions.length > 0
    ? `::${JSON.stringify(selectedOptions)}`
    : '';
  const cartKey = `${itemId}${optionsKey}`;

  state.cart.items[cartKey] = (state.cart.items[cartKey] || 0) + 1;
  saveState(state);
}

function removeFromCart(itemId, selectedOptions) {
  const state = getState();
  const optionsKey = selectedOptions && selectedOptions.length > 0
    ? `::${JSON.stringify(selectedOptions)}`
    : '';
  const targetKey = `${itemId}${optionsKey}`;

  if (state.cart.items[targetKey]) {
    if (state.cart.items[targetKey] > 1) {
      state.cart.items[targetKey]--;
    } else {
      delete state.cart.items[targetKey];
    }
  } else {
    const matchingKeys = Object.keys(state.cart.items).filter(k => k === itemId || k.startsWith(itemId + '::'));
    if (matchingKeys.length > 0) {
      const lastKey = matchingKeys[matchingKeys.length - 1];
      if (state.cart.items[lastKey] > 1) {
        state.cart.items[lastKey]--;
      } else {
        delete state.cart.items[lastKey];
      }
    }
  }

  const hasItems = Object.keys(state.cart.items).length > 0;
  if (!hasItems) {
    state.cart.restaurantId = null;
    state.cart.itemNotes = {};
  } else {
    // Dọn dẹp ghi chú của các món không còn trong items
    state.cart.itemNotes = state.cart.itemNotes || {};
    Object.keys(state.cart.itemNotes).forEach(k => {
      if (!state.cart.items[k]) delete state.cart.itemNotes[k];
    });
  }
  saveState(state);
}

function clearCart() {
  const state = getState();
  state.cart = { restaurantId: null, items: {}, itemNotes: {} };
  saveState(state);
}

function removeItemFromCart(itemId) {
  const state = getState();
  delete state.cart.items[itemId];
  const keys = Object.keys(state.cart.items).filter(k => k === itemId || k.startsWith(itemId + '::'));
  keys.forEach(k => {
    delete state.cart.items[k];
    if (state.cart.itemNotes) delete state.cart.itemNotes[k];
  });

  const hasItems = Object.keys(state.cart.items).length > 0;
  if (!hasItems) {
    state.cart.restaurantId = null;
    state.cart.itemNotes = {};
  }
  saveState(state);
}

function updateCartItemNote(cartKey, note) {
  const state = getState();
  state.cart.itemNotes = state.cart.itemNotes || {};
  state.cart.itemNotes[cartKey] = note;
  saveState(state);
}

async function placeOrder(address, name, phone, ordererPhone, pinnedLat, pinnedLon, isRelative, note, promoCode) {
  const state = getState();
  const cart   = state.cart;
  const totals = getCartTotal();
  const restaurant = getRestaurantById(cart.restaurantId);
  if (!restaurant) {
    throw new Error('Không tìm thấy quán trong giỏ hàng. Vui lòng thử lại.');
  }

  const orderId = 'SPF-' + Math.floor(100000 + Math.random() * 900000);

  const items = [];
  Object.entries(cart.items).forEach(([cartKey, qty]) => {
    const [itemId, optionsStr] = cartKey.split('::');
    const item = (restaurant.menu || []).find(m => m.id === itemId);
    if (item && qty > 0) {
      let toppingsInStore = 0;
      let toppingsApp = 0;
      let selectedOptions = [];
      if (optionsStr) {
        try {
          selectedOptions = JSON.parse(optionsStr);
          selectedOptions.forEach(opt => {
            toppingsInStore += opt.price;
            toppingsApp += calcToppingAppPrice(opt.price);
          });
        } catch (e) {}
      }

      items.push({
        ...item,
        id: cartKey, // Sử dụng cartKey để làm ID dòng sản phẩm duy nhất
        realItemId: itemId,
        inStorePrice: item.inStorePrice + toppingsInStore,
        appPrice: item.appPrice + toppingsApp,
        selectedOptions,
        qty,
        note: (cart.itemNotes && cart.itemNotes[cartKey]) || ''
      });
    }
  });

  if (items.length === 0) {
    throw new Error('Giỏ hàng trống hoặc món không còn hợp lệ.');
  }

  const orderPayload = {
    id: orderId,
    restaurantId: cart.restaurantId,
    restaurantName: restaurant.name,
    restaurantAddress: restaurant.address || '',
    restaurantLat: (typeof restaurant.latitude === 'number' ? restaurant.latitude : null)
      ?? (typeof restaurant.lat === 'number' ? restaurant.lat : null),
    restaurantLon: (typeof restaurant.longitude === 'number' ? restaurant.longitude : null)
      ?? (typeof restaurant.lon === 'number' ? restaurant.lon : null),
    items,
    storeTotal: totals.storeTotal,
    appTotal: totals.appTotal,
    shipperEarning: totals.shipperEarning,
    discountValue: totals.discountValue || 0,
    minServiceFee: totals.minServiceFee || 0,
    deliveryAddress: address,
    deliveryName: name,
    deliveryPhone: phone,
    ordererPhone: ordererPhone || '',
    pinnedLat: pinnedLat || state.userLat || 10.0345,
    pinnedLon: pinnedLon || state.userLon || 105.7876,
    isRelative: isRelative || false,
    note: note || '',
    promoCode: promoCode || null,
    createdAt: Date.now()
  };

  const response = await fetch(`${_API_BASE}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(orderPayload)
  });
  let result;
  try {
    result = await response.json();
  } catch (e) {
    throw new Error('Máy chủ phản hồi không hợp lệ. Vui lòng thử lại.');
  }
  if (!response.ok || !result.success) {
    throw new Error(result.error || 'Lỗi lưu đơn hàng lên server');
  }
  
  const savedOrder = result.data;
  savedOrder.statusTime = Date.now();
  savedOrder.statusHistory = [{ status: 'PENDING', time: Date.now() }];
  
  state.activeOrder = savedOrder;
  state.cart = { restaurantId: null, items: {}, itemNotes: {} };
  saveState(state);
  
  return savedOrder;
}

async function rateOrder(orderId, rating, comment) {
  try {
    const response = await fetch(`${_API_BASE}/api/orders/${orderId}/rate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ rating, comment })
    });
    const result = await response.json();
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Lỗi gửi đánh giá lên server');
    }
    
    const state = getState();
    if (state.activeOrder && state.activeOrder.id === orderId) {
      state.activeOrder.rating = rating;
      state.activeOrder.comment = comment;
      saveState(state);
    }
    return result.data;
  } catch (error) {
    console.error('[App] Error rating order, falling back to local:', error);
    const state = getState();
    if (state.activeOrder && state.activeOrder.id === orderId) {
      state.activeOrder.rating = rating;
      state.activeOrder.comment = comment;
      saveState(state);
    }
    return null;
  }
}

function getActiveOrder() { return getState().activeOrder; }

/** Đơn còn đang chạy (không phải đã giao / đã hủy). */
function isOrderInProgress(orderOrStatus) {
  const status = typeof orderOrStatus === 'string'
    ? orderOrStatus
    : (orderOrStatus && orderOrStatus.status);
  if (!status) return false;
  return status !== 'DELIVERED' && status !== 'CANCELLED';
}

/** Xóa activeOrder khỏi local state (giao xong / hủy / 404). */
function clearActiveOrder() {
  const state = getState();
  if (!state.activeOrder) return;
  state.activeOrder = null;
  saveState(state);
}

function completeOrder() {
  clearActiveOrder();
}

/* --------------------------------------------------------------------------
   Navigation & Routing
   -------------------------------------------------------------------------- */
function navigate(page, params = {}) {
  const searchStr = new URLSearchParams(params).toString();
  window.location.href = page + (searchStr ? '?' + searchStr : '');
}

function getParam(key) {
  return new URLSearchParams(window.location.search).get(key);
}

/* --------------------------------------------------------------------------
   Utility Functions
   -------------------------------------------------------------------------- */
function formatCurrency(amount) {
  if (typeof amount !== 'number') return '0đ';
  return amount.toLocaleString('vi-VN') + 'đ';
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2, '0') + ':' +
         d.getMinutes().toString().padStart(2, '0');
}

function debounce(fn, delay) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

function throttle(fn, wait) {
  let last = 0;
  let pending = null;
  return (...args) => {
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      last = now;
      if (pending) {
        cancelAnimationFrame(pending);
        pending = null;
      }
      fn(...args);
    } else if (!pending) {
      pending = requestAnimationFrame(() => {
        pending = null;
        last = Date.now();
        fn(...args);
      });
    }
  };
}

/* --------------------------------------------------------------------------
   Geolocation — desktop Wi‑Fi + iOS Safari–safe accurate location
   -------------------------------------------------------------------------- */
function isAppleMobile() {
  const ua = navigator.userAgent || '';
  const iOS = /iPad|iPhone|iPod/.test(ua);
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return iOS || iPadOS;
}

/** Desktop / laptop — no phone GPS chip; browsers use Wi‑Fi / IP. */
function isDesktopBrowser() {
  if (isAppleMobile()) return false;
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return false;
  // Touch Chromebook / tablet hybrids still benefit from network-first
  return true;
}

function geoGetOnce(options) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      const err = new Error('Geolocation unsupported');
      err.code = 0;
      reject(err);
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

/** Watch briefly to refine a coarse first fix (common on iOS Safari). */
function geoRefineWatch({ timeoutMs = 12000, targetAccuracy = 45 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      const err = new Error('Geolocation unsupported');
      err.code = 0;
      reject(err);
      return;
    }
    let best = null;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (!best || (pos.coords.accuracy || 9999) < (best.coords.accuracy || 9999)) {
          best = pos;
        }
        if ((pos.coords.accuracy || 9999) <= targetAccuracy) {
          navigator.geolocation.clearWatch(watchId);
          clearTimeout(timer);
          resolve(best);
        }
      },
      (err) => {
        navigator.geolocation.clearWatch(watchId);
        clearTimeout(timer);
        if (best) resolve(best);
        else reject(err);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs }
    );
    const timer = setTimeout(() => {
      navigator.geolocation.clearWatch(watchId);
      if (best) resolve(best);
      else {
        const err = new Error('Geolocation timeout');
        err.code = 3;
        reject(err);
      }
    }, timeoutMs);
  });
}

async function queryGeoPermissionState() {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return null;
    const status = await navigator.permissions.query({ name: 'geolocation' });
    return status && status.state ? status.state : null;
  } catch (_) {
    return null;
  }
}

let _geoInFlight = null;

/**
 * User location with desktop Wi‑Fi / iOS Safari fallbacks.
 * Must be called from a user gesture (button tap).
 *
 * Desktop notes:
 * - PCs rarely have GPS; enableHighAccuracy:true often fails or times out
 * - Prefer network/Wi‑Fi fix first; skip long GPS refine watches
 * - Chrome may report PERMISSION_DENIED if OS Location Services are off
 */
async function getUserLocation({ onProgress } = {}) {
  // Coalesce concurrent calls (double-clicks / stacked handlers)
  if (_geoInFlight) return _geoInFlight;

  _geoInFlight = (async () => {
    const apple = isAppleMobile();
    const desktop = isDesktopBrowser();
    const progress = (msg) => {
      if (typeof onProgress === 'function') onProgress(msg);
    };

    if (!navigator.geolocation) {
      const err = new Error('unsupported');
      err.code = 0;
      throw err;
    }

    if (!window.isSecureContext && location.hostname !== 'localhost') {
      const err = new Error('insecure');
      err.code = 0;
      err.insecure = true;
      throw err;
    }

    const perm = await queryGeoPermissionState();
    if (perm === 'denied') {
      const err = new Error('permission denied');
      err.code = 1;
      err.permissionPermanentlyDenied = true;
      err.desktopHint = desktop;
      err.iosHint = apple;
      throw err;
    }

    // Desktop / Apple: network-first. Desktop has no GPS chip.
    const highOpts = {
      enableHighAccuracy: true,
      maximumAge: desktop ? 30_000 : 0,
      timeout: apple ? 28000 : (desktop ? 12000 : 18000)
    };
    const lowOpts = {
      enableHighAccuracy: false,
      maximumAge: desktop ? 120_000 : 60_000,
      timeout: apple ? 18000 : (desktop ? 20000 : 12000)
    };

    let position = null;
    let coarse = false;

    if (desktop || apple) {
      progress(desktop
        ? 'Đang lấy vị trí qua Wi‑Fi / mạng (máy tính)...'
        : 'Đang lấy vị trí nhanh (mạng)...');
      try {
        position = await geoGetOnce({
          enableHighAccuracy: false,
          maximumAge: desktop ? 120_000 : 30_000,
          timeout: desktop ? 20000 : 12000
        });
        coarse = (position.coords.accuracy || 9999) > 80;
      } catch (netErr) {
        // Permission denied / unavailable — don't keep retrying the same denial
        if (netErr && netErr.code === 1) {
          netErr.desktopHint = desktop;
          netErr.iosHint = apple;
          throw netErr;
        }
        // continue to high-accuracy attempt
      }
    }

    // On desktop, a usable network fix is enough — skip GPS-style retries.
    if (!(desktop && position)) {
      try {
        progress(apple
          ? 'Đang lấy GPS chính xác (iPhone có thể mất 10–25 giây)...'
          : desktop
            ? 'Đang thử định vị chính xác hơn...'
            : 'Đang lấy GPS độ chính xác cao...');
        const highPos = await geoGetOnce(highOpts);
        if (!position || (highPos.coords.accuracy || 9999) <= (position.coords.accuracy || 9999)) {
          position = highPos;
          coarse = (highPos.coords.accuracy || 9999) > 100;
        }
      } catch (highErr) {
        if (!position) {
          progress(desktop
            ? 'Thử lại định vị mạng / Wi‑Fi...'
            : 'GPS chậm — thử định vị mạng / Wi‑Fi...');
          try {
            position = await geoGetOnce(lowOpts);
            coarse = true;
          } catch (lowErr) {
            const err = lowErr || highErr;
            err.iosHint = apple;
            err.desktopHint = desktop;
            throw err;
          }
        }
      }
    }

    const accuracy = position.coords.accuracy || 9999;
    // Refine only on phones — desktop Wi‑Fi accuracy won't improve via GPS watch
    if (!desktop && accuracy > 80) {
      progress('Đang tinh chỉnh vị trí chính xác hơn...');
      try {
        const refined = await geoRefineWatch({
          timeoutMs: apple ? 18000 : 10000,
          targetAccuracy: 40
        });
        if ((refined.coords.accuracy || 9999) <= accuracy) {
          position = refined;
        }
        coarse = (position.coords.accuracy || 9999) > 100;
      } catch (_) {
        // keep best fix so far
      }
    }

    return {
      lat: position.coords.latitude,
      lon: position.coords.longitude,
      accuracy: position.coords.accuracy || null,
      coarse,
      apple,
      desktop,
      timestamp: position.timestamp
    };
  })();

  try {
    return await _geoInFlight;
  } finally {
    _geoInFlight = null;
  }
}

function formatGeoError(error) {
  const apple = isAppleMobile() || error?.iosHint;
  const desktop = isDesktopBrowser() || error?.desktopHint;
  if (error?.insecure) {
    return {
      title: 'Cần mở bằng HTTPS',
      message: 'Trình duyệt chỉ cho phép định vị trên trang bảo mật (https). Hãy mở lại app qua link chính thức.'
    };
  }
  if (!error || error.code === 0) {
    return {
      title: 'Không hỗ trợ GPS',
      message: 'Trình duyệt không hỗ trợ định vị. Hãy kéo ghim trên bản đồ để chọn điểm giao.'
    };
  }
  if (error.code === 1) {
    return {
      title: 'Chưa cấp quyền vị trí',
      message: apple
        ? 'Trên iPhone: Cài đặt → Safari → Vị trí → Cho phép, hoặc chạm aA trên thanh địa chỉ → Website Settings → Location → Allow. Sau đó nhấn lại nút GPS.'
        : desktop
          ? 'Trên máy tính: bấm ổ khóa cạnh thanh địa chỉ → Quyền / Site settings → Vị trí → Cho phép. Đồng thời bật Dịch vụ vị trí trong Windows/macOS. Hoặc kéo ghim trên bản đồ.'
          : 'Hãy cho phép quyền vị trí trong trình duyệt, rồi nhấn lại nút GPS. Hoặc kéo ghim trên bản đồ.'
    };
  }
  if (error.code === 2) {
    return {
      title: 'Không đọc được vị trí',
      message: apple
        ? 'Bật Dịch vụ định vị (Cài đặt → Quyền riêng tư → Dịch vụ định vị) và thử lại ngoài trời, hoặc ghim tay trên bản đồ.'
        : desktop
          ? 'Máy tính chưa lấy được vị trí (Wi‑Fi/IP). Bật Location Services của hệ điều hành, kết nối Wi‑Fi, rồi thử lại — hoặc kéo ghim trên bản đồ.'
          : 'Không lấy được tín hiệu GPS. Thử lại hoặc ghim tay trên bản đồ.'
    };
  }
  if (error.code === 3) {
    return {
      title: 'Định vị quá chậm',
      message: desktop
        ? 'Trình duyệt mất quá lâu để định vị. Hãy kéo ghim trên bản đồ để chọn điểm giao hàng.'
        : 'Máy mất quá lâu để định vị. Ra chỗ thoáng hoặc kéo ghim trên bản đồ để chọn vị trí giao hàng.'
    };
  }
  return {
    title: 'Lỗi định vị',
    message: 'Không thể lấy vị trí. Vui lòng kéo ghim trên bản đồ.'
  };
}

/* --------------------------------------------------------------------------
   Toast Notification System
   -------------------------------------------------------------------------- */
let toastContainer;

function initToasts() {
  toastContainer = document.getElementById('toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }
}

let _lastToastKey = '';
let _lastToastAt = 0;

function showToast(title, message = '', type = 'info', duration = 4000) {
  initToasts();
  // Avoid stacking identical error toasts (e.g. repeated GPS permission denials)
  const dedupeKey = `${type}|${title}|${message}`;
  const now = Date.now();
  if (dedupeKey === _lastToastKey && now - _lastToastAt < 5000) {
    return null;
  }
  _lastToastKey = dedupeKey;
  _lastToastAt = now;

  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.innerHTML = `
    <span class="toast__icon">${icons[type] || icons.info}</span>
    <div class="toast__text">
      ${title ? `<div class="toast__title">${escapeHtml(title)}</div>` : ''}
      ${message ? `<div style="font-size:12px;opacity:0.8;">${escapeHtml(message)}</div>` : ''}
    </div>
    <button class="toast__close" onclick="this.parentElement.remove()">✕</button>
  `;
  toastContainer.appendChild(toast);
  if (duration > 0) setTimeout(() => toast.remove(), duration);
  return toast;
}

/* --------------------------------------------------------------------------
   Nav Scroll Effect
   -------------------------------------------------------------------------- */
function initNavScroll() {
  const nav = document.querySelector('.nav');
  if (!nav) return;
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 10);
  window.addEventListener('scroll', throttle(onScroll, 100), { passive: true });
  onScroll();
}

/* --------------------------------------------------------------------------
   Cart Bar visibility
   -------------------------------------------------------------------------- */
function updateCartBar() {
  const cartBar = document.getElementById('cart-bar');
  if (!cartBar) return;
  const { itemCount, storeTotal, appTotal, shipperEarning } = getCartTotal();

  const elCount    = document.getElementById('cart-bar-count');
  const elStore    = document.getElementById('cart-bar-store');
  const elShipper  = document.getElementById('cart-bar-shipper');
  const elTotal    = document.getElementById('cart-bar-total');
  const elBtnLabel = document.getElementById('cart-bar-btn-label');
  const elNudge    = document.getElementById('cart-bar-nudge');

  if (elCount)    elCount.textContent    = itemCount;
  if (elStore)    elStore.textContent    = formatCurrency(storeTotal);
  if (elShipper)  elShipper.textContent  = '+' + formatCurrency(shipperEarning);
  if (elTotal)    elTotal.textContent    = formatCurrency(appTotal);
  if (elBtnLabel) elBtnLabel.textContent = formatCurrency(appTotal);

  if (elNudge) {
    if (itemCount === 1) {
      elNudge.style.display = 'flex';
    } else {
      elNudge.style.display = 'none';
    }
  }

  if (itemCount > 0) {
    cartBar.classList.add('visible');
  } else {
    cartBar.classList.remove('visible');
  }
}

/* --------------------------------------------------------------------------
   Leaflet — on-demand loader (shared across customer pages)
   -------------------------------------------------------------------------- */
let _leafletLoadPromise = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (_leafletLoadPromise) return _leafletLoadPromise;
  _leafletLoadPromise = new Promise((resolve, reject) => {
    const cssId = 'leaflet-css-deferred';
    if (!document.getElementById(cssId)) {
      const css = document.createElement('link');
      css.id = cssId;
      css.rel = 'stylesheet';
      css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(css);
    }
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    s.async = true;
    s.onload = () => resolve(window.L);
    s.onerror = () => reject(new Error('Không tải được bản đồ'));
    document.head.appendChild(s);
  });
  return _leafletLoadPromise;
}

/* --------------------------------------------------------------------------
   Modal body scroll lock (iOS Safari overscroll)
   -------------------------------------------------------------------------- */
let _modalScrollY = 0;
function lockBodyScroll() {
  _modalScrollY = window.scrollY || window.pageYOffset || 0;
  document.body.classList.add('modal-open');
  document.body.style.position = 'fixed';
  document.body.style.top = `-${_modalScrollY}px`;
  document.body.style.left = '0';
  document.body.style.right = '0';
  document.body.style.width = '100%';
}
function unlockBodyScroll() {
  if (!document.body.classList.contains('modal-open')) return;
  document.body.classList.remove('modal-open');
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.left = '';
  document.body.style.right = '';
  document.body.style.width = '';
  window.scrollTo(0, _modalScrollY);
}

/* --------------------------------------------------------------------------
   Expose to global scope (called from HTML onclick attributes)
   -------------------------------------------------------------------------- */
window.SF = {
  API_BASE: _API_BASE,
  get RESTAURANTS() { return ACTIVE_RESTAURANTS; },
  set RESTAURANTS(val) { setRestaurants(val); },
  setRestaurants,
  upsertRestaurant,
  getRestaurantById,
  get MARKUP_RATE() { return MARKUP_RATE; },
  calcToppingAppPrice,
  escapeHtml,
  debounce,
  throttle,
  isAppleMobile,
  isDesktopBrowser,
  getUserLocation,
  formatGeoError,
  loadLeaflet,
  lockBodyScroll,
  unlockBodyScroll,
  loadPricingConfig,
  getState, saveState, getCart, getCartTotal, updateCartItemNote,
  addToCart, removeFromCart, removeItemFromCart, clearCart,
  placeOrder, getActiveOrder, completeOrder, rateOrder,
  navigate, getParam,
  formatCurrency, formatTime,
  showToast, updateCartBar,
  initNavScroll,
  isOrderInProgress,
  clearActiveOrder
};

/* --------------------------------------------------------------------------
   Mobile Zoom Prevention (lightweight — avoid non-passive touch handlers
   that jank scroll on iOS Safari). Prefer CSS touch-action: manipulation.
   -------------------------------------------------------------------------- */
document.addEventListener('gesturestart', function (event) {
  event.preventDefault();
}, { passive: false });

/* --------------------------------------------------------------------------
   PWA — register service worker so Android can install SHIPFEE to home screen
   -------------------------------------------------------------------------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Bust SW URL so phones discard stale cached tracking/HTML builds
    const swUrl = new URL('sw.js?v=2026-07-18c', window.location.href).href;
    navigator.serviceWorker.register(swUrl).then((reg) => {
      try { reg.update(); } catch (_) {}
    }).catch(() => {});
  });
}
