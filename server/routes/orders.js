'use strict';

/**
 * Order HTTP routes (shipper list + customer/shipper detail).
 * Business helpers stay in server.js; this module owns the Express wiring.
 */

function registerOrderRoutes(app, ctx) {
  const {
    authenticateShipper,
    softAuthenticateBearer,
    authorizeOrderAccess,
    generateTrackingToken,
    stripOrderSecrets,
    enrichOrdersWithShipperAvatar,
    hydrateOrdersRestaurantCoords,
    hydrateOrderRestaurantCoords,
    readOrdersDatabase,
    updateOrdersDatabase,
    findOrderById,
    cleanPhone,
    scheduleOrdersRestaurantNavGpsAfterOffer,
    onlineShipperLocations
  } = ctx;

  /**
   * GET /api/orders
   * Danh sách đơn của tài xế (JWT) — offer PENDING + đơn đã nhận
   */
  app.get('/api/orders', authenticateShipper, async (req, res) => {
    try {
      const { status } = req.query;
      let orders = readOrdersDatabase();
      const now = Date.now();
      const cleanInputPhone = cleanPhone(req.shipperPhone);
      if (!cleanInputPhone) {
        return res.status(403).json({ success: false, error: 'Không xác định được tài xế từ token' });
      }

      let resultData = orders.filter((o) => {
        if (o.status === 'PENDING') {
          if (!o.assignedShipperPhone || !o.offerExpiresAt) return false;
          return cleanPhone(o.assignedShipperPhone) === cleanInputPhone && now <= o.offerExpiresAt;
        }
        return cleanPhone(o.shipperPhone) === cleanInputPhone;
      });
      if (status) {
        resultData = resultData.filter((o) => o.status === status);
      }

      const sanitized = enrichOrdersWithShipperAvatar(
        hydrateOrdersRestaurantCoords(resultData),
        req
      ).map((o) => stripOrderSecrets(o, { keepTrackingToken: false }));

      res.json({ success: true, data: sanitized });
      scheduleOrdersRestaurantNavGpsAfterOffer(resultData, { label: 'list' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /api/orders/:id
   * Chi tiết đơn — tracking token (khách) hoặc JWT shipper/admin.
   * Read-through Supabase nếu thiếu trên local (sau redeploy).
   */
  app.get('/api/orders/:id', async (req, res) => {
    try {
      await softAuthenticateBearer(req);
      const { id } = req.params;
      const order = await findOrderById(id);
      if (!order) {
        return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
      }

      const authz = authorizeOrderAccess(req, order);
      if (!authz.ok) {
        return res.status(authz.status).json({ success: false, error: authz.error });
      }

      if (authz.mintToken) {
        order.trackingToken = generateTrackingToken();
        await updateOrdersDatabase((list) => {
          const idx = list.findIndex((o) => o.id === id);
          if (idx !== -1) list[idx].trackingToken = order.trackingToken;
          else return false;
        });
      }

      const payload = { ...order };
      const hasGps = Number.isFinite(Number(payload.shipperLat)) && Number.isFinite(Number(payload.shipperLon));
      if (!hasGps && payload.shipperPhone) {
        const liveLoc = onlineShipperLocations.get(cleanPhone(payload.shipperPhone));
        if (liveLoc && Number.isFinite(liveLoc.lat) && Number.isFinite(liveLoc.lon)) {
          payload.shipperLat = liveLoc.lat;
          payload.shipperLon = liveLoc.lon;
        }
      }

      const keepToken = authz.role === 'customer';
      res.json({
        success: true,
        data: stripOrderSecrets(
          enrichOrdersWithShipperAvatar(hydrateOrderRestaurantCoords(payload), req),
          { keepTrackingToken: keepToken }
        )
      });
      scheduleOrdersRestaurantNavGpsAfterOffer([order], { label: 'detail' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerOrderRoutes };
