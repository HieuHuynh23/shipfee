/* ==========================================================================
   SHIPFREE — Customer App JavaScript Logic
   ========================================================================== */

'use strict';

/* --------------------------------------------------------------------------
   Data: Loaded from restaurants-data.js (included before app.js in HTML)
   Cần Thơ restaurants based on ShopeeFood listings
   -------------------------------------------------------------------------- */
// Load active restaurants list from localStorage to persist across pages, falling back to static RESTAURANTS
let ACTIVE_RESTAURANTS = [];
try {
  const cached = localStorage.getItem('shipfree_restaurants');
  if (cached) {
    ACTIVE_RESTAURANTS = JSON.parse(cached);
  }
} catch (e) {}

if (!ACTIVE_RESTAURANTS || ACTIVE_RESTAURANTS.length === 0) {
  ACTIVE_RESTAURANTS = typeof RESTAURANTS !== 'undefined' ? RESTAURANTS : [];
}

function setRestaurants(list) {
  ACTIVE_RESTAURANTS = list;
  try {
    localStorage.setItem('shipfree_restaurants', JSON.stringify(list));
  } catch (e) {}
}

/* --------------------------------------------------------------------------
   State Management (localStorage-backed)
   -------------------------------------------------------------------------- */
const STATE_KEY = 'shipfree_state';

function getState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    return raw ? JSON.parse(raw) : getDefaultState();
  } catch { return getDefaultState(); }
}

function getDefaultState() {
  return {
    cart: { restaurantId: null, items: {} },
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
  if (!restaurant) return { storeTotal: 0, appTotal: 0, shipperEarning: 0, itemCount: 0 };

  let storeTotal = 0, appTotal = 0, itemCount = 0;
  Object.entries(cart.items).forEach(([itemId, qty]) => {
    const item = restaurant.menu.find(m => m.id === itemId);
    if (item && qty > 0) {
      storeTotal += item.inStorePrice * qty;
      appTotal   += item.appPrice * qty;
      itemCount  += qty;
    }
  });
  return { storeTotal, appTotal, shipperEarning: appTotal - storeTotal, itemCount };
}

function addToCart(restaurantId, itemId) {
  const state = getState();
  if (state.cart.restaurantId && state.cart.restaurantId !== restaurantId) {
    // Different restaurant — clear old cart
    state.cart = { restaurantId, items: {} };
  }
  state.cart.restaurantId = restaurantId;
  state.cart.items[itemId] = (state.cart.items[itemId] || 0) + 1;
  saveState(state);
}

function removeFromCart(itemId) {
  const state = getState();
  if (state.cart.items[itemId] > 1) {
    state.cart.items[itemId]--;
  } else {
    delete state.cart.items[itemId];
    const hasItems = Object.keys(state.cart.items).length > 0;
    if (!hasItems) state.cart.restaurantId = null;
  }
  saveState(state);
}

function clearCart() {
  const state = getState();
  state.cart = { restaurantId: null, items: {} };
  saveState(state);
}

function placeOrder(address, name, phone, ordererPhone, pinnedLat, pinnedLon, isRelative) {
  const state = getState();
  const cart   = state.cart;
  const totals = getCartTotal();
  const restaurant = ACTIVE_RESTAURANTS.find(r => r.id === cart.restaurantId);

  const orderId = 'SPF-' + Math.floor(100000 + Math.random() * 900000);

  const items = [];
  Object.entries(cart.items).forEach(([itemId, qty]) => {
    const item = restaurant.menu.find(m => m.id === itemId);
    if (item && qty > 0) items.push({ ...item, qty });
  });

  state.activeOrder = {
    id: orderId,
    restaurantId: cart.restaurantId,
    restaurantName: restaurant.name,
    items,
    storeTotal: totals.storeTotal,
    appTotal: totals.appTotal,
    shipperEarning: totals.shipperEarning,
    status: 'PENDING',        // PENDING → ACCEPTED → PURCHASED → DELIVERED
    statusTime: Date.now(),
    statusHistory: [{ status: 'PENDING', time: Date.now() }],
    deliveryAddress: address,
    deliveryName: name,
    deliveryPhone: phone,
    ordererPhone: ordererPhone || '',
    pinnedLat: pinnedLat || state.userLat || 10.0345,
    pinnedLon: pinnedLon || state.userLon || 105.7876,
    isRelative: isRelative || false,
    shipperName: 'Nguyễn Văn Tài',
    shipperPhone: '0901 234 567',
    shipperRating: 4.9,
    createdAt: Date.now()
  };

  state.cart = { restaurantId: null, items: {} };
  saveState(state);
  return state.activeOrder;
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

  if (elCount)    elCount.textContent    = itemCount;
  if (elStore)    elStore.textContent    = formatCurrency(storeTotal);
  if (elShipper)  elShipper.textContent  = '+' + formatCurrency(shipperEarning);
  if (elTotal)    elTotal.textContent    = formatCurrency(appTotal);
  if (elBtnLabel) elBtnLabel.textContent = formatCurrency(appTotal);

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
  get RESTAURANTS() { return ACTIVE_RESTAURANTS; },
  set RESTAURANTS(val) { setRestaurants(val); },
  setRestaurants,
  getState, saveState, getCart, getCartTotal,
  addToCart, removeFromCart, clearCart,
  placeOrder, getActiveOrder, progressOrder, completeOrder,
  navigate, getParam,
  formatCurrency, formatTime,
  showToast, updateCartBar,
  initNavScroll
};
