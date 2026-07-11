/* ==========================================================================
   SHIPFEE CRM — Admin App JavaScript
   SPA Router + API Client + CRUD Modules
   ========================================================================== */

'use strict';

// ── CONFIG ──────────────────────────────────────────────────────────────────
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
  const token = localStorage.getItem('shipfee_jwt');
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

// ── STATE ───────────────────────────────────────────────────────────────────
let supabaseClient = null;
let currentPage = 'dashboard';
let adminUser = null;
let pollTimer = null;
let editingShipperPhone = null;
let adminShipperAvatarBase64 = null;

// Cache
let cachedShippers = [];
let cachedOrders = [];
let cachedRestaurants = [];
let restaurantSearchPage = 1;
let restaurantSearchQuery = '';
let currentEditingMenu = [];

async function initSupabase() {
  try {
    const res = await originalFetch(`${API_BASE}/api/config`).then(r => r.json());
    if (res.supabaseUrl && res.supabaseAnonKey && res.supabaseUrl !== 'your_supabase_url_here') {
      supabaseClient = supabase.createClient(res.supabaseUrl, res.supabaseAnonKey, {
        auth: {
          storageKey: 'shipfee_admin_auth_token',
          persistSession: true,
          autoRefreshToken: true
        }
      });
      console.log('[Supabase] Admin client initialized successfully via proxy config');
    }
  } catch (e) {
    console.warn('[Supabase] Failed to init Supabase in admin app, falling back to local auth:', e);
  }
}

// ── INIT ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await initSupabase();

  if (supabaseClient) {
    // Tự động lắng nghe thay đổi session của Supabase Auth
    supabaseClient.auth.onAuthStateChange((event, session) => {
      if (session) {
        localStorage.setItem('shipfee_jwt', session.access_token);
      } else {
        localStorage.removeItem('shipfee_jwt');
      }
    });

    // Cập nhật session hiện tại vào localStorage tức thì
    supabaseClient.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        localStorage.setItem('shipfee_jwt', session.access_token);
      }
    }).catch(e => console.warn('Lỗi lấy session Supabase:', e));
  }

  const saved = localStorage.getItem('shipfee_admin');
  const jwt = localStorage.getItem('shipfee_jwt');
  if (saved) {
    if (supabaseClient && !jwt) {
      console.log('[Auth] Phát hiện session Demo cũ bị kẹt không có JWT, tự động dọn dẹp.');
      localStorage.removeItem('shipfee_admin');
      localStorage.removeItem('shipfee_jwt');
      document.getElementById('login-page').classList.remove('hidden');
    } else {
      try {
        adminUser = JSON.parse(saved);
        showApp();
      } catch (e) {}
    }
  }
});

// ── AUTH ─────────────────────────────────────────────────────────────────────
async function handleAdminLogin() {
  const email = document.getElementById('admin-email').value.trim();
  const password = document.getElementById('admin-password').value.trim();

  if (!email || !password) {
    showToast('Vui lòng nhập đầy đủ email và mật khẩu', 'warning');
    return;
  }

  if (supabaseClient) {
    try {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) {
        showToast('Đăng nhập thất bại: ' + error.message, 'error');
        return;
      }
      
      const session = data.session;
      const user = data.user;
      
      // Check role admin
      const isAdmin = user.email === 'admin@shipfee.vn' || (user.user_metadata && user.user_metadata.role === 'admin');
      if (!isAdmin) {
        showToast('Bạn không có quyền quản trị!', 'error');
        await supabaseClient.auth.signOut();
        return;
      }
      
      localStorage.setItem('shipfee_jwt', session.access_token);
      adminUser = { email: user.email, name: user.user_metadata.full_name || 'Admin', role: 'admin' };
      localStorage.setItem('shipfee_admin', JSON.stringify(adminUser));
      showToast('Đăng nhập thành công', 'success');
      showApp();
    } catch (e) {
      showToast('Lỗi đăng nhập hệ thống: ' + e.message, 'error');
    }
  } else {
    // Demo admin credentials (will be replaced with Supabase Auth)
    if (email === 'admin@shipfee.vn' && password === 'admin123') {
      adminUser = { email, name: 'Admin ShipFee', role: 'admin' };
      localStorage.setItem('shipfee_admin', JSON.stringify(adminUser));
      showToast('Đăng nhập thành công', 'success');
      showApp();
    } else {
      showToast('Email hoặc mật khẩu không đúng', 'error');
    }
  }
}

async function handleAdminLogout() {
  adminUser = null;
  localStorage.removeItem('shipfee_admin');
  localStorage.removeItem('shipfee_jwt');
  if (supabaseClient) {
    try {
      await supabaseClient.auth.signOut();
    } catch (e) {}
  }
  if (pollTimer) clearInterval(pollTimer);
  document.getElementById('app-shell').classList.add('hidden');
  document.getElementById('login-page').classList.remove('hidden');
  showToast('Đã đăng xuất', 'info');
}

function showApp() {
  document.getElementById('login-page').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');

  if (adminUser) {
    document.getElementById('sidebar-name').textContent = adminUser.name || 'Admin';
    document.getElementById('sidebar-avatar').textContent = (adminUser.name || 'A').charAt(0).toUpperCase();
  }

  navigateTo('dashboard');
  startPolling();
}

// ── ROUTER ──────────────────────────────────────────────────────────────────
function navigateTo(page) {
  currentPage = page;

  // Update sidebar active state
  document.querySelectorAll('.sidebar__link').forEach(link => {
    link.classList.toggle('active', link.dataset.page === page);
  });

  // Update header
  const titles = {
    dashboard: 'Dashboard',
    shippers: 'Quản lý Tài xế',
    restaurants: 'Quản lý Quán ăn',
    orders: 'Quản lý Đơn hàng',
    customers: 'Khách hàng',
    settings: 'Cấu hình hệ thống'
  };
  const breadcrumbs = {
    dashboard: 'Tổng quan',
    shippers: 'Tài xế',
    restaurants: 'Quán ăn',
    orders: 'Đơn hàng',
    customers: 'Khách hàng',
    settings: 'Cấu hình'
  };

  document.getElementById('header-title').textContent = titles[page] || page;
  document.getElementById('header-breadcrumb').textContent = breadcrumbs[page] || page;

  // Render page
  const renderers = {
    dashboard: renderDashboard,
    shippers: renderShippers,
    restaurants: renderRestaurants,
    orders: renderOrders,
    customers: renderCustomers,
    settings: renderSettings
  };

  const renderer = renderers[page];
  if (renderer) renderer();

  // Close mobile sidebar
  document.getElementById('sidebar').classList.remove('open');
}

function refreshCurrentPage() {
  navigateTo(currentPage);
  showToast('Đã làm mới dữ liệu', 'info');
}

// ── POLLING ─────────────────────────────────────────────────────────────────
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  fetchAllData();
  pollTimer = setInterval(fetchAllData, 5000);
}

async function fetchAllData() {
  try {
    const [shippersRes, ordersRes] = await Promise.all([
      fetch(`${API_BASE}/api/shippers`).then(r => r.json()).catch(() => ({ data: [] })),
      fetch(`${API_BASE}/api/orders`).then(r => r.json()).catch(() => [])
    ]);

    cachedShippers = Array.isArray(shippersRes?.data) ? shippersRes.data : [];
    cachedOrders = Array.isArray(ordersRes) ? ordersRes : (Array.isArray(ordersRes?.data) ? ordersRes.data : []);

    // Update nav badges
    document.getElementById('nav-shipper-count').textContent = cachedShippers.length;
    document.getElementById('nav-order-count').textContent = cachedOrders.length;

    // Refresh current page data if on relevant pages
    if (currentPage === 'dashboard') renderDashboardStats();
    if (currentPage === 'orders') renderOrdersTable();
    if (currentPage === 'shippers') renderShippersTable();
  } catch (e) {
    console.warn('Polling error:', e);
  }
}

// ── API HELPERS ─────────────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  const fetchOptions = { ...options, headers };
  const res = await fetch(url, fetchOptions);
  return res.json();
}

function formatCurrency(amount) {
  if (typeof amount !== 'number') return '0đ';
  return amount.toLocaleString('vi-VN') + 'đ';
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
}

function statusLabel(status) {
  const map = {
    PENDING: 'Chờ nhận',
    ACCEPTED: 'Đã nhận',
    PURCHASED: 'Đã mua',
    DELIVERED: 'Hoàn thành',
    ONLINE: 'Trực tuyến',
    OFFLINE: 'Ngoại tuyến'
  };
  return map[status] || status;
}

function statusBadgeClass(status) {
  const map = {
    PENDING: 'badge--pending',
    ACCEPTED: 'badge--accepted',
    PURCHASED: 'badge--purchased',
    DELIVERED: 'badge--delivered',
    ONLINE: 'badge--online',
    OFFLINE: 'badge--offline'
  };
  return map[status] || 'badge--offline';
}

