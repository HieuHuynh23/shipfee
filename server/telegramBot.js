/**
 * ShipFee Telegram Bot — remote ops console aligned with CRM Admin.
 * Long-polling only; configured via pricingConfig.telegramConfig + env vars.
 */
const axios = require('axios');

const CRM_BASE = 'https://shipfee.vercel.app/admin-app/';
const API_BASE = `https://api.telegram.org/bot`;

let deps = {};
let telegramOffset = 0;
let periodicTimer = null;
let pollLoopActive = false;
let isPolling = false;
let lastPollAt = 0;
let lastPollError = null;
let lastUpdateAt = 0;
let pollSuccessCount = 0;
const slaTelegramNotified = new Map();
/** chatId -> { threadId, expiresAt } — admin đang soạn trả lời hỗ trợ tài xế */
const pendingSupportReplies = new Map();
const SUPPORT_REPLY_TTL_MS = 5 * 60 * 1000;

function crmLink(page, q) {
  const params = new URLSearchParams({ page });
  if (q) params.set('q', q);
  return `${CRM_BASE}?${params.toString()}`;
}

/** "/crm@Shipfee_bot" → "/crm"; "/find@bot query" → "/find query" */
function normalizeCommandText(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^\/([a-z0-9_]+)@[a-z0-9_]+/, '/$1');
}

/** Markdown legacy dễ vỡ với _ trong tên/URL — luôn gửi plain text ổn định */
function markdownToPlain(text) {
  return String(text || '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1\n$2')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

function getTelegramConfig() {
  const cfg = deps.getPricingConfig()?.telegramConfig || {};
  return {
    enableNewShipperAlert: cfg.enableNewShipperAlert !== false,
    enableNewOrderAlert: cfg.enableNewOrderAlert !== false,
    enableOrderUpdateAlert: cfg.enableOrderUpdateAlert === true,
    enablePeriodicReport: cfg.enablePeriodicReport !== false,
    enableEmergencyAlert: cfg.enableEmergencyAlert !== false,
    enableSlaAlert: cfg.enableSlaAlert !== false,
    enableRestaurantAlert: cfg.enableRestaurantAlert === true,
    reportIntervalHours: Math.max(1, Number(cfg.reportIntervalHours) || 6)
  };
}

function allowedChatIds() {
  return String(deps.TELEGRAM_CHAT_ID || '')
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function isConfigured() {
  return !!(deps.TELEGRAM_BOT_TOKEN && allowedChatIds().length);
}

function isAuthorizedChat(chatId) {
  if (!deps.TELEGRAM_BOT_TOKEN) return false;
  const id = String(chatId);
  return allowedChatIds().some(allowed => allowed === id);
}

function getStatus() {
  return {
    tokenConfigured: !!deps.TELEGRAM_BOT_TOKEN,
    chatConfigured: allowedChatIds().length > 0,
    allowedChatCount: allowedChatIds().length,
    pollingActive: pollLoopActive,
    isPollingTick: isPolling,
    lastPollAt,
    lastUpdateAt,
    pollSuccessCount,
    lastPollError,
    offset: telegramOffset
  };
}

async function tgPost(method, body) {
  const payload = { ...body };
  // Tránh lỗi parse Markdown (underscore, v.v.) — gửi plain text
  if ((method === 'sendMessage' || method === 'editMessageText') && payload.text) {
    if (payload.parse_mode) {
      payload.text = markdownToPlain(payload.text);
      delete payload.parse_mode;
    }
  }
  await axios.post(`${API_BASE}${deps.TELEGRAM_BOT_TOKEN}/${method}`, payload, { timeout: 20000 });
}

async function sendMessage(text, keyboard, chatId = null) {
  if (!deps.TELEGRAM_BOT_TOKEN) return;
  const target = chatId || allowedChatIds()[0];
  if (!target) return;
  const payload = {
    chat_id: target,
    text: markdownToPlain(text)
  };
  if (keyboard) payload.reply_markup = keyboard;
  await tgPost('sendMessage', payload);
}

function countSlaBreaches() {
  try {
    const orders = deps.readOrdersDatabase();
    const active = orders.filter(o => o.status !== 'DELIVERED' && o.status !== 'CANCELLED');
    return active.filter(o => deps.getOrderSlaInfo(o)).length;
  } catch {
    return 0;
  }
}

function generateCRMReportMessage() {
  try {
    const orders = deps.readOrdersDatabase();
    const shippers = deps.readShippersDatabase();

    const todayStr = new Date().toDateString();
    const todayOrders = orders.filter(o => {
      const d = o.createdAt || o.acceptedAt || Date.now();
      return new Date(d).toDateString() === todayStr;
    });

    const pendingCount = todayOrders.filter(o => o.status === 'PENDING').length;
    const acceptedCount = todayOrders.filter(o => o.status === 'ACCEPTED').length;
    const purchasedCount = todayOrders.filter(o => o.status === 'PURCHASED').length;
    const deliveredCount = todayOrders.filter(o => o.status === 'DELIVERED').length;
    const cancelledCount = todayOrders.filter(o => o.status === 'CANCELLED').length;

    const todayRevenue = todayOrders
      .filter(o => o.status === 'DELIVERED')
      .reduce((sum, o) => sum + (o.appTotal || 0), 0);

    const onlineShippers = shippers.filter(s => s.status === 'ONLINE');
    const activeOrders = orders.filter(o => o.status !== 'DELIVERED' && o.status !== 'CANCELLED' && o.shipperPhone);
    const busyPhones = new Set(activeOrders.map(o => o.shipperPhone.trim().replace(/\s+/g, '')));

    const onlineFreeCount = onlineShippers.filter(s => !busyPhones.has(s.phone.trim().replace(/\s+/g, ''))).length;
    const onlineBusyCount = onlineShippers.filter(s => busyPhones.has(s.phone.trim().replace(/\s+/g, ''))).length;
    const pendingShippers = shippers.filter(s => s.isApproved === false).length;
    const allPendingOrders = orders.filter(o => o.status === 'PENDING').length;
    const slaBreaches = countSlaBreaches();

    const text = `📊 *BÁO CÁO TỔNG QUAN CRM SHIPFEE*\n` +
      `📅 *Ngày cập nhật:* ${new Date().toLocaleDateString('vi-VN')} ${new Date().toLocaleTimeString('vi-VN')}\n\n` +
      `💰 *Doanh thu hôm nay (Giao thành công):* *${todayRevenue.toLocaleString('vi-VN')}đ*\n\n` +
      `📦 *Thống kê Đơn hàng hôm nay:* \n` +
      `• ⏳ Chờ xử lý (PENDING): *${pendingCount}* (đang chờ: *${allPendingOrders}*)\n` +
      `• 🚴 Shipper đã nhận (ACCEPTED): *${acceptedCount}*\n` +
      `• 🛍️ Đang giao hàng (PURCHASED): *${purchasedCount}*\n` +
      `• ✅ Giao thành công (DELIVERED): *${deliveredCount}*\n` +
      `• ❌ Đơn đã hủy (CANCELLED): *${cancelledCount}*\n\n` +
      `⚠️ *SLA breach đang active:* *${slaBreaches}*\n\n` +
      `🛵 *Thống kê ca hoạt động Tài xế:* \n` +
      `• 🟢 Đang trực rảnh việc: *${onlineFreeCount}*\n` +
      `• 🟡 Đang bận giao đơn: *${onlineBusyCount}*\n` +
      `• 🔴 Đã tắt ca (OFFLINE): *${shippers.length - onlineShippers.length}*\n` +
      `• ⏳ Đang chờ Admin duyệt: *${pendingShippers}*\n\n` +
      `🔗 [Mở CRM Admin](${crmLink('dashboard')})\n\n` +
      `Chọn tùy chọn bên dưới để xem báo cáo chi tiết nhanh.`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🔄 Làm mới số liệu', callback_data: 'crm_refresh_stats' },
          { text: '🛵 Shipper online', callback_data: 'crm_shippers_report' }
        ],
        [
          { text: '📦 Đơn chờ xử lý', callback_data: 'crm_pending_orders' },
          { text: '⏳ Shipper chờ duyệt', callback_data: 'crm_pending_shippers' }
        ],
        [
          { text: '💬 Chat hỗ trợ TX', callback_data: 'crm_support_list' },
          { text: '🔗 Mở CRM', url: crmLink('dashboard') }
        ]
      ]
    };

    return { text, keyboard };
  } catch (e) {
    console.error('[Telegram Report Error]:', e.message);
    return { text: '❌ Lỗi hệ thống khi trích xuất dữ liệu báo cáo!', keyboard: { inline_keyboard: [] } };
  }
}

