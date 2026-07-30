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
const MENU_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes — aligned with server RAM menu bridge
const INDEX_CACHE_MAX = 200;

let MARKUP_RATE = 0.28;
let MIN_SHIPPER_EARNING = 15000;
let MULTI_ITEM_DISCOUNT = 0.15;
let FREE_DISTANCE_KM = 1.5;
let PLATFORM_FEE_SHARE = 0.6;
let SHIPPER_SURPLUS_SHARE = 0.7;
let WAIVE_PLATFORM_MIN_ITEMS = 3;
let WAIVE_PLATFORM_MIN_STORE = 79000;
let HALF_DELIVERY_MIN_ITEMS = 3;
let HALF_DELIVERY_MIN_STORE = 120000;

function round100(n) {
  return Math.round((Number(n) || 0) / 100) * 100;
}

/** Topping / menu lines use store price (fees are separate at checkout). */
function calcToppingAppPrice(price) {
  return Number(price) || 0;
}

function splitFeePool(feePool, platformShare) {
  const platformFee = round100(feePool * (platformShare || 0.6));
  return { platformFee, deliveryFee: Math.max(0, feePool - platformFee) };
}

function computeShipperEarning(feePool, minE, surplusShare) {
  const minShip = minE || 15000;
  if (feePool <= minShip) return Math.max(0, feePool);
  return minShip + round100((feePool - minShip) * (surplusShare || 0.7));
}

function buildFeeWaiverHint(storeTotal, itemCount, feePool, platformFee, deliveryFee, platformWaived, deliveryHalfApplied, surchargePerItem) {
  const surcharge = Number(surchargePerItem) || 0;

  function estimateWaiveSave(targetStore, targetItems, kind) {
    const simStore = Math.max(storeTotal, targetStore);
    const simItems = Math.max(itemCount, targetItems);
    let simFee = round100(simStore * MARKUP_RATE) + surcharge * simItems;
    if (simFee < MIN_SHIPPER_EARNING) simFee = MIN_SHIPPER_EARNING;
    const split = splitFeePool(simFee, PLATFORM_FEE_SHARE);
    if (kind === 'platform') {
      return Math.min(split.platformFee, Math.max(0, simFee - MIN_SHIPPER_EARNING));
    }
    return Math.min(round100(split.deliveryFee * 0.5), Math.max(0, simFee - MIN_SHIPPER_EARNING));
  }

  if (!platformWaived && storeTotal < WAIVE_PLATFORM_MIN_STORE && itemCount < WAIVE_PLATFORM_MIN_ITEMS) {
    const saveAmount = estimateWaiveSave(WAIVE_PLATFORM_MIN_STORE, WAIVE_PLATFORM_MIN_ITEMS, 'platform');
    if (saveAmount > 0) {
      return {
        target: 'platform',
        amountShort: Math.max(0, WAIVE_PLATFORM_MIN_STORE - storeTotal),
        itemsShort: Math.max(0, WAIVE_PLATFORM_MIN_ITEMS - itemCount),
        currentFee: platformFee,
        saveAmount,
        thresholdStoreTotal: WAIVE_PLATFORM_MIN_STORE,
        thresholdItems: WAIVE_PLATFORM_MIN_ITEMS
      };
    }
  }
  if (!deliveryHalfApplied && storeTotal < HALF_DELIVERY_MIN_STORE && itemCount < HALF_DELIVERY_MIN_ITEMS) {
    const saveAmount = estimateWaiveSave(HALF_DELIVERY_MIN_STORE, HALF_DELIVERY_MIN_ITEMS, 'delivery');
    if (saveAmount > 0) {
      return {
        target: 'delivery',
        amountShort: Math.max(0, HALF_DELIVERY_MIN_STORE - storeTotal),
        itemsShort: Math.max(0, HALF_DELIVERY_MIN_ITEMS - itemCount),
        currentFee: deliveryFee,
        saveAmount,
        thresholdStoreTotal: HALF_DELIVERY_MIN_STORE,
        thresholdItems: HALF_DELIVERY_MIN_ITEMS
      };
    }
  }
  return null;
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
    appPrice: typeof m.appPrice === 'number' ? m.appPrice : (typeof m.inStorePrice === 'number' ? m.inStorePrice : 30000),
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

/**
 * Checkout / place-order: đảm bảo có menu quán (fetch API nếu cache hết hoặc thiếu).
 */
async function ensureCartRestaurant(restaurantId, opts = {}) {
  const id = restaurantId != null ? String(restaurantId) : '';
  if (!id) return null;

  let local = getRestaurantById(id);
  const needFetch = !local
    || !Array.isArray(local.menu)
    || local.menu.length === 0
    || opts.force === true;

  if (!needFetch) return local;

  try {
    const state = getState();
    const lat = Number(state.userLat);
    const lon = Number(state.userLon);
    const qs = (Number.isFinite(lat) && Number.isFinite(lon))
      ? `?lat=${lat}&lon=${lon}`
      : '';
    const res = await fetch(`${_API_BASE}/api/restaurants/${encodeURIComponent(id)}${qs}`, {
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) return local;
    const json = await res.json();
    const data = json && (json.data || json.restaurant || json);
    if (!data || !data.id) return local;
    return upsertRestaurant(data) || getRestaurantById(id) || local;
  } catch (e) {
    console.warn('[ensureCartRestaurant]', e.message || e);
    return local;
  }
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
    if (typeof json.multiItemDiscount === 'number' && json.multiItemDiscount >= 0) {
      MULTI_ITEM_DISCOUNT = json.multiItemDiscount;
    }
    if (typeof json.freeDistanceKm === 'number' && json.freeDistanceKm >= 0) {
      FREE_DISTANCE_KM = json.freeDistanceKm;
    }
    if (typeof json.platformFeeShare === 'number') PLATFORM_FEE_SHARE = json.platformFeeShare;
    if (typeof json.shipperSurplusShare === 'number') SHIPPER_SURPLUS_SHARE = json.shipperSurplusShare;
    if (typeof json.waivePlatformMinItems === 'number') WAIVE_PLATFORM_MIN_ITEMS = json.waivePlatformMinItems;
    if (typeof json.waivePlatformMinStoreTotal === 'number') WAIVE_PLATFORM_MIN_STORE = json.waivePlatformMinStoreTotal;
    if (typeof json.halfDeliveryMinItems === 'number') HALF_DELIVERY_MIN_ITEMS = json.halfDeliveryMinItems;
    if (typeof json.halfDeliveryMinStoreTotal === 'number') HALF_DELIVERY_MIN_STORE = json.halfDeliveryMinStoreTotal;
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
    const state = raw ? JSON.parse(raw) : getDefaultState();
    return normalizeState(state);
  } catch { return getDefaultState(); }
}

function getDefaultState() {
  return {
    cart: { restaurantId: null, items: {}, itemNotes: {} },
    activeOrder: null,
    orderHistory: [],
    favorites: [],
    savedAddresses: [],
    customerToken: '',
    customerProfile: null,
    theme: 'system',
    paymentMethod: 'COD',
    pushPromptedAt: 0,
    deliveryAddress: '',
    deliveryName: '',
    deliveryPhone: '',
    ordererPhone: '',
    isRelative: false,
    userLat: 10.0345,
    userLon: 105.7876
  };
}

function normalizeState(state) {
  if (!state || typeof state !== 'object') return getDefaultState();
  if (!state.cart || typeof state.cart !== 'object') {
    state.cart = { restaurantId: null, items: {}, itemNotes: {} };
  }
  if (!Array.isArray(state.orderHistory)) state.orderHistory = [];
  if (!Array.isArray(state.favorites)) state.favorites = [];
  if (!Array.isArray(state.savedAddresses)) state.savedAddresses = [];
  if (!state.customerToken) state.customerToken = '';
  if (!state.theme) state.theme = 'system';
  if (!state.paymentMethod) state.paymentMethod = 'COD';
  return state;
}

function saveState(state) {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(normalizeState(state))); } catch {}
}