// ── TOAST ────────────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const icons = {
    success: '<i class="fa-solid fa-circle-check"></i>',
    error: '<i class="fa-solid fa-circle-xmark"></i>',
    warning: '<i class="fa-solid fa-triangle-exclamation"></i>',
    info: '<i class="fa-solid fa-circle-info"></i>'
  };

  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.innerHTML = `
    <span class="toast__icon">${icons[type] || icons.info}</span>
    <span class="toast__text">${message}</span>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ── MODAL HELPERS ───────────────────────────────────────────────────────────
function openModal(id) {
  document.getElementById(id).classList.add('active');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

function handleGlobalSearch(query) {
  if (!query) return;
  // Simple: redirect to relevant page based on query content
}

// ══════════════════════════════════════════════════════════════════════════════
// ── PAGE RENDERERS ──────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// ── DASHBOARD ───────────────────────────────────────────────────────────────
function renderDashboard() {
  const body = document.getElementById('main-body');
  body.innerHTML = `
    <div class="stats-grid" id="dashboard-stats">
      ${renderStatSkeleton(6)}
    </div>

    <div class="grid-2 mb-6" style="gap: 20px;">
      <div class="chart-container" id="chart-revenue">
        <div class="chart-container__header">
          <h3>Doanh thu hôm nay</h3>
          <div class="tabs" style="margin-bottom: 0;">
            <button class="tab active">Hôm nay</button>
            <button class="tab">7 ngày</button>
          </div>
        </div>
        <div id="revenue-chart-body" style="min-height: 200px; display: flex; align-items: center; justify-content: center;">
          <canvas id="revenue-canvas" style="width: 100%; height: 200px;"></canvas>
        </div>
      </div>

      <div class="chart-container" id="chart-orders">
        <div class="chart-container__header">
          <h3>Đơn hàng gần đây</h3>
          <button class="btn btn--ghost btn--sm" onclick="navigateTo('orders')">Xem tất cả →</button>
        </div>
        <div id="recent-orders-list" style="max-height: 220px; overflow-y: auto;">
        </div>
      </div>
    </div>

    <div class="grid-2 mb-6" style="gap: 20px;">
      <div class="data-table-wrapper">
        <div class="data-table-header">
          <h3>Tài xế trực tuyến</h3>
          <span class="count" id="online-shipper-count">0</span>
        </div>
        <div id="online-shippers-body"></div>
      </div>

      <div class="data-table-wrapper">
        <div class="data-table-header">
          <h3>Đơn chờ xử lý</h3>
          <span class="count" id="pending-orders-count">0</span>
        </div>
        <div id="pending-orders-body"></div>
      </div>
    </div>

    <!-- Panel Biến động giá & Trạng thái hoạt động ShopeeFood -->
    <div class="data-table-wrapper mb-6">
      <div class="data-table-header" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 12px;">
        <h3 style="display: flex; align-items: center; gap: 8px; font-size: 15px;">
          <i class="fa-solid fa-bell" style="color: #f59e0b;"></i> Biến động giá & Trạng thái quán (ShopeeFood Sync)
        </h3>
        <button class="btn btn--ghost btn--sm text-xs" onclick="handleReadAllNotifications()" style="color: var(--text-muted);">
          <i class="fa-solid fa-check-double"></i> Đánh dấu đã xem tất cả
        </button>
      </div>
      <div id="notifications-body" style="max-height: 260px; overflow-y: auto; padding: 6px 0;">
        <div class="empty-state" style="padding: 24px;"><p class="text-muted text-sm">Đang tải thông báo...</p></div>
      </div>
    </div>
  `;

  renderDashboardStats();
}

function renderStatSkeleton(count) {
  let html = '';
  for (let i = 0; i < count; i++) {
    html += `
      <div class="card-shell stat-card">
        <div class="card-core" style="display: flex; flex-direction: column; gap: 12px;">
          <div class="skeleton skeleton--text" style="width: 100px;"></div>
          <div class="skeleton skeleton--stat"></div>
        </div>
      </div>
    `;
  }
  return html;
}

function renderDashboardStats() {
  const onlineShippers = cachedShippers.filter(s => s.status === 'ONLINE');
  const pendingOrders = cachedOrders.filter(o => o.status === 'PENDING');
  const activeOrders = cachedOrders.filter(o => o.status !== 'DELIVERED');
  const completedOrders = cachedOrders.filter(o => o.status === 'DELIVERED');
  const totalRevenue = completedOrders.reduce((sum, o) => sum + (o.appTotal || 0), 0);
  const totalEarnings = completedOrders.reduce((sum, o) => sum + (o.shipperEarning || 0), 0);

  const statsEl = document.getElementById('dashboard-stats');
  if (!statsEl) return;

  statsEl.innerHTML = `
    <div class="card-shell stat-card">
      <div class="card-core">
        <div class="stat-card__header">
          <span class="stat-card__label">Đơn hôm nay</span>
          <div class="stat-card__icon" style="background: var(--blue-dim); color: var(--blue);"><i class="fa-solid fa-receipt"></i></div>
        </div>
        <div class="stat-card__value mono">${cachedOrders.length}</div>
        <div class="stat-card__change up"><i class="fa-solid fa-arrow-up"></i> ${activeOrders.length} đang xử lý</div>
      </div>
    </div>
    <div class="card-shell stat-card">
      <div class="card-core">
        <div class="stat-card__header">
          <span class="stat-card__label">Doanh thu</span>
          <div class="stat-card__icon" style="background: var(--emerald-dim); color: var(--emerald-500);"><i class="fa-solid fa-wallet"></i></div>
        </div>
        <div class="stat-card__value mono" style="font-size: 24px; color: var(--emerald-500);">${formatCurrency(totalRevenue)}</div>
        <div class="stat-card__change up"><i class="fa-solid fa-arrow-up"></i> ${completedOrders.length} đơn hoàn thành</div>
      </div>
    </div>
    <div class="card-shell stat-card">
      <div class="card-core">
        <div class="stat-card__header">
          <span class="stat-card__label">Thu nhập shipper</span>
          <div class="stat-card__icon" style="background: var(--amber-dim); color: var(--amber);"><i class="fa-solid fa-coins"></i></div>
        </div>
        <div class="stat-card__value mono" style="font-size: 24px;">${formatCurrency(totalEarnings)}</div>
        <div class="stat-card__change up"><i class="fa-solid fa-motorcycle"></i> ${onlineShippers.length} online</div>
      </div>
    </div>
    <div class="card-shell stat-card">
      <div class="card-core">
        <div class="stat-card__header">
          <span class="stat-card__label">Shipper Online</span>
          <div class="stat-card__icon" style="background: var(--emerald-dim); color: var(--emerald-500);"><i class="fa-solid fa-signal"></i></div>
        </div>
        <div class="stat-card__value mono">${onlineShippers.length}<span style="font-size: 16px; color: var(--text-muted);">/${cachedShippers.length}</span></div>
      </div>
    </div>
    <div class="card-shell stat-card">
      <div class="card-core">
        <div class="stat-card__header">
          <span class="stat-card__label">Đơn chờ nhận</span>
          <div class="stat-card__icon" style="background: var(--amber-dim); color: var(--amber);"><i class="fa-solid fa-clock"></i></div>
        </div>
        <div class="stat-card__value mono" style="color: ${pendingOrders.length > 0 ? 'var(--amber)' : 'var(--text-primary)'};">${pendingOrders.length}</div>
      </div>
    </div>
    <div class="card-shell stat-card">
      <div class="card-core">
        <div class="stat-card__header">
          <span class="stat-card__label">Tỷ lệ hoàn thành</span>
          <div class="stat-card__icon" style="background: var(--violet-dim); color: var(--violet);"><i class="fa-solid fa-chart-pie"></i></div>
        </div>
        <div class="stat-card__value mono">${cachedOrders.length > 0 ? Math.round(completedOrders.length / cachedOrders.length * 100) : 0}<span style="font-size: 16px; color: var(--text-muted);">%</span></div>
      </div>
    </div>
  `;

  // Revenue chart (simple bar chart with CSS)
  renderRevenueChart();

  // Recent orders
  renderRecentOrders();

  // Online shippers
  const onlineEl = document.getElementById('online-shippers-body');
  const onlineCountEl = document.getElementById('online-shipper-count');
  if (onlineEl) {
    if (onlineShippers.length === 0) {
      onlineEl.innerHTML = `<div class="empty-state" style="padding: 32px;"><p class="text-muted text-sm">Không có tài xế trực tuyến</p></div>`;
    } else {
      onlineEl.innerHTML = `<table class="data-table"><tbody>${onlineShippers.map(s => `
        <tr onclick="editShipper('${s.phone}')" style="cursor: pointer;" title="Xem/Sửa thông tin tài xế">
          <td style="width: 40px;"><div class="sidebar__user-avatar" style="width: 28px; height: 28px; font-size: 11px; overflow: hidden; display: flex; align-items: center; justify-content: center;">${s.avatarUrl ? `<img src="${s.avatarUrl}" style="width:100%; height:100%; object-fit:cover;">` : (s.name ? s.name.charAt(0) : '?')}</div></td>
          <td><strong style="font-size: 13px;">${s.name || '—'}</strong><br><span class="text-muted text-xs mono">${s.phone}</span></td>
          <td><span class="badge badge--online"><span class="badge__dot"></span> Online</span></td>
        </tr>
      `).join('')}</tbody></table>`;
    }
  }
  if (onlineCountEl) onlineCountEl.textContent = onlineShippers.length;

  // Pending orders
  const pendingEl = document.getElementById('pending-orders-body');
  const pendingCountEl = document.getElementById('pending-orders-count');
  if (pendingEl) {
    if (pendingOrders.length === 0) {
      pendingEl.innerHTML = `<div class="empty-state" style="padding: 32px;"><p class="text-muted text-sm">Không có đơn chờ xử lý</p></div>`;
    } else {
      pendingEl.innerHTML = `<table class="data-table"><tbody>${pendingOrders.slice(0, 5).map(o => `
        <tr style="cursor: pointer;" onclick="showOrderDetail('${o.id}')">
          <td><span class="mono text-sm fw-700">${o.id}</span></td>
          <td class="truncate" style="max-width: 150px;">${o.restaurantName || '—'}</td>
          <td class="mono text-sm">${formatCurrency(o.appTotal)}</td>
          <td><span class="badge badge--pending"><span class="badge__dot"></span> Chờ</span></td>
        </tr>
      `).join('')}</tbody></table>`;
    }
  }
  if (pendingCountEl) pendingCountEl.textContent = pendingOrders.length;
  
  // Nạp và hiển thị thông báo biến động ShopeeFood
  if (typeof fetchNotifications === 'function') {
    fetchNotifications().then(() => {
      if (typeof renderNotificationsList === 'function') {
        renderNotificationsList();
      }
    });
  }
}

function renderRevenueChart() {
  const canvas = document.getElementById('revenue-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = 200 * dpr;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = '200px';
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = 200;

  // Generate hourly data from orders
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const hourlyRevenue = hours.map(hr => {
    return cachedOrders
      .filter(o => o.status === 'DELIVERED' && new Date(o.createdAt).getHours() === hr)
      .reduce((sum, o) => sum + (o.appTotal || 0), 0);
  });

  const maxVal = Math.max(...hourlyRevenue, 100000);
  const barWidth = (w - 60) / 24;
  const chartH = h - 40;

  // Clear
  ctx.clearRect(0, 0, w, h);

  // Draw bars
  hours.forEach((hr, i) => {
    const val = hourlyRevenue[i];
    const barH = (val / maxVal) * chartH;
    const x = 30 + i * barWidth + barWidth * 0.15;
    const bw = barWidth * 0.7;
    const y = chartH - barH + 10;

    // Bar
    const grad = ctx.createLinearGradient(x, y, x, chartH + 10);
    grad.addColorStop(0, val > 0 ? '#10b981' : '#27272a');
    grad.addColorStop(1, val > 0 ? 'rgba(16, 185, 129, 0.2)' : '#27272a');
    ctx.fillStyle = grad;

    // Rounded top
    const r = Math.min(3, bw / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + bw - r, y);
    ctx.quadraticCurveTo(x + bw, y, x + bw, y + r);
    ctx.lineTo(x + bw, chartH + 10);
    ctx.lineTo(x, chartH + 10);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.fill();

    // Hour label (every 4 hours)
    if (hr % 4 === 0) {
      ctx.fillStyle = '#71717a';
      ctx.font = '10px Geist Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${hr}h`, x + bw / 2, h - 5);
    }
  });
}

