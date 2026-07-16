/* ==========================================================================
   ShipFee CRM Upgrade — Ops Console, Data Health, Export, Live Monitor
   Inspired by dispatch/control-center patterns (Olo, Chowly, UpMenu, Deonde)
   Loaded after app.js — extends router & shared caches.
   ========================================================================== */
'use strict';

const ORDER_SLA_WARN_MS = 2 * 60 * 1000;   // 2 phút — cảnh báo
const ORDER_SLA_CRIT_MS = 5 * 60 * 1000;   // 5 phút — nghiêm trọng
let orderLivePollTimer = null;
let orderLiveOpenId = null;
let cachedDataStats = null;
let cachedCrawlQueue = null;
let lastPendingCount = 0;

// ── Router registration ─────────────────────────────────────────────────────
(function patchRouter() {
  const _navigateTo = window.navigateTo;
  window.navigateTo = function(page) {
    currentPage = page;
    document.querySelectorAll('.sidebar__link').forEach(link => {
      link.classList.toggle('active', link.dataset.page === page);
    });

    const titles = {
      dashboard: 'Dashboard',
      dispatch: 'Dispatch Console',
      shippers: 'Quản lý Tài xế',
      restaurants: 'Quản lý Quán ăn',
      orders: 'Quản lý Đơn hàng',
      customers: 'Khách hàng',
      data: 'Sức khỏe dữ liệu',
      settings: 'Cấu hình hệ thống'
    };
    const breadcrumbs = {
      dashboard: 'Tổng quan',
      dispatch: 'Dispatch',
      shippers: 'Tài xế',
      restaurants: 'Quán ăn',
      orders: 'Đơn hàng',
      customers: 'Khách hàng',
      data: 'Dữ liệu',
      settings: 'Cấu hình'
    };

    document.getElementById('header-title').textContent = titles[page] || page;
    document.getElementById('header-breadcrumb').textContent = breadcrumbs[page] || page;

    const renderers = {
      dashboard: renderDashboard,
      dispatch: renderDispatchConsole,
      shippers: renderShippers,
      restaurants: renderRestaurants,
      orders: renderOrdersEnhanced,
      customers: renderCustomersEnhanced,
      data: renderDataHealth,
      settings: renderSettingsEnhanced
    };

    stopOrderLivePoll();
    const renderer = renderers[page];
    if (renderer) renderer();
    document.getElementById('sidebar')?.classList.remove('open');
  };
})();

// ── Badge helpers ───────────────────────────────────────────────────────────
function updateOpsBadges() {
  const pending = cachedOrders.filter(o => o.status === 'PENDING').length;
  const pendingEl = document.getElementById('nav-pending-count');
  if (pendingEl) {
    pendingEl.textContent = pending;
    pendingEl.style.display = pending > 0 ? '' : 'none';
    if (pending > lastPendingCount && lastPendingCount >= 0 && pending > 0) {
      playOpsChime();
    }
  }
  lastPendingCount = pending;

  const orderEl = document.getElementById('nav-order-count');
  if (orderEl) orderEl.textContent = String(pending || cachedOrders.length);

  const approval = cachedShippers.filter(s => s.isApproved === false).length;
  const approvalEl = document.getElementById('nav-approval-count');
  if (approvalEl) {
    approvalEl.textContent = approval;
    approvalEl.style.display = approval > 0 ? '' : 'none';
  }

  const unread = (cachedNotifications || []).filter(n => n.read !== true).length;
  const notifEl = document.getElementById('nav-notif-count');
  if (notifEl) {
    notifEl.textContent = unread;
    notifEl.style.display = unread > 0 ? '' : 'none';
  }
}

function playOpsChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = 880;
    g.gain.value = 0.04;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    setTimeout(() => { o.stop(); ctx.close(); }, 180);
  } catch (e) { /* ignore */ }
}

// Hook polling to refresh dispatch + badges
(function patchPolling() {
  const _fetchAllData = window.fetchAllData;
  window.fetchAllData = async function() {
    await _fetchAllData();
    updateOpsBadges();
    if (currentPage === 'dispatch') renderDispatchBoard();
    if (currentPage === 'dashboard') renderDispatchMini();
  };
})();