function generateShippersReportMessage() {
  try {
    const shippers = deps.readShippersDatabase();
    const orders = deps.readOrdersDatabase();
    const onlineList = shippers.filter(s => s.status === 'ONLINE');

    const activeOrders = orders.filter(o => o.status !== 'DELIVERED' && o.status !== 'CANCELLED' && o.shipperPhone);
    const busyPhones = new Set(activeOrders.map(o => o.shipperPhone.trim().replace(/\s+/g, '')));

    let text = `🛵 *DANH SÁCH TÀI XẾ ĐANG HOẠT ĐỘNG (ONLINE)*\n` +
      `📅 *Cập nhật:* ${new Date().toLocaleTimeString('vi-VN')}\n\n`;

    if (onlineList.length === 0) {
      text += `⚠️ Hiện tại không có tài xế nào đang online trực ca.`;
    } else {
      onlineList.forEach((s, idx) => {
        const cleanedPhone = s.phone.trim().replace(/\s+/g, '');
        const isBusy = busyPhones.has(cleanedPhone);
        text += `${idx + 1}. *${s.name}* (${s.phone})\n   • Trạng thái: ${isBusy ? '🟡 Đang giao đơn' : '🟢 Đang rảnh việc'}\n`;
      });
    }

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🔄 Làm mới', callback_data: 'crm_shippers_report' },
          { text: '⬅️ Quay lại Menu', callback_data: 'crm_main_menu' }
        ]
      ]
    };

    return { text, keyboard };
  } catch (e) {
    return { text: '❌ Lỗi hệ thống khi tải danh sách tài xế!', keyboard: { inline_keyboard: [] } };
  }
}

function generatePendingOrdersMessage() {
  try {
    const pending = deps.readOrdersDatabase()
      .filter(o => o.status === 'PENDING')
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 10);

    let text = `📦 *ĐƠN HÀNG CHỜ XỬ LÝ (PENDING)*\n` +
      `📅 *Cập nhật:* ${new Date().toLocaleTimeString('vi-VN')}\n\n`;

    if (pending.length === 0) {
      text += `✅ Không có đơn nào đang chờ xử lý.`;
    } else {
      pending.forEach((o, idx) => {
        text += `${idx + 1}. \`${o.id}\` — *${o.restaurantName}*\n   💵 ${(o.appTotal || 0).toLocaleString('vi-VN')}đ\n`;
      });
    }

    const keyboard = { inline_keyboard: [] };
    pending.forEach(o => {
      keyboard.inline_keyboard.push([{
        text: `📦 ${o.id} — ${o.restaurantName}`,
        callback_data: `view_order_details:${o.id}`
      }]);
    });
    keyboard.inline_keyboard.push([
      { text: '⬅️ Quay lại Menu', callback_data: 'crm_main_menu' },
      { text: '🔗 Mở CRM', url: crmLink('orders') }
    ]);

    return { text, keyboard };
  } catch (e) {
    return { text: '❌ Lỗi tải danh sách đơn chờ!', keyboard: { inline_keyboard: [] } };
  }
}

function generatePendingShippersMessage() {
  try {
    const pending = deps.readShippersDatabase().filter(s => s.isApproved === false);

    let text = `⏳ *TÀI XẾ CHỜ PHÊ DUYỆT*\n` +
      `📅 *Cập nhật:* ${new Date().toLocaleTimeString('vi-VN')}\n\n`;

    if (pending.length === 0) {
      text += `✅ Không có tài xế nào đang chờ duyệt.`;
    } else {
      pending.forEach((s, idx) => {
        text += `${idx + 1}. *${s.name}* — \`${s.phone}\`\n`;
      });
    }

    const keyboard = { inline_keyboard: [] };
    pending.slice(0, 10).forEach(s => {
      keyboard.inline_keyboard.push([
        { text: `✅ Duyệt ${s.name}`, callback_data: `approve_shipper:${s.phone}` },
        { text: '❌ Từ chối', callback_data: `reject_shipper:${s.phone}` }
      ]);
      keyboard.inline_keyboard.push([{
        text: `👤 Chi tiết ${s.name}`,
        callback_data: `select_shipper:${s.phone}`
      }]);
    });
    keyboard.inline_keyboard.push([
      { text: '⬅️ Quay lại Menu', callback_data: 'crm_main_menu' },
      { text: '🔗 Mở CRM', url: crmLink('shippers') }
    ]);

    return { text, keyboard };
  } catch (e) {
    return { text: '❌ Lỗi tải danh sách tài xế chờ duyệt!', keyboard: { inline_keyboard: [] } };
  }
}

function findShipperInDatabase(query) {
  try {
    const shippers = deps.readShippersDatabase();
    const cleanQuery = query.trim().toLowerCase().replace(/\s+/g, '');
    if (!cleanQuery) return [];

    return shippers.filter(s => {
      const cleanName = (s.name || '').toLowerCase().replace(/\s+/g, '');
      const cleanPhone = (s.phone || '').trim().replace(/\s+/g, '');
      const cleanEmail = (s.email || '').toLowerCase();
      return cleanName.includes(cleanQuery) ||
        cleanPhone.includes(cleanQuery) ||
        cleanEmail.includes(cleanQuery);
    });
  } catch (e) {
    console.error('Error finding shipper:', e.message);
    return [];
  }
}

function generateShipperDetailMessage(shipper) {
  try {
    const ar = shipper.acceptanceRate !== undefined ? shipper.acceptanceRate : 100;
    const cr = shipper.completionRate !== undefined ? shipper.completionRate : 100;
    const earnings = shipper.totalEarnings || 0;
    const orders = shipper.totalOrders || 0;

    const emailText = shipper.email ? `\`${shipper.email}\`` : '`—`';
    const avatarText = shipper.avatarUrl ? `\`${shipper.avatarUrl}\`` : '`Chưa cập nhật`';

    const text = `👤 *THÔNG TIN CHI TIẾT TÀI XẾ*\n\n` +
      `• *Họ và tên:* ${shipper.name || '—'}\n` +
      `• *Số điện thoại:* \`${shipper.phone}\`\n` +
      `• *Email:* ${emailText}\n` +
      `• *Trạng thái ca:* ${shipper.status === 'ONLINE' ? '🟢 ONLINE' : '🔴 OFFLINE'}\n` +
      `• *Trạng thái duyệt:* ${shipper.isApproved !== false ? '✅ Đã duyệt hoạt động' : '🔒 Đang bị KHÓA / Chờ duyệt'}\n\n` +
      `📈 *Chỉ số hiệu suất:* \n` +
      `• Tỷ lệ nhận đơn (AR): *${ar}%* · Hoàn thành (CR): *${cr}%*\n` +
      `• Tổng đơn giao: *${orders} đơn*\n` +
      `• Doanh thu tích lũy: *${earnings.toLocaleString('vi-VN')}đ*\n\n` +
      `🖼️ *Ảnh chân dung:* ${avatarText}\n\n` +
      `🔗 [Mở CRM](${crmLink('shippers', shipper.phone)})\n\n` +
      `Chọn thao tác xử lý cho tài xế dưới đây:`;

    const buttons = [];
    if (shipper.isApproved === false) {
      buttons.push([
        { text: '✅ Phê duyệt hoạt động', callback_data: `shipper_approve:${shipper.phone}` },
        { text: '❌ Từ chối & Xóa', callback_data: `shipper_reject:${shipper.phone}` }
      ]);
    } else {
      buttons.push([
        { text: '🔒 Khóa tài khoản', callback_data: `shipper_lock:${shipper.phone}` },
        { text: '❌ Xóa hoàn toàn', callback_data: `shipper_delete:${shipper.phone}` }
      ]);
    }
    buttons.push([
      { text: '🔄 Làm mới thông tin', callback_data: `shipper_refresh:${shipper.phone}` },
      { text: '⬅️ Quay lại Menu', callback_data: 'crm_main_menu' }
    ]);

    return { text, keyboard: { inline_keyboard: buttons } };
  } catch (e) {
    return { text: '❌ Lỗi hệ thống khi trích xuất thông tin tài xế!', keyboard: { inline_keyboard: [] } };
  }
}