function renderRecentOrders() {
  const el = document.getElementById('recent-orders-list');
  if (!el) return;

  const recent = [...cachedOrders].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 8);

  if (recent.length === 0) {
    el.innerHTML = `<div class="empty-state" style="padding: 32px;"><p class="text-muted text-sm">Chưa có đơn hàng</p></div>`;
    return;
  }

  el.innerHTML = recent.map(o => `
    <div class="menu-item" style="cursor: pointer;" onclick="showOrderDetail('${o.id}')">
      <div style="flex: 1; min-width: 0;">
        <div class="menu-item__name"><span class="mono text-xs" style="color: var(--text-muted);">${o.id}</span> — ${o.restaurantName || '—'}</div>
        <div class="menu-item__desc">${o.deliveryName || '—'} · ${formatTime(o.createdAt)}</div>
      </div>
      <div style="text-align: right;">
        <div class="mono text-sm fw-700">${formatCurrency(o.appTotal)}</div>
        <span class="badge ${statusBadgeClass(o.status)}" style="font-size: 10px;">${statusLabel(o.status)}</span>
      </div>
    </div>
  `).join('');
}

// ── SHIPPERS PAGE ───────────────────────────────────────────────────────────
function renderShippers() {
  const body = document.getElementById('main-body');
  body.innerHTML = `
    <div class="page-section-header">
      <h2>Quản lý Tài xế</h2>
      <div class="page-section-header__actions">
        <button class="btn btn--primary" onclick="openAddShipperModal()">
          <i class="fa-solid fa-plus"></i> Thêm tài xế
        </button>
      </div>
    </div>

    <div class="toolbar">
      <div class="form-search" style="width: 280px;">
        <span class="form-search__icon"><i class="fa-solid fa-magnifying-glass"></i></span>
        <input type="text" class="form-input" placeholder="Tìm tài xế..." id="shipper-search" onkeyup="renderShippersTable()">
      </div>
      <div class="tabs" style="margin-bottom: 0;">
        <button class="tab active" onclick="filterShippers(this, 'all')">Tất cả</button>
        <button class="tab" onclick="filterShippers(this, 'ONLINE')">Online</button>
        <button class="tab" onclick="filterShippers(this, 'OFFLINE')">Offline</button>
      </div>
    </div>

    <div class="data-table-wrapper">
      <div class="data-table-header">
        <h3>Danh sách tài xế</h3>
        <span class="count" id="shipper-table-count">${cachedShippers.length}</span>
      </div>
      <div id="shippers-table-body">
        <table class="data-table">
          <thead>
            <tr>
              <th>Tài xế</th>
              <th>Số điện thoại</th>
              <th>Trạng thái</th>
              <th>Hiệu suất (AR / CR)</th>
              <th>Doanh thu</th>
              <th>Check-in</th>
              <th>Check-out</th>
              <th style="text-align: right;">Thao tác</th>
            </tr>
            <tr class="filter-row">
              <th><input type="text" id="shipper-filter-name" class="form-input" style="padding: 4px 8px; font-size: 12px; height: 28px; background: rgba(39,39,42,0.4);" placeholder="Lọc tên..." onkeyup="renderShippersTable()"></th>
              <th><input type="text" id="shipper-filter-phone" class="form-input" style="padding: 4px 8px; font-size: 12px; height: 28px; background: rgba(39,39,42,0.4);" placeholder="Lọc SĐT..." onkeyup="renderShippersTable()"></th>
              <th>
                <select id="shipper-filter-status" class="form-input" style="padding: 2px 8px; font-size: 12px; height: 28px; background: rgba(39, 39, 42, 0.4); border-color: var(--border);" onchange="renderShippersTable()">
                  <option value="">Tất cả</option>
                  <option value="ONLINE">Online</option>
                  <option value="OFFLINE">Offline</option>
                </select>
              </th>
              <th></th>
              <th></th>
              <th></th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody id="shippers-tbody"></tbody>
        </table>
      </div>
    </div>
  `;
  renderShippersTable();
}

let shipperFilter = 'all';

function filterShippers(btn, filter) {
  shipperFilter = filter;
  btn.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  renderShippersTable();
}

