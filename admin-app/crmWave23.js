'use strict';

function getAdminRole() {
  return adminUser?.role || 'admin';
}

function canMutate() {
  return getAdminRole() === 'admin' || getAdminRole() === 'ops';
}

function canEditPricing() {
  return getAdminRole() === 'admin';
}

// ── ANALYTICS ───────────────────────────────────────────────────────────────
async function renderAnalytics() {
  const body = document.getElementById('main-body');
  body.innerHTML = `
    <div class="page-section-header">
      <h2>Analytics</h2>
      <div class="page-section-header__actions">
        <div class="tabs" style="margin:0;">
          <button class="tab active" data-range="7d" onclick="switchAnalyticsRange(this,'7d')">7 ngày</button>
          <button class="tab" data-range="30d" onclick="switchAnalyticsRange(this,'30d')">30 ngày</button>
          <button class="tab" data-range="90d" onclick="switchAnalyticsRange(this,'90d')">90 ngày</button>
        </div>
        <button class="btn btn--secondary btn--sm" onclick="exportShipperPayouts()">
          <i class="fa-solid fa-file-csv"></i> Export payout shipper
        </button>
      </div>
    </div>
    <div id="analytics-body"><div class="empty-state" style="padding:32px;">Đang tải...</div></div>`;
  await loadAnalytics(window.__analyticsRange || '7d');
}

async function loadAnalytics(range) {
  window.__analyticsRange = range;
  const el = document.getElementById('analytics-body');
  if (!el) return;
  try {
    const res = await apiFetch(`/api/admin/analytics?range=${range}`);
    if (!res.success) throw new Error(res.error);
    const d = res.data;
    el.innerHTML = `
      <div class="stats-grid mb-6">
        <div class="card-shell stat-card"><div class="card-core">
          <div class="stat-card__label">Tổng đơn</div>
          <div class="stat-card__value mono">${d.totalOrders}</div>
          <div class="stat-card__change ${d.wow.orders >= 0 ? 'up' : ''}">WoW ${d.wow.orders >= 0 ? '+' : ''}${d.wow.orders}%</div>
        </div></div>
        <div class="card-shell stat-card"><div class="card-core">
          <div class="stat-card__label">Hoàn thành</div>
          <div class="stat-card__value mono">${d.completedOrders}</div>
          <div class="stat-card__change">Tỷ lệ ${d.completionRate}%</div>
        </div></div>
        <div class="card-shell stat-card"><div class="card-core">
          <div class="stat-card__label">Doanh thu</div>
          <div class="stat-card__value mono" style="font-size:22px;color:var(--emerald-500);">${formatCurrency(d.totalRevenue)}</div>
          <div class="stat-card__change">WoW ${d.wow.revenue >= 0 ? '+' : ''}${d.wow.revenue}%</div>
        </div></div>
        <div class="card-shell stat-card"><div class="card-core">
          <div class="stat-card__label">AOV</div>
          <div class="stat-card__value mono">${formatCurrency(d.aov)}</div>
          <div class="stat-card__change">${d.cancelledOrders} đơn hủy</div>
        </div></div>
      </div>
      <div class="grid-2 mb-6" style="gap:20px;">
        <div class="data-table-wrapper">
          <div class="data-table-header"><h3>Top quán ăn</h3></div>
          <table class="data-table"><thead><tr><th>Quán</th><th>Đơn</th><th>Doanh thu</th></tr></thead>
          <tbody>${(d.topRestaurants || []).map(r => `
            <tr><td class="text-sm">${escapeHtml(r.name)}</td><td class="mono">${r.orders}</td><td class="mono">${formatCurrency(r.revenue)}</td></tr>`).join('') || '<tr><td colspan="3" class="text-muted text-sm">Không có dữ liệu</td></tr>'}
          </tbody></table>
        </div>
        <div class="data-table-wrapper">
          <div class="data-table-header"><h3>Hiệu suất shipper</h3></div>
          <table class="data-table"><thead><tr><th>Tài xế</th><th>AR/CR</th><th>Thu nhập</th></tr></thead>
          <tbody>${(d.shipperStats || []).slice(0, 10).map(s => `
            <tr><td class="text-sm">${escapeHtml(s.name)}<br><span class="mono text-xs text-muted">${escapeHtml(s.phone)}</span></td>
            <td class="mono text-xs">${s.acceptanceRate}% / ${s.completionRate}%</td>
            <td class="mono text-sm">${formatCurrency(s.totalEarnings)}</td></tr>`).join('') || '<tr><td colspan="3" class="text-muted text-sm">Không có dữ liệu</td></tr>'}
          </tbody></table>
        </div>
      </div>
      <div class="data-table-wrapper">
        <div class="data-table-header"><h3>Doanh thu theo ngày</h3></div>
        <table class="data-table"><thead><tr><th>Ngày</th><th>Đơn</th><th>Doanh thu</th></tr></thead>
        <tbody>${(d.daily || []).map(day => `
          <tr><td class="mono text-sm">${day.date}</td><td class="mono">${day.orders}</td><td class="mono">${formatCurrency(day.revenue)}</td></tr>`).join('')}
        </tbody></table>
      </div>`;
  } catch (e) {
    el.innerHTML = `<div class="empty-state"><p class="text-muted">${escapeHtml(e.message)}</p></div>`;
  }
}

