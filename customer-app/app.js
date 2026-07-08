/* ==========================================================================
   SHIPFEE — Customer App JavaScript Logic
   ========================================================================== */

'use strict';

const defaultApiUrl = 'https://shipfee-eo5s.onrender.com';

let _API_BASE = localStorage.getItem('shipfee_api_url') || defaultApiUrl;
if (_API_BASE.endsWith('/')) {
  _API_BASE = _API_BASE.slice(0, -1);
}

/* --------------------------------------------------------------------------
   Data: Loaded from restaurants-data.js (included before app.js in HTML)
   Cần Thơ restaurants based on ShopeeFood listings
   -------------------------------------------------------------------------- */
// Load active restaurants list from localStorage to persist across pages, falling back to static RESTAURANTS
function normalizeRestaurant(r) {
  if (!r || typeof r !== 'object') return null;
  if (!r.id || !r.name) return null;
  
  return {
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
    menu: Array.isArray(r.menu) ? r.menu.map(m => ({
      id: String(m.id),
      name: String(m.name),
      desc: String(m.desc || ''),
      inStorePrice: typeof m.inStorePrice === 'number' ? m.inStorePrice : 30000,
      appPrice: typeof m.appPrice === 'number' ? m.appPrice : 39000,
      img: String(m.img || ''),
      category: String(m.category || 'Thực đơn')
    })) : [],
    hasRealMenu: r.hasRealMenu === true,
    isClosed: r.isClosed === true,
    closedAt: r.closedAt ? String(r.closedAt) : null,
    closedReason: r.closedReason ? String(r.closedReason) : null,
    menuUpdatedAt: r.menuUpdatedAt ? String(r.menuUpdatedAt) : null,
    latitude: typeof r.latitude === 'number' ? r.latitude : null,
    longitude: typeof r.longitude === 'number' ? r.longitude : null,
    distanceValue: typeof r.distanceValue === 'number' ? r.distanceValue : null,
    distanceSurchargePerItem: typeof r.distanceSurchargePerItem === 'number' ? r.distanceSurchargePerItem : 0
  };
}

let ACTIVE_RESTAURANTS = [];
try {
  const cached = localStorage.getItem('shipfee_restaurants');
  if (cached) {
    const parsed = JSON.parse(cached);
    if (Array.isArray(parsed)) {
      ACTIVE_RESTAURANTS = parsed.map(normalizeRestaurant).filter(Boolean);
    }
  }
} catch (e) {}

if (!ACTIVE_RESTAURANTS || ACTIVE_RESTAURANTS.length === 0) {
  const defaultList = typeof RESTAURANTS !== 'undefined' ? RESTAURANTS : [];
  ACTIVE_RESTAURANTS = defaultList.map(normalizeRestaurant).filter(Boolean);
}

