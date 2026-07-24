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
  PICKUP_PROXIMITY_KM
  } = ctx;

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
    if (telegramBot) telegramBot.sendOrderStatusUpdateNotification(updatedOrder).catch(e => console.error('Lỗi gửi Telegram nhận đơn:', e.message));
    res.json({ success: true, data: updatedOrder });
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

      // Chặn hoàn thành / lấy hàng khi GPS chưa gần điểm đích
      const cleanedAuth = cleanPhone(authPhone);
      const live = onlineShipperLocations.get(cleanedAuth);
      let sLat = Number.isFinite(bodyLat) ? bodyLat : NaN;
      let sLon = Number.isFinite(bodyLon) ? bodyLon : NaN;
      if (!Number.isFinite(sLat) || !Number.isFinite(sLon)) {
        if (live && Number.isFinite(live.lat) && Number.isFinite(live.lon)) {
          sLat = live.lat;
          sLon = live.lon;
        } else {
          sLat = Number(orders[idx].shipperLat);
          sLon = Number(orders[idx].shipperLon);
        }
      }

      if (status === 'DELIVERED') {
        const destLat = Number(orders[idx].pinnedLat ?? orders[idx].deliveryLat);
        const destLon = Number(orders[idx].pinnedLon ?? orders[idx].deliveryLon);
        if (Number.isFinite(destLat) && Number.isFinite(destLon)) {
          if (!Number.isFinite(sLat) || !Number.isFinite(sLon)) {
            transitionError = 'Cần GPS để hoàn thành đơn. Bật định vị và thử lại.';
            return false;
          }
          const distKm = calcDistance(sLat, sLon, destLat, destLon);
          if (distKm > DELIVERY_PROXIMITY_KM) {
            transitionError =
              `Bạn còn cách điểm giao khoảng ${Math.round(distKm * 1000)}m. ` +
              `Hãy đến trong ${Math.round(DELIVERY_PROXIMITY_KM * 1000)}m rồi hoàn thành.`;
            return false;
          }
        }
      } else if (status === 'PURCHASED') {
        const restExact = orders[idx].restaurantCoordsExact === true;
        const restLat = Number(orders[idx].restaurantLat);
        const restLon = Number(orders[idx].restaurantLon);
        if (restExact && Number.isFinite(restLat) && Number.isFinite(restLon)) {
          if (!Number.isFinite(sLat) || !Number.isFinite(sLon)) {
            transitionError = 'Cần GPS để xác nhận lấy hàng. Bật định vị và thử lại.';
            return false;
          }
          const distKm = calcDistance(sLat, sLon, restLat, restLon);
          if (distKm > PICKUP_PROXIMITY_KM) {
            transitionError =
              `Bạn còn cách quán khoảng ${Math.round(distKm * 1000)}m. ` +
              `Hãy đến trong ${Math.round(PICKUP_PROXIMITY_KM * 1000)}m rồi xác nhận lấy hàng.`;
            return false;
          }
        }
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
    scheduleUpsertOrder(updatedOrder, 'status');
    if (telegramBot) telegramBot.sendOrderStatusUpdateNotification(updatedOrder).catch(e => console.error('Lỗi gửi Telegram cập nhật đơn:', e.message));
    res.json({ success: true, data: updatedOrder });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/orders/:id/location
 * Shipper cập nhật tọa độ GPS thời gian thực (shipperLat, shipperLon) lên server
 */
app.post('/api/orders/:id/location', authenticateShipper, async (req, res) => {
  try {
    const { id } = req.params;
    if (!(await ensureOrderInLocalCache(id))) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }
    const lat = Number(req.body?.lat);
    const lon = Number(req.body?.lon);
    const authPhone = cleanPhone(req.shipperPhone);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: 'Tọa độ không hợp lệ' });
    }

    // Đơn đang giao: chỉ chặn nhảy GPS bất thường (không siết bán kính như lúc rảnh)
    const validated = validateShipperLocationUpdate(authPhone, lat, lon, { requireServiceArea: false });
    if (!validated.ok) {
      return res.status(400).json({
        success: false,
        error: validated.error,
        code: validated.code
      });
    }

    let found = false;
    let updatedOrder = null;
    let forbidden = false;

    await updateOrdersDatabase((orders) => {
      const idx = orders.findIndex(o => o.id === id);
      if (idx !== -1) {
        found = true;
        if (cleanPhone(orders[idx].shipperPhone) !== authPhone) {
          forbidden = true;
          return false;
        }
        orders[idx].shipperLat = lat;
        orders[idx].shipperLon = lon;
        updatedOrder = orders[idx];
      } else {
        return false;
      }
    });

    if (!found) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }
    if (forbidden) {
      return res.status(403).json({ success: false, error: 'Bạn không phải tài xế của đơn này' });
    }

    // Mirror into dispatch map only when still inside service area
    if (isShipperGpsInServiceArea(lat, lon)) {
      const nowMs = Date.now();
      onlineShipperLocations.set(authPhone, {
        lat,
        lon,
        lastSeen: nowMs,
        ip: getClientIp(req) || null
      });
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

    res.json({ success: true, data: updatedOrder });
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
    else if (!sender || !['customer', 'shipper'].includes(sender)) {
      return res.status(400).json({ error: 'sender phải là customer hoặc shipper' });
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

    res.json({ success: true, data: updatedOrder });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


}

module.exports = { registerOrderLifecycleRoutes };