function formatWait(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}p ${rem}s` : `${rem}s`;
}

function slaClass(waitMs) {
  if (waitMs >= ORDER_SLA_CRIT_MS) return 'sla--crit';
  if (waitMs >= ORDER_SLA_WARN_MS) return 'sla--warn';
  return 'sla--ok';
}

// ── DISPATCH CONSOLE ────────────────────────────────────────────────────────
function renderDispatchConsole() {
  const body = document.getElementById('main-body');
  const online = cachedShippers.filter(s => s.status === 'ONLINE');
  body.innerHTML = `
    <div class="page-section-header">
      <h2><i class="fa-solid fa-tower-broadcast" style="color:var(--emerald-500);margin-right:8px;"></i>Dispatch Console</h2>
      <div class="page-section-header__actions">
        <button class="btn btn--secondary btn--sm" onclick="fetchAllData()"><i class="fa-solid fa-arrows-rotate"></i> Làm mới</button>
      </div>
    </div>
    <p class="text-sm text-muted mb-4" style="margin-top:-8px;">
      Bảng điều khiển vận hành — ưu tiên đơn PENDING theo thời gian chờ (SLA 2′ / 5′). Gán nhanh tài xế ONLINE.
    </p>
    <div class="stats-grid mb-6" id="dispatch-kpis"></div>
    <div class="grid-2 mb-6" style="gap:20px;">
      <div class="data-table-wrapper">
        <div class="data-table-header">
          <h3>Hàng đợi PENDING</h3>
          <span class="count" id="dispatch-pending-count">0</span>
        </div>
        <div id="dispatch-board"></div>
      </div>
      <div class="data-table-wrapper">
        <div class="data-table-header">
          <h3>Tài xế sẵn sàng</h3>
          <span class="count">${online.length}</span>
        </div>
        <div id="dispatch-shippers"></div>
      </div>
    </div>
  `;
  renderDispatchBoard();
}

function renderDispatchMini() {
  // Inject / refresh mini dispatch strip on dashboard if container exists
  let strip = document.getElementById('dispatch-mini');
  if (!strip) {
    const stats = document.getElementById('dashboard-stats');
    if (!stats) return;
    strip = document.createElement('div');
    strip.id = 'dispatch-mini';
    strip.className = 'data-table-wrapper mb-6';
    stats.insertAdjacentElement('afterend', strip);
  }
  const pending = cachedOrders
    .filter(o => o.status === 'PENDING')
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const online = cachedShippers.filter(s => s.status === 'ONLINE');
  strip.innerHTML = `
    <div class="data-table-header" style="display:flex;justify-content:space-between;align-items:center;">
      <h3 style="display:flex;align-items:center;gap:8px;">
        <i class="fa-solid fa-tower-broadcast" style="color:var(--emerald-500);"></i>
        Dispatch nhanh
        <span class="badge ${pending.length ? 'badge--pending' : 'badge--delivered'}" style="margin-left:6px;">
          ${pending.length} chờ
        </span>
      </h3>
      <button class="btn btn--ghost btn--sm" onclick="navigateTo('dispatch')">Mở console →</button>
    </div>
    <div style="padding:8px 12px;">
      ${pending.length === 0
        ? `<div class="empty-state" style="padding:16px;"><p class="text-muted text-sm">Không có đơn PENDING</p></div>`
        : pending.slice(0, 4).map(o => {
            const wait = Date.now() - (o.createdAt || Date.now());
            return `
              <div class="dispatch-row ${slaClass(wait)}" onclick="showOrderDetail('${escapeHtml(o.id)}')" style="cursor:pointer;">
                <div>
                  <div class="mono text-sm fw-700">${escapeHtml(o.id)}</div>
                  <div class="text-xs text-muted truncate" style="max-width:220px;">${escapeHtml(o.restaurantName || '—')}</div>
                </div>
                <div class="text-right">
                  <div class="sla-timer">${formatWait(wait)}</div>
                  <div class="mono text-xs">${formatCurrency(o.appTotal)}</div>
                </div>
                <button class="btn btn--primary btn--sm" onclick="event.stopPropagation();quickAssignPrompt('${escapeHtml(o.id)}')">Gán</button>
              </div>`;
          }).join('')}
      <div class="text-xs text-muted" style="margin-top:8px;">${online.length} tài xế ONLINE · ${cachedShippers.filter(s => s.isApproved === false).length} chờ duyệt</div>
    </div>
  `;
}

function renderDispatchBoard() {
  const board = document.getElementById('dispatch-board');
  const shippersEl = document.getElementById('dispatch-shippers');
  const kpis = document.getElementById('dispatch-kpis');
  if (!board) return;

  const pending = cachedOrders
    .filter(o => o.status === 'PENDING')
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const online = cachedShippers.filter(s => s.status === 'ONLINE' && s.isApproved !== false);
  const busyPhones = new Set(
    cachedOrders
      .filter(o => !['DELIVERED', 'CANCELLED', 'PENDING'].includes(o.status) && o.shipperPhone)
      .map(o => (o.shipperPhone || '').replace(/\s+/g, ''))
  );
  const free = online.filter(s => !busyPhones.has((s.phone || '').replace(/\s+/g, '')));
  const crit = pending.filter(o => Date.now() - (o.createdAt || 0) >= ORDER_SLA_CRIT_MS).length;

  const countEl = document.getElementById('dispatch-pending-count');
  if (countEl) countEl.textContent = pending.length;

  if (kpis) {
    kpis.innerHTML = `
      <div class="card-shell stat-card"><div class="card-core">
        <div class="stat-card__label">PENDING</div>
        <div class="stat-card__value mono" style="color:${pending.length ? 'var(--amber)' : 'var(--text-primary)'}">${pending.length}</div>
      </div></div>
      <div class="card-shell stat-card"><div class="card-core">
        <div class="stat-card__label">SLA vượt 5′</div>
        <div class="stat-card__value mono" style="color:${crit ? '#ef4444' : 'var(--text-primary)'}">${crit}</div>
      </div></div>
      <div class="card-shell stat-card"><div class="card-core">
        <div class="stat-card__label">Shipper rảnh</div>
        <div class="stat-card__value mono">${free.length}<span style="font-size:14px;color:var(--text-muted)">/${online.length}</span></div>
      </div></div>
      <div class="card-shell stat-card"><div class="card-core">
        <div class="stat-card__label">Đang giao</div>
        <div class="stat-card__value mono">${busyPhones.size}</div>
      </div></div>
    `;
  }

  if (pending.length === 0) {
    board.innerHTML = `<div class="empty-state" style="padding:32px;"><p class="text-muted text-sm">Hàng đợi trống — hệ thống ổn định</p></div>`;
  } else {
    const opts = free.map(s => `<option value="${escapeHtml(s.phone)}">${escapeHtml(s.name)} (${escapeHtml(s.phone)})</option>`).join('');
    board.innerHTML = pending.map(o => {
      const wait = Date.now() - (o.createdAt || Date.now());
      return `
        <div class="dispatch-row ${slaClass(wait)}">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;gap:8px;align-items:center;">
              <span class="mono text-sm fw-700" style="cursor:pointer;" onclick="showOrderDetail('${escapeHtml(o.id)}')">${escapeHtml(o.id)}</span>
              <span class="sla-timer">${formatWait(wait)}</span>
            </div>
            <div class="text-xs text-muted truncate">${escapeHtml(o.restaurantName || '—')} → ${escapeHtml(o.deliveryName || '—')}</div>
            <div class="mono text-xs text-accent">${formatCurrency(o.appTotal)}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-shrink:0;">
            <select class="form-input" id="dq-${escapeHtml(o.id)}" style="max-width:160px;padding:4px 8px;font-size:11px;">
              ${opts || '<option value="">Không có shipper rảnh</option>'}
            </select>
            <button class="btn btn--primary btn--sm" ${free.length ? '' : 'disabled'}
              onclick="quickAssignFromSelect('${escapeHtml(o.id)}')">Gán</button>
          </div>
        </div>`;
    }).join('');
  }

  if (shippersEl) {
    if (online.length === 0) {
      shippersEl.innerHTML = `<div class="empty-state" style="padding:24px;"><p class="text-muted text-sm">Không có tài xế ONLINE</p></div>`;
    } else {
      shippersEl.innerHTML = `<table class="data-table"><tbody>${online.map(s => {
        const busy = busyPhones.has((s.phone || '').replace(/\s+/g, ''));
        return `<tr>
          <td><strong class="text-sm">${escapeHtml(s.name)}</strong><br><span class="mono text-xs text-muted">${escapeHtml(s.phone)}</span></td>
          <td><span class="badge ${busy ? 'badge--pending' : 'badge--online'}"><span class="badge__dot"></span> ${busy ? 'Đang giao' : 'Rảnh'}</span></td>
        </tr>`;
      }).join('')}</tbody></table>`;
    }
  }
}

async function quickAssignFromSelect(orderId) {
  const sel = document.getElementById(`dq-${orderId}`);
  if (!sel || !sel.value) {
    showToast('Chọn tài xế rảnh', 'warning');
    return;
  }
  try {
    const res = await apiFetch(`/api/admin/orders/${orderId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ shipperPhone: sel.value })
    });
    if (res.success) {
      showToast('Đã gán đơn thành công', 'success');
      await fetchAllData();
    } else {
      showToast(res.error || 'Lỗi gán đơn', 'error');
    }
  } catch (e) {
    showToast(e.message || 'Lỗi kết nối', 'error');
  }
}