function renderShippersTable() {
  const tbody = document.getElementById('shippers-tbody');
  const countEl = document.getElementById('shipper-table-count');
  if (!tbody) return;

  const query = (document.getElementById('shipper-search')?.value || '').toLowerCase();
  
  // Lấy giá trị các bộ lọc cột
  const filterName = (document.getElementById('shipper-filter-name')?.value || '').toLowerCase();
  const filterPhone = (document.getElementById('shipper-filter-phone')?.value || '').toLowerCase();
  const filterStatus = (document.getElementById('shipper-filter-status')?.value || '');

  let filtered = cachedShippers;

  // Lọc theo tabs
  if (shipperFilter !== 'all') {
    filtered = filtered.filter(s => s.status === shipperFilter);
  }
  // Lọc theo search box chính
  if (query) {
    filtered = filtered.filter(s =>
      (s.name || '').toLowerCase().includes(query) ||
      (s.phone || '').includes(query)
    );
  }
  // Lọc theo bộ lọc riêng từng cột
  if (filterName) {
    filtered = filtered.filter(s => (s.name || '').toLowerCase().includes(filterName));
  }
  if (filterPhone) {
    filtered = filtered.filter(s => (s.phone || '').includes(filterPhone));
  }
  if (filterStatus) {
    filtered = filtered.filter(s => s.status === filterStatus);
  }

  if (countEl) countEl.textContent = filtered.length;

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8">
          <div class="empty-state" style="padding: 32px 0;">
            <p class="text-muted text-sm">Không tìm thấy tài xế trùng khớp với bộ lọc</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map(s => {
    const ar = s.acceptanceRate !== undefined ? s.acceptanceRate : 100;
    const cr = s.completionRate !== undefined ? s.completionRate : 100;
    const earnings = s.totalEarnings || 0;
    const orders = s.totalOrders || 0;

    return `
      <tr>
        <td>
          <div class="flex items-center gap-2">
            <div class="sidebar__user-avatar" style="width: 32px; height: 32px; font-size: 12px; overflow: hidden; display: flex; align-items: center; justify-content: center;">
              ${s.avatarUrl ? `<img src="${s.avatarUrl}" style="width:100%; height:100%; object-fit:cover;">` : (s.name || '?').charAt(0)}
            </div>
            <div>
              <strong style="display:block;">${s.name || '—'}</strong>
              <div class="flex items-center gap-1 text-xs" style="margin-top: 2px;">
                <span class="text-muted">${orders} đơn</span>
                <span style="color: var(--text-muted); opacity: 0.5;">·</span>
                ${s.isApproved !== false ? 
                  `<span style="color: var(--emerald-500); font-weight: 600;"><i class="fa-solid fa-circle-check"></i> Đã duyệt</span>` : 
                  `<span style="color: var(--amber); font-weight: 600;"><i class="fa-solid fa-circle-notch fa-spin"></i> Chờ duyệt</span>`
                }
              </div>
            </div>
          </div>
        </td>
        <td>
          <span class="mono text-sm" style="display:block;">${s.phone}</span>
          <span class="text-muted text-xs" style="display:block; margin-top:2px;">CCCD: ${s.cccd || '—'}</span>
        </td>
        <td><span class="badge ${statusBadgeClass(s.status)}"><span class="badge__dot"></span> ${statusLabel(s.status)}</span></td>
        <td>
          <div class="flex flex-column gap-1 text-xs">
            <div>AR: <strong class="text-accent mono">${ar}%</strong> · CR: <strong class="text-success mono">${cr}%</strong></div>
            <div style="width: 100px; height: 4px; background: rgba(39,39,42,0.6); border-radius: 2px; overflow: hidden; display: flex;">
              <div style="width: ${ar}%; height: 100%; background: var(--accent);"></div>
              <div style="width: ${cr}%; height: 100%; background: var(--success); opacity: 0.7;"></div>
            </div>
          </div>
        </td>
        <td><strong class="mono text-sm text-accent">${formatCurrency(earnings)}</strong></td>
        <td class="text-sm text-muted">${formatTime(s.lastCheckIn)}</td>
        <td class="text-sm text-muted">${formatTime(s.lastCheckOut)}</td>
        <td style="text-align: right; white-space: nowrap;">
          ${s.isApproved === false ? `
            <button class="btn btn--sm" onclick="approveShipper('${s.phone}')" title="Phê duyệt tài xế" style="background: rgba(16, 185, 129, 0.2); color: #10b981; border: none; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; margin-right: 4px; cursor: pointer;">
              <i class="fa-solid fa-check"></i> Duyệt
            </button>
          ` : ''}
          <button class="btn btn--ghost btn--sm" onclick="editShipper('${s.phone}')" title="Sửa">
            <i class="fa-solid fa-pen"></i>
          </button>
          <button class="btn btn--danger btn--sm" onclick="deleteShipper('${s.phone}')" title="Xóa">
            <i class="fa-solid fa-trash"></i>
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

async function approveShipper(phone) {
  if (!confirm('Bạn có chắc chắn muốn phê duyệt kích hoạt tài xế này?')) return;
  try {
    const res = await apiFetch(`/api/admin/shippers/${phone}/approve`, {
      method: 'POST'
    });
    if (res.success) {
      showToast('Phê duyệt tài xế thành công!', 'success');
      await fetchAllData();
      renderShippersTable();
    } else {
      showToast(res.error || 'Lỗi phê duyệt tài xế', 'error');
    }
  } catch (err) {
    showToast('Lỗi kết nối máy chủ', 'error');
  }
}
window.approveShipper = approveShipper;

function openAddShipperModal() {
  editingShipperPhone = null;
  adminShipperAvatarBase64 = null;
  document.getElementById('shipper-modal-title').textContent = 'Thêm Tài xế mới';
  document.getElementById('modal-shipper-name').value = '';
  document.getElementById('modal-shipper-phone').value = '';
  document.getElementById('modal-shipper-cccd').value = '';
  document.getElementById('modal-shipper-email').value = '';
  document.getElementById('modal-shipper-password').value = '';
  
  const fileInput = document.getElementById('modal-shipper-avatar-input');
  if (fileInput) fileInput.value = '';
  const img = document.getElementById('modal-shipper-avatar-img');
  const placeholder = document.getElementById('modal-shipper-avatar-placeholder');
  if (img) img.style.display = 'none';
  if (placeholder) placeholder.style.display = 'block';

  openModal('shipper-modal');
}

function editShipper(phone) {
  const s = cachedShippers.find(sh => sh.phone === phone);
  if (!s) return;
  editingShipperPhone = phone;
  adminShipperAvatarBase64 = null;
  document.getElementById('shipper-modal-title').textContent = 'Sửa thông tin Tài xế';
  document.getElementById('modal-shipper-name').value = s.name || '';
  document.getElementById('modal-shipper-phone').value = s.phone || '';
  document.getElementById('modal-shipper-cccd').value = s.cccd || '';
  document.getElementById('modal-shipper-email').value = s.email || '';
  document.getElementById('modal-shipper-password').value = '';
  
  const fileInput = document.getElementById('modal-shipper-avatar-input');
  if (fileInput) fileInput.value = '';
  const img = document.getElementById('modal-shipper-avatar-img');
  const placeholder = document.getElementById('modal-shipper-avatar-placeholder');
  if (s.avatarUrl && img && placeholder) {
    img.src = s.avatarUrl;
    img.style.display = 'block';
    placeholder.style.display = 'none';
  } else {
    if (img) img.style.display = 'none';
    if (placeholder) placeholder.style.display = 'block';
  }
  
  openModal('shipper-modal');
}

async function saveShipper() {
  const name = document.getElementById('modal-shipper-name').value.trim();
  const phone = document.getElementById('modal-shipper-phone').value.trim();
  const cccd = document.getElementById('modal-shipper-cccd').value.trim();
  const email = document.getElementById('modal-shipper-email').value.trim();
  const password = document.getElementById('modal-shipper-password').value.trim();

  if (!name || !phone) {
    showToast('Vui lòng nhập đầy đủ thông tin', 'warning');
    return;
  }

  try {
    let res;
    if (editingShipperPhone) {
      res = await apiFetch(`/api/admin/shippers/${editingShipperPhone}`, {
        method: 'PUT',
        body: JSON.stringify({ name, phone, email, password, cccd, avatar: adminShipperAvatarBase64 })
      });
    } else {
      res = await apiFetch('/api/admin/shippers', {
        method: 'POST',
        body: JSON.stringify({ name, phone, email, password, cccd, avatar: adminShipperAvatarBase64 })
      });
    }

    if (res.success) {
      showToast(editingShipperPhone ? 'Đã cập nhật thông tin tài xế' : 'Đã thêm tài xế mới', 'success');
      closeModal('shipper-modal');
      await fetchAllData();
      renderShippersTable();
    } else {
      showToast(res.error || 'Lỗi lưu tài xế', 'error');
    }
  } catch (e) {
    showToast('Lỗi kết nối server', 'error');
  }
}

function handleAdminShipperAvatarChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(evt) {
    adminShipperAvatarBase64 = evt.target.result;
    const img = document.getElementById('modal-shipper-avatar-img');
    const placeholder = document.getElementById('modal-shipper-avatar-placeholder');
    if (img && placeholder) {
      img.src = evt.target.result;
      img.style.display = 'block';
      placeholder.style.display = 'none';
    }
  };
  reader.readAsDataURL(file);
}
window.handleAdminShipperAvatarChange = handleAdminShipperAvatarChange;

async function deleteShipper(phone) {
  if (!confirm(`Xác nhận xóa tài xế ${phone}?`)) return;

  try {
    const res = await apiFetch(`/api/admin/shippers/${phone}`, { method: 'DELETE' });
    if (res.success) {
      showToast('Đã xóa tài xế', 'success');
      await fetchAllData();
      renderShippersTable();
    } else {
      showToast(res.error || 'Lỗi xóa', 'error');
    }
  } catch (e) {
    showToast('Lỗi kết nối', 'error');
  }
}

// ── RESTAURANTS PAGE ────────────────────────────────────────────────────────
function renderRestaurants() {
  const body = document.getElementById('main-body');
  body.innerHTML = `
    <div class="page-section-header">
      <h2>Quản lý Quán ăn</h2>
    </div>

    <div class="toolbar">
      <div class="form-search" style="width: 320px;">
        <span class="form-search__icon"><i class="fa-solid fa-magnifying-glass"></i></span>
        <input type="text" class="form-input" placeholder="Tìm quán ăn..." id="restaurant-search" onkeyup="searchRestaurantsDebounced()">
      </div>
      <div class="tabs" style="margin-bottom: 0;">
        <button class="tab active" onclick="filterRestaurants(this, 'all')">Tất cả</button>
        <button class="tab" onclick="filterRestaurants(this, 'open')">Đang mở</button>
        <button class="tab" onclick="filterRestaurants(this, 'closed')">Đã đóng</button>
      </div>
      <div class="toolbar__spacer"></div>
      <span class="text-muted text-sm mono" id="restaurant-result-info">Đang tải...</span>
    </div>

    <div class="data-table-wrapper">
      <div id="restaurants-table-body">
        <table class="data-table">
          <thead>
            <tr>
              <th>Quán ăn</th>
              <th>Danh mục</th>
              <th>Trạng thái</th>
              <th>Menu</th>
              <th>Cập nhật</th>
              <th style="text-align: right;">Thao tác</th>
            </tr>
            <tr class="filter-row">
              <th><input type="text" id="restaurant-filter-name" class="form-input" style="padding: 4px 8px; font-size: 12px; height: 28px; background: rgba(39,39,42,0.4);" placeholder="Lọc tên/địa chỉ..." onkeyup="filterRestaurantsLocal()"></th>
              <th><input type="text" id="restaurant-filter-category" class="form-input" style="padding: 4px 8px; font-size: 12px; height: 28px; background: rgba(39,39,42,0.4);" placeholder="Lọc danh mục..." onkeyup="filterRestaurantsLocal()"></th>
              <th>
                <select id="restaurant-filter-status" class="form-input" style="padding: 2px 8px; font-size: 12px; height: 28px; background: rgba(39, 39, 42, 0.4); border-color: var(--border);" onchange="filterRestaurantsLocal()">
                  <option value="">Tất cả</option>
                  <option value="open">Đang mở</option>
                  <option value="closed">Đóng cửa</option>
                </select>
              </th>
              <th>
                <select id="restaurant-filter-menu" class="form-input" style="padding: 2px 8px; font-size: 12px; height: 28px; background: rgba(39, 39, 42, 0.4); border-color: var(--border);" onchange="filterRestaurantsLocal()">
                  <option value="">Tất cả</option>
                  <option value="yes">Có menu</option>
                  <option value="no">Chưa có</option>
                </select>
              </th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody id="restaurants-tbody">
            <tr>
              <td colspan="6" style="padding: 20px;">
                <div style="display: flex; flex-direction: column; gap: 10px;">
                  <div class="skeleton skeleton--row"></div>
                  <div class="skeleton skeleton--row"></div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  loadRestaurants();
}

let restaurantFilter = 'all';
let searchDebounceTimer = null;

function filterRestaurants(btn, filter) {
  restaurantFilter = filter;
  btn.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  restaurantSearchPage = 1;
  loadRestaurants();
}

function searchRestaurantsDebounced() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    restaurantSearchPage = 1;
    loadRestaurants();
  }, 400);
}

