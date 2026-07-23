/* shipfee-deploy-batch-v2 */
/* ==========================================================================
   SHIPFEE — Shipper App JavaScript Logic
   ========================================================================== */

'use strict';

const defaultApiUrl = 'https://shipfee-eo5s.onrender.com';

if (localStorage.getItem('shipfee_api_url')) {
  localStorage.removeItem('shipfee_api_url');
}
const API_BASE = defaultApiUrl;

/** Auth keys — localStorage để giữ login qua đóng tab / mở lại PWA */
const AUTH_JWT_KEY = 'shipfee_jwt';
const AUTH_DRIVER_KEY = 'shipfee_driver';
const AUTH_ONLINE_KEY = 'shipfee_driver_online';
const AUTH_SUPABASE_KEY = 'shipfee_driver_auth_token';

function getAuthItem(key) {
  try {
    const fromLocal = localStorage.getItem(key);
    if (fromLocal != null) return fromLocal;
    const fromSession = sessionStorage.getItem(key);
    if (fromSession != null) {
      try {
        localStorage.setItem(key, fromSession);
        sessionStorage.removeItem(key);
      } catch (_) {}
      return fromSession;
    }
  } catch (_) {}
  return null;
}

function setAuthItem(key, value) {
  try { localStorage.setItem(key, value); } catch (_) {}
  try { sessionStorage.removeItem(key); } catch (_) {}
}

function removeAuthItem(key) {
  try { localStorage.removeItem(key); } catch (_) {}
  try { sessionStorage.removeItem(key); } catch (_) {}
}

function clearShipperAuthStorage() {
  removeAuthItem(AUTH_JWT_KEY);
  removeAuthItem(AUTH_DRIVER_KEY);
  removeAuthItem(AUTH_ONLINE_KEY);
  removeAuthItem(AUTH_SUPABASE_KEY);
}

// Migrate one-time from sessionStorage → localStorage (bản cũ)
(function migrateShipperAuthToLocalStorage() {
  [AUTH_JWT_KEY, AUTH_DRIVER_KEY, AUTH_ONLINE_KEY, AUTH_SUPABASE_KEY].forEach((key) => {
    try {
      const ss = sessionStorage.getItem(key);
      if (ss == null) return;
      if (localStorage.getItem(key) == null) localStorage.setItem(key, ss);
      sessionStorage.removeItem(key);
    } catch (_) {}
  });
})();

const originalFetch = window.fetch;
window.fetch = function(input, init) {
  let url = typeof input === 'string' ? input : (input && input.url) || '';
  if (typeof input === 'string' && input.startsWith('http://localhost:3001')) {
    input = input.replace('http://localhost:3001', API_BASE);
    url = input;
  }

  // Only attach JWT to ShipFee backend — never leak token to OSRM/CDN/third-parties
  const isShipfeeApi = url.startsWith(API_BASE) || url.startsWith('/') || url.startsWith('http://localhost:3001');
  const token = isShipfeeApi ? getAuthItem(AUTH_JWT_KEY) : null;
  if (token) {
    init = init || {};
    init.headers = init.headers || {};
    if (typeof init.headers.set === 'function') {
      init.headers.set('Authorization', `Bearer ${token}`);
    } else if (Array.isArray(init.headers)) {
      init.headers.push(['Authorization', `Bearer ${token}`]);
    } else {
      init.headers['Authorization'] = `Bearer ${token}`;
    }
  }
  return originalFetch(input, init);
};

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch (e) {
    throw new Error('Máy chủ phản hồi không hợp lệ. Vui lòng thử lại.');
  }
}

async function apiFetch(url, options = {}, timeoutMs = 8000) {
  const opts = { ...options };
  if (!opts.signal && typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    opts.signal = AbortSignal.timeout(timeoutMs);
  }
  return fetch(url, opts);
}

// Helper to normalize phone numbers for robust matching (removes spaces)
function cleanPhone(p) {
  return (p || '').toString().trim().replace(/\s+/g, '');
}

/* --------------------------------------------------------------------------
   Leaflet — on-demand loader (faster first paint on mobile)
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
   Modal body scroll lock (iOS Safari overscroll through overlays)
   -------------------------------------------------------------------------- */
let _modalLockCount = 0;
let _modalScrollY = 0;
function lockBodyScroll() {
  if (_modalLockCount === 0) {
    _modalScrollY = window.scrollY || window.pageYOffset || 0;
    document.body.classList.add('modal-open');
    document.body.style.position = 'fixed';
    document.body.style.top = `-${_modalScrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
  }
  _modalLockCount += 1;
}
function unlockBodyScroll() {
  if (_modalLockCount <= 0) return;
  _modalLockCount -= 1;
  if (_modalLockCount > 0) return;
  document.body.classList.remove('modal-open');
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.left = '';
  document.body.style.right = '';
  document.body.style.width = '';
  window.scrollTo(0, _modalScrollY);
}

function setOverlayActive(overlayEl, active) {
  if (!overlayEl) return;
  const wasActive = overlayEl.classList.contains('active');
  if (active && !wasActive) {
    overlayEl.classList.add('active');
    lockBodyScroll();
  } else if (!active && wasActive) {
    overlayEl.classList.remove('active');
    unlockBodyScroll();
  } else if (active) {
    overlayEl.classList.add('active');
  } else {
    overlayEl.classList.remove('active');
  }
}

/* Chat bottom-sheet keyboard avoidance (visualViewport) */
let chatKeyboardHandler = null;
function bindChatKeyboardAvoidance() {
  unbindChatKeyboardAvoidance();
  const overlay = document.getElementById('chat-overlay');
  const sheet = overlay && overlay.querySelector('.bottom-sheet');
  if (!overlay || !sheet || !window.visualViewport) return;

  chatKeyboardHandler = () => {
    const vv = window.visualViewport;
    const occluded = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    sheet.style.setProperty('--kb-inset', occluded + 'px');
    sheet.style.transform = occluded > 0 ? `translateY(-${occluded}px)` : '';
  };
  window.visualViewport.addEventListener('resize', chatKeyboardHandler);
  window.visualViewport.addEventListener('scroll', chatKeyboardHandler);
  chatKeyboardHandler();
}
function unbindChatKeyboardAvoidance() {
  if (chatKeyboardHandler && window.visualViewport) {
    window.visualViewport.removeEventListener('resize', chatKeyboardHandler);
    window.visualViewport.removeEventListener('scroll', chatKeyboardHandler);
  }
  chatKeyboardHandler = null;
  const overlay = document.getElementById('chat-overlay');
  const sheet = overlay && overlay.querySelector('.bottom-sheet');
  if (sheet) {
    sheet.style.removeProperty('--kb-inset');
    sheet.style.transform = '';
  }
}

let driverAvatarBase64 = null;
function previewDriverAvatar(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    driverAvatarBase64 = e.target.result;
    const imgEl = document.getElementById('avatar-preview-img');
    const iconEl = document.getElementById('avatar-preview-icon');
    if (imgEl && iconEl) {
      imgEl.src = e.target.result;
      imgEl.style.display = 'block';
      iconEl.style.display = 'none';
    }
  };
  reader.readAsDataURL(file);
}
window.previewDriverAvatar = previewDriverAvatar;

function logoutApprovalPending() {
  if (supabaseClient) {
    supabaseClient.auth.signOut().then(() => {
      clearShipperAuthStorage();
      document.getElementById('approval-overlay').style.display = 'none';
      document.getElementById('login-overlay').classList.add('active');
    }).catch(() => {
      clearShipperAuthStorage();
      document.getElementById('approval-overlay').style.display = 'none';
      document.getElementById('login-overlay').classList.add('active');
    });
  } else {
    clearShipperAuthStorage();
    document.getElementById('approval-overlay').style.display = 'none';
    document.getElementById('login-overlay').classList.add('active');
  }
}
window.logoutApprovalPending = logoutApprovalPending;

// ── STATE MANAGEMENT ────────────────────────────────────────────────────────
let supabaseClient = null;
let currentDriver = null; // { name, phone }
let activeOrder = null;   // focused active order (1 of up to 2)
let activeOrders = [];    // up to 2 concurrent ACCEPTED/PURCHASED orders
const MAX_ACTIVE_ORDERS = 2;
let pendingOrders = [];   // targeted offers only (no public pool)
let historyOrders = [];   // completed orders by this driver
let isOnline = true;      // receiving orders
let pollInterval = null;
let watchPositionId = null;
let targetedOffer = null; // current active job offer
let offerTimerInterval = null;

// In-flight / concurrency guards
let syncInFlight = false;
let acceptInFlight = false;
let statusUpdateInFlight = false;
let shiftInFlight = false;
let chatSendInFlight = false;
let loginInFlight = false;
let pollFailCount = 0;
let pollBackoffActive = false;
let lastChatFingerprint = '';
let lastHistoryFingerprint = '';
let perfPeriodFilter = 'today'; // today | 7d | month
let perfDetailOpen = false;
/** Các ngày đang mở chi tiết đơn (7 ngày / tháng) */
const expandedPerfDays = new Set();
let activeTabId = 'orders';
let mapFollowGps = true;
let lastGpsUiUpdate = 0;
let lastGpsIndicatorText = '';
let lastKnownOnline = true;
const declinedPublicOrders = new Map(); // orderId -> expiresAt
const DECLINE_IGNORE_MS = 10 * 60 * 1000;

// Performance stats (Acceptance Rate, Completion Rate)
// Bump STATS_EPOCH khi cần xoá AR/CR cũ trên máy tài xế (go-live / reset vận hành)
const STATS_EPOCH = 'golive-2026-07-21';
let stats = {
  accepted: 0,
  declined: 0,
  completed: 0
};

// Map variables
let tripMap = null;
let shipperMarker = null;
let restMarker = null;
let destMarker = null;
let routeLine = null;

const FLOW = ['PENDING', 'ACCEPTED', 'PURCHASED', 'DELIVERED'];

function setConnectionStatus(online, detail) {
  const banner = document.getElementById('connection-banner');
  if (!banner) return;

  // Không hiện banner trên màn đăng nhập — tránh làm lệch layout/giao diện auth
  const loginOverlay = document.getElementById('login-overlay');
  const onLoginScreen = !!(loginOverlay && loginOverlay.classList.contains('active'));
  if (onLoginScreen || !currentDriver) {
    lastKnownOnline = online;
    banner.classList.remove('active', 'connection-banner--offline', 'connection-banner--online');
    banner.textContent = '';
    return;
  }

  if (online) {
    if (!lastKnownOnline) {
      banner.classList.remove('active', 'connection-banner--offline');
      banner.classList.add('connection-banner--online');
      banner.textContent = detail || 'Đã kết nối lại máy chủ';
      banner.classList.add('active');
      setTimeout(() => banner.classList.remove('active', 'connection-banner--online'), 2500);
    } else {
      banner.classList.remove('active', 'connection-banner--offline', 'connection-banner--online');
    }
  } else {
    banner.classList.add('active', 'connection-banner--offline');
    banner.classList.remove('connection-banner--online');
    banner.textContent = detail || 'Mất kết nối — đang thử lại…';
  }
  lastKnownOnline = online;
}

function pruneDeclinedOrders() {
  const now = Date.now();
  for (const [id, expiresAt] of declinedPublicOrders) {
    if (expiresAt <= now) declinedPublicOrders.delete(id);
  }
}

function rememberDeclinedOrder(orderId) {
  if (!orderId) return;
  declinedPublicOrders.set(orderId, Date.now() + DECLINE_IGNORE_MS);
}

function getChatFingerprint(order) {
  if (!order || !Array.isArray(order.messages) || order.messages.length === 0) return '0';
  const last = order.messages[order.messages.length - 1];
  return `${order.messages.length}:${last.id || ''}:${last.ts || last.createdAt || ''}:${last.text || ''}`;
}

let pollMode = 'all'; // 'all' | 'active'
let shipperRealtime = null; // EventSource
let shipperRealtimeActive = false;
let shipperRealtimeDebounce = null;

function openShipperRealtime() {
  if (!currentDriver || typeof EventSource === 'undefined') return;
  const token = getAuthItem(AUTH_JWT_KEY);
  if (!token) return;
  try {
    if (shipperRealtime) {
      shipperRealtime.close();
      shipperRealtime = null;
    }
    const url = `${API_BASE}/api/realtime/stream?role=shipper&access_token=${encodeURIComponent(token)}`;
    shipperRealtime = new EventSource(url);
    shipperRealtime.addEventListener('connected', () => {
      shipperRealtimeActive = true;
      // SSE sống → bỏ polling 3s, chỉ sync khi có event (+ fallback chậm)
      schedulePolling(45000);
      console.log('[Realtime] Shipper SSE connected');
    });
    shipperRealtime.addEventListener('order_updated', () => {
      if (shipperRealtimeDebounce) clearTimeout(shipperRealtimeDebounce);
      shipperRealtimeDebounce = setTimeout(() => {
        if (pollMode === 'active' && activeOrder) syncActiveOrderOnly();
        else syncAllData();
      }, 120);
    });
    shipperRealtime.addEventListener('call_updated', (ev) => {
      try {
        const payload = JSON.parse(ev.data || '{}');
        if (payload.call && payload.call.status === 'ringing' && payload.call.caller === 'customer') {
          if (activeOrder && String(payload.orderId) === String(activeOrder.id)) {
            checkIncomingCall(activeOrder.id);
          }
        }
      } catch (_) {}
    });
    shipperRealtime.onerror = () => {
      shipperRealtimeActive = false;
      try { shipperRealtime.close(); } catch (_) {}
      shipperRealtime = null;
      // Fallback polling nhanh khi SSE đứt
      schedulePolling(3000);
      setTimeout(() => { if (currentDriver) openShipperRealtime(); }, 4000);
    };
  } catch (e) {
    shipperRealtimeActive = false;
    console.warn('[Realtime] Shipper SSE failed:', e.message);
  }
}

function closeShipperRealtime() {
  shipperRealtimeActive = false;
  if (shipperRealtimeDebounce) {
    clearTimeout(shipperRealtimeDebounce);
    shipperRealtimeDebounce = null;
  }
  if (shipperRealtime) {
    try { shipperRealtime.close(); } catch (_) {}
    shipperRealtime = null;
  }
}

function schedulePolling(intervalMs) {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  const tick = () => {
    if (pollMode === 'active') {
      if (!activeOrder) {
        startPolling();
        return;
      }
      syncActiveOrderOnly();
    } else {
      syncAllData();
    }
  };
  pollInterval = setInterval(tick, intervalMs);
}

// ── DOM LOADED ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await initSupabase();
  loadDriverInfo();
  loadStats();
  initApp();

  // Sau khi shipper bấm link xác nhận email (CRM đã duyệt) → ?approved=1
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('approved') === '1') {
      showToast(
        'Email đã xác nhận!',
        'Đăng ký thành công. Đăng nhập bằng email và mật khẩu để bắt đầu nhận đơn.',
        'success'
      );
      params.delete('approved');
      const qs = params.toString();
      const cleanUrl = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
      window.history.replaceState({}, '', cleanUrl);
    }
  } catch (e) { /* ignore */ }

  window.addEventListener('online', () => {
    setConnectionStatus(true, 'Đã có mạng trở lại');
    if (currentDriver) {
      pollFailCount = 0;
      pollBackoffActive = false;
      if (pollMode === 'active') syncActiveOrderOnly();
      else syncAllData();
      schedulePolling(3000);
    }
  });
  window.addEventListener('offline', () => {
    setConnectionStatus(false, 'Thiết bị mất mạng — kiểm tra kết nối');
  });
});

async function initApp() {
  if (currentDriver) {
    document.getElementById('login-overlay').classList.remove('active');
    updateDriverHeader();
    
    // Ưu tiên trạng thái ca local (localStorage) — không để reload/restart Render tự checkout
    const savedStatus = getAuthItem(AUTH_ONLINE_KEY) ?? 'true';
    isOnline = (savedStatus === 'true');
    const checkbox = document.getElementById('online-switch');
    const statusText = document.getElementById('status-text');
    applyOnlineUi(isOnline);
    
    // Đồng bộ từ server; nếu local đang ONLINE mà server OFFLINE (sau deploy) → tự check-in lại
    try {
      const res = await apiFetch(`${API_BASE}/api/shippers/profile?phone=${encodeURIComponent(currentDriver.phone)}`, {}, 10000);
      if (res.ok) {
        const json = await safeJson(res);
        if (json.success && json.shipper) {
          const serverOnline = (json.shipper.status === 'ONLINE');
          if (isOnline && !serverOnline) {
            await restoreOnlineShift();
          } else {
            isOnline = serverOnline;
            persistOnlineStatus(isOnline);
            applyOnlineUi(isOnline);
          }
        }
      }
    } catch (e) {
      console.warn('Không thể đồng bộ trạng thái ca lúc khởi chạy:', e);
    }
    
    startPolling();
  }
}

function persistOnlineStatus(online) {
  setAuthItem(AUTH_ONLINE_KEY, online ? 'true' : 'false');
}

function applyOnlineUi(online) {
  const checkbox = document.getElementById('online-switch');
  const statusText = document.getElementById('status-text');
  if (checkbox) checkbox.checked = !!online;
  if (statusText) {
    if (online) {
      statusText.textContent = 'Đang trong ca (Check-in)';
      statusText.className = 'status-indicator online';
    } else {
      statusText.textContent = 'Đã tắt ca (Check-out)';
      statusText.className = 'status-indicator offline';
    }
  }
}

async function restoreOnlineShift() {
  if (!currentDriver) return;
  try {
    const res = await apiFetch(`${API_BASE}/api/shippers/shift`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: currentDriver.phone, status: 'ONLINE' })
    }, 10000);
    if (res.ok) {
      isOnline = true;
      persistOnlineStatus(true);
      applyOnlineUi(true);
      console.log('[Shift] Đã khôi phục Check-in sau khi tải lại trang');
    }
  } catch (e) {
    console.warn('[Shift] Không khôi phục được ca ONLINE:', e?.message || e);
  }
}

// ── SESSION & REGISTRATION ─────────────────────────────────────────────────
let authMode = 'login'; // 'login' or 'register'

function toggleAuthMode(e) {
  if (e) e.preventDefault();
  const link = document.getElementById('auth-toggle-link');
  const text = document.getElementById('auth-toggle-text');
  const btn = document.getElementById('login-btn');
  const title = document.querySelector('#login-overlay .modal__brand h2');
  
  // Reset avatar preview
  const imgEl = document.getElementById('avatar-preview-img');
  const iconEl = document.getElementById('avatar-preview-icon');
  if (imgEl) imgEl.style.display = 'none';
  if (iconEl) iconEl.style.display = 'block';
  const fileInput = document.getElementById('driver-avatar');
  if (fileInput) fileInput.value = '';
  driverAvatarBase64 = null;

  if (authMode === 'login') {
    authMode = 'register';
    title.textContent = 'Đăng ký Tài xế';
    text.textContent = 'Đã có tài khoản?';
    link.textContent = 'Đăng nhập';
    
    document.getElementById('login-group-name').style.display = 'flex';
    document.getElementById('login-group-phone').style.display = 'flex';
    document.getElementById('login-group-cccd').style.display = 'flex';
    document.getElementById('login-group-email').style.display = 'flex';
    document.getElementById('login-group-password').style.display = 'flex';
    document.getElementById('login-group-avatar').style.display = 'flex';
    btn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Đăng ký tài khoản';
  } else {
    authMode = 'login';
    title.textContent = 'Đăng nhập Tài xế';
    text.textContent = 'Chưa có tài khoản?';
    link.textContent = 'Đăng ký ngay';
    
    document.getElementById('login-group-name').style.display = 'none';
    document.getElementById('login-group-phone').style.display = 'none';
    document.getElementById('login-group-cccd').style.display = 'none';
    document.getElementById('login-group-email').style.display = 'flex';
    document.getElementById('login-group-password').style.display = 'flex';
    document.getElementById('login-group-avatar').style.display = 'none';
    btn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Đăng nhập';
  }
}

async function handleAuthAction() {
  if (authMode === 'login') {
    await loginDriver();
  } else {
    await registerDriver();
  }
}

async function registerDriver() {
  const nameInput = document.getElementById('driver-name');
  const phoneInput = document.getElementById('driver-phone');
  const cccdInput = document.getElementById('driver-cccd');
  const emailInput = document.getElementById('driver-email');
  const passwordInput = document.getElementById('driver-password');

  const name = nameInput.value.trim();
  const phone = phoneInput.value.trim();
  const cccd = cccdInput ? cccdInput.value.trim() : '';
  const email = emailInput.value.trim();
  const password = passwordInput.value.trim();
  
  if (!name || !phone || !cccd || !email || !password) {
    showToast('Thiếu thông tin', 'Vui lòng điền đầy đủ Họ tên, Số điện thoại, Số CCCD, Email và Mật khẩu.', 'warning');
    return;
  }

  if (!driverAvatarBase64) {
    showToast('Thiếu ảnh chân dung', 'Vui lòng chọn ảnh chân dung để tiếp tục đăng ký.', 'warning');
    return;
  }

  const btn = document.getElementById('login-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang đăng ký...';

  if (!supabaseClient) {
    showToast('Supabase chưa cấu hình', 'Hệ thống đang hoạt động ở chế độ Online bắt buộc nhưng Supabase chưa được kết nối!', 'error');
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Đăng ký tài khoản';
    return;
  }

  try {
    // 1. Đăng ký qua Backend (Admin createUser — không gửi email ngay)
    const response = await apiFetch(`${API_BASE}/api/shippers/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name, phone, email, password, avatar: driverAvatarBase64, cccd })
    }, 20000);

    const res = await safeJson(response);
    if (!response.ok || !res.success) {
      showToast('Đăng ký thất bại', res.error || 'Đăng ký tài khoản thất bại.', 'error');
      return;
    }

    // 2. Chờ CRM/Telegram duyệt → lúc đó mới nhận email xác nhận Supabase
    showToast(
      'Đăng ký thành công!',
      'Hồ sơ đang chờ admin duyệt. Bạn chưa nhận email lúc này. Sau khi được duyệt, Supabase mới gửi link xác nhận — mở link rồi đăng nhập bằng email/mật khẩu.',
      'success'
    );
    toggleAuthMode();
  } catch (err) {
    console.error('Lỗi đăng ký tài xế:', err);
    showToast('Lỗi kết nối', 'Không thể kết nối đến máy chủ API.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = authMode === 'register'
      ? '<i class="fa-solid fa-user-plus"></i> Đăng ký tài khoản'
      : '<i class="fa-solid fa-right-to-bracket"></i> Đăng nhập';
  }
}

