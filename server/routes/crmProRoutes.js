'use strict';

/**
 * CRM Pro routes — pagination, CSV exports, bulk actions, customer CRM depth.
 * Registered from server.js with shared ctx.
 */
function registerCrmProRoutes(app, ctx) {
  const {
    authenticateAdmin,
    crm,
    cleanPhone,
    readShippersDatabase,
    writeShippersDatabase,
    readOrdersDatabase,
    updateOrdersDatabase,
    scheduleUpsertOrder,
    mergeOrdersFromSupabaseForRange,
    ORDER_HISTORY_RETENTION_DAYS,
    filterAdminOrders,
    getOrderSlaInfo,
    getAdminRestaurantsList,
    enrichAdminRestaurantRow,
    normalizeImageUrl,
    canTransitionOrderStatus,
    getShipperActiveOrderCount,
    MAX_ACTIVE_ORDERS_PER_SHIPPER,
    approveShipperAccount,
    rejectShipperAccount,
    telegramBot,
    addNotification,
    runBulkRestaurantSync
  } = ctx;

  const mutateOps = crm.requireAdminRole('admin', 'ops');

  // ── Paginated shippers ───────────────────────────────────────────────────
  app.get('/api/admin/shippers', authenticateAdmin, (req, res) => {
    try {
      const { q, status, page = '1', limit = '50', sort = 'name' } = req.query;
      let list = readShippersDatabase().map((s) => ({
        ...s,
        avatarUrl: normalizeImageUrl ? normalizeImageUrl(s.avatarUrl, req) : s.avatarUrl
      }));
      if (status === 'online') list = list.filter((s) => s.status === 'ONLINE');
      else if (status === 'offline') list = list.filter((s) => s.status !== 'ONLINE');
      else if (status === 'pending') list = list.filter((s) => s.isApproved === false);
      if (q) {
        const ql = String(q).toLowerCase();
        list = list.filter((s) =>
          (s.name || '').toLowerCase().includes(ql) ||
          (s.phone || '').includes(q) ||
          (s.email || '').toLowerCase().includes(ql) ||
          (s.cccd || '').includes(q)
        );
      }
      const sortKey = String(sort);
      list.sort((a, b) => {
        if (sortKey === 'earnings') return (b.totalEarnings || 0) - (a.totalEarnings || 0);
        if (sortKey === 'ar') return (b.acceptanceRate ?? 100) - (a.acceptanceRate ?? 100);
        if (sortKey === 'cr') return (b.completionRate ?? 100) - (a.completionRate ?? 100);
        if (sortKey === 'status') return String(a.status || '').localeCompare(String(b.status || ''));
        return String(a.name || '').localeCompare(String(b.name || ''), 'vi');
      });
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
      const start = (pageNum - 1) * limitNum;
      res.json({
        success: true,
        data: list.slice(start, start + limitNum),
        total: list.length,
        page: pageNum,
        limit: limitNum,
        hasMore: start + limitNum < list.length
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/admin/shippers/list-export', authenticateAdmin, (req, res) => {
    try {
      const shippers = readShippersDatabase();
      const headers = ['phone', 'name', 'email', 'status', 'isApproved', 'totalOrders', 'totalEarnings', 'acceptanceRate', 'completionRate'];
      const rows = shippers.map((s) => [
        s.phone, s.name, s.email, s.status, s.isApproved !== false, s.totalOrders || 0,
        s.totalEarnings || 0, s.acceptanceRate ?? 100, s.completionRate ?? 100
      ]);
      const csv = crm.buildCsv(headers, rows);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="shipfee-shippers.csv"');
      res.send(csv);
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/admin/shippers/bulk', authenticateAdmin, mutateOps, async (req, res) => {
    try {
      const { action, phones = [] } = req.body || {};
      if (!action || !Array.isArray(phones) || !phones.length) {
        return res.status(400).json({ success: false, error: 'Thiếu action hoặc phones[]' });
      }
      const results = [];
      for (const phone of phones) {
        try {
          if (action === 'approve') {
            if (typeof approveShipperAccount === 'function') {
              await approveShipperAccount(phone);
            } else {
              const shippers = readShippersDatabase();
              const s = shippers.find((x) => cleanPhone(x.phone) === cleanPhone(phone));
              if (s) { s.isApproved = true; writeShippersDatabase(shippers); }
            }
            crm.logAdminAudit(req, 'shipper_bulk_approve', { phone });
            results.push({ phone, ok: true });
          } else if (action === 'reject') {
            if (typeof rejectShipperAccount === 'function') {
              await rejectShipperAccount(phone);
            } else {
              let shippers = readShippersDatabase();
              shippers = shippers.filter((x) => cleanPhone(x.phone) !== cleanPhone(phone));
              writeShippersDatabase(shippers);
            }
            crm.logAdminAudit(req, 'shipper_bulk_reject', { phone });
            results.push({ phone, ok: true });
          } else if (action === 'setOffline') {
            const shippers = readShippersDatabase();
            const s = shippers.find((x) => cleanPhone(x.phone) === cleanPhone(phone));
            if (s) {
              s.status = 'OFFLINE';
              writeShippersDatabase(shippers);
              crm.logAdminAudit(req, 'shipper_bulk_offline', { phone });
              results.push({ phone, ok: true });
            } else results.push({ phone, ok: false, error: 'Not found' });
          } else {
            results.push({ phone, ok: false, error: 'Unknown action' });
          }
        } catch (err) {
          results.push({ phone, ok: false, error: err.message });
        }
      }
      res.json({ success: true, data: results });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── Customers paginated + export + detail ────────────────────────────────
  async function buildCustomerList(req) {
    const orders = await mergeOrdersFromSupabaseForRange(
      readOrdersDatabase(),
      ORDER_HISTORY_RETENTION_DAYS || 90
    );
    const customerMap = new Map();
    orders.forEach((o) => {
      const phone = o.deliveryPhone || o.ordererPhone;
      if (!phone) return;
      if (!customerMap.has(phone)) {
        customerMap.set(phone, {
          name: o.deliveryName || '—',
          phone,
          address: o.deliveryAddress || '',
          ordersCount: 0,
          totalSpent: 0,
          lastOrderAt: 0
        });
      }
      const c = customerMap.get(phone);
      c.ordersCount++;
      c.totalSpent += o.appTotal || 0;
      c.lastOrderAt = Math.max(c.lastOrderAt || 0, o.createdAt || 0);
      if (o.deliveryName) c.name = o.deliveryName;
      if (o.deliveryAddress) c.address = o.deliveryAddress;
    });
    const blacklist = new Set((crm.readBlacklist() || []).map((b) => cleanPhone(b.phone)));
    const crmStore = crm.readCustomerCrmStore();
    let list = Array.from(customerMap.values()).map((c) => {
      const p = cleanPhone(c.phone);
      const profile = crmStore[p] || {};
      return {
        ...c,
        blacklisted: blacklist.has(p),
        tags: Array.isArray(profile.tags) ? profile.tags : [],
        notesCount: Array.isArray(profile.notes) ? profile.notes.length : 0
      };
    });
    const { q, sort = 'spent', minSpent, minOrders, segment } = req.query;
    if (q) {
      const ql = String(q).toLowerCase();
      list = list.filter((c) =>
        (c.name || '').toLowerCase().includes(ql) ||
        (c.phone || '').includes(q) ||
        (c.address || '').toLowerCase().includes(ql) ||
        (c.tags || []).some((t) => String(t).toLowerCase().includes(ql))
      );
    }
    if (minSpent) list = list.filter((c) => c.totalSpent >= Number(minSpent));
    if (minOrders) list = list.filter((c) => c.ordersCount >= Number(minOrders));
    if (segment === 'vip') list = list.filter((c) => c.totalSpent >= 500000);
    else if (segment === 'new') {
      const weekAgo = Date.now() - 7 * 86400000;
      list = list.filter((c) => (c.lastOrderAt || 0) >= weekAgo && c.ordersCount <= 2);
    } else if (segment === 'blacklisted') list = list.filter((c) => c.blacklisted);
    else if (segment === 'inactive') {
      const monthAgo = Date.now() - 30 * 86400000;
      list = list.filter((c) => (c.lastOrderAt || 0) < monthAgo);
    }
    if (sort === 'orders') list.sort((a, b) => b.ordersCount - a.ordersCount);
    else if (sort === 'recent') list.sort((a, b) => (b.lastOrderAt || 0) - (a.lastOrderAt || 0));
    else if (sort === 'name') list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'vi'));
    else list.sort((a, b) => b.totalSpent - a.totalSpent);
    return list;
  }

  app.get('/api/admin/customers', authenticateAdmin, async (req, res) => {
    try {
      const list = await buildCustomerList(req);
      const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limitNum = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const start = (pageNum - 1) * limitNum;
      res.json({
        success: true,
        data: list.slice(start, start + limitNum),
        total: list.length,
        page: pageNum,
        limit: limitNum,
        hasMore: start + limitNum < list.length
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/admin/customers/export', authenticateAdmin, async (req, res) => {
    try {
      const list = await buildCustomerList(req);
      const headers = ['phone', 'name', 'address', 'ordersCount', 'totalSpent', 'lastOrderAt', 'tags', 'blacklisted'];
      const rows = list.map((c) => [
        c.phone, c.name, c.address, c.ordersCount, c.totalSpent,
        c.lastOrderAt ? new Date(c.lastOrderAt).toISOString() : '',
        (c.tags || []).join('|'), c.blacklisted
      ]);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="shipfee-customers.csv"');
      res.send(crm.buildCsv(headers, rows));
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/admin/customers/:phone', authenticateAdmin, async (req, res) => {
    try {
      const phone = cleanPhone(req.params.phone);
      const orders = await mergeOrdersFromSupabaseForRange(
        readOrdersDatabase(),
        ORDER_HISTORY_RETENTION_DAYS || 90
      );
      const history = orders
        .filter((o) => cleanPhone(o.deliveryPhone) === phone || cleanPhone(o.ordererPhone) === phone)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      if (!history.length && !crm.getCustomerCrmProfile(phone).notes.length) {
        return res.status(404).json({ success: false, error: 'Không tìm thấy khách hàng' });
      }
      const profile = crm.getCustomerCrmProfile(phone);
      const blacklisted = !!crm.isBlacklisted(phone);
      const totalSpent = history.reduce((s, o) => s + (o.appTotal || 0), 0);
      const last = history[0] || {};
      res.json({
        success: true,
        data: {
          phone,
          name: last.deliveryName || '—',
          address: last.deliveryAddress || '',
          ordersCount: history.length,
          totalSpent,
          ltv: totalSpent,
          lastOrderAt: last.createdAt || null,
          blacklisted,
          tags: profile.tags,
          notes: profile.notes,
          orders: history.slice(0, 50)
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.put('/api/admin/customers/:phone', authenticateAdmin, mutateOps, (req, res) => {
    try {
      const phone = cleanPhone(req.params.phone);
      const { tags, notes, appendNote } = req.body || {};
      const profile = crm.upsertCustomerCrmProfile(phone, { tags, notes, appendNote });
      crm.logAdminAudit(req, 'customer_crm_update', { phone, tags: profile.tags, appendNote: !!appendNote });
      res.json({ success: true, data: profile });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── Restaurants export + bulk ────────────────────────────────────────────
  app.get('/api/admin/restaurants/export', authenticateAdmin, (req, res) => {
    try {
      const { q, tab } = req.query;
      const result = getAdminRestaurantsList({ q, tab: tab || 'all', page: 1, limit: 100000, export: true });
      const rows = (result.data || []).map((row) => [
          row.id, row.name, row.address, row.category,
          row.isClosed ? 'CLOSED' : 'OPEN',
          row.hasRealMenu ? 'real' : 'fallback',
          row.menuItemCount || 0,
          row.menuUpdatedAt ? new Date(row.menuUpdatedAt).toISOString() : ''
      ]);
      const headers = ['id', 'name', 'address', 'category', 'status', 'menuType', 'menuItemCount', 'menuUpdatedAt'];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="shipfee-restaurants.csv"');
      res.send(crm.buildCsv(headers, rows));
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/admin/restaurants/bulk', authenticateAdmin, mutateOps, async (req, res) => {
    try {
      const { action, ids = [] } = req.body || {};
      if (!action || !Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ success: false, error: 'Thiếu action hoặc ids[]' });
      }
      const results = [];
      if (action === 'open' || action === 'close') {
        const wantClosed = action === 'close';
        for (const id of ids) {
          try {
            // Reuse toggle via local DB helper exposed on ctx if available
            if (typeof ctx.setRestaurantClosed === 'function') {
              await ctx.setRestaurantClosed(id, wantClosed);
            } else if (typeof ctx.toggleRestaurantStatus === 'function') {
              await ctx.toggleRestaurantStatus(id, wantClosed);
            } else {
              results.push({ id, ok: false, error: 'Toggle helper unavailable' });
              continue;
            }
            crm.logAdminAudit(req, 'restaurant_bulk_status', { id, isClosed: wantClosed });
            results.push({ id, ok: true });
          } catch (err) {
            results.push({ id, ok: false, error: err.message });
          }
        }
      } else if (action === 'sync') {
        if (typeof runBulkRestaurantSync === 'function') {
          // Fire selected sync via per-id scrape if available
          for (const id of ids) {
            try {
              if (typeof ctx.triggerSyncMenuScrape === 'function') {
                ctx.triggerSyncMenuScrape(id);
                crm.logAdminAudit(req, 'restaurant_bulk_sync', { id });
                results.push({ id, ok: true, queued: true });
              } else {
                results.push({ id, ok: false, error: 'Scrape helper unavailable' });
              }
            } catch (err) {
              results.push({ id, ok: false, error: err.message });
            }
          }
        }
      } else {
        return res.status(400).json({ success: false, error: 'action phải là open|close|sync' });
      }
      res.json({ success: true, data: results });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── Orders bulk ──────────────────────────────────────────────────────────
  app.post('/api/admin/orders/bulk', authenticateAdmin, mutateOps, async (req, res) => {
    try {
      const { action, ids = [], payload = {} } = req.body || {};
      if (!action || !Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ success: false, error: 'Thiếu action hoặc ids[]' });
      }
      const results = [];
      for (const orderId of ids) {
        try {
          if (action === 'cancel') {
            let updatedOrder = null;
            let errMsg = null;
            await updateOrdersDatabase((orders) => {
              const idx = orders.findIndex((o) => o.id === orderId);
              if (idx === -1) return false;
              if (['DELIVERED', 'CANCELLED'].includes(orders[idx].status)) {
                errMsg = `Không hủy được ${orders[idx].status}`;
                return false;
              }
              orders[idx].status = 'CANCELLED';
              orders[idx].cancelledAt = Date.now();
              orders[idx].cancelReason = payload.reason || 'Admin bulk cancel';
              orders[idx].assignedShipperPhone = null;
              orders[idx].offerExpiresAt = null;
              updatedOrder = orders[idx];
            });
            if (errMsg) { results.push({ id: orderId, ok: false, error: errMsg }); continue; }
            if (!updatedOrder) { results.push({ id: orderId, ok: false, error: 'Not found' }); continue; }
            scheduleUpsertOrder(updatedOrder, 'admin');
            crm.notifyOrderCancelled(updatedOrder, addNotification);
            crm.logAdminAudit(req, 'order_bulk_cancel', { orderId });
            results.push({ id: orderId, ok: true });
          } else if (action === 'status') {
            const status = payload.status;
            if (!status) { results.push({ id: orderId, ok: false, error: 'Thiếu status' }); continue; }
            let updatedOrder = null;
            let errMsg = null;
            await updateOrdersDatabase((orders) => {
              const idx = orders.findIndex((o) => o.id === orderId);
              if (idx === -1) return false;
              if (!canTransitionOrderStatus(orders[idx].status, status)) {
                errMsg = `Không chuyển ${orders[idx].status} → ${status}`;
                return false;
              }
              orders[idx].status = status;
              if (status === 'ACCEPTED' && !orders[idx].acceptedAt) orders[idx].acceptedAt = Date.now();
              if (status === 'PURCHASED') orders[idx].purchasedAt = Date.now();
              if (status === 'DELIVERED') orders[idx].deliveredAt = Date.now();
              updatedOrder = orders[idx];
            });
            if (errMsg) { results.push({ id: orderId, ok: false, error: errMsg }); continue; }
            if (!updatedOrder) { results.push({ id: orderId, ok: false, error: 'Not found' }); continue; }
            scheduleUpsertOrder(updatedOrder, 'admin');
            crm.logAdminAudit(req, 'order_bulk_status', { orderId, status });
            results.push({ id: orderId, ok: true });
          } else if (action === 'assign') {
            const shipperPhone = payload.shipperPhone;
            if (!shipperPhone) { results.push({ id: orderId, ok: false, error: 'Thiếu shipperPhone' }); continue; }
            const shippers = readShippersDatabase();
            const matched = shippers.find((s) => cleanPhone(s.phone) === cleanPhone(shipperPhone));
            if (!matched || matched.status !== 'ONLINE') {
              results.push({ id: orderId, ok: false, error: 'Tài xế không ONLINE' });
              continue;
            }
            if (getShipperActiveOrderCount(matched.phone) >= MAX_ACTIVE_ORDERS_PER_SHIPPER) {
              results.push({ id: orderId, ok: false, error: 'Tài xế đầy đơn' });
              continue;
            }
            let updatedOrder = null;
            let errMsg = null;
            await updateOrdersDatabase((orders) => {
              const idx = orders.findIndex((o) => o.id === orderId);
              if (idx === -1) return false;
              if (orders[idx].status !== 'PENDING') {
                errMsg = 'Chỉ gán đơn PENDING';
                return false;
              }
              orders[idx].status = 'ACCEPTED';
              orders[idx].shipperId = matched.id || 'local-shipper-id';
              orders[idx].shipperName = matched.name;
              orders[idx].shipperPhone = matched.phone;
              orders[idx].assignedShipperPhone = null;
              orders[idx].offerExpiresAt = null;
              orders[idx].acceptedAt = Date.now();
              updatedOrder = orders[idx];
            });
            if (errMsg) { results.push({ id: orderId, ok: false, error: errMsg }); continue; }
            if (!updatedOrder) { results.push({ id: orderId, ok: false, error: 'Not found' }); continue; }
            scheduleUpsertOrder(updatedOrder, 'admin');
            if (telegramBot) telegramBot.sendOrderStatusUpdateNotification(updatedOrder).catch(() => {});
            crm.logAdminAudit(req, 'order_bulk_assign', { orderId, shipperPhone: matched.phone });
            results.push({ id: orderId, ok: true });
          } else {
            results.push({ id: orderId, ok: false, error: 'Unknown action' });
          }
        } catch (err) {
          results.push({ id: orderId, ok: false, error: err.message });
        }
      }
      res.json({ success: true, data: results });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── Settlements / analytics export ───────────────────────────────────────
  app.get('/api/admin/settlements/export', authenticateAdmin, (req, res) => {
    try {
      const { from, to } = req.query;
      const report = crm.computeSettlementReport(readOrdersDatabase(), from, to);
      const headers = ['restaurantId', 'restaurantName', 'orders', 'gmv', 'storeTotal', 'commissionRate', 'commissionAmount', 'platformNet'];
      const rows = (report.restaurants || []).map((r) => [
        r.restaurantId, r.restaurantName, r.orders, r.gmv, r.storeTotal,
        r.commissionRate, r.commissionAmount, r.platformNet
      ]);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="shipfee-settlements.csv"');
      res.send(crm.buildCsv(headers, rows));
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/admin/analytics/export', authenticateAdmin, async (req, res) => {
    try {
      const range = req.query.range || '7d';
      const { from, to, tab = 'sales' } = req.query;
      const days = from || to ? 90 : crm.parseRangeDays(range);
      const orders = await mergeOrdersFromSupabaseForRange(readOrdersDatabase(), Math.max(days * 2, days));
      const data = crm.computeAnalytics(orders, readShippersDatabase(), range, from, to);
      let headers, rows;
      if (tab === 'ops') {
        headers = ['date', 'breaches', 'cancelled'];
        rows = (data.slaDaily || []).map((d) => [d.date, d.breaches, d.cancelled]);
      } else if (tab === 'financials') {
        headers = ['restaurantId', 'restaurantName', 'orders', 'gmv', 'commissionAmount', 'platformNet'];
        rows = (data.settlement?.restaurants || []).map((r) => [
          r.restaurantId, r.restaurantName, r.orders, r.gmv, r.commissionAmount, r.platformNet
        ]);
      } else {
        headers = ['date', 'orders', 'revenue'];
        rows = (data.daily || []).map((d) => [d.date, d.orders, d.revenue]);
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="shipfee-analytics-${tab}.csv"`);
      res.send(crm.buildCsv(headers, rows));
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Me / role endpoint for FE gating
  app.get('/api/admin/me', authenticateAdmin, (req, res) => {
    res.json({
      success: true,
      data: {
        email: req.user?.email || null,
        role: req.adminRole || 'viewer',
        canMutate: crm.canMutateOrders(req.adminRole),
        canEditPricing: crm.canMutatePricing(req.adminRole)
      }
    });
  });
}

module.exports = { registerCrmProRoutes };