async function loadRestaurants() {
  const query = (document.getElementById('restaurant-search')?.value || '').trim();
  const tbody = document.getElementById('restaurants-tbody');
  if (!tbody) return;

  try {
    let url = `${API_BASE}/api/restaurants?limit=50`; // Tăng giới hạn để có thêm kết quả lọc local
    if (query) url += `&q=${encodeURIComponent(query)}`;

    const res = await fetch(url).then(r => r.json());
    let restaurants = [];

    if (Array.isArray(res)) {
      restaurants = res;
    } else if (res?.data && Array.isArray(res.data)) {
      restaurants = res.data;
    } else if (res?.restaurants && Array.isArray(res.restaurants)) {
      restaurants = res.restaurants;
    }

    cachedRestaurants = restaurants;
    filterRestaurantsLocal();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><p class="text-muted">Lỗi tải dữ liệu quán ăn</p></div></td></tr>`;
  }
}

function filterRestaurantsLocal() {
  const tbody = document.getElementById('restaurants-tbody');
  const infoEl = document.getElementById('restaurant-result-info');
  if (!tbody) return;

  const filterName = (document.getElementById('restaurant-filter-name')?.value || '').toLowerCase();
  const filterCategory = (document.getElementById('restaurant-filter-category')?.value || '').toLowerCase();
  const filterStatus = document.getElementById('restaurant-filter-status')?.value || '';
  const filterMenu = document.getElementById('restaurant-filter-menu')?.value || '';

  let filtered = cachedRestaurants;

  // Lọc theo tab
  if (restaurantFilter === 'open') {
    filtered = filtered.filter(r => !r.isClosed);
  } else if (restaurantFilter === 'closed') {
    filtered = filtered.filter(r => r.isClosed);
  }

  // Lọc theo bộ lọc riêng từng cột
  if (filterName) {
    filtered = filtered.filter(r => 
      (r.name || '').toLowerCase().includes(filterName) || 
      (r.address || '').toLowerCase().includes(filterName)
    );
  }
  if (filterCategory) {
    filtered = filtered.filter(r => (r.category || '').toLowerCase().includes(filterCategory));
  }
  if (filterStatus) {
    if (filterStatus === 'open') {
      filtered = filtered.filter(r => !r.isClosed);
    } else if (filterStatus === 'closed') {
      filtered = filtered.filter(r => r.isClosed);
    }
  }
  if (filterMenu) {
    if (filterMenu === 'yes') {
      filtered = filtered.filter(r => r.hasRealMenu);
    } else if (filterMenu === 'no') {
      filtered = filtered.filter(r => !r.hasRealMenu);
    }
  }

  if (infoEl) infoEl.textContent = `${filtered.length} quán`;
  document.getElementById('nav-restaurant-count').textContent = filtered.length;

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6">
          <div class="empty-state" style="padding: 32px 0;">
            <p class="text-muted text-sm">Không tìm thấy quán ăn trùng khớp bộ lọc</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map(r => `
    <tr>
      <td>
        <div style="max-width: 260px;">
          <strong class="truncate" style="display: block; font-size: 13px;">${r.name || '—'}</strong>
          <span class="text-muted text-xs truncate" style="display: block;">${r.address || ''}</span>
        </div>
      </td>
      <td class="text-sm">${r.category || '—'}</td>
      <td>
        <span class="badge ${r.isClosed ? 'badge--closed' : 'badge--open'}">
          <span class="badge__dot"></span>
          ${r.isClosed ? 'Đóng cửa' : 'Đang mở'}
        </span>
      </td>
      <td>
        <span class="mono text-sm">${r.hasRealMenu ? '✓ Có menu' : '—'}</span>
      </td>
      <td class="text-xs text-muted">${r.menuUpdatedAt ? formatTime(r.menuUpdatedAt) : '—'}</td>
      <td style="text-align: right;">
        <button class="btn btn--ghost btn--sm" onclick="viewRestaurantMenu('${r.id}')" title="Xem/Sửa menu">
          <i class="fa-solid fa-utensils"></i>
        </button>
        <button class="btn btn--ghost btn--sm" onclick="toggleRestaurantStatus('${r.id}', ${!r.isClosed})" title="${r.isClosed ? 'Mở cửa' : 'Đóng cửa'}">
          <i class="fa-solid fa-${r.isClosed ? 'lock-open' : 'lock'}"></i>
        </button>
      </td>
    </tr>
  `).join('');
}

async function viewRestaurantMenu(restaurantId) {
  document.getElementById('menu-modal-title').textContent = 'Đang tải menu...';
  document.getElementById('menu-modal-body').innerHTML = `
    <div style="padding: 32px; text-align: center;">
      <div class="skeleton skeleton--row"></div>
      <div class="skeleton skeleton--row"></div>
      <div class="skeleton skeleton--row"></div>
    </div>
  `;

  // Thay đổi footer của modal để có nút lưu
  const footerEl = document.querySelector('#menu-modal .modal__footer');
  if (footerEl) {
    footerEl.innerHTML = `
      <button class="btn btn--secondary" onclick="closeModal('menu-modal')">Đóng</button>
      <button class="btn btn--primary" id="save-menu-btn" onclick="saveEditedMenu('${restaurantId}')" style="display: none;">
        <i class="fa-solid fa-floppy-disk"></i> Lưu thay đổi
      </button>
    `;
  }

  openModal('menu-modal');

  try {
    const res = await fetch(`${API_BASE}/api/restaurants/${restaurantId}`).then(r => r.json());
    const data = res?.data || res;

    document.getElementById('menu-modal-title').textContent = `Menu: ${data?.name || restaurantId}`;

    const menu = data?.menu || [];
    currentEditingMenu = JSON.parse(JSON.stringify(menu)); // Sao chép thực đơn để chỉnh sửa

    if (menu.length === 0) {
      document.getElementById('menu-modal-body').innerHTML = `
        <div class="empty-state" style="padding: 32px;">
          <div class="empty-state__icon"><i class="fa-solid fa-utensils"></i></div>
          <h3>Chưa có menu</h3>
          <p>Quán ăn này chưa được cào menu từ ShopeeFood</p>
        </div>
      `;
      return;
    }

    // Nhóm theo nhóm món ăn
    const categories = {};
    currentEditingMenu.forEach((item, index) => {
      const cat = item.category || 'Khác';
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push({ item, index });
    });

    let html = '';
    Object.entries(categories).forEach(([cat, groupedItems]) => {
      html += `<div style="padding: 12px 16px; background: rgba(39,39,42,0.3); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted);">${cat} (${groupedItems.length})</div>`;
      groupedItems.forEach(({ item, index }) => {
        const appPrice = item.appPrice || Math.round(item.inStorePrice * 1.28 / 100) * 100;
        html += `
          <div class="menu-item">
            ${item.img ? `<img src="${item.img}" alt="" class="menu-item__img" onerror="this.style.display='none'">` : '<div class="menu-item__img" style="display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:16px;"><i class="fa-solid fa-bowl-food"></i></div>'}
            <div class="menu-item__info">
              <div class="menu-item__name">${item.name || '—'}</div>
              <div class="menu-item__desc">${item.desc || ''}</div>
              <div style="display: flex; align-items: center; gap: 8px; margin-top: 6px;">
                <span style="font-size:11px; color:var(--clr-text-muted); font-weight:600;">Bán món:</span>
                <label class="switch" style="position: relative; display: inline-block; width: 34px; height: 20px; vertical-align: middle;">
                  <input type="checkbox" ${item.available !== false ? 'checked' : ''} 
                         onchange="toggleMenuItemAvailability(this, '${restaurantId}', '${item.id || item.name}'); this.nextElementSibling.style.backgroundColor = this.checked ? '#10b981' : '#ef4444'; this.nextElementSibling.firstElementChild.style.transform = this.checked ? 'translateX(14px)' : 'none';"
                         style="opacity: 0; width: 0; height: 0;">
                  <span class="slider round" style="position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: ${item.available !== false ? '#10b981' : '#ef4444'}; transition: .3s; border-radius: 34px; display: block;">
                    <span style="position: absolute; height: 14px; width: 14px; left: 3px; bottom: 3px; background-color: white; transition: .3s; border-radius: 50%; display: block; transform: ${item.available !== false ? 'translateX(14px)' : 'none'};"></span>
                  </span>
                </label>
              </div>
            </div>
            <div class="menu-item__prices" style="display: flex; flex-direction: column; gap: 4px; align-items: flex-end;">
              <div style="font-size: 11px; color: var(--text-muted);">Giá App (Markup 28%): <strong class="mono text-accent" id="app-price-${index}">${formatCurrency(appPrice)}</strong></div>
              <div style="display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-muted);">
                <span>Giá gốc:</span>
                <input type="number" class="form-input mono" 
                       value="${item.inStorePrice}" 
                       style="width: 90px; padding: 2px 6px; font-size: 12px; height: 24px; text-align: right; background: rgba(39,39,42,0.4);" 
                       oninput="handleMenuPriceInput(this, ${index})">
              </div>
            </div>
          </div>
        `;
      });
    });

    document.getElementById('menu-modal-body').innerHTML = html;

  } catch (e) {
    document.getElementById('menu-modal-body').innerHTML = `<div class="empty-state" style="padding: 32px;"><p class="text-muted">Lỗi tải menu</p></div>`;
  }
}

function handleMenuPriceInput(input, index) {
  const val = Number(input.value) || 0;
  if (currentEditingMenu[index]) {
    currentEditingMenu[index].inStorePrice = val;
    // Tính lại giá App = giá cửa hàng * 1.28 làm tròn đến hàng trăm
    const appPrice = Math.round(val * 1.28 / 100) * 100;
    currentEditingMenu[index].appPrice = appPrice;
    
    // Cập nhật hiển thị giá app trực tiếp trên giao diện
    const appPriceEl = document.getElementById(`app-price-${index}`);
    if (appPriceEl) {
      appPriceEl.textContent = formatCurrency(appPrice);
    }

    // Hiển thị nút lưu
    const saveBtn = document.getElementById('save-menu-btn');
    if (saveBtn) {
      saveBtn.style.display = 'inline-flex';
    }
  }
}

async function saveEditedMenu(restaurantId) {
  const saveBtn = document.getElementById('save-menu-btn');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang lưu...';
  }

  try {
    const res = await fetch(`${API_BASE}/api/admin/restaurants/${restaurantId}/menu`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ menu: currentEditingMenu })
    }).then(r => r.json());

    if (res.success) {
      showToast('Đã lưu thay đổi giá thực đơn thành công!', 'success');
      closeModal('menu-modal');
      loadRestaurants(); // Tải lại danh sách quán để cập nhật tag menu
    } else {
      showToast(res.error || 'Lỗi lưu thực đơn', 'error');
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Lưu thay đổi';
      }
    }
  } catch (err) {
    showToast('Lỗi kết nối đến server', 'error');
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Lưu thay đổi';
    }
  }
}

async function toggleRestaurantStatus(id, setClosed) {
  try {
    const status = setClosed ? 'CLOSED' : 'OPEN';
    const res = await fetch(`${API_BASE}/api/admin/restaurants/${id}/toggle-status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status })
    }).then(r => r.json());

    if (res.success) {
      showToast(`Đã ${setClosed ? 'Đóng' : 'Mở'} cửa quán thành công!`, 'success');
      loadRestaurants(); // Reload list
    } else {
      showToast(res.error || 'Lỗi thay đổi trạng thái quán', 'error');
    }
  } catch (err) {
    showToast('Lỗi kết nối server', 'error');
  }
}

