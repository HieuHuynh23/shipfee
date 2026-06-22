/* ==========================================================================
   SHIPFEE — Shipper App JavaScript Logic
   ========================================================================== */

'use strict';

const API_BASE = localStorage.getItem('shipfee_api_url') || 'http://localhost:3001';
if (API_BASE !== 'http://localhost:3001') {
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string' && input.startsWith('http://localhost:3001')) {
      input = input.replace('http://localhost:3001', API_BASE);
    }
    return originalFetch(input, init);
  };
}

// Helper to normalize phone numbers for robust matching (removes spaces)
function cleanPhone(p) {
  return (p || '').toString().trim().replace(/\s+/g, '');
}

// ── STATE MANAGEMENT ────────────────────────────────────────────────────────
let currentDriver = null; // { name, phone }
let activeOrder = null;   // current accepted order
let pendingOrders = [];   // list of pending orders
let historyOrders = [];   // completed orders by this driver
let isOnline = true;      // receiving orders
let pollInterval = null;
let watchPositionId = null;

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
document.addEventListener('DOMContentLoaded', () => {
  loadDriverInfo();
  loadStats();
  initApp();
});

async function initApp() {
  if (currentDriver) {
    document.getElementById('login-overlay').classList.remove('active');
    updateDriverHeader();
    
    // Đồng bộ trạng thái ca làm việc (Check-in/Check-out) từ server
    try {
      const res = await fetch('http://localhost:3001/api/shippers');
      if (res.ok) {
        const json = await res.json();
        if (json.success && Array.isArray(json.data)) {
          const cleanedPhone = currentDriver.phone.trim().replace(/\s+/g, '');
          const me = json.data.find(s => s.phone.trim().replace(/\s+/g, '') === cleanedPhone);
          if (me) {
            isOnline = (me.status === 'ONLINE');
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
function loadDriverInfo() {
  try {
    const raw = localStorage.getItem('shipfee_driver');
    if (raw) {
      currentDriver = JSON.parse(raw);
    }
  } catch (e) {
    console.error('Lỗi đọc thông tin tài xế:', e);
  }
}

async function loginDriver() {
  const nameInput = document.getElementById('driver-name');
  const phoneInput = document.getElementById('driver-phone');
  
  const name = nameInput.value.trim();
  const phone = phoneInput.value.trim();
  
  if (!name || !phone) {
    showToast('Thiếu thông tin', 'Vui lòng nhập Họ tên và Số điện thoại.', 'warning');
    return;
  }
  
  try {
    const response = await fetch('http://localhost:3001/api/shippers/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name, phone })
    });
    
    const result = await response.json();
    if (response.ok && result.success) {
      // Đăng nhập thành công
      currentDriver = { name: result.shipper.name, phone: result.shipper.phone };
      localStorage.setItem('shipfee_driver', JSON.stringify(currentDriver));
      
      document.getElementById('login-overlay').classList.remove('active');
      updateDriverHeader();
      showToast('Đăng nhập thành công', `Chào mừng ${currentDriver.name} đã vào hệ thống!`, 'success');
      
      // Mặc định ban đầu sau khi đăng nhập là OFFLINE (Chưa vào ca)
      isOnline = false;
      const checkbox = document.getElementById('online-switch');
      const statusText = document.getElementById('status-text');
      if (checkbox && statusText) {
        checkbox.checked = false;
        statusText.textContent = 'Đã tắt ca (Check-out)';
        statusText.className = 'status-indicator offline';
      }
      
      startPolling();
    } else {
      showToast('Đăng nhập thất bại', result.error || 'Thông tin tài xế không đúng.', 'error');
    }
  } catch (err) {
    console.error('Lỗi đăng nhập:', err);
    showToast('Lỗi kết nối', 'Không thể kết nối với server để xác thực.', 'error');
  }
}

function updateDriverHeader() {
  if (!currentDriver) return;
  document.getElementById('header-name').textContent = currentDriver.name;
  document.getElementById('header-phone').textContent = currentDriver.phone;
  document.getElementById('header-avatar').textContent = currentDriver.name.charAt(0);
}

async function toggleOnlineStatus() {
  const checkbox = document.getElementById('online-switch');
  const statusText = document.getElementById('status-text');
  const nextOnline = checkbox.checked;
  const statusString = nextOnline ? 'ONLINE' : 'OFFLINE';
  
  if (!currentDriver) return;
  
  try {
    const res = await fetch('http://localhost:3001/api/shippers/shift', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ phone: currentDriver.phone, status: statusString })
    });
    
    const result = await res.json();
    if (res.ok && result.success) {
      isOnline = nextOnline;
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
  syncAllData();
  pollInterval = setInterval(syncAllData, 3000);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
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
    const res = await fetch('http://localhost:3001/api/orders');
    if (!res.ok) throw new Error('API server error');
    const result = await res.json();
    
    if (result.success && Array.isArray(result.data)) {
      const allOrders = result.data;
      
      pendingOrders = allOrders.filter(o => o.status === 'PENDING');
      
      // Play Synthesizer Chime if new orders appear
      if (isOnline && pendingOrders.length > lastPendingLength) {
        playChimeSound();
        showToast('Có Đơn Mới! 🛵', 'Tài xế có đơn hàng mới lân cận cần xử lý.', 'success');
      }
      lastPendingLength = pendingOrders.length;

      if (isOnline && !activeOrder) {
        renderPendingOrders(pendingOrders);
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
    const res = await fetch(`http://localhost:3001/api/orders/${activeOrder.id}`);
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
    container.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-radar fa-spin-slow" style="color:var(--clr-text-muted);"></i>
        <p>${isOnline ? 'Đang tìm kiếm đơn hàng lân cận...' : 'Vui lòng BẬT NHẬN ĐƠN để tìm đơn mới'}</p>
      </div>`;
    return;
  }
  
  orders.forEach(order => {
    const card = document.createElement('div');
    card.className = 'order-card animate-fade-in';
    card.onclick = () => openJobDetail(order.id);
    
    let itemsLabel = (order.items || []).map(i => `${i.name} (x${i.qty})`).join(', ');
    if (itemsLabel.length > 50) itemsLabel = itemsLabel.substring(0, 47) + '...';

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
    const response = await fetch(`http://localhost:3001/api/orders/${orderId}/accept`, {
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
      tripMap = L.map('shipper-map', { zoomControl: false }).setView([(restLat + custLat) / 2, (restLon + custLon) / 2], 14);
      
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
      tripMap.fitBounds(group.getBounds().pad(0.15));
      
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
  } catch (err) {
    console.error('Lỗi vẽ bản đồ:', err);
  }
}

// ── ADVANCE TRIP STATUS ────────────────────────────────────────────────────
async function advanceTripStatus() {
  if (!activeOrder) return;
  
  const nextStatus = activeOrder.status === 'ACCEPTED' ? 'PURCHASED' : 'DELIVERED';
  
  try {
    const response = await fetch(`http://localhost:3001/api/orders/${activeOrder.id}/status`, {
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

function startGpsTracking() {
  stopGpsTracking();
  
  if (!navigator.geolocation) {
    document.getElementById('gps-indicator').innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> GPS: Thiết bị không hỗ trợ Geolocation`;
    return;
  }
  
  document.getElementById('gps-indicator').innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> GPS: Đang khởi động định vị...`;
  
  watchPositionId = navigator.geolocation.watchPosition(
    async (position) => {
      const lat = position.coords.latitude;
      const lon = position.coords.longitude;
      
      document.getElementById('gps-indicator').innerHTML = `<i class="fa-solid fa-location-crosshairs fa-spin-slow"></i> GPS: (${lat.toFixed(5)}, ${lon.toFixed(5)})`;
      
      if (shipperMarker) {
        shipperMarker.setLatLng([lat, lon]);
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
  if (!activeOrder) return;
  try {
    await fetch(`http://localhost:3001/api/orders/${activeOrder.id}/location`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ lat, lon })
    });
  } catch (e) {
    console.warn('Không thể gửi GPS lên server:', e.message);
  }
}

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
    const res = await fetch(`http://localhost:3001/api/orders/${activeOrder.id}/messages`, {
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
    const res = await fetch(`http://localhost:3001/api/orders/${activeOrder.id}/messages`, {
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

// Auto-initialize/resume on first interaction
document.addEventListener('click', () => { getSharedAudioCtx(); }, { once: true });
document.addEventListener('touchstart', () => { getSharedAudioCtx(); }, { once: true });

function playChimeSound() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    
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
  } catch(e) {
    console.warn('Audio play failed:', e);
  }
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
    const raw = localStorage.getItem('shipfee_shipper_stats');
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
    localStorage.setItem('shipfee_shipper_stats', JSON.stringify(stats));
  } catch (e) {}
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
    const res = await fetch(`http://localhost:3001/api/orders/${orderId}/call/poll?role=shipper`);
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

async function acceptCall() {
  getSharedAudioCtx(); // Initialize AudioContext synchronously under user gesture context
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
      await fetch(`http://localhost:3001/api/orders/${activeOrder.id}/call/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'accept', answer: { type: 'answer', sdp: 'simulated' } })
      });
    } catch (e) {}
    startShipperSimulatedCall();
    return;
  }

  try {
    const pollRes = await fetch(`http://localhost:3001/api/orders/${activeOrder.id}/call/poll?role=shipper`);
    const pollJson = await pollRes.json();
    const callObj = pollJson.call;

    if (!callObj || !callObj.offer) {
      throw new Error('No offer found on server');
    }

    if (callObj.offer.sdp === 'simulated') {
      throw new Error('Simulated call offer');
    }

    peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    peerConnection.oniceconnectionstatechange = () => {
      console.log('[WebRTC] Callee ICE Connection State Changed:', peerConnection.iceConnectionState);
      if (peerConnection.iceConnectionState === 'failed' || peerConnection.iceConnectionState === 'disconnected') {
        console.warn('[WebRTC] Callee ICE Connection failed/disconnected, falling back to simulated call');
        showToast('Kết nối thất bại', 'Không thể kết nối trực tiếp (do chặn mạng/WiFi). Chuyển sang cuộc gọi mô phỏng.', 'warning');
        
        fetch(`http://localhost:3001/api/orders/${activeOrder.id}/call/respond`, {
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
      let audioEl = document.getElementById('remote-audio-el');
      if (!audioEl) {
        audioEl = document.createElement('video');
        audioEl.id = 'remote-audio-el';
        audioEl.setAttribute('autoplay', 'true');
        audioEl.setAttribute('playsinline', 'true');
        audioEl.setAttribute('webkit-playsinline', 'true');
        audioEl.style.position = 'absolute';
        audioEl.style.width = '1px';
        audioEl.style.height = '1px';
        audioEl.style.opacity = '0';
        audioEl.style.pointerEvents = 'none';
        document.body.appendChild(audioEl);
      }
      audioEl.srcObject = remoteStream;
      audioEl.play().then(() => {
        console.log('[WebRTC] Callee Remote audio playback started successfully');
      }).catch(e => {
        console.warn('[WebRTC] Callee Audio play failed, retrying on user click:', e);
        const playFallback = () => {
          audioEl.play().then(() => {
            console.log('[WebRTC] Callee Remote audio playback started on user click');
            document.removeEventListener('click', playFallback);
          }).catch(err => console.error('[WebRTC] Callee Play retry failed:', err));
        };
        document.addEventListener('click', playFallback);
      });

      // Route via shared AudioContext as fallback
      try {
        const ctx = getSharedAudioCtx();
        if (ctx) {
          const source = ctx.createMediaStreamSource(remoteStream);
          source.connect(ctx.destination);
          console.log('[WebRTC] Callee Remote audio connected to shared AudioContext destination');
        }
      } catch (audioCtxErr) {
        console.warn('[WebRTC] Callee AudioContext routing failed:', audioCtxErr);
      }
    };
    peerConnection.onicecandidate = async (event) => {
      if (event.candidate) {
        await fetch(`http://localhost:3001/api/orders/${activeOrder.id}/call/candidate`, {
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

    await fetch(`http://localhost:3001/api/orders/${activeOrder.id}/call/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'accept', answer })
    });
  } catch (err) {
    console.error('Shipper accept WebRTC failed, fallback to simulated', err);
    try {
      await fetch(`http://localhost:3001/api/orders/${activeOrder.id}/call/respond`, {
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
      fetch(`http://localhost:3001/api/orders/${activeOrder.id}/call/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'decline' })
      });
    } catch (e) {}
  }
  endCallLocally();
}

async function initiateCall() {
  getSharedAudioCtx(); // Initialize AudioContext synchronously under user gesture context
  if (!activeOrder || !activeOrder.id) {
    showToast('Lỗi', 'Không có đơn hàng hoạt động.', 'error');
    return;
  }

  const overlay = document.getElementById('call-overlay');
  if (overlay) overlay.classList.add('active');

  document.getElementById('call-contact-name').textContent = activeOrder.deliveryName || 'Khách hàng';
  document.getElementById('call-avatar-display').textContent = (activeOrder.deliveryName || 'K').charAt(0);

  const statusLabel = document.getElementById('call-status-label');
  if (statusLabel) statusLabel.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang kết nối...';

  document.getElementById('call-actions-incoming').style.display = 'none';
  document.getElementById('call-actions-active').style.display = 'block';

  callActive = true;
  let hasMicrophone = false;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    hasMicrophone = true;
  } catch (err) {
    console.warn('Microphone access failed for shipper, using simulated call', err);
  }

  if (!hasMicrophone) {
    startShipperOutgoingSimulatedCall();
    return;
  }

  try {
    startOutgoingRingback();
    statusLabel.innerHTML = '<i class="fa-solid fa-phone-volume animate-pulse"></i> Đang đổ chuông...';

    peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    peerConnection.oniceconnectionstatechange = () => {
      console.log('[WebRTC] Caller ICE Connection State Changed:', peerConnection.iceConnectionState);
      if (peerConnection.iceConnectionState === 'failed' || peerConnection.iceConnectionState === 'disconnected') {
        console.warn('[WebRTC] Caller ICE Connection failed/disconnected, falling back to simulated call');
        showToast('Kết nối thất bại', 'Không thể kết nối trực tiếp (do chặn mạng/WiFi). Chuyển sang cuộc gọi mô phỏng.', 'warning');
        
        fetch(`http://localhost:3001/api/orders/${activeOrder.id}/call/respond`, {
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
      console.log('[WebRTC] Caller Connection State Changed:', peerConnection.connectionState);
    };
    peerConnection.ontrack = (event) => {
      console.log('[WebRTC] Caller Remote track received:', event.track.kind);
      let remoteStream = event.streams[0];
      if (!remoteStream) {
        console.log('[WebRTC] Caller Fallback: creating new MediaStream for track');
        remoteStream = new MediaStream();
        remoteStream.addTrack(event.track);
      }
      let audioEl = document.getElementById('remote-audio-el');
      if (!audioEl) {
        audioEl = document.createElement('video');
        audioEl.id = 'remote-audio-el';
        audioEl.setAttribute('autoplay', 'true');
        audioEl.setAttribute('playsinline', 'true');
        audioEl.setAttribute('webkit-playsinline', 'true');
        audioEl.style.position = 'absolute';
        audioEl.style.width = '1px';
        audioEl.style.height = '1px';
        audioEl.style.opacity = '0';
        audioEl.style.pointerEvents = 'none';
        document.body.appendChild(audioEl);
      }
      audioEl.srcObject = remoteStream;
      audioEl.play().then(() => {
        console.log('[WebRTC] Caller Remote audio playback started successfully');
      }).catch(e => {
        console.warn('[WebRTC] Caller Audio play failed, retrying on user click:', e);
        const playFallback = () => {
          audioEl.play().then(() => {
            console.log('[WebRTC] Caller Remote audio playback started on user click');
            document.removeEventListener('click', playFallback);
          }).catch(err => console.error('[WebRTC] Caller Play retry failed:', err));
        };
        document.addEventListener('click', playFallback);
      });

      // Route via shared AudioContext as fallback
      try {
        const ctx = getSharedAudioCtx();
        if (ctx) {
          const source = ctx.createMediaStreamSource(remoteStream);
          source.connect(ctx.destination);
          console.log('[WebRTC] Caller Remote audio connected to shared AudioContext destination');
        }
      } catch (audioCtxErr) {
        console.warn('[WebRTC] Caller AudioContext routing failed:', audioCtxErr);
      }
    };
    peerConnection.onicecandidate = async (event) => {
      if (event.candidate) {
        await fetch(`http://localhost:3001/api/orders/${activeOrder.id}/call/candidate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sender: 'shipper', candidate: event.candidate })
        });
      }
    };

    const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    localCallStream = localStream;
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    const res = await fetch(`http://localhost:3001/api/orders/${activeOrder.id}/call/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caller: 'shipper', offer })
    });
    if (!res.ok) throw new Error('Call initiate failed');

    startCallPolling('shipper');
  } catch (err) {
    console.error('Shipper VoIP call initiation failed, fallback to simulated', err);
    stopOutgoingRingback();
    startShipperOutgoingSimulatedCall();
  }
}

async function startShipperOutgoingSimulatedCall() {
  const statusLabel = document.getElementById('call-status-label');
  if (statusLabel) statusLabel.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang kết nối...';
  startOutgoingRingback();

  try {
    const offer = { type: 'offer', sdp: 'simulated' };
    await fetch(`http://localhost:3001/api/orders/${activeOrder.id}/call/initiate`, {
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
      const res = await fetch(`http://localhost:3001/api/orders/${activeOrder.id}/call/poll?role=shipper`);
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
      fetch(`http://localhost:3001/api/orders/${activeOrder.id}/call/respond`, {
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
}

window.initiateCall = initiateCall;
window.acceptCall = acceptCall;
window.declineCall = declineCall;
window.endCall = endCall;

function makeDirectCall() {
  if (!activeOrder || !activeOrder.deliveryPhone) {
    showToast('Lỗi', 'Không tìm thấy số điện thoại khách hàng.', 'error');
    return;
  }
  window.location.href = `tel:${activeOrder.deliveryPhone}`;
}
window.makeDirectCall = makeDirectCall;

function configureApiUrl() {
  const currentUrl = localStorage.getItem('shipfee_api_url') || 'http://localhost:3001';
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

window.addEventListener('pagehide', () => {
  if (callActive && activeOrder && activeOrder.id) {
    fetch(`http://localhost:3001/api/orders/${activeOrder.id}/call/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'end' }),
      keepalive: true
    });
  }
});