function switchAnalyticsRange(btn, range) {
  btn.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  loadAnalytics(range);
}

async function exportShipperPayouts() {
  try {
    const res = await fetch(`${API_BASE}/api/admin/shippers/export`);
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'shipfee-shipper-payouts.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('Đã tải CSV payout', 'success');
  } catch (e) {
    showToast('Lỗi export', 'error');
  }
}

// ── SUPPORT / DISPUTES ──────────────────────────────────────────────────────
async function renderSupport() {
  const body = document.getElementById('main-body');
  body.innerHTML = `
    <div class="page-section-header">
      <h2>Hỗ trợ & Khiếu nại</h2>
      ${canMutate() ? `<div class="page-section-header__actions">
        <button class="btn btn--primary btn--sm" onclick="openCreateDisputePrompt()"><i class="fa-solid fa-plus"></i> Tạo ticket</button>
      </div>` : ''}
    </div>
    <div class="tabs mb-4">
      <button class="tab active" onclick="filterDisputes(this,'all')">Tất cả</button>
      <button class="tab" onclick="filterDisputes(this,'open')">Đang mở</button>
      <button class="tab" onclick="filterDisputes(this,'resolved')">Đã xử lý</button>
    </div>
    <div id="disputes-body"><div class="empty-state" style="padding:24px;">Đang tải...</div></div>`;
  window.__disputeFilter = 'all';
  await loadDisputes();
}

async function loadDisputes() {
  const el = document.getElementById('disputes-body');
  if (!el) return;
  try {
    const res = await apiFetch('/api/admin/disputes');
    let list = res.data || [];
    const f = window.__disputeFilter;
    if (f && f !== 'all') list = list.filter(d => d.status === f);
    if (!list.length) {
      el.innerHTML = `<div class="empty-state" style="padding:32px;"><p class="text-muted">Chưa có ticket</p></div>`;
      return;
    }
    el.innerHTML = list.map(d => `
      <div class="card mb-4" style="padding:16px;">
        <div class="flex justify-between items-center mb-2">
          <div><span class="mono fw-700">${escapeHtml(d.id)}</span> · Đơn <span class="mono">${escapeHtml(d.orderId)}</span></div>
          <span class="badge ${d.status === 'open' ? 'badge--pending' : 'badge--online'}">${d.status === 'open' ? 'Mở' : 'Đã xử lý'}</span>
        </div>
        <p class="text-sm text-muted mb-2">${escapeHtml(d.reason || '')}</p>
        <div style="max-height:120px;overflow-y:auto;margin-bottom:8px;">
          ${(d.messages || []).map(m => `<div class="text-xs" style="padding:4px 0;border-bottom:1px solid var(--border);"><strong>${escapeHtml(m.sender || m.role)}</strong>: ${escapeHtml(m.text)}</div>`).join('') || '<span class="text-xs text-muted">Chưa có phản hồi</span>'}
        </div>
        ${canMutate() && d.status === 'open' ? `
          <div class="flex gap-2" style="margin-top:8px;">
            <input type="text" class="form-input" id="dispute-reply-${escapeHtml(d.id)}" placeholder="Trả lời khách..." style="flex:1;">
            <button class="btn btn--primary btn--sm" onclick="replyDispute('${escapeHtml(d.id)}')">Gửi</button>
            <button class="btn btn--secondary btn--sm" onclick="resolveDispute('${escapeHtml(d.id)}')">Đóng</button>
            <button class="btn btn--ghost btn--sm" onclick="showOrderDetail('${escapeHtml(d.orderId)}')">Xem đơn</button>
          </div>` : ''}
      </div>`).join('');
  } catch (e) {
    el.innerHTML = `<div class="empty-state"><p class="text-muted">${escapeHtml(e.message)}</p></div>`;
  }
}

