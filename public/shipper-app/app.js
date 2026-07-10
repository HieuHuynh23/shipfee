/* ==========================================================================
   SHIPFEE — Shipper App JavaScript Logic
   ========================================================================== */

'use strict';

const defaultApiUrl = 'https://shipfee-eo5s.onrender.com';

if (localStorage.getItem('shipfee_api_url')) {
  localStorage.removeItem('shipfee_api_url');
}
const API_BASE = defaultApiUrl;
const originalFetch = window.fetch;
window.fetch = function(input, init) {
  if (typeof input === 'string' && input.startsWith('http://localhost:3001')) {
    input = input.replace('http://localhost:3001', API_BASE);
  }
  const token = sessionStorage.getItem('shipfee_jwt');
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

// Helper to normalize phone numbers for robust matching (removes spaces)
function cleanPhone(p) {
  return (p || '').toString().trim().replace(/\s+/g, '');
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
      sessionStorage.removeItem('shipfee_jwt');
      sessionStorage.removeItem('shipfee_driver');
      document.getElementById('approval-overlay').style.display = 'none';
      document.getElementById('login-overlay').classList.add('active');
    }).catch(() => {
      sessionStorage.removeItem('shipfee_jwt');
      sessionStorage.removeItem('shipfee_driver');
      document.getElementById('approval-overlay').style.display = 'none';
      document.getElementById('login-overlay').classList.add('active');
    });
  } else {
    sessionStorage.removeItem('shipfee_jwt');
    sessionStorage.removeItem('shipfee_driver');
    document.getElementById('approval-overlay').style.display = 'none';
    document.getElementById('login-overlay').classList.add('active');
  }
}
window.logoutApprovalPending = logoutApprovalPending;

// ── STATE MANAGEMENT ────────────────────────────────────────────────────────
let supabaseClient = null;
let currentDriver = null; // { name, phone }
let activeOrder = null;   // current accepted order
let pendingOrders = [];   // list of pending orders
let historyOrders = [];   // completed orders by this driver
let isOnline = true;      // receiving orders
let pollInterval = null;
let watchPositionId = null;
let targetedOffer = null; // current active job offer
let offerTimerInterval = null;

// Performance stats (Acceptance Rate, Completion Rate)
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

// ── DOM LOADED ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await initSupabase();
  loadDriverInfo();
  loadStats();
  initApp();
});

async function initApp() {
  if (currentDriver) {
    document.getElementById('login-overlay').classList.remove('active');
    updateDriverHeader();
    
    // Set UI immediately from sessionStorage to prevent flash of OFFLINE status
    const savedStatus = sessionStorage.getItem('shipfee_driver_online') || 'true';
    isOnline = (savedStatus === 'true');
    const checkbox = document.getElementById('online-switch');
    const statusText = document.getElementById('status-text');
    if (checkbox && statusText) {
      checkbox.checked = isOnline;
      if (isOnline) {
        statusText.textContent = 'Đang trong ca (Check-in)';
        statusText.className = 'status-indicator online';
      } else {
        statusText.textContent = 'Đã tắt ca (Check-out)';
        statusText.className = 'status-indicator offline';
      }
    }
    
    // Đồng bộ trạng thái ca làm việc (Check-in/Check-out) từ server bằng API profile
    try {
      const res = await fetch(`${API_BASE}/api/shippers/profile?phone=${encodeURIComponent(currentDriver.phone)}`);
      if (res.ok) {
        const json = await res.json();
        if (json.success && json.shipper) {
          isOnline = (json.shipper.status === 'ONLINE');
          sessionStorage.setItem('shipfee_driver_online', isOnline);
          if (checkbox && statusText) {
            checkbox.checked = isOnline;
            if (isOnline) {
              statusText.textContent = 'Đang trong ca (Check-in)';
              statusText.className = 'status-indicator online';
            } else {
              statusText.textContent = 'Đã tắt ca (Check-out)';
              statusText.className = 'status-indicator offline';
            }
          }
        }
      }
    } catch (e) {
      console.warn('Không thể đồng bộ trạng thái ca lúc khởi chạy:', e);
    }
    
    startPolling();
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
    btn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Đăng nhập với Supabase';
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
    // 1. Tạo tài khoản thông qua API Backend (sử dụng signUp để gửi email xác nhận)
    const response = await fetch(`${API_BASE}/api/shippers/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name, phone, email, password, avatar: driverAvatarBase64, cccd })
    });

    const res = await response.json();
    if (!response.ok || !res.success) {
      showToast('Đăng ký thất bại', res.error || 'Đăng ký tài khoản thất bại.', 'error');
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Đăng ký tài khoản';
      return;
    }

    // 2. Thông báo đăng ký thành công (email được tự động kích hoạt) và chờ Admin duyệt SĐT
    showToast(
      'Đăng ký thành công!', 
      'Tài khoản của bạn đã được khởi tạo và tự động xác thực email. Vui lòng chờ Admin duyệt Số điện thoại để bắt đầu nhận đơn!', 
      'success'
    );
    toggleAuthMode();
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Đăng nhập với Supabase';
    return;
  } catch (err) {
    console.error('Lỗi đăng ký tài xế:', err);
    showToast('Lỗi kết nối', 'Không thể kết nối đến máy chủ API.', 'error');
  }
  btn.disabled = false;
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
      sessionStorage.setItem('shipfee_driver', JSON.stringify(currentDriver));
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
    const raw = sessionStorage.getItem('shipfee_driver');
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

  const emailInput = document.getElementById('driver-email');
  const passwordInput = document.getElementById('driver-password');
  const email = emailInput.value.trim();
  const password = passwordInput.value.trim();

  if (!email || !password) {
    showToast('Thiếu thông tin', 'Vui lòng nhập Email và Mật khẩu.', 'warning');
    return;
  }

  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) {
      showToast('Đăng nhập thất bại', error.message, 'error');
      return;
    }

    const session = data.session;
    sessionStorage.setItem('shipfee_jwt', session.access_token);

    // Gọi API của server để đồng bộ và lấy thông tin shipper
    const response = await fetch(`${API_BASE}/api/shippers/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ token: session.access_token })
    });

    if (response.status === 403) {
      // Tài khoản đang chờ phê duyệt
      document.getElementById('login-overlay').classList.remove('active');
      document.getElementById('approval-overlay').style.display = 'flex';
      return;
    }

    const result = await response.json();
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
      sessionStorage.setItem('shipfee_driver', JSON.stringify(currentDriver));
      loadStats();

      document.getElementById('login-overlay').classList.remove('active');
      updateDriverHeader();
      showToast('Đăng nhập thành công', `Chào mừng ${currentDriver.name} đã vào hệ thống!`, 'success');

      isOnline = true;
      sessionStorage.setItem('shipfee_driver_online', 'true');
      const checkbox = document.getElementById('online-switch');
      const statusText = document.getElementById('status-text');
      if (checkbox && statusText) {
        checkbox.checked = true;
        statusText.textContent = 'Đang trong ca (Check-in)';
        statusText.className = 'status-indicator online';
      }

      fetch(`${API_BASE}/api/shippers/shift`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ phone: currentDriver.phone, status: 'ONLINE' })
      }).catch(err => console.warn('Lỗi tự động vào ca:', err));

      startPolling();
    } else {
      showToast('Đăng nhập thất bại', result.error || 'Đồng bộ thông tin tài xế thất bại.', 'error');
    }
  } catch (err) {
    console.error('Lỗi login Supabase:', err);
    showToast('Lỗi kết nối', 'Không thể kết nối với Supabase Auth.', 'error');
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
  
  try {
    const res = await fetch(`${API_BASE}/api/shippers/shift`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ phone: currentDriver.phone, status: statusString })
    });
    
    const result = await res.json();
    if (res.ok && result.success) {
      isOnline = nextOnline;
      sessionStorage.setItem('shipfee_driver_online', isOnline);
      if (isOnline) {
        statusText.textContent = 'Đang trong ca (Check-in)';
        statusText.className = 'status-indicator online';
        showToast('Vào ca thành công 🟢', 'Đã ghi nhận Check-in trên hệ thống.', 'success');
        startPolling();
      } else {
        statusText.textContent = 'Đã tắt ca (Check-out)';
        statusText.className = 'status-indicator offline';
        showToast('Ra ca thành công 🔴', 'Đã ghi nhận Check-out trên hệ thống.', 'info');
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
  }
}