async function refreshDriverInfo() {
  if (!currentDriver || !currentDriver.phone) return;
  try {
    const res = await fetch(`${API_BASE}/api/shippers/profile?phone=${currentDriver.phone}`).then(r => r.json());
    if (res.success && res.shipper) {
      currentDriver = {
        name: res.shipper.name,
        phone: res.shipper.phone,
        avatarUrl: res.shipper.avatarUrl || '',
        isApproved: res.shipper.isApproved,
        cccd: res.shipper.cccd || '',
        assistanceLimitToday: res.shipper.assistanceLimitToday || 0,
        assistanceRequested: res.shipper.assistanceRequested || false
      };
      setAuthItem(AUTH_DRIVER_KEY, JSON.stringify(currentDriver));
      updateDriverHeader();
      
      // Nếu modal profile đang mở, cập nhật lại các trường trong modal
      const overlay = document.getElementById('driver-profile-overlay');
      if (overlay && overlay.style.display !== 'none') {
        document.getElementById('profile-name').textContent = currentDriver.name || '-';
        document.getElementById('profile-phone').textContent = currentDriver.phone || '-';
        const cccdEl = document.getElementById('profile-cccd');
        if (cccdEl) cccdEl.textContent = currentDriver.cccd || 'Chưa cập nhật';
        
        const avatarImg = document.getElementById('profile-avatar-img');
        const avatarPlaceholder = document.getElementById('profile-avatar-placeholder');
        if (currentDriver.avatarUrl && avatarImg && avatarPlaceholder) {
          avatarImg.src = currentDriver.avatarUrl;
          avatarImg.style.display = 'block';
          avatarPlaceholder.style.display = 'none';
        }
      }
    }
  } catch (err) {
    console.warn('[Profile Refresh Error] Không thể làm mới hồ sơ tài xế:', err);
  }
}

function loadDriverInfo() {
  try {
    const raw = getAuthItem(AUTH_DRIVER_KEY);
    if (raw) {
      currentDriver = JSON.parse(raw);
      refreshDriverInfo(); // Tự động làm mới thông tin từ server khi khởi chạy app
    }
  } catch (e) {
    console.error('Lỗi đọc thông tin tài xế:', e);
  }
}

async function loginDriver() {
  if (!supabaseClient) {
    showToast('Supabase chưa cấu hình', 'Hệ thống đang hoạt động ở chế độ Online bắt buộc nhưng Supabase chưa được kết nối!', 'error');
    return;
  }
  if (loginInFlight) return;

  const emailInput = document.getElementById('driver-email');
  const passwordInput = document.getElementById('driver-password');
  const email = emailInput.value.trim();
  const password = passwordInput.value.trim();
  const btn = document.getElementById('login-btn');

  if (!email || !password) {
    showToast('Thiếu thông tin', 'Vui lòng nhập Email và Mật khẩu.', 'warning');
    return;
  }

  loginInFlight = true;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang đăng nhập...';
  }

  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) {
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('email not confirmed') || msg.includes('email_not_confirmed')) {
        showToast(
          'Chưa xác nhận email',
          'Sau khi CRM duyệt, mở email và bấm link xác nhận Supabase, rồi đăng nhập lại.',
          'warning'
        );
      } else {
        showToast('Đăng nhập thất bại', error.message, 'error');
      }
      return;
    }

    const session = data.session;
    setAuthItem(AUTH_JWT_KEY, session.access_token);

    // Gọi API của server để đồng bộ và lấy thông tin shipper
    const response = await apiFetch(`${API_BASE}/api/shippers/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ token: session.access_token })
    }, 15000);

    if (response.status === 403) {
      // Tài khoản đang chờ phê duyệt
      document.getElementById('login-overlay').classList.remove('active');
      document.getElementById('approval-overlay').style.display = 'flex';
      return;
    }

    const result = await safeJson(response);
    if (response.ok && result.success) {
      currentDriver = { 
        name: result.shipper.name, 
        phone: result.shipper.phone,
        avatarUrl: result.shipper.avatarUrl,
        isApproved: result.shipper.isApproved,
        cccd: result.shipper.cccd || '',
        assistanceLimitToday: result.shipper.assistanceLimitToday || 0,
        assistanceRequested: result.shipper.assistanceRequested || false
      };
      setAuthItem(AUTH_DRIVER_KEY, JSON.stringify(currentDriver));
      loadStats();

      document.getElementById('login-overlay').classList.remove('active');
      updateDriverHeader();
      showToast('Đăng nhập thành công', `Chào mừng ${currentDriver.name} đã vào hệ thống!`, 'success');

      isOnline = true;
      persistOnlineStatus(true);
      applyOnlineUi(true);
      unlockAudio(false);
      startAudioKeepAlive();

      apiFetch(`${API_BASE}/api/shippers/shift`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ phone: currentDriver.phone, status: 'ONLINE' })
      }, 10000).catch(err => console.warn('Lỗi tự động vào ca:', err));

      startPolling();
    } else {
      showToast('Đăng nhập thất bại', result.error || 'Đồng bộ thông tin tài xế thất bại.', 'error');
    }
  } catch (err) {
    console.error('Lỗi login Supabase:', err);
    showToast('Lỗi kết nối', 'Không thể kết nối với Supabase Auth.', 'error');
  } finally {
    loginInFlight = false;
    if (btn && authMode === 'login') {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Đăng nhập';
    }
  }
}

function updateDriverHeader() {
  if (!currentDriver) return;
  document.getElementById('header-name').textContent = currentDriver.name;
  document.getElementById('header-phone').textContent = currentDriver.phone;

  const headerAvatarText = document.getElementById('header-avatar-text');
  const headerAvatarImg = document.getElementById('header-avatar-img');

  if (currentDriver.avatarUrl && headerAvatarImg && headerAvatarText) {
    headerAvatarImg.src = currentDriver.avatarUrl;
    headerAvatarImg.style.display = 'block';
    headerAvatarText.style.display = 'none';
  } else {
    if (headerAvatarImg) headerAvatarImg.style.display = 'none';
    if (headerAvatarText) {
      headerAvatarText.textContent = currentDriver.name.charAt(0);
      headerAvatarText.style.display = 'block';
    }
  }
}

async function toggleOnlineStatus() {
  const checkbox = document.getElementById('online-switch');
  const statusText = document.getElementById('status-text');
  const nextOnline = checkbox.checked;
  const statusString = nextOnline ? 'ONLINE' : 'OFFLINE';
  
  if (!currentDriver) return;
  if (shiftInFlight) {
    checkbox.checked = !nextOnline;
    return;
  }

  shiftInFlight = true;
  checkbox.disabled = true;
  
  try {
    const res = await apiFetch(`${API_BASE}/api/shippers/shift`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ phone: currentDriver.phone, status: statusString })
    }, 10000);
    
    const result = await safeJson(res);
    if (res.ok && result.success) {
      isOnline = nextOnline;
      persistOnlineStatus(isOnline);
      if (isOnline) {
        statusText.textContent = 'Đang trong ca (Check-in)';
        statusText.className = 'status-indicator online';
        showToast('Vào ca thành công 🟢', 'Đã ghi nhận Check-in trên hệ thống.', 'success');
        unlockAudio(false);
        startAudioKeepAlive();
        startPolling();
      } else {
        statusText.textContent = 'Đã tắt ca (Check-out)';
        statusText.className = 'status-indicator offline';
        showToast('Ra ca thành công 🔴', 'Đã ghi nhận Check-out trên hệ thống.', 'info');
        stopAudioKeepAlive();
        stopOrderAlertLoop();
        stopPolling();
        if (activeOrder) {
          startActiveOrderPolling();
        } else {
          renderPendingOrders([]);
        }
      }
    } else {
      // Revert checkbox state on error
      checkbox.checked = !nextOnline;
      showToast('Lỗi ca làm việc', result.error || 'Không thể cập nhật trạng thái ca.', 'error');
    }
  } catch (e) {
    // Revert checkbox state on network error
    checkbox.checked = !nextOnline;
    showToast('Lỗi kết nối', 'Không thể kết nối máy chủ để cập nhật ca.', 'error');
  } finally {
    shiftInFlight = false;
    checkbox.disabled = false;
  }
}

// ── POLLING DATA ────────────────────────────────────────────────────────────
function startPolling() {
  stopPolling();
  pollMode = 'all';
  if (isOnline) {
    startGpsTracking();
  }
  pollFailCount = 0;
  pollBackoffActive = false;
  syncAllData();
  openShipperRealtime();
  // Khi SSE chưa sẵn sàng: poll 3s; khi connected sẽ nới 45s
  schedulePolling(shipperRealtimeActive ? 45000 : 3000);
  startCrmSupportPolling();
}

function stopPolling() {
  closeShipperRealtime();
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (activeOrders.length === 0) {
    stopGpsTracking();
  }
}

function startActiveOrderPolling() {
  // Vẫn poll toàn bộ đơn để nhận đề xuất đơn thứ 2 (ghép đơn)
  startPolling();
}

let lastPendingLength = 0;

function setActiveOrdersList(list, { announceNew = false } = {}) {
  const prevIds = new Set(activeOrders.map(o => o.id));
  activeOrders = Array.isArray(list) ? list.slice(0, MAX_ACTIVE_ORDERS) : [];

  if (activeOrders.length === 0) {
    activeOrder = null;
    return { isFirstLoad: false, focusedChanged: true };
  }

  const stillFocused = activeOrder && activeOrders.some(o => o.id === activeOrder.id);
  const newest = activeOrders[activeOrders.length - 1];
  const prevFocusedId = activeOrder && activeOrder.id;
  if (!stillFocused) {
    activeOrder = newest;
  } else {
    activeOrder = activeOrders.find(o => o.id === activeOrder.id) || newest;
  }

  const isFirstLoad = prevIds.size === 0 && activeOrders.length > 0;
  const newlyAdded = activeOrders.filter(o => !prevIds.has(o.id));
  if (announceNew && newlyAdded.length > 0 && !isFirstLoad) {
    playChimeSound();
    showToast(
      activeOrders.length > 1 ? 'Ghép đơn thành công! 📦' : 'Nhận đơn thành công! ⚡',
      newlyAdded.length > 1
        ? `Bạn vừa nhận thêm ${newlyAdded.length} đơn.`
        : `Đơn ${newlyAdded[0].id} đã được gán cho bạn.`,
      'success'
    );
  }
  return {
    isFirstLoad,
    focusedChanged: prevFocusedId !== (activeOrder && activeOrder.id),
    newlyAdded
  };
}

function selectActiveOrder(orderId) {
  const found = activeOrders.find(o => o.id === orderId);
  if (!found) return;
  activeOrder = found;
  mapFollowGps = true;
  renderActiveTrip();
  maybeRefreshChat();
}
window.selectActiveOrder = selectActiveOrder;

async function syncAllData() {
  if (!currentDriver || syncInFlight) return;
  syncInFlight = true;
  
  try {
    const url = `${API_BASE}/api/orders?shipperPhone=${encodeURIComponent(currentDriver.phone)}`;
    const res = await apiFetch(url, {}, 8000);
    if (!res.ok) throw new Error('API server error');
    const result = await safeJson(res);
    
    pollFailCount = 0;
    setConnectionStatus(true);
    if (pollBackoffActive) {
      pollBackoffActive = false;
      schedulePolling(3000);
    }
    
    if (result.success && Array.isArray(result.data)) {
      const allOrders = result.data;
      pruneDeclinedOrders();
      
      // Chỉ đề xuất đích danh — không còn bể đơn chung
      pendingOrders = allOrders.filter(o =>
        o.status === 'PENDING' &&
        cleanPhone(o.assignedShipperPhone) === cleanPhone(currentDriver.phone) &&
        !declinedPublicOrders.has(o.id)
      );
      
      const myOffer = pendingOrders[0] || null;
      // Chỉ hiện offer đơn thứ 2 nếu còn chỗ capacity
      if (myOffer && activeOrders.length < MAX_ACTIVE_ORDERS) {
        handleTargetedOffer(myOffer);
      } else if (!myOffer) {
        handleTargetedOffer(null);
      } else {
        // Đang đủ 2 đơn — đóng offer nếu có
        handleTargetedOffer(null);
      }

      // Tab "Chờ đề xuất" — không liệt kê bể chung
      renderPendingOrders([]);
      
      historyOrders = allOrders.filter(o => cleanPhone(o.shipperPhone) === cleanPhone(currentDriver.phone) && o.status === 'DELIVERED');
      if (activeTabId === 'history' && !document.hidden) {
        renderHistoryAndStats();
      }
      
      const activeDriverOrders = allOrders
        .filter(o => cleanPhone(o.shipperPhone) === cleanPhone(currentDriver.phone) && (o.status === 'ACCEPTED' || o.status === 'PURCHASED'))
        .sort((a, b) => {
          const ta = new Date(a.acceptedAt || a.updatedAt || a.createdAt || 0).getTime();
          const tb = new Date(b.acceptedAt || b.updatedAt || b.createdAt || 0).getTime();
          return ta - tb;
        });

      const prevFocused = activeOrder;
      const { isFirstLoad, focusedChanged } = setActiveOrdersList(activeDriverOrders, { announceNew: true });

      if (activeOrder) {
        if (prevFocused && prevFocused.id === activeOrder.id) {
          checkNewMessages(prevFocused, activeOrder);
        }
        const statusChanged = !prevFocused || prevFocused.id !== activeOrder.id || prevFocused.status !== activeOrder.status;
        if (statusChanged || focusedChanged || activeOrders.length !== (prevFocused ? 1 : 0)) {
          renderActiveTrip();
        }
        if (isFirstLoad) {
          switchTab('trip');
          startGpsTracking();
          if (typeof playChimeSound === 'function') playChimeSound();
          showToast('Nhận đơn thành công! ⚡', 'Hệ thống đã đề xuất và gán đơn cho bạn.', 'success');
        }
        maybeRefreshChat();
        checkIncomingCall(activeOrder.id);
      } else {
        renderActiveTrip();
        if (!isOnline) stopGpsTracking();
      }

      // Badge: số đề xuất đang chờ + số đơn đang chạy
      const pendingBadge = document.getElementById('pending-count');
      if (pendingBadge) pendingBadge.textContent = String(pendingOrders.length);
    }
  } catch (err) {
    console.error('[Shipper App] Error syncing data:', err);
    pollFailCount++;
    pollBackoffActive = true;
    setConnectionStatus(false, pollFailCount > 1
      ? `Mất kết nối — thử lại lần ${pollFailCount}…`
      : 'Mất kết nối — đang thử lại…');
    const backoff = Math.min(15000, 3000 * Math.pow(2, Math.min(pollFailCount - 1, 2)));
    schedulePolling(backoff);
  } finally {
    syncInFlight = false;
  }
}

async function syncActiveOrderOnly() {
  // Fallback: luôn sync toàn bộ để hỗ trợ ghép tối đa 2 đơn + đề xuất mới
  return syncAllData();
}

function maybeRefreshChat() {
  const chatOverlay = document.getElementById('chat-overlay');
  if (!chatOverlay || !chatOverlay.classList.contains('active')) return;
  const fp = getChatFingerprint(activeOrder);
  if (fp !== lastChatFingerprint) {
    lastChatFingerprint = fp;
    renderShipperChatMessages();
  }
}

// ── NEW MESSAGE NOTIFICATION DETECTOR ───────────────────────────────────────
function checkNewMessages(oldOrder, newOrder) {
  if (!oldOrder || !newOrder || !newOrder.messages) return;
  const oldMsgs = oldOrder.messages || [];
  const newMsgs = newOrder.messages;
  
  if (newMsgs.length > oldMsgs.length) {
    const incoming = newMsgs.slice(oldMsgs.length);
    const newCustomerMsgs = incoming.filter(m => {
      const s = String(m.sender || '').toLowerCase();
      const r = String(m.role || '').toLowerCase();
      return s === 'customer' || r === 'customer';
    });
    const newAdminMsgs = incoming.filter(m => {
      const s = String(m.sender || '').toLowerCase();
      const r = String(m.role || '').toLowerCase();
      return s === 'admin' || r === 'admin' || m.sender === 'Admin';
    });
    if (newCustomerMsgs.length > 0) {
      playMessageChimeSound();
      const lastMsg = newCustomerMsgs[newCustomerMsgs.length - 1];
      showToast('Khách hàng nhắn tin 💬', lastMsg.text, 'info');
    }
    if (newAdminMsgs.length > 0) {
      playMessageChimeSound();
      const lastMsg = newAdminMsgs[newAdminMsgs.length - 1];
      showToast('CRM trả lời 💬', lastMsg.text, 'info');
      maybeRefreshChat();
    }
  }
}

// ── TAB ROUTING ─────────────────────────────────────────────────────────────
function switchTab(tabId) {
  activeTabId = tabId || 'orders';
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  const btn = document.getElementById(`nav-btn-${tabId}`);
  if (btn) btn.classList.add('active');
  
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  const content = document.getElementById(`tab-${tabId}`);
  if (content) content.classList.add('active');
  
  if (tabId === 'orders') {
    // Không hiển thị bể chung — chỉ trạng thái chờ đề xuất / SOS
    renderPendingOrders([]);
  } else if (tabId === 'trip') {
    renderActiveTrip();
  } else if (tabId === 'history') {
    lastHistoryFingerprint = '';
    renderHistoryAndStats();
    loadCrmSupportThread();
  }
}

// ── RENDER PENDING ORDERS ───────────────────────────────────────────────────
function renderPendingOrders(orders) {
  const container = document.getElementById('pending-orders-list');
  container.innerHTML = '';
  
  const pendingCountEl = document.getElementById('pending-count');
  if (pendingCountEl) pendingCountEl.textContent = orders.length;

  if (orders.length === 0) {
    let assistanceHtml = '';
    if (isOnline && currentDriver) {
      const usedToday = currentDriver.assistanceLimitToday || 0;
      const isRequested = currentDriver.assistanceRequested === true;
      const remaining = Math.max(0, 3 - usedToday);
      assistanceHtml = `
        <div class="crm-assist-card ${isRequested ? 'is-waiting' : ''}" id="assistance-container">
          <div class="crm-assist-card__head">
            <span class="crm-assist-card__icon"><i class="fa-solid fa-headset"></i></span>
            <div>
              <h4>Hỗ trợ tìm đơn từ CRM</h4>
              <p>Dùng khi lâu không nhận đề xuất — CRM sẽ ưu tiên gán đơn gần bạn.</p>
            </div>
          </div>
          <div class="crm-assist-card__meta">
            <span class="status-chip ${isRequested ? 'status-chip--wait' : (remaining === 0 ? 'status-chip--danger' : 'status-chip--ok')}">
              ${isRequested ? 'Đang chờ CRM' : (remaining === 0 ? 'Hết lượt hôm nay' : 'Sẵn sàng')}
            </span>
            <span>Đã dùng <strong id="assistance-used-count">${usedToday}</strong>/3 · còn <strong>${remaining}</strong></span>
          </div>
          <button type="button" class="btn ${isRequested ? 'btn--secondary' : 'btn--primary'}" id="btn-request-assistance"
            onclick="requestOrderAssistance()" ${isRequested || remaining === 0 ? 'disabled' : ''}>
            <i class="fa-solid ${isRequested ? 'fa-hourglass-half' : 'fa-bolt'}"></i>
            ${isRequested ? 'CRM đang ưu tiên gán đơn...' : 'Yêu cầu CRM hỗ trợ tìm đơn'}
          </button>
        </div>
      `;
    }

    const loadHint = activeOrders.length > 0
      ? (activeOrders.some(o => o.status === 'PURCHASED')
          ? `Bạn đang chạy ${activeOrders.length}/${MAX_ACTIVE_ORDERS} đơn (đã lấy hàng). Hệ thống ưu tiên ghép đơn gần điểm giao khách hiện tại.`
          : `Bạn đang chạy ${activeOrders.length}/${MAX_ACTIVE_ORDERS} đơn. Hệ thống có thể ghép thêm đơn gần quán/điểm giao hiện tại.`)
      : 'Hệ thống đề xuất đơn đích danh (không bể chung). Tối đa 2 đơn / tài xế — đồng bộ với CRM Live Ops.';
    container.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-satellite-dish fa-spin-slow" style="color:var(--clr-text-muted);"></i>
        <p>${isOnline ? 'Đang chờ hệ thống đề xuất đơn...' : 'Vui lòng BẬT NHẬN ĐƠN để nhận đề xuất'}</p>
        <p style="font-size:11px;color:var(--clr-text-muted);margin-top:8px;max-width:280px;line-height:1.45;">${loadHint}</p>
        ${assistanceHtml}
      </div>`;
    return;
  }
  
  orders.forEach(order => {
    const card = document.createElement('div');
    card.className = 'order-card animate-fade-in';
    card.onclick = () => openJobDetail(order.id);
    
    let itemsLabel = (order.items || []).map(i => {
      const optsText = (i.selectedOptions && i.selectedOptions.length > 0)
        ? ` [${i.selectedOptions.map(o => o.name).join(', ')}]`
        : '';
      return `${i.name}${optsText} (x${i.qty})`;
    }).join(', ');
    if (itemsLabel.length > 80) itemsLabel = itemsLabel.substring(0, 77) + '...';

    card.innerHTML = `
      <div class="order-card__header">
        <span class="order-card__id">${escapeHtml(order.id)}</span>
        <span class="order-card__time">${formatTime(order.createdAt)}</span>
      </div>
      <div class="order-card__points">
        <div class="card-point">
          <span class="card-point__icon">🏪</span>
          <div>
            <div class="card-point__name">${escapeHtml(order.restaurantName)}</div>
            <div class="card-point__address">${escapeHtml(order.restaurantAddress)}</div>
          </div>
        </div>
        <div class="card-point">
          <span class="card-point__icon">🏠</span>
          <div>
            <div class="card-point__name">Khách hàng: ${escapeHtml(order.deliveryAddress)}</div>
            <div class="card-point__address" style="color:var(--clr-accent); font-weight:600;">Món ăn: ${escapeHtml(itemsLabel)}</div>
          </div>
        </div>
      </div>
      <div class="order-card__footer">
        <div class="order-card__earning">
          <span class="earning-label">Thu nhập dự kiến</span>
          <span class="earning-val">${formatCurrency(order.shipperEarning)}</span>
        </div>
        <span style="font-size: 11px; font-weight: 700; color: var(--clr-primary);"><i class="fa-solid fa-angle-right"></i> Nhấp để xem</span>
      </div>
    `;
    container.appendChild(card);
  });
}

