'use strict';

/**
 * Customer portal HTTP routes.
 */
function registerCustomerPortalRoutes(app, ctx) {
  const {
    rateLimitAuth,
    rateLimitStrict,
    readOrdersDatabase,
    mergeOrdersFromSupabaseForRange,
    ORDER_HISTORY_RETENTION_DAYS,
    cleanPhone
  } = ctx;
  const portal = require('../customerPortal');
  const customerOps = require('../customerOps');

  app.post('/api/customer/otp/request', rateLimitAuth, async (req, res) => {
    try {
      const result = await portal.requestOtp(req.body?.phone);
      if (!result.ok) return res.status(400).json({ success: false, error: result.error });
      res.json({
        success: true,
        data: {
          phone: result.phone,
          expiresInSec: result.expiresInSec,
          delivery: result.delivery || 'inline',
          message: result.message,
          code: result.code || result.demoCode,
          demoCode: result.demoCode || result.code
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/customer/otp/verify', rateLimitAuth, (req, res) => {
    try {
      const result = portal.verifyOtp(req.body?.phone, req.body?.code, { name: req.body?.name });
      if (!result.ok) return res.status(400).json({ success: false, error: result.error });
      res.json({ success: true, data: result });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/customer/me', portal.authenticateCustomer, (req, res) => {
    res.json({ success: true, data: portal.publicProfile(req.customerProfile) });
  });

  app.put('/api/customer/me', portal.authenticateCustomer, (req, res) => {
    try {
      const body = req.body || {};
      const patch = {};
      if (typeof body.name === 'string') patch.name = body.name.trim().slice(0, 80);
      if (Array.isArray(body.addresses)) patch.addresses = body.addresses;
      if (Array.isArray(body.favorites)) patch.favorites = body.favorites;
      if (body.theme === 'light' || body.theme === 'dark' || body.theme === 'system') {
        patch.theme = body.theme;
      }
      const profile = portal.saveProfile(req.customerPhone, patch);
      res.json({ success: true, data: portal.publicProfile(profile) });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/customer/addresses', portal.authenticateCustomer, (req, res) => {
    const profile = portal.getProfile(req.customerPhone);
    res.json({ success: true, data: profile.addresses || [] });
  });

  app.put('/api/customer/addresses', portal.authenticateCustomer, (req, res) => {
    const addresses = Array.isArray(req.body?.addresses) ? req.body.addresses : [];
    const profile = portal.saveProfile(req.customerPhone, { addresses });
    res.json({ success: true, data: profile.addresses || [] });
  });

  app.post('/api/customer/push/subscribe', portal.authenticateCustomer, (req, res) => {
    const sub = req.body?.subscription || req.body;
    if (!sub || !sub.endpoint) {
      return res.status(400).json({ success: false, error: 'Thiếu subscription' });
    }
    portal.upsertPushSubscription(req.customerPhone, sub);
    res.json({ success: true });
  });

  app.delete('/api/customer/push/subscribe', portal.authenticateCustomer, (req, res) => {
    const endpoint = req.body?.endpoint || req.query.endpoint;
    if (!endpoint) return res.status(400).json({ success: false, error: 'Thiếu endpoint' });
    portal.removePushSubscription(req.customerPhone, endpoint);
    res.json({ success: true });
  });

  app.get('/api/customer/push/vapid-public-key', rateLimitStrict, (req, res) => {
    const key = portal.getVapidPublicKey();
    res.json({ success: true, data: { publicKey: key, enabled: !!key } });
  });

  app.get('/api/customer/offers', rateLimitStrict, async (req, res) => {
    try {
      portal.softAuthenticateCustomer(req);
      const phone = cleanPhone(req.customerPhone || req.query.phone || '');
      if (!phone) return res.status(400).json({ success: false, error: 'Thiếu SĐT' });
      const orders = await mergeOrdersFromSupabaseForRange(
        readOrdersDatabase(),
        Math.min(ORDER_HISTORY_RETENTION_DAYS || 90, 90)
      );
      let loyalty = null;
      try {
        loyalty = customerOps.getLoyaltyProfile(phone);
      } catch (_) {}
      let promos = [];
      try {
        promos = require('../crmHelpers').readPromos();
      } catch (_) {}
      const offers = portal.buildPersonalizedOffers(phone, { orders, loyalty, promos });
      res.json({ success: true, data: offers });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/customer/suggestions', rateLimitStrict, async (req, res) => {
    try {
      portal.softAuthenticateCustomer(req);
      const phone = cleanPhone(req.customerPhone || req.query.phone || '');
      if (!phone) {
        return res.json({
          success: true,
          data: {
            timeLabel: 'Gợi ý cho bạn',
            recentOrders: [],
            frequentItems: [],
            frequentRestaurants: [],
            favorites: []
          }
        });
      }
      const orders = await mergeOrdersFromSupabaseForRange(
        readOrdersDatabase(),
        Math.min(ORDER_HISTORY_RETENTION_DAYS || 90, 90)
      );
      const profile = portal.getProfile(phone);
      const data = portal.buildSuggestions(phone, {
        orders,
        favorites: profile.favorites || []
      });
      res.json({ success: true, data });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/config/payment', rateLimitStrict, (req, res) => {
    res.json({
      success: true,
      data: {
        methods: [
          {
            id: 'COD',
            name: 'Tiền mặt khi nhận (COD)',
            desc: 'Trả tiền trực tiếp cho tài xế khi nhận hàng',
            enabled: true
          },
          {
            id: 'BANK_TRANSFER',
            name: 'Chuyển khoản ngân hàng',
            desc: 'Chuyển khoản trước, gửi xác nhận cho tài xế khi giao',
            enabled: true
          }
        ],
        bankTransfer: {
          bankName: process.env.PAYMENT_BANK_NAME || 'Vietcombank',
          accountName: process.env.PAYMENT_BANK_ACCOUNT_NAME || 'SHIPFEE',
          accountNumber: process.env.PAYMENT_BANK_ACCOUNT_NUMBER || '',
          noteHint: 'Nội dung: SPF + SĐT đặt hàng'
        },
        momoNote:
          'Ví MoMo đang chuẩn bị kết nối. Hiện hỗ trợ COD và chuyển khoản.'
      }
    });
  });
}

module.exports = { registerCustomerPortalRoutes };