function filterDisputes(btn, status) {
  window.__disputeFilter = status;
  btn.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  loadDisputes();
}

async function openCreateDisputePrompt() {
  const orderId = prompt('Mã đơn hàng:', '');
  if (!orderId) return;
  const reason = prompt('Lý do khiếu nại:', 'Khách phản ánh') || 'Khách phản ánh';
  try {
    const res = await apiFetch('/api/admin/disputes', { method: 'POST', body: JSON.stringify({ orderId, reason }) });
    if (res.success) { showToast('Đã tạo ticket', 'success'); loadDisputes(); }
    else showToast(res.error || 'Lỗi', 'error');
  } catch (e) { showToast('Lỗi kết nối', 'error'); }
}

async function replyDispute(id) {
  const input = document.getElementById(`dispute-reply-${id}`);
  const text = input?.value?.trim();
  if (!text) return;
  try {
    const res = await apiFetch(`/api/admin/disputes/${id}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
    if (res.success) { input.value = ''; showToast('Đã gửi', 'success'); loadDisputes(); }
  } catch (e) { showToast('Lỗi', 'error'); }
}

async function resolveDispute(id) {
  try {
    const res = await apiFetch(`/api/admin/disputes/${id}/resolve`, { method: 'POST' });
    if (res.success) { showToast('Đã đóng ticket', 'success'); loadDisputes(); }
  } catch (e) { showToast('Lỗi', 'error'); }
}

// ── GROWTH SETTINGS (Promos, Zones, Settlement, Audit) ─────────────────────
async function loadGrowthSettingsPanels() {
  if (currentPage !== 'settings') return;
  await Promise.all([loadPromosPanel(), loadZonesPanel(), loadSettlementPanel(), loadAuditPanel(), loadBlacklistPanel()]);
}

async function loadPromosPanel() {
  const el = document.getElementById('promos-panel-body');
  if (!el) return;
  try {
    const res = await apiFetch('/api/admin/promos');
    const list = res.data || [];
    el.innerHTML = `
      ${canMutate() ? `<div class="flex gap-2 mb-4" style="flex-wrap:wrap;">
        <input class="form-input" id="new-promo-code" placeholder="Mã (SHIPFEE10)" style="width:140px;">
        <select class="form-input" id="new-promo-type" style="width:auto;"><option value="percent">%</option><option value="fixed">Cố định</option><option value="free_ship">Free ship</option></select>
        <input class="form-input" id="new-promo-value" type="number" placeholder="Giá trị" style="width:100px;">
        <button class="btn btn--primary btn--sm" onclick="createPromo()">Thêm</button>
      </div>` : ''}
      <table class="data-table"><thead><tr><th>Mã</th><th>Loại</th><th>Giá trị</th><th>Đã dùng</th><th>Trạng thái</th></tr></thead>
      <tbody>${list.map(p => `
        <tr><td class="mono">${escapeHtml(p.code)}</td><td>${p.type}</td><td class="mono">${p.value}</td><td>${p.usedCount || 0}${p.maxUses ? '/' + p.maxUses : ''}</td>
        <td>${p.active !== false ? 'Active' : 'Off'}</td></tr>`).join('') || '<tr><td colspan="5" class="text-muted">Chưa có mã</td></tr>'}
      </tbody></table>`;
  } catch (e) {
    el.innerHTML = `<p class="text-muted text-sm">${escapeHtml(e.message)}</p>`;
  }
}

async function createPromo() {
  const code = document.getElementById('new-promo-code')?.value;
  const type = document.getElementById('new-promo-type')?.value;
  const value = Number(document.getElementById('new-promo-value')?.value);
  try {
    const res = await apiFetch('/api/admin/promos', { method: 'POST', body: JSON.stringify({ code, type, value }) });
    if (res.success) { showToast('Đã tạo mã', 'success'); loadPromosPanel(); }
    else showToast(res.error, 'error');
  } catch (e) { showToast('Lỗi', 'error'); }
}

async function loadZonesPanel() {
  const el = document.getElementById('zones-panel-body');
  if (!el) return;
  try {
    const res = await apiFetch('/api/admin/delivery-zones');
    const list = res.data || [];
    el.innerHTML = `
      ${canMutate() ? `<div class="flex gap-2 mb-4" style="flex-wrap:wrap;">
        <input class="form-input" id="new-zone-name" placeholder="Tên khu" style="width:120px;">
        <input class="form-input" id="new-zone-lat" type="number" step="0.0001" placeholder="Lat" style="width:110px;">
        <input class="form-input" id="new-zone-lon" type="number" step="0.0001" placeholder="Lon" style="width:110px;">
        <input class="form-input" id="new-zone-radius" type="number" placeholder="Km" value="3" style="width:70px;">
        <button class="btn btn--primary btn--sm" onclick="createZone()">Thêm zone</button>
      </div>` : ''}
      <table class="data-table"><thead><tr><th>Khu</th><th>Tọa độ</th><th>Bán kính</th><th></th></tr></thead>
      <tbody>${list.map(z => `
        <tr><td>${escapeHtml(z.name)}</td><td class="mono text-xs">${z.centerLat}, ${z.centerLon}</td><td>${z.radiusKm} km</td>
        <td>${canMutate() ? `<button class="btn btn--danger btn--sm" onclick="deleteZone('${escapeHtml(z.id)}')"><i class="fa-solid fa-trash"></i></button>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="text-muted">Chưa cấu hình zone (mặc định phục vụ toàn khu vực)</td></tr>'}
      </tbody></table>`;
  } catch (e) {
    el.innerHTML = `<p class="text-muted text-sm">${escapeHtml(e.message)}</p>`;
  }
}

async function createZone() {
  const name = document.getElementById('new-zone-name')?.value;
  const centerLat = parseFloat(document.getElementById('new-zone-lat')?.value);
  const centerLon = parseFloat(document.getElementById('new-zone-lon')?.value);
  const radiusKm = parseFloat(document.getElementById('new-zone-radius')?.value) || 3;
  try {
    const res = await apiFetch('/api/admin/delivery-zones', { method: 'POST', body: JSON.stringify({ name, centerLat, centerLon, radiusKm }) });
    if (res.success) { showToast('Đã thêm zone', 'success'); loadZonesPanel(); }
    else showToast(res.error, 'error');
  } catch (e) { showToast('Lỗi', 'error'); }
}

async function deleteZone(id) {
  if (!confirm('Xóa zone này?')) return;
  try {
    await apiFetch(`/api/admin/delivery-zones/${id}`, { method: 'DELETE' });
    showToast('Đã xóa', 'success');
    loadZonesPanel();
  } catch (e) { showToast('Lỗi', 'error'); }
}

async function loadSettlementPanel() {
  const el = document.getElementById('settlement-panel-body');
  if (!el) return;
  try {
    const res = await apiFetch('/api/admin/settlements/report');
    const d = res.data || {};
    el.innerHTML = `
      <p class="text-sm text-muted mb-4">Tổng GMV: <strong class="mono">${formatCurrency(d.totalGmv || 0)}</strong></p>
      <table class="data-table"><thead><tr><th>Quán</th><th>Đơn</th><th>GMV</th><th>Hoa hồng</th><th>Platform net</th></tr></thead>
      <tbody>${(d.restaurants || []).slice(0, 15).map(r => `
        <tr><td class="text-sm">${escapeHtml(r.restaurantName)}</td><td class="mono">${r.orders}</td><td class="mono">${formatCurrency(r.gmv)}</td>
        <td class="mono">${formatCurrency(r.commissionAmount)} (${Math.round(r.commissionRate * 100)}%)</td><td class="mono">${formatCurrency(r.platformNet)}</td></tr>`).join('') || '<tr><td colspan="5" class="text-muted">Chưa có đơn hoàn thành</td></tr>'}
      </tbody></table>`;
  } catch (e) {
    el.innerHTML = `<p class="text-muted text-sm">${escapeHtml(e.message)}</p>`;
  }
}

async function loadAuditPanel() {
  const el = document.getElementById('audit-panel-body');
  if (!el) return;
  try {
    const res = await apiFetch('/api/admin/audit-log?limit=50');
    const list = res.data || [];
    el.innerHTML = `
      <table class="data-table"><thead><tr><th>Thời gian</th><th>Admin</th><th>Hành động</th><th>Chi tiết</th></tr></thead>
      <tbody>${list.map(a => `
        <tr><td class="text-xs text-muted">${formatTime(a.at)}</td><td class="text-xs">${escapeHtml(a.adminEmail)}</td>
        <td class="mono text-xs">${escapeHtml(a.action)}</td><td class="text-xs text-muted">${escapeHtml(JSON.stringify(a.details || {}))}</td></tr>`).join('') || '<tr><td colspan="4" class="text-muted">Chưa có log</td></tr>'}
      </tbody></table>`;
  } catch (e) {
    el.innerHTML = `<p class="text-muted text-sm">${escapeHtml(e.message)}</p>`;
  }
}

async function loadBlacklistPanel() {
  const el = document.getElementById('blacklist-panel-body');
  if (!el) return;
  try {
    const res = await apiFetch('/api/admin/blacklist');
    const list = res.data || [];
    el.innerHTML = `
      ${canMutate() ? `<div class="flex gap-2 mb-4">
        <input class="form-input" id="new-blacklist-phone" placeholder="SĐT" style="width:140px;">
        <input class="form-input" id="new-blacklist-reason" placeholder="Lý do" style="flex:1;">
        <button class="btn btn--danger btn--sm" onclick="addBlacklist()">Chặn</button>
      </div>` : ''}
      <table class="data-table"><thead><tr><th>SĐT</th><th>Lý do</th><th>Bởi</th><th></th></tr></thead>
      <tbody>${list.map(b => `
        <tr><td class="mono">${escapeHtml(b.phone)}</td><td class="text-sm">${escapeHtml(b.reason)}</td><td class="text-xs text-muted">${escapeHtml(b.blacklistedBy || '')}</td>
        <td>${canMutate() ? `<button class="btn btn--ghost btn--sm" onclick="removeBlacklist('${escapeHtml(b.phone)}')">Gỡ</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="text-muted">Danh sách trống</td></tr>'}
      </tbody></table>`;
  } catch (e) {
    el.innerHTML = `<p class="text-muted text-sm">${escapeHtml(e.message)}</p>`;
  }
}

async function addBlacklist() {
  const phone = document.getElementById('new-blacklist-phone')?.value;
  const reason = document.getElementById('new-blacklist-reason')?.value;
  try {
    const res = await apiFetch('/api/admin/blacklist', { method: 'POST', body: JSON.stringify({ phone, reason }) });
    if (res.success) { showToast('Đã chặn SĐT', 'success'); loadBlacklistPanel(); }
    else showToast(res.error, 'error');
  } catch (e) { showToast('Lỗi', 'error'); }
}

async function removeBlacklist(phone) {
  try {
    await apiFetch(`/api/admin/blacklist/${encodeURIComponent(phone)}`, { method: 'DELETE' });
    showToast('Đã gỡ chặn', 'success');
    loadBlacklistPanel();
  } catch (e) { showToast('Lỗi', 'error'); }
}

async function blacklistCustomerFromModal(phone) {
  const reason = prompt('Lý do chặn khách:', 'Vi phạm chính sách') || 'Vi phạm chính sách';
  try {
    const res = await apiFetch('/api/admin/blacklist', { method: 'POST', body: JSON.stringify({ phone, reason }) });
    if (res.success) showToast('Đã chặn khách', 'success');
    else showToast(res.error, 'error');
  } catch (e) { showToast('Lỗi', 'error'); }
}

async function sendAdminOrderMessage(orderId) {
  const input = document.getElementById('admin-order-reply');
  const text = input?.value?.trim();
  if (!text) return;
  try {
    const res = await apiFetch(`/api/admin/orders/${orderId}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
    if (res.success) {
      input.value = '';
      showToast('Đã gửi tin nhắn', 'success');
      showOrderDetail(orderId);
    }
  } catch (e) { showToast('Lỗi gửi', 'error'); }
}

// Patch renderSettings to add growth panels
const _origRenderSettings = renderSettings;
renderSettings = function() {
  _origRenderSettings();
  setTimeout(() => {
    const grid = document.querySelector('#main-body .grid-2');
    if (!grid) return;
    const extra = document.createElement('div');
    extra.className = 'grid-2';
    extra.style.gap = '20px';
    extra.style.marginTop = '20px';
    extra.innerHTML = `
      <div class="card"><h3 class="mb-4"><i class="fa-solid fa-ticket" style="color:var(--violet);margin-right:8px;"></i>Mã giảm giá</h3><div id="promos-panel-body"><p class="text-muted text-sm">Đang tải...</p></div></div>
      <div class="card"><h3 class="mb-4"><i class="fa-solid fa-map" style="color:var(--blue);margin-right:8px;"></i>Khu giao hàng</h3><div id="zones-panel-body"><p class="text-muted text-sm">Đang tải...</p></div></div>
      <div class="card"><h3 class="mb-4"><i class="fa-solid fa-hand-holding-dollar" style="color:var(--emerald-500);margin-right:8px;"></i>Settlement quán</h3><div id="settlement-panel-body"><p class="text-muted text-sm">Đang tải...</p></div></div>
      <div class="card"><h3 class="mb-4"><i class="fa-solid fa-list-check" style="color:var(--amber);margin-right:8px;"></i>Audit log</h3><div id="audit-panel-body"><p class="text-muted text-sm">Đang tải...</p></div></div>
      <div class="card" style="grid-column:1/-1;"><h3 class="mb-4"><i class="fa-solid fa-ban" style="color:#ef4444;margin-right:8px;"></i>Blacklist khách hàng</h3><div id="blacklist-panel-body"><p class="text-muted text-sm">Đang tải...</p></div></div>`;
    document.getElementById('main-body').appendChild(extra);
    loadGrowthSettingsPanels();
  }, 50);
};

// Patch navigateTo
const _origNavigateTo = navigateTo;
navigateTo = function(page) {
  currentPage = page;
  document.querySelectorAll('.sidebar__link').forEach(link => {
    link.classList.toggle('active', link.dataset.page === page);
  });
  const titles = {
    dashboard: 'Dashboard', shippers: 'Quản lý Tài xế', restaurants: 'Quản lý Quán ăn',
    orders: 'Quản lý Đơn hàng', fleet: 'Fleet Map', customers: 'Khách hàng',
    analytics: 'Analytics', support: 'Hỗ trợ & Khiếu nại', settings: 'Cấu hình hệ thống'
  };
  const breadcrumbs = {
    dashboard: 'Tổng quan', shippers: 'Tài xế', restaurants: 'Quán ăn', orders: 'Đơn hàng',
    fleet: 'Fleet Map', customers: 'Khách hàng', analytics: 'Analytics', support: 'Hỗ trợ', settings: 'Cấu hình'
  };
  document.getElementById('header-title').textContent = titles[page] || page;
  document.getElementById('header-breadcrumb').textContent = breadcrumbs[page] || page;
  const renderers = {
    dashboard: renderDashboard, shippers: renderShippers, restaurants: renderRestaurants,
    orders: renderOrders, fleet: renderFleet, customers: renderCustomers,
    analytics: renderAnalytics, support: renderSupport, settings: renderSettings
  };
  const renderer = renderers[page];
  if (renderer) renderer();
  document.getElementById('sidebar').classList.remove('open');
};

// Patch showCustomerDetail for blacklist button
const _origShowCustomerDetail = showCustomerDetail;
showCustomerDetail = function(phone) {
  _origShowCustomerDetail(phone);
  if (!canMutate()) return;
  const body = document.getElementById('customer-modal-body');
  if (body) {
    body.innerHTML += `<div style="margin-top:12px;"><button class="btn btn--danger btn--sm" onclick="blacklistCustomerFromModal('${escapeHtml(phone)}')"><i class="fa-solid fa-ban"></i> Chặn khách</button></div>`;
  }
};

// Patch order modal chat with admin reply
const _origShowOrderDetail = showOrderDetail;
showOrderDetail = async function(orderId) {
  await _origShowOrderDetail(orderId);
  if (!canMutate()) return;
  const chatSection = document.querySelector('#order-modal-body [data-live-chat]')?.parentElement;
  if (chatSection) {
    chatSection.insertAdjacentHTML('beforeend', `
      <div class="flex gap-2 mt-2" style="margin-top:8px;">
        <input type="text" class="form-input" id="admin-order-reply" placeholder="Admin trả lời..." style="flex:1;">
        <button class="btn btn--primary btn--sm" onclick="sendAdminOrderMessage('${escapeHtml(orderId)}')">Gửi</button>
      </div>`);
  }
};

// Patch login role detection
const _origHandleAdminLogin = handleAdminLogin;
handleAdminLogin = async function() {
  const email = document.getElementById('admin-email').value.trim();
  const password = document.getElementById('admin-password').value.trim();
  if (!email || !password) { showToast('Vui lòng nhập đầy đủ email và mật khẩu', 'warning'); return; }
  if (supabaseClient) {
    try {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) { showToast('Đăng nhập thất bại: ' + error.message, 'error'); return; }
      const user = data.user;
      let role = null;
      if (user.email === 'admin@shipfee.vn' || user.user_metadata?.role === 'admin') role = 'admin';
      else if (user.user_metadata?.role === 'ops') role = 'ops';
      else if (user.user_metadata?.role === 'viewer') role = 'viewer';
      if (!role) { showToast('Bạn không có quyền CRM!', 'error'); await supabaseClient.auth.signOut(); return; }
      localStorage.setItem('shipfee_jwt', data.session.access_token);
      adminUser = { email: user.email, name: user.user_metadata?.full_name || role, role };
      localStorage.setItem('shipfee_admin', JSON.stringify(adminUser));
      const roleEl = document.querySelector('.sidebar__user-role');
      if (roleEl) roleEl.textContent = role === 'admin' ? 'Quản trị viên' : (role === 'ops' ? 'Vận hành' : 'Xem only');
      showToast('Đăng nhập thành công (' + role + ')', 'success');
      showApp();
    } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
  } else {
    _origHandleAdminLogin();
  }
};

window.renderAnalytics = renderAnalytics;
window.renderSupport = renderSupport;
window.switchAnalyticsRange = switchAnalyticsRange;
window.exportShipperPayouts = exportShipperPayouts;
window.loadDisputes = loadDisputes;
window.filterDisputes = filterDisputes;
window.openCreateDisputePrompt = openCreateDisputePrompt;
window.replyDispute = replyDispute;
window.resolveDispute = resolveDispute;
window.createPromo = createPromo;
window.createZone = createZone;
window.deleteZone = deleteZone;
window.addBlacklist = addBlacklist;
window.removeBlacklist = removeBlacklist;
window.blacklistCustomerFromModal = blacklistCustomerFromModal;
window.sendAdminOrderMessage = sendAdminOrderMessage;