// ── JOB DETAIL OVERLAY ──────────────────────────────────────────────────────
let activeJobId = null;

function openJobDetail(orderId) {
  const order = pendingOrders.find(o => o.id === orderId);
  if (!order) return;
  
  activeJobId = orderId;
  
  document.getElementById('job-restaurant-name').textContent = order.restaurantName;
  document.getElementById('job-restaurant-address').textContent = order.restaurantAddress;
  document.getElementById('job-customer-address').textContent = order.deliveryAddress;
  document.getElementById('job-earning').textContent = formatCurrency(order.shipperEarning);
  document.getElementById('job-app-total').textContent = formatCurrency(order.appTotal);
  document.getElementById('job-store-total').textContent = formatCurrency(order.storeTotal);
  
  // Render danh sách món ăn kèm ghi chú món
  const itemsContainer = document.getElementById('job-items-list');
  if (itemsContainer) {
    itemsContainer.innerHTML = '';
    const items = order.items || [];
    items.forEach((item, idx) => {
      const optsText = (item.selectedOptions && item.selectedOptions.length > 0)
        ? ` <span style="color: var(--clr-text-secondary); font-size:11px;">(${item.selectedOptions.map(o => escapeHtml(o.name)).join(', ')})</span>`
        : '';
      const noteHtml = (item.note && item.note.trim() && item.note !== 'undefined' && item.note !== 'null')
        ? `<div style="color: #b45309; font-size: 11px; margin-top: 4px; padding: 4px 8px; background: rgba(245, 158, 11, 0.05); border: 1px dashed rgba(245, 158, 11, 0.25); border-radius: 4px; display: inline-block; width: 100%; box-sizing: border-box;"><i class="fa-solid fa-note-sticky"></i> Ghi chú món: <strong>${escapeHtml(item.note)}</strong></div>`
        : '';
      
      const itemEl = document.createElement('div');
      itemEl.style.padding = '8px 0';
      if (idx < items.length - 1) {
        itemEl.style.borderBottom = '1px solid var(--clr-border)';
      }
      itemEl.innerHTML = `
        <div style="display:flex; justify-content:space-between; font-size:13px; font-weight:600; margin-bottom: 2px;">
          <span style="color:var(--clr-text-primary); text-align:left;">${escapeHtml(item.name)}${optsText}</span>
          <span style="color:var(--clr-primary); margin-left: 8px; font-weight: 700;">x${item.quantity || item.qty || 1}</span>
        </div>
        ${noteHtml}
      `;
      itemsContainer.appendChild(itemEl);
    });

    // Render ghi chú giao hàng chung của khách hàng trực tiếp dưới danh sách món ăn
    if (order.note && order.note.trim() && order.note !== 'undefined' && order.note !== 'null') {
      const generalNoteEl = document.createElement('div');
      generalNoteEl.style.marginTop = '12px';
      generalNoteEl.style.padding = '10px';
      generalNoteEl.style.background = 'rgba(245, 158, 11, 0.05)';
      generalNoteEl.style.border = '1px dashed rgba(245, 158, 11, 0.25)';
      generalNoteEl.style.borderRadius = '8px';
      generalNoteEl.innerHTML = `
        <span style="color: #b45309; font-weight: 700; font-size: 12px; display: flex; align-items: center; gap: 4px;">
          <i class="fa-solid fa-note-sticky"></i> Ghi chú giao hàng của khách:
        </span>
        <div style="color: #78350f; font-size: 12px; margin-top: 4px; font-weight: 600; line-height: 1.4;">${escapeHtml(order.note)}</div>
      `;
      itemsContainer.appendChild(generalNoteEl);
    }
  }

  // Khớp an toàn với noteBox cũ nếu vẫn tồn tại trong HTML
  const noteBox = document.getElementById('job-note-box');
  if (noteBox) {
    noteBox.style.display = 'none';
  }
  
  document.getElementById('order-detail-overlay').classList.add('active');
  lockBodyScroll();
  
  // Initialize accept swipe button
  initSwipeButton('accept-swipe-container', 'accept-swipe-handle', 'accept-swipe-text', () => {
    document.getElementById('order-detail-overlay').classList.remove('active');
    unlockBodyScroll();
    acceptOrder(activeJobId);
  });
}

function closeJobDetail() {
  const overlay = document.getElementById('order-detail-overlay');
  if (overlay && overlay.classList.contains('active')) {
    overlay.classList.remove('active');
    unlockBodyScroll();
  }
  activeJobId = null;
}

function declineOrder() {
  if (!activeJobId) return;
  const declinedId = activeJobId;
  // Đồng bộ server giống declineTargetedOffer — không chỉ ẩn local
  (async () => {
    try {
      const res = await apiFetch(`${API_BASE}/api/orders/${declinedId}/decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: currentDriver && currentDriver.phone })
      }, 10000);
      const json = await safeJson(res);
      if (!res.ok || !json.success) {
        showToast('Không từ chối được', (json && json.error) || 'Thử lại sau.', 'error');
        return;
      }
      rememberDeclinedOrder(declinedId);
      stats.declined++;
      saveStats();
      showToast('Đã từ chối đơn', `Bạn đã bỏ qua đơn hàng ${declinedId}.`, 'info');
      closeJobDetail();
      pendingOrders = pendingOrders.filter(o => o.id !== declinedId);
      const poolOrders = pendingOrders.filter(o => !o.assignedShipperPhone || cleanPhone(o.assignedShipperPhone) !== cleanPhone(currentDriver && currentDriver.phone));
      lastPendingLength = poolOrders.length;
      renderPendingOrders(poolOrders);
    } catch (e) {
      showToast('Lỗi mạng', 'Không thể từ chối đơn.', 'error');
    }
  })();
}

// ── ACCEPT ORDER ───────────────────────────────────────────────────────────
async function acceptOrder(orderId) {
  if (!currentDriver) {
    document.getElementById('login-overlay').classList.add('active');
    return;
  }
  if (acceptInFlight) return;
  if (activeOrders.length >= MAX_ACTIVE_ORDERS) {
    showToast('Đã đủ đơn', `Bạn đang mang tối đa ${MAX_ACTIVE_ORDERS} đơn. Hãy hoàn thành một đơn trước.`, 'warning');
    return;
  }

  acceptInFlight = true;
  
  try {
    const response = await apiFetch(`${API_BASE}/api/orders/${orderId}/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        shipperId: currentDriver.phone,
        shipperName: currentDriver.name,
        shipperPhone: currentDriver.phone
      })
    }, 12000);
    
    const result = await safeJson(response);
    if (response.ok && result.success) {
      stats.accepted++;
      saveStats();
      const nextList = [...activeOrders.filter(o => o.id !== result.data.id), result.data];
      setActiveOrdersList(nextList);
      mapFollowGps = true;
      showToast(
        nextList.length > 1 ? 'Ghép đơn thành công! 📦' : 'Đã nhận đơn!',
        `Bạn đang chạy ${nextList.length}/${MAX_ACTIVE_ORDERS} đơn.`,
        'success'
      );
      switchTab('trip');
      startGpsTracking();
      startPolling(); // tiếp tục nhận đề xuất đơn thứ 2 nếu còn chỗ
      renderActiveTrip();
    } else {
      showToast('Lỗi nhận đơn', result.error || 'Không thể nhận đơn này.', 'error');
      syncAllData();
    }
  } catch (e) {
    console.error('Lỗi nhận đơn:', e);
    showToast('Lỗi kết nối', 'Không thể kết nối với server.', 'error');
  } finally {
    acceptInFlight = false;
  }
}

// ── RENDER ACTIVE TRIP ──────────────────────────────────────────────────────
function renderActiveTrip() {
  const emptyTrip = document.getElementById('no-active-trip');
  const tripContainer = document.getElementById('active-trip-container');
  const switcher = document.getElementById('active-orders-switcher');
  
  if (!activeOrder || activeOrders.length === 0) {
    emptyTrip.style.display = 'flex';
    tripContainer.style.display = 'none';
    if (switcher) {
      switcher.style.display = 'none';
      switcher.innerHTML = '';
    }
    const countBadge = document.getElementById('active-orders-count');
    if (countBadge) countBadge.style.display = 'none';
    if (tripMap) {
      tripMap.remove();
      tripMap = null;
    }
    return;
  }
  
  emptyTrip.style.display = 'none';
  tripContainer.style.display = 'block';

  const countBadge = document.getElementById('active-orders-count');
  if (countBadge) {
    countBadge.style.display = 'inline-flex';
    countBadge.textContent = `${activeOrders.length}/${MAX_ACTIVE_ORDERS}`;
  }

  // Switcher khi đang mang 2 đơn (ghép đơn)
  if (switcher) {
    if (activeOrders.length > 1) {
      switcher.style.display = 'flex';
      switcher.innerHTML = activeOrders.map((o, idx) => {
        const active = activeOrder && activeOrder.id === o.id;
        return `<button type="button" class="trip-switch-btn ${active ? 'active' : ''}" onclick="selectActiveOrder('${escapeHtml(o.id)}')">
          Đơn ${idx + 1}: ${escapeHtml(o.id)} · ${escapeHtml(o.status)}
        </button>`;
      }).join('');
    } else {
      switcher.style.display = 'none';
      switcher.innerHTML = '';
    }
  }
  
  document.getElementById('trip-order-id').textContent = activeOrder.id;
  
  const statusBadge = document.getElementById('trip-order-status');
  statusBadge.textContent = activeOrder.status;
  statusBadge.className = 'trip-card__status badge ' + getStatusBadgeClass(activeOrder.status);
  
  document.getElementById('trip-restaurant-name').textContent = activeOrder.restaurantName;
  document.getElementById('trip-restaurant-address').textContent = activeOrder.restaurantAddress;
  
  const clientName = activeOrder.isRelative ? `👤 ${activeOrder.deliveryName} (Người thân)` : activeOrder.deliveryName || 'Khách hàng';
  document.getElementById('trip-customer-name').textContent = clientName;
  document.getElementById('trip-customer-address').textContent = activeOrder.deliveryAddress;
  document.getElementById('trip-customer-phone').textContent = `SĐT: ${activeOrder.deliveryPhone}`;
  
  document.getElementById('trip-store-total').textContent = formatCurrency(activeOrder.storeTotal);
  document.getElementById('trip-app-total').textContent = formatCurrency(activeOrder.appTotal);
  document.getElementById('trip-earning').textContent = formatCurrency(activeOrder.shipperEarning);
  
  // Render danh sách món ăn kèm ghi chú món cho active trip
  const tripItemsContainer = document.getElementById('trip-items-list');
  if (tripItemsContainer) {
    tripItemsContainer.innerHTML = '';
    const items = activeOrder.items || [];
    items.forEach((item, idx) => {
      const optsText = (item.selectedOptions && item.selectedOptions.length > 0)
        ? ` <span style="color: var(--clr-text-secondary); font-size:11px;">(${item.selectedOptions.map(o => o.name).join(', ')})</span>`
        : '';
      const noteHtml = (item.note && item.note.trim() && item.note !== 'undefined' && item.note !== 'null')
        ? `<div style="color: #b45309; font-size: 11px; margin-top: 4px; padding: 4px 8px; background: rgba(245, 158, 11, 0.05); border: 1px dashed rgba(245, 158, 11, 0.25); border-radius: 4px; display: inline-block; width: 100%; box-sizing: border-box;"><i class="fa-solid fa-note-sticky"></i> Ghi chú món: <strong>${item.note}</strong></div>`
        : '';
      
      const itemEl = document.createElement('div');
      itemEl.style.padding = '8px 0';
      if (idx < items.length - 1) {
        itemEl.style.borderBottom = '1px solid var(--clr-border)';
      }
      itemEl.innerHTML = `
        <div style="display:flex; justify-content:space-between; font-size:13px; font-weight:600; margin-bottom: 2px;">
          <span style="color:var(--clr-text-primary); text-align:left;">${item.name}${optsText}</span>
          <span style="color:var(--clr-primary); margin-left: 8px; font-weight: 700;">x${item.quantity || item.qty || 1}</span>
        </div>
        ${noteHtml}
      `;
      tripItemsContainer.appendChild(itemEl);
    });

    // Render ghi chú giao hàng chung của khách hàng trực tiếp dưới danh sách món ăn
    if (activeOrder.note && activeOrder.note.trim() && activeOrder.note !== 'undefined' && activeOrder.note !== 'null') {
      const generalNoteEl = document.createElement('div');
      generalNoteEl.style.marginTop = '12px';
      generalNoteEl.style.padding = '10px';
      generalNoteEl.style.background = 'rgba(245, 158, 11, 0.05)';
      generalNoteEl.style.border = '1px dashed rgba(245, 158, 11, 0.25)';
      generalNoteEl.style.borderRadius = '8px';
      generalNoteEl.innerHTML = `
        <span style="color: #b45309; font-weight: 700; font-size: 12px; display: flex; align-items: center; gap: 4px;">
          <i class="fa-solid fa-note-sticky"></i> Ghi chú giao hàng của khách:
        </span>
        <div style="color: #78350f; font-size: 12px; margin-top: 4px; font-weight: 600; line-height: 1.4;">${activeOrder.note}</div>
      `;
      tripItemsContainer.appendChild(generalNoteEl);
    }
  }

  // Khớp an toàn với tripNoteBox cũ nếu vẫn tồn tại trong HTML
  const tripNoteBox = document.getElementById('trip-note-box');
  if (tripNoteBox) {
    tripNoteBox.style.display = 'none';
  }
  
  // Set swipe track text based on status
  const swipeText = document.getElementById('trip-swipe-text');
  if (activeOrder.status === 'ACCEPTED') {
    swipeText.textContent = '👉 Vuốt để xác nhận lấy hàng';
  } else if (activeOrder.status === 'PURCHASED') {
    swipeText.textContent = '👉 Vuốt để hoàn thành giao hàng';
  }

  // Initialize swipe button for status changes
  initSwipeButton('trip-swipe-container', 'trip-swipe-handle', 'trip-swipe-text', () => {
    advanceTripStatus();
  });
  
  // Hiện nút chỉ đường khi có tọa độ hoặc địa chỉ (Maps resolve bằng text)
  const btnNavRest = document.getElementById('btn-nav-restaurant');
  const btnNavCust = document.getElementById('btn-nav-customer');
  if (btnNavRest) {
    const hasRestCoords = Number.isFinite(parseFloat(activeOrder.restaurantLat)) && Number.isFinite(parseFloat(activeOrder.restaurantLon));
    const hasRestAddress = !!(activeOrder.restaurantAddress || activeOrder.restaurantName);
    btnNavRest.style.display = (hasRestCoords || hasRestAddress) ? 'inline-flex' : 'none';
  }
  if (btnNavCust) {
    const hasCustCoords = Number.isFinite(parseFloat(activeOrder.pinnedLat)) && Number.isFinite(parseFloat(activeOrder.pinnedLon));
    const hasCustAddress = !!activeOrder.deliveryAddress;
    btnNavCust.style.display = (hasCustCoords || hasCustAddress) ? 'inline-flex' : 'none';
  }

  initTripMap();
}

function getStatusBadgeClass(status) {
  const map = {
    PENDING: 'badge--warning',
    ACCEPTED: 'badge--primary',
    PURCHASED: 'badge--accent',
    DELIVERED: 'badge--primary'
  };
  return map[status] || 'badge--primary';
}

// ── TRIP MAP & ROUTING ──────────────────────────────────────────────────────
let tripMapInitToken = 0;
async function initTripMap() {
  if (!activeOrder) return;
  const token = ++tripMapInitToken;
  const mapEl = document.getElementById('shipper-map');
  if (typeof L === 'undefined') {
    if (mapEl && !tripMap) {
      mapEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:16px;text-align:center;color:var(--clr-text-muted);font-size:13px;">Đang tải bản đồ…</div>`;
    }
    try {
      await loadLeaflet();
    } catch (e) {
      if (token !== tripMapInitToken) return;
      if (mapEl) {
        mapEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:16px;text-align:center;color:var(--clr-text-muted);font-size:13px;">Không tải được bản đồ. Dùng nút điều hướng Google Maps bên dưới.</div>`;
      }
      return;
    }
  }
  if (token !== tripMapInitToken || !activeOrder) return;
  
  const restLat = activeOrder.restaurantLat || 10.0354;
  const restLon = activeOrder.restaurantLon || 105.7825;
  const custLat = activeOrder.pinnedLat || 10.0276;
  const custLon = activeOrder.pinnedLon || 105.7725;
  
  const shipLat = activeOrder.shipperLat || restLat + 0.005;
  const shipLon = activeOrder.shipperLon || restLon - 0.005;
  
  try {
    if (!tripMap) {
      // Prevent "Map container is already initialized" error defensively on reload
      const mapContainer = document.getElementById('shipper-map');
      if (mapContainer) {
        // Clear deferred-load placeholder before Leaflet mounts
        mapContainer.innerHTML = '';
        if (mapContainer._leaflet_id) {
          const parent = mapContainer.parentNode;
          const newContainer = mapContainer.cloneNode(false);
          newContainer.removeAttribute('_leaflet_id');
          parent.replaceChild(newContainer, mapContainer);
        }
      }
      
      tripMap = L.map('shipper-map', {
        zoomControl: false,
        tapTolerance: 15,
        preferCanvas: true
      }).setView([shipLat, shipLon], 16);
      mapFollowGps = true;
      tripMap.on('dragstart', () => { mapFollowGps = false; });
      tripMap.on('zoomstart', () => { mapFollowGps = false; });
      
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
      }).addTo(tripMap);
      
      const restIcon = L.divIcon({
        html: `<div style="background:#EF4444; width:30px; height:30px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:white; font-size:14px; border: 2px solid white; box-shadow: 0 2px 5px rgba(0,0,0,0.3);">🏪</div>`,
        className: '', iconSize: [30, 30], iconAnchor: [15, 15]
      });

      const destIcon = L.divIcon({
        html: `<div style="background:#3B82F6; width:30px; height:30px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:white; font-size:14px; border: 2px solid white; box-shadow: 0 2px 5px rgba(0,0,0,0.3);">🏠</div>`,
        className: '', iconSize: [30, 30], iconAnchor: [15, 15]
      });

      const shipIcon = L.divIcon({
        html: `<div style="background:#10B981; width:34px; height:34px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:white; font-size:16px; border: 2px solid white; box-shadow: 0 2px 8px rgba(16,185,129,0.5);"><i class="fa-solid fa-motorcycle"></i></div>`,
        className: '', iconSize: [34, 34], iconAnchor: [17, 17]
      });

      restMarker = L.marker([restLat, restLon], { icon: restIcon }).addTo(tripMap);
      destMarker = L.marker([custLat, custLon], { icon: destIcon }).addTo(tripMap);
      shipperMarker = L.marker([shipLat, shipLon], { icon: shipIcon }).addTo(tripMap).bindPopup('Vị trí của bạn (Shipper)').openPopup();
      
      routeLine = L.polyline([[restLat, restLon], [custLat, custLon]], {
        color: '#3B82F6',
        weight: 5,
        opacity: 0.8
      }).addTo(tripMap);
      
      const group = new L.featureGroup([restMarker, destMarker, shipperMarker]);
      // Center on driver instead of fitBounds (zoom out)
      tripMap.setView([shipLat, shipLon], 16);
      
      fetch(`https://router.project-osrm.org/route/v1/driving/${restLon},${restLat};${custLon},${custLat}?overview=full&geometries=geojson`)
        .then(res => res.json())
        .then(data => {
          if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
            const coords = data.routes[0].geometry.geojson.coordinates;
            const pathLatLngs = coords.map(c => [c[1], c[0]]);
            routeLine.setLatLngs(pathLatLngs);
          }
        }).catch(err => console.warn('Lỗi OSRM routing:', err));
        
    } else {
      restMarker.setLatLng([restLat, restLon]);
      destMarker.setLatLng([custLat, custLon]);
      shipperMarker.setLatLng([shipLat, shipLon]);
    }
    
    setTimeout(() => {
      if (tripMap) {
        tripMap.invalidateSize();
      }
    }, 150);
  } catch (err) {
    console.error('Lỗi vẽ bản đồ:', err);
  }
}

