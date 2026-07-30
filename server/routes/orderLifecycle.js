'use strict';

function registerOrderLifecycleRoutes(app, ctx) {
  const {
  authenticateShipper,
  softAuthenticateBearer,
  ensureOrderInLocalCache,
  cleanPhone,
  readShippersDatabase,
  writeShippersDatabase,
  getShipperActiveOrderCount,
  MAX_ACTIVE_ORDERS_PER_SHIPPER,
  updateOrdersDatabase,
  scheduleUpsertOrder,
  telegramBot,
  supabase,
  canTransitionOrderStatus,
  onlineShipperLocations,
  validateShipperLocationUpdate,
  authorizeOrderAccess,
  generateTrackingToken,
  findNearestAvailableShipper,
  assignOfferToShipper,
  clearOrderOffer,
  realtimeHub,
  calcDistance,
  stripOrderSecrets,
  DELIVERY_PROXIMITY_KM,
  PICKUP_PROXIMITY_KM,
  touchShipperPresence,
  isShipperGpsInServiceArea,
  getClientIp,
  tripProximity,
  setOrderLiveGps,
  getOrderLiveGps,
  orderGpsLastPersistAt,
  ORDER_GPS_PERSIST_MS,
  readOrdersDatabase,
  crm,
  addNotification
  } = ctx;
  const telegramNotify = telegramBot;

  function notifyCustomerPush(order, title, body) {
    try {
      const portal = require('../customerPortal');
      const phones = [order.ordererPhone, order.deliveryPhone]
        .map((p) => portal.cleanPhone(p))
        .filter(Boolean);
      const unique = [...new Set(phones)];
      const payload = {
        title: title || 'ShipFee',
        body: body || '',
        url: order.id
          ? `/customer-app/tracking.html?orderId=${encodeURIComponent(order.id)}${order.trackingToken ? `&token=${encodeURIComponent(order.trackingToken)}` : ''}`
          : '/customer-app/',
        orderId: order.id,
        status: order.status
      };
      unique.forEach((phone) => {
        portal.sendPushToPhone(phone, payload).catch(() => {});
      });
    } catch (_) {}
  }

app.post('/api/orders/:id/accept', authenticateShipper, async (req, res) => {
  try {
    const { id } = req.params;
    if (!(await ensureOrderInLocalCache(id))) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
    }
    const authPhone = req.shipperPhone;
    if (!authPhone) {
      return res.status(403).json({ success: false, error: 'Không xác định được tài xế từ token!' });
    }

    const shippers = readShippersDatabase();
    const matchedShipper = req.shipper || shippers.find(s => cleanPhone(s.phone) === authPhone);
    if (!matchedShipper) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy hồ sơ tài xế!' });
    }

    if (getShipperActiveOrderCount(authPhone) >= MAX_ACTIVE_ORDERS_PER_SHIPPER) {
      return res.status(409).json({ success: false, error: `Bạn đang mang tối đa ${MAX_ACTIVE_ORDERS_PER_SHIPPER} đơn. Hãy hoàn thành một đơn trước.` });
    }

    // Shipper-specific blacklist
    try {
      const customerOps = require('../customerOps');
      const snap = (typeof readOrdersDatabase === 'function' ? readOrdersDatabase() : []).find(o => o && o.id === id);
      const cust = snap ? cleanPhone(snap.deliveryPhone || snap.ordererPhone) : '';
      if (cust && customerOps.isShipperBlacklistedCustomer(authPhone, cust)) {
        return res.status(403).json({
          success: false,
          error: 'Bạn đã chặn khách hàng này. Không thể nhận đơn.'
        });
      }
    } catch (_) {}

    let updatedOrder = null;
    let found = false;
    let alreadyAccepted = false;
    let offerMismatch = false;
    let offerExpired = false;

    await updateOrdersDatabase((orders) => {
      const idx = orders.findIndex(o => o.id === id);
      if (idx !== -1) {
        found = true;
        if (orders[idx].status !== 'PENDING') {
          alreadyAccepted = true;
          return false;
        }
        const assigned = cleanPhone(orders[idx].assignedShipperPhone);
        const expiresAt = orders[idx].offerExpiresAt;
        // Chỉ nhận đơn đang được đề xuất đúng tài xế (không public pool)
        if (!assigned || assigned !== authPhone) {
          offerMismatch = true;
          return false;
        }
        if (!expiresAt || Date.now() > expiresAt) {
          offerExpired = true;
          return false;
        }
        if (getShipperActiveOrderCount(authPhone, orders) >= MAX_ACTIVE_ORDERS_PER_SHIPPER) {
          return false;
        }
        orders[idx].status = 'ACCEPTED';
        orders[idx].acceptedAt = Date.now();
        orders[idx].shipperId = matchedShipper.id || 'shipper-default';
        orders[idx].shipperName = matchedShipper.name;
        orders[idx].shipperPhone = matchedShipper.phone;
        // Gắn GPS hiện tại của tài xế (nếu đang online) để khách thấy vị trí thật ngay
        const liveLoc = onlineShipperLocations.get(authPhone);
        if (liveLoc && Number.isFinite(liveLoc.lat) && Number.isFinite(liveLoc.lon)) {
          orders[idx].shipperLat = liveLoc.lat;
          orders[idx].shipperLon = liveLoc.lon;
        }
        clearOrderOffer(orders[idx]);
        updatedOrder = orders[idx];
      } else {
        return false;
      }
    });

    if (!found) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }
    if (alreadyAccepted) {
      return res.status(400).json({ success: false, error: 'Đơn hàng đã được nhận bởi tài xế khác!' });
    }
    if (offerMismatch) {
      return res.status(403).json({ success: false, error: 'Đơn này không được đề xuất cho bạn. Hệ thống chỉ phát đơn đích danh.' });
    }
    if (offerExpired) {
      return res.status(410).json({ success: false, error: 'Đề xuất đơn đã hết hạn. Vui lòng chờ đề xuất mới.' });
    }
    if (!updatedOrder) {
      return res.status(409).json({ success: false, error: `Bạn đang mang tối đa ${MAX_ACTIVE_ORDERS_PER_SHIPPER} đơn.` });
    }

    console.log(`[Order Server] 🛵 Shipper đã nhận đơn: ${id}`);
    
    // Tắt cờ yêu cầu hỗ trợ tìm đơn của tài xế này sau khi nhận đơn thành công
    try {
      const shippersDb = readShippersDatabase();
      const sIdx = shippersDb.findIndex(s => cleanPhone(s.phone) === authPhone);
      if (sIdx !== -1 && shippersDb[sIdx].assistanceRequested) {
        shippersDb[sIdx].assistanceRequested = false;
        writeShippersDatabase(shippersDb);
        console.log(`[Priority Dispatch] 🟢 Đã tắt cờ hỗ trợ tìm đơn cho shipper ${shippersDb[sIdx].name} vì đã nhận đơn thành công.`);
        
        if (supabase && shippersDb[sIdx].id) {
          supabase
            .from('shipper_profiles')
            .update({ assistance_requested: false })
            .eq('id', shippersDb[sIdx].id)
            .then(({ error }) => {
              if (error) console.warn('[Supabase Sync] Lỗi dọn cờ hỗ trợ:', error.message);
            })
            .catch(err => console.warn('[Supabase Sync] Lỗi dọn cờ hỗ trợ:', err.message));
        }
      }
    } catch (err) {
      console.error('[Assistance Clean Error] Lỗi dọn dẹp cờ hỗ trợ tìm đơn:', err.message);
    }

    scheduleUpsertOrder(updatedOrder, 'accept');
    if (telegramNotify) telegramNotify.sendOrderStatusUpdateNotification(updatedOrder).catch(e => console.error('Lỗi gửi Telegram nhận đơn:', e.message));
    notifyCustomerPush(
      updatedOrder,
      'Tài xế đã nhận đơn',
      `${updatedOrder.shipperName || 'Tài xế'} đang đến quán lấy món.`
    );
    res.json({ success: true, data: stripOrderSecrets(updatedOrder, { keepTrackingToken: false }) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/orders/:id/status
 * Shipper cập nhật trạng thái đơn (PURCHASED hoặc DELIVERED, ghi nhận thời gian tương ứng)
 */
app.post('/api/orders/:id/status', authenticateShipper, async (req, res) => {
  try {
    const { id } = req.params;
    if (!(await ensureOrderInLocalCache(id))) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }
    const { status } = req.body;
    const authPhone = req.shipperPhone;
    const bodyLat = Number(req.body?.lat);
    const bodyLon = Number(req.body?.lon);

    if (!['PURCHASED', 'DELIVERED'].includes(status)) {
      return res.status(400).json({ error: 'Trạng thái không hợp lệ. Chỉ cho phép PURCHASED hoặc DELIVERED.' });
    }

    let updatedOrder = null;
    let found = false;
    let transitionError = null;

    await updateOrdersDatabase((orders) => {
      const idx = orders.findIndex(o => o.id === id);
      if (idx === -1) {
        return false;
      }
      found = true;
      const current = orders[idx].status;
      if (!canTransitionOrderStatus(current, status)) {
        transitionError = `Không thể chuyển từ ${current} sang ${status}`;
        return false;
      }
      if (cleanPhone(orders[idx].shipperPhone) !== cleanPhone(authPhone)) {
        transitionError = 'Bạn không phải tài xế của đơn này';
        return false;
      }

      // GPS: body (mới) → live map tươi → từ chối stale order fields
      const cleanedAuth = cleanPhone(authPhone);
      const live = onlineShipperLocations.get(cleanedAuth);
      let sLat = Number.isFinite(bodyLat) ? bodyLat : NaN;
      let sLon = Number.isFinite(bodyLon) ? bodyLon : NaN;
      let gpsAgeMs = 0;
      if (!Number.isFinite(sLat) || !Number.isFinite(sLon)) {
        if (live && Number.isFinite(live.lat) && Number.isFinite(live.lon)) {
          sLat = live.lat;
          sLon = live.lon;
          gpsAgeMs = Math.max(0, Date.now() - (live.lastSeen || 0));
        }
      }

      const proximity = tripProximity && typeof tripProximity.assertTripProximity === 'function'
        ? tripProximity.assertTripProximity({
          status,
          order: orders[idx],
          lat: sLat,
          lon: sLon,
          gpsAgeMs,
          calcDistance
        })
        : { ok: true };
      if (!proximity.ok) {
        transitionError = proximity.error || 'Chưa đủ gần điểm đích';
        return false;
      }

      orders[idx].status = status;
      if (Number.isFinite(sLat) && Number.isFinite(sLon)) {
        orders[idx].shipperLat = sLat;
        orders[idx].shipperLon = sLon;
      }
      if (status === 'PURCHASED') {
        orders[idx].purchasedAt = Date.now();
      } else if (status === 'DELIVERED') {
        orders[idx].deliveredAt = Date.now();
      }
      updatedOrder = orders[idx];
    });

    if (!found) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }
    if (transitionError) {
      return res.status(400).json({ success: false, error: transitionError });
    }

    console.log(`[Order Server] 🔄 Cập nhật trạng thái đơn ${id} thành: ${status}`);
    if (updatedOrder && Number.isFinite(Number(updatedOrder.shipperLat)) && Number.isFinite(Number(updatedOrder.shipperLon))) {
      if (typeof setOrderLiveGps === 'function') {
        setOrderLiveGps(id, updatedOrder.shipperLat, updatedOrder.shipperLon, cleanPhone(authPhone));
      }
      try {
        realtimeHub.publishLocationUpdate(id, {
          lat: updatedOrder.shipperLat,
          lon: updatedOrder.shipperLon,
          at: Date.now()
        }, {
          shipperPhone: updatedOrder.shipperPhone,
          assignedShipperPhone: updatedOrder.assignedShipperPhone
        });
      } catch (_) {}
    }
    scheduleUpsertOrder(updatedOrder, 'status');
    if (telegramNotify) telegramNotify.sendOrderStatusUpdateNotification(updatedOrder).catch(e => console.error('Lỗi gửi Telegram cập nhật đơn:', e.message));
    if (status === 'PURCHASED') {
      notifyCustomerPush(updatedOrder, 'Đang giao đến bạn', 'Tài xế đã mua xong và đang trên đường giao.');
    } else if (status === 'DELIVERED') {
      notifyCustomerPush(updatedOrder, 'Giao hàng thành công', 'Cảm ơn bạn đã đặt ShipFee. Hãy đánh giá tài xế nhé!');
    }
    if (status === 'DELIVERED' && updatedOrder) {
      try {
        require('../customerOps').onOrderDelivered(updatedOrder, {
          telegramBot: telegramNotify || telegramBot,
          crm,
          addNotification
        });
      } catch (e) {
        console.warn('[CustomerOps] onOrderDelivered:', e.message);
      }
    }
    res.json({ success: true, data: stripOrderSecrets(updatedOrder, { keepTrackingToken: false, forShipper: true }) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/orders/:id/location
 * GPS realtime: SSE location_updated ngay; persist JSON thưa (tránh ghi disk mỗi 3s).
 */
app.post('/api/orders/:id/location', authenticateShipper, async (req, res) => {
  try {
    const { id } = req.params;
    if (!(await ensureOrderInLocalCache(id))) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }
    const lat = Number(req.body?.lat);
    const lon = Number(req.body?.lon);
    const accuracy = Number(req.body?.accuracy);
    const authPhone = cleanPhone(req.shipperPhone);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: 'Tọa độ không hợp lệ' });
    }

    const validated = validateShipperLocationUpdate(authPhone, lat, lon, { requireServiceArea: false });
    if (!validated.ok) {
      return res.status(400).json({
        success: false,
        error: validated.error,
        code: validated.code
      });
    }

    const ordersSnap = typeof readOrdersDatabase === 'function' ? readOrdersDatabase() : [];
    const orderSnap = (ordersSnap || []).find(o => o && String(o.id) === String(id));
    if (!orderSnap) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }
    if (cleanPhone(orderSnap.shipperPhone) !== authPhone) {
      return res.status(403).json({ success: false, error: 'Bạn không phải tài xế của đơn này' });
    }

    const live = typeof setOrderLiveGps === 'function'
      ? setOrderLiveGps(id, lat, lon, authPhone)
      : { lat, lon, at: Date.now(), phone: authPhone };

    // Dispatch presence map (kể cả ngoài service area khi đang giao — vẫn track)
    const nowMs = Date.now();
    onlineShipperLocations.set(authPhone, {
      lat,
      lon,
      accuracy: Number.isFinite(accuracy) ? accuracy : null,
      lastSeen: nowMs,
      ip: getClientIp(req) || null
    });
    if (typeof touchShipperPresence === 'function') {
      touchShipperPresence(authPhone, 'order-gps');
    }

    try {
      realtimeHub.publishLocationUpdate(id, {
        lat,
        lon,
        at: live.at,
        accuracy: Number.isFinite(accuracy) ? accuracy : null
      }, {
        shipperPhone: orderSnap.shipperPhone,
        assignedShipperPhone: orderSnap.assignedShipperPhone
      });
    } catch (_) {}

    // Persist thưa vào orders JSON (+ order_updated cho client chưa có location SSE)
    const persistEvery = Number(ORDER_GPS_PERSIST_MS) || 15000;
    const lastPersist = orderGpsLastPersistAt instanceof Map
      ? (orderGpsLastPersistAt.get(String(id)) || 0)
      : 0;
    const shouldPersist = !lastPersist || (nowMs - lastPersist) >= persistEvery;
    let updatedOrder = null;
    if (shouldPersist) {
      await updateOrdersDatabase((orders) => {
        const idx = orders.findIndex(o => o.id === id);
        if (idx === -1) return false;
        if (cleanPhone(orders[idx].shipperPhone) !== authPhone) return false;
        orders[idx].shipperLat = lat;
        orders[idx].shipperLon = lon;
        orders[idx].shipperGpsAt = nowMs;
        updatedOrder = orders[idx];
      });
      if (orderGpsLastPersistAt instanceof Map) {
        orderGpsLastPersistAt.set(String(id), nowMs);
      }
      if (isShipperGpsInServiceArea(lat, lon)) {
        const shippersDb = readShippersDatabase();
        const sIdx = shippersDb.findIndex(s => cleanPhone(s.phone) === authPhone);
        if (sIdx !== -1) {
          const prevAt = Number(shippersDb[sIdx].lastLocationAt) || 0;
          if (!prevAt || (nowMs - prevAt) >= 20000) {
            shippersDb[sIdx].lastLat = lat;
            shippersDb[sIdx].lastLon = lon;
            shippersDb[sIdx].lastLocationAt = nowMs;
            writeShippersDatabase(shippersDb);
          }
        }
      }
    }

    res.json({
      success: true,
      data: updatedOrder
        ? stripOrderSecrets(updatedOrder, { keepTrackingToken: false })
        : {
          id,
          shipperLat: lat,
          shipperLon: lon,
          shipperGpsAt: live.at
        },
      persisted: shouldPersist
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/orders/:id/rate
 * Khách hàng gửi đánh giá — cần tracking token
 */
app.post('/api/orders/:id/rate', async (req, res) => {
  try {
    await softAuthenticateBearer(req);
    const { id } = req.params;
    const { rating, comment } = req.body;

    if (typeof rating !== 'number' || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Đánh giá rating phải từ 1 đến 5' });
    }

    if (!(await ensureOrderInLocalCache(id))) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }

    const orders = readOrdersDatabase();
    const existing = orders.find(o => o.id === id);
    if (!existing) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }
    const authz = authorizeOrderAccess(req, existing);
    if (!authz.ok || authz.role === 'shipper') {
      return res.status(authz.ok ? 403 : authz.status).json({
        success: false,
        error: authz.ok ? 'Chỉ khách hàng được đánh giá đơn' : authz.error
      });
    }

    let found = false;
    let updatedOrder = null;

    await updateOrdersDatabase((orders) => {
      const idx = orders.findIndex(o => o.id === id);
      if (idx !== -1) {
        found = true;
        if (authz.mintToken && !orders[idx].trackingToken) {
          orders[idx].trackingToken = generateTrackingToken();
        }
        orders[idx].rating = rating;
        orders[idx].comment = String(comment || '').slice(0, 500);
        updatedOrder = orders[idx];
      } else {
        return false;
      }
    });

    if (!found) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }

    const commentPreview = (comment && String(comment).trim())
      ? String(comment).trim().slice(0, 80)
      : '(không có ý kiến)';
    console.log(`[Order Server] ⭐ Khách hàng đánh giá đơn ${id}: ${rating} sao — ${commentPreview}`);
    res.json({
      success: true,
      data: stripOrderSecrets(updatedOrder, { keepTrackingToken: true })
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/orders/:id/messages
 * Gửi tin nhắn — tracking token (khách) hoặc JWT shipper gắn đơn
 */
app.post('/api/orders/:id/messages', async (req, res) => {
  try {
    await softAuthenticateBearer(req);
    const { id } = req.params;
    let { sender, text } = req.body;

    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: 'Thiếu nội dung tin nhắn (text)' });
    }
    text = String(text).trim().slice(0, 1000);

    if (!(await ensureOrderInLocalCache(id))) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }

    const ordersSnap = readOrdersDatabase();
    const existing = ordersSnap.find(o => o.id === id);
    if (!existing) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }
    const authz = authorizeOrderAccess(req, existing);
    if (!authz.ok) {
      return res.status(authz.status).json({ success: false, error: authz.error });
    }

    if (authz.role === 'customer') sender = 'customer';
    else if (authz.role === 'shipper') sender = 'shipper';
    else if (authz.role === 'admin') sender = 'Admin';
    else {
      return res.status(403).json({ success: false, error: 'Không có quyền gửi tin nhắn trên đơn này' });
    }

    let updatedOrder = null;
    let found = false;

    await updateOrdersDatabase((orders) => {
      const idx = orders.findIndex(o => o.id === id);
      if (idx !== -1) {
        found = true;
        if (authz.mintToken && !orders[idx].trackingToken) {
          orders[idx].trackingToken = generateTrackingToken();
        }
        if (!orders[idx].messages) {
          orders[idx].messages = [];
        }
        if (orders[idx].messages.length > 200) {
          orders[idx].messages = orders[idx].messages.slice(-150);
        }
        orders[idx].messages.push({
          sender,
          role: authz.role,
          text,
          timestamp: Date.now()
        });
        updatedOrder = orders[idx];
      } else {
        return false;
      }
    });

    if (!found) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }

    console.log(`[Order Server] 💬 [Đơn ${id}] ${sender}: ${text}`);
    res.json({ success: true, messages: updatedOrder.messages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.post('/api/orders/:id/decline', authenticateShipper, async (req, res) => {
  try {
    const { id } = req.params;
    if (!(await ensureOrderInLocalCache(id))) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng hoặc đơn không ở trạng thái chờ nhận!' });
    }
    const cleanedPhone = cleanPhone(req.shipperPhone || req.body?.phone);

    if (!cleanedPhone) {
      return res.status(400).json({ success: false, error: 'Thiếu số điện thoại tài xế!' });
    }

    let found = false;
    let updatedOrder = null;
    let forbidden = false;

    await updateOrdersDatabase((orders) => {
      const idx = orders.findIndex(o => o.id === id);
      if (idx !== -1 && orders[idx].status === 'PENDING') {
        const assigned = cleanPhone(orders[idx].assignedShipperPhone);
        if (!assigned || assigned !== cleanedPhone) {
          forbidden = true;
          return false;
        }
        found = true;
        
        // Add to declined list
        orders[idx].declinedShippers = orders[idx].declinedShippers || [];
        if (!orders[idx].declinedShippers.includes(cleanedPhone)) {
          orders[idx].declinedShippers.push(cleanedPhone);
        }

        console.log(`[Dispatch] ❌ Tài xế ${cleanedPhone} đã từ chối đơn hàng ${id}`);

        // Try to find the next nearest driver
        const nextNearest = findNearestAvailableShipper(
          orders[idx].restaurantLat,
          orders[idx].restaurantLon,
          orders[idx].declinedShippers,
          orders[idx]
        );
        if (nextNearest) {
          assignOfferToShipper(orders[idx], nextNearest);
          console.log(`[Dispatch] 🎯 Đơn ${orders[idx].id} chuyển tiếp đề xuất cho ${nextNearest.name} (${nextNearest.phone})`);
        } else {
          clearOrderOffer(orders[idx]);
          console.log(`[Dispatch] ⏳ Đơn ${orders[idx].id} chờ đề xuất lại (ẩn bể chung)`);
        }

        updatedOrder = orders[idx];
      } else {
        return false;
      }
    });

    if (forbidden) {
      return res.status(403).json({ success: false, error: 'Bạn không phải tài xế được đề xuất đơn này!' });
    }

    if (!found) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng hoặc đơn không ở trạng thái chờ nhận!' });
    }

    res.json({ success: true, data: stripOrderSecrets(updatedOrder, { keepTrackingToken: false }) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/orders/:id/disputes
 * Khách xem khiếu nại gắn đơn (tracking token)
 */
app.get('/api/orders/:id/disputes', async (req, res) => {
  try {
    if (!crm || typeof crm.readDisputes !== 'function') {
      return res.status(503).json({ success: false, error: 'Module khiếu nại chưa sẵn sàng' });
    }
    await softAuthenticateBearer(req);
    const { id } = req.params;
    if (!(await ensureOrderInLocalCache(id))) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
    }
    const ordersSnap = readOrdersDatabase();
    const order = (ordersSnap || []).find(o => o && String(o.id) === String(id));
    if (!order) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });

    const authz = authorizeOrderAccess(req, order);
    if (!authz.ok || authz.role === 'shipper') {
      return res.status(authz.ok ? 403 : authz.status).json({
        success: false,
        error: authz.ok ? 'Chỉ khách hàng / admin xem khiếu nại đơn này' : authz.error
      });
    }

    const list = (crm.readDisputes() || [])
      .filter(d => d && String(d.orderId) === String(id))
      .map((d) => ({
        id: d.id,
        orderId: d.orderId,
        status: d.status,
        reason: d.reason,
        source: d.source || null,
        messages: d.messages || [],
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        resolvedAt: d.resolvedAt || null
      }));
    res.json({ success: true, data: list });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/orders/:id/disputes
 * Khách tạo khiếu nại (tracking token)
 */
app.post('/api/orders/:id/disputes', async (req, res) => {
  try {
    if (!crm || typeof crm.readDisputes !== 'function') {
      return res.status(503).json({ success: false, error: 'Module khiếu nại chưa sẵn sàng' });
    }
    await softAuthenticateBearer(req);
    const { id } = req.params;
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    if (!reason) {
      return res.status(400).json({ success: false, error: 'Vui lòng nhập lý do khiếu nại' });
    }
    if (!(await ensureOrderInLocalCache(id))) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
    }
    const ordersSnap = readOrdersDatabase();
    const order = (ordersSnap || []).find(o => o && String(o.id) === String(id));
    if (!order) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });

    const authz = authorizeOrderAccess(req, order);
    if (!authz.ok || authz.role !== 'customer') {
      return res.status(authz.ok ? 403 : authz.status).json({
        success: false,
        error: authz.ok ? 'Chỉ khách hàng được tạo khiếu nại trên đơn này' : authz.error
      });
    }

    const disputes = crm.readDisputes() || [];
    const openExisting = disputes.find(d => d && String(d.orderId) === String(id) && d.status === 'open');
    if (openExisting) {
      return res.status(409).json({
        success: false,
        error: 'Đơn này đã có khiếu nại đang mở',
        data: {
          id: openExisting.id,
          status: openExisting.status,
          reason: openExisting.reason
        }
      });
    }

    const ticket = {
      id: 'disp-' + Date.now() + '-' + Math.floor(1000 + Math.random() * 9000),
      orderId: id,
      status: 'open',
      reason,
      source: 'customer',
      customerPhone: order.deliveryPhone || order.ordererPhone || null,
      messages: [{
        role: 'customer',
        sender: 'customer',
        text: reason,
        createdAt: Date.now()
      }],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    disputes.unshift(ticket);
    crm.writeDisputes(disputes);

    await updateOrdersDatabase((orders) => {
      const idx = orders.findIndex(o => o.id === id);
      if (idx === -1) return false;
      if (authz.mintToken && !orders[idx].trackingToken) {
        orders[idx].trackingToken = generateTrackingToken();
      }
      orders[idx].messages = orders[idx].messages || [];
      orders[idx].messages.push({
        sender: 'customer',
        role: 'customer',
        text: `[Khiếu nại] ${reason}`,
        timestamp: Date.now()
      });
      return true;
    });

    if (typeof addNotification === 'function') {
      addNotification(
        'dispute_open',
        order.restaurantId || null,
        order.restaurantName || '',
        'Khiếu nại mới từ khách',
        `Đơn ${id}: ${reason.slice(0, 120)}`
      );
    }
    if (telegramNotify && typeof telegramNotify.sendDisputeNotification === 'function') {
      telegramNotify.sendDisputeNotification(ticket).catch(e => console.error('Lỗi Telegram dispute:', e.message));
    }

    console.log(`[Order Server] ⚖️ Khách tạo khiếu nại ${ticket.id} cho đơn ${id}`);
    res.json({ success: true, data: ticket });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/orders/:id/disputes/:disputeId/messages
 * Khách trả lời trong ticket khiếu nại
 */
app.post('/api/orders/:id/disputes/:disputeId/messages', async (req, res) => {
  try {
    if (!crm || typeof crm.readDisputes !== 'function') {
      return res.status(503).json({ success: false, error: 'Module khiếu nại chưa sẵn sàng' });
    }
    await softAuthenticateBearer(req);
    const { id, disputeId } = req.params;
    const text = String(req.body?.text || '').trim().slice(0, 1000);
    if (!text) {
      return res.status(400).json({ success: false, error: 'Thiếu nội dung tin nhắn' });
    }
    if (!(await ensureOrderInLocalCache(id))) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
    }
    const ordersSnap = readOrdersDatabase();
    const order = (ordersSnap || []).find(o => o && String(o.id) === String(id));
    if (!order) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });

    const authz = authorizeOrderAccess(req, order);
    if (!authz.ok || authz.role !== 'customer') {
      return res.status(authz.ok ? 403 : authz.status).json({
        success: false,
        error: authz.ok ? 'Chỉ khách hàng được trả lời khiếu nại này' : authz.error
      });
    }

    const disputes = crm.readDisputes() || [];
    const idx = disputes.findIndex(d => d && d.id === disputeId && String(d.orderId) === String(id));
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy ticket khiếu nại' });
    }
    if (disputes[idx].status === 'resolved') {
      return res.status(400).json({ success: false, error: 'Ticket đã đóng — không thể gửi thêm' });
    }

    const msg = {
      role: 'customer',
      sender: 'customer',
      text,
      createdAt: Date.now()
    };
    disputes[idx].messages = disputes[idx].messages || [];
    disputes[idx].messages.push(msg);
    disputes[idx].updatedAt = Date.now();
    crm.writeDisputes(disputes);

    res.json({ success: true, data: disputes[idx] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


}

module.exports = { registerOrderLifecycleRoutes };