// ── ORDERS PAGE ─────────────────────────────────────────────────────────────
function renderOrders() {
  const body = document.getElementById('main-body');
  body.innerHTML = `
    <div class="page-section-header">
      <h2>Quản lý Đơn hàng</h2>
    </div>

    <div class="toolbar">
      <div class="form-search" style="width: 260px;">
        <span class="form-search__icon"><i class="fa-solid fa-magnifying-glass"></i></span>
        <input type="text" class="form-input" placeholder="Tìm đơn hàng..." id="order-search" onkeyup="renderOrdersTable()">
      </div>
      <div class="tabs" style="margin-bottom: 0;">
        <button class="tab active" onclick="filterOrders(this, 'all')">Tất cả</button>
        <button class="tab" onclick="filterOrders(this, 'PENDING')">Chờ nhận</button>
        <button class="tab" onclick="filterOrders(this, 'ACCEPTED')">Đã nhận</button>
        <button class="tab" onclick="filterOrders(this, 'PURCHASED')">Đã mua</button>
        <button class="tab" onclick="filterOrders(this, 'DELIVERED')">Hoàn thành</button>
      </div>
    </div>

    <div class="data-table-wrapper">
      <div class="data-table-header">
        <h3>Đơn hàng</h3>
        <span class="count" id="order-table-count">${cachedOrders.length}</span>
      </div>
      <div id="orders-table-body"></div>
    </div>
  `;
  renderOrdersTable();
}

let orderFilter = 'all';

function filterOrders(btn, filter) {
  orderFilter = filter;
  btn.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  renderOrdersTable();
}

