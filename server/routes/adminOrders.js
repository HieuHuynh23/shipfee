'use strict';

function registerAdminOrderRoutes(app, ctx) {
  const {
  authenticateAdmin,
  crm,
  cleanPhone,
  readShippersDatabase,
  getShipperActiveOrderCount,
  MAX_ACTIVE_ORDERS_PER_SHIPPER,
  updateOrdersDatabase,
  scheduleUpsertOrder,
  telegramBot,
  ensureOrderInLocalCache,
  readOrdersDatabase,
  onlineShipperLocations,
  canTransitionOrderStatus,
  assignOfferToShipper,
  clearOrderOffer,
  findNearestAvailableShipper,
  addNotification,
  enrichOrdersWithShipperAvatar,
  activeCalls
  } = ctx;

app.post('/api/admin/orders/:id/assign', authenticateAdmin, async (req, res) => {
  try {
    const orderId = req.params.id;
    const { shipperPhone } = req.body;
    if (!shipperPhone) {
      return res.status(400).json({ success: false, error: 'Thiếu số điện thoại tài xế!' });
    }

    const shippers = readShippersDatabase();
    const matchedShipper = shippers.find(s => cleanPhone(s.phone) === cleanPhone(shipperPhone));
    if (!matchedShipper) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy tài xế với số điện thoại này!' });
    }
    if (matchedShipper.status !== 'ONLINE') {
      return res.status(400).json({ success: false, error: 'Tài xế không đang ONLINE!' });
    }
    if (getShipperActiveOrderCount(matchedShipper.phone) >= MAX_ACTIVE_ORDERS_PER_SHIPPER) {
      return res.status(409).json({ success: false, error: `Tài xế đang mang tối đa ${MAX_ACTIVE_ORDERS_PER_SHIPPER} đơn.` });
    }

    let updatedOrder = null;
    let statusError = null;
    await updateOrdersDatabase((orders) => {
      const idx = orders.findIndex(o => o.id === orderId);
      if (idx === -1) return false;
      if (orders[idx].status !== 'PENDING') {
        statusError = `Chỉ gán được đơn PENDING (hiện tại: ${orders[idx].status})`;
        return false;
      }
      orders[idx].status = 'ACCEPTED';
      orders[idx].shipperId = matchedShipper.id || 'local-shipper-id';
      orders[idx].shipperName = matchedShipper.name;
      orders[idx].shipperPhone = matchedShipper.phone;
      orders[idx].assignedShipperPhone = null;
      orders[idx].offerExpiresAt = null;
      orders[idx].acceptedAt = Date.now();
      updatedOrder = orders[idx];
    });

    if (statusError) {
      return res.status(400).json({ success: false, error: statusError });
    }
    if (!updatedOrder) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng!' });
    }

    scheduleUpsertOrder(updatedOrder, 'admin');
    if (telegramBot) telegramBot.sendOrderStatusUpdateNotification(updatedOrder).catch(e => console.error('Lỗi gửi Telegram gán đơn:', e.message));
    crm.logAdminAudit(req, 'order_assign', { orderId, shipperPhone: matchedShipper.phone });

    console.log(`[Admin Dispatch] 🎯 Admin đã chỉ định gán đơn ${orderId} cho tài xế ${matchedShipper.name} (${matchedShipper.phone})`);
    res.json({ success: true, data: updatedOrder });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/admin/orders/:id/status
 * Admin cập nhật trạng thái đơn theo state machine
 */
app.post('/api/admin/orders/:id/status', authenticateAdmin, async (req, res) => {
  try {
    const orderId = req.params.id;
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ success: false, error: 'Thiếu trạng thái!' });
    }

    let updatedOrder = null;
    let errMsg = null;
    await updateOrdersDatabase((orders) => {
      const idx = orders.findIndex(o => o.id === orderId);
      if (idx === -1) return false;
      const current = orders[idx].status;
      if (!canTransitionOrderStatus(current, status)) {
        errMsg = `Không thể chuyển từ ${current} sang ${status}`;
        return false;
      }
      orders[idx].status = status;
      if (status === 'ACCEPTED' && !orders[idx].acceptedAt) orders[idx].acceptedAt = Date.now();
      if (status === 'PURCHASED') orders[idx].purchasedAt = Date.now();
      if (status === 'DELIVERED') orders[idx].deliveredAt = Date.now();
      if (status === 'CANCELLED') {
        orders[idx].cancelledAt = Date.now();
        orders[idx].cancelReason = req.body.reason || 'Admin hủy';
      }
      updatedOrder = orders[idx];
    });

    if (errMsg) return res.status(400).json({ success: false, error: errMsg });
    if (!updatedOrder) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng!' });

    scheduleUpsertOrder(updatedOrder, 'admin');
    if (telegramBot) telegramBot.sendOrderStatusUpdateNotification(updatedOrder).catch(() => {});
    res.json({ success: true, data: updatedOrder });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/admin/orders/:id/cancel
 * Admin hủy đơn hàng
 */
app.post('/api/admin/orders/:id/cancel', authenticateAdmin, async (req, res) => {
  try {
    const orderId = req.params.id;
    const reason = req.body?.reason || 'Admin hủy đơn';

    let updatedOrder = null;
    let errMsg = null;
    await updateOrdersDatabase((orders) => {
      const idx = orders.findIndex(o => o.id === orderId);
      if (idx === -1) return false;
      if (orders[idx].status === 'DELIVERED' || orders[idx].status === 'CANCELLED') {
        errMsg = `Không thể hủy đơn ở trạng thái ${orders[idx].status}`;
        return false;
      }
      orders[idx].status = 'CANCELLED';
      orders[idx].cancelledAt = Date.now();
      orders[idx].cancelReason = reason;
      orders[idx].assignedShipperPhone = null;
      orders[idx].offerExpiresAt = null;
      updatedOrder = orders[idx];
    });

    if (errMsg) return res.status(400).json({ success: false, error: errMsg });
    if (!updatedOrder) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng!' });

    scheduleUpsertOrder(updatedOrder, 'admin');
    crm.notifyOrderCancelled(updatedOrder, addNotification);
    if (telegramBot) telegramBot.sendOrderStatusUpdateNotification(updatedOrder).catch(() => {});
    crm.logAdminAudit(req, 'order_cancel', { orderId, reason });
    console.log(`[Admin] ❌ Đã hủy đơn ${orderId}: ${reason}`);
    res.json({ success: true, data: updatedOrder });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/admin/orders/:id/reassign
 * Admin gán lại tài xế (PENDING hoặc ACCEPTED)
 */
app.post('/api/admin/orders/:id/reassign', authenticateAdmin, async (req, res) => {
  try {
    const orderId = req.params.id;
    const { shipperPhone } = req.body;
    if (!shipperPhone) {
      return res.status(400).json({ success: false, error: 'Thiếu số điện thoại tài xế!' });
    }

    const shippers = readShippersDatabase();
    const matchedShipper = shippers.find(s => cleanPhone(s.phone) === cleanPhone(shipperPhone));
    if (!matchedShipper) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy tài xế!' });
    }
    if (matchedShipper.status !== 'ONLINE') {
      return res.status(400).json({ success: false, error: 'Tài xế không đang ONLINE!' });
    }
    if (isShipperBusy(matchedShipper.phone, orderId)) {
      return res.status(400).json({ success: false, error: 'Tài xế đang có đơn chưa hoàn thành!' });
    }

    let updatedOrder = null;
    let errMsg = null;
    await updateOrdersDatabase((orders) => {
      const idx = orders.findIndex(o => o.id === orderId);
      if (idx === -1) return false;
      if (!['PENDING', 'ACCEPTED'].includes(orders[idx].status)) {
        errMsg = `Chỉ reassign được đơn PENDING/ACCEPTED (hiện tại: ${orders[idx].status})`;
        return false;
      }
      orders[idx].status = 'ACCEPTED';
      orders[idx].shipperId = matchedShipper.id || 'local-shipper-id';
      orders[idx].shipperName = matchedShipper.name;
      orders[idx].shipperPhone = matchedShipper.phone;
      orders[idx].assignedShipperPhone = null;
      orders[idx].offerExpiresAt = null;
      orders[idx].acceptedAt = Date.now();
      orders[idx].shipperLat = null;
      orders[idx].shipperLon = null;
      updatedOrder = orders[idx];
    });

    if (errMsg) return res.status(400).json({ success: false, error: errMsg });
    if (!updatedOrder) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng!' });

    scheduleUpsertOrder(updatedOrder, 'admin');
    if (telegramBot) telegramBot.sendOrderStatusUpdateNotification(updatedOrder).catch(() => {});
    console.log(`[Admin Reassign] 🔄 Đơn ${orderId} → ${matchedShipper.name}`);
    res.json({ success: true, data: updatedOrder });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/admin/orders/:id/live
 * Chi tiết đơn live: messages, GPS, call state
 */
app.get('/api/admin/orders/:id/live', authenticateAdmin, (req, res) => {
  try {
    const orderId = req.params.id;
    const orders = readOrdersDatabase();
    const order = orders.find(o => o.id === orderId);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng!' });
    }

    const call = activeCalls[orderId] || null;
    res.json({
      success: true,
      data: {
        ...enrichOrdersWithShipperAvatar(order, req),
        messages: order.messages || [],
        shipperLat: order.shipperLat ?? null,
        shipperLon: order.shipperLon ?? null,
        call: call ? { status: call.status, initiatedBy: call.initiatedBy, updatedAt: call.updatedAt } : null
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

}

module.exports = { registerAdminOrderRoutes };