// ── ADVANCE TRIP STATUS ────────────────────────────────────────────────────
async function advanceTripStatus() {
  if (!activeOrder || statusUpdateInFlight) return;
  
  const nextStatus = activeOrder.status === 'ACCEPTED' ? 'PURCHASED' : 'DELIVERED';
  statusUpdateInFlight = true;
  
  try {
    const response = await apiFetch(`${API_BASE}/api/orders/${activeOrder.id}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status: nextStatus })
    }, 12000);
    
    const result = await safeJson(response);
    if (response.ok && result.success) {
      if (nextStatus === 'DELIVERED') {
        stats.completed++;
        // Đưa đơn vào history trước khi sync CRM — tránh earnings/totalOrders bị stale
        const deliveredOrder = result.data || activeOrder;
        if (deliveredOrder && deliveredOrder.id) {
          historyOrders = [
            deliveredOrder,
            ...(historyOrders || []).filter(o => o && o.id !== deliveredOrder.id)
          ];
        }
        saveStats();
        const remaining = activeOrders.filter(o => o.id !== activeOrder.id);
        setActiveOrdersList(remaining);
        showToast(
          'Hoàn thành đơn hàng!',
          remaining.length > 0
            ? `Còn ${remaining.length} đơn đang chạy. Chuyển sang đơn tiếp theo.`
            : 'Bạn đã hoàn tất giao hàng.',
          'success'
        );
        if (remaining.length > 0) {
          mapFollowGps = true;
          renderActiveTrip();
          startPolling();
        } else {
          stopGpsTracking();
          renderActiveTrip();
          startPolling();
        }
      } else {
        showToast('Đã lấy hàng!', 'Hãy chuyển đồ ăn đến khách hàng.', 'success');
        activeOrders = activeOrders.map(o => o.id === result.data.id ? result.data : o);
        activeOrder = result.data;
        renderActiveTrip();
      }
    } else {
      showToast('Lỗi cập nhật', result.error || 'Không thể cập nhật trạng thái.', 'error');
      // Re-init swipe so driver can retry
      if (activeOrder) renderActiveTrip();
    }
  } catch (e) {
    console.error('Lỗi cập nhật đơn:', e);
    showToast('Lỗi kết nối', 'Không thể kết nối với server.', 'error');
    if (activeOrder) renderActiveTrip();
  } finally {
    statusUpdateInFlight = false;
  }
}

// ── GPS REAL POSITION TRACKING ──────────────────────────────────────────────
let lastGpsSendTime = 0;

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function startGpsTracking() {
  stopGpsTracking();
  
  if (!navigator.geolocation) {
    const gpsEl = document.getElementById('gps-indicator');
    if (gpsEl) gpsEl.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> GPS: Thiết bị không hỗ trợ Geolocation`;
    return;
  }
  
  const gpsEl = document.getElementById('gps-indicator');
  if (gpsEl) gpsEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> GPS: Đang khởi động định vị...`;
  lastGpsIndicatorText = '';
  lastGpsUiUpdate = 0;
  
  watchPositionId = navigator.geolocation.watchPosition(
    async (position) => {
      const lat = position.coords.latitude;
      const lon = position.coords.longitude;
      
      // Outside service area: warn but keep real GPS (never fabricate coordinates)
      const distFromCenter = calculateDistance(lat, lon, 10.0345, 105.7876);
      const outsideArea = distFromCenter > 20;
      const indicatorText = outsideArea
        ? `<i class="fa-solid fa-triangle-exclamation" style="color:var(--clr-warning,#f59e0b)"></i> GPS: Ngoài khu vực Cần Thơ (${lat.toFixed(5)}, ${lon.toFixed(5)})`
        : `<i class="fa-solid fa-location-crosshairs"></i> GPS: (${lat.toFixed(5)}, ${lon.toFixed(5)})`;

      const now = Date.now();
      // Throttle GPS UI updates to reduce jank
      if (now - lastGpsUiUpdate >= 1500 || indicatorText !== lastGpsIndicatorText) {
        lastGpsUiUpdate = now;
        lastGpsIndicatorText = indicatorText;
        const el = document.getElementById('gps-indicator');
        if (el) el.innerHTML = indicatorText;
      }
      
      if (shipperMarker) {
        shipperMarker.setLatLng([lat, lon]);
      }
      // Only auto-follow when user hasn't panned the map
      if (tripMap && mapFollowGps) {
        tripMap.setView([lat, lon], tripMap.getZoom() || 16, { animate: false });
      }
      
      // Gửi GPS thường xuyên hơn để app khách theo dõi vị trí thật mượt hơn
      if (now - lastGpsSendTime >= 3000) {
        lastGpsSendTime = now;
        sendLocationToServer(lat, lon);
      }
    },
    (error) => {
      console.warn('Geolocation error:', error);
      const el = document.getElementById('gps-indicator');
      if (el) el.innerHTML = `<i class="fa-solid fa-circle-exclamation" style="color:var(--clr-danger)"></i> GPS: Không thể lấy vị trí (${escapeHtml(error.message)})`;
    },
    {
      enableHighAccuracy: true,
      maximumAge: 3000,
      // iOS Safari cold GPS regularly needs >15s on first fix
      timeout: (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
        ? 28000
        : 18000
    }
  );
}

function stopGpsTracking() {
  if (watchPositionId !== null) {
    navigator.geolocation.clearWatch(watchPositionId);
    watchPositionId = null;
  }
}

async function sendLocationToServer(lat, lon) {
  try {
    // Cập nhật GPS cho mọi đơn đang chạy (tối đa 2)
    if (activeOrders.length > 0) {
      await Promise.all(activeOrders.map(order =>
        apiFetch(`${API_BASE}/api/orders/${order.id}/location`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lat, lon })
        }, 8000).catch(err => console.warn(`[GPS] Lỗi gửi đơn ${order.id}:`, err.message))
      ));
    }
    // Vẫn cập nhật vị trí tài xế (để dispatch chọn khoảng cách)
    if (isOnline && currentDriver) {
      await apiFetch(`${API_BASE}/api/shippers/location`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          phone: currentDriver.phone,
          lat,
          lon
        })
      }, 8000);
    }
  } catch (e) {
    console.warn('Không thể gửi GPS lên server:', e.message);
  }
}

// ── TARGETED JOB OFFER LOGIC ────────────────────────────────────────────────
function handleTargetedOffer(offer) {
  if (!offer) {
    if (targetedOffer) {
      clearOfferTimer();
      stopOrderAlertLoop();
      const offerOverlay = document.getElementById('job-offer-overlay');
      if (offerOverlay && offerOverlay.classList.contains('active')) {
        offerOverlay.classList.remove('active');
        unlockBodyScroll();
      }
      targetedOffer = null;
      showToast('Đơn đề xuất đã hết hạn ⏰', 'Đơn đề xuất đã được nhận bởi tài xế khác hoặc hết thời gian.', 'info');
    }
    return;
  }

  if (!targetedOffer || targetedOffer.id !== offer.id) {
    targetedOffer = offer;
    
    document.getElementById('offer-restaurant-name').textContent = offer.restaurantName;
    document.getElementById('offer-restaurant-address').textContent = offer.restaurantAddress;
    document.getElementById('offer-customer-address').textContent = offer.deliveryAddress;
    document.getElementById('offer-earning').textContent = formatCurrency(offer.shipperEarning);
    document.getElementById('offer-app-total').textContent = formatCurrency(offer.appTotal);
    document.getElementById('offer-store-total').textContent = formatCurrency(offer.storeTotal);

    const titleText = document.getElementById('offer-title-text');
    const batchBanner = document.getElementById('offer-batch-banner');
    const swipeText = document.getElementById('offer-swipe-text');
    if (activeOrders.length === 1) {
      const current = activeOrders[0];
      const isPurchased = current.status === 'PURCHASED';
      if (titleText) titleText.textContent = 'ĐƠN GHÉP GẦN TUYẾN!';
      if (batchBanner) {
        batchBanner.style.display = 'block';
        batchBanner.innerHTML = isPurchased
          ? `<i class="fa-solid fa-route"></i> Ghép đơn gần <strong>khách đang giao</strong> (${escapeHtml(current.id)}). Tối đa 2 đơn.`
          : `<i class="fa-solid fa-link"></i> Ghép đơn gần tuyến đơn đang chạy (${escapeHtml(current.id)}). Tối đa 2 đơn.`;
      }
      if (swipeText) swipeText.textContent = '👉 Vuốt để nhận đơn ghép';
    } else {
      if (titleText) titleText.textContent = 'ĐƠN ĐỀ XUẤT CHO BẠN!';
      if (batchBanner) {
        batchBanner.style.display = 'none';
        batchBanner.innerHTML = '';
      }
      if (swipeText) swipeText.textContent = '👉 Vuốt sang phải để nhận đơn';
    }

    const noteBox = document.getElementById('offer-note-box');
    const noteText = document.getElementById('offer-note-text');
    if (noteBox && noteText) {
      if (offer.note && offer.note.trim()) {
        noteText.textContent = offer.note;
        noteBox.style.display = 'block';
      } else {
        noteText.textContent = '—';
        noteBox.style.display = 'none';
      }
    }

    document.getElementById('job-offer-overlay').classList.add('active');
    lockBodyScroll();

    initSwipeButton('offer-swipe-container', 'offer-swipe-handle', 'offer-swipe-text', () => {
      document.getElementById('job-offer-overlay').classList.remove('active');
      unlockBodyScroll();
      clearOfferTimer();
      stopOrderAlertLoop();
      targetedOffer = null;
      acceptOrder(offer.id);
    });

    startOfferTimer(offer.offerExpiresAt);
    
    startOrderAlertLoop();
    showToast(
      activeOrders.length === 1 ? 'Đơn ghép gần tuyến! 📦' : 'Đơn Đề Xuất Mới! 🎯',
      activeOrders.length === 1
        ? 'Có đơn thứ 2 phù hợp tuyến đang chạy. Vuốt để nhận.'
        : 'Có đơn hàng dành riêng cho bạn! Hãy nhận ngay.',
      'warning'
    );
  }
}

function startOfferTimer(expiresAt) {
  clearOfferTimer();
  
  const progressBar = document.getElementById('offer-progress-bar');
  const timerSeconds = document.getElementById('offer-timer-seconds');
  const totalDuration = 30000;
  let endAt = Number(expiresAt);
  if (!Number.isFinite(endAt) || endAt <= Date.now()) {
    endAt = Date.now() + totalDuration;
  }

  function updateTimer() {
    const remaining = endAt - Date.now();
    if (remaining <= 0) {
      clearOfferTimer();
      declineTargetedOffer(true);
      return;
    }
    
    const pct = Math.max(0, (remaining / totalDuration) * 100);
    if (progressBar) progressBar.style.width = `${pct}%`;
    if (timerSeconds) timerSeconds.textContent = `${Math.ceil(remaining / 1000)}s`;
  }

  updateTimer();
  offerTimerInterval = setInterval(updateTimer, 200);
}

function clearOfferTimer() {
  if (offerTimerInterval) {
    clearInterval(offerTimerInterval);
    offerTimerInterval = null;
  }
  stopOrderAlertLoop();
}

async function declineTargetedOffer(isAuto = false) {
  if (!targetedOffer) return;
  const offerId = targetedOffer.id;
  
  clearOfferTimer();
  stopOrderAlertLoop();
  const offerOverlay = document.getElementById('job-offer-overlay');
  if (offerOverlay && offerOverlay.classList.contains('active')) {
    offerOverlay.classList.remove('active');
    unlockBodyScroll();
  }
  targetedOffer = null;

  try {
    const res = await fetch(`${API_BASE}/api/orders/${offerId}/decline`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ phone: currentDriver.phone })
    });
    
    if (res.ok) {
      stats.declined++;
      saveStats();
      if (isAuto) {
        showToast('Trôi đơn hàng ⏰', 'Yêu cầu đề xuất đã tự động trôi qua do hết thời gian.', 'info');
      } else {
        showToast('Đã từ chối đơn', `Bạn đã bỏ qua đơn đề xuất ${offerId}.`, 'info');
      }
    }
  } catch (e) {
    console.warn('Lỗi khi từ chối đơn hàng:', e.message);
  } finally {
    syncAllData();
  }
}

window.declineTargetedOffer = declineTargetedOffer;

// ── QUICK CHAT MESSAGES ─────────────────────────────────────────────────────
function openQuickChat() {
  if (!activeOrder) {
    showToast('Không có chuyến đi', 'Bạn cần có chuyến đi đang hoạt động để chat.', 'warning');
    return;
  }
  const overlay = document.getElementById('chat-overlay');
  if (overlay && !overlay.classList.contains('active')) {
    overlay.classList.add('active');
    lockBodyScroll();
  }
  bindChatKeyboardAvoidance();
  lastChatFingerprint = getChatFingerprint(activeOrder);
  renderShipperChatMessages();
  setTimeout(() => {
    const box = document.getElementById('shipper-chat-messages-box');
    if (box) box.scrollTop = box.scrollHeight;
  }, 50);
}

function closeQuickChat() {
  const overlay = document.getElementById('chat-overlay');
  if (overlay && overlay.classList.contains('active')) {
    overlay.classList.remove('active');
    unlockBodyScroll();
  }
  unbindChatKeyboardAvoidance();
}

function renderShipperChatMessages() {
  const box = document.getElementById('shipper-chat-messages-box');
  if (!box) return;

  if (!activeOrder) {
    box.innerHTML = `<div style="color: var(--clr-text-muted); text-align: center; font-size: 11px; margin-top: 40px;">Không có đơn hàng hoạt động</div>`;
    return;
  }

  if (!activeOrder.messages || activeOrder.messages.length === 0) {
    box.innerHTML = `<div style="color: var(--clr-text-muted); text-align: center; font-size: 11px; margin-top: 40px;">Chưa có tin nhắn nào</div>`;
    return;
  }

  const html = activeOrder.messages.map(msg => {
    const role = String(msg.role || '').toLowerCase();
    const sender = String(msg.sender || '').toLowerCase();
    const isMe = sender === 'shipper' || role === 'shipper';
    const isAdmin = sender === 'admin' || role === 'admin' || sender === 'crm'
      || String(msg.sender || '') === 'Admin';
    let alignStyle;
    let senderName;
    if (isMe) {
      alignStyle = 'align-self: flex-end; background: var(--clr-primary); color: white;';
      senderName = 'Bạn';
    } else if (isAdmin) {
      alignStyle = 'align-self: flex-start; background: rgba(16, 185, 129, 0.12); color: var(--clr-text-primary); border: 1px solid rgba(16, 185, 129, 0.25);';
      senderName = 'CRM';
    } else {
      alignStyle = 'align-self: flex-start; background: rgba(255,255,255,0.1); color: var(--clr-text-primary);';
      senderName = 'Khách hàng';
    }
    return `
      <div style="max-width: 80%; padding: 8px 12px; border-radius: var(--radius-md); font-size: 12px; ${alignStyle} display: flex; flex-direction: column; gap: 3px;">
        <span style="font-weight: 700; opacity: 0.8; font-size: 10px;">${senderName}</span>
        <span>${escapeHtml(msg.text)}</span>
      </div>
    `;
  }).join('');

  const shouldScroll = box.scrollTop + box.clientHeight >= box.scrollHeight - 50 || box.innerHTML.includes('Chưa có tin nhắn');
  box.innerHTML = html;
  if (shouldScroll) {
    box.scrollTop = box.scrollHeight;
  }
}

async function sendQuickMessage(text) {
  if (!activeOrder || chatSendInFlight) return;
  chatSendInFlight = true;
  try {
    const res = await apiFetch(`${API_BASE}/api/orders/${activeOrder.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender: 'shipper',
        text: text
      })
    }, 10000);
    const result = await safeJson(res);
    if (res.ok && result.success) {
      activeOrder.messages = result.messages;
      lastChatFingerprint = getChatFingerprint(activeOrder);
      renderShipperChatMessages();
      showToast('Đã gửi tin nhắn', `Đã gửi: "${text}"`, 'success');
    } else {
      showToast('Lỗi gửi tin nhắn', result.error || 'Không thể gửi tin nhắn.', 'error');
    }
  } catch (e) {
    console.error('Lỗi gửi chat:', e);
    showToast('Lỗi kết nối', 'Không thể kết nối với server.', 'error');
  } finally {
    chatSendInFlight = false;
  }
}