function renderOrdersTable() {
  const el = document.getElementById('orders-table-body');
  const countEl = document.getElementById('order-table-count');
  if (!el) return;

  const query = (document.getElementById('order-search')?.value || '').toLowerCase();
  let filtered = cachedOrders;

  if (orderFilter !== 'all') {
    filtered = filtered.filter(o => o.status === orderFilter);
  }
  if (query) {
    filtered = filtered.filter(o =>
      (o.id || '').toLowerCase().includes(query) ||
      (o.restaurantName || '').toLowerCase().includes(query) ||
      (o.deliveryName || '').toLowerCase().includes(query) ||
      (o.deliveryPhone || '').includes(query)
    );
  }

  // Sort by createdAt descending
  filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  if (countEl) countEl.textContent = filtered.length;

  if (filtered.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="empty-state__icon"><i class="fa-solid fa-receipt"></i></div><h3>Không có đơn hàng</h3><p>Chưa có đơn hàng phù hợp bộ lọc</p></div>`;
    return;
  }

  el.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Mã đơn</th>
          <th>Quán ăn</th>
          <th>Khách hàng</th>
          <th>Tài xế</th>
          <th>Tổng tiền</th>
          <th>Trạng thái</th>
          <th>Thời gian</th>
        </tr>
      </thead>
      <tbody>
        ${filtered.map(o => `
          <tr style="cursor: pointer;" onclick="showOrderDetail('${o.id}')">
            <td><span class="mono text-sm fw-700">${o.id}</span></td>
            <td class="truncate" style="max-width: 180px;">${o.restaurantName || '—'}</td>
            <td>
              <div style="max-width: 140px;">
                <div class="truncate text-sm">${o.deliveryName || '—'}</div>
                <div class="mono text-xs text-muted">${o.deliveryPhone || ''}</div>
              </div>
            </td>
            <td class="text-sm">${o.shipperName || '<span class="text-muted">—</span>'}</td>
            <td><span class="mono text-sm fw-700 text-accent">${formatCurrency(o.appTotal)}</span></td>
            <td><span class="badge ${statusBadgeClass(o.status)}"><span class="badge__dot"></span> ${statusLabel(o.status)}</span></td>
            <td class="text-xs text-muted">${formatTime(o.createdAt)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function showOrderDetail(orderId) {
  const o = cachedOrders.find(ord => ord.id === orderId);
  if (!o) {
    showToast('Không tìm thấy đơn hàng', 'error');
    return;
  }

  // Lọc các tài xế đang ONLINE để gán đơn chủ động
  const onlineShippers = cachedShippers.filter(s => s.status === 'ONLINE');
  let assignHtml = '';
  if (o.status === 'PENDING') {
    const optionsHtml = onlineShippers.map(s => `<option value="${s.phone}">${s.name} (${s.phone})</option>`).join('');
    assignHtml = `
      <div style="border-top: 1px solid var(--border); padding-top: 12px; margin-top: 12px; background: rgba(59, 130, 246, 0.05); padding: 12px; border-radius: 8px;">
        <h4 class="mb-2" style="color: var(--blue); font-size:13px; font-weight:700;"><i class="fa-solid fa-motorcycle"></i> Chỉ định tài xế gán đơn</h4>
        ${onlineShippers.length === 0 
          ? `<div class="text-xs text-muted" style="margin-top:4px;"><i class="fa-solid fa-circle-info"></i> Không có tài xế nào đang Trực tuyến (ONLINE) lúc này.</div>`
          : `<div class="flex gap-2" style="margin-top:6px; display:flex; gap:8px;">
              <select id="assign-shipper-select" class="form-input" style="flex: 1; padding: 6px 12px; font-size:12px;">
                ${optionsHtml}
              </select>
              <button class="btn btn--primary btn--sm" onclick="assignOrderToShipper('${o.id}')" style="padding: 6px 16px; font-size:12px;">Gán đơn</button>
            </div>`
        }
      </div>
    `;
  }

  document.getElementById('order-modal-title').textContent = `Đơn hàng ${o.id}`;
  document.getElementById('order-modal-body').innerHTML = `
    <div class="flex items-center justify-between mb-4">
      <span class="badge ${statusBadgeClass(o.status)}" style="font-size: 12px; padding: 5px 14px;">
        <span class="badge__dot"></span> ${statusLabel(o.status)}
      </span>
      <span class="mono text-sm text-muted">${formatTime(o.createdAt)}</span>
    </div>

    <div class="card mb-4" style="padding: 16px;">
      <div style="display: flex; align-items: flex-start; gap: 10px; margin-bottom: 12px;">
        <span style="font-size: 16px;">🏪</span>
        <div>
          <div class="text-sm fw-700">${o.restaurantName || '—'}</div>
          <div class="text-xs text-muted">${o.restaurantAddress || ''}</div>
        </div>
      </div>
      <div style="display: flex; align-items: flex-start; gap: 10px;">
        <span style="font-size: 16px;">🏠</span>
        <div>
          <div class="text-sm fw-700">${o.deliveryName || '—'}</div>
          <div class="text-xs text-muted">${o.deliveryAddress || ''}</div>
          <div class="mono text-xs text-muted">${o.deliveryPhone || ''}</div>
        </div>
      </div>
    </div>

    ${o.note ? `<div class="card mb-4" style="padding: 12px; background: var(--amber-dim); border-color: rgba(245,158,11,0.2);"><span class="text-sm" style="color: var(--amber);">📝 ${o.note}</span></div>` : ''}

    <h4 class="mb-4">Món ăn (${(o.items || []).length})</h4>
    ${(o.items || []).map(item => {
      const noteHtml = item.note 
        ? `<div style="color: #f59e0b; font-size: 11px; margin-top: 2px; padding: 2px 6px; background: rgba(245,158,11,0.08); border: 1px dashed rgba(245,158,11,0.2); border-radius: 4px; display: inline-block; box-sizing: border-box; width:100%;"><i class="fa-solid fa-note-sticky"></i> Ghi chú: <strong>${item.note}</strong></div>`
        : '';
      return `
        <div class="menu-item" style="padding: 8px 0; border-bottom: 1px solid var(--border); display:flex; flex-direction:column;">
          <div style="display:flex; justify-content:space-between; width:100%;">
            <div class="menu-item__name" style="font-weight:600;">${item.name || '—'} × ${item.qty || 1}</div>
            <div class="mono text-sm fw-700">${formatCurrency((item.appPrice || 0) * (item.qty || 1))}</div>
          </div>
          ${noteHtml}
        </div>
      `;
    }).join('')}

    <div style="border-top: 1px solid var(--border); padding-top: 12px; margin-top: 12px;">
      <div class="flex justify-between mb-4">
        <span class="text-sm text-muted">Tổng thanh toán (COD)</span>
        <span class="mono fw-700" style="font-size: 18px; color: var(--emerald-500);">${formatCurrency(o.appTotal)}</span>
      </div>
      <div class="flex justify-between mb-4">
        <span class="text-sm text-muted">Ứng trả quán</span>
        <span class="mono text-sm">${formatCurrency(o.storeTotal)}</span>
      </div>
      <div class="flex justify-between">
        <span class="text-sm text-muted">Thu nhập tài xế</span>
        <span class="mono text-sm fw-700" style="color: var(--amber);">${formatCurrency(o.shipperEarning)}</span>
      </div>
    </div>

    ${assignHtml}

    ${o.shipperName ? `
      <div style="border-top: 1px solid var(--border); padding-top: 12px; margin-top: 12px;">
        <h4 class="mb-4">Tài xế</h4>
        <div class="flex items-center gap-2" onclick="editShipper('${o.shipperPhone}')" style="cursor: pointer;" title="Xem/Sửa thông tin tài xế">
          <div class="sidebar__user-avatar" style="width: 28px; height: 28px; font-size: 11px; overflow: hidden; display: flex; align-items: center; justify-content: center;">
            ${o.shipperAvatarUrl ? `<img src="${o.shipperAvatarUrl}" style="width:100%; height:100%; object-fit:cover;">` : (o.shipperName || '?').charAt(0)}
          </div>
          <div>
            <div class="text-sm fw-700">${o.shipperName}</div>
            <div class="mono text-xs text-muted">${o.shipperPhone || ''}</div>
          </div>
        </div>
      </div>
    ` : ''}

    <div style="border-top: 1px solid var(--border); padding-top: 12px; margin-top: 12px;">
      <h4 class="mb-4">Timeline</h4>
      <div class="timeline">
        <div class="timeline__item done">
          <div class="timeline__dot"></div>
          <div class="timeline__label">Đặt hàng</div>
          <div class="timeline__time">${formatTime(o.createdAt)}</div>
        </div>
        <div class="timeline__item ${o.acceptedAt ? 'done' : (o.status === 'PENDING' ? 'active' : '')}">
          <div class="timeline__dot"></div>
          <div class="timeline__label">Shipper nhận đơn</div>
          <div class="timeline__time">${formatTime(o.acceptedAt)}</div>
        </div>
        <div class="timeline__item ${o.purchasedAt ? 'done' : (o.status === 'ACCEPTED' ? 'active' : '')}">
          <div class="timeline__dot"></div>
          <div class="timeline__label">Đã mua hàng</div>
          <div class="timeline__time">${formatTime(o.purchasedAt)}</div>
        </div>
        <div class="timeline__item ${o.deliveredAt ? 'done' : (o.status === 'PURCHASED' ? 'active' : '')}">
          <div class="timeline__dot"></div>
          <div class="timeline__label">Giao thành công</div>
          <div class="timeline__time">${formatTime(o.deliveredAt)}</div>
        </div>
      </div>
    </div>
  `;
  openModal('order-modal');
}

// ── CUSTOMERS PAGE ──────────────────────────────────────────────────────────
function renderCustomers() {
  const body = document.getElementById('main-body');

  const customerMap = new Map();
  cachedOrders.forEach(o => {
    const phone = o.deliveryPhone || o.ordererPhone;
    if (!phone) return;
    if (!customerMap.has(phone)) {
      customerMap.set(phone, {
        name: o.deliveryName || '—',
        phone,
        address: o.deliveryAddress || '',
        orders: [],
        totalSpent: 0
      });
    }
    const c = customerMap.get(phone);
    c.orders.push(o);
    c.totalSpent += (o.appTotal || 0);
  });

  const customers = Array.from(customerMap.values());

  body.innerHTML = `
    <div class="page-section-header">
      <h2>Khách hàng</h2>
    </div>

    <div class="toolbar">
      <div class="form-search" style="width: 280px;">
        <span class="form-search__icon"><i class="fa-solid fa-magnifying-glass"></i></span>
        <input type="text" class="form-input" placeholder="Tìm khách hàng..." id="customer-search">
      </div>
      <div class="toolbar__spacer"></div>
      <span class="text-muted text-sm">${customers.length} khách hàng</span>
    </div>

    <div class="data-table-wrapper">
      <div class="data-table-header">
        <h3>Danh sách khách hàng</h3>
        <span class="count">${customers.length}</span>
      </div>
      ${customers.length === 0
        ? `<div class="empty-state"><div class="empty-state__icon"><i class="fa-solid fa-users"></i></div><h3>Chưa có khách hàng</h3><p>Khách hàng sẽ xuất hiện khi có đơn hàng</p></div>`
        : `<table class="data-table">
          <thead>
            <tr>
              <th>Khách hàng</th>
              <th>Số điện thoại</th>
              <th>Địa chỉ</th>
              <th>Số đơn</th>
              <th>Tổng chi tiêu</th>
            </tr>
          </thead>
          <tbody>
            ${customers.map(c => `
              <tr>
                <td>
                  <div style="display:flex; align-items:center; gap:8px;">
                    <div class="sidebar__user-avatar" style="width: 32px; height: 32px; font-size: 12px; background: rgba(59, 130, 246, 0.1); color: var(--clr-primary); display:flex; align-items:center; justify-content:center; border-radius:50%;">${(c.name || '?').charAt(0)}</div>
                    <strong>${c.name}</strong>
                  </div>
                </td>
                <td><span class="mono text-sm">${c.phone}</span></td>
                <td class="text-sm text-muted" style="max-width: 200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${c.address}</td>
                <td><span class="mono text-sm fw-700">${c.orders.length}</span></td>
                <td><span class="mono text-sm fw-700 text-accent">${formatCurrency(c.totalSpent)}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>`
      }
    </div>
  `;
}

// ── SETTINGS PAGE ───────────────────────────────────────────────────────────
function renderSettings() {
  const body = document.getElementById('main-body');
  body.innerHTML = `
    <div class="page-section-header">
      <h2>Cấu hình hệ thống</h2>
    </div>

    <div class="grid-2" style="gap: 20px;">
      <div class="card" id="pricing-settings-card">
        <h3 class="mb-4"><i class="fa-solid fa-tags" style="color: var(--clr-primary); margin-right: 8px;"></i>Pricing & Khuyến mãi</h3>
        <div class="form-group">
          <label class="form-label">Markup món ăn (%) (ví dụ: 28)</label>
          <input type="number" class="form-input" id="settings-markup-rate" min="0" max="100" value="28">
        </div>
        <div class="form-group">
          <label class="form-label">Giảm giá đơn thứ 2 (%) (ví dụ: 10)</label>
          <input type="number" class="form-input" id="settings-discount-rate" min="0" max="100" value="10">
        </div>
        <button class="btn btn--primary btn--sm" onclick="savePricingSettings()">
          <i class="fa-solid fa-floppy-disk"></i> Lưu cấu hình
        </button>
      </div>

      <div class="card">
        <h3 class="mb-4"><i class="fa-solid fa-server" style="color: var(--blue); margin-right: 8px;"></i>API Server</h3>
        <div class="form-group">
          <label class="form-label">API Base URL</label>
          <input type="text" class="form-input mono" id="settings-api-url" value="${API_BASE}">
        </div>
        <button class="btn btn--primary btn--sm" onclick="saveApiUrl()">
          <i class="fa-solid fa-floppy-disk"></i> Lưu
        </button>
        <button class="btn btn--secondary btn--sm" onclick="testApiConnection()">
          <i class="fa-solid fa-plug"></i> Test kết nối
        </button>
      </div>

      <div class="card">
        <h3 class="mb-4"><i class="fa-solid fa-shield-halved" style="color: var(--emerald-500); margin-right: 8px;"></i>Supabase Auth</h3>
        <div class="form-group">
          <label class="form-label">Supabase URL</label>
          <input type="text" class="form-input mono" id="settings-supabase-url" placeholder="https://xxxxx.supabase.co" value="${localStorage.getItem('supabase_url') || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Anon Key</label>
          <input type="password" class="form-input mono" id="settings-supabase-key" placeholder="eyJhbGci..." value="${localStorage.getItem('supabase_anon_key') || ''}">
        </div>
        <button class="btn btn--primary btn--sm" onclick="saveSupabaseConfig()">
          <i class="fa-solid fa-floppy-disk"></i> Lưu
        </button>
      </div>

      <div class="card">
        <h3 class="mb-4"><i class="fa-solid fa-broom" style="color: var(--amber); margin-right: 8px;"></i>Bảo trì</h3>
        <button class="btn btn--secondary btn--sm mb-4" onclick="clearApiCache()">
          <i class="fa-solid fa-trash-can"></i> Xóa Cache API
        </button>
        <button class="btn btn--danger btn--sm" onclick="handleAdminLogout()">
          <i class="fa-solid fa-right-from-bracket"></i> Đăng xuất
        </button>
      </div>

      <div class="card">
        <h3 class="mb-4"><i class="fa-solid fa-circle-info" style="color: var(--violet); margin-right: 8px;"></i>Thông tin</h3>
        <div class="text-sm text-muted" style="line-height: 2;">
          <div>Phiên bản: <span class="mono">1.0.0</span></div>
          <div>Server: <span class="mono" id="server-status-text">—</span></div>
          <div>Database: <span class="mono">Local JSON + Supabase</span></div>
        </div>
      </div>
    </div>
  `;

  // Tải cấu hình pricing từ API
  fetch(`${API_BASE}/api/admin/pricing-config`)
    .then(r => r.json())
    .then(res => {
      if (res.success && res.data) {
        const markupInput = document.getElementById('settings-markup-rate');
        const discountInput = document.getElementById('settings-discount-rate');
        if (markupInput) markupInput.value = Math.round(res.data.markupRate * 100);
        if (discountInput) discountInput.value = Math.round(res.data.secondOrderDiscountRate * 100);
      }
    })
    .catch(err => console.error('Lỗi lấy cấu hình pricing:', err));

  checkServerStatus();
}

function saveApiUrl() {
  const url = document.getElementById('settings-api-url').value.trim();
  if (url) {
    API_BASE = url;
    localStorage.setItem('shipfee_api_url', url);
    showToast('Đã lưu API URL', 'success');
  }
}

function saveSupabaseConfig() {
  const url = document.getElementById('settings-supabase-url').value.trim();
  const key = document.getElementById('settings-supabase-key').value.trim();
  if (url) localStorage.setItem('supabase_url', url);
  if (key) localStorage.setItem('supabase_anon_key', key);
  showToast('Đã lưu cấu hình Supabase', 'success');
}

async function testApiConnection() {
  try {
    const res = await fetch(`${API_BASE}/api/status`).then(r => r.json());
    if (res.status === 'online') {
      showToast('Kết nối API thành công', 'success');
    } else {
      showToast('Server phản hồi bất thường', 'warning');
    }
  } catch (e) {
    showToast('Không thể kết nối đến API server', 'error');
  }
}

async function clearApiCache() {
  try {
    await fetch(`${API_BASE}/api/cache/clear`, { method: 'POST' });
    showToast('Đã xóa cache API', 'success');
  } catch (e) {
    showToast('Lỗi xóa cache', 'error');
  }
}

async function checkServerStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/status`).then(r => r.json());
    const el = document.getElementById('server-status-text');
    if (el) el.textContent = `${res.status || 'unknown'} (${res.city || ''})`;
  } catch (e) {
    const el = document.getElementById('server-status-text');
    if (el) el.textContent = 'Offline';
  }
}

async function savePricingSettings() {
  const markupInput = document.getElementById('settings-markup-rate');
  const discountInput = document.getElementById('settings-discount-rate');
  if (!markupInput || !discountInput) return;

  const markupRate = parseFloat(markupInput.value) / 100;
  const secondOrderDiscountRate = parseFloat(discountInput.value) / 100;

  if (isNaN(markupRate) || isNaN(secondOrderDiscountRate)) {
    showToast('Thông số không hợp lệ!', 'error');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/admin/pricing-config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ markupRate, secondOrderDiscountRate })
    }).then(r => r.json());

    if (res.success) {
      showToast('Đã lưu cấu hình Pricing & Khuyến mãi thành công!', 'success');
    } else {
      showToast(res.error || 'Lỗi lưu cấu hình', 'error');
    }
  } catch (err) {
    showToast('Không thể kết nối đến API Server.', 'error');
  }
}