// ── POLLING DATA ────────────────────────────────────────────────────────────
function startPolling() {
  stopPolling();
  if (isOnline) {
    startGpsTracking();
  }
  syncAllData();
  pollInterval = setInterval(syncAllData, 3000);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (!activeOrder) {
    stopGpsTracking();
  }
}

function startActiveOrderPolling() {
  stopPolling();
  pollInterval = setInterval(async () => {
    if (!activeOrder) {
      startPolling();
      return;
    }
    await syncActiveOrderOnly();
  }, 3000);
}

let lastPendingLength = 0;

async function syncAllData() {
  if (!currentDriver) return;
  
  try {
    const url = `${API_BASE}/api/orders?shipperPhone=${encodeURIComponent(currentDriver.phone)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('API server error');
    const result = await res.json();
    
    if (result.success && Array.isArray(result.data)) {
      const allOrders = result.data;
      
      pendingOrders = allOrders.filter(o => o.status === 'PENDING');
      
      // Detect targeted job offer specifically for this driver
      const myOffer = pendingOrders.find(o => o.assignedShipperPhone && cleanPhone(o.assignedShipperPhone) === cleanPhone(currentDriver.phone));
      handleTargetedOffer(myOffer);
      
      // Filter out the targeted offer from the background "Tìm Đơn" list to avoid redundancy
      const poolOrders = pendingOrders.filter(o => !o.assignedShipperPhone || cleanPhone(o.assignedShipperPhone) !== cleanPhone(currentDriver.phone));
      
      // Play Synthesizer Chime if new orders appear in the public pool
      if (isOnline && poolOrders.length > lastPendingLength) {
        playChimeSound();
        showToast('Có Đơn Mới! 🛵', 'Tài xế có đơn hàng mới lân cận cần xử lý.', 'success');
      }
      lastPendingLength = poolOrders.length;

      if (isOnline && !activeOrder) {
        renderPendingOrders(poolOrders);
      }

      // Nếu tài xế đang xem chi tiết một đơn hàng thủ công mà đơn đó không còn PENDING nữa
      if (activeJobId && !pendingOrders.some(o => o.id === activeJobId)) {
        closeJobDetail();
        showToast('Đơn hàng đã hết hạn ⏰', 'Đơn hàng này đã được tài xế khác nhận hoặc đã bị hủy.', 'info');
      }
      
      historyOrders = allOrders.filter(o => cleanPhone(o.shipperPhone) === cleanPhone(currentDriver.phone) && o.status === 'DELIVERED');
      renderHistoryAndStats();
      
      const activeDriverOrders = allOrders.filter(o => cleanPhone(o.shipperPhone) === cleanPhone(currentDriver.phone) && o.status !== 'DELIVERED');
      const currentActive = activeDriverOrders.length > 0 ? activeDriverOrders[activeDriverOrders.length - 1] : null;
      
      if (currentActive) {
        const isNewOrStatusChanged = (!activeOrder || activeOrder.id !== currentActive.id || activeOrder.status !== currentActive.status);
        const isFirstLoad = !activeOrder;
        
        // Kiểm tra tin nhắn mới từ khách hàng
        if (activeOrder && activeOrder.id === currentActive.id) {
          checkNewMessages(activeOrder, currentActive);
        }
        
        activeOrder = currentActive;
        if (isNewOrStatusChanged) {
          renderActiveTrip();
        }
        if (isFirstLoad) {
          switchTab('trip');
          startGpsTracking();
          if (typeof playChimeSound === 'function') playChimeSound();
          showToast('Nhận đơn thành công! ⚡', 'Hệ thống đã tự động gán đơn hàng ưu tiên cho bạn.', 'success');
        }
        if (document.getElementById('chat-overlay').classList.contains('active')) {
          renderShipperChatMessages();
        }
        // Thăm dò cuộc gọi đến từ khách hàng
        checkIncomingCall(activeOrder.id);
      } else {
        if (activeOrder) {
          activeOrder = null;
          stopGpsTracking();
          renderActiveTrip();
        }
      }
    }
  } catch (err) {
    console.error('[Shipper App] Error syncing data:', err);
  }
}

async function syncActiveOrderOnly() {
  if (!activeOrder) return;
  try {
    const res = await fetch(`${API_BASE}/api/orders/${activeOrder.id}`);
    if (res.status === 404) {
      showToast('Đơn hàng không tồn tại', 'Đơn hàng hiện tại không còn trên hệ thống.', 'warning');
      activeOrder = null;
      stopGpsTracking();
      renderActiveTrip();
      startPolling();
      return;
    }
    if (!res.ok) return;
    const result = await res.json();
    if (result.success && result.data) {
      const orderData = result.data;
      if (orderData.status === 'DELIVERED') {
        showToast('Đơn hàng hoàn tất', 'Đơn hàng đã được giao thành công!', 'success');
        activeOrder = null;
        stopGpsTracking();
        renderActiveTrip();
        startPolling();
      } else {
        const statusChanged = (orderData.status !== activeOrder.status);
        
        // Kiểm tra tin nhắn mới từ khách hàng
        checkNewMessages(activeOrder, orderData);
        
        activeOrder = orderData;
        if (statusChanged) {
          renderActiveTrip();
        }
        if (document.getElementById('chat-overlay').classList.contains('active')) {
          renderShipperChatMessages();
        }
        checkIncomingCall(activeOrder.id);
      }
    }
  } catch (e) {
    console.error('[Shipper App] Error syncing active order:', e);
  }
}

// ── NEW MESSAGE NOTIFICATION DETECTOR ───────────────────────────────────────
function checkNewMessages(oldOrder, newOrder) {
  if (!oldOrder || !newOrder || !newOrder.messages) return;
  const oldMsgs = oldOrder.messages || [];
  const newMsgs = newOrder.messages;
  
  if (newMsgs.length > oldMsgs.length) {
    const newCustomerMsgs = newMsgs.slice(oldMsgs.length).filter(m => m.sender === 'customer');
    if (newCustomerMsgs.length > 0) {
      playMessageChimeSound();
      const lastMsg = newCustomerMsgs[newCustomerMsgs.length - 1];
      showToast('Khách hàng nhắn tin 💬', lastMsg.text, 'info');
    }
  }
}

// ── TAB ROUTING ─────────────────────────────────────────────────────────────
function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  const btn = document.getElementById(`nav-btn-${tabId}`);
  if (btn) btn.classList.add('active');
  
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  const content = document.getElementById(`tab-${tabId}`);
  if (content) content.classList.add('active');
  
  if (tabId === 'orders') {
    renderPendingOrders(pendingOrders);
  } else if (tabId === 'trip') {
    renderActiveTrip();
  } else if (tabId === 'history') {
    renderHistoryAndStats();
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
      
      assistanceHtml = `
        <div id="assistance-container" style="margin-top: 15px; text-align: center; width: 100%;">
          <button class="btn" id="btn-request-assistance" onclick="requestOrderAssistance()" 
            ${isRequested ? 'disabled' : ''} 
            style="background: ${isRequested ? '#4b5563' : '#dc2626'}; color: white; padding: 10px 18px; font-weight: 700; border-radius: 8px; border: none; font-size: 13px; cursor: ${isRequested ? 'not-allowed' : 'pointer'}; display: inline-flex; align-items: center; gap: 6px;">
            <i class="fa-solid ${isRequested ? 'fa-hourglass-half' : 'fa-circle-question'}"></i> 
            ${isRequested ? 'Đang chờ gán đơn ưu tiên...' : '🆘 Yêu cầu Hỗ trợ Tìm đơn'}
          </button>
          <p style="font-size: 11px; color: var(--clr-text-muted); margin-top: 6px; margin-bottom: 0;">
            Lưu ý: Chỉ hỗ trợ tối đa 3 lần/ngày. Đã dùng: <strong id="assistance-used-count">${usedToday}</strong>/3
          </p>
        </div>
      `;
    }

    container.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-radar fa-spin-slow" style="color:var(--clr-text-muted);"></i>
        <p>${isOnline ? 'Đang tìm kiếm đơn hàng lân cận...' : 'Vui lòng BẬT NHẬN ĐƠN để tìm đơn mới'}</p>
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
        <span class="order-card__id">${order.id}</span>
        <span class="order-card__time">${formatTime(order.createdAt)}</span>
      </div>
      <div class="order-card__points">
        <div class="card-point">
          <span class="card-point__icon">🏪</span>
          <div>
            <div class="card-point__name">${order.restaurantName}</div>
            <div class="card-point__address">${order.restaurantAddress}</div>
          </div>
        </div>
        <div class="card-point">
          <span class="card-point__icon">🏠</span>
          <div>
            <div class="card-point__name">Khách hàng: ${order.deliveryAddress}</div>
            <div class="card-point__address" style="color:var(--clr-accent); font-weight:600;">Món ăn: ${itemsLabel}</div>
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
    (order.items || []).forEach(item => {
      const optsText = (item.selectedOptions && item.selectedOptions.length > 0)
        ? ` <span style="color: var(--clr-text-secondary); font-size:11px;">(${item.selectedOptions.map(o => o.name).join(', ')})</span>`
        : '';
      const noteHtml = (item.note && item.note.trim() && item.note !== 'undefined' && item.note !== 'null')
        ? `<div style="color: #b45309; font-size: 11px; margin-top: 4px; padding: 4px 8px; background: rgba(245, 158, 11, 0.05); border: 1px dashed rgba(245, 158, 11, 0.25); border-radius: 4px; display: inline-block; width: 100%; box-sizing: border-box;"><i class="fa-solid fa-note-sticky"></i> Ghi chú món: <strong>${item.note}</strong></div>`
        : '';
      
      const itemEl = document.createElement('div');
      itemEl.style.borderBottom = '1px solid var(--clr-border)';
      itemEl.style.paddingBottom = '8px';
      itemEl.style.marginTop = '4px';
      itemEl.innerHTML = `
        <div style="display:flex; justify-content:space-between; font-size:13px; font-weight:600; margin-bottom: 2px;">
          <span style="color:var(--clr-text-primary); text-align:left;">${item.name}${optsText}</span>
          <span style="color:var(--clr-primary); margin-left: 8px; font-weight: 700;">x${item.quantity || item.qty || 1}</span>
        </div>
        ${noteHtml}
      `;
      itemsContainer.appendChild(itemEl);
    });
  }

  const noteBox = document.getElementById('job-note-box');
  const noteText = document.getElementById('job-note-text');
  if (noteBox && noteText) {
    if (order.note && order.note.trim()) {
      noteText.textContent = order.note;
      noteBox.style.display = 'block';
    } else {
      noteText.textContent = '—';
      noteBox.style.display = 'none';
    }
  }
  
  document.getElementById('order-detail-overlay').classList.add('active');
  
  // Initialize accept swipe button
  initSwipeButton('accept-swipe-container', 'accept-swipe-handle', 'accept-swipe-text', () => {
    document.getElementById('order-detail-overlay').classList.remove('active');
    acceptOrder(activeJobId);
  });
}

function closeJobDetail() {
  document.getElementById('order-detail-overlay').classList.remove('active');
  activeJobId = null;
}

function declineOrder() {
  if (activeJobId) {
    stats.declined++;
    saveStats();
    showToast('Đã từ chối đơn', `Bạn đã bỏ qua đơn hàng ${activeJobId}.`, 'info');
    closeJobDetail();
    syncAllData();
  }
}

// ── ACCEPT ORDER ───────────────────────────────────────────────────────────
async function acceptOrder(orderId) {
  if (!currentDriver) {
    document.getElementById('login-overlay').classList.add('active');
    return;
  }
  
  try {
    const response = await fetch(`${API_BASE}/api/orders/${orderId}/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        shipperId: currentDriver.phone,
        shipperName: currentDriver.name,
        shipperPhone: currentDriver.phone
      })
    });
    
    const result = await response.json();
    if (response.ok && result.success) {
      stats.accepted++;
      saveStats();
      showToast('Đã nhận đơn!', `Bạn đã nhận đơn hàng ${orderId}.`, 'success');
      activeOrder = result.data;
      switchTab('trip');
      startGpsTracking();
      startActiveOrderPolling();
    } else {
      showToast('Lỗi nhận đơn', result.error || 'Không thể nhận đơn này.', 'error');
      syncAllData();
    }
  } catch (e) {
    console.error('Lỗi nhận đơn:', e);
    showToast('Lỗi kết nối', 'Không thể kết nối với server.', 'error');
  }
}

