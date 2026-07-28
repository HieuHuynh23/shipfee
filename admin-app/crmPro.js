'use strict';
/**
 * ShipFee CRM Pro — shell UX, reports, bulk actions, customer CRM, settings tabs.
 * Loaded after app.js + crmWave23.js
 */

(function initCrmPro() {
  window.__crmPro = { density: localStorage.getItem('shipfee_crm_density') || 'comfortable' };
  window.__ordersExtra = window.__ordersExtra || { shipperPhone: '', restaurantId: '', minTotal: '', slaOnly: false };
  window.__shippersPage = { page: 1, limit: 50, total: 0, q: '', status: 'all', sort: 'name', selected: new Set() };
  window.__customersPage = { page: 1, limit: 50, total: 0, q: '', segment: '', sort: 'spent' };
  window.__analyticsTab = 'sales';
  window.__settingsTab = 'pricing';
  window.__orderSelected = new Set();
  window.__restSelected = new Set();

  // ── Role sync from server (app_metadata) ─────────────────────────────────
  async function syncAdminRole() {
    const res = await apiFetch('/api/admin/me');
    if (!res?.success || !res.data?.role) {
      throw new Error('Không có quyền CRM');
    }
    adminUser = adminUser || {};
    adminUser.role = res.data.role;
    adminUser.email = res.data.email || adminUser.email;
    adminUser.canMutate = !!res.data.canMutate;
    adminUser.canEditPricing = !!res.data.canEditPricing;
    localStorage.setItem('shipfee_admin', JSON.stringify(adminUser));
    applyRoleUi();
  }
  window.syncAdminRole = syncAdminRole;

  function applyRoleUi() {
    const role = adminUser?.role || 'viewer';
    const roleEl = document.querySelector('.sidebar__user-role');
    if (roleEl) {
      roleEl.textContent = role === 'admin' ? 'Quản trị viên' : (role === 'ops' ? 'Vận hành' : 'Chỉ xem');
      roleEl.className = 'sidebar__user-role role-badge role-badge--' + role;
    }
    document.body.classList.toggle('crm-viewer', role === 'viewer');
    document.body.classList.toggle('crm-ops', role === 'ops');
    document.body.classList.toggle('crm-admin', role === 'admin');
  }

  // ── Density ──────────────────────────────────────────────────────────────
  function applyDensity(mode) {
    window.__crmPro.density = mode;
    localStorage.setItem('shipfee_crm_density', mode);
    document.body.classList.toggle('density-compact', mode === 'compact');
    const btn = document.getElementById('density-toggle');
    if (btn) btn.title = mode === 'compact' ? 'Density: Compact' : 'Density: Comfortable';
  }
  window.toggleCrmDensity = function () {
    applyDensity(window.__crmPro.density === 'compact' ? 'comfortable' : 'compact');
  };

  // ── History routing ──────────────────────────────────────────────────────
  function pushPageState(page, replace) {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('page', page);
      if (replace) history.replaceState({ page }, '', url);
      else history.pushState({ page }, '', url);
    } catch (e) { /* ignore */ }
  }

  const _navFromWave = navigateTo;
  navigateTo = function (page) {
    _navFromWave(page);
    pushPageState(page, false);
    applyRoleUi();
    hideCommandPalette();
  };

  window.addEventListener('popstate', (e) => {
    const page = e.state?.page || new URLSearchParams(location.search).get('page') || 'dashboard';
    _navFromWave(page);
  });

  // ── Command palette ──────────────────────────────────────────────────────
  function ensureCommandPalette() {
    if (document.getElementById('cmd-palette')) return;
    const el = document.createElement('div');
    el.id = 'cmd-palette';
    el.className = 'cmd-palette hidden';
    el.innerHTML = `
      <div class="cmd-palette__backdrop" onclick="hideCommandPalette()"></div>
      <div class="cmd-palette__panel card-shell">
        <div class="card-core">
          <div class="cmd-palette__input-wrap">
            <i class="fa-solid fa-magnifying-glass"></i>
            <input id="cmd-palette-input" class="form-input" placeholder="Nhảy tới trang, đơn, quán, tài xế, khách… (Ctrl+K)" autocomplete="off">
          </div>
          <div id="cmd-palette-results" class="cmd-palette__results"></div>
          <div class="cmd-palette__hint text-xs text-muted">↑↓ chọn · Enter mở · Esc đóng</div>
        </div>
      </div>`;
    document.body.appendChild(el);
  }

  function showCommandPalette() {
    ensureCommandPalette();
    const el = document.getElementById('cmd-palette');
    el.classList.remove('hidden');
    const input = document.getElementById('cmd-palette-input');
    input.value = '';
    renderCmdResults('');
    setTimeout(() => input.focus(), 30);
  }
  window.showCommandPalette = showCommandPalette;
  window.hideCommandPalette = function () {
    document.getElementById('cmd-palette')?.classList.add('hidden');
  };

  function renderCmdResults(q) {
    const box = document.getElementById('cmd-palette-results');
    if (!box) return;
    const ql = (q || '').toLowerCase().trim();
    const pages = [
      { type: 'page', id: 'dashboard', label: 'Dashboard', icon: 'fa-grid-2' },
      { type: 'page', id: 'analytics', label: 'Reports / Analytics', icon: 'fa-chart-line' },
      { type: 'page', id: 'orders', label: 'Đơn hàng', icon: 'fa-receipt' },
      { type: 'page', id: 'shippers', label: 'Tài xế', icon: 'fa-motorcycle' },
      { type: 'page', id: 'restaurants', label: 'Quán ăn', icon: 'fa-store' },
      { type: 'page', id: 'customers', label: 'Khách hàng', icon: 'fa-users' },
      { type: 'page', id: 'fleet', label: 'Fleet Map', icon: 'fa-map-location-dot' },
      { type: 'page', id: 'support', label: 'Hỗ trợ', icon: 'fa-headset' },
      { type: 'page', id: 'settings', label: 'Cấu hình', icon: 'fa-sliders' }
    ].filter(p => !ql || p.label.toLowerCase().includes(ql) || p.id.includes(ql));

    const orders = (cachedOrders || []).filter(o =>
      !ql || (o.id || '').toLowerCase().includes(ql) || (o.restaurantName || '').toLowerCase().includes(ql)
    ).slice(0, 5).map(o => ({ type: 'order', id: o.id, label: `${o.id} · ${o.restaurantName || ''}`, icon: 'fa-receipt' }));

    const shippers = (cachedShippers || []).filter(s =>
      !ql || (s.name || '').toLowerCase().includes(ql) || (s.phone || '').includes(ql)
    ).slice(0, 5).map(s => ({ type: 'shipper', id: s.phone, label: `${s.name} · ${s.phone}`, icon: 'fa-motorcycle' }));

    const customers = (cachedCustomers || []).filter(c =>
      !ql || (c.name || '').toLowerCase().includes(ql) || (c.phone || '').includes(ql)
    ).slice(0, 5).map(c => ({ type: 'customer', id: c.phone, label: `${c.name} · ${c.phone}`, icon: 'fa-user' }));

    const items = [...pages, ...orders, ...shippers, ...customers].slice(0, 20);
    window.__cmdItems = items;
    window.__cmdIndex = 0;
    box.innerHTML = items.length ? items.map((it, i) => `
      <button type="button" class="cmd-palette__item ${i === 0 ? 'active' : ''}" data-idx="${i}" onclick="runCmdItem(${i})">
        <i class="fa-solid ${it.icon}"></i>
        <span>${escapeHtml(it.label)}</span>
        <span class="text-xs text-muted">${it.type}</span>
      </button>`).join('') : `<div class="empty-state" style="padding:20px;">Không có kết quả</div>`;
  }

  window.runCmdItem = function (idx) {
    const it = (window.__cmdItems || [])[idx];
    if (!it) return;
    hideCommandPalette();
    if (it.type === 'page') navigateTo(it.id);
    else if (it.type === 'order') { navigateTo('orders'); setTimeout(() => showOrderDetail(it.id), 200); }
    else if (it.type === 'shipper') { navigateTo('shippers'); setTimeout(() => editShipper(it.id), 200); }
    else if (it.type === 'customer') { navigateTo('customers'); setTimeout(() => showCustomerDetailPro(it.id), 200); }
  };

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      const open = !document.getElementById('cmd-palette')?.classList.contains('hidden');
      if (open) hideCommandPalette(); else showCommandPalette();
      return;
    }
    const palette = document.getElementById('cmd-palette');
    if (!palette || palette.classList.contains('hidden')) return;
    if (e.key === 'Escape') hideCommandPalette();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      window.__cmdIndex = Math.min((window.__cmdItems || []).length - 1, (window.__cmdIndex || 0) + 1);
      highlightCmd();
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      window.__cmdIndex = Math.max(0, (window.__cmdIndex || 0) - 1);
      highlightCmd();
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      runCmdItem(window.__cmdIndex || 0);
    }
  });

  function highlightCmd() {
    document.querySelectorAll('.cmd-palette__item').forEach((el, i) => {
      el.classList.toggle('active', i === window.__cmdIndex);
    });
  }

  document.addEventListener('input', (e) => {
    if (e.target?.id === 'cmd-palette-input') renderCmdResults(e.target.value);
  });

  // ── Enhanced Analytics / Reports ─────────────────────────────────────────
  async function renderAnalyticsPro() {
    const body = document.getElementById('main-body');
    const range = window.__analyticsRange || '7d';
    body.innerHTML = `
      <div class="page-section-header">
        <h2>Reports</h2>
        <div class="page-section-header__actions" style="flex-wrap:wrap;gap:8px;">
          <div class="tabs" style="margin:0;">
            <button class="tab ${range === '7d' ? 'active' : ''}" onclick="switchAnalyticsRangePro(this,'7d')">7 ngày</button>
            <button class="tab ${range === '30d' ? 'active' : ''}" onclick="switchAnalyticsRangePro(this,'30d')">30 ngày</button>
            <button class="tab ${range === '90d' ? 'active' : ''}" onclick="switchAnalyticsRangePro(this,'90d')">90 ngày</button>
            <button class="tab ${range === 'custom' ? 'active' : ''}" onclick="switchAnalyticsRangePro(this,'custom')">Tuỳ chọn</button>
          </div>
          <input type="date" class="form-input" id="ana-from" style="width:auto;" value="${window.__anaFrom || ''}">
          <input type="date" class="form-input" id="ana-to" style="width:auto;" value="${window.__anaTo || ''}">
          <button class="btn btn--secondary btn--sm" onclick="exportAnalyticsCsv()"><i class="fa-solid fa-file-csv"></i> Export</button>
        </div>
      </div>
      <div class="tabs mb-4">
        <button class="tab ${window.__analyticsTab === 'sales' ? 'active' : ''}" onclick="switchAnalyticsTab(this,'sales')">Sales</button>
        <button class="tab ${window.__analyticsTab === 'ops' ? 'active' : ''}" onclick="switchAnalyticsTab(this,'ops')">Operations</button>
        <button class="tab ${window.__analyticsTab === 'financials' ? 'active' : ''}" onclick="switchAnalyticsTab(this,'financials')">Financials</button>
      </div>
      <div id="analytics-body"><div class="empty-state" style="padding:32px;">Đang tải...</div></div>`;
    await loadAnalyticsPro();
  }

  window.switchAnalyticsRangePro = function (btn, range) {
    document.querySelectorAll('.page-section-header .tab').forEach(t => t.classList.remove('active'));
    btn?.classList.add('active');
    window.__analyticsRange = range;
    if (range !== 'custom') loadAnalyticsPro();
    else loadAnalyticsPro();
  };
  window.switchAnalyticsTab = function (btn, tab) {
    window.__analyticsTab = tab;
    document.querySelectorAll('#main-body > .tabs .tab').forEach(t => t.classList.remove('active'));
    btn?.classList.add('active');
    if (window.__lastAnalytics) paintAnalytics(window.__lastAnalytics);
  };

  async function loadAnalyticsPro() {
    const el = document.getElementById('analytics-body');
    if (!el) return;
    try {
      const params = new URLSearchParams();
      const range = window.__analyticsRange || '7d';
      window.__anaFrom = document.getElementById('ana-from')?.value || window.__anaFrom || '';
      window.__anaTo = document.getElementById('ana-to')?.value || window.__anaTo || '';
      if (range === 'custom' || window.__anaFrom || window.__anaTo) {
        if (window.__anaFrom) params.set('from', window.__anaFrom);
        if (window.__anaTo) params.set('to', window.__anaTo);
        params.set('range', '7d');
      } else {
        params.set('range', range);
      }
      const res = await apiFetch(`/api/admin/analytics?${params}`);
      if (!res.success) throw new Error(res.error);
      window.__lastAnalytics = res.data;
      paintAnalytics(res.data);
    } catch (e) {
      el.innerHTML = `<div class="empty-state" style="padding:32px;color:var(--rose);">${escapeHtml(e.message)}</div>`;
    }
  }

  function paintAnalytics(d) {
    const el = document.getElementById('analytics-body');
    if (!el || !d) return;
    const tab = window.__analyticsTab || 'sales';
    const kpi = `
      <div class="stats-grid mb-6">
        <div class="card-shell stat-card"><div class="card-core">
          <div class="stat-card__label">Tổng đơn</div>
          <div class="stat-card__value mono">${d.totalOrders}</div>
          <div class="stat-card__change">WoW ${d.wow?.orders >= 0 ? '+' : ''}${d.wow?.orders || 0}%</div>
        </div></div>
        <div class="card-shell stat-card"><div class="card-core">
          <div class="stat-card__label">Hoàn thành</div>
          <div class="stat-card__value mono">${d.completedOrders}</div>
          <div class="stat-card__change">Tỷ lệ ${d.completionRate}%</div>
        </div></div>
        <div class="card-shell stat-card"><div class="card-core">
          <div class="stat-card__label">Doanh thu (GMV)</div>
          <div class="stat-card__value mono" style="font-size:20px;color:var(--emerald-500);">${formatCurrency(d.totalRevenue)}</div>
          <div class="stat-card__change">AOV ${formatCurrency(d.aov)}</div>
        </div></div>
        <div class="card-shell stat-card"><div class="card-core">
          <div class="stat-card__label">Shipper earnings</div>
          <div class="stat-card__value mono" style="font-size:20px;">${formatCurrency(d.shipperEarnings || 0)}</div>
          <div class="stat-card__change">${d.cancelledOrders || 0} đơn hủy</div>
        </div></div>
      </div>`;

    if (tab === 'ops') {
      el.innerHTML = kpi + `
        <div class="grid-2" style="gap:20px;">
          <div class="data-table-wrapper">
            <div class="data-table-header"><h3>SLA / Cancel theo ngày</h3></div>
            <table class="data-table"><thead><tr><th>Ngày</th><th>SLA breaches</th><th>Huỷ</th></tr></thead>
            <tbody>${(d.slaDaily || []).map(r => `<tr><td>${escapeHtml(r.date)}</td><td class="mono">${r.breaches}</td><td class="mono">${r.cancelled}</td></tr>`).join('') || '<tr><td colspan="3" class="text-muted">Không có dữ liệu</td></tr>'}</tbody></table>
          </div>
          <div class="data-table-wrapper">
            <div class="data-table-header"><h3>Lý do huỷ</h3></div>
            <table class="data-table"><thead><tr><th>Lý do</th><th>Số</th></tr></thead>
            <tbody>${(d.cancelReasons || []).map(r => `<tr><td>${escapeHtml(r.reason)}</td><td class="mono">${r.count}</td></tr>`).join('') || '<tr><td colspan="2" class="text-muted">—</td></tr>'}</tbody></table>
          </div>
        </div>
        <div class="card mt-4"><h3 class="mb-4">Peak hours</h3><div class="peak-heatmap">${(d.hourly || []).map(h => {
          const max = Math.max(1, ...d.hourly.map(x => x.orders));
          const pct = Math.round((h.orders / max) * 100);
          return `<div class="peak-cell" style="--p:${pct}%" title="${h.hour}h: ${h.orders} đơn"><span>${h.hour}</span></div>`;
        }).join('')}</div></div>`;
      return;
    }

    if (tab === 'financials') {
      const settles = d.settlement?.restaurants || [];
      el.innerHTML = kpi + `
        <div class="data-table-wrapper">
          <div class="data-table-header"><h3>Settlement theo quán</h3>
            <button class="btn btn--ghost btn--sm" onclick="downloadCsvUrl('/api/admin/settlements/export')">Export settlements</button>
          </div>
          <table class="data-table"><thead><tr><th>Quán</th><th>Đơn</th><th>GMV</th><th>Commission</th><th>Platform net</th></tr></thead>
          <tbody>${settles.slice(0, 30).map(r => `
            <tr><td>${escapeHtml(r.restaurantName)}</td><td class="mono">${r.orders}</td>
            <td class="mono">${formatCurrency(r.gmv)}</td><td class="mono">${formatCurrency(r.commissionAmount)}</td>
            <td class="mono text-accent">${formatCurrency(r.platformNet)}</td></tr>`).join('') || '<tr><td colspan="5" class="text-muted">Không có dữ liệu</td></tr>'}
          </tbody></table>
        </div>`;
      return;
    }

    // sales
    el.innerHTML = kpi + `
      <div class="grid-2" style="gap:20px;">
        <div class="data-table-wrapper">
          <div class="data-table-header"><h3>Doanh thu theo ngày</h3></div>
          <table class="data-table"><thead><tr><th>Ngày</th><th>Đơn</th><th>Doanh thu</th></tr></thead>
          <tbody>${(d.daily || []).map(r => `<tr><td>${escapeHtml(r.date)}</td><td class="mono">${r.orders}</td><td class="mono">${formatCurrency(r.revenue)}</td></tr>`).join('')}</tbody></table>
        </div>
        <div class="data-table-wrapper">
          <div class="data-table-header"><h3>Top quán</h3></div>
          <table class="data-table"><thead><tr><th>Quán</th><th>Đơn</th><th>Doanh thu</th></tr></thead>
          <tbody>${(d.topRestaurants || []).map(r => `<tr><td>${escapeHtml(r.name)}</td><td class="mono">${r.orders}</td><td class="mono">${formatCurrency(r.revenue)}</td></tr>`).join('')}</tbody></table>
        </div>
      </div>
      <div class="card mt-4"><h3 class="mb-4">Peak hours</h3><div class="peak-heatmap">${(d.hourly || []).map(h => {
        const max = Math.max(1, ...(d.hourly || [{ orders: 1 }]).map(x => x.orders));
        const pct = Math.round((h.orders / max) * 100);
        return `<div class="peak-cell" style="--p:${pct}%" title="${h.hour}h: ${h.orders} đơn"><span>${h.hour}</span></div>`;
      }).join('')}</div></div>`;
  }

  window.exportAnalyticsCsv = function () {
    const tab = window.__analyticsTab || 'sales';
    const params = new URLSearchParams({ tab });
    const range = window.__analyticsRange || '7d';
    if (range !== 'custom') params.set('range', range);
    if (window.__anaFrom) params.set('from', window.__anaFrom);
    if (window.__anaTo) params.set('to', window.__anaTo);
    downloadCsvUrl(`/api/admin/analytics/export?${params}`);
  };

  window.downloadCsvUrl = async function (path) {
    try {
      const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
      const token = localStorage.getItem('shipfee_jwt');
      const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error('Export thất bại');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (path.split('filename=')[1] || 'shipfee-export.csv').replace(/"/g, '') || 'export.csv';
      a.click();
      URL.revokeObjectURL(a.href);
      showToast('Đã tải CSV', 'success');
    } catch (e) {
      showToast(e.message, 'error');
    }
  };

  // ── Orders: advanced filters + bulk ──────────────────────────────────────
  const _renderOrders = renderOrders;
  renderOrders = function () {
    _renderOrders();
    const toolbar = document.querySelector('#main-body .toolbar');
    if (!toolbar || document.getElementById('order-sla-only')) return;
    const extra = document.createElement('div');
    extra.className = 'toolbar-extra';
    extra.innerHTML = `
      <input type="text" class="form-input" id="order-filter-shipper" placeholder="SĐT tài xế" style="width:140px;" value="${escapeHtml(window.__ordersExtra.shipperPhone || '')}">
      <input type="text" class="form-input" id="order-filter-rest" placeholder="ID quán" style="width:120px;" value="${escapeHtml(window.__ordersExtra.restaurantId || '')}">
      <input type="number" class="form-input" id="order-filter-min" placeholder="Min total" style="width:110px;" value="${escapeHtml(window.__ordersExtra.minTotal || '')}">
      <label class="text-sm" style="display:flex;align-items:center;gap:6px;white-space:nowrap;">
        <input type="checkbox" id="order-sla-only" ${window.__ordersExtra.slaOnly ? 'checked' : ''}> Chỉ SLA
      </label>
      <button class="btn btn--secondary btn--sm" onclick="applyOrderExtraFilters()">Lọc</button>`;
    toolbar.appendChild(extra);

    const header = document.querySelector('#main-body .page-section-header__actions');
    if (header && canMutate() && !document.getElementById('orders-bulk-bar')) {
      header.insertAdjacentHTML('beforeend', `
        <div id="orders-bulk-bar" class="bulk-bar hidden">
          <span id="orders-bulk-count">0 chọn</span>
          <button class="btn btn--danger btn--sm" onclick="bulkOrdersAction('cancel')">Huỷ</button>
          <button class="btn btn--secondary btn--sm" onclick="bulkOrdersAction('status','PURCHASED')">→ Đã mua</button>
          <button class="btn btn--secondary btn--sm" onclick="bulkOrdersAction('status','DELIVERED')">→ HT</button>
        </div>`);
    }

    // Patch table renderer once
    if (!window.__ordersTablePatched) {
      window.__ordersTablePatched = true;
      const _renderOrdersTable = renderOrdersTable;
      renderOrdersTable = function () {
        _renderOrdersTable();
        const table = document.querySelector('#orders-table-body table thead tr');
        if (table && canMutate() && !table.querySelector('.order-check-all')) {
          table.insertAdjacentHTML('afterbegin', `<th style="width:36px;"><input type="checkbox" class="order-check-all" onchange="toggleAllOrders(this.checked)"></th>`);
          document.querySelectorAll('#orders-table-body table tbody tr').forEach(tr => {
            const id = tr.querySelector('.mono')?.textContent?.trim();
            if (!id) return;
            tr.insertAdjacentHTML('afterbegin', `<td><input type="checkbox" class="order-check" data-id="${escapeHtml(id)}" onchange="toggleOrderSelect('${escapeHtml(id)}', this.checked)" ${window.__orderSelected.has(id) ? 'checked' : ''}></td>`);
          });
        }
      };
      window.renderOrdersTable = renderOrdersTable;
    }
  };

  window.applyOrderExtraFilters = function () {
    window.__ordersExtra.shipperPhone = document.getElementById('order-filter-shipper')?.value || '';
    window.__ordersExtra.restaurantId = document.getElementById('order-filter-rest')?.value || '';
    window.__ordersExtra.minTotal = document.getElementById('order-filter-min')?.value || '';
    window.__ordersExtra.slaOnly = !!document.getElementById('order-sla-only')?.checked;
    ordersPage = 1;
    loadOrdersPagePro();
  };

  const _loadOrdersPage = loadOrdersPage;
  async function loadOrdersPagePro() {
    const el = document.getElementById('orders-table-body');
    if (!el) return _loadOrdersPage();
    if (!localStorage.getItem('shipfee_jwt')) return _loadOrdersPage();

    const q = (document.getElementById('order-search')?.value || '').trim();
    ordersDateFrom = document.getElementById('order-date-from')?.value || ordersDateFrom;
    ordersDateTo = document.getElementById('order-date-to')?.value || ordersDateTo;
    el.innerHTML = `<div class="empty-state" style="padding:24px;"><p class="text-muted text-sm">Đang tải...</p></div>`;
    try {
      const params = new URLSearchParams({ page: String(ordersPage), limit: String(ordersLimit) });
      if (orderFilter !== 'all') params.set('status', orderFilter);
      if (q) params.set('q', q);
      if (ordersDateFrom) params.set('from', ordersDateFrom);
      if (ordersDateTo) params.set('to', ordersDateTo);
      const ex = window.__ordersExtra || {};
      if (ex.shipperPhone) params.set('shipperPhone', ex.shipperPhone);
      if (ex.restaurantId) params.set('restaurantId', ex.restaurantId);
      if (ex.minTotal) params.set('minTotal', ex.minTotal);
      if (ex.slaOnly) params.set('slaOnly', '1');
      const res = await apiFetch(`/api/admin/orders?${params}`);
      if (res.success) {
        cachedOrders = res.data || [];
        ordersTotal = res.total || 0;
        renderOrdersTable();
        if (typeof renderOrdersPagination === 'function') renderOrdersPagination();
        const countEl = document.getElementById('order-table-count');
        if (countEl) countEl.textContent = ordersTotal;
      }
    } catch (e) {
      el.innerHTML = `<div class="empty-state" style="padding:24px;color:var(--rose);">${escapeHtml(e.message)}</div>`;
    }
  }
  loadOrdersPage = loadOrdersPagePro;
  window.loadOrdersPage = loadOrdersPagePro;

  window.toggleOrderSelect = function (id, checked) {
    if (checked) window.__orderSelected.add(id); else window.__orderSelected.delete(id);
    const bar = document.getElementById('orders-bulk-bar');
    const count = document.getElementById('orders-bulk-count');
    if (bar) bar.classList.toggle('hidden', window.__orderSelected.size === 0);
    if (count) count.textContent = `${window.__orderSelected.size} chọn`;
  };
  window.toggleAllOrders = function (checked) {
    document.querySelectorAll('.order-check').forEach(cb => {
      cb.checked = checked;
      toggleOrderSelect(cb.dataset.id, checked);
    });
  };
  window.bulkOrdersAction = async function (action, status) {
    if (!canMutate()) return showToast('Không đủ quyền', 'error');
    const ids = [...window.__orderSelected];
    if (!ids.length) return;
    if (action === 'cancel' && !confirm(`Huỷ ${ids.length} đơn?`)) return;
    try {
      const payload = action === 'status' ? { status } : { reason: 'Admin bulk cancel' };
      const res = await apiFetch('/api/admin/orders/bulk', { method: 'POST', body: JSON.stringify({ action, ids, payload }) });
      const ok = (res.data || []).filter(r => r.ok).length;
      showToast(`Bulk: ${ok}/${ids.length} thành công`, 'success');
      window.__orderSelected.clear();
      loadOrdersPage();
    } catch (e) { showToast(e.message, 'error'); }
  };

  // Jump to orders with SLA from dashboard
  window.jumpOrdersSla = function () {
    window.__ordersExtra.slaOnly = true;
    orderFilter = 'all';
    navigateTo('orders');
  };

  // ── Shippers paginated + bulk ────────────────────────────────────────────
  const _renderShippers = renderShippers;
  renderShippers = function () {
    const body = document.getElementById('main-body');
    body.innerHTML = `
      <div class="page-section-header">
        <h2>Quản lý Tài xế</h2>
        <div class="page-section-header__actions">
          ${canMutate() ? `<button class="btn btn--primary btn--sm" onclick="openShipperModal()"><i class="fa-solid fa-plus"></i> Thêm</button>` : ''}
          <button class="btn btn--secondary btn--sm" onclick="downloadCsvUrl('/api/admin/shippers/list-export')"><i class="fa-solid fa-file-csv"></i> Export</button>
          <button class="btn btn--ghost btn--sm" onclick="exportShipperPayouts && exportShipperPayouts()"><i class="fa-solid fa-wallet"></i> Payouts</button>
          <div id="shippers-bulk-bar" class="bulk-bar hidden">
            <span id="shippers-bulk-count">0</span>
            <button class="btn btn--primary btn--sm" onclick="bulkShippers('approve')">Duyệt</button>
            <button class="btn btn--danger btn--sm" onclick="bulkShippers('reject')">Từ chối</button>
            <button class="btn btn--secondary btn--sm" onclick="bulkShippers('setOffline')">Offline</button>
          </div>
        </div>
      </div>
      <div class="toolbar">
        <div class="form-search" style="width:240px;">
          <span class="form-search__icon"><i class="fa-solid fa-magnifying-glass"></i></span>
          <input type="text" class="form-input" id="shipper-search-pro" placeholder="Tìm tài xế..." onkeyup="debounceShippersLoad()">
        </div>
        <select class="form-input" id="shipper-status-pro" style="width:auto;" onchange="loadShippersPage()">
          <option value="all">Tất cả</option><option value="online">Online</option>
          <option value="offline">Offline</option><option value="pending">Chờ duyệt</option>
        </select>
        <select class="form-input" id="shipper-sort-pro" style="width:auto;" onchange="loadShippersPage()">
          <option value="name">Tên</option><option value="earnings">Thu nhập</option>
          <option value="ar">AR</option><option value="cr">CR</option><option value="status">Status</option>
        </select>
      </div>
      <div class="data-table-wrapper">
        <div class="data-table-header"><h3>Tài xế</h3><span class="count" id="shipper-table-count">0</span></div>
        <div id="shippers-table-body"></div>
        <div class="pagination" id="shippers-pagination"></div>
      </div>`;
    loadShippersPage();
  };

  let _shipDebounce;
  window.debounceShippersLoad = function () {
    clearTimeout(_shipDebounce);
    _shipDebounce = setTimeout(() => { window.__shippersPage.page = 1; loadShippersPage(); }, 350);
  };

  window.loadShippersPage = async function () {
    const el = document.getElementById('shippers-table-body');
    if (!el) return;
    const st = window.__shippersPage;
    st.q = document.getElementById('shipper-search-pro')?.value || '';
    st.status = document.getElementById('shipper-status-pro')?.value || 'all';
    st.sort = document.getElementById('shipper-sort-pro')?.value || 'name';
    el.innerHTML = `<div class="empty-state" style="padding:24px;">Đang tải...</div>`;
    try {
      const params = new URLSearchParams({ page: st.page, limit: st.limit, sort: st.sort });
      if (st.q) params.set('q', st.q);
      if (st.status !== 'all') params.set('status', st.status);
      const res = await apiFetch(`/api/admin/shippers?${params}`);
      const list = res.data || [];
      cachedShippers = list;
      st.total = res.total || list.length;
      document.getElementById('shipper-table-count').textContent = st.total;
      if (!list.length) {
        el.innerHTML = `<div class="empty-state" style="padding:32px;">Không có tài xế</div>`;
        return;
      }
      el.innerHTML = `<table class="data-table"><thead><tr>
        ${canMutate() ? '<th style="width:36px;"><input type="checkbox" onchange="toggleAllShippers(this.checked)"></th>' : ''}
        <th>Tài xế</th><th>SĐT</th><th>Status</th><th>AR/CR</th><th>Earnings</th><th></th>
      </tr></thead><tbody>${list.map(s => `
        <tr>
          ${canMutate() ? `<td><input type="checkbox" class="ship-check" data-phone="${escapeHtml(s.phone)}" onchange="toggleShipperSelect('${escapeHtml(s.phone)}',this.checked)"></td>` : ''}
          <td class="text-sm fw-700">${escapeHtml(s.name || '—')}${s.isApproved === false ? ' <span class="badge badge--pending">Pending</span>' : ''}</td>
          <td class="mono text-sm">${escapeHtml(s.phone)}</td>
          <td><span class="badge ${s.status === 'ONLINE' ? 'badge--online' : 'badge--offline'}">${s.status || 'OFFLINE'}</span></td>
          <td class="mono text-xs">${s.acceptanceRate ?? 100}% / ${s.completionRate ?? 100}%</td>
          <td class="mono text-sm">${formatCurrency(s.totalEarnings || 0)}</td>
          <td><button class="btn btn--ghost btn--sm" onclick="editShipper('${escapeHtml(s.phone)}')">Chi tiết</button></td>
        </tr>`).join('')}</tbody></table>`;
      const pages = Math.max(1, Math.ceil(st.total / st.limit));
      document.getElementById('shippers-pagination').innerHTML = `
        <button class="btn btn--ghost btn--sm" ${st.page <= 1 ? 'disabled' : ''} onclick="__shippersPage.page--;loadShippersPage()">Trước</button>
        <span class="text-sm text-muted">Trang ${st.page}/${pages}</span>
        <button class="btn btn--ghost btn--sm" ${st.page >= pages ? 'disabled' : ''} onclick="__shippersPage.page++;loadShippersPage()">Sau</button>`;
    } catch (e) {
      // fallback to original client list
      el.innerHTML = `<div class="empty-state" style="padding:24px;">${escapeHtml(e.message)}</div>`;
      if (typeof _renderShippers === 'function') { /* keep */ }
    }
  };

  window.toggleShipperSelect = function (phone, checked) {
    if (checked) window.__shippersPage.selected.add(phone); else window.__shippersPage.selected.delete(phone);
    const bar = document.getElementById('shippers-bulk-bar');
    if (bar) bar.classList.toggle('hidden', window.__shippersPage.selected.size === 0);
    const c = document.getElementById('shippers-bulk-count');
    if (c) c.textContent = window.__shippersPage.selected.size;
  };
  window.toggleAllShippers = function (checked) {
    document.querySelectorAll('.ship-check').forEach(cb => {
      cb.checked = checked;
      toggleShipperSelect(cb.dataset.phone, checked);
    });
  };
  window.bulkShippers = async function (action) {
    if (!canMutate()) return;
    const phones = [...window.__shippersPage.selected];
    if (!phones.length) return;
    try {
      const res = await apiFetch('/api/admin/shippers/bulk', { method: 'POST', body: JSON.stringify({ action, phones }) });
      const ok = (res.data || []).filter(r => r.ok).length;
      showToast(`Bulk shipper: ${ok}/${phones.length}`, 'success');
      window.__shippersPage.selected.clear();
      loadShippersPage();
    } catch (e) { showToast(e.message, 'error'); }
  };

  // ── Customers CRM ────────────────────────────────────────────────────────
  renderCustomers = async function () {
    const body = document.getElementById('main-body');
    body.innerHTML = `
      <div class="page-section-header">
        <h2>Khách hàng CRM</h2>
        <div class="page-section-header__actions">
          <button class="btn btn--secondary btn--sm" onclick="exportCustomersCsv()"><i class="fa-solid fa-file-csv"></i> Export</button>
        </div>
      </div>
      <div class="toolbar">
        <div class="form-search" style="width:260px;">
          <span class="form-search__icon"><i class="fa-solid fa-magnifying-glass"></i></span>
          <input type="text" class="form-input" id="customer-search-pro" placeholder="Tìm khách..." onkeyup="debounceCustomersLoad()">
        </div>
        <div class="tabs" style="margin:0;">
          <button class="tab active" data-seg="" onclick="setCustomerSegment(this,'')">Tất cả</button>
          <button class="tab" data-seg="vip" onclick="setCustomerSegment(this,'vip')">VIP</button>
          <button class="tab" data-seg="new" onclick="setCustomerSegment(this,'new')">Mới</button>
          <button class="tab" data-seg="inactive" onclick="setCustomerSegment(this,'inactive')">Inactive</button>
          <button class="tab" data-seg="blacklisted" onclick="setCustomerSegment(this,'blacklisted')">Blacklist</button>
        </div>
      </div>
      <div class="data-table-wrapper">
        <div class="data-table-header"><h3>Danh sách</h3><span class="count" id="customer-table-count">0</span></div>
        <div id="customers-table-body"></div>
        <div class="pagination" id="customers-pagination"></div>
      </div>`;
    loadCustomersPage();
  };

  let _custDeb;
  window.debounceCustomersLoad = function () {
    clearTimeout(_custDeb);
    _custDeb = setTimeout(() => { window.__customersPage.page = 1; loadCustomersPage(); }, 350);
  };
  window.setCustomerSegment = function (btn, seg) {
    window.__customersPage.segment = seg;
    document.querySelectorAll('#main-body .toolbar .tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    window.__customersPage.page = 1;
    loadCustomersPage();
  };

  window.loadCustomersPage = async function () {
    const el = document.getElementById('customers-table-body');
    if (!el) return;
    const st = window.__customersPage;
    st.q = document.getElementById('customer-search-pro')?.value || '';
    el.innerHTML = `<div class="empty-state" style="padding:24px;">Đang tải...</div>`;
    try {
      const params = new URLSearchParams({ page: st.page, limit: st.limit, sort: st.sort });
      if (st.q) params.set('q', st.q);
      if (st.segment) params.set('segment', st.segment);
      const res = await apiFetch(`/api/admin/customers?${params}`);
      const list = res.data || [];
      cachedCustomers = list;
      st.total = res.total || 0;
      document.getElementById('customer-table-count').textContent = st.total;
      if (!list.length) {
        el.innerHTML = `<div class="empty-state" style="padding:32px;">Không có khách hàng</div>`;
        return;
      }
      el.innerHTML = `<table class="data-table sticky-head"><thead><tr>
        <th>Khách</th><th>SĐT</th><th>Tags</th><th>Đơn</th><th>LTV</th><th></th>
      </tr></thead><tbody>${list.map(c => `
        <tr style="cursor:pointer;" onclick="showCustomerDetailPro('${escapeHtml(c.phone)}')">
          <td class="text-sm fw-700">${escapeHtml(c.name || '—')}${c.blacklisted ? ' <span class="badge badge--danger">BL</span>' : ''}</td>
          <td class="mono text-sm">${escapeHtml(c.phone)}</td>
          <td class="text-xs">${(c.tags || []).map(t => `<span class="tag-chip">${escapeHtml(t)}</span>`).join(' ') || '—'}</td>
          <td class="mono">${c.ordersCount || 0}</td>
          <td class="mono text-accent">${formatCurrency(c.totalSpent || 0)}</td>
          <td><button class="btn btn--ghost btn--sm" onclick="event.stopPropagation();showCustomerDetailPro('${escapeHtml(c.phone)}')">Profile</button></td>
        </tr>`).join('')}</tbody></table>`;
      const pages = Math.max(1, Math.ceil(st.total / st.limit));
      document.getElementById('customers-pagination').innerHTML = `
        <button class="btn btn--ghost btn--sm" ${st.page <= 1 ? 'disabled' : ''} onclick="__customersPage.page--;loadCustomersPage()">Trước</button>
        <span class="text-sm text-muted">${st.page}/${pages}</span>
        <button class="btn btn--ghost btn--sm" ${st.page >= pages ? 'disabled' : ''} onclick="__customersPage.page++;loadCustomersPage()">Sau</button>`;
    } catch (e) {
      el.innerHTML = `<div class="empty-state" style="padding:24px;color:var(--rose);">${escapeHtml(e.message)}</div>`;
    }
  };

  window.exportCustomersCsv = function () {
    const st = window.__customersPage;
    const params = new URLSearchParams();
    if (st.q) params.set('q', st.q);
    if (st.segment) params.set('segment', st.segment);
    downloadCsvUrl(`/api/admin/customers/export?${params}`);
  };

  window.showCustomerDetailPro = async function (phone) {
    if (!phone) return;
    try {
      const res = await apiFetch(`/api/admin/customers/${encodeURIComponent(phone)}`);
      if (!res.success) throw new Error(res.error || 'Không tìm thấy');
      const c = res.data;
      document.getElementById('customer-modal-title').textContent = c.name || phone;
      document.getElementById('customer-modal-body').innerHTML = `
        <div class="card mb-4" style="padding:16px;">
          <div class="text-sm fw-700">${escapeHtml(c.name || '—')}</div>
          <div class="mono text-sm text-muted">${escapeHtml(phone)}</div>
          <div class="text-sm text-muted mt-2">${escapeHtml(c.address || '—')}</div>
          <div class="flex gap-4 mt-4">
            <div><span class="text-muted text-xs">Đơn</span><div class="mono fw-700">${c.ordersCount}</div></div>
            <div><span class="text-muted text-xs">LTV</span><div class="mono fw-700 text-accent">${formatCurrency(c.ltv || c.totalSpent)}</div></div>
            <div><span class="text-muted text-xs">Blacklist</span><div class="fw-700">${c.blacklisted ? 'Có' : 'Không'}</div></div>
          </div>
        </div>
        <div class="mb-4">
          <label class="form-label">Tags (phẩy tách)</label>
          <input class="form-input" id="cust-tags-input" value="${escapeHtml((c.tags || []).join(', '))}" ${canMutate() ? '' : 'disabled'}>
          ${canMutate() ? `<button class="btn btn--secondary btn--sm mt-2" onclick="saveCustomerTags('${escapeHtml(phone)}')">Lưu tags</button>` : ''}
        </div>
        <div class="mb-4">
          <label class="form-label">Ghi chú mới</label>
          ${canMutate() ? `<div class="flex gap-2"><input class="form-input" id="cust-note-input" placeholder="Thêm ghi chú..."><button class="btn btn--primary btn--sm" onclick="appendCustomerNote('${escapeHtml(phone)}')">Thêm</button></div>` : ''}
          <div class="mt-4">${(c.notes || []).map(n => `
            <div class="note-item"><div class="text-sm">${escapeHtml(n.text)}</div><div class="text-xs text-muted">${n.at ? new Date(n.at).toLocaleString('vi-VN') : ''}</div></div>`).join('') || '<p class="text-muted text-sm">Chưa có ghi chú</p>'}
          </div>
        </div>
        <h4 class="mb-2">Lịch sử đơn</h4>
        <div class="data-table-wrapper" style="max-height:240px;overflow:auto;">
          <table class="data-table"><thead><tr><th>Mã</th><th>TT</th><th>Tổng</th><th>Ngày</th></tr></thead>
          <tbody>${(c.orders || []).map(o => `
            <tr style="cursor:pointer;" onclick="closeModal('customer-modal');showOrderDetail('${escapeHtml(o.id)}')">
              <td class="mono text-xs">${escapeHtml(o.id)}</td>
              <td><span class="badge ${statusBadgeClass(o.status)}">${statusLabel(o.status)}</span></td>
              <td class="mono text-xs">${formatCurrency(o.appTotal)}</td>
              <td class="text-xs">${o.createdAt ? new Date(o.createdAt).toLocaleString('vi-VN') : ''}</td>
            </tr>`).join('') || '<tr><td colspan="4" class="text-muted">Không có đơn</td></tr>'}
          </tbody></table>
        </div>
        ${canMutate() && !c.blacklisted ? `<div class="mt-4"><button class="btn btn--danger btn--sm" onclick="blacklistCustomerFromModal('${escapeHtml(phone)}')"><i class="fa-solid fa-ban"></i> Chặn khách</button></div>` : ''}`;
      openModal('customer-modal');
    } catch (e) {
      showToast(e.message, 'error');
    }
  };

  window.saveCustomerTags = async function (phone) {
    const raw = document.getElementById('cust-tags-input')?.value || '';
    const tags = raw.split(',').map(s => s.trim()).filter(Boolean);
    try {
      await apiFetch(`/api/admin/customers/${encodeURIComponent(phone)}`, { method: 'PUT', body: JSON.stringify({ tags }) });
      showToast('Đã lưu tags', 'success');
      showCustomerDetailPro(phone);
    } catch (e) { showToast(e.message, 'error'); }
  };
  window.appendCustomerNote = async function (phone) {
    const appendNote = document.getElementById('cust-note-input')?.value || '';
    if (!appendNote.trim()) return;
    try {
      await apiFetch(`/api/admin/customers/${encodeURIComponent(phone)}`, { method: 'PUT', body: JSON.stringify({ appendNote }) });
      showToast('Đã thêm ghi chú', 'success');
      showCustomerDetailPro(phone);
    } catch (e) { showToast(e.message, 'error'); }
  };

  // ── Settings tabs ────────────────────────────────────────────────────────
  const _renderSettings = renderSettings;
  renderSettings = function () {
    _renderSettings();
    setTimeout(() => {
      const body = document.getElementById('main-body');
      if (!body || document.getElementById('settings-tabs')) return;
      const header = body.querySelector('.page-section-header');
      if (!header) return;
      header.insertAdjacentHTML('afterend', `
        <div class="tabs mb-4" id="settings-tabs">
          <button class="tab active" data-stab="pricing" onclick="switchSettingsTab(this,'pricing')">Pricing</button>
          <button class="tab" data-stab="growth" onclick="switchSettingsTab(this,'growth')">Growth</button>
          <button class="tab" data-stab="system" onclick="switchSettingsTab(this,'system')">System</button>
          <button class="tab" data-stab="audit" onclick="switchSettingsTab(this,'audit')">Audit</button>
        </div>
        <div id="settings-audit-panel" class="hidden">
          <div class="toolbar">
            <input class="form-input" id="audit-q" placeholder="Tìm audit..." style="width:200px;">
            <input class="form-input" id="audit-action" placeholder="Action" style="width:140px;">
            <input type="date" class="form-input" id="audit-from" style="width:auto;">
            <input type="date" class="form-input" id="audit-to" style="width:auto;">
            <button class="btn btn--secondary btn--sm" onclick="loadAuditPro()">Lọc</button>
          </div>
          <div class="data-table-wrapper"><div id="audit-pro-body"></div>
          <div class="pagination" id="audit-pro-pagination"></div></div>
        </div>
        <div class="card mb-4" id="pricing-preview-card">
          <h3 class="mb-2">Preview giá mẫu</h3>
          <div class="flex gap-2 items-center" style="flex-wrap:wrap;">
            <input type="number" class="form-input" id="price-preview-base" value="50000" style="width:120px;" oninput="updatePricePreview()">
            <input type="number" class="form-input" id="price-preview-km" value="3" step="0.1" style="width:100px;" oninput="updatePricePreview()">
            <span class="text-sm text-muted">đ / km</span>
            <strong class="mono" id="price-preview-result">—</strong>
          </div>
        </div>`);
      switchSettingsTab(document.querySelector('#settings-tabs .tab'), 'pricing');
      updatePricePreview();
      if (!canEditPricing()) {
        document.querySelectorAll('#pricing-settings-card input, #pricing-settings-card button').forEach(el => {
          el.disabled = true;
        });
      }
    }, 60);
  };

  window.switchSettingsTab = function (btn, tab) {
    window.__settingsTab = tab;
    document.querySelectorAll('#settings-tabs .tab').forEach(t => t.classList.remove('active'));
    btn?.classList.add('active');
    const audit = document.getElementById('settings-audit-panel');
    const grid = document.querySelector('#main-body > .grid-2');
    const preview = document.getElementById('pricing-preview-card');
    if (tab === 'audit') {
      if (audit) audit.classList.remove('hidden');
      if (grid) grid.classList.add('hidden');
      if (preview) preview.classList.add('hidden');
      loadAuditPro();
    } else {
      if (audit) audit.classList.add('hidden');
      if (grid) grid.classList.remove('hidden');
      if (preview) preview.classList.toggle('hidden', tab !== 'pricing');
      // Soft-filter cards
      document.querySelectorAll('#main-body .grid-2 > .card, #main-body .grid-2 > [class*="card"]').forEach(card => {
        const h = (card.querySelector('h3')?.textContent || '').toLowerCase();
        let show = true;
        if (tab === 'pricing') show = h.includes('pricing') || h.includes('telegram') || h.includes('commission');
        else if (tab === 'growth') show = h.includes('giảm') || h.includes('promo') || h.includes('khu') || h.includes('settlement') || h.includes('blacklist') || h.includes('audit');
        else if (tab === 'system') show = h.includes('api') || h.includes('supabase') || h.includes('cache') || h.includes('phiên') || h.includes('đăng xuất') || h.includes('server');
        card.style.display = show ? '' : 'none';
      });
    }
  };

  window.updatePricePreview = function () {
    const base = Number(document.getElementById('price-preview-base')?.value || 0);
    const km = Number(document.getElementById('price-preview-km')?.value || 0);
    const markup = (Number(document.getElementById('settings-markup-rate')?.value || 28) / 100);
    const freeKm = Number(document.getElementById('settings-free-distance')?.value || 1.5);
    const coef = Number(document.getElementById('settings-surcharge-coef')?.value || 7000);
    const marked = Math.round(base * (1 + markup) / 100) * 100;
    const over = Math.max(0, km - freeKm);
    const surcharge = over > 0 ? Math.round((coef * Math.sqrt(over)) / 100) * 100 : 0;
    const el = document.getElementById('price-preview-result');
    if (el) el.textContent = `${formatCurrency(marked + surcharge)} (markup ${formatCurrency(marked)} + phụ thu ${formatCurrency(surcharge)})`;
  };

  window.__auditPage = 1;
  window.loadAuditPro = async function () {
    const el = document.getElementById('audit-pro-body');
    if (!el) return;
    try {
      const params = new URLSearchParams({ page: window.__auditPage, limit: 40 });
      const q = document.getElementById('audit-q')?.value;
      const action = document.getElementById('audit-action')?.value;
      const from = document.getElementById('audit-from')?.value;
      const to = document.getElementById('audit-to')?.value;
      if (q) params.set('q', q);
      if (action) params.set('action', action);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const res = await apiFetch(`/api/admin/audit-log?${params}`);
      const list = res.data || [];
      el.innerHTML = `<table class="data-table sticky-head"><thead><tr><th>Thời gian</th><th>Actor</th><th>Action</th><th>Chi tiết</th></tr></thead>
        <tbody>${list.map(a => `
          <tr><td class="text-xs">${a.at ? new Date(a.at).toLocaleString('vi-VN') : ''}</td>
          <td class="text-xs">${escapeHtml(a.actorEmail || a.adminEmail || '')}<br><span class="text-muted">${escapeHtml(a.role || a.adminRole || '')}</span></td>
          <td class="mono text-xs">${escapeHtml(a.action || '')}</td>
          <td class="text-xs" style="max-width:320px;overflow:hidden;"><code>${escapeHtml(JSON.stringify(a.details || {}).slice(0, 180))}</code></td></tr>`).join('') || '<tr><td colspan="4" class="text-muted">Trống</td></tr>'}
        </tbody></table>`;
      const pages = Math.max(1, Math.ceil((res.total || 0) / 40));
      document.getElementById('audit-pro-pagination').innerHTML = `
        <button class="btn btn--ghost btn--sm" onclick="__auditPage=Math.max(1,__auditPage-1);loadAuditPro()">Trước</button>
        <span class="text-sm text-muted">${window.__auditPage}/${pages}</span>
        <button class="btn btn--ghost btn--sm" onclick="__auditPage++;loadAuditPro()">Sau</button>`;
    } catch (e) {
      el.innerHTML = `<p class="text-muted">${escapeHtml(e.message)}</p>`;
    }
  };

  // ── Restaurants bulk toolbar ─────────────────────────────────────────────
  const _renderRestaurants = typeof renderRestaurants === 'function' ? renderRestaurants : null;
  const _renderRestaurantsTable = typeof renderRestaurantsTable === 'function' ? renderRestaurantsTable : null;
  if (_renderRestaurantsTable) {
    renderRestaurantsTable = function () {
      _renderRestaurantsTable();
      const tbody = document.getElementById('restaurants-tbody');
      if (!tbody || !canMutate()) return;
      tbody.querySelectorAll('tr[data-restaurant-id]').forEach(tr => {
        if (tr.querySelector('.rest-check')) return;
        const rid = tr.getAttribute('data-restaurant-id');
        tr.insertAdjacentHTML('afterbegin', `<td><input type="checkbox" class="rest-check" data-id="${escapeHtml(rid)}" onchange="toggleRestSelect('${escapeHtml(rid)}',this.checked)" ${window.__restSelected.has(rid) ? 'checked' : ''}></td>`);
      });
      const theadRows = document.querySelectorAll('#restaurants-table-body thead tr');
      theadRows.forEach((thead, idx) => {
        if (thead.querySelector('.rest-check-all') || thead.querySelector('.rest-check-spacer')) return;
        if (idx === 0) {
          thead.insertAdjacentHTML('afterbegin', `<th style="width:36px;" class="rest-check-all"><input type="checkbox" onchange="document.querySelectorAll('.rest-check').forEach(c=>{c.checked=this.checked;toggleRestSelect(c.dataset.id,this.checked)})"></th>`);
        } else {
          thead.insertAdjacentHTML('afterbegin', `<th class="rest-check-spacer"></th>`);
        }
      });
    };
    window.renderRestaurantsTable = renderRestaurantsTable;
  }
  if (_renderRestaurants) {
    renderRestaurants = function () {
      _renderRestaurants();
      setTimeout(() => {
        const actions = document.querySelector('#main-body .page-section-header__actions');
        if (!actions || document.getElementById('rest-bulk-bar')) return;
        actions.insertAdjacentHTML('beforeend', `
          <button class="btn btn--ghost btn--sm" onclick="downloadCsvUrl('/api/admin/restaurants/export')"><i class="fa-solid fa-file-csv"></i> Export</button>
          ${canMutate() ? `<div id="rest-bulk-bar" class="bulk-bar">
            <span id="rest-bulk-count">0 chọn</span>
            <button class="btn btn--secondary btn--sm" onclick="bulkRestaurants('open')">Mở cửa</button>
            <button class="btn btn--secondary btn--sm" onclick="bulkRestaurants('close')">Đóng</button>
            <button class="btn btn--primary btn--sm" onclick="bulkRestaurants('sync')">Sync</button>
          </div>` : ''}`);
      }, 100);
    };
  }

  window.toggleRestSelect = function (id, checked) {
    if (checked) window.__restSelected.add(id); else window.__restSelected.delete(id);
    const c = document.getElementById('rest-bulk-count');
    if (c) c.textContent = `${window.__restSelected.size} chọn`;
  };
  window.bulkRestaurants = async function (action) {
    if (!canMutate()) return;
    const ids = [...window.__restSelected];
    if (!ids.length) return showToast('Chọn ít nhất 1 quán', 'warning');
    try {
      const res = await apiFetch('/api/admin/restaurants/bulk', { method: 'POST', body: JSON.stringify({ action, ids }) });
      const ok = (res.data || []).filter(r => r.ok).length;
      showToast(`Bulk quán: ${ok}/${ids.length}`, 'success');
      window.__restSelected.clear();
      if (typeof loadRestaurantsPage === 'function') loadRestaurantsPage();
      else navigateTo('restaurants');
    } catch (e) { showToast(e.message, 'error'); }
  };

  // ── Dashboard SLA click + peak hours ─────────────────────────────────────
  const _renderDashboard = renderDashboard;
  renderDashboard = function () {
    _renderDashboard();
    setTimeout(() => {
      const ops = document.getElementById('ops-live-body') || document.querySelector('[data-ops-live]');
      // Add peak hours strip if analytics hourly available
      if (!document.getElementById('dash-peak') && document.getElementById('main-body')) {
        const wrap = document.createElement('div');
        wrap.className = 'card mb-4';
        wrap.id = 'dash-peak';
        wrap.innerHTML = `<div class="flex justify-between items-center mb-2"><h3>Peak hours (7 ngày)</h3>
          <button class="btn btn--ghost btn--sm" onclick="jumpOrdersSla()">Xem đơn SLA</button></div>
          <div id="dash-peak-body" class="peak-heatmap"><span class="text-muted text-sm">Đang tải...</span></div>`;
        const firstCard = document.querySelector('#main-body .stats-grid');
        if (firstCard) firstCard.insertAdjacentElement('afterend', wrap);
        apiFetch('/api/admin/analytics?range=7d').then(res => {
          const hourly = res?.data?.hourly || [];
          const el = document.getElementById('dash-peak-body');
          if (!el) return;
          const max = Math.max(1, ...hourly.map(h => h.orders));
          el.innerHTML = hourly.map(h => {
            const pct = Math.round((h.orders / max) * 100);
            return `<div class="peak-cell" style="--p:${pct}%" title="${h.hour}h · ${h.orders} đơn"><span>${h.hour}</span></div>`;
          }).join('') || '<span class="text-muted text-sm">Chưa có dữ liệu</span>';
        }).catch(() => {});
      }
    }, 100);
  };

  // ── Wire navigateTo renderers ────────────────────────────────────────────
  const _nav2 = navigateTo;
  navigateTo = function (page) {
    if (page === 'analytics') {
      currentPage = page;
      document.querySelectorAll('.sidebar__link').forEach(link => {
        link.classList.toggle('active', link.dataset.page === page);
      });
      document.getElementById('header-title').textContent = 'Reports';
      document.getElementById('header-breadcrumb').textContent = 'Analytics';
      renderAnalyticsPro();
      pushPageState(page, false);
      document.getElementById('sidebar')?.classList.remove('open');
      return;
    }
    _nav2(page);
  };

  // Patch showApp
  const _showApp = showApp;
  showApp = function () {
    _showApp();
    applyDensity(window.__crmPro.density);
    applyRoleUi();
    syncAdminRole().catch((e) => console.warn('[CRM Pro] role sync', e.message));
    ensureCommandPalette();
    // header actions
    const actions = document.querySelector('.main-header__actions');
    if (actions && !document.getElementById('density-toggle')) {
      actions.insertAdjacentHTML('afterbegin', `
        <button class="btn btn--ghost btn--icon" id="cmdk-btn" title="Command palette (Ctrl+K)" onclick="showCommandPalette()">
          <i class="fa-solid fa-terminal"></i>
        </button>
        <button class="btn btn--ghost btn--icon" id="density-toggle" title="Density" onclick="toggleCrmDensity()">
          <i class="fa-solid fa-table-cells"></i>
        </button>`);
      const search = document.getElementById('global-search');
      if (search) {
        search.placeholder = 'Ctrl+K tìm nhanh…';
        search.addEventListener('focus', () => showCommandPalette());
      }
    }
  };

  // Re-patch login: verify role via /api/admin/me (app_metadata on server)
  handleAdminLogin = async function () {
    const email = document.getElementById('admin-email').value.trim();
    const password = document.getElementById('admin-password').value.trim();
    if (!email || !password) { showToast('Vui lòng nhập đầy đủ email và mật khẩu', 'warning'); return; }
    if (!supabaseClient) { showToast('Cần kết nối Supabase Auth để đăng nhập quản trị.', 'error'); return; }
    try {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) { showToast('Đăng nhập thất bại: ' + error.message, 'error'); return; }
      localStorage.setItem('shipfee_jwt', data.session.access_token);
      adminUser = {
        email: data.user.email,
        name: data.user.user_metadata?.full_name || data.user.email,
        role: 'viewer'
      };
      localStorage.setItem('shipfee_admin', JSON.stringify(adminUser));
      try {
        await syncAdminRole();
      } catch (e) {
        await supabaseClient.auth.signOut();
        localStorage.removeItem('shipfee_jwt');
        localStorage.removeItem('shipfee_admin');
        showToast('Bạn không có quyền CRM!', 'error');
        return;
      }
      if (!adminUser?.role) {
        await supabaseClient.auth.signOut();
        showToast('Bạn không có quyền CRM!', 'error');
        return;
      }
      applyRoleUi();
      showToast('Đăng nhập thành công (' + adminUser.role + ')', 'success');
      showApp();
    } catch (e) {
      showToast('Lỗi: ' + e.message, 'error');
    }
  };

  // Export overrides
  window.renderAnalytics = renderAnalyticsPro;
  window.renderCustomers = renderCustomers;
  window.renderShippers = renderShippers;
  window.renderOrders = renderOrders;
  window.renderSettings = renderSettings;
  window.renderDashboard = renderDashboard;
  window.showCustomerDetail = showCustomerDetailPro;

  console.log('[CRM Pro] loaded');
})();