function generateOrderDetailMessage(order) {
  const itemsText = (order.items || []).map(i => {
    let line = `• ${i.name} x${i.quantity || i.qty}`;
    if (i.note) line += ` (Ghi chú: *${i.note}*)`;
    return line;
  }).join('\n');

  const statusLabels = {
    PENDING: '⏳ Chờ xử lý',
    ACCEPTED: '🚴 Đã nhận đơn',
    PURCHASED: '🛍️ Đang giao',
    DELIVERED: '✅ Giao thành công',
    CANCELLED: '❌ Đã hủy'
  };

  const text = `📦 *CHI TIẾT ĐƠN HÀNG*\n\n` +
    `🆔 *Mã đơn:* \`${order.id}\`\n` +
    `📈 *Trạng thái:* ${statusLabels[order.status] || order.status}\n` +
    `🏪 *Cửa hàng:* *${order.restaurantName}*\n` +
    `📍 *Địa chỉ giao:* ${order.deliveryAddress}\n` +
    `👤 *Người nhận:* ${order.deliveryName} (${order.deliveryPhone})\n` +
    `👤 *Người đặt:* ${order.isRelative ? 'Đặt hộ - ' : ''}${order.ordererPhone}\n` +
    `🛵 *Tài xế:* ${order.shipperName ? `${order.shipperName} (${order.shipperPhone})` : 'Chưa có'}\n` +
    `📝 *Ghi chú đơn:* ${order.note || 'Không có'}\n\n` +
    `📦 *Danh sách món:* \n${itemsText || 'Trống'}\n\n` +
    `💰 *Tổng tiền món:* ${(order.storeTotal || 0).toLocaleString('vi-VN')}đ\n` +
    `💵 *Khách thanh toán:* *${(order.appTotal || 0).toLocaleString('vi-VN')}đ*\n` +
    `🛵 *Thu nhập tài xế:* ${(order.shipperEarning || 0).toLocaleString('vi-VN')}đ\n\n` +
    `🔗 [Mở CRM](${crmLink('orders', order.id)})\n\n` +
    `Chọn thao tác nhanh dưới đây:`;

  const buttons = [];
  if (order.status === 'PENDING') {
    buttons.push([
      { text: '🚴 Gán nhanh tự động', callback_data: `assign_auto:${order.id}` },
      { text: '🎯 Chỉ định tài xế', callback_data: `assign_select:${order.id}` }
    ]);
    buttons.push([{ text: '❌ Hủy đơn', callback_data: `cancel_order:${order.id}` }]);
  } else if (order.status === 'ACCEPTED') {
    buttons.push([{ text: '▶️ Đã mua hàng (PURCHASED)', callback_data: `advance_status:${order.id}:PURCHASED` }]);
    buttons.push([
      { text: '🔄 Gán lại tài xế', callback_data: `reassign_select:${order.id}` },
      { text: '❌ Hủy đơn', callback_data: `cancel_order:${order.id}` }
    ]);
  } else if (order.status === 'PURCHASED') {
    buttons.push([{ text: '✅ Giao thành công', callback_data: `advance_status:${order.id}:DELIVERED` }]);
    buttons.push([{ text: '🔄 Gán lại tài xế', callback_data: `reassign_select:${order.id}` }]);
  }

  if (buttons.length > 0) {
    buttons.push([{ text: '🔗 Mở CRM', url: crmLink('orders', order.id) }]);
  } else {
    buttons.push([{ text: '🔗 Mở CRM', url: crmLink('orders', order.id) }]);
  }

  return { text, keyboard: { inline_keyboard: buttons } };
}

async function syncOrderToSupabase(order) {
  if (!deps.supabase || !order) return;
  try {
    await deps.supabase.from('orders').update({
      status: order.status,
      shipper_id: order.shipperId,
      shipper_name: order.shipperName,
      shipper_phone: order.shipperPhone,
      accepted_at: order.acceptedAt ? new Date(order.acceptedAt).toISOString() : undefined,
      purchased_at: order.purchasedAt ? new Date(order.purchasedAt).toISOString() : undefined,
      delivered_at: order.deliveredAt ? new Date(order.deliveredAt).toISOString() : undefined
    }).eq('id', order.id);
  } catch (e) {
    console.warn('[Telegram Bot] Supabase sync warning:', e.message);
  }
}

async function assignOrderToShipper(orderId, shipperPhone, { isReassign = false } = {}) {
  const shippers = deps.readShippersDatabase();
  const matchedShipper = shippers.find(s => s.phone.trim().replace(/\s+/g, '') === shipperPhone.trim().replace(/\s+/g, ''));
  if (!matchedShipper) return { ok: false, error: 'Không tìm thấy tài xế!' };

  let updatedOrder = null;
  await deps.updateOrdersDatabase((dbOrders) => {
    const idx = dbOrders.findIndex(o => o.id === orderId);
    if (idx === -1) return;
    const order = dbOrders[idx];
    if (isReassign) {
      if (!['PENDING', 'ACCEPTED', 'PURCHASED'].includes(order.status)) return;
    } else if (order.status !== 'PENDING') {
      return;
    }
    dbOrders[idx].status = 'ACCEPTED';
    dbOrders[idx].shipperId = matchedShipper.id || 'local-shipper-id';
    dbOrders[idx].shipperName = matchedShipper.name;
    dbOrders[idx].shipperPhone = matchedShipper.phone;
    dbOrders[idx].assignedShipperPhone = matchedShipper.phone;
    dbOrders[idx].offerExpiresAt = null;
    if (!dbOrders[idx].acceptedAt) dbOrders[idx].acceptedAt = Date.now();
    updatedOrder = dbOrders[idx];
  });

  if (!updatedOrder) return { ok: false, error: 'Gán đơn thất bại!' };

  await syncOrderToSupabase(updatedOrder);
  if (deps.upsertOrderToSupabase) deps.upsertOrderToSupabase(updatedOrder).catch(() => {});
  return { ok: true, order: updatedOrder, shipper: matchedShipper };
}

async function advanceOrderStatus(orderId, newStatus) {
  let updatedOrder = null;
  let errMsg = null;
  await deps.updateOrdersDatabase((orders) => {
    const idx = orders.findIndex(o => o.id === orderId);
    if (idx === -1) return;
    const current = orders[idx].status;
    if (!deps.canTransitionOrderStatus(current, newStatus)) {
      errMsg = `Không thể chuyển từ ${current} sang ${newStatus}`;
      return;
    }
    orders[idx].status = newStatus;
    if (newStatus === 'ACCEPTED' && !orders[idx].acceptedAt) orders[idx].acceptedAt = Date.now();
    if (newStatus === 'PURCHASED') orders[idx].purchasedAt = Date.now();
    if (newStatus === 'DELIVERED') orders[idx].deliveredAt = Date.now();
    if (newStatus === 'CANCELLED') {
      orders[idx].cancelledAt = Date.now();
      orders[idx].cancelReason = 'Admin hủy (Telegram)';
    }
    updatedOrder = orders[idx];
  });

  if (errMsg) return { ok: false, error: errMsg };
  if (!updatedOrder) return { ok: false, error: 'Không tìm thấy đơn hàng!' };

  await syncOrderToSupabase(updatedOrder);
  if (deps.upsertOrderToSupabase) deps.upsertOrderToSupabase(updatedOrder).catch(() => {});
  return { ok: true, order: updatedOrder };
}

async function cancelOrderById(orderId) {
  let updatedOrder = null;
  await deps.updateOrdersDatabase((dbOrders) => {
    const idx = dbOrders.findIndex(o => o.id === orderId);
    if (idx === -1) return;
    if (['DELIVERED', 'CANCELLED'].includes(dbOrders[idx].status)) return;
    dbOrders[idx].status = 'CANCELLED';
    dbOrders[idx].cancelledAt = Date.now();
    dbOrders[idx].cancelReason = dbOrders[idx].cancelReason || 'Admin hủy (Telegram)';
    dbOrders[idx].assignedShipperPhone = null;
    dbOrders[idx].offerExpiresAt = null;
    updatedOrder = dbOrders[idx];
  });

  if (!updatedOrder) return { ok: false, error: 'Không thể hủy đơn!' };

  await syncOrderToSupabase(updatedOrder);
  if (deps.notifyOrderCancelled) deps.notifyOrderCancelled(updatedOrder);
  if (deps.upsertOrderToSupabase) deps.upsertOrderToSupabase(updatedOrder).catch(() => {});
  return { ok: true, order: updatedOrder };
}

function notifyShipperAction(type, shipper, source = 'Telegram') {
  if (!deps.addNotification || !shipper) return;
  const titles = {
    approved: 'Tài xế đã được duyệt',
    rejected: 'Tài xế bị từ chối',
    locked: 'Tài khoản tài xế bị khóa'
  };
  deps.addNotification(
    'shipper_action',
    null,
    shipper.name || '',
    titles[type] || 'Cập nhật tài xế',
    `${shipper.name} (${shipper.phone}) — xử lý qua ${source}`
  );
}

// ── Outbound notifications ───────────────────────────────────────────────────

async function sendNewShipperNotification(shipper) {
  if (!isConfigured()) return;
  if (!getTelegramConfig().enableNewShipperAlert) {
    console.log('[Telegram Bot] Bỏ qua alert tài xế mới (cấu hình tắt).');
    return;
  }
  try {
    const text = `🔔 *Yêu cầu phê duyệt Tài xế mới*\n\n` +
      `👤 *Họ và tên:* ${shipper.name}\n` +
      `📞 *Số điện thoại:* ${shipper.phone}\n` +
      `✉️ *Email:* ${shipper.email || '—'}\n` +
      `🖼️ *Ảnh chân dung:* [Xem ảnh](${shipper.avatarUrl || ''})\n\n` +
      `🔗 [Mở CRM Shippers](${crmLink('shippers', shipper.phone)})\n\n` +
      `Nhấp chọn phê duyệt bên dưới hoặc duyệt trên CRM.`;

    await sendMessage(text, {
      inline_keyboard: [[
        { text: '✅ Phê duyệt', callback_data: `approve_shipper:${shipper.phone}` },
        { text: '❌ Từ chối', callback_data: `reject_shipper:${shipper.phone}` }
      ]]
    });
    console.log(`[Telegram Bot] Alert tài xế mới: ${shipper.name}`);
  } catch (err) {
    console.error('[Telegram Bot] Lỗi gửi alert tài xế:', err.response?.data || err.message);
  }
}

async function sendNewOrderNotification(order) {
  if (!isConfigured()) return;
  if (!getTelegramConfig().enableNewOrderAlert) {
    console.log('[Telegram Bot] Bỏ qua alert đơn mới (cấu hình tắt).');
    return;
  }
  try {
    const detail = generateOrderDetailMessage(order);
    const text = `🛒 *CÓ ĐƠN HÀNG MỚI CHỜ XỬ LÝ!*\n\n${detail.text}`;
    await sendMessage(text, detail.keyboard);
    console.log(`[Telegram Bot] Alert đơn mới: ${order.id}`);
  } catch (err) {
    console.error('[Telegram Bot] Lỗi alert đơn mới:', err.response?.data || err.message);
  }
}