// ── RENDER ACTIVE TRIP ──────────────────────────────────────────────────────
function renderActiveTrip() {
  const emptyTrip = document.getElementById('no-active-trip');
  const tripContainer = document.getElementById('active-trip-container');
  
  if (!activeOrder) {
    emptyTrip.style.display = 'flex';
    tripContainer.style.display = 'none';
    if (tripMap) {
      tripMap.remove();
      tripMap = null;
    }
    return;
  }
  
  emptyTrip.style.display = 'none';
  tripContainer.style.display = 'block';
  
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
    (activeOrder.items || []).forEach(item => {
      const optsText = (item.selectedOptions && item.selectedOptions.length > 0)
        ? ` <span style="color: var(--clr-text-secondary); font-size:11px;">(${item.selectedOptions.map(o => o.name).join(', ')})</span>`
        : '';
      const noteHtml = (item.note && item.note.trim() && item.note !== 'undefined' && item.note !== 'null')
        ? `<div style="color: #b45309; font-size: 11px; margin-top: 4px; padding: 4px 8px; background: rgba(245, 158, 11, 0.05); border: 1px dashed rgba(245, 158, 11, 0.25); border-radius: 4px; display: inline-block; width: 100%; box-sizing: border-box;"><i class="fa-solid fa-note-sticky"></i> Ghi chú món: <strong>${item.note}</strong></div>`
        : '';
      
      const itemEl = document.createElement('div');
      itemEl.style.borderBottom = '1px solid var(--clr-border)';
      itemEl.style.paddingBottom = '8px';
      itemEl.style.marginTop = '4px';
      itemEl.innerHTML = `
        <div style="display:flex; justify-content:space-between; font-size:13px; font-weight:600; margin-bottom: 2px;">
          <span style="color:var(--clr-text-primary); text-align:left;">${item.name}${optsText}</span>
          <span style="color:var(--clr-primary); margin-left: 8px; font-weight: 700;">x${item.quantity || item.qty || 1}</span>
        </div>
        ${noteHtml}
      `;
      tripItemsContainer.appendChild(itemEl);
    });
  }

  const tripNoteBox = document.getElementById('trip-note-box');
  const tripNoteText = document.getElementById('trip-note-text');
  if (tripNoteBox && tripNoteText) {
    if (activeOrder.note && activeOrder.note.trim()) {
      tripNoteText.textContent = activeOrder.note;
      tripNoteBox.style.display = 'block';
    } else {
      tripNoteText.textContent = '—';
      tripNoteBox.style.display = 'none';
    }
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
  
  // Show / Hide navigation buttons based on coordinates availability
  const btnNavRest = document.getElementById('btn-nav-restaurant');
  const btnNavCust = document.getElementById('btn-nav-customer');
  if (btnNavRest) {
    if (activeOrder.restaurantLat && activeOrder.restaurantLon) {
      btnNavRest.style.display = 'inline-flex';
    } else {
      btnNavRest.style.display = 'none';
    }
  }
  if (btnNavCust) {
    if (activeOrder.pinnedLat && activeOrder.pinnedLon) {
      btnNavCust.style.display = 'inline-flex';
    } else {
      btnNavCust.style.display = 'none';
    }
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
function initTripMap() {
  if (!activeOrder) return;
  
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
      if (mapContainer && mapContainer._leaflet_id) {
        const parent = mapContainer.parentNode;
        const newContainer = mapContainer.cloneNode(false);
        newContainer.removeAttribute('_leaflet_id');
        parent.replaceChild(newContainer, mapContainer);
      }
      
      tripMap = L.map('shipper-map', { zoomControl: false }).setView([shipLat, shipLon], 16);
      
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
  if (!activeOrder) return;
  
  const nextStatus = activeOrder.status === 'ACCEPTED' ? 'PURCHASED' : 'DELIVERED';
  
  try {
    const response = await fetch(`${API_BASE}/api/orders/${activeOrder.id}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status: nextStatus })
    });
    
    const result = await response.json();
    if (response.ok && result.success) {
      if (nextStatus === 'DELIVERED') {
        stats.completed++;
        saveStats();
        showToast('Hoàn thành đơn hàng!', 'Bạn đã hoàn tất giao hàng.', 'success');
        activeOrder = null;
        stopGpsTracking();
        renderActiveTrip();
        startPolling();
      } else {
        showToast('Đã lấy hàng!', 'Hãy chuyển đồ ăn đến khách hàng.', 'success');
        activeOrder = result.data;
        renderActiveTrip();
      }
    } else {
      showToast('Lỗi cập nhật', result.error || 'Không thể cập nhật trạng thái.', 'error');
    }
  } catch (e) {
    console.error('Lỗi cập nhật đơn:', e);
    showToast('Lỗi kết nối', 'Không thể kết nối với server.', 'error');
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
    document.getElementById('gps-indicator').innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> GPS: Thiết bị không hỗ trợ Geolocation`;
    return;
  }
  
  document.getElementById('gps-indicator').innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> GPS: Đang khởi động định vị...`;
  
  watchPositionId = navigator.geolocation.watchPosition(
    async (position) => {
      let lat = position.coords.latitude;
      let lon = position.coords.longitude;
      
      // Kiểm tra xem vị trí có nằm ngoài Cần Thơ không (cách trung tâm Ninh Kiều > 20km)
      const distFromCenter = calculateDistance(lat, lon, 10.0345, 105.7876);
      if (distFromCenter > 20) {
        // Tự động chuyển vị trí về Trung tâm Cần Thơ + jitter nhỏ để tránh chồng đè marker
        const jitterLat = (Math.random() - 0.5) * 0.006;
        const jitterLon = (Math.random() - 0.5) * 0.006;
        lat = 10.0345 + jitterLat;
        lon = 105.7876 + jitterLon;
        document.getElementById('gps-indicator').innerHTML = `<i class="fa-solid fa-location-crosshairs fa-spin-slow"></i> GPS: (${lat.toFixed(5)}, ${lon.toFixed(5)}) (Giả lập Cần Thơ)`;
      } else {
        document.getElementById('gps-indicator').innerHTML = `<i class="fa-solid fa-location-crosshairs fa-spin-slow"></i> GPS: (${lat.toFixed(5)}, ${lon.toFixed(5)})`;
      }
      
      if (shipperMarker) {
        shipperMarker.setLatLng([lat, lon]);
      }
      if (tripMap) {
        tripMap.setView([lat, lon], 16);
      }
      
      const now = Date.now();
      if (now - lastGpsSendTime >= 5000) {
        lastGpsSendTime = now;
        sendLocationToServer(lat, lon);
      }
    },
    (error) => {
      console.warn('Geolocation error:', error);
      document.getElementById('gps-indicator').innerHTML = `<i class="fa-solid fa-circle-exclamation" style="color:var(--clr-danger)"></i> GPS: Không thể lấy vị trí (${error.message})`;
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000
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
    if (activeOrder) {
      await fetch(`${API_BASE}/api/orders/${activeOrder.id}/location`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ lat, lon })
      });
    } else if (isOnline && currentDriver) {
      await fetch(`${API_BASE}/api/shippers/location`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          phone: currentDriver.phone,
          lat,
          lon
        })
      });
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
      document.getElementById('job-offer-overlay').classList.remove('active');
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

    initSwipeButton('offer-swipe-container', 'offer-swipe-handle', 'offer-swipe-text', () => {
      document.getElementById('job-offer-overlay').classList.remove('active');
      clearOfferTimer();
      targetedOffer = null;
      acceptOrder(offer.id);
    });

    startOfferTimer(offer.offerExpiresAt);
    
    playChimeSound();
    showToast('Đơn Đề Xuất Mới! 🎯', 'Có đơn hàng dành riêng cho bạn! Hãy nhận ngay.', 'warning');
  }
}

function startOfferTimer(expiresAt) {
  clearOfferTimer();
  
  const progressBar = document.getElementById('offer-progress-bar');
  const timerSeconds = document.getElementById('offer-timer-seconds');
  const totalDuration = 30000;

  function updateTimer() {
    const remaining = expiresAt - Date.now();
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
}

async function declineTargetedOffer(isAuto = false) {
  if (!targetedOffer) return;
  const offerId = targetedOffer.id;
  
  clearOfferTimer();
  document.getElementById('job-offer-overlay').classList.remove('active');
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
  document.getElementById('chat-overlay').classList.add('active');
  renderShipperChatMessages();
  setTimeout(() => {
    const box = document.getElementById('shipper-chat-messages-box');
    if (box) box.scrollTop = box.scrollHeight;
  }, 50);
}

function closeQuickChat() {
  document.getElementById('chat-overlay').classList.remove('active');
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
    const isMe = msg.sender === 'shipper';
    const alignStyle = isMe ? 'align-self: flex-end; background: var(--clr-primary); color: white;' : 'align-self: flex-start; background: rgba(255,255,255,0.1); color: var(--clr-text-primary);';
    const senderName = isMe ? 'Bạn' : 'Khách hàng';
    return `
      <div style="max-width: 80%; padding: 8px 12px; border-radius: var(--radius-md); font-size: 12px; ${alignStyle} display: flex; flex-direction: column; gap: 3px;">
        <span style="font-weight: 700; opacity: 0.8; font-size: 10px;">${senderName}</span>
        <span>${msg.text}</span>
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
  if (!activeOrder) return;
  try {
    const res = await fetch(`${API_BASE}/api/orders/${activeOrder.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender: 'shipper',
        text: text
      })
    });
    const result = await res.json();
    if (res.ok && result.success) {
      activeOrder.messages = result.messages;
      renderShipperChatMessages();
      showToast('Đã gửi tin nhắn', `Đã gửi: "${text}"`, 'success');
    } else {
      showToast('Lỗi gửi tin nhắn', result.error || 'Không thể gửi tin nhắn.', 'error');
    }
  } catch (e) {
    console.error('Lỗi gửi chat:', e);
    showToast('Lỗi kết nối', 'Không thể kết nối với server.', 'error');
  }
}

async function sendShipperCustomMessage() {
  const input = document.getElementById('shipper-chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  if (!activeOrder) return;
  try {
    const res = await fetch(`${API_BASE}/api/orders/${activeOrder.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender: 'shipper',
        text: text
      })
    });
    const result = await res.json();
    if (res.ok && result.success) {
      activeOrder.messages = result.messages;
      renderShipperChatMessages();
    } else {
      showToast('Lỗi gửi tin nhắn', result.error || 'Không thể gửi tin nhắn.', 'error');
    }
  } catch (e) {
    console.error('Lỗi gửi chat:', e);
    showToast('Lỗi kết nối', 'Không thể kết nối với server.', 'error');
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
      
      // Remove listeners
      handle.removeEventListener('mousedown', dragStart);
      handle.removeEventListener('touchstart', dragStart);
      
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

// ── AUDIO NOTIFICATION SYNTHESIZER ──────────────────────────────────────────
let sharedAudioCtx = null;
function getSharedAudioCtx() {
  if (!sharedAudioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      sharedAudioCtx = new AudioContext();
    }
  }
  if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(e => console.warn('[Audio] Failed to resume context:', e));
  }
  return sharedAudioCtx;
}

function unlockAudio() {
  const ctx = getSharedAudioCtx();
  if (!ctx) return;
  // Play a short silent buffer to unlock the AudioContext on iOS/mobile
  const buffer = ctx.createBuffer(1, 1, 22050);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start(0);
  document.removeEventListener('click', unlockAudio);
  document.removeEventListener('touchstart', unlockAudio);
}

// Auto-initialize/resume and unlock on first interaction
document.addEventListener('click', unlockAudio);
document.addEventListener('touchstart', unlockAudio);

function playChimeSound() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    
    if (ctx.state === 'suspended') {
      ctx.resume().then(() => triggerChime(ctx)).catch(e => console.warn('Audio resume failed:', e));
    } else {
      triggerChime(ctx);
    }
  } catch(e) {
    console.warn('Audio play failed:', e);
  }
}