async function quickAssignPrompt(orderId) {
  const free = cachedShippers.filter(s => s.status === 'ONLINE' && s.isApproved !== false);
  if (!free.length) {
    showToast('Không có tài xế ONLINE', 'warning');
    return;
  }
  const phone = free[0].phone;
  try {
    const res = await apiFetch(`/api/admin/orders/${orderId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ shipperPhone: phone })
    });
    if (res.success) {
      showToast(`Đã gán cho ${free[0].name}`, 'success');
      await fetchAllData();
    } else showToast(res.error || 'Lỗi', 'error');
  } catch (e) {
    showToast(e.message || 'Lỗi', 'error');
  }
}

window.renderDispatchConsole = renderDispatchConsole;
window.quickAssignFromSelect = quickAssignFromSelect;
window.quickAssignPrompt = quickAssignPrompt;

// Patch dashboard to include mini dispatch after stats render
(function patchDashboard() {
  const _renderDashboardStats = window.renderDashboardStats;
  window.renderDashboardStats = function() {
    _renderDashboardStats();
    renderDispatchMini();
    updateOpsBadges();
  };
})();

// ── DATA HEALTH ─────────────────────────────────────────────────────────────
async function renderDataHealth() {
  const body = document.getElementById('main-body');
  body.innerHTML = `
    <div class="page-section-header">
      <h2><i class="fa-solid fa-database" style="color:var(--blue);margin-right:8px;"></i>Sức khỏe dữ liệu</h2>
      <div class="page-section-header__actions">
        <button class="btn btn--secondary btn--sm" onclick="loadDataHealth(true)"><i class="fa-solid fa-arrows-rotate"></i> Làm mới</button>
        <button class="btn btn--primary btn--sm" onclick="triggerSupabaseSync()"><i class="fa-solid fa-cloud-arrow-up"></i> Sync Supabase</button>
      </div>
    </div>
    <div class="stats-grid mb-6" id="data-stats-grid">${renderStatSkeleton(6)}</div>
    <div class="tabs mb-4" id="crawl-tabs">
      <button class="tab active" onclick="showCrawlTab(this,'needMenu')">Cần menu</button>
      <button class="tab" onclick="showCrawlTab(this,'tempClosed')">Tạm đóng</button>
      <button class="tab" onclick="showCrawlTab(this,'permClosed')">Đóng vĩnh viễn</button>
    </div>
    <div class="data-table-wrapper">
      <div class="data-table-header"><h3 id="crawl-tab-title">Hàng đợi crawl</h3><span class="count" id="crawl-tab-count">0</span></div>
      <div id="crawl-queue-body"><div class="empty-state" style="padding:24px;"><p class="text-muted text-sm">Đang tải...</p></div></div>
    </div>
  `;
  await loadDataHealth();
}

async function loadDataHealth(force) {
  if (!localStorage.getItem('shipfee_jwt')) {
    showToast('Cần đăng nhập Supabase Admin để xem data health', 'warning');
    return;
  }
  try {
    const [statsRes, crawlRes] = await Promise.all([
      apiFetch('/api/admin/data-stats'),
      apiFetch('/api/admin/crawl-queue')
    ]);
    if (statsRes.success) cachedDataStats = statsRes.stats;
    if (crawlRes.success) cachedCrawlQueue = crawlRes;
    renderDataStatsGrid();
    showCrawlTab(document.querySelector('#crawl-tabs .tab.active') || null, window.__crawlTab || 'needMenu');
    if (force) showToast('Đã làm mới dữ liệu', 'info');
  } catch (e) {
    showToast(e.message || 'Lỗi tải data health', 'error');
  }
}

function renderDataStatsGrid() {
  const el = document.getElementById('data-stats-grid');
  if (!el || !cachedDataStats) return;
  const s = cachedDataStats;
  const summary = cachedCrawlQueue?.summary || {};
  el.innerHTML = `
    <div class="card-shell stat-card"><div class="card-core">
      <div class="stat-card__label">Tổng quán</div>
      <div class="stat-card__value mono">${s.totalRestaurants ?? summary.total ?? 0}</div>
    </div></div>
    <div class="card-shell stat-card"><div class="card-core">
      <div class="stat-card__label">Đang mở</div>
      <div class="stat-card__value mono">${s.activeRestaurants ?? summary.active ?? 0}</div>
    </div></div>
    <div class="card-shell stat-card"><div class="card-core">
      <div class="stat-card__label">Đóng cửa</div>
      <div class="stat-card__value mono">${s.closedRestaurants ?? 0} <span class="text-xs text-muted">${s.closedPercent || ''}</span></div>
    </div></div>
    <div class="card-shell stat-card"><div class="card-core">
      <div class="stat-card__label">Menu thật</div>
      <div class="stat-card__value mono" style="color:var(--emerald-500)">${s.withRealMenu ?? summary.hasRealMenu ?? 0}</div>
    </div></div>
    <div class="card-shell stat-card"><div class="card-core">
      <div class="stat-card__label">Cần crawl menu</div>
      <div class="stat-card__value mono" style="color:var(--amber)">${summary.needRealMenu ?? s.withFallbackMenu ?? 0}</div>
    </div></div>
    <div class="card-shell stat-card"><div class="card-core">
      <div class="stat-card__label">Độ phủ menu</div>
      <div class="stat-card__value mono">${s.menuCoverage || '—'}</div>
    </div></div>
  `;
}

function showCrawlTab(btn, tab) {
  window.__crawlTab = tab;
  if (btn?.parentElement) {
    btn.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
  }
  const body = document.getElementById('crawl-queue-body');
  const title = document.getElementById('crawl-tab-title');
  const count = document.getElementById('crawl-tab-count');
  if (!body || !cachedCrawlQueue) return;

  const map = {
    needMenu: { list: cachedCrawlQueue.needMenu || [], title: 'Quán cần menu thật', action: 'sync' },
    tempClosed: { list: cachedCrawlQueue.tempClosed || [], title: 'Tạm đóng — cần kiểm tra', action: 'open' },
    permClosed: { list: cachedCrawlQueue.permClosed || [], title: 'Đóng vĩnh viễn', action: null }
  };
  const cfg = map[tab] || map.needMenu;
  if (title) title.textContent = cfg.title;
  if (count) count.textContent = cfg.list.length;

  if (!cfg.list.length) {
    body.innerHTML = `<div class="empty-state" style="padding:32px;"><p class="text-muted text-sm">Không có mục nào</p></div>`;
    return;
  }
  body.innerHTML = `<table class="data-table">
    <thead><tr><th>Quán</th><th>Chi tiết</th><th style="text-align:right;">Thao tác</th></tr></thead>
    <tbody>${cfg.list.map(r => `
      <tr>
        <td><strong class="text-sm">${escapeHtml(r.name)}</strong><br><span class="mono text-xs text-muted">${escapeHtml(r.id)}</span></td>
        <td class="text-xs text-muted">${escapeHtml(r.reason || (r.dishCount != null ? `${r.dishCount} món mẫu` : '') || '—')}</td>
        <td style="text-align:right;">
          <button class="btn btn--ghost btn--sm" onclick="viewRestaurantMenu('${escapeHtml(r.id)}')" title="Menu"><i class="fa-solid fa-utensils"></i></button>
          ${cfg.action === 'sync' ? `<button class="btn btn--ghost btn--sm" onclick="syncRestaurantPrice('${escapeHtml(r.id)}')" title="Sync giá"><i class="fa-solid fa-arrows-rotate"></i></button>` : ''}
          ${cfg.action === 'open' ? `<button class="btn btn--ghost btn--sm" onclick="toggleRestaurantStatus('${escapeHtml(r.id)}', false)" title="Mở lại"><i class="fa-solid fa-lock-open"></i></button>` : ''}
          <button class="btn btn--ghost btn--sm" onclick="openEditRestaurantModal('${escapeHtml(r.id)}')" title="Sửa"><i class="fa-solid fa-pen"></i></button>
        </td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

async function triggerSupabaseSync() {
  try {
    const res = await apiFetch('/api/admin/db/sync-to-supabase', { method: 'POST' });
    showToast(res.message || 'Đã bắt đầu sync Supabase nền', 'success');
  } catch (e) {
    showToast(e.message || 'Lỗi sync', 'error');
  }
}

window.renderDataHealth = renderDataHealth;
window.loadDataHealth = loadDataHealth;
window.showCrawlTab = showCrawlTab;
window.triggerSupabaseSync = triggerSupabaseSync;

// ── ORDERS: export + date filter ─────────────────────────────────────────────
function renderOrdersEnhanced() {
  renderOrders();
  const header = document.querySelector('.page-section-header');
  if (header && !document.getElementById('orders-export-btn')) {
    let actions = header.querySelector('.page-section-header__actions');
    if (!actions) {
      actions = document.createElement('div');
      actions.className = 'page-section-header__actions';
      header.appendChild(actions);
    }
    actions.innerHTML = `
      <input type="date" id="orders-export-from" class="form-input" style="width:auto;padding:6px 10px;font-size:12px;">
      <input type="date" id="orders-export-to" class="form-input" style="width:auto;padding:6px 10px;font-size:12px;">
      <button class="btn btn--secondary btn--sm" id="orders-export-btn" onclick="exportOrdersCsv()">
        <i class="fa-solid fa-file-csv"></i> Xuất CSV
      </button>
      <button class="btn btn--ghost btn--sm" onclick="navigateTo('dispatch')">
        <i class="fa-solid fa-tower-broadcast"></i> Dispatch
      </button>
    `;
  }
}

function exportOrdersCsv() {
  const fromEl = document.getElementById('orders-export-from');
  const toEl = document.getElementById('orders-export-to');
  let list = [...cachedOrders];
  if (fromEl?.value) {
    const from = new Date(fromEl.value); from.setHours(0, 0, 0, 0);
    list = list.filter(o => (o.createdAt || 0) >= from.getTime());
  }
  if (toEl?.value) {
    const to = new Date(toEl.value); to.setHours(23, 59, 59, 999);
    list = list.filter(o => (o.createdAt || 0) <= to.getTime());
  }

  const cols = ['id', 'status', 'restaurantName', 'deliveryName', 'deliveryPhone', 'shipperName', 'shipperPhone', 'appTotal', 'storeTotal', 'shipperEarning', 'createdAt', 'acceptedAt', 'deliveredAt', 'cancelReason'];
  const rows = [cols.join(',')];
  list.forEach(o => {
    rows.push(cols.map(c => {
      let v = o[c];
      if (c.endsWith('At') && v) v = new Date(v).toISOString();
      if (typeof v === 'string') return `"${v.replace(/"/g, '""')}"`;
      return v == null ? '' : v;
    }).join(','));
  });

  const blob = new Blob(['\uFEFF' + rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `shipfee-orders-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast(`Đã xuất ${list.length} đơn`, 'success');
}

window.exportOrdersCsv = exportOrdersCsv;

// ── LIVE ORDER POLL + CALL BADGE ────────────────────────────────────────────
function stopOrderLivePoll() {
  if (orderLivePollTimer) {
    clearInterval(orderLivePollTimer);
    orderLivePollTimer = null;
  }
  orderLiveOpenId = null;
}

const _showOrderDetail = window.showOrderDetail;
window.showOrderDetail = async function(orderId) {
  await _showOrderDetail(orderId);
  orderLiveOpenId = orderId;
  stopOrderLivePoll();
  orderLiveOpenId = orderId;

  // Call badge
  injectCallBadge(orderId);

  orderLivePollTimer = setInterval(async () => {
    if (orderLiveOpenId !== orderId) return;
    const overlay = document.getElementById('order-modal');
    if (!overlay || !overlay.classList.contains('active')) {
      stopOrderLivePoll();
      return;
    }
    try {
      const res = await apiFetch(`/api/admin/orders/${orderId}/live`);
      if (!res.success || !res.data) return;
      const o = res.data;
      const gpsEl = document.getElementById('order-live-gps');
      if (gpsEl && typeof o.shipperLat === 'number') {
        gpsEl.textContent = `GPS: ${o.shipperLat.toFixed(5)}, ${o.shipperLon.toFixed(5)}`;
      }
      const callEl = document.getElementById('order-call-badge');
      if (callEl) {
        callEl.innerHTML = o.call
          ? `<span class="badge badge--accepted"><span class="badge__dot"></span> Call: ${escapeHtml(o.call.status || 'active')}</span>`
          : `<span class="text-xs text-muted">Không có cuộc gọi</span>`;
      }
      if (typeof o.shipperLat === 'number' && orderLiveMap && typeof L !== 'undefined') {
        // soft refresh map marker via re-init light
      }
      const msgBox = document.getElementById('order-live-messages');
      if (msgBox && Array.isArray(o.messages)) {
        msgBox.innerHTML = o.messages.length
          ? o.messages.map(m => `
              <div style="padding:6px 0;border-bottom:1px solid var(--border);">
                <div class="text-xs text-muted">${escapeHtml(m.sender || m.role || '—')} · ${formatTime(m.createdAt || m.timestamp)}</div>
                <div class="text-sm">${escapeHtml(m.text || m.message || '')}</div>
              </div>`).join('')
          : `<div class="text-xs text-muted">Chưa có tin nhắn</div>`;
      }
    } catch (e) { /* silent */ }
  }, 4000);
};

function injectCallBadge(orderId) {
  const body = document.getElementById('order-modal-body');
  if (!body || document.getElementById('order-call-badge')) return;
  const banner = document.createElement('div');
  banner.id = 'order-live-banner';
  banner.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding:8px 12px;background:rgba(16,185,129,0.06);border-radius:8px;border:1px solid rgba(16,185,129,0.15);';
  banner.innerHTML = `
    <span class="text-xs" style="color:var(--emerald-500);"><i class="fa-solid fa-satellite-dish"></i> Live monitor (4s)</span>
    <span id="order-call-badge"><span class="text-xs text-muted">Đang kiểm tra cuộc gọi...</span></span>
  `;
  body.prepend(banner);

  // Mark chat container for live updates
  const chatHeaders = body.querySelectorAll('h4');
  chatHeaders.forEach(h => {
    if (h.textContent.trim() === 'Chat' && !document.getElementById('order-live-messages')) {
      const next = h.nextElementSibling;
      if (next) next.id = 'order-live-messages';
    }
  });
}

const _closeModal = window.closeModal;
window.closeModal = function(id) {
  if (id === 'order-modal') stopOrderLivePoll();
  _closeModal(id);
};

// ── SHIPPER: pending approval tab ───────────────────────────────────────────
(function patchShippers() {
  const _renderShippers = window.renderShippers;
  window.renderShippers = function() {
    _renderShippers();
    const tabs = document.querySelector('#main-body .tabs');
    if (tabs && !tabs.querySelector('[data-shipper-tab="pending"]')) {
      const btn = document.createElement('button');
      btn.className = 'tab';
      btn.dataset.shipperTab = 'pending';
      btn.textContent = 'Chờ duyệt';
      btn.onclick = function() { filterShippers(this, 'PENDING_APPROVAL'); };
      tabs.appendChild(btn);
    }
    updateOpsBadges();
  };

  const _renderShippersTable = window.renderShippersTable;
  window.renderShippersTable = function() {
    // Temporarily filter pending approval via shipperFilter
    if (typeof shipperFilter !== 'undefined' && shipperFilter === 'PENDING_APPROVAL') {
      const tbody = document.getElementById('shippers-tbody');
      const countEl = document.getElementById('shipper-table-count');
      if (!tbody) return;
      const query = (document.getElementById('shipper-search')?.value || '').toLowerCase();
      let filtered = cachedShippers.filter(s => s.isApproved === false);
      if (query) {
        filtered = filtered.filter(s =>
          (s.name || '').toLowerCase().includes(query) ||
          (s.phone || '').toLowerCase().includes(query)
        );
      }
      if (countEl) countEl.textContent = filtered.length;
      if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state" style="padding:32px;"><p class="text-muted text-sm">Không có tài xế chờ duyệt</p></div></td></tr>`;
        return;
      }
      tbody.innerHTML = filtered.map(s => `
        <tr>
          <td><strong class="text-sm">${escapeHtml(s.name || '—')}</strong></td>
          <td class="mono text-sm">${escapeHtml(s.phone || '')}</td>
          <td><span class="badge badge--pending"><span class="badge__dot"></span> Chờ duyệt</span></td>
          <td class="text-muted text-xs">—</td>
          <td class="text-muted text-xs">—</td>
          <td class="text-muted text-xs">—</td>
          <td class="text-muted text-xs">—</td>
          <td style="text-align:right;">
            <button class="btn btn--primary btn--sm" onclick="approveShipper('${escapeHtml(s.phone)}')"><i class="fa-solid fa-check"></i> Duyệt</button>
            <button class="btn btn--ghost btn--sm" onclick="editShipper('${escapeHtml(s.phone)}')"><i class="fa-solid fa-pen"></i></button>
          </td>
        </tr>
      `).join('');
      return;
    }
    _renderShippersTable();
  };
})();