async function sendShipperCustomMessage() {
  const input = document.getElementById('shipper-chat-input');
  if (!input || chatSendInFlight) return;
  const text = input.value.trim();
  if (!text) return;
  if (!activeOrder) return;

  chatSendInFlight = true;
  input.disabled = true;
  try {
    const res = await apiFetch(`${API_BASE}/api/orders/${activeOrder.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender: 'shipper',
        text: text
      })
    }, 10000);
    const result = await safeJson(res);
    if (res.ok && result.success) {
      input.value = '';
      activeOrder.messages = result.messages;
      lastChatFingerprint = getChatFingerprint(activeOrder);
      renderShipperChatMessages();
    } else {
      showToast('Lỗi gửi tin nhắn', result.error || 'Không thể gửi tin nhắn.', 'error');
    }
  } catch (e) {
    console.error('Lỗi gửi chat:', e);
    showToast('Lỗi kết nối', 'Không thể kết nối với server.', 'error');
  } finally {
    chatSendInFlight = false;
    input.disabled = false;
    input.focus();
  }
}

// ── SWIPE GESTURE MECHANICS ─────────────────────────────────────────────────
function initSwipeButton(containerId, handleId, textId, onSwipeComplete) {
  const container = document.getElementById(containerId);
  const handle = document.getElementById(handleId);
  const text = document.getElementById(textId);
  
  if (!container || !handle) return;
  
  // Clean up any old listeners to prevent leak/multiple bindings
  if (handle._swipeCleanup) {
    handle._swipeCleanup();
  }

  let isDragging = false;
  let startX = 0;
  let currentX = 0;
  
  // Reset handle position
  handle.style.transform = 'translateX(0px)';
  if (text) text.style.opacity = '1';
  
  function getEventX(e) {
    return e.touches ? e.touches[0].clientX : e.clientX;
  }
  
  function dragStart(e) {
    isDragging = true;
    startX = getEventX(e);
    handle.style.transition = 'none';
  }
  
  function dragMove(e) {
    if (!isDragging) return;
    const clientX = getEventX(e);
    const containerWidth = container.offsetWidth;
    const handleWidth = handle.offsetWidth;
    const maxDrag = containerWidth - handleWidth - 8;
    
    let delta = clientX - startX;
    if (delta < 0) delta = 0;
    if (delta > maxDrag) delta = maxDrag;
    
    currentX = delta;
    handle.style.transform = `translateX(${delta}px)`;
    
    if (text) {
      const opacity = 1 - (delta / maxDrag);
      text.style.opacity = opacity < 0 ? 0 : opacity;
    }
  }
  
  function dragEnd() {
    if (!isDragging) return;
    isDragging = false;
    
    const containerWidth = container.offsetWidth;
    const handleWidth = handle.offsetWidth;
    const maxDrag = containerWidth - handleWidth - 8;
    
    handle.style.transition = 'transform 0.15s cubic-bezier(0.25, 0.8, 0.25, 1)';
    
    if (currentX >= maxDrag * 0.90) {
      handle.style.transform = `translateX(${maxDrag}px)`;
      if (text) text.style.opacity = '0';
      
      // Full cleanup of all listeners (including window) to prevent leaks
      if (handle._swipeCleanup) handle._swipeCleanup();
      
      setTimeout(() => {
        onSwipeComplete();
      }, 200);
    } else {
      handle.style.transform = 'translateX(0px)';
      if (text) text.style.opacity = '1';
      currentX = 0;
    }
  }
  
  handle.addEventListener('mousedown', dragStart);
  window.addEventListener('mousemove', dragMove);
  window.addEventListener('mouseup', dragEnd);
  
  handle.addEventListener('touchstart', dragStart, { passive: true });
  window.addEventListener('touchmove', dragMove, { passive: false });
  window.addEventListener('touchend', dragEnd);
  
  // Store cleanup callback
  handle._swipeCleanup = () => {
    handle.removeEventListener('mousedown', dragStart);
    window.removeEventListener('mousemove', dragMove);
    window.removeEventListener('mouseup', dragEnd);
    handle.removeEventListener('touchstart', dragStart);
    window.removeEventListener('touchmove', dragMove);
    window.removeEventListener('touchend', dragEnd);
  };
}

// ── AUDIO NOTIFICATION SYNTHESIZER (iOS / Android — to, rõ, unlock ổn định) ─
let sharedAudioCtx = null;
let audioUnlocked = false;
let orderAlertInterval = null;
let audioKeepAliveTimer = null;
let htmlOrderAudio = null;
let htmlChatAudio = null;

function getSharedAudioCtx() {
  if (!sharedAudioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      sharedAudioCtx = new AC({ latencyHint: 'interactive' });
    } catch (e) {
      sharedAudioCtx = new AC();
    }
  }
  if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

/** Tạo WAV data-URI (PCM 16-bit mono) — HTMLAudio fallback cho iOS */
function buildToneWavDataUri(sequence, sampleRate = 22050) {
  // sequence: [{ freq, dur, vol, wave?: 'sine'|'square' }, ...]
  let totalSamples = 0;
  const parts = sequence.map((s) => {
    const n = Math.max(1, Math.floor(sampleRate * s.dur));
    totalSamples += n;
    return { ...s, n };
  });
  const samples = new Int16Array(totalSamples);
  let offset = 0;
  for (const part of parts) {
    const vol = Math.min(1, Math.max(0, part.vol == null ? 1 : part.vol));
    const wave = part.wave || 'square';
    for (let i = 0; i < part.n; i++) {
      const t = i / sampleRate;
      // Sustain gần max volume (chỉ fade rất ngắn đầu/cuối) — tránh tiếng bip nhỏ
      const attack = Math.min(1, i / Math.max(1, sampleRate * 0.008));
      const release = Math.min(1, (part.n - i) / Math.max(1, sampleRate * 0.02));
      const env = Math.min(attack, release);
      let raw;
      if (wave === 'silence') {
        raw = 0;
      } else if (wave === 'sine') {
        raw = Math.sin(2 * Math.PI * part.freq * t);
      } else {
        // square — to và xuyên hơn trên loa điện thoại
        raw = ((t * part.freq) % 1 < 0.5) ? 1 : -1;
      }
      samples[offset++] = Math.max(-32767, Math.min(32767, raw * vol * env * 32767));
    }
  }
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (o, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(o + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return 'data:audio/wav;base64,' + btoa(binary);
}

/** Chuỗi chuông báo đơn dài ~4s: ring-ring × 3 (to, square) */
function buildOrderRingtoneSequence() {
  const seq = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    // ring 1 (~0.55s)
    seq.push({ freq: 880, dur: 0.28, vol: 1, wave: 'square' });
    seq.push({ freq: 1175, dur: 0.28, vol: 1, wave: 'square' });
    seq.push({ freq: 0, dur: 0.14, vol: 0, wave: 'silence' });
    // ring 2 (~0.55s)
    seq.push({ freq: 988, dur: 0.28, vol: 1, wave: 'square' });
    seq.push({ freq: 1319, dur: 0.28, vol: 1, wave: 'square' });
    // nghỉ giữa chu kỳ
    seq.push({ freq: 0, dur: 0.32, vol: 0, wave: 'silence' });
  }
  return seq;
}

const ORDER_AUDIO_VER = 4;
let htmlOrderAudioVer = 0;

function ensureHtmlAlertPlayers() {
  if (!htmlOrderAudio || htmlOrderAudioVer !== ORDER_AUDIO_VER) {
    htmlOrderAudioVer = ORDER_AUDIO_VER;
    try { if (htmlOrderAudio) { htmlOrderAudio.pause(); htmlOrderAudio.src = ''; } } catch (e) { /* ignore */ }
    htmlOrderAudio = new Audio(buildToneWavDataUri(buildOrderRingtoneSequence()));
    htmlOrderAudio.setAttribute('playsinline', 'true');
    htmlOrderAudio.setAttribute('webkit-playsinline', 'true');
    htmlOrderAudio.preload = 'auto';
    htmlOrderAudio.volume = 1;
  }
  if (!htmlChatAudio) {
    htmlChatAudio = new Audio(buildToneWavDataUri([
      { freq: 988, dur: 0.14, vol: 1, wave: 'square' },
      { freq: 1318.5, dur: 0.22, vol: 1, wave: 'square' }
    ]));
    htmlChatAudio.setAttribute('playsinline', 'true');
    htmlChatAudio.setAttribute('webkit-playsinline', 'true');
    htmlChatAudio.preload = 'auto';
    htmlChatAudio.volume = 1;
  }
}

function playHtmlAlert(kind) {
  try {
    ensureHtmlAlertPlayers();
    const el = kind === 'chat' ? htmlChatAudio : htmlOrderAudio;
    if (!el) return Promise.resolve();
    el.pause();
    el.currentTime = 0;
    el.muted = false;
    el.volume = 1;
    const p = el.play();
    return p && typeof p.then === 'function' ? p.catch(() => {}) : Promise.resolve();
  } catch (e) {
    return Promise.resolve();
  }
}

function vibrateAlert(pattern) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch (e) { /* ignore */ }
}

function unlockAudio(fromKeepAlive) {
  const ctx = getSharedAudioCtx();
  ensureHtmlAlertPlayers();

  const finish = () => {
    audioUnlocked = true;
    if (!fromKeepAlive) startAudioKeepAlive();
  };

  try {
    if (ctx) {
      const resumeP = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();
      resumeP.then(() => {
        // Buffer gần im lặng nhưng không zero — iOS cần “real” playback để unlock
        const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 0.05)), ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.0008;
        const source = ctx.createBufferSource();
        const gain = ctx.createGain();
        gain.gain.value = 0.001;
        source.buffer = buffer;
        source.connect(gain);
        gain.connect(ctx.destination);
        source.start(0);
        finish();
      }).catch(() => finish());
    } else {
      finish();
    }
  } catch (e) {
    finish();
  }

  // Unlock HTMLAudioElement song song (quan trọng trên iOS Safari/PWA)
  try {
    [htmlOrderAudio, htmlChatAudio].forEach((el) => {
      if (!el) return;
      const prevVol = el.volume;
      el.muted = true;
      el.volume = 0;
      const p = el.play();
      const reset = () => {
        try {
          el.pause();
          el.currentTime = 0;
          el.muted = false;
          el.volume = prevVol || 1;
        } catch (err) { /* ignore */ }
      };
      if (p && typeof p.then === 'function') p.then(reset).catch(reset);
      else reset();
    });
  } catch (e) { /* ignore */ }
}

function startAudioKeepAlive() {
  if (audioKeepAliveTimer) return;
  // Giữ AudioContext / session sống khi tài xế đang trong ca (poll nền)
  audioKeepAliveTimer = setInterval(() => {
    if (!isOnline) return;
    const ctx = getSharedAudioCtx();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    if (!audioUnlocked) unlockAudio(true);
  }, 20000);
}

function stopAudioKeepAlive() {
  if (audioKeepAliveTimer) {
    clearInterval(audioKeepAliveTimer);
    audioKeepAliveTimer = null;
  }
}

function bindAudioUnlockGestures() {
  const handler = () => {
    if (!audioUnlocked) {
      unlockAudio(false);
      return;
    }
    const ctx = getSharedAudioCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  };
  ['touchstart', 'pointerdown', 'click'].forEach((evt) => {
    document.addEventListener(evt, handler, { passive: true, capture: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      unlockAudio(false);
      const ctx = getSharedAudioCtx();
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    }
  });
  window.addEventListener('pageshow', () => unlockAudio(false));
  window.addEventListener('focus', () => unlockAudio(false));
}
bindAudioUnlockGestures();

function playOscBurst(ctx, { freq, type = 'square', start, dur, peak = 0.95 }) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  // Không lọc thấp — giữ square full để to trên loa điện thoại
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  // Sustain gần max suốt duration (tránh bip ngắn bị cắt sớm)
  const peakSafe = Math.max(0.001, Math.min(1, peak));
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peakSafe, start + 0.02);
  gain.gain.setValueAtTime(peakSafe, start + Math.max(0.05, dur - 0.05));
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + dur + 0.03);
}

/** Chuông báo đơn dài ~4s: ring-ring × 3, dual-tone max volume */
function triggerOrderRingtone(ctx) {
  const t0 = ctx.currentTime;
  for (let cycle = 0; cycle < 3; cycle++) {
    const base = t0 + cycle * 1.35;
    // Ring 1 — dual square rất to
    playOscBurst(ctx, { freq: 880.0, type: 'square', start: base, dur: 0.55, peak: 1.0 });
    playOscBurst(ctx, { freq: 1174.66, type: 'square', start: base, dur: 0.55, peak: 0.92 });
    // Ring 2
    playOscBurst(ctx, { freq: 987.77, type: 'square', start: base + 0.7, dur: 0.55, peak: 1.0 });
    playOscBurst(ctx, { freq: 1318.51, type: 'square', start: base + 0.7, dur: 0.55, peak: 0.92 });
  }
}

function triggerChime(ctx) {
  triggerOrderRingtone(ctx);
}

function triggerMessageChime(ctx) {
  const t0 = ctx.currentTime;
  playOscBurst(ctx, { freq: 988.0, type: 'square', start: t0, dur: 0.14, peak: 0.95 });
  playOscBurst(ctx, { freq: 1318.5, type: 'square', start: t0 + 0.16, dur: 0.28, peak: 1.0 });
  playOscBurst(ctx, { freq: 659.25, type: 'triangle', start: t0 + 0.16, dur: 0.28, peak: 0.55 });
}

function playChimeSound() {
  try {
    unlockAudio(false);
    // Rung dài hơn để dễ nhận khi âm lượng thấp / silent
    vibrateAlert([500, 150, 500, 150, 500, 150, 700]);
    const ctx = getSharedAudioCtx();
    // HTMLAudio chuông dài ~4s (chính trên iOS) + WebAudio dual-tone (lớn hơn)
    playHtmlAlert('order');
    const run = () => {
      if (ctx) triggerOrderRingtone(ctx);
    };
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().then(run).catch(() => {});
    } else {
      run();
    }
  } catch (e) {
    console.warn('Audio play failed:', e);
    playHtmlAlert('order');
    vibrateAlert([500, 150, 500, 150, 700]);
  }
}

function playMessageChimeSound() {
  try {
    unlockAudio(false);
    const ctx = getSharedAudioCtx();
    const run = () => {
      if (ctx) triggerMessageChime(ctx);
      playHtmlAlert('chat');
    };
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().then(run).catch(() => playHtmlAlert('chat'));
    } else {
      run();
    }
    vibrateAlert([100, 50, 120]);
  } catch (e) {
    console.warn('Audio play failed:', e);
    playHtmlAlert('chat');
    vibrateAlert([100, 50, 120]);
  }
}

/** Lặp chuông khi có đơn đề xuất — mỗi chu kỳ ~4.2s */
const ORDER_RING_LOOP_MS = 4300;

function startOrderAlertLoop() {
  stopOrderAlertLoop();
  playChimeSound();
  orderAlertInterval = setInterval(() => {
    const overlay = document.getElementById('job-offer-overlay');
    if (!overlay || !overlay.classList.contains('active')) {
      stopOrderAlertLoop();
      return;
    }
    playChimeSound();
  }, ORDER_RING_LOOP_MS);
}

function stopOrderAlertLoop() {
  if (orderAlertInterval) {
    clearInterval(orderAlertInterval);
    orderAlertInterval = null;
  }
}

// ── DRIVER STATS PERSISTENCE ────────────────────────────────────────────────
function statsStorageKey(phone) {
  return `shipfee_shipper_stats_${cleanPhone(phone)}`;
}

function statsEpochKey(phone) {
  return `shipfee_shipper_stats_epoch_${cleanPhone(phone)}`;
}

function emptyStats() {
  return { accepted: 0, declined: 0, completed: 0 };
}

function loadStats() {
  try {
    if (!currentDriver) {
      stats = emptyStats();
      return;
    }
    const phone = currentDriver.phone;
    const key = statsStorageKey(phone);
    const epochKey = statsEpochKey(phone);
    const storedEpoch = localStorage.getItem(epochKey);

    // Epoch mới (go-live) → xoá bộ đếm AR/CR cũ trên máy, không lấy từ đơn hàng
    if (storedEpoch !== STATS_EPOCH) {
      stats = emptyStats();
      localStorage.setItem(key, JSON.stringify(stats));
      localStorage.setItem(epochKey, STATS_EPOCH);
      syncStatsToServer();
      return;
    }

    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      stats = {
        accepted: Number(parsed.accepted) || 0,
        declined: Number(parsed.declined) || 0,
        completed: Number(parsed.completed) || 0
      };
    } else {
      stats = emptyStats();
    }
  } catch (e) {
    stats = emptyStats();
  }
}

function saveStats() {
  try {
    if (!currentDriver) return;
    const phone = currentDriver.phone;
    localStorage.setItem(statsStorageKey(phone), JSON.stringify(stats));
    localStorage.setItem(statsEpochKey(phone), STATS_EPOCH);
    syncStatsToServer(); // Tự động đồng bộ lên CRM server
  } catch (e) {}
}

async function syncStatsToServer() {
  if (!currentDriver) return;
  try {
    const key = statsStorageKey(currentDriver.phone);
    const raw = localStorage.getItem(key);
    let statsObj = emptyStats();
    if (raw) statsObj = JSON.parse(raw);

    const totalOffers = statsObj.accepted + statsObj.declined;
    const arPercentage = clampPercent(totalOffers > 0 ? (statsObj.accepted / totalOffers) * 100 : 100);
    const crPercentage = clampPercent(statsObj.accepted > 0 ? (statsObj.completed / statsObj.accepted) * 100 : 100);

    let totalEarnings = 0;
    if (Array.isArray(historyOrders)) {
      historyOrders.forEach(o => {
        totalEarnings += o.shipperEarning || 0;
      });
    }
    const totalOrders = Array.isArray(historyOrders) ? historyOrders.length : 0;

    const response = await fetch(`${API_BASE}/api/shippers/stats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        phone: currentDriver.phone,
        stats: statsObj,
        totalOrders,
        totalEarnings,
        acceptanceRate: arPercentage,
        completionRate: crPercentage
      })
    });
    
    const res = await response.json();
    if (res.success) {
      console.log('[Stats Sync] Đã đồng bộ hiệu năng lên server.');
    }
  } catch (err) {
    console.warn('[Stats Sync Fallback] Không thể đồng bộ hiệu năng:', err.message);
  }
}