async function sendOrderStatusUpdateNotification(order) {
  if (!isConfigured()) return;
  if (!getTelegramConfig().enableOrderUpdateAlert) return;

  try {
    let statusEmoji = 'ℹ️';
    let statusName = order.status;
    if (order.status === 'ACCEPTED') {
      statusEmoji = '🚴';
      statusName = 'Đã nhận đơn (Shipper đang đến quán)';
    } else if (order.status === 'PURCHASED') {
      statusEmoji = '🛍️';
      statusName = 'Đã mua hàng (Đang giao tới khách)';
    } else if (order.status === 'DELIVERED') {
      statusEmoji = '✅';
      statusName = 'Giao thành công 🎉';
    } else if (order.status === 'CANCELLED') {
      statusEmoji = '❌';
      statusName = 'Đã hủy đơn';
    }

    const text = `${statusEmoji} *CẬP NHẬT TRẠNG THÁI ĐƠN HÀNG*\n\n` +
      `🆔 *Mã đơn:* \`${order.id}\`\n` +
      `🏪 *Cửa hàng:* *${order.restaurantName}*\n` +
      `🛵 *Tài xế:* ${order.shipperName ? `${order.shipperName} (${order.shipperPhone})` : 'Chưa có'}\n` +
      `📈 *Trạng thái mới:* *${statusName}*\n\n` +
      `🔗 [Mở CRM](${crmLink('orders', order.id)})`;

    await sendMessage(text);
  } catch (err) {
    console.error('[Telegram Bot] Lỗi cập nhật trạng thái:', err.message);
  }
}

async function sendSlaBreachNotification(order, sla) {
  if (!isConfigured() || !getTelegramConfig().enableSlaAlert) return;
  const now = Date.now();
  const last = slaTelegramNotified.get(order.id) || 0;
  if (now - last < 15 * 60 * 1000) return;
  slaTelegramNotified.set(order.id, now);

  try {
    const text = `⚠️ *SLA BREACH — ĐƠN QUÁ HẠN*\n\n` +
      `🆔 *Mã đơn:* \`${order.id}\`\n` +
      `📈 *Trạng thái:* ${order.status}\n` +
      `🏪 *Quán:* ${order.restaurantName}\n` +
      `⏱️ *Loại SLA:* ${sla.type}\n` +
      `⌛ *Thời gian:* ${Math.round(sla.ageMs / 60000)} phút\n\n` +
      `🔗 [Mở Fleet Map](${crmLink('fleet')}) · [Đơn hàng](${crmLink('orders', order.id)})`;

    await sendMessage(text, {
      inline_keyboard: [[
        { text: '📦 Xem đơn', callback_data: `view_order_details:${order.id}` },
        { text: '🔗 Mở CRM', url: crmLink('orders', order.id) }
      ]]
    });
  } catch (err) {
    console.error('[Telegram Bot] Lỗi SLA alert:', err.message);
  }
}

async function sendSosNotification(shipper) {
  if (!isConfigured() || !getTelegramConfig().enableEmergencyAlert) return;
  try {
    const cleanPhone = shipper.phone.trim().replace(/\s+/g, '');
    const text = `🆘 *Tài xế yêu cầu Hỗ trợ Tìm đơn*\n\n` +
      `🛵 *Tài xế:* ${shipper.name} (${shipper.phone})\n` +
      `📊 *Số lượt đã dùng hôm nay:* ${shipper.assistanceLimitToday || 0}/3\n` +
      `⏳ *Trạng thái:* Đang chờ đơn hàng mới phát sinh để tự động gán ưu tiên.\n\n` +
      `🔗 [Mở Fleet Map](${crmLink('fleet')})`;

    await sendMessage(text, {
      inline_keyboard: [[
        { text: '🎯 Chỉ định đơn nhanh', callback_data: `sos_assign_select:${cleanPhone}` },
        { text: '❌ Hủy yêu cầu SOS', callback_data: `sos_cancel:${cleanPhone}` }
      ]]
    });

    if (deps.addNotification) {
      deps.addNotification(
        'sos_request',
        null,
        shipper.name || '',
        'SOS — Tài xế cần đơn',
        `${shipper.name} (${shipper.phone}) yêu cầu hỗ trợ tìm đơn`
      );
    }
  } catch (err) {
    console.error('[Telegram Bot] Lỗi SOS alert:', err.message);
  }
}

function supportThreadKeyboard(threadId, shipperPhone = '') {
  const id = String(threadId || '');
  const crmQ = shipperPhone || id;
  return {
    inline_keyboard: [
      [
        { text: '💬 Trả lời ngay', callback_data: `support_reply:${id}` },
        { text: '📜 Xem hội thoại', callback_data: `support_view:${id}` }
      ],
      [
        { text: '✅ Đóng hỗ trợ', callback_data: `support_resolve:${id}` },
        { text: '🔗 Mở CRM can thiệp', url: crmLink('support', crmQ) }
      ]
    ]
  };
}

function generateSupportListMessage() {
  try {
    if (!deps.readShipperSupportThreads) {
      return { text: '❌ Module hỗ trợ chưa sẵn sàng.', keyboard: { inline_keyboard: [] } };
    }
    const open = (deps.readShipperSupportThreads() || [])
      .filter(t => t.status === 'open')
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 10);

    let text = `💬 *CHAT HỖ TRỢ TÀI XẾ (ĐANG MỞ)*\n` +
      `📅 ${new Date().toLocaleTimeString('vi-VN')}\n\n`;

    if (!open.length) {
      text += `✅ Không có hội thoại đang mở.`;
    } else {
      open.forEach((t, i) => {
        const last = (t.messages || [])[t.messages.length - 1];
        const preview = last ? String(last.text || '').slice(0, 40) : '—';
        const urg = t.priority === 'emergency' ? '🚨 ' : '';
        text += `${i + 1}. ${urg}*${t.shipperName || t.shipperPhone}*\n` +
          `   📞 \`${t.shipperPhone}\`${t.orderId ? ` · 📦 ${t.orderId}` : ''}\n` +
          `   💬 ${preview}${preview.length >= 40 ? '…' : ''}\n`;
      });
    }

    const keyboard = { inline_keyboard: [] };
    open.forEach(t => {
      keyboard.inline_keyboard.push([{
        text: `${t.priority === 'emergency' ? '🚨' : '💬'} ${t.shipperName || t.shipperPhone}`,
        callback_data: `support_view:${t.id}`
      }]);
    });
    keyboard.inline_keyboard.push([
      { text: '🔄 Làm mới', callback_data: 'crm_support_list' },
      { text: '🔗 Mở CRM', url: crmLink('support') }
    ]);
    keyboard.inline_keyboard.push([{ text: '⬅️ Menu', callback_data: 'crm_main_menu' }]);
    return { text, keyboard };
  } catch (e) {
    return { text: '❌ Lỗi tải danh sách hỗ trợ!', keyboard: { inline_keyboard: [] } };
  }
}