// ── CUSTOMER 360 ────────────────────────────────────────────────────────────
function renderCustomersEnhanced() {
  renderCustomers();
}

const _filterCustomersTable = window.filterCustomersTable;
window.filterCustomersTable = function() {
  _filterCustomersTable();
  // Make rows clickable for 360
  document.querySelectorAll('#customers-table-body tbody tr').forEach((tr, i) => {
    const q = (document.getElementById('customer-search')?.value || '').toLowerCase().trim();
    let list = cachedCustomers || [];
    if (q) {
      list = list.filter(c =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.phone || '').toLowerCase().includes(q) ||
        (c.address || '').toLowerCase().includes(q)
      );
    }
    const c = list[i];
    if (!c) return;
    tr.style.cursor = 'pointer';
    tr.onclick = () => showCustomer360(c.phone);
  });
};

function showCustomer360(phone) {
  const clean = (phone || '').replace(/\s+/g, '');
  const orders = cachedOrders.filter(o =>
    (o.deliveryPhone || '').replace(/\s+/g, '') === clean ||
    (o.ordererPhone || '').replace(/\s+/g, '') === clean
  ).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const c = (cachedCustomers || []).find(x => (x.phone || '').replace(/\s+/g, '') === clean) || {
    name: orders[0]?.deliveryName || '—',
    phone,
    address: orders[0]?.deliveryAddress || '',
    totalSpent: orders.reduce((s, o) => s + (o.appTotal || 0), 0),
    ordersCount: orders.length
  };

  const modal = document.getElementById('customer-modal');
  if (!modal) return;
  document.getElementById('customer-modal-title').textContent = `Khách: ${c.name || phone}`;
  document.getElementById('customer-modal-body').innerHTML = `
    <div class="card mb-4" style="padding:16px;">
      <div class="text-sm fw-700">${escapeHtml(c.name || '—')}</div>
      <div class="mono text-sm">${escapeHtml(c.phone || '')}</div>
      <div class="text-xs text-muted">${escapeHtml(c.address || '')}</div>
      <div style="display:flex;gap:16px;margin-top:12px;">
        <div><div class="text-xs text-muted">Số đơn</div><div class="mono fw-700">${c.ordersCount || orders.length}</div></div>
        <div><div class="text-xs text-muted">Chi tiêu</div><div class="mono fw-700 text-accent">${formatCurrency(c.totalSpent || 0)}</div></div>
      </div>
    </div>
    <h4 class="mb-2">Lịch sử đơn (${orders.length})</h4>
    ${orders.length === 0 ? `<div class="text-xs text-muted">Chưa có đơn</div>` :
      `<table class="data-table"><thead><tr><th>Mã</th><th>Quán</th><th>Trạng thái</th><th>Tiền</th><th>Thời gian</th></tr></thead>
      <tbody>${orders.slice(0, 30).map(o => `
        <tr style="cursor:pointer;" onclick="closeModal('customer-modal');showOrderDetail('${escapeHtml(o.id)}')">
          <td class="mono text-sm">${escapeHtml(o.id)}</td>
          <td class="text-xs truncate" style="max-width:140px;">${escapeHtml(o.restaurantName || '—')}</td>
          <td><span class="badge ${statusBadgeClass(o.status)}"><span class="badge__dot"></span> ${statusLabel(o.status)}</span></td>
          <td class="mono text-sm">${formatCurrency(o.appTotal)}</td>
          <td class="text-xs text-muted">${formatTime(o.createdAt)}</td>
        </tr>`).join('')}
      </tbody></table>`}
  `;
  openModal('customer-modal');
}