function setRestaurants(list) {
  const normalized = Array.isArray(list) ? list.map(normalizeRestaurant).filter(Boolean) : [];
  ACTIVE_RESTAURANTS = normalized;
  try {
    localStorage.setItem('shipfee_restaurants', JSON.stringify(normalized));
  } catch (e) {}
}

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
  const restaurant = ACTIVE_RESTAURANTS.find(r => r.id === cart.restaurantId);
  if (!restaurant) return { storeTotal: 0, appTotal: 0, shipperEarning: 0, itemCount: 0, discountValue: 0, minServiceFee: 0 };

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
            toppingsApp += Math.round((opt.price * 1.28) / 100) * 100;
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
            toppingsApp += Math.round((opt.price * 1.28) / 100) * 100;
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
    
    const surchargeDiscount = Math.round((surchargePerItem * 0.30) / 100) * 100;
    
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
    if (shipperEarningBeforeDiscount >= 15000) {
      minServiceFee = 0;
      discountValue = Math.min(discountValue, shipperEarningBeforeDiscount - 15000);
      appTotal = Math.max(0, appTotalRaw - discountValue);
    } else {
      discountValue = 0;
      minServiceFee = Math.round((15000 - shipperEarningBeforeDiscount) / 100) * 100;
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

async function placeOrder(address, name, phone, ordererPhone, pinnedLat, pinnedLon, isRelative, note) {
  const state = getState();
  const cart   = state.cart;
  const totals = getCartTotal();
  const restaurant = ACTIVE_RESTAURANTS.find(r => r.id === cart.restaurantId);

  const orderId = 'SPF-' + Math.floor(100000 + Math.random() * 900000);

  const items = [];
  Object.entries(cart.items).forEach(([cartKey, qty]) => {
    const [itemId, optionsStr] = cartKey.split('::');
    const item = restaurant.menu.find(m => m.id === itemId);
    if (item && qty > 0) {
      let toppingsInStore = 0;
      let toppingsApp = 0;
      let selectedOptions = [];
      if (optionsStr) {
        try {
          selectedOptions = JSON.parse(optionsStr);
          selectedOptions.forEach(opt => {
            toppingsInStore += opt.price;
            toppingsApp += Math.round((opt.price * 1.28) / 100) * 100;
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

  const orderPayload = {
    id: orderId,
    restaurantId: cart.restaurantId,
    restaurantName: restaurant.name,
    restaurantAddress: restaurant.address || '',
    restaurantLat: restaurant.latitude || null,
    restaurantLon: restaurant.longitude || null,
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
    createdAt: Date.now()
  };

  try {
    const response = await fetch(`${_API_BASE}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(orderPayload)
    });
    const result = await response.json();
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Lỗi lưu đơn hàng lên server');
    }
    
    const savedOrder = result.data;
    savedOrder.statusTime = Date.now();
    savedOrder.statusHistory = [{ status: 'PENDING', time: Date.now() }];
    
    state.activeOrder = savedOrder;
    state.cart = { restaurantId: null, items: {} };
    saveState(state);
    
    return savedOrder;
  } catch (error) {
    console.error('[App] Error placing order, falling back to local:', error);
    orderPayload.status = 'PENDING';
    orderPayload.statusTime = Date.now();
    orderPayload.statusHistory = [{ status: 'PENDING', time: Date.now() }];
    
    state.activeOrder = orderPayload;
    state.cart = { restaurantId: null, items: {} };
    saveState(state);
    return orderPayload;
  }
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

// Simulate order progression (for demo purposes)
function progressOrder() {
  const state = getState();
  if (!state.activeOrder) return null;
  const flow = ['PENDING', 'ACCEPTED', 'PURCHASED', 'DELIVERED'];
  const curIdx = flow.indexOf(state.activeOrder.status);
  if (curIdx < flow.length - 1) {
    const nextStatus = flow[curIdx + 1];
    state.activeOrder.status = nextStatus;
    state.activeOrder.statusTime = Date.now();
    state.activeOrder.statusHistory.push({ status: nextStatus, time: Date.now() });
    saveState(state);
  }
  return state.activeOrder;
}

function completeOrder() {
  const state = getState();
  state.activeOrder = null;
  saveState(state);
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

function showToast(title, message = '', type = 'info', duration = 4000) {
  initToasts();
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.innerHTML = `
    <span class="toast__icon">${icons[type] || icons.info}</span>
    <div class="toast__text">
      ${title ? `<div class="toast__title">${title}</div>` : ''}
      ${message ? `<div style="font-size:12px;opacity:0.8;">${message}</div>` : ''}
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
  window.addEventListener('scroll', onScroll, { passive: true });
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
   Expose to global scope (called from HTML onclick attributes)
   -------------------------------------------------------------------------- */
window.SF = {
  API_BASE: _API_BASE,
  get RESTAURANTS() { return ACTIVE_RESTAURANTS; },
  set RESTAURANTS(val) { setRestaurants(val); },
  setRestaurants,
  getState, saveState, getCart, getCartTotal,
  addToCart, removeFromCart, removeItemFromCart, clearCart,
  placeOrder, getActiveOrder, progressOrder, completeOrder, rateOrder,
  navigate, getParam,
  formatCurrency, formatTime,
  showToast, updateCartBar,
  initNavScroll
};

/* --------------------------------------------------------------------------
   Mobile Zoom Prevention
   -------------------------------------------------------------------------- */
document.addEventListener('touchstart', function (event) {
  if (event.touches.length > 1) {
    event.preventDefault();
  }
}, { passive: false });

let lastTouchEnd = 0;
document.addEventListener('touchend', function (event) {
  const now = (new Date()).getTime();
  if (now - lastTouchEnd <= 300) {
    event.preventDefault();
  }
  lastTouchEnd = now;
}, { passive: false });