window.savePricingSettings = savePricingSettings;

async function assignOrderToShipper(orderId) {
  const select = document.getElementById('assign-shipper-select');
  if (!select) return;
  const shipperPhone = select.value;
  if (!shipperPhone) {
    showToast('Vui lòng chọn tài xế!', 'warning');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/admin/orders/${orderId}/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ shipperPhone })
    }).then(r => r.json());

    if (res.success) {
      showToast('Gán đơn cho tài xế thành công!', 'success');
      closeModal('order-modal');
      // Refresh dữ liệu ngay lập tức
      fetchAllData();
    } else {
      showToast(res.error || 'Lỗi gán đơn', 'error');
    }
  } catch (err) {
    showToast('Lỗi kết nối server', 'error');
  }
}
window.assignOrderToShipper = assignOrderToShipper;

async function toggleMenuItemAvailability(checkbox, restaurantId, itemId) {
  const available = checkbox.checked;
  try {
    const res = await fetch(`${API_BASE}/api/admin/restaurants/${restaurantId}/menu/${itemId}/toggle-availability`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ available })
    }).then(r => r.json());

    if (res.success) {
      showToast(`Đã ${available ? 'Bật' : 'Tắt'} món ăn thành công!`, 'success');
    } else {
      showToast(res.error || 'Lỗi thay đổi trạng thái món ăn', 'error');
      checkbox.checked = !available; // Hoàn tác
      checkbox.nextElementSibling.style.backgroundColor = !available ? '#10b981' : '#ef4444';
      checkbox.nextElementSibling.firstElementChild.style.transform = !available ? 'translateX(14px)' : 'none';
    }
  } catch (err) {
    showToast('Lỗi kết nối server', 'error');
    checkbox.checked = !available; // Hoàn tác
    checkbox.nextElementSibling.style.backgroundColor = !available ? '#10b981' : '#ef4444';
    checkbox.nextElementSibling.firstElementChild.style.transform = !available ? 'translateX(14px)' : 'none';
  }
}
window.toggleMenuItemAvailability = toggleMenuItemAvailability;

// ── SYSTEM NOTIFICATIONS & PRICE/STATUS CHANGES CRM LOGIC ────────────────────
let cachedNotifications = [];

async function fetchNotifications() {
  try {
    const res = await fetchWithAuth(`${API_BASE}/api/admin/notifications`);
    if (res.success && Array.isArray(res.data)) {
      cachedNotifications = res.data;
    }
  } catch (err) {
    console.error('[Notifications] Lỗi nạp thông báo:', err.message);
  }
}

function renderNotificationsList() {
  const container = document.getElementById('notifications-body');
  if (!container) return;

  if (cachedNotifications.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: 32px;">
        <p class="text-muted text-sm"><i class="fa-solid fa-circle-check"></i> Không có biến động giá hoặc trạng thái nào mới.</p>
      </div>`;
    return;
  }

  let html = `<table class="data-table"><tbody>`;
  
  cachedNotifications.forEach(n => {
    const isUnread = n.read !== true;
    const timeStr = new Date(n.createdAt).toLocaleString('vi-VN');
    const badgeColor = n.type === 'price_change' ? '#f59e0b' : '#ef4444';
    const badgeText = n.type === 'price_change' ? 'Biến động giá' : 'Đổi trạng thái';
    
    // Custom style cho chấm đỏ chưa đọc
    const unreadDot = isUnread ? `<span class="badge__dot" style="background:#ef4444; width:8px; height:8px; display:inline-block; border-radius:50%; margin-right:6px; animation: pulse 1.5s infinite;"></span>` : '';
    
    html += `
      <tr style="${isUnread ? 'background: rgba(245,158,11,0.02);' : ''}">
        <td style="width: 28px; text-align: center;">
          ${isUnread 
            ? `<button class="btn btn--ghost btn--icon btn--sm" onclick="handleReadNotification('${n.id}', event)" title="Đánh dấu đã xem" style="color:#f59e0b;"><i class="fa-solid fa-circle-check"></i></button>`
            : `<i class="fa-solid fa-check text-muted" style="font-size:12px;"></i>`
          }
        </td>
        <td style="white-space: nowrap; width: 140px;">
          <span class="badge" style="background: ${badgeColor}22; color: ${badgeColor}; border: 1px solid ${badgeColor}33; font-size:11px;">
            ${badgeText}
          </span>
        </td>
        <td>
          <div style="display: flex; align-items: center; gap: 8px;">
            ${unreadDot}
            <strong style="color: var(--text-primary); cursor: pointer;" onclick="viewRestaurantInCRM('${n.restaurantId}', '${n.restaurantName.replace(/'/g, "\\'")}')" title="Xem quán & menu">
              ${n.restaurantName}
            </strong>
          </div>
          <div class="text-xs text-muted" style="margin-top: 4px; white-space: pre-wrap; line-height: 1.5;">${n.message}</div>
        </td>
        <td class="mono text-xs text-muted" style="text-align: right; white-space: nowrap; width: 150px;">
          ${timeStr}
        </td>
        <td style="text-align: right; width: 80px;">
          <button class="btn btn--secondary btn--sm" onclick="viewRestaurantInCRM('${n.restaurantId}', '${n.restaurantName.replace(/'/g, "\\'")}')" style="padding: 4px 10px; font-size: 11px;">
            <i class="fa-solid fa-store"></i> Xem quán
          </button>
        </td>
      </tr>
    `;
  });
  
  html += `</tbody></table>`;
  container.innerHTML = html;
}

async function handleReadNotification(id, event) {
  if (event) event.stopPropagation();
  try {
    const res = await fetchWithAuth(`${API_BASE}/api/admin/notifications/${id}/read`, { method: 'POST' });
    if (res.success) {
      // Cập nhật trạng thái cục bộ
      const idx = cachedNotifications.findIndex(n => n.id === id);
      if (idx !== -1) cachedNotifications[idx].read = true;
      renderNotificationsList();
      showToast('Đã đánh dấu đã xem!', 'success');
    }
  } catch (err) {
    showToast('Lỗi kết nối server', 'error');
  }
}

async function handleReadAllNotifications() {
  try {
    const res = await fetchWithAuth(`${API_BASE}/api/admin/notifications/read-all`, { method: 'POST' });
    if (res.success) {
      cachedNotifications.forEach(n => n.read = true);
      renderNotificationsList();
      showToast('Đã đánh dấu đã xem tất cả!', 'success');
    }
  } catch (err) {
    showToast('Lỗi kết nối server', 'error');
  }
}

function viewRestaurantInCRM(restaurantId, restaurantName) {
  // 1. Chuyển hướng sang tab Quán ăn
  navigateTo('restaurants');
  
  // 2. Chờ DOM render xong, điền tên quán vào ô lọc
  setTimeout(() => {
    const filterInput = document.getElementById('restaurant-filter-name');
    if (filterInput) {
      filterInput.value = restaurantName;
      filterRestaurantsLocal();
    }
    
    // 3. Tự động mở Modal Menu của quán ăn đó luôn để Admin xem nhanh món/giá thay đổi!
    openRestaurantMenu(restaurantId);
  }, 120);
}

// Đăng ký toàn cục
window.fetchNotifications = fetchNotifications;
window.renderNotificationsList = renderNotificationsList;
window.handleReadNotification = handleReadNotification;
window.handleReadAllNotifications = handleReadAllNotifications;
window.viewRestaurantInCRM = viewRestaurantInCRM;