// ── STATS & HISTORY TAB ─────────────────────────────────────────────────────
function startOfLocalDay(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfLocalMonth(ts = Date.now()) {
  const d = new Date(ts);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayKey(ts) {
  const d = new Date(ts || 0);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDayLabel(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  if (!y || !m || !d) return key;
  const todayKey = dayKey(Date.now());
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = dayKey(yesterday.getTime());
  if (key === todayKey) return `Hôm nay · ${d}/${m}`;
  if (key === yesterdayKey) return `Hôm qua · ${d}/${m}`;
  return `${d}/${m}/${y}`;
}

function filterHistoryByPeriod(orders, period) {
  const list = Array.isArray(orders) ? orders : [];
  const now = Date.now();
  if (period === '7d') {
    const from = startOfLocalDay(now - 6 * 24 * 60 * 60 * 1000);
    return list.filter(o => (o.deliveredAt || o.createdAt || 0) >= from);
  }
  if (period === 'month') {
    const from = startOfLocalMonth(now);
    return list.filter(o => (o.deliveredAt || o.createdAt || 0) >= from);
  }
  const todayStart = startOfLocalDay(now);
  return list.filter(o => (o.deliveredAt || o.createdAt || 0) >= todayStart);
}

function groupOrdersByDay(orders) {
  const map = new Map();
  (orders || []).forEach(o => {
    const key = dayKey(o.deliveredAt || o.createdAt || 0);
    if (!map.has(key)) {
      map.set(key, {
        key,
        orders: [],
        earning: 0,
        store: 0,
        cod: 0
      });
    }
    const row = map.get(key);
    row.orders.push(o);
    row.earning += o.shipperEarning || 0;
    row.store += o.storeTotal || 0;
    row.cod += o.appTotal || 0;
  });
  return Array.from(map.values()).sort((a, b) => (a.key < b.key ? 1 : -1));
}

function setPerfPeriod(period) {
  const next = (period === '7d' || period === 'month') ? period : 'today';
  if (perfPeriodFilter === next) return;
  perfPeriodFilter = next;
  expandedPerfDays.clear();
  lastHistoryFingerprint = '';
  document.querySelectorAll('.perf-period__btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.getAttribute('data-period') === next);
  });
  renderHistoryAndStats();
}
window.setPerfPeriod = setPerfPeriod;

function togglePerfDayExpand(dayKey) {
  if (!dayKey) return;
  if (expandedPerfDays.has(dayKey)) expandedPerfDays.delete(dayKey);
  else expandedPerfDays.add(dayKey);

  const card = Array.from(document.querySelectorAll('.history-card--day'))
    .find(el => el.dataset.day === dayKey);
  if (!card) {
    lastHistoryFingerprint = '';
    renderHistoryAndStats();
    return;
  }
  const open = expandedPerfDays.has(dayKey);
  card.classList.toggle('is-expanded', open);
  card.setAttribute('aria-expanded', open ? 'true' : 'false');
  const panel = card.querySelector('.history-day__orders');
  if (panel) panel.hidden = !open;
  const hint = card.querySelector('.history-day__hint');
  if (hint) hint.textContent = open ? 'Bấm để thu gọn' : 'Bấm để xem từng đơn';
  const chevron = card.querySelector('.history-day__chevron');
  if (chevron) chevron.setAttribute('aria-expanded', open ? 'true' : 'false');
}
window.togglePerfDayExpand = togglePerfDayExpand;

function openPerfDetailSheet() {
  const overlay = document.getElementById('perf-detail-overlay');
  if (!overlay) return;
  perfDetailOpen = true;
  lastHistoryFingerprint = '';
  if (!overlay.classList.contains('active')) {
    overlay.classList.add('active');
    lockBodyScroll();
  }
  renderHistoryAndStats();
}
window.openPerfDetailSheet = openPerfDetailSheet;

function closePerfDetailSheet() {
  const overlay = document.getElementById('perf-detail-overlay');
  if (overlay && overlay.classList.contains('active')) {
    overlay.classList.remove('active');
    unlockBodyScroll();
  }
  perfDetailOpen = false;
  expandedPerfDays.clear();
  lastHistoryFingerprint = '';
  // Cập nhật lại tổng trên tab chính (không render list)
  renderHistoryAndStats();
}
window.closePerfDetailSheet = closePerfDetailSheet;

/** @deprecated dùng open/close sheet */
function togglePerfDetail() {
  const overlay = document.getElementById('perf-detail-overlay');
  if (overlay && overlay.classList.contains('active')) closePerfDetailSheet();
  else openPerfDetailSheet();
}
window.togglePerfDetail = togglePerfDetail;

function applyPerfDetailVisibility() {
  // Chi tiết chỉ nằm trong bottom sheet — tab chính luôn chỉ hiện tổng
  const board = document.getElementById('money-board');
  if (board) board.classList.remove('money-board--detail-open');
}

function clampPercent(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function renderHistoryAndStats() {
  const fingerprint = [
    perfPeriodFilter,
    perfDetailOpen ? '1' : '0',
    historyOrders.length,
    historyOrders.map(o => `${o.id}:${o.rating || 0}:${o.shipperEarning || 0}:${o.storeTotal || 0}:${o.appTotal || 0}`).join(','),
    stats.accepted || 0,
    stats.declined || 0,
    stats.completed || 0
  ].join('|');
  if (fingerprint === lastHistoryFingerprint) return;
  lastHistoryFingerprint = fingerprint;

  applyPerfDetailVisibility();

  const filtered = filterHistoryByPeriod(historyOrders, perfPeriodFilter);
  const totalOrders = filtered.length;

  let totalEarnings = 0;
  let totalStore = 0;
  let totalCod = 0;
  let totalRatings = 0;
  let ratedCount = 0;

  filtered.forEach(o => {
    totalEarnings += o.shipperEarning || 0;
    totalStore += o.storeTotal || 0;
    totalCod += o.appTotal || 0;
    if (o.rating) {
      totalRatings += o.rating;
      ratedCount++;
    }
  });

  const avgRating = ratedCount > 0 ? (totalRatings / ratedCount).toFixed(1) + '★' : '—';

  const totalOffers = (stats.accepted || 0) + (stats.declined || 0);
  const arRaw = totalOffers > 0 ? ((stats.accepted || 0) / totalOffers) * 100 : 100;
  const crRaw = (stats.accepted || 0) > 0
    ? ((stats.completed || 0) / stats.accepted) * 100
    : 100;
  const arPercentage = clampPercent(arRaw);
  const crPercentage = clampPercent(crRaw);

  const periodLabels = { today: 'Hôm nay', '7d': '7 ngày gần đây', month: 'Tháng này' };
  const periodEl = document.getElementById('stats-period-label');
  if (periodEl) periodEl.textContent = periodLabels[perfPeriodFilter] || 'Hôm nay';
  const sheetPeriodEl = document.getElementById('sheet-period-label');
  if (sheetPeriodEl) sheetPeriodEl.textContent = periodLabels[perfPeriodFilter] || 'Hôm nay';
  const sheetSub = document.getElementById('perf-detail-sheet-sub');
  if (sheetSub) {
    sheetSub.textContent = perfPeriodFilter === 'today'
      ? 'Tiền quán · tiền khách · từng đơn'
      : 'Tổng theo ngày — bấm ngày để xem từng đơn';
  }

  const headingEl = document.getElementById('history-section-heading');
  if (headingEl) {
    headingEl.textContent = perfPeriodFilter === 'today'
      ? 'Chi tiết từng đơn'
      : 'Chi tiết theo ngày';
  }

  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  setText('stats-total-orders', String(totalOrders));
  setText('stats-total-earnings', formatCurrency(totalEarnings));
  setText('sheet-total-earnings', formatCurrency(totalEarnings));
  setText('stats-store-total', formatCurrency(totalStore));
  setText('stats-cod-total', formatCurrency(totalCod));
  setText('stats-avg-rating', avgRating);
  setText('stats-acceptance-rate', arPercentage + '%');
  setText('stats-completion-rate', crPercentage + '%');
  setText('stats-acceptance-rate-lg', arPercentage + '%');
  setText('stats-completion-rate-lg', crPercentage + '%');
  setText('stats-ar-detail', `${stats.accepted || 0} nhận / ${totalOffers} đề xuất`);
  setText('stats-cr-detail', `${stats.completed || 0} giao / ${stats.accepted || 0} nhận`);
  setText(
    'history-count-label',
    perfPeriodFilter === 'today'
      ? `${totalOrders} đơn`
      : `${groupOrdersByDay(filtered).length} ngày · ${totalOrders} đơn`
  );

  const arFill = document.getElementById('stats-acceptance-fill');
  const crFill = document.getElementById('stats-completion-fill');
  if (arFill) arFill.style.width = arPercentage + '%';
  if (crFill) crFill.style.width = crPercentage + '%';

  // Sheet đóng → không render danh sách breakdown
  if (!perfDetailOpen) {
    syncStatsToServer();
    return;
  }

  const container = document.getElementById('history-orders-list');
  if (!container) return;
  container.innerHTML = '';

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-clock-rotate-left"></i>
        <p>Chưa có đơn hoàn thành trong khoảng này.</p>
      </div>`;
    syncStatsToServer();
    return;
  }

  if (perfPeriodFilter === 'today') {
    filtered
      .slice()
      .sort((a, b) => (b.deliveredAt || b.createdAt || 0) - (a.deliveredAt || a.createdAt || 0))
      .forEach(order => {
        const card = document.createElement('div');
        card.className = 'history-card animate-fade-in';
        let feedbackHtml = '';
        if (order.rating) {
          let stars = '';
          for (let i = 1; i <= 5; i++) stars += i <= order.rating ? '★' : '☆';
          const note = order.comment
            ? escapeHtml(String(order.comment))
            : 'Khách không để lại ý kiến';
          feedbackHtml = `
            <div class="history-card__feedback">
              <span class="history-card__stars">${stars}</span>
              <span>${note}</span>
            </div>`;
        }
        card.innerHTML = `
          <div class="history-card__header">
            <span class="history-card__res">${escapeHtml(order.restaurantName || 'Quán')}</span>
            <span class="history-card__earning">+${formatCurrency(order.shipperEarning)}</span>
          </div>
          <div class="history-card__money">
            <span><i class="fa-solid fa-store"></i> Quán ${formatCurrency(order.storeTotal)}</span>
            <span><i class="fa-solid fa-wallet"></i> Khách ${formatCurrency(order.appTotal)}</span>
          </div>
          <div class="history-card__date">
            ${escapeHtml(String(order.id || ''))} · ${formatDate(order.deliveredAt || order.createdAt)}
          </div>
          ${feedbackHtml}
        `;
        container.appendChild(card);
      });
  } else {
    // 7 ngày / Tháng: chỉ hiện tổng theo ngày — bấm mới sổ từng đơn
    groupOrdersByDay(filtered).forEach(day => {
      const card = document.createElement('div');
      const isOpen = expandedPerfDays.has(day.key);
      card.className = `history-card history-card--day animate-fade-in${isOpen ? ' is-expanded' : ''}`;
      card.dataset.day = day.key;
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      card.addEventListener('click', () => togglePerfDayExpand(day.key));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          togglePerfDayExpand(day.key);
        }
      });

      const orderLines = day.orders
        .slice()
        .sort((a, b) => (b.deliveredAt || b.createdAt || 0) - (a.deliveredAt || a.createdAt || 0))
        .map(o => {
          let feedbackHtml = '';
          if (o.rating) {
            let stars = '';
            for (let i = 1; i <= 5; i++) stars += i <= o.rating ? '★' : '☆';
            feedbackHtml = `<div class="history-day__order-rating">${stars}</div>`;
          }
          return `
          <div class="history-day__order">
            <div class="history-day__order-top">
              <span>${escapeHtml(o.restaurantName || o.id || 'Đơn')}</span>
              <strong>+${formatCurrency(o.shipperEarning)}</strong>
            </div>
            <div class="history-day__order-money">
              Quán ${formatCurrency(o.storeTotal)} · Khách ${formatCurrency(o.appTotal)}
              · ${formatDate(o.deliveredAt || o.createdAt)}
            </div>
            ${feedbackHtml}
          </div>`;
        }).join('');

      card.innerHTML = `
        <div class="history-day__summary">
          <div class="history-card__header">
            <span class="history-card__res">${escapeHtml(formatDayLabel(day.key))}</span>
            <span class="history-day__right">
              <span class="history-card__earning">+${formatCurrency(day.earning)}</span>
              <i class="fa-solid fa-chevron-down history-day__chevron" aria-hidden="true"></i>
            </span>
          </div>
          <div class="history-card__money">
            <span><i class="fa-solid fa-store"></i> Quán ${formatCurrency(day.store)}</span>
            <span><i class="fa-solid fa-wallet"></i> Khách ${formatCurrency(day.cod)}</span>
            <span><i class="fa-solid fa-box"></i> ${day.orders.length} đơn</span>
          </div>
          <div class="history-day__hint">${isOpen ? 'Bấm để thu gọn' : 'Bấm để xem từng đơn'}</div>
        </div>
        <div class="history-day__orders" ${isOpen ? '' : 'hidden'}>${orderLines}</div>
      `;
      container.appendChild(card);
    });
  }

  syncStatsToServer();
}

// ── UTILITIES ───────────────────────────────────────────────────────────────
function formatCurrency(amount) {
  if (typeof amount !== 'number') return '0đ';
  return amount.toLocaleString('vi-VN') + 'đ';
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2, '0') + ':' +
         d.getMinutes().toString().padStart(2, '0');
}

function formatDate(ts) {
  const d = new Date(ts);
  return `${d.getDate()}/${d.getMonth()+1} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

// Toast notification
let toastContainer = null;
function showToast(title, message = '', type = 'info', duration = 3500) {
  toastContainer = document.getElementById('toast-container');
  if (!toastContainer) return;
  
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ' };
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.innerHTML = `
    <span class="toast__icon">${icons[type] || icons.info}</span>
    <div class="toast__text">
      ${title ? `<div style="font-weight:700;margin-bottom:2px;">${escapeHtml(title)}</div>` : ''}
      ${message ? `<div style="opacity:0.85;font-size:11px;">${escapeHtml(message)}</div>` : ''}
    </div>
    <button class="toast__close" onclick="this.parentElement.remove()">✕</button>
  `;
  toastContainer.appendChild(toast);
  if (duration > 0) setTimeout(() => toast.remove(), duration);
}

// Expose globals for HTML onclicks
window.loginDriver = loginDriver;
window.toggleOnlineStatus = toggleOnlineStatus;
window.switchTab = switchTab;
window.acceptOrder = acceptOrder;
window.advanceTripStatus = advanceTripStatus;
window.openJobDetail = openJobDetail;
window.closeJobDetail = closeJobDetail;
window.declineOrder = declineOrder;
window.openQuickChat = openQuickChat;
window.closeQuickChat = closeQuickChat;
window.sendQuickMessage = sendQuickMessage;
window.sendShipperCustomMessage = sendShipperCustomMessage;

// ── VoIP CALLING LOGIC & AUDIO SYNTHESIS ──
let callPollInterval = null;
let callActive = false;
let peerConnection = null;
let simulatedCallTimeout = null;
let simulatedCallInterval = null;
let callStartTime = null;
let localCallStream = null;
let remoteAudioNodes = [];
let iceFallbackTimer = null;
let iceFallbackNotified = false;

// Audio context and oscillators
let ringbackOsc1 = null;
let ringbackOsc2 = null;
let ringbackGain = null;
let incomingRingtoneInterval = null;

function startOutgoingRingback() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;

    ringbackGain = ctx.createGain();
    ringbackGain.gain.setValueAtTime(0.0, ctx.currentTime);
    ringbackGain.connect(ctx.destination);

    ringbackOsc1 = ctx.createOscillator();
    ringbackOsc1.type = 'sine';
    ringbackOsc1.frequency.setValueAtTime(440, ctx.currentTime);
    ringbackOsc1.connect(ringbackGain);

    ringbackOsc2 = ctx.createOscillator();
    ringbackOsc2.type = 'sine';
    ringbackOsc2.frequency.setValueAtTime(480, ctx.currentTime);
    ringbackOsc2.connect(ringbackGain);

    ringbackOsc1.start();
    ringbackOsc2.start();

    const playRing = () => {
      if (!ringbackGain) return;
      const now = ctx.currentTime;
      ringbackGain.gain.setValueAtTime(0.15, now);
      ringbackGain.gain.linearRampToValueAtTime(0.15, now + 0.1);
      ringbackGain.gain.setValueAtTime(0.15, now + 2.0);
      ringbackGain.gain.linearRampToValueAtTime(0.0, now + 2.1);
    };

    playRing();
    window.ringbackInterval = setInterval(playRing, 6000);
  } catch (e) {
    console.warn('Sound synthesis failed', e);
  }
}

function stopOutgoingRingback() {
  if (window.ringbackInterval) {
    clearInterval(window.ringbackInterval);
    window.ringbackInterval = null;
  }
  try {
    if (ringbackOsc1) { ringbackOsc1.stop(); ringbackOsc1 = null; }
    if (ringbackOsc2) { ringbackOsc2.stop(); ringbackOsc2 = null; }
    if (ringbackGain) { ringbackGain.disconnect(); ringbackGain = null; }
  } catch (e) {}
}

function startIncomingRingtone() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;

    const playMelody = () => {
      const now = ctx.currentTime;
      const notes = [523.25, 659.25, 783.99, 1046.50];
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.25);
        gain.gain.setValueAtTime(0.1, now + idx * 0.25);
        gain.gain.exponentialRampToValueAtTime(0.01, now + idx * 0.25 + 0.2);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.25);
        osc.stop(now + idx * 0.25 + 0.2);
      });
    };

    playMelody();
    incomingRingtoneInterval = setInterval(playMelody, 2000);
  } catch (e) {
    console.warn('Incoming audio play failed', e);
  }
}

function stopIncomingRingtone() {
  if (incomingRingtoneInterval) {
    clearInterval(incomingRingtoneInterval);
    incomingRingtoneInterval = null;
  }
}

function playSyntheticAudioBeep() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(350, ctx.currentTime);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  } catch (e) {}
}

async function checkIncomingCall(orderId) {
  if (callActive) return;
  try {
    const res = await fetch(`${API_BASE}/api/orders/${orderId}/call/poll?role=shipper`);
    if (!res.ok) return;
    const json = await res.json();
    const callObj = json.call;

    if (callObj && callObj.status === 'ringing' && callObj.caller === 'customer') {
      showIncomingCallOverlay(callObj);
    }
  } catch (e) {
    console.warn('Error checking incoming call:', e);
  }
}

function showIncomingCallOverlay(callObj) {
  callActive = true;
  const overlay = document.getElementById('call-overlay');
  if (overlay && !overlay.classList.contains('active')) {
    overlay.classList.add('active');
    lockBodyScroll();
  }

  document.getElementById('call-contact-name').textContent = activeOrder.deliveryName || 'Khách hàng';
  document.getElementById('call-avatar-display').textContent = (activeOrder.deliveryName || 'K').charAt(0);
  document.getElementById('call-status-label').innerHTML = '<i class="fa-solid fa-bell animate-bounce"></i> Cuộc gọi đến...';

  document.getElementById('call-actions-incoming').style.display = 'flex';
  document.getElementById('call-actions-active').style.display = 'none';

  startIncomingRingtone();
  startCallPolling('shipper');
}

let iceServersConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.stunprotocol.org:3478' }
  ]
};

async function fetchIceServers() {
  try {
    const res = await fetch(`${API_BASE}/api/webrtc/ice-servers`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        iceServersConfig = { iceServers: data };
        console.log('[WebRTC] Dynamic ICE servers loaded:', data);
      }
    }
  } catch (e) {
    console.warn('[WebRTC] Failed to fetch ICE servers from backend:', e);
  }
}

function getOrCreateRemoteAudioEl(unlock = false) {
  let audioEl = document.getElementById('remote-audio-el');
  if (!audioEl) {
    audioEl = document.createElement('audio');
    audioEl.id = 'remote-audio-el';
    audioEl.setAttribute('autoplay', 'true');
    audioEl.setAttribute('playsinline', 'true');
    audioEl.setAttribute('webkit-playsinline', 'true');
    audioEl.preload = 'auto';
    audioEl.controls = false;
    audioEl.style.position = 'absolute';
    audioEl.style.width = '10px';
    audioEl.style.height = '10px';
    audioEl.style.top = '0px';
    audioEl.style.left = '0px';
    audioEl.style.opacity = '0.01';
    audioEl.style.zIndex = '-1';
    audioEl.style.pointerEvents = 'none';
    document.body.appendChild(audioEl);
  } else {
    audioEl.style.width = '10px';
    audioEl.style.height = '10px';
    audioEl.style.opacity = '0.01';
    audioEl.style.zIndex = '-1';
  }
  if (unlock) {
    audioEl.muted = false;
    audioEl.volume = 1;
    audioEl.play().catch(e => console.log('[WebRTC] Silent pre-play caught (expected):', e));
  }
  return audioEl;
}

function getCallDiagnostics() {
  const hasTurn = (iceServersConfig.iceServers || []).some(server => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some(url => String(url || '').startsWith('turn:') || String(url || '').startsWith('turns:'));
  });
  const apiUrl = API_BASE;
  const usingHttpsPage = window.location.protocol === 'https:';
  const usingHttpApi = String(apiUrl).startsWith('http://');
  return {
    secureContext: window.isSecureContext,
    hasMediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    hasTurn,
    mixedContentRisk: usingHttpsPage && usingHttpApi,
    apiUrl
  };
}

function renderCallDiagnostics() {
  const panel = document.getElementById('call-diagnostics-panel');
  if (!panel) return;
  const diag = getCallDiagnostics();
  const rows = [
    {
      ok: diag.secureContext,
      label: diag.secureContext ? 'Mic duoc phep tren HTTPS/localhost' : 'Can HTTPS de trinh duyet cho phep microphone'
    },
    {
      ok: diag.hasTurn,
      label: diag.hasTurn ? 'TURN server san sang cho goi ngoai mang LAN' : 'Thieu TURN server, goi qua internet/NAT de mat tieng'
    },
    {
      ok: !diag.mixedContentRisk,
      label: diag.mixedContentRisk ? 'Frontend HTTPS dang goi API HTTP, co the bi chan' : 'API signaling khong bi mixed-content'
    }
  ];
  panel.innerHTML = rows.map(row => `
    <div class="call-diagnostic ${row.ok ? 'ok' : 'warn'}">
      <i class="fa-solid ${row.ok ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
      <span>${row.label}</span>
    </div>
  `).join('');
}

function attachRemoteAudioStream(remoteStream, label) {
  const audioEl = getOrCreateRemoteAudioEl();
  audioEl.srcObject = remoteStream;
  audioEl.muted = false;
  audioEl.volume = 1;

  const playPromise = audioEl.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.then(() => {
      console.log(`[WebRTC] ${label} remote audio playback started successfully`);
    }).catch(e => {
      console.warn(`[WebRTC] ${label} audio element play failed, routing via AudioContext:`, e);
      try {
        const ctx = getSharedAudioCtx();
        if (ctx) {
          const source = ctx.createMediaStreamSource(remoteStream);
          source.connect(ctx.destination);
          remoteAudioNodes.push(source);
        }
      } catch (audioCtxErr) {
        console.warn(`[WebRTC] ${label} AudioContext routing failed:`, audioCtxErr);
      }
      const playFallback = () => {
        audioEl.play().then(() => {
          console.log(`[WebRTC] ${label} remote audio playback started on user gesture`);
          document.removeEventListener('click', playFallback);
          document.removeEventListener('touchstart', playFallback);
        }).catch(err => console.error(`[WebRTC] ${label} play retry failed:`, err));
      };
      document.addEventListener('click', playFallback);
      document.addEventListener('touchstart', playFallback);
    });
  }
}

function clearIceFallbackTimer() {
  if (iceFallbackTimer) {
    clearTimeout(iceFallbackTimer);
    iceFallbackTimer = null;
  }
}

function runWebRtcFallback(label, startFallback, notifyFallback) {
  clearIceFallbackTimer();
  if (!callActive || iceFallbackNotified) return;

  const state = peerConnection ? peerConnection.iceConnectionState : 'closed';
  if (state === 'connected' || state === 'completed') return;

  iceFallbackNotified = true;
  console.warn(`[WebRTC] ${label} ICE ${state}, falling back to simulated call`);
  showToast('Ket noi that bai', 'Khong co duong am thanh truc tiep. Hay cau hinh TURN server khi goi qua internet.', 'warning');

  try {
    if (typeof notifyFallback === 'function') notifyFallback();
  } catch (e) {}

  if (peerConnection) {
    try { peerConnection.close(); } catch (e) {}
    peerConnection = null;
  }
  startFallback();
}

function handleIceConnectionState(label, startFallback, notifyFallback) {
  if (!peerConnection) return;
  const state = peerConnection.iceConnectionState;
  console.log(`[WebRTC] ${label} ICE Connection State Changed:`, state);

  if (state === 'connected' || state === 'completed') {
    clearIceFallbackTimer();
    return;
  }

  if (state === 'disconnected') {
    if (!iceFallbackTimer) {
      console.warn(`[WebRTC] ${label} ICE disconnected; waiting before fallback`);
      iceFallbackTimer = setTimeout(() => runWebRtcFallback(label, startFallback, notifyFallback), 12000);
    }
    return;
  }

  if (state === 'failed') {
    runWebRtcFallback(label, startFallback, notifyFallback);
  }
}

async function acceptCall() {
  getSharedAudioCtx(); // Initialize AudioContext synchronously under user gesture context
  getOrCreateRemoteAudioEl(true); // Unlock audio element synchronously under user gesture context
  renderCallDiagnostics();
  stopIncomingRingtone();
  const statusLabel = document.getElementById('call-status-label');
  if (statusLabel) statusLabel.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang kết nối...';

  document.getElementById('call-actions-incoming').style.display = 'none';
  document.getElementById('call-actions-active').style.display = 'block';

  let hasMicrophone = false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    hasMicrophone = true;
  } catch (err) {
    console.warn('Microphone access failed for shipper, using simulated call fallback', err);
  }

  if (!hasMicrophone) {
    try {
      await fetch(`${API_BASE}/api/orders/${activeOrder.id}/call/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'accept', answer: { type: 'answer', sdp: 'simulated' } })
      });
    } catch (e) {}
    startShipperSimulatedCall();
    return;
  }

  try {
    const pollRes = await fetch(`${API_BASE}/api/orders/${activeOrder.id}/call/poll?role=shipper`);
    const pollJson = await pollRes.json();
    const callObj = pollJson.call;

    if (!callObj || !callObj.offer) {
      throw new Error('No offer found on server');
    }

    if (callObj.offer.sdp === 'simulated') {
      throw new Error('Simulated call offer');
    }

    iceFallbackNotified = false;
    clearIceFallbackTimer();
    peerConnection = new RTCPeerConnection(iceServersConfig);
    peerConnection.oniceconnectionstatechange = () => {
      handleIceConnectionState('Callee', startShipperSimulatedCall, () => {
        fetch(`${API_BASE}/api/orders/${activeOrder.id}/call/respond`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'accept', answer: { type: 'answer', sdp: 'simulated' } })
        }).catch(e => {});
      });
      return;
      console.log('[WebRTC] Callee ICE Connection State Changed:', peerConnection.iceConnectionState);
      if (peerConnection.iceConnectionState === 'failed' || peerConnection.iceConnectionState === 'disconnected') {
        console.warn('[WebRTC] Callee ICE Connection failed/disconnected, falling back to simulated call');
        showToast('Kết nối thất bại', 'Không thể kết nối trực tiếp (do chặn mạng/WiFi). Chuyển sang cuộc gọi mô phỏng.', 'warning');
        
        fetch(`${API_BASE}/api/orders/${activeOrder.id}/call/respond`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'accept', answer: { type: 'answer', sdp: 'simulated' } })
        }).catch(e => {});

        if (peerConnection) {
          try { peerConnection.close(); } catch(e){}
          peerConnection = null;
        }
        startShipperSimulatedCall();
      }
    };
    peerConnection.onconnectionstatechange = () => {
      console.log('[WebRTC] Callee Connection State Changed:', peerConnection.connectionState);
    };
    peerConnection.ontrack = (event) => {
      console.log('[WebRTC] Callee Remote track received:', event.track.kind);
      let remoteStream = event.streams[0];
      if (!remoteStream) {
        console.log('[WebRTC] Callee Fallback: creating new MediaStream for track');
        remoteStream = new MediaStream();
        remoteStream.addTrack(event.track);
      }
      attachRemoteAudioStream(remoteStream, 'Callee');
    };
    peerConnection.onicecandidate = async (event) => {
      if (event.candidate) {
        await fetch(`${API_BASE}/api/orders/${activeOrder.id}/call/candidate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sender: 'shipper', candidate: event.candidate })
        });
      }
    };

    const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    localCallStream = localStream;
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    await peerConnection.setRemoteDescription(new RTCSessionDescription(callObj.offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    await fetch(`${API_BASE}/api/orders/${activeOrder.id}/call/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'accept', answer })
    });
  } catch (err) {
    console.error('Shipper accept WebRTC failed, fallback to simulated', err);
    try {
      await fetch(`${API_BASE}/api/orders/${activeOrder.id}/call/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'accept', answer: { type: 'answer', sdp: 'simulated' } })
      });
    } catch (e) {}
    startShipperSimulatedCall();
  }
}