function generateSupportThreadMessage(thread) {
  if (!thread) {
    return { text: '❌ Không tìm thấy hội thoại.', keyboard: { inline_keyboard: [] } };
  }
  const msgs = (thread.messages || []).slice(-8);
  let text = `💬 *HỘI THOẠI HỖ TRỢ*\n\n` +
    `🛵 *Tài xế:* ${thread.shipperName || '—'} (\`${thread.shipperPhone}\`)\n` +
    `📈 *Trạng thái:* ${thread.status}${thread.priority === 'emergency' ? ' · 🚨 Khẩn cấp' : ''}\n` +
    (thread.orderId ? `📦 *Đơn:* \`${thread.orderId}\`\n` : '') +
    `\n`;

  if (!msgs.length) {
    text += `_Chưa có tin nhắn._\n`;
  } else {
    msgs.forEach(m => {
      const who = m.sender === 'admin' || m.role === 'admin' ? 'CRM' : 'TX';
      const t = m.timestamp ? new Date(m.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '';
      text += `• *${who}*${t ? ` (${t})` : ''}: ${String(m.text || '').slice(0, 180)}\n`;
    });
  }

  text += `\n💡 Nhấn *Trả lời ngay* rồi gõ tin — tài xế nhận trong app.\nHoặc mở CRM để can thiệp đầy đủ.`;
  return { text, keyboard: supportThreadKeyboard(thread.id, thread.shipperPhone) };
}

async function adminReplySupportThread(threadId, replyText, chatId) {
  const cleaned = String(replyText || '').trim();
  if (!cleaned) return { ok: false, error: 'Tin trống!' };
  if (cleaned.length > 1000) return { ok: false, error: 'Tối đa 1000 ký tự!' };
  if (!deps.appendShipperSupportMessage) return { ok: false, error: 'Module hỗ trợ chưa sẵn sàng!' };

  const updated = deps.appendShipperSupportMessage(threadId, {
    sender: 'admin',
    role: 'admin',
    text: cleaned,
    adminEmail: 'telegram-admin'
  });
  if (!updated) return { ok: false, error: 'Không tìm thấy hội thoại!' };

  if (deps.markShipperSupportRead) deps.markShipperSupportRead(threadId, 'admin');

  // Đồng bộ sang chat đơn (nếu có) — giống API admin CRM
  if (updated.orderId && deps.updateOrdersDatabase) {
    await deps.updateOrdersDatabase((orders) => {
      const idx = orders.findIndex(o => o.id === updated.orderId);
      if (idx === -1) return false;
      orders[idx].messages = orders[idx].messages || [];
      orders[idx].messages.push({
        sender: 'Admin',
        role: 'admin',
        text: cleaned,
        timestamp: Date.now()
      });
      return true;
    });
  }

  if (deps.addNotification) {
    deps.addNotification(
      'shipper_support',
      updated.shipperPhone,
      updated.shipperName || updated.shipperPhone,
      'CRM đã trả lời tài xế (Telegram)',
      `${updated.shipperName || updated.shipperPhone}: ${cleaned.slice(0, 120)}`
    );
  }

  return { ok: true, thread: updated };
}

async function adminResolveSupportThread(threadId) {
  if (!deps.readShipperSupportThreads || !deps.writeShipperSupportThreads) {
    return { ok: false, error: 'Module hỗ trợ chưa sẵn sàng!' };
  }
  const threads = deps.readShipperSupportThreads();
  const idx = threads.findIndex(t => t.id === threadId);
  if (idx === -1) return { ok: false, error: 'Không tìm thấy hội thoại!' };
  threads[idx].status = 'resolved';
  threads[idx].resolvedAt = Date.now();
  threads[idx].updatedAt = Date.now();
  deps.writeShipperSupportThreads(threads);
  return { ok: true, thread: threads[idx] };
}

async function sendShipperSupportNotification(payload) {
  if (!isConfigured()) return;
  try {
    const isEmergency = String(payload.supportPriority || '').toLowerCase() === 'emergency';
    const msg = String(payload.supportMessage || '').trim();
    const orderId = payload.supportOrderId ? String(payload.supportOrderId) : '';
    const threadId = payload.supportThreadId || '';
    const title = isEmergency ? '🚨 *Shipper khẩn cấp*' : '💬 *Shipper nhắn CRM*';
    const text = `${title}\n\n` +
      `🛵 *Tài xế:* ${payload.name || '—'} (${payload.phone || '—'})\n` +
      (orderId ? `📦 *Đơn:* \`${orderId}\`\n` : '') +
      (msg ? `\n📝 ${msg.slice(0, 400)}${msg.length > 400 ? '…' : ''}\n` : '') +
      `\nTrả lời ngay trên Telegram — hoặc mở CRM để can thiệp.`;

    const keyboard = threadId
      ? supportThreadKeyboard(threadId, payload.phone)
      : {
          inline_keyboard: [[
            { text: '💬 Danh sách hỗ trợ', callback_data: 'crm_support_list' },
            { text: '🔗 Mở CRM Hỗ trợ', url: crmLink('support') }
          ]]
        };

    await sendMessage(text, keyboard);
  } catch (err) {
    console.error('[Telegram Bot] Lỗi shipper support chat:', err.message);
  }
}

async function sendRestaurantAlert(type, restaurantName, title, message, restaurantId) {
  if (!isConfigured() || !getTelegramConfig().enableRestaurantAlert) return;
  try {
    const emoji = type === 'price_change' ? '💰' : '🏪';
    const text = `${emoji} *${title}*\n\n` +
      `🏪 *Quán:* ${restaurantName}\n\n` +
      `${message.substring(0, 800)}${message.length > 800 ? '…' : ''}\n\n` +
      `🔗 [Mở CRM Restaurants](${crmLink('restaurants', restaurantName)})`;

    await sendMessage(text, {
      inline_keyboard: [[
        { text: '🔗 Mở CRM', url: crmLink('restaurants') }
      ]]
    });
  } catch (err) {
    console.error('[Telegram Bot] Lỗi restaurant alert:', err.message);
  }
}

async function sendPeriodicReport() {
  if (!isConfigured() || !getTelegramConfig().enablePeriodicReport) return;
  try {
    const report = generateCRMReportMessage();
    await sendMessage(`📅 *BÁO CÁO ĐỊNH KỲ CRM*\n\n${report.text}`, report.keyboard);
    console.log('[Telegram Bot] Đã gửi báo cáo định kỳ.');
  } catch (err) {
    console.error('[Telegram Bot] Lỗi báo cáo định kỳ:', err.message);
  }
}

function restartPeriodicReport() {
  if (periodicTimer) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
  const cfg = getTelegramConfig();
  if (!isConfigured() || !cfg.enablePeriodicReport) return;

  const ms = cfg.reportIntervalHours * 60 * 60 * 1000;
  periodicTimer = setInterval(() => {
    sendPeriodicReport().catch(e => console.error('[Telegram Bot] Periodic error:', e.message));
  }, ms);
  console.log(`[Telegram Bot] Báo cáo định kỳ mỗi ${cfg.reportIntervalHours}h.`);
}

function checkAndNotifySla(activeOrders) {
  if (!getTelegramConfig().enableSlaAlert) return;
  for (const order of activeOrders) {
    const sla = deps.getOrderSlaInfo(order);
    if (sla) sendSlaBreachNotification(order, sla).catch(() => {});
  }
}

// ── Polling & callbacks ────────────────────────────────────────────────────────

async function buildShipperPickerKeyboard(orderId, mode = 'assign') {
  const orders = deps.readOrdersDatabase();
  const order = orders.find(o => o.id === orderId);
  if (!order) return null;

  const shippers = deps.readShippersDatabase();
  const onlineList = shippers.filter(s => s.status === 'ONLINE' && s.isApproved !== false);
  if (onlineList.length === 0) return { error: 'Không có tài xế online!' };

  const shippersWithDistance = onlineList.map(s => {
    const cleanedPhone = s.phone.trim().replace(/\s+/g, '');
    const loc = deps.onlineShipperLocations.get(cleanedPhone);
    let dist = Infinity;
    if (loc && typeof order.restaurantLat === 'number' && typeof order.restaurantLon === 'number') {
      dist = deps.calcDistance(order.restaurantLat, order.restaurantLon, loc.lat, loc.lon);
    }
    return { shipper: s, distance: dist };
  }).sort((a, b) => a.distance - b.distance).slice(0, 10);

  const prefix = mode === 'reassign' ? 'reassign_to_shipper' : 'assign_to_shipper';
  const keyboard = { inline_keyboard: [] };
  shippersWithDistance.forEach(item => {
    const s = item.shipper;
    const distText = item.distance !== Infinity ? ` (~${item.distance.toFixed(1)} km)` : '';
    keyboard.inline_keyboard.push([{
      text: `🚴 ${s.name}${distText}`,
      callback_data: `${prefix}:${orderId}:${s.phone}`
    }]);
  });
  keyboard.inline_keyboard.push([{
    text: '⬅️ Quay lại đơn',
    callback_data: `view_order_details:${orderId}`
  }]);

  return { keyboard, order, count: onlineList.length };
}

async function processUpdates(updates) {
  for (const update of updates) {
        telegramOffset = update.update_id + 1;

        const msg = update.message || update.channel_post;
        if (msg && msg.text) {
          const text = normalizeCommandText(msg.text);
          const chatId = msg.chat.id;

          if (!isAuthorizedChat(chatId)) {
            console.log(`[Telegram Bot] Chat không được phép: ${chatId} (allowed: ${allowedChatIds().join(',') || 'none'}) text=${text}`);
            if (text.startsWith('/')) {
              try {
                await axios.post(`${API_BASE}${deps.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                  chat_id: chatId,
                  text:
                    `ShipFee Bot: chat này chưa được phép điều khiển CRM.\n\n` +
                    `Chat ID của bạn: ${chatId}\n` +
                    `TELEGRAM_CHAT_ID đang cấu hình: ${deps.TELEGRAM_CHAT_ID || '(trống)'}\n\n` +
                    `→ Gõ lệnh trong đúng nhóm admin, hoặc thêm Chat ID trên vào env Render (có thể nhiều ID, cách nhau bằng dấu phẩy).`
                }, { timeout: 15000 });
              } catch (e) {
                console.error('[Telegram Bot] Không gửi được cảnh báo unauthorized:', e.response?.data || e.message);
              }
            }
            continue;
          }

          console.log(`[Telegram Bot] Lệnh nhận: ${text} từ chat ${chatId}`);
          lastUpdateAt = Date.now();

          // Admin đang soạn trả lời hỗ trợ tài xế (tin thường, không phải lệnh)
          const pendingKey = String(chatId);
          const pending = pendingSupportReplies.get(pendingKey);
          if (pending && Date.now() < pending.expiresAt) {
            if (text === '/cancel' || text === 'hủy' || text === 'huy' || text === 'cancel') {
              pendingSupportReplies.delete(pendingKey);
              await tgPost('sendMessage', { chat_id: chatId, text: '❌ Đã hủy trả lời hỗ trợ.' });
              continue;
            }
            if (!text.startsWith('/')) {
              const replyBody = String(msg.text || '').trim();
              pendingSupportReplies.delete(pendingKey);
              const result = await adminReplySupportThread(pending.threadId, replyBody, chatId);
              if (result.ok) {
                const detail = generateSupportThreadMessage(result.thread);
                await tgPost('sendMessage', {
                  chat_id: chatId,
                  text: `✅ *Đã gửi tới tài xế!*\n\n${detail.text}`,
                  parse_mode: 'Markdown',
                  reply_markup: detail.keyboard
                });
              } else {
                await tgPost('sendMessage', { chat_id: chatId, text: `❌ ${result.error || 'Gửi thất bại!'}` });
              }
              continue;
            }
            // Lệnh khác khi đang pending → hủy pending rồi xử lý lệnh
            pendingSupportReplies.delete(pendingKey);
          } else if (pending) {
            pendingSupportReplies.delete(pendingKey);
          }

          if (text === '/crm' || text === '/stats' || text === '/start') {
            const report = generateCRMReportMessage();
            await tgPost('sendMessage', { chat_id: chatId, text: report.text, parse_mode: 'Markdown', reply_markup: report.keyboard });
          } else if (text === '/help') {
            await tgPost('sendMessage', {
              chat_id: chatId,
              text: '🤖 *ShipFee CRM Bot*\n\n`/crm` `/stats` — Dashboard\n`/orders` — Đơn chờ\n`/support` — Chat hỗ trợ tài xế\n`/reply <threadId|sđt> <tin>` — Trả lời TX\n`/pending_shippers` — Shipper chờ duyệt\n`/shippers` — Shipper online\n`/find <tên|sđt>` — Tìm tài xế\n`/assign <mã_đơn> <tài_xế>` — Gán đơn\n`/help` — Trợ giúp',
              parse_mode: 'Markdown'
            });
          } else if (text === '/support' || text === '/supports' || text === '/chat') {
            const supportMsg = generateSupportListMessage();
            await tgPost('sendMessage', { chat_id: chatId, text: supportMsg.text, parse_mode: 'Markdown', reply_markup: supportMsg.keyboard });
          } else if (text.startsWith('/reply ') || text.startsWith('/r ')) {
            const raw = String(msg.text || '').trim().replace(/^\/(reply|r)\s+/i, '');
            const spaceIdx = raw.search(/\s/);
            if (spaceIdx < 1) {
              await tgPost('sendMessage', {
                chat_id: chatId,
                text: '⚠️ Cú pháp: `/reply <threadId hoặc SĐT> <nội dung>`\nVí dụ: `/reply 0907296261 Đang xử lý giúp bạn`',
                parse_mode: 'Markdown'
              });
              continue;
            }
            const target = raw.slice(0, spaceIdx).trim();
            const body = raw.slice(spaceIdx + 1).trim();
            let threadId = target;
            if (!target.startsWith('sst-') && deps.readShipperSupportThreads) {
              const phone = target.replace(/\s+/g, '');
              const open = deps.readShipperSupportThreads().find(t =>
                t.status === 'open' && String(t.shipperPhone || '').replace(/\s+/g, '') === phone
              );
              if (open) threadId = open.id;
            }
            const result = await adminReplySupportThread(threadId, body, chatId);
            if (result.ok) {
              const detail = generateSupportThreadMessage(result.thread);
              await tgPost('sendMessage', {
                chat_id: chatId,
                text: `✅ *Đã gửi tới tài xế!*\n\n${detail.text}`,
                parse_mode: 'Markdown',
                reply_markup: detail.keyboard
              });
            } else {
              await tgPost('sendMessage', { chat_id: chatId, text: `❌ ${result.error || 'Gửi thất bại!'}` });
            }
          } else if (text === '/shippers' || text === '/drivers') {
            const shippersMsg = generateShippersReportMessage();
            await tgPost('sendMessage', { chat_id: chatId, text: shippersMsg.text, parse_mode: 'Markdown', reply_markup: shippersMsg.keyboard });
          } else if (text === '/orders' || text === '/pending_orders') {
            const pendingMsg = generatePendingOrdersMessage();
            await tgPost('sendMessage', { chat_id: chatId, text: pendingMsg.text, parse_mode: 'Markdown', reply_markup: pendingMsg.keyboard });
          } else if (text === '/pending_shippers') {
            const pendingMsg = generatePendingShippersMessage();
            await tgPost('sendMessage', { chat_id: chatId, text: pendingMsg.text, parse_mode: 'Markdown', reply_markup: pendingMsg.keyboard });
          } else if (text.startsWith('/find ') || text.startsWith('/search ')) {
            const query = text.replace(/^\/(find|search)\s+/, '').trim();
            const results = findShipperInDatabase(query);
            if (results.length === 0) {
              await tgPost('sendMessage', { chat_id: chatId, text: `🔍 *Tìm kiếm tài xế:* "${query}"\n\n⚠️ Không tìm thấy!`, parse_mode: 'Markdown' });
            } else if (results.length === 1) {
              const report = generateShipperDetailMessage(results[0]);
              await tgPost('sendMessage', { chat_id: chatId, text: report.text, parse_mode: 'Markdown', reply_markup: report.keyboard });
            } else {
              const keyboard = { inline_keyboard: results.map(s => ([{
                text: `🔎 ${s.name} (${s.phone})`,
                callback_data: `select_shipper:${s.phone}`
              }])) };
              keyboard.inline_keyboard.push([{ text: '⬅️ Menu', callback_data: 'crm_main_menu' }]);
              await tgPost('sendMessage', {
                chat_id: chatId,
                text: `🔍 *Tìm thấy ${results.length} tài xế:* "${query}"`,
                parse_mode: 'Markdown',
                reply_markup: keyboard
              });
            }
          } else if (text.startsWith('/assign ')) {
            const params = text.replace(/^\/assign\s+/, '').trim().split(/\s+/);
            if (params.length < 2) {
              await tgPost('sendMessage', { chat_id: chatId, text: '⚠️ Cú pháp: `/assign <mã_đơn> <sđt_tài_xế>`', parse_mode: 'Markdown' });
              continue;
            }
            const orderIdInput = params[0].toUpperCase();
            const shipperQuery = params.slice(1).join(' ').trim();
            const orders = deps.readOrdersDatabase();
            const order = orders.find(o => o.id.toUpperCase() === orderIdInput);
            if (!order || order.status !== 'PENDING') {
              await tgPost('sendMessage', { chat_id: chatId, text: `❌ Đơn \`${orderIdInput}\` không hợp lệ hoặc không PENDING.`, parse_mode: 'Markdown' });
              continue;
            }
            const matchedShippers = findShipperInDatabase(shipperQuery);
            if (matchedShippers.length === 1) {
              const result = await assignOrderToShipper(order.id, matchedShippers[0].phone);
              const msgText = result.ok
                ? `🎯 *Gán đơn thành công!*\n\`${result.order.id}\` → ${result.shipper.name}`
                : `❌ ${result.error}`;
              await tgPost('sendMessage', { chat_id: chatId, text: msgText, parse_mode: 'Markdown' });
            } else if (matchedShippers.length > 1) {
              const keyboard = { inline_keyboard: matchedShippers.map(s => ([{
                text: `🚴 ${s.name} (${s.phone})`,
                callback_data: `assign_to_shipper:${order.id}:${s.phone}`
              }])) };
              await tgPost('sendMessage', { chat_id: chatId, text: `Chọn tài xế cho đơn \`${order.id}\`:`, parse_mode: 'Markdown', reply_markup: keyboard });
            } else {
              await tgPost('sendMessage', { chat_id: chatId, text: `❌ Không tìm thấy tài xế: "${shipperQuery}"`, parse_mode: 'Markdown' });
            }
          }
        }

        if (update.callback_query) {
          const cb = update.callback_query;
          const data = cb.data;
          const msgId = cb.message?.message_id;
          const chatId = cb.message?.chat?.id;

          if (!isAuthorizedChat(chatId)) {
            await tgPost('answerCallbackQuery', { callback_query_id: cb.id, text: 'Unauthorized chat!' });
            continue;
          }

          const answer = (text, extra = {}) => tgPost('answerCallbackQuery', { callback_query_id: cb.id, text, ...extra });
          const edit = (text, keyboard) => tgPost('editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'Markdown', reply_markup: keyboard });

          if (data.startsWith('approve_shipper:')) {
            const phone = data.split(':')[1];
            const shippersBefore = deps.readShippersDatabase();
            const shipperBefore = shippersBefore.find(s => s.phone.trim().replace(/\s+/g, '') === phone.trim().replace(/\s+/g, ''));
            const ok = await deps.approveShipperAccount(phone);
            if (ok) {
              notifyShipperAction('approved', shipperBefore || { phone, name: phone });
              await answer('Phê duyệt tài xế thành công!');
              await edit(`✅ *Đã duyệt tài xế thành công!*\nSố điện thoại: ${phone}`);
            } else await answer('Lỗi phê duyệt!');
          } else if (data.startsWith('reject_shipper:')) {
            const phone = data.split(':')[1];
            const shippersBefore = deps.readShippersDatabase();
            const shipperBefore = shippersBefore.find(s => s.phone.trim().replace(/\s+/g, '') === phone.trim().replace(/\s+/g, ''));
            const ok = await deps.rejectShipperAccount(phone);
            if (ok) {
              notifyShipperAction('rejected', shipperBefore || { phone, name: phone });
              await answer('Đã từ chối tài xế!');
              await edit(`❌ *Đã từ chối và xóa tài xế!*\nSố điện thoại: ${phone}`);
            } else await answer('Lỗi từ chối!');
          } else if (data === 'crm_refresh_stats' || data === 'crm_main_menu') {
            const report = generateCRMReportMessage();
            await answer('Đã làm mới số liệu!');
            await edit(report.text, report.keyboard);
          } else if (data === 'crm_shippers_report') {
            const shippersMsg = generateShippersReportMessage();
            await answer('Đã tải danh sách tài xế!');
            await edit(shippersMsg.text, shippersMsg.keyboard);
          } else if (data === 'crm_pending_orders') {
            const pendingMsg = generatePendingOrdersMessage();
            await answer('Đã tải đơn chờ!');
            await edit(pendingMsg.text, pendingMsg.keyboard);
          } else if (data === 'crm_pending_shippers') {
            const pendingMsg = generatePendingShippersMessage();
            await answer('Đã tải shipper chờ duyệt!');
            await edit(pendingMsg.text, pendingMsg.keyboard);
          } else if (data === 'crm_support_list') {
            const supportMsg = generateSupportListMessage();
            await answer('Danh sách hỗ trợ!');
            await edit(supportMsg.text, supportMsg.keyboard);
          } else if (data.startsWith('support_view:')) {
            const threadId = data.slice('support_view:'.length);
            const threads = deps.readShipperSupportThreads ? deps.readShipperSupportThreads() : [];
            const thread = threads.find(t => t.id === threadId);
            if (!thread) {
              await answer('Không tìm thấy hội thoại!', { show_alert: true });
              continue;
            }
            if (deps.markShipperSupportRead) deps.markShipperSupportRead(threadId, 'admin');
            const detail = generateSupportThreadMessage(thread);
            await answer('Chi tiết hội thoại!');
            await edit(detail.text, detail.keyboard);
          } else if (data.startsWith('support_reply:')) {
            const threadId = data.slice('support_reply:'.length);
            const threads = deps.readShipperSupportThreads ? deps.readShipperSupportThreads() : [];
            const thread = threads.find(t => t.id === threadId);
            if (!thread) {
              await answer('Không tìm thấy hội thoại!', { show_alert: true });
              continue;
            }
            if (thread.status === 'resolved') {
              await answer('Hội thoại đã đóng — mở lại khi TX nhắn mới.', { show_alert: true });
              continue;
            }
            pendingSupportReplies.set(String(chatId), {
              threadId,
              expiresAt: Date.now() + SUPPORT_REPLY_TTL_MS
            });
            await answer('Nhập tin trả lời...');
            await tgPost('sendMessage', {
              chat_id: chatId,
              text:
                `💬 *Trả lời ${thread.shipperName || thread.shipperPhone}*\n\n` +
                `Gõ nội dung tin nhắn ngay bên dưới (trong 5 phút).\n` +
                `Tài xế sẽ nhận trong app « Nhắn CRM hỗ trợ ».\n\n` +
                `Hoặc: \`/reply ${thread.shipperPhone} <nội dung>\`\n` +
                `Huỷ: \`/cancel\``,
              parse_mode: 'Markdown'
            });
          } else if (data.startsWith('support_resolve:')) {
            const threadId = data.slice('support_resolve:'.length);
            const result = await adminResolveSupportThread(threadId);
            if (result.ok) {
              await answer('Đã đóng hỗ trợ!');
              await edit(
                `✅ *Đã đóng hội thoại hỗ trợ*\n\n🛵 ${result.thread.shipperName || ''} (\`${result.thread.shipperPhone}\`)`,
                {
                  inline_keyboard: [[
                    { text: '💬 Danh sách hỗ trợ', callback_data: 'crm_support_list' },
                    { text: '🔗 Mở CRM', url: crmLink('support') }
                  ]]
                }
              );
            } else {
              await answer(result.error || 'Lỗi!', { show_alert: true });
            }
          } else if (data.startsWith('view_order_details:')) {
            const orderId = data.split(':')[1];
            const order = deps.readOrdersDatabase().find(o => o.id === orderId);
            if (!order) { await answer('Không tìm thấy đơn!'); continue; }
            const detail = generateOrderDetailMessage(order);
            await answer('Chi tiết đơn!');
            await edit(detail.text, detail.keyboard);
          } else if (data.startsWith('advance_status:')) {
            const parts = data.split(':');
            const orderId = parts[1];
            const newStatus = parts[2];
            const result = await advanceOrderStatus(orderId, newStatus);
            if (result.ok) {
              sendOrderStatusUpdateNotification(result.order).catch(() => {});
              const detail = generateOrderDetailMessage(result.order);
              await answer(`Đã chuyển sang ${newStatus}!`);
              await edit(`✅ *Cập nhật trạng thái thành công!*\n\n${detail.text}`, detail.keyboard);
            } else await answer(result.error || 'Lỗi!', { show_alert: true });
          } else if (data.startsWith('reassign_select:')) {
            const orderId = data.split(':')[1];
            const picker = await buildShipperPickerKeyboard(orderId, 'reassign');
            if (!picker || picker.error) {
              await answer(picker?.error || 'Lỗi!', { show_alert: true });
              continue;
            }
            await answer('Chọn tài xế mới...');
            await edit(
              `🔄 *GÁN LẠI TÀI XẾ*\n\n🆔 \`${orderId}\`\nTop 10 tài xế gần quán nhất:`,
              picker.keyboard
            );
          } else if (data.startsWith('reassign_to_shipper:')) {
            const parts = data.split(':');
            const orderId = parts[1];
            const phone = parts[2];
            const result = await assignOrderToShipper(orderId, phone, { isReassign: true });
            if (result.ok) {
              sendOrderStatusUpdateNotification(result.order).catch(() => {});
              await answer('Đã gán lại tài xế!');
              await edit(`🔄 *Gán lại thành công!*\n\n🆔 \`${orderId}\`\n👤 ${result.shipper.name} (${result.shipper.phone})`);
            } else await answer(result.error || 'Thất bại!', { show_alert: true });
          } else if (data.startsWith('assign_auto:')) {
            const orderId = data.split(':')[1];
            const order = deps.readOrdersDatabase().find(o => o.id === orderId);
            if (!order || order.status !== 'PENDING') { await answer('Đơn không hợp lệ!'); continue; }
            const nearest = deps.findNearestAvailableShipper(order.restaurantLat, order.restaurantLon, order.declinedShippers);
            if (!nearest) { await answer('Không có shipper rảnh gần!', { show_alert: true }); continue; }
            const result = await assignOrderToShipper(orderId, nearest.phone);
            if (result.ok) {
              sendOrderStatusUpdateNotification(result.order).catch(() => {});
              await answer('Đã gán tự động!');
              await edit(`🚴 *Gán tự động thành công!*\n\n🆔 \`${orderId}\`\n👤 ${result.shipper.name}\n📍 ${nearest.distance.toFixed(2)} km`);
            } else await answer(result.error || 'Thất bại!');
          } else if (data.startsWith('assign_select:')) {
            const orderId = data.split(':')[1];
            const picker = await buildShipperPickerKeyboard(orderId, 'assign');
            if (!picker || picker.error) {
              await answer(picker?.error || 'Lỗi!', { show_alert: true });
              continue;
            }
            await answer('Đang tải danh sách...');
            await edit(`🎯 *CHỌN TÀI XẾ CHO ĐƠN* \`${orderId}\`\n(${picker.count} online)`, picker.keyboard);
          } else if (data.startsWith('assign_to_shipper:')) {
            const parts = data.split(':');
            const orderId = parts[1];
            const phone = parts[2];
            const result = await assignOrderToShipper(orderId, phone);
            if (result.ok) {
              sendOrderStatusUpdateNotification(result.order).catch(() => {});
              await answer('Đã gán đơn!');
              await edit(`🎯 *Gán đơn thành công!*\n\n🆔 \`${orderId}\`\n👤 ${result.shipper.name} (${result.shipper.phone})`);
            } else await answer(result.error || 'Thất bại!', { show_alert: true });
          } else if (data.startsWith('cancel_order:')) {
            const orderId = data.split(':')[1];
            const result = await cancelOrderById(orderId);
            if (result.ok) {
              sendOrderStatusUpdateNotification(result.order).catch(() => {});
              await answer('Đã hủy đơn!');
              await edit(`❌ *Đơn đã hủy!*\n🆔 \`${orderId}\``);
            } else await answer(result.error || 'Không hủy được!');
          } else if (data.startsWith('sos_assign_select:')) {
            const phone = data.split(':')[1];
            const cleanP = phone.trim().replace(/\s+/g, '');
            const pendingOrders = deps.readOrdersDatabase().filter(o =>
              o.status === 'PENDING' && (!o.assignedShipperPhone || (o.offerExpiresAt && Date.now() > o.offerExpiresAt))
            );
            if (pendingOrders.length === 0) {
              await answer('Không có đơn PENDING!', { show_alert: true });
              continue;
            }
            const keyboard = { inline_keyboard: pendingOrders.map(o => ([{
              text: `📦 ${o.id} - ${o.restaurantName}`,
              callback_data: `sos_assign_confirm:${cleanP}:${o.id}`
            }])) };
            keyboard.inline_keyboard.push([{ text: '⬅️ Quay lại', callback_data: `sos_back:${cleanP}` }]);
            await answer('');
            await edit(`🎯 *Chọn đơn gán cho:* \`${phone}\``, keyboard);
          } else if (data.startsWith('sos_assign_confirm:')) {
            const parts = data.split(':');
            const cleanP = parts[1];
            const orderId = parts[2];
            const result = await assignOrderToShipper(orderId, cleanP);
            if (result.ok) {
              const shippersDB = deps.readShippersDatabase();
              const sIdx = shippersDB.findIndex(s => s.phone.trim().replace(/\s+/g, '') === cleanP);
              if (sIdx !== -1) {
                shippersDB[sIdx].assistanceRequested = false;
                deps.writeShippersDatabase(shippersDB);
                if (deps.supabase && shippersDB[sIdx].id) {
                  deps.supabase.from('shipper_profiles').update({ assistance_requested: false }).eq('id', shippersDB[sIdx].id).catch(() => {});
                }
              }
              sendOrderStatusUpdateNotification(result.order).catch(() => {});
              await answer('Gán SOS thành công!');
              await edit(`✅ *SOS — Gán đơn thành công!*\n\n🆔 \`${orderId}\`\n🛵 ${result.shipper.name}`);
            } else await answer(result.error || 'Thất bại!');
          } else if (data.startsWith('sos_cancel:')) {
            const cleanP = data.split(':')[1].trim().replace(/\s+/g, '');
            const shippers = deps.readShippersDatabase();
            const idx = shippers.findIndex(s => s.phone.trim().replace(/\s+/g, '') === cleanP);
            if (idx !== -1) {
              shippers[idx].assistanceRequested = false;
              deps.writeShippersDatabase(shippers);
              if (deps.supabase && shippers[idx].id) {
                deps.supabase.from('shipper_profiles').update({ assistance_requested: false }).eq('id', shippers[idx].id).catch(() => {});
              }
              await answer('Đã hủy SOS!');
              await edit(`❌ *Đã hủy yêu cầu SOS!*\n🛵 ${shippers[idx].name} (${shippers[idx].phone})`);
            } else await answer('Không tìm thấy tài xế!');
          } else if (data.startsWith('sos_back:')) {
            const cleanP = data.split(':')[1].trim().replace(/\s+/g, '');
            const s = deps.readShippersDatabase().find(sh => sh.phone.trim().replace(/\s+/g, '') === cleanP);
            if (!s) { await answer('Không tìm thấy!'); continue; }
            await answer('');
            await edit(
              `🆘 *Tài xế yêu cầu Hỗ trợ Tìm đơn*\n\n🛵 ${s.name} (${s.phone})`,
              { inline_keyboard: [[
                { text: '🎯 Chỉ định đơn nhanh', callback_data: `sos_assign_select:${cleanP}` },
                { text: '❌ Hủy SOS', callback_data: `sos_cancel:${cleanP}` }
              ]] }
            );
          } else if (data.startsWith('select_shipper:')) {
            const phone = data.split(':')[1];
            const shipper = deps.readShippersDatabase().find(s => s.phone.trim().replace(/\s+/g, '') === phone.trim().replace(/\s+/g, ''));
            if (shipper) {
              const report = generateShipperDetailMessage(shipper);
              await answer('Chi tiết tài xế!');
              await edit(report.text, report.keyboard);
            } else await answer('Không tìm thấy!');
          } else if (data.startsWith('shipper_approve:')) {
            const phone = data.split(':')[1];
            const shipperBefore = deps.readShippersDatabase().find(s => s.phone.trim().replace(/\s+/g, '') === phone.trim().replace(/\s+/g, ''));
            const ok = await deps.approveShipperAccount(phone);
            if (ok) {
              notifyShipperAction('approved', shipperBefore);
              const shipper = deps.readShippersDatabase().find(s => s.phone.trim().replace(/\s+/g, '') === phone.trim().replace(/\s+/g, ''));
              const report = generateShipperDetailMessage(shipper);
              await answer('Đã phê duyệt!');
              await edit(`✅ *Đã phê duyệt!*\n\n${report.text}`, report.keyboard);
            } else await answer('Lỗi phê duyệt!');
          } else if (data.startsWith('shipper_reject:') || data.startsWith('shipper_delete:')) {
            const phone = data.split(':')[1];
            const shipperBefore = deps.readShippersDatabase().find(s => s.phone.trim().replace(/\s+/g, '') === phone.trim().replace(/\s+/g, ''));
            const ok = await deps.rejectShipperAccount(phone);
            if (ok) {
              notifyShipperAction('rejected', shipperBefore);
              await answer('Đã xóa tài xế!');
              await edit(`❌ *Đã xóa tài xế!*\nSĐT: ${phone}`, { inline_keyboard: [[{ text: '⬅️ Menu', callback_data: 'crm_main_menu' }]] });
            } else await answer('Lỗi xóa!');
          } else if (data.startsWith('shipper_lock:')) {
            const phone = data.split(':')[1];
            const shipperBefore = deps.readShippersDatabase().find(s => s.phone.trim().replace(/\s+/g, '') === phone.trim().replace(/\s+/g, ''));
            const ok = await deps.lockShipperAccount(phone);
            if (ok) {
              notifyShipperAction('locked', shipperBefore);
              const shipper = deps.readShippersDatabase().find(s => s.phone.trim().replace(/\s+/g, '') === phone.trim().replace(/\s+/g, ''));
              const report = generateShipperDetailMessage(shipper);
              await answer('Đã khóa!');
              await edit(`🔒 *Đã khóa tài khoản!*\n\n${report.text}`, report.keyboard);
            } else await answer('Lỗi khóa!');
          } else if (data.startsWith('shipper_refresh:')) {
            const phone = data.split(':')[1];
            const shipper = deps.readShippersDatabase().find(s => s.phone.trim().replace(/\s+/g, '') === phone.trim().replace(/\s+/g, ''));
            if (shipper) {
              const report = generateShipperDetailMessage(shipper);
              await answer('Đã làm mới!');
              await edit(report.text, report.keyboard);
            } else await answer('Không tìm thấy!');
          }
        }
      }
}

async function pollOnce() {
  if (!deps.TELEGRAM_BOT_TOKEN) return;
  isPolling = true;
  lastPollAt = Date.now();
  try {
    const response = await axios.get(`${API_BASE}${deps.TELEGRAM_BOT_TOKEN}/getUpdates`, {
      params: { offset: telegramOffset, timeout: 25 },
      timeout: 35000
    });
    const updates = response.data?.result || [];
    pollSuccessCount += 1;
    lastPollError = null;
    if (updates.length > 0) {
      console.log(`[Telegram Bot] Nhận ${updates.length} update(s)`);
      await processUpdates(updates);
    }
    if (global._hasTelegramConflictLogged) {
      console.log('[Telegram Bot] Polling đã lấy lại quyền getUpdates.');
      global._hasTelegramConflictLogged = false;
    }
  } catch (err) {
    const desc = err.response?.data?.description || err.message;
    lastPollError = desc;
    if (err.code !== 'ECONNRESET' && err.code !== 'ETIMEDOUT' && err.code !== 'ECONNABORTED') {
      const isConflict = err.response && err.response.status === 409;
      if (isConflict) {
        if (!global._hasTelegramConflictLogged) {
          console.log('[Telegram Bot] ⚠️ Bot đang poll song song ở nơi khác (local/Render). Chờ đồng bộ...');
          global._hasTelegramConflictLogged = true;
        }
        await new Promise(r => setTimeout(r, 20000));
      } else {
        console.error('[Telegram Polling Error]:', desc);
      }
    }
  } finally {
    isPolling = false;
  }
}

async function runPollLoop() {
  while (pollLoopActive) {
    await pollOnce();
    if (!pollLoopActive) break;
    // Nghỉ ngắn giữa các long-poll; nếu 409 thì pollOnce đã chờ thêm
    await new Promise(r => setTimeout(r, 500));
  }
}

function startPolling() {
  if (!deps.TELEGRAM_BOT_TOKEN) {
    console.log('[Telegram Bot] TELEGRAM_BOT_TOKEN chưa cấu hình, bỏ qua polling.');
    return;
  }
  if (pollLoopActive) {
    console.log('[Telegram Bot] Poll loop đã chạy, bỏ qua start trùng.');
    return;
  }
  pollLoopActive = true;
  console.log('[Telegram Bot] Khởi chạy Telegram Polling Daemon (recursive loop)...');
  console.log(`[Telegram Bot] TELEGRAM_CHAT_ID=${deps.TELEGRAM_CHAT_ID || '(chưa set)'}`);
  restartPeriodicReport();
  runPollLoop().catch(e => {
    pollLoopActive = false;
    console.error('[Telegram Bot] Poll loop dừng vì lỗi:', e.message);
  });
}

module.exports = function createTelegramBot(depsIn) {
  deps = depsIn;
  return {
    sendNewShipperNotification,
    sendNewOrderNotification,
    sendOrderStatusUpdateNotification,
    sendSlaBreachNotification,
    sendSosNotification,
    sendShipperSupportNotification,
    sendRestaurantAlert,
    sendPeriodicReport,
    checkAndNotifySla,
    restartPeriodicReport,
    startPolling,
    getStatus,
    crmLink
  };
};