const ORDER_HISTORY_MAX = 50;
const FAVORITES_MAX = 40;

function getCustomerPhone() {
  const s = getState();
  const fromProfile = s.customerProfile && s.customerProfile.phone;
  const phone = String(fromProfile || s.ordererPhone || s.deliveryPhone || '').trim();
  return /^0[35789]\d{8}$/.test(phone) ? phone : '';
}

function customerAuthHeaders(extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  const token = getState().customerToken;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers['X-Customer-Token'] = token;
  }
  const phone = getCustomerPhone();
  if (phone) headers['X-Delivery-Phone'] = phone;
  return headers;
}

function isCustomerLoggedIn() {
  return !!(getState().customerToken && getCustomerPhone());
}

async function requestCustomerOtp(phone) {
  const res = await fetch(`${_API_BASE}/api/customer/otp/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone })
  });
  const result = await res.json();
  if (!res.ok || !result.success) throw new Error(result.error || 'Không gửi được OTP');
  return result.data;
}

async function verifyCustomerOtp(phone, code, name) {
  const res = await fetch(`${_API_BASE}/api/customer/otp/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code, name: name || '' })
  });
  const result = await res.json();
  if (!res.ok || !result.success) throw new Error(result.error || 'OTP không hợp lệ');
  const state = getState();
  state.customerToken = result.data.token;
  state.customerProfile = result.data.profile;
  if (result.data.profile?.phone) {
    if (!state.deliveryPhone) state.deliveryPhone = result.data.profile.phone;
    if (!state.ordererPhone) state.ordererPhone = result.data.profile.phone;
  }
  if (result.data.profile?.name && !state.deliveryName) {
    state.deliveryName = result.data.profile.name;
  }
  if (Array.isArray(result.data.profile?.favorites) && result.data.profile.favorites.length) {
    const map = new Map();
    [...result.data.profile.favorites, ...state.favorites].forEach((f) => {
      if (f && f.id != null) map.set(String(f.id), f);
    });
    state.favorites = Array.from(map.values()).slice(0, FAVORITES_MAX);
  }
  if (Array.isArray(result.data.profile?.addresses)) {
    state.savedAddresses = result.data.profile.addresses;
  }
  if (result.data.profile?.theme) state.theme = result.data.profile.theme;
  saveState(state);
  applyTheme(state.theme);
  return result.data;
}

function logoutCustomer() {
  const state = getState();
  state.customerToken = '';
  state.customerProfile = null;
  saveState(state);
}

async function syncCustomerProfile(patch) {
  if (!isCustomerLoggedIn()) return null;
  const res = await fetch(`${_API_BASE}/api/customer/me`, {
    method: 'PUT',
    headers: customerAuthHeaders(),
    body: JSON.stringify(patch || {})
  });
  const result = await res.json();
  if (!res.ok || !result.success) throw new Error(result.error || 'Không lưu được hồ sơ');
  const state = getState();
  state.customerProfile = result.data;
  if (Array.isArray(result.data.addresses)) state.savedAddresses = result.data.addresses;
  if (Array.isArray(result.data.favorites)) state.favorites = result.data.favorites;
  if (result.data.theme) state.theme = result.data.theme;
  saveState(state);
  return result.data;
}

async function syncFavoritesToServer() {
  if (!isCustomerLoggedIn()) return;
  try {
    await syncCustomerProfile({ favorites: getFavorites() });
  } catch (e) {
    console.warn('[App] sync favorites failed', e);
  }
}

function getSavedAddresses() {
  const state = getState();
  if (Array.isArray(state.savedAddresses) && state.savedAddresses.length) return state.savedAddresses;
  return (state.customerProfile && state.customerProfile.addresses) || [];
}

function saveAddressLocal(addr) {
  const state = getState();
  const list = Array.isArray(state.savedAddresses) ? state.savedAddresses.slice() : [];
  const row = {
    id: addr.id || `addr-${Date.now()}`,
    label: addr.label || 'Địa chỉ',
    address: addr.address || '',
    name: addr.name || state.deliveryName || '',
    phone: addr.phone || state.deliveryPhone || '',
    lat: addr.lat ?? state.userLat,
    lon: addr.lon ?? state.userLon,
    isDefault: !!addr.isDefault
  };
  const idx = list.findIndex((a) => a.id === row.id);
  if (idx >= 0) list[idx] = row;
  else list.unshift(row);
  if (row.isDefault) list.forEach((a) => { a.isDefault = a.id === row.id; });
  state.savedAddresses = list.slice(0, 8);
  saveState(state);
  if (isCustomerLoggedIn()) {
    syncCustomerProfile({ addresses: state.savedAddresses }).catch(() => {});
  }
  return state.savedAddresses;
}