function triggerChime(ctx) {
  const osc1 = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const gainNode = ctx.createGain();
  
  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
  osc1.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15); // A5
  
  osc2.type = 'triangle';
  osc2.frequency.setValueAtTime(293.66, ctx.currentTime); // D4
  osc2.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.15); // A4
  
  gainNode.gain.setValueAtTime(0.15, ctx.currentTime);
  gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
  
  osc1.connect(gainNode);
  osc2.connect(gainNode);
  gainNode.connect(ctx.destination);
  
  osc1.start();
  osc2.start();
  osc1.stop(ctx.currentTime + 0.4);
  osc2.stop(ctx.currentTime + 0.4);
}

function playMessageChimeSound() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    
    const playBeep = (freq, startTime, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime);
      gain.gain.setValueAtTime(0.1, startTime);
      gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startTime);
      osc.stop(startTime + duration);
    };
    
    playBeep(659.25, ctx.currentTime, 0.1); // E5 at t=0
    playBeep(880.00, ctx.currentTime + 0.12, 0.15); // A5 at t=0.12s
  } catch(e) {
    console.warn('Audio play failed:', e);
  }
}

// ── DRIVER STATS PERSISTENCE ────────────────────────────────────────────────
function loadStats() {
  try {
    if (!currentDriver) {
      stats = { accepted: 0, declined: 0, completed: 0 };
      return;
    }
    const key = `shipfee_shipper_stats_${cleanPhone(currentDriver.phone)}`;
    const raw = localStorage.getItem(key);
    if (raw) {
      stats = JSON.parse(raw);
    } else {
      stats = { accepted: 0, declined: 0, completed: 0 };
    }
  } catch (e) {
    stats = { accepted: 0, declined: 0, completed: 0 };
  }
}