window.showCustomer360 = showCustomer360;

// ── RESTAURANT METADATA EDITOR ──────────────────────────────────────────────
async function openEditRestaurantModal(restaurantId) {
  let r = cachedRestaurants.find(x => String(x.id) === String(restaurantId));
  if (!r) {
    try {
      const res = await fetch(`${API_BASE}/api/restaurants/${restaurantId}`).then(x => x.json());
      r = res?.data || res;
    } catch (e) {
      showToast('Không tải được quán', 'error');
      return;
    }
  }
  document.getElementById('restaurant-edit-title').textContent = `Sửa: ${r.name || restaurantId}`;
  document.getElementById('rest-edit-id').value = r.id;
  document.getElementById('rest-edit-name').value = r.name || '';
  document.getElementById('rest-edit-address').value = r.address || '';
  document.getElementById('rest-edit-category').value = r.category || '';
  document.getElementById('rest-edit-closed').checked = !!r.isClosed;
  openModal('restaurant-edit-modal');
}

async function saveRestaurantMeta() {
  const id = document.getElementById('rest-edit-id').value;
  const payload = {
    name: document.getElementById('rest-edit-name').value.trim(),
    address: document.getElementById('rest-edit-address').value.trim(),
    category: document.getElementById('rest-edit-category').value.trim(),
    isClosed: document.getElementById('rest-edit-closed').checked
  };
  try {
    const res = await apiFetch(`/api/admin/restaurants/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    if (res.success) {
      showToast('Đã cập nhật quán', 'success');
      closeModal('restaurant-edit-modal');
      if (typeof loadRestaurants === 'function') loadRestaurants();
      if (currentPage === 'data') loadDataHealth(true);
    } else {
      showToast(res.error || 'Lỗi lưu', 'error');
    }
  } catch (e) {
    showToast(e.message || 'Lỗi', 'error');
  }
}

window.openEditRestaurantModal = openEditRestaurantModal;
window.saveRestaurantMeta = saveRestaurantMeta;

// Patch restaurant row actions to include edit
(function patchRestaurantRows() {
  const _filterRestaurantsLocal = window.filterRestaurantsLocal;
  if (!_filterRestaurantsLocal) return;
  // Add edit button via CSS/event delegation instead of rewriting whole table
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-edit-restaurant]');
    if (btn) {
      e.preventDefault();
      openEditRestaurantModal(btn.getAttribute('data-edit-restaurant'));
    }
  });
})();

// Enhance restaurant table after local filter — inject edit icon
(function patchRestaurantFilter() {
  const _filter = window.filterRestaurantsLocal;
  if (typeof _filter !== 'function') return;
  window.filterRestaurantsLocal = function() {
    _filter();
    document.querySelectorAll('#restaurants-tbody tr').forEach(tr => {
      const menuBtn = tr.querySelector('button[onclick*="viewRestaurantMenu"]');
      if (!menuBtn || tr.querySelector('[data-edit-restaurant]')) return;
      const m = (menuBtn.getAttribute('onclick') || '').match(/viewRestaurantMenu\('([^']+)'\)/);
      if (!m) return;
      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn--ghost btn--sm';
      editBtn.title = 'Sửa thông tin quán';
      editBtn.setAttribute('data-edit-restaurant', m[1]);
      editBtn.innerHTML = '<i class="fa-solid fa-pen"></i>';
      menuBtn.parentElement.insertBefore(editBtn, menuBtn);
    });
  };
})();

// ── SETTINGS: sync supabase button ──────────────────────────────────────────
function renderSettingsEnhanced() {
  renderSettings();
  const maint = document.querySelector('#main-body .card:nth-of-type(4)') || 
    [...document.querySelectorAll('#main-body .card')].find(c => c.textContent.includes('Bảo trì'));
  if (maint && !document.getElementById('btn-sync-supabase')) {
    const btn = document.createElement('button');
    btn.id = 'btn-sync-supabase';
    btn.className = 'btn btn--secondary btn--sm mb-4';
    btn.style.display = 'block';
    btn.style.marginTop = '8px';
    btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i> Đồng bộ DB → Supabase';
    btn.onclick = triggerSupabaseSync;
    const firstBtn = maint.querySelector('button');
    if (firstBtn) firstBtn.insertAdjacentElement('afterend', btn);
    else maint.appendChild(btn);
  }
}

// Escape / keyboard for modals
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach(el => closeModal(el.id));
  }
});

// Init badges after first poll
setTimeout(updateOpsBadges, 1500);

console.log('[CRM Upgrade] Ops console, data health, export, live monitor loaded');