function applySavedAddress(addr) {
  if (!addr) return;
  const state = getState();
  state.deliveryAddress = addr.address || state.deliveryAddress;
  state.deliveryName = addr.name || state.deliveryName;
  state.deliveryPhone = addr.phone || state.deliveryPhone;
  if (Number.isFinite(Number(addr.lat))) state.userLat = Number(addr.lat);
  if (Number.isFinite(Number(addr.lon))) state.userLon = Number(addr.lon);
  saveState(state);
}

function applyTheme(theme) {
  const mode = theme || getState().theme || 'system';
  const state = getState();
  state.theme = mode;
  saveState(state);
  const root = document.documentElement;
  let effective = mode;
  if (mode === 'system') {
    effective = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  root.setAttribute('data-theme', effective);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', effective === 'dark' ? '#0F172A' : '#EF4444');
}

function toggleTheme() {
  const cur = getState().theme || 'system';
  const next = cur === 'dark' ? 'light' : cur === 'light' ? 'system' : 'dark';
  applyTheme(next);
  if (isCustomerLoggedIn()) syncCustomerProfile({ theme: next }).catch(() => {});
  return next;
}

function estimateEtaMinutes(restaurant) {
  if (!restaurant || restaurant.isClosed) return null;
  const d = Number(restaurant.distanceValue);
  if (Number.isFinite(d)) return Math.max(18, Math.min(55, Math.round(12 + d * 3.5 + 5)));
  const timeStr = String(restaurant.time || '');
  const m = timeStr.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (m) return Math.round((Number(m[1]) + Number(m[2])) / 2);
  const single = timeStr.match(/(\d+)\s*phút/i);
  if (single) return Number(single[1]);
  return 25;
}

function formatEtaLabel(restaurant) {
  const eta = estimateEtaMinutes(restaurant);
  if (eta == null) return restaurant?.isClosed ? 'Đóng cửa' : (restaurant?.time || '—');
  return `~${eta} phút`;
}

async function fetchCustomerOffers() {
  const phone = getCustomerPhone();
  if (!phone) return [];
  try {
    const res = await fetch(
      `${_API_BASE}/api/customer/offers?phone=${encodeURIComponent(phone)}`,
      { headers: customerAuthHeaders() }
    );
    const result = await res.json();
    return result.success ? (result.data || []) : [];
  } catch {
    return [];
  }
}

async function fetchCustomerSuggestions() {
  const phone = getCustomerPhone();
  try {
    const url = phone
      ? `${_API_BASE}/api/customer/suggestions?phone=${encodeURIComponent(phone)}`
      : `${_API_BASE}/api/customer/suggestions`;
    const res = await fetch(url, { headers: customerAuthHeaders() });
    const result = await res.json();
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function fetchPaymentConfig() {
  try {
    const res = await fetch(`${_API_BASE}/api/config/payment`);
    const result = await res.json();
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function setPaymentMethod(method) {
  const state = getState();
  state.paymentMethod = method === 'BANK_TRANSFER' ? 'BANK_TRANSFER' : 'COD';
  saveState(state);
  return state.paymentMethod;
}

function getTrackingShareUrl(order) {
  const o = order || getActiveOrder();
  if (!o || !o.id) return '';
  const base = `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, '')}`;
  const params = new URLSearchParams({ orderId: o.id });
  if (o.trackingToken) params.set('token', o.trackingToken);
  return `${base}tracking.html?${params.toString()}`;
}

async function shareTrackingLink(order) {
  const url = getTrackingShareUrl(order);
  if (!url) throw new Error('Không có đơn để chia sẻ');
  const title = 'Theo dõi đơn ShipFee';
  const text = `Theo dõi đơn ${order?.id || ''} trên ShipFee`;
  if (navigator.share) {
    await navigator.share({ title, text, url });
    return 'shared';
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(url);
    return 'copied';
  }
  return url;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function enablePushNotifications() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    throw new Error('Trình duyệt không hỗ trợ thông báo');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Bạn đã từ chối thông báo');

  const reg = await navigator.serviceWorker.ready;
  let vapidPublic = '';
  try {
    const res = await fetch(`${_API_BASE}/api/customer/push/vapid-public-key`);
    const result = await res.json();
    vapidPublic = result?.data?.publicKey || '';
  } catch (_) {}

  if (vapidPublic && isCustomerLoggedIn()) {
    try {
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublic)
      });
      await fetch(`${_API_BASE}/api/customer/push/subscribe`, {
        method: 'POST',
        headers: customerAuthHeaders(),
        body: JSON.stringify({ subscription: sub.toJSON() })
      });
    } catch (e) {
      console.warn('[Push] subscribe failed, local notifications still ok', e);
    }
  }

  const state = getState();
  state.pushPromptedAt = Date.now();
  saveState(state);
  return true;
}

function notifyLocal(title, body, opts = {}) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const n = new Notification(title, {
      body,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-96.png',
      ...opts
    });
    n.onclick = () => {
      window.focus();
      if (opts.url) window.location.href = opts.url;
      n.close();
    };
  } catch (_) {}
}

// Apply theme ASAP for FOUC reduction
try { applyTheme(getState().theme); } catch (_) {}

function toHistoryEntry(order) {
  if (!order || !order.id) return null;
  return {
    id: order.id,
    trackingToken: order.trackingToken || null,
    restaurantId: order.restaurantId,
    restaurantName: order.restaurantName || 'Quán ăn',
    restaurantImg: order.restaurantImg || null,
    items: (order.items || []).map((i) => ({
      id: i.id || i.realItemId,
      name: i.name,
      quantity: i.quantity || i.qty || 1,
      price: i.appPrice != null ? i.appPrice : i.price,
      selectedOptions: Array.isArray(i.selectedOptions) ? i.selectedOptions : []
    })),
    appTotal: Number(order.appTotal) || 0,
    status: order.status || 'PENDING',
    createdAt: order.createdAt || Date.now(),
    deliveredAt: order.deliveredAt || null,
    rating: typeof order.rating === 'number' ? order.rating : null,
    deliveryAddress: order.deliveryAddress || '',
    deliveryPhone: order.deliveryPhone || '',
    ordererPhone: order.ordererPhone || ''
  };
}

function upsertOrderHistory(order) {
  const entry = toHistoryEntry(order);
  if (!entry) return;
  const state = getState();
  const idx = state.orderHistory.findIndex((o) => o && o.id === entry.id);
  if (idx >= 0) state.orderHistory[idx] = { ...state.orderHistory[idx], ...entry };
  else state.orderHistory.unshift(entry);
  state.orderHistory = state.orderHistory.slice(0, ORDER_HISTORY_MAX);
  saveState(state);
}