function saveStats() {
  try {
    if (!currentDriver) return;
    const key = `shipfee_shipper_stats_${cleanPhone(currentDriver.phone)}`;
    localStorage.setItem(key, JSON.stringify(stats));
    syncStatsToServer(); // Tự động đồng bộ lên CRM server
  } catch (e) {}
}

async function syncStatsToServer() {
  if (!currentDriver) return;
  try {
    const key = `shipfee_shipper_stats_${cleanPhone(currentDriver.phone)}`;
    const raw = localStorage.getItem(key);
    let statsObj = { accepted: 0, declined: 0, completed: 0 };
    if (raw) statsObj = JSON.parse(raw);

    const totalOffers = statsObj.accepted + statsObj.declined;
    const arPercentage = totalOffers > 0 ? Math.round((statsObj.accepted / totalOffers) * 100) : 100;
    const crPercentage = statsObj.accepted > 0 ? Math.round((statsObj.completed / statsObj.accepted) * 100) : 100;

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
function renderHistoryAndStats() {
  const totalOrders = historyOrders.length;
  
  let totalEarnings = 0;
  let totalRatings = 0;
  let ratedCount = 0;
  
  historyOrders.forEach(o => {
    totalEarnings += o.shipperEarning || 0;
    if (o.rating) {
      totalRatings += o.rating;
      ratedCount++;
    }
  });
  
  const avgRating = ratedCount > 0 ? (totalRatings / ratedCount).toFixed(1) + ' ★' : '5.0 ★';
  
  // Calculate quality rates
  const totalOffers = stats.accepted + stats.declined;
  const arPercentage = totalOffers > 0 ? Math.round((stats.accepted / totalOffers) * 100) : 100;
  const crPercentage = stats.accepted > 0 ? Math.round((stats.completed / stats.accepted) * 100) : 100;

  document.getElementById('stats-total-orders').textContent = totalOrders;
  document.getElementById('stats-total-earnings').textContent = formatCurrency(totalEarnings);
  document.getElementById('stats-avg-rating').textContent = avgRating;
  
  // Update detailed rates UI
  document.getElementById('stats-acceptance-rate').textContent = arPercentage + '%';
  document.getElementById('stats-acceptance-fill').style.width = arPercentage + '%';
  document.getElementById('stats-completion-rate').textContent = crPercentage + '%';
  document.getElementById('stats-completion-fill').style.width = crPercentage + '%';

  // Render completed list
  const container = document.getElementById('history-orders-list');
  container.innerHTML = '';
  
  if (historyOrders.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-clock-rotate-left"></i>
        <p>Bạn chưa hoàn thành đơn hàng nào hôm nay.</p>
      </div>`;
    return;
  }
  
  historyOrders.sort((a, b) => b.createdAt - a.createdAt).forEach(order => {
    const card = document.createElement('div');
    card.className = 'history-card animate-fade-in';
    
    let feedbackHtml = '';
    if (order.rating) {
      let stars = '';
      for (let i = 1; i <= 5; i++) {
        stars += i <= order.rating ? '★' : '☆';
      }
      feedbackHtml = `
        <div class="history-card__feedback">
          <span style="color:#F59E0B; font-weight:700;">${stars}</span>
          <span>${order.comment ? `"${order.comment}"` : 'Không để lại lời nhắn'}</span>
        </div>
      `;
    }
    
    card.innerHTML = `
      <div class="history-card__header">
        <span class="history-card__res">${order.restaurantName}</span>
        <span class="history-card__earning">+${formatCurrency(order.shipperEarning)}</span>
      </div>
      <div class="history-card__date">
        Đơn: ${order.id} · ${formatDate(order.createdAt)} · Tổng COD: ${formatCurrency(order.appTotal)}
      </div>
      ${feedbackHtml}
    `;
    container.appendChild(card);
  });

  // Kích hoạt đồng bộ các chỉ số thống kê tổng hợp mới nhất lên server CRM
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
      ${title ? `<div style="font-weight:700;margin-bottom:2px;">${title}</div>` : ''}
      ${message ? `<div style="opacity:0.85;font-size:11px;">${message}</div>` : ''}
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
  return; // VoIP calling disabled
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
  if (overlay) overlay.classList.add('active');

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
  const apiUrl = localStorage.getItem('shipfee_api_url') || API_BASE;
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
  if (overlay) overlay.classList.remove('active');

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
  if (overlay) overlay.classList.remove('active');
  
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
  if (overlay) overlay.classList.remove('active');
}
window.closeCallSelect = closeCallSelect;

function configureApiUrl() {
  const defaultApiUrl = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:3001'
    : 'https://shipfee-eo5s.onrender.com';
  const currentUrl = localStorage.getItem('shipfee_api_url') || defaultApiUrl;
  const newUrl = prompt('Cấu hình URL Backend API (Ví dụ: https://shipfee-backend.onrender.com):', currentUrl);
  if (newUrl !== null) {
    const cleanedUrl = newUrl.trim().replace(/\/+$/, '');
    if (cleanedUrl) {
      localStorage.setItem('shipfee_api_url', cleanedUrl);
    } else {
      localStorage.removeItem('shipfee_api_url');
    }
    window.location.reload();
  }
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
    
    sessionStorage.removeItem('shipfee_driver');
    sessionStorage.removeItem('shipfee_jwt');
    sessionStorage.removeItem('shipfee_driver_online');
    
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

  // Thống kê AR/CR
  const ar = localStorage.getItem('shipfee_ar') || '100';
  const cr = localStorage.getItem('shipfee_cr') || '100';
  document.getElementById('profile-ar').textContent = ar + '%';
  document.getElementById('profile-cr').textContent = cr + '%';
  
  // Tổng đơn hoàn thành và doanh thu
  const statsStr = localStorage.getItem('shipfee_stats') || '{"totalCompleted":0,"totalEarning":0}';
  try {
    const stats = JSON.parse(statsStr);
    document.getElementById('profile-total-orders').textContent = (stats.totalCompleted || 0) + ' đơn';
    document.getElementById('profile-revenue').textContent = formatCurrency(stats.totalEarning || 0);
  } catch (e) {
    document.getElementById('profile-total-orders').textContent = '0 đơn';
    document.getElementById('profile-revenue').textContent = '0đ';
  }

  const overlay = document.getElementById('driver-profile-overlay');
  if (overlay) {
    overlay.style.display = 'flex';
    overlay.classList.add('active');
  }
}

function closeDriverProfile() {
  const overlay = document.getElementById('driver-profile-overlay');
  if (overlay) {
    overlay.style.display = 'none';
    overlay.classList.remove('active');
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

// Mobile Zoom Prevention
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

async function initSupabase() {
  try {
    const res = await fetch(`${API_BASE}/api/config`).then(r => r.json());
    if (res.supabaseUrl && res.supabaseAnonKey && res.supabaseUrl !== 'your_supabase_url_here') {
      supabaseClient = supabase.createClient(res.supabaseUrl, res.supabaseAnonKey, {
        auth: {
          storageKey: 'shipfee_driver_auth_token',
          storage: window.sessionStorage,
          persistSession: true,
          autoRefreshToken: true
        }
      });
      console.log('[Supabase] Client initialized successfully via proxy config');
      
      // Tự động khôi phục JWT token từ storage của client
      supabaseClient.auth.getSession().then(({ data: { session } }) => {
        if (session) {
          sessionStorage.setItem('shipfee_jwt', session.access_token);
        }
      }).catch(e => console.warn('Lỗi lấy session shipper:', e));

      // Update UI: hide name/phone, show email/password
      document.getElementById('login-group-name').style.display = 'none';
      document.getElementById('login-group-phone').style.display = 'none';
      document.getElementById('login-group-email').style.display = 'flex';
      document.getElementById('login-group-password').style.display = 'flex';
      document.getElementById('login-btn').innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Đăng nhập với Supabase';
    } else {
      console.error('[Supabase] Proxy returned placeholder credentials. Supabase mode required but not configured!');
      showToast('Cấu hình Supabase', 'Hệ thống đang hoạt động ở chế độ bắt buộc Supabase nhưng chưa cấu hình credentials. Vui lòng cập nhật file .env!', 'error');
    }
  } catch (e) {
    console.error('[Supabase] Failed to retrieve config from proxy:', e);
    showToast('Lỗi kết nối', 'Không thể kết nối đến máy chủ cấu hình API.', 'error');
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
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang yêu cầu...';
  }

  try {
    const res = await fetch(`${API_BASE}/api/shippers/request-assistance`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionStorage.getItem('shipfee_jwt')}`
      },
      body: JSON.stringify({ phone: currentDriver.phone })
    }).then(r => r.json());

    if (res.success) {
      showToast('Thành công', res.message, 'success');
      currentDriver.assistanceLimitToday = res.limitUsed;
      currentDriver.assistanceRequested = true;
      sessionStorage.setItem('shipfee_driver', JSON.stringify(currentDriver));
      
      if (res.orderId) {
        if (typeof pollJobs === 'function') pollJobs();
      } else {
        const countText = document.getElementById('assistance-used-count');
        if (countText) countText.textContent = res.limitUsed;
        if (btn) {
          btn.innerHTML = '<i class="fa-solid fa-hourglass-half"></i> Đang chờ gán đơn ưu tiên...';
          btn.style.background = '#4b5563';
        }
      }
    } else {
      showToast('Thất bại', res.error || 'Yêu cầu hỗ trợ thất bại.', 'error');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-circle-question"></i> 🆘 Yêu cầu Hỗ trợ Tìm đơn';
      }
    }
  } catch (err) {
    console.error('Lỗi yêu cầu hỗ trợ tìm đơn:', err);
    showToast('Lỗi kết nối', 'Không thể kết nối với server.', 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-circle-question"></i> 🆘 Yêu cầu Hỗ trợ Tìm đơn';
    }
  }
}
window.requestOrderAssistance = requestOrderAssistance;

function navigateToPoint(target) {
  if (!activeOrder) {
    showToast('Không có đơn hàng', 'Không tìm thấy thông tin đơn hàng hoạt động.', 'warning');
    return;
  }

  let lat, lon;
  if (target === 'restaurant') {
    lat = activeOrder.restaurantLat;
    lon = activeOrder.restaurantLon;
  } else if (target === 'customer') {
    lat = activeOrder.pinnedLat;
    lon = activeOrder.pinnedLon;
  }

  if (!lat || !lon) {
    showToast('Thiếu tọa độ', 'Đơn hàng này không có sẵn tọa độ chính xác.', 'error');
    return;
  }

  // Google Maps navigation direction universal URL scheme
  const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
  window.open(url, '_blank');
}
window.navigateToPoint = navigateToPoint;