function startShipperSimulatedCall() {
  const statusLabel = document.getElementById('call-status-label');
  if (statusLabel) statusLabel.innerHTML = '<i class="fa-solid fa-microphone-lines"></i> Đã kết nối (Mô phỏng)';

  callStartTime = Date.now();
  simulatedCallInterval = setInterval(() => {
    if (!callActive) return;
    const secs = Math.floor((Date.now() - callStartTime) / 1000);
    const mins = Math.floor(secs / 60);
    const display = `${mins.toString().padStart(2, '0')}:${(secs % 60).toString().padStart(2, '0')}`;
    const warningText = !window.isSecureContext ? '<br><span style="font-size:10px;color:#FCA5A5;">⚠️ HTTP chặn Micrô (Cần HTTPS/Localhost)</span>' : '';
    if (statusLabel) statusLabel.innerHTML = `<i class="fa-solid fa-microphone-lines text-success"></i> Đang thoại: ${display} (Mô phỏng)${warningText}`;
    
    if (secs % 3 === 0) {
      playSyntheticAudioBeep();
    }
  }, 1000);
}

function declineCall() {
  stopIncomingRingtone();
  callActive = false;
  if (activeOrder) {
    try {
      fetch(`${API_BASE}/api/orders/${activeOrder.id}/call/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'decline' })
      });
    } catch (e) {}
  }
  endCallLocally();
}

async function initiateCall() {
  makeDirectCall();
}

async function startShipperOutgoingSimulatedCall() {
  const statusLabel = document.getElementById('call-status-label');
  if (statusLabel) statusLabel.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang kết nối...';
  startOutgoingRingback();

  try {
    const offer = { type: 'offer', sdp: 'simulated' };
    await fetch(`${API_BASE}/api/orders/${activeOrder.id}/call/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caller: 'shipper', offer })
    });
  } catch (e) {
    console.error('Failed to notify server of simulated call:', e);
  }

  startCallPolling('shipper');

  simulatedCallTimeout = setTimeout(async () => {
    stopOutgoingRingback();
    if (!callActive) return;

    if (statusLabel) statusLabel.innerHTML = '<i class="fa-solid fa-microphone-lines"></i> Đã kết nối (Mô phỏng)';
    showToast('Đã kết nối', 'Cuộc gọi mô phỏng đang hoạt động.', 'success');

    callStartTime = Date.now();
    simulatedCallInterval = setInterval(() => {
      if (!callActive) return;
      const secs = Math.floor((Date.now() - callStartTime) / 1000);
      const mins = Math.floor(secs / 60);
      const display = `${mins.toString().padStart(2, '0')}:${(secs % 60).toString().padStart(2, '0')}`;
      if (statusLabel) statusLabel.innerHTML = `<i class="fa-solid fa-microphone-lines text-success"></i> Đang thoại: ${display} (Mô phỏng)`;
      
      if (secs % 3 === 0) {
        playSyntheticAudioBeep();
      }
    }, 1000);
  }, 4000);
}

function startCallPolling(role) {
  if (callPollInterval) clearInterval(callPollInterval);
  let candidateIdx = 0;

  callPollInterval = setInterval(async () => {
    if (!callActive) return;
    try {
      const res = await fetch(`${API_BASE}/api/orders/${activeOrder.id}/call/poll?role=shipper`);
      if (!res.ok) return;
      const json = await res.json();
      const callObj = json.call;

      if (!callObj || callObj.status === 'ended') {
        showToast('Cuộc gọi kết thúc', 'Cuộc gọi đã được gác máy.', 'info');
        endCallLocally();
        return;
      }

      const statusLabel = document.getElementById('call-status-label');

      if (callObj.status === 'connected') {
        stopOutgoingRingback();
        stopIncomingRingtone();

        if (callObj.answer && callObj.answer.sdp === 'simulated') {
          if (peerConnection) {
            try { peerConnection.close(); } catch (e) {}
            peerConnection = null;
          }
          if (!simulatedCallInterval) {
            startShipperSimulatedCall();
          }
          return;
        }

        const isCaller = (callObj.caller === 'shipper');

        // Caller: set remote description when answer is received from callee
        if (isCaller && peerConnection && peerConnection.signalingState !== 'stable' && callObj.answer && callObj.answer.sdp !== 'simulated') {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(callObj.answer));
        }

        if (!callStartTime) callStartTime = Date.now();
        const secs = Math.floor((Date.now() - callStartTime) / 1000);
        const mins = Math.floor(secs / 60);
        const display = `${mins.toString().padStart(2, '0')}:${(secs % 60).toString().padStart(2, '0')}`;
        if (statusLabel) {
          statusLabel.innerHTML = `<i class="fa-solid fa-microphone-lines text-success"></i> Đang đàm thoại: ${display}`;
        }

        // Poll candidates sent by the other side
        const targetCandidates = isCaller ? callObj.calleeCandidates : callObj.callerCandidates;
        if (peerConnection && peerConnection.remoteDescription && targetCandidates && targetCandidates.length > candidateIdx) {
          for (let i = candidateIdx; i < targetCandidates.length; i++) {
            try {
              await peerConnection.addIceCandidate(new RTCIceCandidate(targetCandidates[i]));
              console.log('[WebRTC] Successfully added ICE candidate:', targetCandidates[i].candidate);
            } catch (iceErr) {
              console.warn('[WebRTC] Failed to add ICE candidate:', iceErr);
            }
          }
          candidateIdx = targetCandidates.length;
        }
      }
    } catch (e) {
      console.error('Error polling call details:', e);
    }
  }, 1500);
}

function endCall() {
  callActive = false;
  stopOutgoingRingback();
  stopIncomingRingtone();
  if (simulatedCallTimeout) { clearTimeout(simulatedCallTimeout); simulatedCallTimeout = null; }
  if (simulatedCallInterval) { clearInterval(simulatedCallInterval); simulatedCallInterval = null; }

  if (activeOrder && activeOrder.id) {
    try {
      fetch(`${API_BASE}/api/orders/${activeOrder.id}/call/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'end' })
      });
    } catch (e) {}
  }
  endCallLocally();
}

function endCallLocally() {
  callActive = false;
  callStartTime = null;
  stopOutgoingRingback();
  stopIncomingRingtone();
  if (callPollInterval) { clearInterval(callPollInterval); callPollInterval = null; }
  if (simulatedCallTimeout) { clearTimeout(simulatedCallTimeout); simulatedCallTimeout = null; }
  if (simulatedCallInterval) { clearInterval(simulatedCallInterval); simulatedCallInterval = null; }
  clearIceFallbackTimer();
  iceFallbackNotified = false;

  if (peerConnection) {
    try { peerConnection.close(); } catch (e) {}
    peerConnection = null;
  }

  if (localCallStream) {
    try {
      localCallStream.getTracks().forEach(track => track.stop());
    } catch (e) {}
    localCallStream = null;
  }

  const overlay = document.getElementById('call-overlay');
  if (overlay && overlay.classList.contains('active')) {
    overlay.classList.remove('active');
    unlockBodyScroll();
  }

  const audioEl = document.getElementById('remote-audio-el');
  if (audioEl) audioEl.srcObject = null;
  remoteAudioNodes.forEach(node => {
    try { node.disconnect(); } catch (e) {}
  });
  remoteAudioNodes = [];
}

window.initiateCall = initiateCall;
window.acceptCall = acceptCall;
window.declineCall = declineCall;
window.endCall = endCall;

function makeDirectCall() {
  if (!activeOrder) {
    showToast('Lỗi', 'Không tìm thấy thông tin đơn hàng.', 'error');
    return;
  }
  
  if (activeOrder.isRelative && activeOrder.ordererPhone) {
    const overlay = document.getElementById('call-select-overlay');
    if (overlay) {
      const btnRel = document.getElementById('btn-call-relative');
      const btnOrd = document.getElementById('btn-call-orderer');
      if (btnRel) btnRel.innerHTML = `<i class="fa-solid fa-user"></i> Gọi Người Thân (Nhận): ${activeOrder.deliveryName || ''} (${activeOrder.deliveryPhone})`;
      if (btnOrd) btnOrd.innerHTML = `<i class="fa-solid fa-user-group"></i> Gọi Người Đặt Hộ: (${activeOrder.ordererPhone})`;
      overlay.classList.add('active');
      lockBodyScroll();
    }
  } else {
    if (!activeOrder.deliveryPhone) {
      showToast('Lỗi', 'Không tìm thấy số điện thoại khách hàng.', 'error');
      return;
    }
    window.location.href = `tel:${activeOrder.deliveryPhone}`;
  }
}
window.makeDirectCall = makeDirectCall;

function callPerson(type) {
  const overlay = document.getElementById('call-select-overlay');
  if (overlay && overlay.classList.contains('active')) {
    overlay.classList.remove('active');
    unlockBodyScroll();
  }
  
  if (!activeOrder) return;
  
  if (type === 'relative') {
    window.location.href = `tel:${activeOrder.deliveryPhone}`;
  } else if (type === 'orderer') {
    window.location.href = `tel:${activeOrder.ordererPhone}`;
  }
}
window.callPerson = callPerson;

function closeCallSelect() {
  const overlay = document.getElementById('call-select-overlay');
  if (overlay && overlay.classList.contains('active')) {
    overlay.classList.remove('active');
    unlockBodyScroll();
  }
}
window.closeCallSelect = closeCallSelect;

function configureApiUrl() {
  // Đã ẩn trên production — không cho xem/đổi Backend API URL.
  return;
}
window.configureApiUrl = configureApiUrl;

async function logoutDriver() {
  if (confirm('Bạn có chắc chắn muốn đăng xuất tài khoản tài xế?')) {
    if (isOnline && currentDriver) {
      try {
        await fetch(`${API_BASE}/api/shippers/shift`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: currentDriver.phone, status: 'OFFLINE' })
        });
      } catch (e) {
        console.warn('Lỗi tự động check-out khi đăng xuất:', e);
      }
    }
    
    clearShipperAuthStorage();
    
    if (supabaseClient) {
      try {
        await supabaseClient.auth.signOut();
      } catch (e) {
        console.warn('Lỗi đăng xuất Supabase:', e);
      }
    }
    
    currentDriver = null;
    activeOrder = null;
    pendingOrders = [];
    historyOrders = [];
    isOnline = false;
    stopPolling();
    stopGpsTracking();
    
    document.getElementById('login-overlay').classList.add('active');
    document.getElementById('driver-name').value = '';
    document.getElementById('driver-phone').value = '';
    if (document.getElementById('driver-email')) document.getElementById('driver-email').value = '';
    if (document.getElementById('driver-password')) document.getElementById('driver-password').value = '';
    
    const checkbox = document.getElementById('online-switch');
    const statusText = document.getElementById('status-text');
    if (checkbox && statusText) {
      checkbox.checked = false;
      statusText.textContent = 'Đã tắt ca (Check-out)';
      statusText.className = 'status-indicator offline';
    }
    
    showToast('Đã đăng xuất', 'Thông tin tài xế đã được xóa khỏi thiết bị.', 'info');
  }
}
window.logoutDriver = logoutDriver;

async function showDriverProfile() {
  if (!currentDriver) return;
  
  document.getElementById('profile-name').textContent = currentDriver.name || '-';
  document.getElementById('profile-phone').textContent = currentDriver.phone || '-';
  const cccdEl = document.getElementById('profile-cccd');
  if (cccdEl) {
    cccdEl.textContent = currentDriver.cccd || 'Chưa cập nhật';
  }

  const avatarImg = document.getElementById('profile-avatar-img');
  const avatarPlaceholder = document.getElementById('profile-avatar-placeholder');
  
  if (currentDriver.avatarUrl && avatarImg && avatarPlaceholder) {
    avatarImg.src = currentDriver.avatarUrl;
    avatarImg.style.display = 'block';
    avatarPlaceholder.style.display = 'none';
  } else {
    if (avatarImg) avatarImg.style.display = 'none';
    if (avatarPlaceholder) avatarPlaceholder.style.display = 'block';
  }
  
  // Trạng thái ca
  const statusTextEl = document.getElementById('status-text');
  document.getElementById('profile-status').textContent = statusTextEl ? statusTextEl.textContent : (isOnline ? 'Đang trong ca (ONLINE)' : 'Đã tắt ca (OFFLINE)');
  
  // Lấy email từ Supabase Auth nếu có
  if (supabaseClient) {
    supabaseClient.auth.getSession().then(({ data: { session } }) => {
      if (session && session.user) {
        document.getElementById('profile-email').textContent = session.user.email;
      } else {
        document.getElementById('profile-email').textContent = 'Chưa xác thực trực tuyến';
      }
    }).catch(() => {
      document.getElementById('profile-email').textContent = 'Chưa xác thực trực tuyến';
    });
  } else {
    document.getElementById('profile-email').textContent = 'Ngoại tuyến';
  }

  // Gọi đồng bộ bất đồng bộ từ server để cập nhật thông tin mới nhất
  refreshDriverInfo();

  // Thống kê AR/CR từ stats theo tài xế hiện tại (giới hạn 0–100%)
  const totalOffers = (stats.accepted || 0) + (stats.declined || 0);
  const arPct = clampPercent(totalOffers > 0 ? (stats.accepted / totalOffers) * 100 : 100);
  const crPct = clampPercent(stats.accepted > 0 ? (stats.completed / stats.accepted) * 100 : 100);
  document.getElementById('profile-ar').textContent = arPct + '%';
  document.getElementById('profile-cr').textContent = crPct + '%';
  
  // Tổng đơn hoàn thành và doanh thu từ lịch sử đã sync
  let totalEarnings = 0;
  (historyOrders || []).forEach(o => { totalEarnings += o.shipperEarning || 0; });
  document.getElementById('profile-total-orders').textContent = (historyOrders ? historyOrders.length : 0) + ' đơn';
  document.getElementById('profile-revenue').textContent = formatCurrency(totalEarnings);

  const overlay = document.getElementById('driver-profile-overlay');
  if (overlay) {
    overlay.style.display = 'flex';
    if (!overlay.classList.contains('active')) {
      overlay.classList.add('active');
      lockBodyScroll();
    }
  }
}

function closeDriverProfile() {
  const overlay = document.getElementById('driver-profile-overlay');
  if (overlay) {
    overlay.style.display = 'none';
    if (overlay.classList.contains('active')) {
      overlay.classList.remove('active');
      unlockBodyScroll();
    }
  }
}

window.showDriverProfile = showDriverProfile;
window.closeDriverProfile = closeDriverProfile;

window.addEventListener('pagehide', () => {
  if (callActive && activeOrder && activeOrder.id) {
    fetch(`${API_BASE}/api/orders/${activeOrder.id}/call/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'end' }),
      keepalive: true
    });
  }
});

// Fetch ICE servers dynamically on page load
fetchIceServers();

// Mobile Zoom Prevention — khóa pinch + double-tap zoom (iOS/Android)
(function lockViewportZoom() {
  const block = (event) => {
    if (event.cancelable) event.preventDefault();
  };

  ['gesturestart', 'gesturechange', 'gestureend'].forEach((type) => {
    document.addEventListener(type, block, { passive: false });
  });

  // Chặn pinch (2 ngón)
  document.addEventListener('touchmove', (event) => {
    if (event.touches && event.touches.length > 1) block(event);
  }, { passive: false });

  // Chặn double-tap zoom (khoảng cách 2 lần chạm < 300ms)
  let lastTouchEnd = 0;
  document.addEventListener('touchend', (event) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) block(event);
    lastTouchEnd = now;
  }, { passive: false });

  // Giữ scale=1 nếu trình duyệt cố zoom (một số WebView)
  const meta = document.querySelector('meta[name="viewport"]');
  if (meta) {
    const locked =
      'width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content';
    meta.setAttribute('content', locked);
  }
})();