function getOrderHistory() {
  const state = getState();
  const map = new Map();
  (state.orderHistory || []).forEach((o) => {
    if (o && o.id) map.set(o.id, o);
  });
  if (state.activeOrder && state.activeOrder.id) {
    map.set(state.activeOrder.id, toHistoryEntry(state.activeOrder));
  }
  return Array.from(map.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function fetchOrderHistoryFromServer() {
  const phone = getCustomerPhone();
  const local = getOrderHistory();
  if (!phone) return local;
  try {
    const res = await fetch(
      `${_API_BASE}/api/customer/orders?phone=${encodeURIComponent(phone)}`,
      { headers: customerAuthHeaders() }
    );
    const result = await res.json();
    if (!res.ok || !result.success || !Array.isArray(result.data)) return local;

    const state = getState();
    const byId = new Map();
    (state.orderHistory || []).forEach((o) => {
      if (o && o.id) byId.set(o.id, o);
    });
    result.data.forEach((remote) => {
      const entry = toHistoryEntry(remote);
      if (!entry) return;
      const prev = byId.get(entry.id);
      byId.set(entry.id, prev ? { ...prev, ...entry } : entry);
    });
    state.orderHistory = Array.from(byId.values())
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, ORDER_HISTORY_MAX);
    saveState(state);
    return getOrderHistory();
  } catch (e) {
    console.warn('[App] fetchOrderHistoryFromServer failed:', e);
    return local;
  }
}

function getFavorites() {
  return getState().favorites || [];
}

function isFavorite(restaurantId) {
  if (restaurantId == null) return false;
  const id = String(restaurantId);
  return getFavorites().some((f) => String(f.id) === id);
}

function toggleFavorite(restaurant) {
  if (!restaurant || restaurant.id == null) return false;
  const state = getState();
  const id = String(restaurant.id);
  const idx = state.favorites.findIndex((f) => String(f.id) === id);
  if (idx >= 0) {
    state.favorites.splice(idx, 1);
    saveState(state);
    syncFavoritesToServer();
    return false;
  }
  state.favorites.unshift({
    id: restaurant.id,
    name: restaurant.name || 'Quán ăn',
    img: restaurant.img || '',
    rating: restaurant.rating || 0,
    reviews: restaurant.reviews || 0,
    tags: Array.isArray(restaurant.tags) ? restaurant.tags.slice(0, 3) : [],
    address: restaurant.address || '',
    distance: restaurant.distance || '',
    time: restaurant.time || '',
    savedAt: Date.now()
  });
  state.favorites = state.favorites.slice(0, FAVORITES_MAX);
  saveState(state);
  syncFavoritesToServer();
  return true;
}

function removeFavorite(restaurantId) {
  const state = getState();
  const id = String(restaurantId);
  state.favorites = (state.favorites || []).filter((f) => String(f.id) !== id);
  saveState(state);
  syncFavoritesToServer();
}

function reorderFromHistory(order) {
  if (!order || !order.restaurantId || !Array.isArray(order.items) || !order.items.length) {
    throw new Error('Không thể đặt lại đơn này.');
  }
  const state = getState();
  const items = {};
  const itemNotes = {};
  order.items.forEach((item) => {
    const itemId = item.id || item.realItemId;
    if (!itemId) return;
    const optionsKey = item.selectedOptions && item.selectedOptions.length
      ? `::${JSON.stringify(item.selectedOptions)}`
      : '';
    const cartKey = `${itemId}${optionsKey}`;
    const qty = Number(item.quantity || item.qty) || 1;
    items[cartKey] = (items[cartKey] || 0) + qty;
    if (item.note) itemNotes[cartKey] = item.note;
  });
  if (!Object.keys(items).length) {
    throw new Error('Đơn không còn món hợp lệ để đặt lại.');
  }
  state.cart = { restaurantId: order.restaurantId, items, itemNotes };
  saveState(state);
  navigate('restaurant.html', { id: String(order.restaurantId), reorder: '1' });
}

/* Cart helpers */
function getCart() { return getState().cart; }

function getCartTotal() {
  const cart = getCart();
  const empty = {
    storeTotal: 0, appTotal: 0, feePool: 0, platformFee: 0, deliveryFee: 0,
    shipperEarning: 0, itemCount: 0, discountValue: 0, minServiceFee: 0,
    platformWaivedAmount: 0, deliveryHalfAmount: 0, platformWaived: false,
    deliveryHalfApplied: false, feeWaiverHint: null
  };
  const restaurant = getRestaurantById(cart.restaurantId);
  if (!restaurant || !Array.isArray(restaurant.menu)) return empty;

  let storeTotal = 0;
  let itemCount = 0;
  const unitPrices = [];
  Object.entries(cart.items || {}).forEach(([cartKey, qty]) => {
    const [itemId, optionsStr] = cartKey.split('::');
    const item = restaurant.menu.find(m => m.id === itemId);
    if (item && qty > 0) {
      let toppingsInStore = 0;
      if (optionsStr) {
        try {
          JSON.parse(optionsStr).forEach(opt => { toppingsInStore += Number(opt.price) || 0; });
        } catch (e) {}
      }
      const unitStore = (Number(item.inStorePrice) || 0) + toppingsInStore;
      storeTotal += unitStore * qty;
      itemCount += qty;
      for (let i = 0; i < qty; i++) unitPrices.push(unitStore);
    }
  });

  if (itemCount <= 0) return empty;

  const surchargePerItem = restaurant.distanceSurchargePerItem || 0;
  let feePoolRaw = round100(storeTotal * MARKUP_RATE) + surchargePerItem * itemCount;

  let discountValue = 0;
  if (itemCount > 1) {
    // 15% giá quán mỗi món từ món thứ 2 (bỏ món đắt nhất); tối thiểu 2k/món; clamp sàn ship
    const sorted = unitPrices.slice().sort((a, b) => b - a);
    for (let i = 1; i < sorted.length; i++) {
      discountValue += Math.max(2000, round100(sorted[i] * MULTI_ITEM_DISCOUNT));
    }
    discountValue = Math.min(discountValue, Math.max(0, feePoolRaw - MIN_SHIPPER_EARNING));
  }

  let feePool = Math.max(0, feePoolRaw - discountValue);
  let minServiceFee = 0;
  if (feePool < MIN_SHIPPER_EARNING) {
    minServiceFee = round100(MIN_SHIPPER_EARNING - feePool);
    feePool = MIN_SHIPPER_EARNING;
  }

  let { platformFee, deliveryFee } = splitFeePool(feePool, PLATFORM_FEE_SHARE);
  let platformWaivedAmount = 0;
  let deliveryHalfAmount = 0;
  let platformWaived = false;
  let deliveryHalfApplied = false;

  if ((storeTotal >= WAIVE_PLATFORM_MIN_STORE || itemCount >= WAIVE_PLATFORM_MIN_ITEMS) && platformFee > 0) {
    platformWaivedAmount = Math.min(platformFee, Math.max(0, feePool - MIN_SHIPPER_EARNING));
    if (platformWaivedAmount > 0) {
      feePool -= platformWaivedAmount;
      platformWaived = true;
      ({ platformFee, deliveryFee } = splitFeePool(feePool, PLATFORM_FEE_SHARE));
    }
  }

  if ((storeTotal >= HALF_DELIVERY_MIN_STORE || itemCount >= HALF_DELIVERY_MIN_ITEMS) && deliveryFee > 0) {
    deliveryHalfAmount = Math.min(round100(deliveryFee * 0.5), Math.max(0, feePool - MIN_SHIPPER_EARNING));
    if (deliveryHalfAmount > 0) {
      feePool -= deliveryHalfAmount;
      deliveryHalfApplied = true;
      ({ platformFee, deliveryFee } = splitFeePool(feePool, PLATFORM_FEE_SHARE));
    }
  }

  return {
    storeTotal,
    appTotal: storeTotal + feePool,
    feePool,
    platformFee,
    deliveryFee,
    shipperEarning: computeShipperEarning(feePool, MIN_SHIPPER_EARNING, SHIPPER_SURPLUS_SHARE),
    itemCount,
    discountValue,
    minServiceFee,
    platformWaivedAmount,
    deliveryHalfAmount,
    platformWaived,
    deliveryHalfApplied,
    feeWaiverHint: buildFeeWaiverHint(
      storeTotal, itemCount, feePool, platformFee, deliveryFee, platformWaived, deliveryHalfApplied, surchargePerItem
    )
  };
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

async function placeOrder(address, name, phone, ordererPhone, pinnedLat, pinnedLon, isRelative, note, promoCode, loyaltyPointsRedeem, paymentMethod) {
  const state = getState();
  const cart   = state.cart;
  await ensureCartRestaurant(cart.restaurantId);
  const totals = getCartTotal();
  const restaurant = getRestaurantById(cart.restaurantId);
  if (!restaurant) {
    throw new Error('Không tìm thấy quán trong giỏ hàng. Vui lòng thử lại.');
  }

  const items = [];
  Object.entries(cart.items).forEach(([cartKey, qty]) => {
    const [itemId, optionsStr] = cartKey.split('::');
    const item = (restaurant.menu || []).find(m => m.id === itemId);
    if (item && qty > 0) {
      let selectedOptions = [];
      if (optionsStr) {
        try {
          selectedOptions = JSON.parse(optionsStr);
        } catch (e) {}
      }

      items.push({
        id: itemId,
        realItemId: itemId,
        name: item.name,
        quantity: qty,
        qty,
        note: (cart.itemNotes && cart.itemNotes[cartKey]) || '',
        selectedOptions
      });
    }
  });

  if (items.length === 0) {
    throw new Error('Giỏ hàng trống hoặc món không còn hợp lệ.');
  }

  const pay = (paymentMethod || state.paymentMethod || 'COD') === 'BANK_TRANSFER'
    ? 'BANK_TRANSFER'
    : 'COD';

  const orderPayload = {
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
    pinnedLat: (typeof pinnedLat === 'number' && Number.isFinite(pinnedLat))
      ? pinnedLat
      : ((typeof state.userLat === 'number' && Number.isFinite(state.userLat)) ? state.userLat : null),
    pinnedLon: (typeof pinnedLon === 'number' && Number.isFinite(pinnedLon))
      ? pinnedLon
      : ((typeof state.userLon === 'number' && Number.isFinite(state.userLon)) ? state.userLon : null),
    isRelative: isRelative || false,
    note: note || '',
    promoCode: promoCode || null,
    loyaltyPointsRedeem: Number(loyaltyPointsRedeem) > 0 ? Math.floor(Number(loyaltyPointsRedeem)) : 0,
    paymentMethod: pay,
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
  if (!savedOrder.restaurantImg && restaurant.img) {
    savedOrder.restaurantImg = restaurant.img;
  }

  state.activeOrder = savedOrder;
  state.cart = { restaurantId: null, items: {}, itemNotes: {} };
  saveState(state);
  upsertOrderHistory(savedOrder);

  return savedOrder;
}

function orderAuthHeaders(order) {
  const o = order || getState().activeOrder;
  const headers = { 'Content-Type': 'application/json' };
  if (o && o.trackingToken) {
    headers['X-Order-Token'] = o.trackingToken;
  } else if (o && (o.deliveryPhone || o.ordererPhone)) {
    headers['X-Delivery-Phone'] = o.deliveryPhone || o.ordererPhone;
  }
  return headers;
}

function orderAuthQuery(order) {
  const o = order || getState().activeOrder;
  if (!o) return '';
  if (o.trackingToken) return `&token=${encodeURIComponent(o.trackingToken)}`;
  const phone = o.deliveryPhone || o.ordererPhone || '';
  if (phone) return `&phone=${encodeURIComponent(phone)}`;
  return '';
}

async function rateOrder(orderId, rating, comment) {
  try {
    const response = await fetch(`${_API_BASE}/api/orders/${orderId}/rate`, {
      method: 'POST',
      headers: orderAuthHeaders(),
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
      if (result.data && result.data.trackingToken) {
        state.activeOrder.trackingToken = result.data.trackingToken;
      }
      saveState(state);
      upsertOrderHistory(state.activeOrder);
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
  upsertOrderHistory(state.activeOrder);
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

/** Reverse-geocode lat/lon → địa chỉ đọc được (Nominatim). */
async function reverseGeocodeAddress(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&accept-language=vi&addressdetails=1`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.display_name) return String(data.display_name);
  } catch (e) {
    console.warn('[reverseGeocode]', e.message || e);
  }
  return null;
}

let _geoInFlight = null;

function isEmbeddedFrame() {
  try {
    return window.self !== window.top;
  } catch (_) {
    return true;
  }
}

/**
 * Gắn ngữ cảnh lỗi GPS để formatGeoError phân biệt:
 * - siteDenied: trang bị Block/Deny trong trình duyệt
 * - osLocationOff: site đã Allow nhưng OS/Chrome system permission chặn → vẫn code 1
 *   (Chrome 144+ trên Windows: thêm dialog cho phép Location của hệ thống cho Chrome)
 */
function annotateGeoError(err, { apple, desktop, permState, inIframe, pageHost } = {}) {
  if (!err) return err;
  err.iosHint = !!apple;
  err.desktopHint = !!desktop;
  err.permState = permState || null;
  err.inIframe = !!inIframe;
  err.pageHost = pageHost || '';
  err.browserMessage = err.message || '';

  if (err.code === 1) {
    if (inIframe) {
      err.iframeBlocked = true;
    } else if (permState === 'granted') {
      // Giữ flag cũ cho tương thích; thực tế có thể là site/provider chứ không phải OS tắt
      err.osLocationOff = true;
    } else if (permState === 'denied') {
      err.permissionPermanentlyDenied = true;
    } else {
      err.permissionPermanentlyDenied = false;
    }
  }
  console.warn('[Geolocation]', {
    code: err.code,
    message: err.message,
    permState,
    pageHost: pageHost || '',
    inIframe: !!inIframe,
    osLocationOff: !!err.osLocationOff,
    siteDenied: !!err.permissionPermanentlyDenied
  });
  return err;
}

/**
 * Lấy vị trí từ Geolocation API (không ước lượng IP).
 *
 * QUAN TRỌNG — gọi từ click/tap:
 * 1) getCurrentPosition phải schedule ĐỒNG BỘ trong stack user gesture
 *    (không await Permissions API trước).
 * 2) Desktop Windows: máy không có GPS chip — dùng Wi‑Fi/cache của Chrome.
 *    maximumAge: 0 + high-accuracy dễ fail dù Windows Location đã On;
 *    ưu tiên lấy bản cache/network trước, rồi mới ép fresh.
 */
async function getUserLocation({ onProgress } = {}) {
  if (_geoInFlight) return _geoInFlight;

  const apple = isAppleMobile();
  const desktop = isDesktopBrowser();
  const inIframe = isEmbeddedFrame();
  const pageHost = (typeof location !== 'undefined' && location.hostname) || '';
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

  const highOpts = {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: apple ? 28000 : (desktop ? 20000 : 18000)
  };
  const lowFreshOpts = {
    enableHighAccuracy: false,
    maximumAge: 0,
    timeout: apple ? 18000 : 15000
  };
  // Desktop: chấp nhận vị trí Chrome/Windows lấy gần đây (tránh ép sensor mới → code 1/2 giả).
  const desktopCachedOpts = {
    enableHighAccuracy: false,
    maximumAge: 10 * 60 * 1000,
    timeout: 12000
  };

  // ── BẮT BUỘC: kick off getCurrentPosition TRƯỚC mọi await ──
  let firstPromise;
  if (apple) {
    progress('Đang lấy vị trí nhanh (mạng)...');
    firstPromise = geoGetOnce({
      enableHighAccuracy: false,
      maximumAge: 15_000,
      timeout: 12000
    });
  } else if (desktop) {
    progress('Đang lấy vị trí từ trình duyệt...');
    firstPromise = geoGetOnce(desktopCachedOpts);
  } else {
    progress('Đang lấy vị trí chính xác từ trình duyệt...');
    firstPromise = geoGetOnce(highOpts);
  }

  _geoInFlight = (async () => {
    const permState = await queryGeoPermissionState();

    let position = null;
    let coarse = false;
    let lastErr = null;

    try {
      position = await firstPromise;
      coarse = (position.coords.accuracy || 9999) > 80;
    } catch (firstErr) {
      lastErr = firstErr;
      // Thử thêm các chế độ còn lại trước khi kết luận fail
      const retries = desktop
        ? [lowFreshOpts, highOpts]
        : apple
          ? [highOpts]
          : [lowFreshOpts];

      for (const opts of retries) {
        progress('Đang thử lại định vị...');
        try {
          position = await geoGetOnce(opts);
          coarse = true;
          lastErr = null;
          break;
        } catch (retryErr) {
          lastErr = retryErr || lastErr;
        }
      }

      if (!position) {
        throw annotateGeoError(lastErr || firstErr, {
          apple,
          desktop,
          permState,
          inIframe,
          pageHost
        });
      }
    }

    // Apple: nâng độ chính xác nếu mới có fix mạng thô
    if (apple && position && (position.coords.accuracy || 9999) > 60) {
      progress('Đang lấy GPS chính xác (iPhone có thể mất 10–25 giây)...');
      try {
        const highPos = await geoGetOnce(highOpts);
        if ((highPos.coords.accuracy || 9999) <= (position.coords.accuracy || 9999)) {
          position = highPos;
        }
        coarse = (position.coords.accuracy || 9999) > 100;
      } catch (_) { /* giữ fix mạng */ }
    }

    // Desktop: chỉ refine ngắn nếu lệch lớn — không bắt buộc GPS chip
    const accuracy = position.coords.accuracy || 9999;
    if (accuracy > 60 && !desktop) {
      progress('Đang tinh chỉnh vị trí chính xác hơn...');
      try {
        const refined = await geoRefineWatch({
          timeoutMs: apple ? 18000 : 10000,
          targetAccuracy: 35
        });
        if ((refined.coords.accuracy || 9999) <= accuracy) {
          position = refined;
        }
        coarse = (position.coords.accuracy || 9999) > 100;
      } catch (_) { /* giữ fix tốt nhất */ }
    } else if (desktop && accuracy > 150) {
      coarse = true;
    }

    return {
      lat: position.coords.latitude,
      lon: position.coords.longitude,
      accuracy: position.coords.accuracy || null,
      coarse,
      apple,
      desktop,
      source: 'browser',
      permState,
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
      message: 'Trình duyệt không hỗ trợ định vị. Bạn vui lòng di chuyển ghim đỏ trên bản đồ để chọn điểm giao.'
    };
  }
  if (error.code === 1) {
    if (error.iframeBlocked || error.inIframe) {
      return {
        title: 'Chế độ xem trước',
        message: 'Trang đang mở trong khung xem trước nên bị giới hạn GPS. Bạn vui lòng kéo ghim trên bản đồ hoặc mở trang trực tiếp.'
      };
    }
    if (error.osLocationOff || error.permState === 'granted') {
      return {
        title: 'Chưa đọc được vị trí GPS',
        message: apple
          ? 'Cài đặt vị trí trên thiết bị chưa cho phép. Bạn vui lòng kéo ghim đỏ trên bản đồ để chọn vị trí giao hàng.'
          : desktop
            ? 'Máy tính không có phần cứng GPS hoặc định vị Windows/Chrome chưa sẵn sàng. Bạn vui lòng di chuyển ghim đỏ trên bản đồ hoặc nhập địa chỉ bên dưới.'
            : 'Hệ thống chưa đọc được tọa độ GPS. Bạn vui lòng kéo ghim đỏ trên bản đồ để chọn điểm giao hàng.'
      };
    }
    return {
      title: 'Chưa cấp quyền vị trí',
      message: apple
        ? 'Bạn chưa cho phép Safari đọc vị trí. Vui lòng di chuyển ghim đỏ trên bản đồ hoặc bật vị trí trong Cài đặt.'
        : desktop
          ? 'Trình duyệt chưa được cấp vị trí. Bạn vui lòng di chuyển ghim đỏ trên bản đồ hoặc bấm biểu tượng khóa cạnh thanh địa chỉ để Cho Phép.'
          : 'Trình duyệt chưa được cấp quyền vị trí. Vui lòng kéo ghim đỏ trên bản đồ để chọn vị trí giao hàng.'
    };
  }
  if (error.code === 2) {
    return {
      title: 'Không tìm thấy vị trí',
      message: desktop
        ? 'Trình duyệt không xác định được tọa độ (máy tính không có GPS). Vui lòng di chuyển ghim đỏ trên bản đồ hoặc nhập địa chỉ bên dưới.'
        : 'Không bắt được tín hiệu GPS. Bạn vui lòng di chuyển ghim đỏ trên bản đồ để chọn điểm giao hàng.'
    };
  }
  if (error.code === 3) {
    return {
      title: 'Định vị phản hồi chậm',
      message: 'Tín hiệu GPS phản hồi quá chậm. Vui lòng di chuyển ghim đỏ trên bản đồ để chọn điểm giao nhanh chóng.'
    };
  }
  return {
    title: 'Chưa lấy được vị trí',
    message: 'Không thể lấy tọa độ tự động. Vui lòng di chuyển ghim đỏ trên bản đồ để chọn điểm giao.'
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
  ensureCartRestaurant,
  get MARKUP_RATE() { return MARKUP_RATE; },
  calcToppingAppPrice,
  escapeHtml,
  debounce,
  throttle,
  isAppleMobile,
  isDesktopBrowser,
  getUserLocation,
  reverseGeocodeAddress,
  formatGeoError,
  loadLeaflet,
  lockBodyScroll,
  unlockBodyScroll,
  loadPricingConfig,
  getState, saveState, getCart, getCartTotal, updateCartItemNote,
  addToCart, removeFromCart, removeItemFromCart, clearCart,
  placeOrder, getActiveOrder, completeOrder, rateOrder,
  orderAuthHeaders, orderAuthQuery,
  navigate, getParam,
  formatCurrency, formatTime,
  showToast, updateCartBar,
  initNavScroll,
  isOrderInProgress,
  clearActiveOrder,
  getCustomerPhone,
  getOrderHistory,
  fetchOrderHistoryFromServer,
  upsertOrderHistory,
  reorderFromHistory,
  getFavorites,
  isFavorite,
  toggleFavorite,
  removeFavorite,
  customerAuthHeaders,
  isCustomerLoggedIn,
  requestCustomerOtp,
  verifyCustomerOtp,
  logoutCustomer,
  syncCustomerProfile,
  getSavedAddresses,
  saveAddressLocal,
  applySavedAddress,
  applyTheme,
  toggleTheme,
  estimateEtaMinutes,
  formatEtaLabel,
  fetchCustomerOffers,
  fetchCustomerSuggestions,
  fetchPaymentConfig,
  setPaymentMethod,
  getTrackingShareUrl,
  shareTrackingLink,
  enablePushNotifications,
  notifyLocal
};

/* --------------------------------------------------------------------------
   Mobile Zoom Prevention — PWA-style lock (pinch + ctrl-wheel + iOS gesture)
   -------------------------------------------------------------------------- */
(function lockPageZoom() {
  const block = (event) => {
    event.preventDefault();
  };
  document.addEventListener('gesturestart', block, { passive: false });
  document.addEventListener('gesturechange', block, { passive: false });
  document.addEventListener('gestureend', block, { passive: false });
  document.addEventListener('wheel', (event) => {
    if (event.ctrlKey) event.preventDefault();
  }, { passive: false });
  document.addEventListener('touchmove', (event) => {
    if (event.touches && event.touches.length > 1) event.preventDefault();
  }, { passive: false });
  // Double-tap zoom fallback (iOS): ignore rapid second tap on non-inputs
  let lastTouchEnd = 0;
  document.addEventListener('touchend', (event) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) {
      const tag = (event.target && event.target.tagName) || '';
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        event.preventDefault();
      }
    }
    lastTouchEnd = now;
  }, { passive: false });
})();

/* --------------------------------------------------------------------------
   PWA — register service worker + install prompt (Android / iOS)
   -------------------------------------------------------------------------- */
const PWA_DISMISS_KEY = 'shipfee_pwa_install_dismissed_v1';
const PWA_DISMISS_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

let _pwaDeferredPrompt = null;
let _pwaInstallUiReady = false;

function isPwaInstalled() {
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
    if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
  } catch (_) {}
  if (typeof navigator.standalone === 'boolean' && navigator.standalone) return true;
  return false;
}

function wasPwaInstallDismissed() {
  try {
    const raw = localStorage.getItem(PWA_DISMISS_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < PWA_DISMISS_MS;
  } catch (_) {
    return false;
  }
}

function dismissPwaInstall(persist) {
  hidePwaInstallBanner();
  closePwaInstallSheet();
  if (persist) {
    try { localStorage.setItem(PWA_DISMISS_KEY, String(Date.now())); } catch (_) {}
  }
}

function ensurePwaInstallUi() {
  if (_pwaInstallUiReady) return;
  _pwaInstallUiReady = true;

  const banner = document.createElement('div');
  banner.id = 'pwa-install';
  banner.className = 'pwa-install';
  banner.setAttribute('role', 'dialog');
  banner.setAttribute('aria-label', 'Cài đặt ứng dụng SHIPFEE');
  banner.innerHTML = `
    <img class="pwa-install__icon" src="icons/icon-192.png?v=20260730logo" width="44" height="44" alt="">
    <div class="pwa-install__body">
      <div class="pwa-install__title">Cài SHIPFEE vào máy</div>
      <div class="pwa-install__sub">Mở nhanh như app, không cần App Store</div>
    </div>
    <div class="pwa-install__actions">
      <button type="button" class="pwa-install__btn" id="pwa-install-btn">Cài đặt</button>
      <button type="button" class="pwa-install__close" id="pwa-install-close" aria-label="Đóng">
        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
      </button>
    </div>
  `;
  document.body.appendChild(banner);

  const sheet = document.createElement('div');
  sheet.id = 'pwa-install-sheet';
  sheet.className = 'pwa-install-sheet';
  sheet.setAttribute('aria-hidden', 'true');
  sheet.innerHTML = `
    <div class="pwa-install-sheet__panel" role="dialog" aria-modal="true" aria-labelledby="pwa-sheet-title">
      <div class="pwa-install-sheet__handle" aria-hidden="true"></div>
      <h3 class="pwa-install-sheet__title" id="pwa-sheet-title">Thêm SHIPFEE vào màn hình chính</h3>
      <p class="pwa-install-sheet__desc">Trên iPhone/iPad, Safari không cho tự cài — làm theo 3 bước sau:</p>
      <ol class="pwa-install-sheet__steps">
        <li><span class="pwa-install-sheet__num">1</span><span>Chạm nút <strong>Chia sẻ</strong> <i class="fa-solid fa-arrow-up-from-bracket" aria-hidden="true"></i> ở thanh Safari</span></li>
        <li><span class="pwa-install-sheet__num">2</span><span>Chọn <strong>Thêm vào Màn hình chính</strong></span></li>
        <li><span class="pwa-install-sheet__num">3</span><span>Nhấn <strong>Thêm</strong> — icon SHIPFEE sẽ xuất hiện như app</span></li>
      </ol>
      <button type="button" class="pwa-install-sheet__done" id="pwa-sheet-done">Đã hiểu</button>
    </div>
  `;
  document.body.appendChild(sheet);

  banner.querySelector('#pwa-install-btn').addEventListener('click', () => {
    triggerPwaInstall();
  });
  banner.querySelector('#pwa-install-close').addEventListener('click', () => {
    dismissPwaInstall(true);
  });
  sheet.querySelector('#pwa-sheet-done').addEventListener('click', () => {
    dismissPwaInstall(true);
  });
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) dismissPwaInstall(true);
  });
}

function showPwaInstallBanner() {
  if (isPwaInstalled() || wasPwaInstallDismissed() || isDesktopBrowser()) return;
  ensurePwaInstallUi();
  const el = document.getElementById('pwa-install');
  if (!el) return;
  requestAnimationFrame(() => el.classList.add('visible'));
}

function hidePwaInstallBanner() {
  const el = document.getElementById('pwa-install');
  if (el) el.classList.remove('visible');
}

function openPwaInstallSheet() {
  ensurePwaInstallUi();
  const sheet = document.getElementById('pwa-install-sheet');
  if (!sheet) return;
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  hidePwaInstallBanner();
}

function closePwaInstallSheet() {
  const sheet = document.getElementById('pwa-install-sheet');
  if (!sheet) return;
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
}

async function triggerPwaInstall() {
  if (_pwaDeferredPrompt) {
    try {
      _pwaDeferredPrompt.prompt();
      const choice = await _pwaDeferredPrompt.userChoice;
      _pwaDeferredPrompt = null;
      if (choice && choice.outcome === 'accepted') {
        dismissPwaInstall(true);
        showToast('Đã cài SHIPFEE', 'Mở app từ màn hình chính để đặt món nhanh hơn.', 'success');
      } else {
        dismissPwaInstall(true);
      }
      return;
    } catch (_) {
      _pwaDeferredPrompt = null;
    }
  }

  if (isAppleMobile()) {
    openPwaInstallSheet();
    return;
  }

  // Android/other without native prompt — guide via browser menu
  ensurePwaInstallUi();
  const sheet = document.getElementById('pwa-install-sheet');
  if (sheet) {
    const title = sheet.querySelector('#pwa-sheet-title');
    const desc = sheet.querySelector('.pwa-install-sheet__desc');
    const steps = sheet.querySelector('.pwa-install-sheet__steps');
    if (title) title.textContent = 'Cài SHIPFEE từ trình duyệt';
    if (desc) desc.textContent = 'Trình duyệt của bạn hỗ trợ cài web app. Làm theo các bước:';
    if (steps) {
      steps.innerHTML = `
        <li><span class="pwa-install-sheet__num">1</span><span>Mở menu trình duyệt <strong>⋮</strong> (góc trên)</span></li>
        <li><span class="pwa-install-sheet__num">2</span><span>Chọn <strong>Cài đặt ứng dụng</strong> / <strong>Add to Home screen</strong></span></li>
        <li><span class="pwa-install-sheet__num">3</span><span>Xác nhận — icon SHIPFEE sẽ nằm trên màn hình chính</span></li>
      `;
    }
  }
  openPwaInstallSheet();
}

function initPwaInstallPrompt() {
  if (isPwaInstalled() || wasPwaInstallDismissed()) return;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _pwaDeferredPrompt = e;
    showPwaInstallBanner();
  });

  window.addEventListener('appinstalled', () => {
    _pwaDeferredPrompt = null;
    dismissPwaInstall(true);
    showToast('Cài đặt thành công', 'SHIPFEE đã sẵn sàng trên màn hình chính.', 'success');
  });

  // iOS / browsers without beforeinstallprompt: show after short delay
  window.addEventListener('load', () => {
    setTimeout(() => {
      if (_pwaDeferredPrompt || isPwaInstalled() || wasPwaInstallDismissed()) return;
      if (isAppleMobile() || /Android/i.test(navigator.userAgent || '')) {
        showPwaInstallBanner();
      }
    }, 2800);
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Bust SW URL so phones discard stale cached tracking/HTML builds
    const swUrl = new URL('sw.js?v=2026-07-30logo', window.location.href).href;
    navigator.serviceWorker.register(swUrl).then((reg) => {
      try { reg.update(); } catch (_) {}
    }).catch(() => {});
  });
}

initPwaInstallPrompt();