async function initSupabase() {
  let retries = 3;
  let delay = 3000;
  let currentTimeout = 6000;

  while (retries >= 0) {
    try {
      const res = await apiFetch(`${API_BASE}/api/config`, {}, currentTimeout);
      const data = await safeJson(res);
      if (data.supabaseUrl && data.supabaseAnonKey && data.supabaseUrl !== 'your_supabase_url_here') {
        supabaseClient = supabase.createClient(data.supabaseUrl, data.supabaseAnonKey, {
          auth: {
            storageKey: 'shipfee_driver_auth_token',
            storage: window.localStorage,
            persistSession: true,
            autoRefreshToken: true
          }
        });
        console.log('[Supabase] Client initialized successfully via proxy config');
        // Không gọi setConnectionStatus trên màn login
        
        // Tự động khôi phục JWT token từ storage của client
        supabaseClient.auth.getSession().then(({ data: { session } }) => {
          if (session) {
            setAuthItem(AUTH_JWT_KEY, session.access_token);
          }
        }).catch(e => console.warn('Lỗi lấy session shipper:', e));

        // Update UI: hide name/phone, show email/password
        const nameGroup = document.getElementById('login-group-name');
        const phoneGroup = document.getElementById('login-group-phone');
        const emailGroup = document.getElementById('login-group-email');
        const passwordGroup = document.getElementById('login-group-password');
        const loginBtn = document.getElementById('login-btn');
        if (nameGroup) nameGroup.style.display = 'none';
        if (phoneGroup) phoneGroup.style.display = 'none';
        if (emailGroup) emailGroup.style.display = 'flex';
        if (passwordGroup) passwordGroup.style.display = 'flex';
        if (loginBtn) loginBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Đăng nhập';
        return;
      } else {
        console.error('[Supabase] Proxy returned placeholder credentials. Supabase mode required but not configured!');
        showToast('Cấu hình Supabase', 'Hệ thống đang hoạt động ở chế độ bắt buộc Supabase nhưng chưa cấu hình credentials. Vui lòng cập nhật file .env!', 'error');
        return;
      }
    } catch (e) {
      console.error('[Supabase] Failed to retrieve config from proxy:', e);
      if (retries === 0) {
        showToast('Lỗi kết nối', 'Không thể kết nối đến máy chủ cấu hình API. Thử lại sau vài giây.', 'error');
        break;
      }
      if (retries === 3 && API_BASE.includes('render.com')) {
        showToast('Khởi động Máy chủ', 'Máy chủ đang thức giấc, vui lòng chờ…', 'info');
      }
      retries--;
      currentTimeout = 15000;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function requestOrderAssistance() {
  if (!currentDriver || !currentDriver.phone) {
    showToast('Lỗi', 'Không xác định được thông tin tài xế!', 'error');
    return;
  }

  const btn = document.getElementById('btn-request-assistance');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang gửi tới CRM...';
  }

  try {
    const res = await fetch(`${API_BASE}/api/shippers/request-assistance`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getAuthItem(AUTH_JWT_KEY)}`
      },
      body: JSON.stringify({ phone: currentDriver.phone })
    }).then(r => r.json());

    if (res.success) {
      showToast('CRM đã nhận yêu cầu', res.message || 'Hệ thống đang ưu tiên gán đơn cho bạn.', 'success');
      currentDriver.assistanceLimitToday = res.limitUsed;
      currentDriver.assistanceRequested = true;
      setAuthItem(AUTH_DRIVER_KEY, JSON.stringify(currentDriver));

      if (res.orderId) {
        syncAllData();
      } else {
        renderPendingOrders([]);
      }
    } else {
      showToast('Thất bại', res.error || 'Yêu cầu hỗ trợ thất bại.', 'error');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-bolt"></i> Yêu cầu CRM hỗ trợ tìm đơn';
      }
    }
  } catch (err) {
    console.error('Lỗi yêu cầu hỗ trợ tìm đơn:', err);
    showToast('Lỗi kết nối', 'Không thể kết nối với server.', 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-bolt"></i> Yêu cầu CRM hỗ trợ tìm đơn';
    }
  }
}
window.requestOrderAssistance = requestOrderAssistance;

function reportTripIncident() {
  if (!activeOrder) {
    showToast('Chưa có chuyến đi', 'Chỉ báo sự cố khi đang chạy đơn.', 'warning');
    return;
  }

  crmSupportLinkOrder = true;
  const emergencyEl = document.getElementById('crm-support-emergency');
  if (emergencyEl) emergencyEl.checked = true;
  const input = document.getElementById('crm-support-input');
  if (input && !input.value.trim()) {
    input.value = `Khẩn cấp đơn ${activeOrder.id} (${activeOrder.status}): `;
  }
  updateCrmSupportOrderTag();
  openCrmSupportSheet({ focus: true });
  showToast('Nhắn CRM', 'Đã mở chat CRM — gửi tin để nhờ hỗ trợ khẩn cấp.', 'info');
}
window.reportTripIncident = reportTripIncident;

/* ── CRM Support Chat (shipper ↔ admin) — bottom sheet ───────────────────── */
let crmSupportThread = null;
let crmSupportLinkOrder = false;
let crmSupportSendInFlight = false;
let crmSupportPollTimer = null;
let crmSupportSheetOpen = false;
let lastCrmSupportFingerprint = '';
let crmSupportComposingNew = false;   // đang soạn 1 ticket mới (bỏ qua ticket đã đóng)
let lastCrmSupportStatus = null;      // theo dõi chuyển trạng thái open → resolved

function getCrmSupportTicketCode(thread) {
  if (!thread || !thread.id) return '';
  const digits = String(thread.id).replace(/\D/g, '');
  return digits ? digits.slice(-4) : String(thread.id).slice(-4);
}

function getCrmSupportFingerprint(thread) {
  if (!thread || !Array.isArray(thread.messages) || thread.messages.length === 0) return '0';
  const last = thread.messages[thread.messages.length - 1];
  return `${thread.messages.length}:${last.id || ''}:${last.timestamp || ''}:${last.sender || ''}:${last.text || ''}`;
}

function openCrmSupportSheet(opts = {}) {
  const overlay = document.getElementById('crm-support-overlay');
  if (!overlay) return;
  if (!overlay.classList.contains('active')) {
    overlay.classList.add('active');
    lockBodyScroll();
  }
  crmSupportSheetOpen = true;
  crmSupportComposingNew = false;
  updateCrmSupportOrderTag();
  bindCrmSupportKeyboardAvoidance();
  loadCrmSupportThread().then(() => {
    startCrmSupportPolling();
    if (opts.focus !== false) {
      const input = document.getElementById('crm-support-input');
      if (input) setTimeout(() => input.focus(), 220);
    }
  });
}
window.openCrmSupportSheet = openCrmSupportSheet;

function closeCrmSupportSheet() {
  const overlay = document.getElementById('crm-support-overlay');
  if (overlay && overlay.classList.contains('active')) {
    overlay.classList.remove('active');
    unlockBodyScroll();
  }
  crmSupportSheetOpen = false;
  unbindCrmSupportKeyboardAvoidance();
  const input = document.getElementById('crm-support-input');
  if (input) input.blur();
}
window.closeCrmSupportSheet = closeCrmSupportSheet;

function updateCrmSupportOrderTag() {
  const tag = document.getElementById('crm-support-order-tag');
  const btn = document.getElementById('crm-support-link-order-btn');
  const linked = !!crmSupportLinkOrder && !!activeOrder;
  if (btn) {
    btn.classList.toggle('is-on', linked);
    btn.textContent = linked
      ? `Đang gắn: ${activeOrder.id}`
      : (activeOrder ? 'Gắn đơn đang chạy' : 'Gắn đơn (chưa có chuyến)');
  }
  if (!tag) return;
  if (linked) {
    tag.style.display = 'inline-flex';
    tag.textContent = `Đơn ${activeOrder.id}`;
  } else if (crmSupportThread?.orderId) {
    tag.style.display = 'inline-flex';
    tag.textContent = `Đơn ${crmSupportThread.orderId}`;
  } else {
    tag.style.display = 'none';
    tag.textContent = '';
  }
}

function toggleCrmSupportOrderLink() {
  if (!activeOrder) {
    showToast('Chưa có đơn', 'Chỉ gắn được khi đang có chuyến đi.', 'warning');
    crmSupportLinkOrder = false;
  } else {
    crmSupportLinkOrder = !crmSupportLinkOrder;
  }
  updateCrmSupportOrderTag();
}
window.toggleCrmSupportOrderLink = toggleCrmSupportOrderLink;

function formatCrmSupportTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function renderCrmSupportMessages(thread) {
  const box = document.getElementById('crm-support-messages');
  const statusEl = document.getElementById('crm-support-status');
  const ticketEl = document.getElementById('crm-support-ticket');
  const composeEl = document.getElementById('crm-support-compose');
  const closedEl = document.getElementById('crm-support-closed');
  if (!box) return;

  crmSupportThread = thread || null;
  updateCrmSupportOrderTag();

  // Trạng thái hiển thị: soạn ticket mới > đã đóng > đang mở > chưa có
  const newMode = crmSupportComposingNew || !thread;
  const isClosed = !crmSupportComposingNew && thread && thread.status === 'resolved';

  if (ticketEl) {
    const code = (!newMode && thread) ? getCrmSupportTicketCode(thread) : '';
    if (code) {
      ticketEl.style.display = 'inline-flex';
      ticketEl.textContent = `Ticket #${code}`;
    } else {
      ticketEl.style.display = 'none';
      ticketEl.textContent = '';
    }
  }

  if (statusEl) {
    if (newMode) {
      statusEl.textContent = 'Yêu cầu mới — mô tả sự cố, CRM sẽ phản hồi tại đây';
    } else if (isClosed) {
      statusEl.textContent = 'Đã xử lý & đóng — tạo yêu cầu mới nếu cần thêm';
    } else if (thread.priority === 'emergency') {
      statusEl.textContent = 'Đang mở · Khẩn cấp';
    } else {
      statusEl.textContent = 'Đang mở · CRM sẽ trả lời tại đây';
    }
  }

  // Bật/tắt khung soạn tin vs. banner "đã đóng"
  if (composeEl) composeEl.style.display = isClosed ? 'none' : '';
  if (closedEl) closedEl.style.display = isClosed ? 'flex' : 'none';

  const messages = (!newMode && thread && Array.isArray(thread.messages)) ? thread.messages : [];
  if (!messages.length) {
    box.innerHTML = newMode
      ? `<div class="crm-support-empty">Tạo yêu cầu hỗ trợ mới.<br>Mô tả sự cố rồi bấm gửi — CRM sẽ trả lời ngay tại đây.</div>`
      : `<div class="crm-support-empty">Chưa có tin nhắn.<br>Gõ bên dưới rồi bấm gửi — CRM sẽ trả lời ngay tại đây.</div>`;
    return;
  }

  const shouldScroll = box.scrollTop + box.clientHeight >= box.scrollHeight - 40
    || box.querySelector('.crm-support-empty');

  box.innerHTML = messages.map(msg => {
    const isSystem = msg.sender === 'system' || msg.role === 'system';
    if (isSystem) {
      return `<div class="crm-support-system">${escapeHtml(msg.text || '')}</div>`;
    }
    const isMe = msg.sender === 'shipper' || msg.role === 'shipper';
    const who = isMe ? 'Bạn' : 'CRM';
    const cls = isMe ? 'crm-support-bubble--me' : 'crm-support-bubble--crm';
    const time = formatCrmSupportTime(msg.timestamp || msg.createdAt);
    return `
      <div class="crm-support-bubble ${cls}">
        <span class="crm-support-bubble__who">${who}</span>
        <span>${escapeHtml(msg.text || '')}</span>
        ${time ? `<span class="crm-support-bubble__time">${time}</span>` : ''}
      </div>`;
  }).join('');

  if (shouldScroll) box.scrollTop = box.scrollHeight;
}

function startNewCrmSupportTicket() {
  crmSupportComposingNew = true;
  crmSupportLinkOrder = false;
  const emergencyEl = document.getElementById('crm-support-emergency');
  if (emergencyEl) emergencyEl.checked = false;
  const input = document.getElementById('crm-support-input');
  if (input) input.value = '';
  renderCrmSupportMessages(crmSupportThread);
  if (input) setTimeout(() => input.focus(), 120);
}
window.startNewCrmSupportTicket = startNewCrmSupportTicket;

async function loadCrmSupportThread() {
  if (!currentDriver || !getAuthItem(AUTH_JWT_KEY)) return null;
  try {
    const res = await apiFetch(`${API_BASE}/api/shippers/support/thread`, {
      headers: { 'Authorization': `Bearer ${getAuthItem(AUTH_JWT_KEY)}` }
    }, 10000);
    const data = await safeJson(res);
    if (res.ok && data.success) {
      const thread = data.data || null;
      const newStatus = thread ? thread.status : null;
      // Phát hiện CRM vừa đóng ticket (open → resolved) để báo tài xế
      if (!crmSupportComposingNew && lastCrmSupportStatus === 'open' && newStatus === 'resolved') {
        playMessageChimeSound();
        showToast('CRM đã xử lý ✔', 'Yêu cầu của bạn đã được đóng. Bấm "Tạo yêu cầu mới" nếu cần thêm hỗ trợ.', 'success');
      } else {
        const newFp = getCrmSupportFingerprint(thread);
        if (thread && lastCrmSupportFingerprint && newFp !== lastCrmSupportFingerprint) {
          const msgs = thread.messages || [];
          const last = msgs[msgs.length - 1];
          const isAdmin = last && (last.sender === 'admin' || last.role === 'admin');
          if (isAdmin) {
            playMessageChimeSound();
            showToast('CRM trả lời 💬', last.text || 'Có tin nhắn mới từ CRM', 'info');
          }
        }
      }
      if (thread) lastCrmSupportFingerprint = getCrmSupportFingerprint(thread);
      lastCrmSupportStatus = newStatus;
      renderCrmSupportMessages(thread);
      return thread;
    }
    const statusEl = document.getElementById('crm-support-status');
    if (statusEl && res.status === 401) {
      statusEl.textContent = 'Phiên đăng nhập hết hạn — đăng nhập lại';
    }
  } catch (e) {
    console.warn('[CRM Support] load failed:', e?.message || e);
    const statusEl = document.getElementById('crm-support-status');
    if (statusEl) statusEl.textContent = 'Không tải được chat CRM — kiểm tra mạng';
  }
  return null;
}

async function sendCrmSupportMessage() {
  if (crmSupportSendInFlight) return;
  if (!currentDriver || !getAuthItem(AUTH_JWT_KEY)) {
    showToast('Chưa đăng nhập', 'Vui lòng đăng nhập lại.', 'warning');
    return;
  }

  const input = document.getElementById('crm-support-input');
  const emergencyEl = document.getElementById('crm-support-emergency');
  const btn = document.getElementById('crm-support-send-btn');
  const text = (input?.value || '').trim();
  if (!text) {
    showToast('Thiếu nội dung', 'Nhập tin nhắn cần hỗ trợ.', 'warning');
    return;
  }

  const priority = emergencyEl?.checked ? 'emergency' : 'normal';
  const orderId = (crmSupportLinkOrder && activeOrder?.id)
    ? activeOrder.id
    : (crmSupportThread?.orderId || null);

  crmSupportSendInFlight = true;
  if (btn) btn.disabled = true;
  if (input) input.disabled = true;

  try {
    const res = await apiFetch(`${API_BASE}/api/shippers/support/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getAuthItem(AUTH_JWT_KEY)}`
      },
      body: JSON.stringify({ text, orderId, priority })
    }, 12000);
    const data = await safeJson(res);
    if (res.ok && data.success) {
      if (input) input.value = '';
      if (emergencyEl) emergencyEl.checked = false;
      crmSupportLinkOrder = false;
      const wasComposingNew = crmSupportComposingNew;
      crmSupportComposingNew = false;
      lastCrmSupportStatus = data.data ? data.data.status : lastCrmSupportStatus;
      renderCrmSupportMessages(data.data);
      showToast(
        wasComposingNew ? 'Đã tạo yêu cầu mới' : 'Đã gửi CRM',
        priority === 'emergency' ? 'Đã báo khẩn cấp tới CRM.' : 'CRM đã nhận tin nhắn của bạn.',
        'success'
      );
    } else {
      showToast('Gửi thất bại', data.error || 'Không gửi được tin nhắn.', 'error');
    }
  } catch (e) {
    console.error('[CRM Support] send failed:', e);
    showToast('Lỗi kết nối', 'Không thể gửi tin tới CRM.', 'error');
  } finally {
    crmSupportSendInFlight = false;
    if (btn) btn.disabled = false;
    if (input) {
      input.disabled = false;
      input.focus();
    }
  }
}
window.sendCrmSupportMessage = sendCrmSupportMessage;

function startCrmSupportPolling() {
  stopCrmSupportPolling();
  if (!currentDriver || !getAuthItem(AUTH_JWT_KEY)) return;
  loadCrmSupportThread();
  crmSupportPollTimer = setInterval(() => {
    loadCrmSupportThread();
  }, 8000);
}

function stopCrmSupportPolling() {
  if (crmSupportPollTimer) {
    clearInterval(crmSupportPollTimer);
    crmSupportPollTimer = null;
  }
}

let crmSupportKbHandler = null;
function unbindCrmSupportKeyboardAvoidance() {
  if (crmSupportKbHandler && window.visualViewport) {
    window.visualViewport.removeEventListener('resize', crmSupportKbHandler);
    window.visualViewport.removeEventListener('scroll', crmSupportKbHandler);
  }
  crmSupportKbHandler = null;
  const sheet = document.getElementById('crm-support-panel');
  if (sheet) {
    sheet.classList.remove('is-kb-open');
    sheet.style.transform = '';
    sheet.style.removeProperty('--kb-inset');
  }
}
function bindCrmSupportKeyboardAvoidance() {
  unbindCrmSupportKeyboardAvoidance();
  const sheet = document.getElementById('crm-support-panel');
  if (!sheet || !window.visualViewport) return;
  sheet.classList.add('is-kb-open');
  crmSupportKbHandler = () => {
    const vv = window.visualViewport;
    const occluded = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    sheet.style.setProperty('--kb-inset', occluded + 'px');
    sheet.style.transform = occluded > 0 ? `translateY(-${Math.min(occluded, 220)}px)` : '';
  };
  window.visualViewport.addEventListener('resize', crmSupportKbHandler);
  window.visualViewport.addEventListener('scroll', crmSupportKbHandler);
  crmSupportKbHandler();
}

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('crm-support-input');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        sendCrmSupportMessage();
      }
    });
    input.addEventListener('focus', () => {
      if (crmSupportSheetOpen) bindCrmSupportKeyboardAvoidance();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && crmSupportSheetOpen) closeCrmSupportSheet();
  });
  updateCrmSupportOrderTag();
});

function geocodeAddressOffline(address, name) {
  const text = ((address || '') + ' ' + (name || '')).toLowerCase();
  
  // Basic Vietnamese tone removal to improve matching
  const cleanText = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // CMT8 dài nhiều quận — chọn theo phường trong địa chỉ
  if (cleanText.includes('cach mang thang 8') || cleanText.includes('cmt8')) {
    if (cleanText.includes('binh thuy') || cleanText.includes('an thoi')) {
      return { lat: 10.06014, lon: 105.76537 };
    }
    return { lat: 10.05031, lon: 105.77514 }; // Cái Khế / Ninh Kiều
  }

  const mappings = [
    { keys: ['nguyen van cu'], lat: 10.0298, lon: 105.7584 },
    { keys: ['mau than'], lat: 10.0276, lon: 105.7725 },
    { keys: ['ba thang hai', '3 thang 2', '3/2'], lat: 10.0244, lon: 105.7676 },
    { keys: ['30 thang 4', 'ba muoi thang tu', '30/4'], lat: 10.0165, lon: 105.7708 },
    { keys: ['tran hung dao'], lat: 10.0381, lon: 105.7801 },
    { keys: ['ly tu trong'], lat: 10.0354, lon: 105.7825 },
    { keys: ['hung vuong'], lat: 10.0415, lon: 105.7818 },
    { keys: ['tran van hoai'], lat: 10.0261, lon: 105.7772 },
    { keys: ['tam vu'], lat: 10.0182, lon: 105.7720 },
    { keys: ['de tham'], lat: 10.0336, lon: 105.7828 },
    { keys: ['quang trung'], lat: 10.0229, lon: 105.7905 },
    { keys: ['vo van kiet'], lat: 10.0526, lon: 105.7502 },
    { keys: ['cai rang'], lat: 9.9968, lon: 105.7505 },
    { keys: ['o mon'], lat: 10.1205, lon: 105.6292 },
    { keys: ['binh thuy'], lat: 10.0763, lon: 105.7289 }
  ];

  for (const mapping of mappings) {
    if (mapping.keys.some(key => cleanText.includes(key))) {
      return { lat: mapping.lat, lon: mapping.lon };
    }
  }

  // Default Ninh Kieu Center
  return { lat: 10.0345, lon: 105.7876 };
}

function parseCoord(value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function openExternalMapsUrl(url) {
  // Anchor click tránh popup-blocker trên mobile; fallback gán location
  try {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch (err) {
    console.warn('[Navigation] anchor open failed', err);
  }
  try {
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (opened) return true;
  } catch (_) { /* ignore */ }
  try {
    window.location.href = url;
    return true;
  } catch (err) {
    console.error('[Navigation] location assign failed', err);
    return false;
  }
}

function cleanMapsText(s) {
  return String(s || '')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .trim();
}

/** Rút tên quán gọn (trước dấu " - ") để Google khớp listing, vd. BINBIN / Nhi Nhi's */
function shortRestaurantName(name) {
  const n = cleanMapsText(name);
  if (!n) return '';
  const cut = n.split(/\s+-\s+/)[0].trim();
  return cut || n;
}

/**
 * Địa chỉ quán cho Google Maps — giữ nguyên địa chỉ đã cào (số nhà + đường + phường/quận).
 * Không rút gọn Quận/TP (dễ làm Google lệch điểm).
 */
function formatRestaurantMapsDestination(name, address) {
  const shortName = shortRestaurantName(name);
  let addr = cleanMapsText(address);

  addr = addr
    .replace(/\s+,/g, ',')
    .replace(/,{2,}/g, ',')
    .replace(/\s+/g, ' ')
    .trim();

  const parts = [];
  if (addr) {
    parts.push(addr);
  } else if (shortName) {
    parts.push(shortName);
  }
  let dest = parts.join(', ');
  if (dest && !/việt\s*nam|vietnam/i.test(dest)) {
    dest += ', Việt Nam';
  }
  return dest;
}

function buildGoogleMapsDirectionsUrl({ lat, lon, label, preferLabel = false }) {
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);
  const text = (label || '').trim();

  // Có tọa độ exact từ crawl → ghim GPS chính xác
  if (!preferLabel && hasCoords) {
    return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=two-wheeler&dir_action=navigate`;
  }
  // Không có GPS exact → dùng đúng chuỗi địa chỉ đã cào
  if (text) {
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(text)}&travelmode=two-wheeler&dir_action=navigate`;
  }
  if (hasCoords) {
    return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=two-wheeler&dir_action=navigate`;
  }
  return null;
}

function navigateToPoint(target) {
  if (!activeOrder) {
    showToast('Không có đơn hàng', 'Không tìm thấy thông tin đơn hàng hoạt động.', 'warning');
    return;
  }

  let lat = null;
  let lon = null;
  let label = '';
  let preferLabel = false;

  if (target === 'restaurant') {
    // Địa chỉ chuẩn từ server hydrate (DB cào) — không mangling
    label = formatRestaurantMapsDestination(
      activeOrder.restaurantName,
      activeOrder.restaurantAddress
    );

    lat = parseCoord(activeOrder.restaurantLat);
    lon = parseCoord(activeOrder.restaurantLon);

    // Chỉ dùng GPS khi server đánh dấu exact (coords từ Grab/Shopee crawl)
    // Tránh heuristic đường phố (centroid) → chỉ đường sai
    const exact = activeOrder.restaurantCoordsExact === true;
    if (exact && lat != null && lon != null) {
      preferLabel = false;
    } else {
      preferLabel = !!label;
      // Không fallback geocodeAddressOffline cho quán — dễ lệch
      if (!preferLabel && (lat == null || lon == null)) {
        showToast('Thiếu địa chỉ quán', 'Đơn này chưa có địa chỉ quán để chỉ đường.', 'error');
        return;
      }
    }

    console.log('[Navigation] Restaurant', {
      preferLabel,
      exact,
      label,
      lat,
      lon,
      address: activeOrder.restaurantAddress
    });
  } else if (target === 'customer') {
    // Điểm giao: ưu tiên pin GPS của khách (chính xác)
    lat = parseCoord(activeOrder.pinnedLat);
    lon = parseCoord(activeOrder.pinnedLon);
    label = formatRestaurantMapsDestination(
      activeOrder.deliveryName || '',
      activeOrder.deliveryAddress || ''
    );

    if (lat == null || lon == null) {
      const coords = geocodeAddressOffline(activeOrder.deliveryAddress || '', '');
      lat = coords.lat;
      lon = coords.lon;
      console.log(`[Navigation] Geocoded customer offline fallback: ${lat}, ${lon}`);
      preferLabel = !!label;
    }
  } else {
    showToast('Lỗi', 'Điểm chỉ đường không hợp lệ.', 'error');
    return;
  }

  const url = buildGoogleMapsDirectionsUrl({ lat, lon, label, preferLabel });
  if (!url) {
    showToast('Thiếu địa chỉ', 'Đơn hàng này chưa có địa chỉ hoặc tọa độ để chỉ đường.', 'error');
    return;
  }

  console.log('[Navigation] Opening:', url);
  const ok = openExternalMapsUrl(url);
  if (!ok) {
    showToast('Không mở được Maps', label || 'Sao chép địa chỉ và mở Google Maps thủ công.', 'error');
  }
}
window.navigateToPoint = navigateToPoint;

/* --------------------------------------------------------------------------
   PWA — register service worker (ShipFee Tài Xế, tách biệt customer-app)
   -------------------------------------------------------------------------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const swUrl = new URL('sw.js?v=3.0', window.location.href).href;
    navigator.serviceWorker.register(swUrl).then((reg) => {
      if (reg && typeof reg.update === 'function') reg.update().catch(() => {});
    }).catch(() => {});
  });
}
