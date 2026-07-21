/**
 * ShipFee — Proxy Server
 * Tự động lấy data quán ăn từ ShopeeFood Cần Thơ
 * Cache 10 phút, fallback về data local nếu API fail
 */

// Ngăn chặn server bị sập do lỗi bất đồng bộ của Puppeteer hoặc các tác vụ nền
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Unhandled Rejection] Lỗi bất đồng bộ được bỏ qua để giữ server an toàn:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[Uncaught Exception] Ngoại lệ chưa bắt được bỏ qua để giữ server an toàn:', error);
});

const express     = require('express');
const cors        = require('cors');
const compression = require('compression');
const axios       = require('axios');
const fs          = require('fs');
const path        = require('path');
const { exec }    = require('child_process');
const cheerio     = require('cheerio');
const menuScraper = require('./menuScraper');
const dbHelper    = require('./dbHelper');
const { analyzeMenuQuality, applyMenuFlags } = require('./menuQuality');
const crm = require('./crmHelpers');

// ── SYSTEM NOTIFICATIONS (Lưu cục bộ và đồng bộ Supabase) ────────────────────
const NOTIFICATIONS_FILE = path.join(__dirname, 'notifications-local.json');

function readNotifications() {
  if (!fs.existsSync(NOTIFICATIONS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf8')) || [];
  } catch (e) {
    return [];
  }
}

function writeNotifications(notifs) {
  try {
    fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(notifs || [], null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

async function syncNotificationToSupabase(notif) {
  if (!supabase) return;
  // Delegate qua module chung supabaseSync để nhất quán schema với các script GrabFood
  const res = await supaSync.insertNotification(notif, { client: supabase });
  if (!res.ok && !res.skipped) {
    console.warn('[Supabase Sync] Không thể sync notification lên Supabase:', res.error);
  }
}

/**
 * Kéo thông báo biến động (do scheduler ở local/VPS tạo) từ Supabase về local trên Render.
 * Best-effort: không làm hỏng gì nếu bảng/schema khác — chỉ merge theo id.
 */
async function hydrateNotificationsFromSupabase() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase
      .from('system_notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(300);
    if (error) {
      console.warn('[Notif Hydrate] Không đọc được từ Supabase:', error.message);
      return;
    }
    if (!Array.isArray(data) || data.length === 0) return;

    const local = readNotifications();
    const byId = new Map(local.map(n => [String(n.id), n]));
    let added = 0;
    for (const row of data) {
      const id = String(row.id);
      if (!id || byId.has(id)) continue;
      const rawCreated = row.created_at;
      const createdAt = typeof rawCreated === 'number'
        ? rawCreated
        : (Date.parse(rawCreated) || Date.now());
      byId.set(id, {
        id: row.id,
        type: row.type,
        restaurantId: row.restaurant_id,
        restaurantName: row.restaurant_name,
        title: row.title,
        message: row.message,
        createdAt,
        read: row.read === true
      });
      added++;
    }
    if (added > 0) {
      const merged = Array.from(byId.values())
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, 200);
      writeNotifications(merged);
      if (typeof invalidateAdminChangedCache === 'function') invalidateAdminChangedCache();
      console.log(`[Notif Hydrate] Đã bổ sung ${added} thông báo biến động từ Supabase.`);
    }
  } catch (e) {
    console.warn('[Notif Hydrate] Lỗi:', e.message);
  }
}

function addNotification(type, restaurantId, restaurantName, title, message) {
  const notifs = readNotifications();
  const notif = {
    id: 'nt-' + Date.now() + '-' + Math.floor(1000 + Math.random() * 9000),
    type,
    restaurantId,
    restaurantName,
    title,
    message,
    createdAt: Date.now(),
    read: false
  };
  notifs.unshift(notif);
  if (notifs.length > 200) notifs.pop();
  writeNotifications(notifs);
  
  // Đồng bộ ngầm
  syncNotificationToSupabase(notif);
  return notif;
}

function diffAndLogMenuChanges(restaurant, oldMenu, newMenu) {
  if (!oldMenu || oldMenu.length === 0) return; // Không diff nếu trước đó là menu fallback
  if (!newMenu || newMenu.length === 0) return;

  const oldMap = new Map();
  (oldMenu || []).forEach(item => {
    if (item && item.name) {
      oldMap.set(item.name.trim(), item);
    }
  });

  const newMap = new Map();
  (newMenu || []).forEach(item => {
    if (item && item.name) {
      newMap.set(item.name.trim(), item);
    }
  });

  const changes = [];

  // So sánh đổi giá và món mới
  for (const [name, newItem] of newMap.entries()) {
    const oldItem = oldMap.get(name);
    if (oldItem) {
      if (oldItem.inStorePrice !== newItem.inStorePrice) {
        const diff = newItem.inStorePrice - oldItem.inStorePrice;
        const pct = Math.round((diff / oldItem.inStorePrice) * 100);
        changes.push(`Món "${name}" đổi giá: ${oldItem.inStorePrice.toLocaleString()}đ -> ${newItem.inStorePrice.toLocaleString()}đ (${diff > 0 ? '+' : ''}${diff.toLocaleString()}đ, ${diff > 0 ? 'tăng' : 'giảm'} ${Math.abs(pct)}%)`);
      }
    } else {
      changes.push(`Món mới: "${name}" với giá ${newItem.inStorePrice.toLocaleString()}đ`);
    }
  }

  // So sánh món bị xóa
  for (const name of oldMap.keys()) {
    if (!newMap.has(name)) {
      changes.push(`Xóa món: "${name}" khỏi thực đơn`);
    }
  }

  if (changes.length > 0) {
    console.log(`[Diff Menu] 🔔 Phát hiện thay đổi thực đơn/giá tại "${restaurant.name}":`, changes);
    notifyCrmAndTelegram(
      'price_change',
      restaurant.id,
      restaurant.name,
      'Cập nhật thực đơn & Giá bán',
      changes.join('\n')
    );
  }
}


// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { createClient } = require('@supabase/supabase-js');
const supaSync = require('./supabaseSync');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || '').trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

let supabase = null;
/** Anon client — dùng gửi email Auth (resend signup / magic link) vì SMTP đi qua Auth API public. */
let supabaseAnon = null;
const SHIPPER_APP_URL = (process.env.SHIPPER_APP_URL || 'https://shipfee.vercel.app/shipper-app/').replace(/\/?$/, '/');

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && SUPABASE_URL !== 'your_supabase_url_here') {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
  console.log('[Supabase] Client initialized successfully via Service Role Key');

  if (SUPABASE_ANON_KEY) {
    supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  }
  
  // Tự động kiểm tra và tạo tài khoản Admin mặc định
  seedAdminUser();
  // Tự động kiểm tra và tạo storage bucket "avatars" công khai
  initSupabaseStorage();
} else {
  console.log('[Supabase] Supabase is NOT configured. Operating in LOCAL/BYPASS mode.');
}

/**
 * Gửi email xác nhận Supabase SAU KHI CRM duyệt tài xế (không gửi lúc đăng ký).
 *
 * Luồng chuẩn:
 * 1) Chưa confirm → resend signup confirmation (template Confirm signup)
 * 2) Nếu SMTP/resend fail → generateLink(type: signup) để CRM copy gửi tay
 * 3) Đã confirm từ trước → chỉ báo có thể đăng nhập (không gửi magic-link "Sign in"
 *    — tránh trùng / nhầm với email lúc đăng ký)
 *
 * Lưu ý: KHÔNG dùng signInWithOtp ở đây (email "Your sign-in link" gây nhầm lẫn
 * với bước chờ duyệt admin).
 */
async function sendShipperApprovalConfirmationEmail(shipper) {
  if (!supabase) {
    return { sent: false, error: 'Supabase chưa cấu hình', method: null, confirmationLink: null };
  }

  let email = (shipper?.email || '').trim().toLowerCase();
  let emailConfirmed = false;
  let userId = shipper?.id || null;

  try {
    if (userId) {
      const { data: userData, error: getErr } = await supabase.auth.admin.getUserById(userId);
      if (getErr) {
        console.warn('[Approve Email] Không lấy được user Auth:', getErr.message);
      } else if (userData?.user) {
        email = email || (userData.user.email || '').trim().toLowerCase();
        emailConfirmed = !!userData.user.email_confirmed_at;
        userId = userData.user.id;
      }
    }

    if (!email) {
      return { sent: false, error: 'Tài xế chưa có email liên kết', method: null, confirmationLink: null };
    }

    const emailRedirectTo = `${SHIPPER_APP_URL}?approved=1`;
    const errors = [];

    // Đã confirm email sẵn → không gửi thêm magic link (tránh email "Sign in" thừa)
    if (emailConfirmed) {
      console.log(`[Approve Email] ${email} đã confirm — bỏ qua gửi email Auth`);
      return {
        sent: false,
        error: null,
        method: 'already_confirmed',
        confirmationLink: null
      };
    }

    // Gửi email Confirm signup — CHỈ sau khi admin duyệt (không phải magic-link "Sign in")
    if (supabaseAnon) {
      const { error: resendErr } = await supabaseAnon.auth.resend({
        type: 'signup',
        email,
        options: { emailRedirectTo }
      });
      if (!resendErr) {
        console.log(`[Approve Email] Đã gửi signup confirmation tới ${email}`);
        return { sent: true, error: null, method: 'signup_confirm', confirmationLink: null };
      }
      errors.push('resend: ' + resendErr.message);
      console.warn('[Approve Email] resend signup thất bại:', resendErr.message);
    } else {
      errors.push('Thiếu SUPABASE_ANON_KEY');
    }

    // Fallback an toàn: không gửi magic-link. Auto-confirm để tài xế đăng nhập bằng mật khẩu đã tạo lúc đăng ký.
    if (userId) {
      try {
        await supabase.auth.admin.updateUserById(userId, { email_confirm: true });
        console.warn(`[Approve Email] Đã auto-confirm ${email} (không gửi được email Confirm signup)`);
        return {
          sent: false,
          error: (errors.join(' | ') || 'Không gửi được email xác nhận') +
            ' — đã xác nhận email giúp tài xế; họ có thể đăng nhập bằng mật khẩu đã đăng ký',
          method: 'auto_confirm',
          confirmationLink: null
        };
      } catch (confirmErr) {
        errors.push('auto_confirm: ' + confirmErr.message);
      }
    }

    return { sent: false, error: errors.join(' | '), method: null, confirmationLink: null };
  } catch (err) {
    console.error('[Approve Email] Exception:', err.message);
    return { sent: false, error: err.message, method: null, confirmationLink: null };
  }
}

async function seedAdminUser() {
  try {
    const adminEmail = 'admin@shipfee.vn';
    const adminPassword = 'admin123';
    
    const { data: { users }, error: listError } = await supabase.auth.admin.listUsers();
    if (listError) {
      console.warn('[Supabase Admin Seed] Không thể lấy danh sách user:', listError.message);
      return;
    }

    const adminExists = users.some(u => u.email === adminEmail);
    if (!adminExists) {
      console.log('[Supabase Admin Seed] Đang khởi tạo tài khoản Admin mặc định...');
      const { data, error } = await supabase.auth.admin.createUser({
        email: adminEmail,
        password: adminPassword,
        email_confirm: true,
        user_metadata: {
          role: 'admin',
          full_name: 'ShipFee Admin'
        }
      });
      if (error) {
        console.error('[Supabase Admin Seed] Tạo tài khoản Admin thất bại:', error.message);
      } else {
        console.log('[Supabase Admin Seed] Đã khởi tạo thành công tài khoản Admin mặc định: admin@shipfee.vn / admin123');
      }
    } else {
      console.log('[Supabase Admin Seed] Tài khoản Admin đã sẵn sàng.');
    }
  } catch (err) {
    console.error('[Supabase Admin Seed] Lỗi khởi tạo:', err.message);
  }
}

async function initSupabaseStorage() {
  if (!supabase) return;
  try {
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();
    if (listError) throw listError;
    
    const exists = buckets.some(b => b.name === 'avatars');
    if (!exists) {
      const { error: createError } = await supabase.storage.createBucket('avatars', {
        public: true,
        fileSizeLimit: 1024 * 1024 * 5 // 5MB
      });
      if (createError) throw createError;
      console.log('[Supabase Storage] Đã khởi tạo bucket "avatars" công khai thành công.');
    } else {
      console.log('[Supabase Storage] Bucket "avatars" đã tồn tại.');
    }
  } catch (err) {
    console.warn('[Supabase Storage] Không thể khởi tạo bucket "avatars" (có thể do thiếu quyền):', err.message);
  }
}

function normalizeImageUrl(url, req) {
  if (!url) return '';
  const isLocal = url.startsWith('http://localhost:3001') || url.startsWith('http://127.0.0.1:3001');
  const isRelative = url.startsWith('/uploads');

  if (isLocal || isRelative) {
    let origin = 'https://shipfee-eo5s.onrender.com';
    if (req) {
      const host = req.headers['x-forwarded-host'] || req.get('host');
      const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      if (host) {
        origin = `${protocol}://${host}`;
      }
    }
    if (isLocal) {
      return url.replace(/^http:\/\/(localhost|127\.0\.0\.1):3001/, origin);
    } else {
      return `${origin}${url}`;
    }
  }
  return url;
}

async function uploadShipperAvatar(cleanedPhone, base64Data, req) {
  let avatarUrl = '';
  // 1. Lưu local filesystem (dự phòng)
  const fileName = `${cleanedPhone}.png`;
  try {
    const base64DataClean = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64DataClean, 'base64');
    const filePath = path.join(UPLOADS_DIR, fileName);
    fs.writeFileSync(filePath, buffer);
    const host = req.headers['x-forwarded-host'] || req.get('host') || 'shipfee-eo5s.onrender.com';
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    avatarUrl = `${protocol}://${host}/uploads/shippers/${fileName}`;
  } catch (err) {
    console.error('[Avatar Local Save Error] Lỗi lưu ảnh local:', err.message);
  }

  // 2. Tải lên Supabase Storage (lưu trữ bền vững đám mây)
  if (supabase) {
    try {
      const base64DataClean = base64Data.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64DataClean, 'base64');
      const { data, error } = await supabase.storage
        .from('avatars')
        .upload(`shippers/${fileName}`, buffer, {
          contentType: 'image/png',
          upsert: true
        });
      if (error) throw error;

      const { data: { publicUrl } } = supabase.storage
        .from('avatars')
        .getPublicUrl(`shippers/${fileName}`);
      
      if (publicUrl) {
        avatarUrl = publicUrl;
        console.log(`[Supabase Storage] Upload thành công avatar của shipper ${cleanedPhone}: ${avatarUrl}`);
      }
    } catch (err) {
      console.warn(`[Supabase Storage Upload Error] Không thể upload avatar lên Supabase Storage (sử dụng URL local dự phòng):`, err.message);
    }
  }
  return avatarUrl;
}

async function syncShippersFromSupabase() {
  if (!supabase) return;
  console.log('[Supabase Sync] 🔄 Đang đồng bộ thông tin tài xế từ Supabase Auth online về local JSON...');
  try {
    const { data: authData, error: authError } = await supabase.auth.admin.listUsers();
    if (authError) throw authError;
    if (!authData || !authData.users) {
      console.log('[Supabase Sync] Không tìm thấy user nào trên Supabase Auth.');
      return;
    }

    const localShippers = readShippersDatabase();
    let changed = false;

    // Lọc ra các user là shipper từ Supabase Auth
    const onlineShippers = authData.users.filter(u => u.user_metadata && u.user_metadata.role === 'shipper');

    onlineShippers.forEach(u => {
      // Chuẩn hóa phone từ định dạng Supabase Auth (+84... hoặc 84... hoặc 0...) về định dạng 0...
      let rawPhone = u.phone || u.user_metadata.phone || '';
      let cleanPhone = rawPhone.trim().replace(/\s+/g, '').replace(/^\+84/, '0').replace(/^84/, '0');
      if (!cleanPhone) return;

      const metadata = u.user_metadata;
      const email = u.email || '';
      
      const idx = localShippers.findIndex(s => s.phone.trim().replace(/\s+/g, '') === cleanPhone);

      if (idx !== -1) {
        // Cập nhật thông tin nếu có sự khác biệt
        const s = localShippers[idx];
        const normalizedMetaAvatar = normalizeImageUrl(metadata.avatar_url || '', null);
        if (
          s.id !== u.id ||
          s.name !== (metadata.full_name || s.name) ||
          s.cccd !== (metadata.cccd || '') ||
          s.avatarUrl !== normalizedMetaAvatar ||
          (email && s.email !== email)
        ) {
          s.id = u.id;
          s.name = metadata.full_name || s.name;
          s.cccd = metadata.cccd || '';
          s.avatarUrl = normalizedMetaAvatar;
          if (email) s.email = email;
          changed = true;
        }
      } else {
        // Thêm shipper mới từ Supabase Auth vào local JSON
        localShippers.push({
          id: u.id,
          phone: cleanPhone,
          name: metadata.full_name || 'Tài xế tự do',
          email: email || `${cleanPhone}@shipfee.vn`,
          cccd: metadata.cccd || '',
          avatarUrl: normalizeImageUrl(metadata.avatar_url || '', null),
          isApproved: true, // Mặc định là true nếu đã có trên Supabase
          status: 'OFFLINE',
          lastCheckIn: null,
          lastCheckOut: null,
          totalOrders: 0,
          totalEarnings: 0,
          acceptanceRate: 100,
          completionRate: 100
        });
        changed = true;
      }

      // Không ghi đè status ONLINE khi sync Auth → tránh mất ca làm việc
      const existingStatus = idx !== -1 ? (localShippers[idx].status || 'OFFLINE') : 'OFFLINE';
      supabase.from('shipper_profiles').upsert({
        id: u.id,
        phone: cleanPhone,
        full_name: metadata.full_name || 'Tài xế tự do',
        status: existingStatus,
        avatar_url: metadata.avatar_url || ''
      }).then(({ error }) => {
        if (error) console.error('[Supabase Sync Error] Lỗi ghi profile dự phòng:', error.message);
      });
    });

    if (changed) {
      writeShippersDatabase(localShippers);
      console.log('[Supabase Sync] ✅ Đã đồng bộ thành công thông tin tài xế từ Supabase Auth về local JSON.');
    } else {
      console.log('[Supabase Sync] Dữ liệu tài xế local đã trùng khớp hoàn toàn với Supabase Auth.');
    }
  } catch (err) {
    console.error('[Supabase Sync Error] Lỗi đồng bộ tài xế từ Supabase Auth:', err.message);
  }
}

// Khởi tạo thư mục upload ảnh chân dung tài xế
const UPLOADS_DIR = path.join(__dirname, 'public/uploads/shippers');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Shipper account mutations (shared by CRM Admin API + Telegram bot)
async function lockShipperAccount(phone) {
  try {
    const shippers = readShippersDatabase();
    const cleanedPhone = phone.trim().replace(/\s+/g, '');
    const shipperIndex = shippers.findIndex(s => s.phone.trim().replace(/\s+/g, '') === cleanedPhone);
    if (shipperIndex === -1) return false;

    const shipper = shippers[shipperIndex];
    shipper.isApproved = false;
    shippers[shipperIndex] = shipper;
    writeShippersDatabase(shippers);

    if (supabase && shipper.id) {
      await supabase.auth.admin.updateUserById(shipper.id, {
        user_metadata: { is_approved: false }
      });
      try {
        await supabase
          .from('shipper_profiles')
          .update({ is_approved: false })
          .eq('id', shipper.id);
      } catch (err) {
        console.warn('[Supabase Error] Lỗi cập nhật khóa trong shipper_profiles:', err.message);
      }
    }
    console.log(`[Lock Shipper] Đã khóa tài xế: ${shipper.name} (${shipper.phone})`);
    return true;
  } catch (err) {
    console.error('[Lock Shipper Error]:', err.message);
    return false;
  }
}

async function approveShipperAccount(phone, options = {}) {
  const forceEmail = !!options.forceEmail;
  try {
    const shippers = readShippersDatabase();
    const cleanedPhone = phone.trim().replace(/\s+/g, '');
    const shipperIndex = shippers.findIndex(s => s.phone.trim().replace(/\s+/g, '') === cleanedPhone);
    if (shipperIndex === -1) {
      return { success: false, emailSent: false, emailError: null, alreadyApproved: false, confirmationLink: null };
    }

    const shipper = shippers[shipperIndex];
    const wasApproved = !!shipper.isApproved;

    if (!wasApproved) {
      shipper.isApproved = true;
      shippers[shipperIndex] = shipper;
      writeShippersDatabase(shippers);

      if (supabase && shipper.id) {
        await supabase.auth.admin.updateUserById(shipper.id, {
          user_metadata: { is_approved: true, pending_crm_approval: false },
          app_metadata: { role: 'shipper', pending_crm_approval: false }
        });
        try {
          await supabase
            .from('shipper_profiles')
            .update({ is_approved: true })
            .eq('id', shipper.id);
        } catch (err) {
          console.warn('[Supabase Error] Lỗi cập nhật is_approved trong table shipper_profiles:', err.message);
        }
      }
    } else if (!forceEmail) {
      // Đã duyệt trước đó — không gửi lại trừ khi force (tránh spam khi bấm duyệt 2 lần)
      return {
        success: true,
        emailSent: false,
        emailError: 'Tài xế đã duyệt trước đó — bấm lại với gửi lại email nếu cần',
        alreadyApproved: true,
        confirmationLink: null,
        shipper
      };
    }

    // Gửi email xác nhận Supabase — shipper biết đăng ký đã được duyệt thành công
    const emailResult = await sendShipperApprovalConfirmationEmail(shipper);
    console.log(`[Approve Shipper] Đã phê duyệt tài xế: ${shipper.name} (${shipper.phone}) | emailSent=${emailResult.sent} | method=${emailResult.method}`);
    return {
      success: true,
      emailSent: !!emailResult.sent,
      emailError: emailResult.error || null,
      emailMethod: emailResult.method || null,
      confirmationLink: emailResult.confirmationLink || null,
      alreadyApproved: wasApproved,
      shipper
    };
  } catch (err) {
    console.error('[Approve Shipper Error]:', err.message);
    return { success: false, emailSent: false, emailError: err.message, alreadyApproved: false, confirmationLink: null };
  }
}

async function rejectShipperAccount(phone) {
  try {
    const shippers = readShippersDatabase();
    const cleanedPhone = phone.trim().replace(/\s+/g, '');
    const shipperIndex = shippers.findIndex(s => s.phone.trim().replace(/\s+/g, '') === cleanedPhone);
    if (shipperIndex === -1) return false;

    const shipper = shippers[shipperIndex];
    const uuid = shipper.id;

    shippers.splice(shipperIndex, 1);
    writeShippersDatabase(shippers);

    const avatarPath = path.join(UPLOADS_DIR, `${cleanedPhone}.png`);
    if (fs.existsSync(avatarPath)) {
      try { fs.unlinkSync(avatarPath); } catch (e) {}
    }

    if (supabase && uuid) {
      await supabase.auth.admin.deleteUser(uuid);
      try {
        await supabase.from('shipper_profiles').delete().eq('id', uuid);
      } catch (err) {}
    }
    console.log(`[Reject Shipper] Đã từ chối và xóa tài xế: ${shipper.name} (${shipper.phone})`);
    return true;
  } catch (err) {
    console.error('[Reject Shipper Error]:', err.message);
    return false;
  }
}

const createTelegramBot = require('./telegramBot');
let telegramBot = null;

async function toggleRestaurantStatusForTelegram(restaurantId, close) {
  const isClosed = !!close;
  let updatedRestaurant = null;
  await updateLocalDatabase((restaurants) => {
    const idx = restaurants.findIndex(r => String(r.id) === String(restaurantId));
    if (idx === -1) return false;
    restaurants[idx].isClosed = isClosed;
    if (isClosed) {
      restaurants[idx].closedAt = new Date().toISOString();
      restaurants[idx].closedReason = 'Admin đóng cửa qua Telegram';
    } else {
      delete restaurants[idx].closedAt;
      delete restaurants[idx].closedReason;
    }
    restaurants[idx].updatedAt = Date.now();
    updatedRestaurant = restaurants[idx];
    return true;
  });
  if (updatedRestaurant) {
    // Chỉ ghi CRM notification — tránh echo alert Telegram khi admin vừa thao tác từ bot
    addNotification(
      'status_change',
      restaurantId,
      updatedRestaurant.name,
      isClosed ? 'Quán đóng cửa (Telegram)' : 'Quán mở cửa (Telegram)',
      `Admin đổi trạng thái qua Telegram → ${isClosed ? 'CLOSED' : 'OPEN'}`
    );
  }
  return updatedRestaurant;
}

function initTelegramBot() {
  telegramBot = createTelegramBot({
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    getPricingConfig: () => pricingConfig,
    readOrdersDatabase,
    readShippersDatabase,
    writeShippersDatabase,
    updateOrdersDatabase,
    approveShipperAccount,
    rejectShipperAccount,
    lockShipperAccount,
    findNearestAvailableShipper,
    calcDistance,
    getOrderSlaInfo,
    canTransitionOrderStatus,
    onlineShipperLocations,
    addNotification,
    upsertOrderToSupabase,
    supabase,
    notifyOrderCancelled: (order) => crm.notifyOrderCancelled(order, addNotification),
    readShipperSupportThreads: () => crm.readShipperSupportThreads(),
    writeShipperSupportThreads: (list) => crm.writeShipperSupportThreads(list),
    appendShipperSupportMessage: (id, msg) => crm.appendShipperSupportMessage(id, msg),
    resolveShipperSupportThread: (id, opts) => crm.resolveShipperSupportThread(id, opts),
    markShipperSupportRead: (id, reader) => crm.markShipperSupportRead(id, reader),
    readNotifications,
    readDisputes: () => crm.readDisputes(),
    writeDisputes: (list) => crm.writeDisputes(list),
    isBlacklisted: (phone) => crm.isBlacklisted(phone),
    addToBlacklist: (phone, reason) => crm.addToBlacklist(phone, reason, 'telegram-admin'),
    toggleRestaurantStatus: toggleRestaurantStatusForTelegram
  });
  return telegramBot;
}

function notifyCrmAndTelegram(type, restaurantId, restaurantName, title, message) {
  addNotification(type, restaurantId, restaurantName, title, message);
  if (telegramBot && (type === 'status_change' || type === 'price_change')) {
    telegramBot.sendRestaurantAlert(type, restaurantName, title, message, restaurantId).catch(() => {});
  }
}

// Middleware: Authenticate Shipper via Supabase JWT
async function authenticateShipper(req, res, next) {
  try {
    if (!supabase) {
      return res.status(503).json({ success: false, error: 'Hệ thống đang hoạt động ở chế độ Supabase trực tuyến nhưng chưa cấu hình thông số kết nối hoặc cấu hình bị lỗi!' });
    }
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Thiếu hoặc sai token xác thực Bearer!' });
    }
    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ success: false, error: 'Token không hợp lệ hoặc đã hết hạn!' });
    }

    // Kiểm tra xem shipper đã được duyệt tài khoản chưa
    const shippers = readShippersDatabase();
    const userPhone = (user.phone || user.user_metadata?.phone || '').trim().replace(/\s+/g, '');
    const shipper = shippers.find(s => s.phone.trim().replace(/\s+/g, '') === userPhone || s.id === user.id);
    
    if (shipper && shipper.isApproved === false) {
      return res.status(403).json({ success: false, error: 'PENDING_APPROVAL', message: 'Tài khoản của bạn đang chờ Admin phê duyệt!' });
    }

    req.user = user;
    req.shipper = shipper || null;
    req.shipperPhone = shipper
      ? shipper.phone.trim().replace(/\s+/g, '')
      : userPhone;
    next();
  } catch (e) {
    res.status(500).json({ success: false, error: 'Lỗi xác thực Shipper: ' + e.message });
  }
}

function cleanPhone(phone) {
  return (phone || '').trim().replace(/\s+/g, '');
}

/** Cần Thơ service center — reject GPS spoofing far outside city */
const SHIPPER_SERVICE_CENTER = { lat: 10.0345, lon: 105.7876 };
const SHIPPER_SERVICE_RADIUS_KM = 35;
const SHIPPER_MAX_SPEED_KMH = 160; // motorcycle + GPS jitter ceiling
const SHIPPER_STALE_ONLINE_MS = 12 * 60 * 1000; // no GPS heartbeat → auto OFFLINE

function getClientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = xf || req.headers['cf-connecting-ip'] || req.ip || req.socket?.remoteAddress || '';
  return String(ip).replace(/^::ffff:/, '');
}

/**
 * Bind body.phone to JWT shipper — block spoofing another driver.
 * Returns { ok, phone, error }.
 */
function resolveAuthenticatedShipperPhone(req, bodyPhone) {
  const authPhone = cleanPhone(req.shipperPhone);
  if (!authPhone) {
    return { ok: false, phone: '', error: 'Không xác định được tài xế từ token' };
  }
  const claimed = cleanPhone(bodyPhone);
  if (claimed && claimed !== authPhone) {
    return { ok: false, phone: authPhone, error: 'Không được thao tác hộ tài xế khác' };
  }
  return { ok: true, phone: authPhone };
}

function isShipperGpsInServiceArea(lat, lon) {
  return calcDistance(lat, lon, SHIPPER_SERVICE_CENTER.lat, SHIPPER_SERVICE_CENTER.lon) <= SHIPPER_SERVICE_RADIUS_KM;
}

/**
 * Validate GPS write: anti-teleport + optional service-area fence for dispatch.
 * Returns { ok, error?, code? }.
 */
function validateShipperLocationUpdate(cleanedPhone, lat, lon, opts = {}) {
  const requireServiceArea = opts.requireServiceArea !== false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { ok: false, code: 'INVALID_COORDS', error: 'Tọa độ không hợp lệ' };
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return { ok: false, code: 'INVALID_COORDS', error: 'Tọa độ ngoài phạm vi' };
  }
  if (requireServiceArea && !isShipperGpsInServiceArea(lat, lon)) {
    return {
      ok: false,
      code: 'OUT_OF_SERVICE_AREA',
      error: 'Vị trí ngoài khu vực phục vụ Cần Thơ — không dùng để nhận đơn'
    };
  }
  const prev = onlineShipperLocations.get(cleanedPhone);
  if (prev && Number.isFinite(prev.lat) && Number.isFinite(prev.lon) && prev.lastSeen) {
    const dtMs = Date.now() - prev.lastSeen;
    if (dtMs > 0 && dtMs < 10 * 60 * 1000) {
      const distKm = calcDistance(prev.lat, prev.lon, lat, lon);
      const speedKmh = distKm / (dtMs / 3600000);
      if (speedKmh > SHIPPER_MAX_SPEED_KMH && distKm > 3) {
        return {
          ok: false,
          code: 'IMPOSSIBLE_JUMP',
          error: 'Phát hiện nhảy vị trí bất thường — từ chối cập nhật GPS'
        };
      }
    }
  }
  return { ok: true };
}

function markStaleShippersOffline() {
  try {
    const shippers = readShippersDatabase();
    const now = Date.now();
    let changed = false;
    for (let i = 0; i < shippers.length; i++) {
      const s = shippers[i];
      if (s.status !== 'ONLINE') continue;
      const phone = cleanPhone(s.phone);
      const loc = onlineShipperLocations.get(phone);
      const lastSeen = loc?.lastSeen || 0;
      // Keep ONLINE briefly after deploy (Map empty) if check-in was recent
      const lastCheckInMs = s.lastCheckIn ? Date.parse(s.lastCheckIn) : 0;
      const freshCheckIn = lastCheckInMs && (now - lastCheckInMs) < SHIPPER_STALE_ONLINE_MS;
      if (!lastSeen && freshCheckIn) continue;
      if (!lastSeen || (now - lastSeen) > SHIPPER_STALE_ONLINE_MS) {
        shippers[i].status = 'OFFLINE';
        shippers[i].lastCheckOut = new Date().toISOString();
        onlineShipperLocations.delete(phone);
        changed = true;
      }
    }
    if (changed) writeShippersDatabase(shippers);
  } catch (e) {
    console.warn('[Shift TTL]', e.message);
  }
}

const MAX_ACTIVE_ORDERS_PER_SHIPPER = 2; // tối thiểu 1, tối đa 2 đơn đang chạy
const BATCH_NEAR_RESTAURANT1_KM = 2;
const BATCH_NEAR_CUSTOMER1_KM = 2;
const BATCH_DELIVERY_CLUSTER_KM = 2;
const OFFER_TTL_MS = 30000;

function getShipperActiveOrders(phone, orders = null) {
  const cleaned = cleanPhone(phone);
  const list = orders || readOrdersDatabase();
  return list.filter(o =>
    cleanPhone(o.shipperPhone) === cleaned &&
    (o.status === 'ACCEPTED' || o.status === 'PURCHASED')
  );
}

function getShipperActiveOrderCount(phone, orders = null) {
  return getShipperActiveOrders(phone, orders).length;
}

function isShipperBusy(shipperPhone, excludeOrderId = null) {
  const cleaned = cleanPhone(shipperPhone);
  if (!cleaned) return false;
  const orders = readOrdersDatabase();
  const active = orders.filter(o =>
    (o.status === 'ACCEPTED' || o.status === 'PURCHASED') &&
    cleanPhone(o.shipperPhone) === cleaned &&
    (!excludeOrderId || o.id !== excludeOrderId)
  );
  return active.length >= MAX_ACTIVE_ORDERS_PER_SHIPPER;
}

function assignOfferToShipper(order, shipper) {
  if (!order || !shipper) return order;
  order.assignedShipperPhone = cleanPhone(shipper.phone);
  order.offerExpiresAt = Date.now() + OFFER_TTL_MS;
  return order;
}

function clearOrderOffer(order) {
  if (!order) return order;
  order.assignedShipperPhone = null;
  order.offerExpiresAt = null;
  return order;
}

function scoreBatchCandidate(existingOrder, candidateOrder, shipperDistToNewRestaurant) {
  const result = {
    batchCompatible: false,
    score: shipperDistToNewRestaurant + 8,
    reason: 'INCOMPAT',
    rest2ToRest1: Infinity,
    rest2ToCust1: Infinity,
    deliv2ToCust1: Infinity
  };
  if (!existingOrder || !candidateOrder) return result;

  const rest2ToRest1 = calcDistance(
    existingOrder.restaurantLat, existingOrder.restaurantLon,
    candidateOrder.restaurantLat, candidateOrder.restaurantLon
  );
  const rest2ToCust1 = calcDistance(
    existingOrder.pinnedLat, existingOrder.pinnedLon,
    candidateOrder.restaurantLat, candidateOrder.restaurantLon
  );
  const deliv2ToCust1 = calcDistance(
    existingOrder.pinnedLat, existingOrder.pinnedLon,
    candidateOrder.pinnedLat, candidateOrder.pinnedLon
  );
  result.rest2ToRest1 = rest2ToRest1;
  result.rest2ToCust1 = rest2ToCust1;
  result.deliv2ToCust1 = deliv2ToCust1;

  if (existingOrder.status === 'PURCHASED') {
    const nearCust1Pickup = rest2ToCust1 <= BATCH_NEAR_CUSTOMER1_KM;
    const nearCust1Dropoff = deliv2ToCust1 <= BATCH_DELIVERY_CLUSTER_KM;
    if (nearCust1Pickup || nearCust1Dropoff) {
      result.batchCompatible = true;
      const anchorDist = Math.min(
        Number.isFinite(rest2ToCust1) ? rest2ToCust1 : Infinity,
        Number.isFinite(deliv2ToCust1) ? deliv2ToCust1 : Infinity
      );
      result.score = anchorDist * 0.22 + shipperDistToNewRestaurant * 0.12;
      if (nearCust1Pickup && nearCust1Dropoff) {
        result.score *= 0.75;
        result.reason = 'NEAR_CUSTOMER1_BOTH';
      } else if (nearCust1Pickup) {
        result.reason = 'NEAR_CUSTOMER1_PICKUP';
      } else {
        result.reason = 'NEAR_CUSTOMER1_DROPOFF';
      }
    } else {
      result.score = shipperDistToNewRestaurant + 10;
      result.reason = 'FAR_FROM_CUSTOMER1';
    }
    return result;
  }

  const nearRest1 = rest2ToRest1 <= BATCH_NEAR_RESTAURANT1_KM;
  const nearCust1Dropoff = deliv2ToCust1 <= BATCH_DELIVERY_CLUSTER_KM;
  const nearCust1Pickup = rest2ToCust1 <= BATCH_NEAR_CUSTOMER1_KM;
  if (nearRest1) {
    result.batchCompatible = true;
    result.score = rest2ToRest1 * 0.4 + shipperDistToNewRestaurant * 0.3;
    if (nearCust1Dropoff) {
      result.score *= 0.7;
      result.reason = 'NEAR_REST1_AND_CUST1';
    } else {
      result.reason = 'NEAR_REST1';
    }
  } else if (nearCust1Pickup || nearCust1Dropoff) {
    result.batchCompatible = true;
    const anchorDist = Math.min(
      Number.isFinite(rest2ToCust1) ? rest2ToCust1 : Infinity,
      Number.isFinite(deliv2ToCust1) ? deliv2ToCust1 : Infinity
    );
    result.score = anchorDist * 0.4 + shipperDistToNewRestaurant * 0.3;
    result.reason = nearCust1Pickup ? 'NEAR_CUST1_PICKUP_EARLY' : 'NEAR_CUST1_DROPOFF_EARLY';
  } else {
    result.score = shipperDistToNewRestaurant + 8;
    result.reason = 'INCOMPAT_BEFORE_PICKUP';
  }
  return result;
}

const ORDER_STATUS_TRANSITIONS = {
  PENDING: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['PURCHASED', 'CANCELLED'],
  PURCHASED: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: []
};

function canTransitionOrderStatus(from, to) {
  const allowed = ORDER_STATUS_TRANSITIONS[from] || [];
  return allowed.includes(to);
}

async function processExpiredOffers() {
  const now = Date.now();
  const orders = readOrdersDatabase();
  const expiredOrders = orders.filter(o =>
    o.status === 'PENDING' &&
    o.assignedShipperPhone &&
    o.offerExpiresAt &&
    now > o.offerExpiresAt
  );
  const unassignedPending = orders.filter(o => o.status === 'PENDING' && !o.assignedShipperPhone);
  if (expiredOrders.length === 0 && unassignedPending.length === 0) return;

  await updateOrdersDatabase((dbOrders) => {
    let changed = false;
    for (const exp of expiredOrders) {
      const idx = dbOrders.findIndex(o => o.id === exp.id);
      if (idx === -1) continue;
      if (dbOrders[idx].status !== 'PENDING' || !dbOrders[idx].assignedShipperPhone) continue;
      if (!(dbOrders[idx].offerExpiresAt && now > dbOrders[idx].offerExpiresAt)) continue;

      console.log(`[Dispatch] ⏰ Đề xuất đơn ${dbOrders[idx].id} cho tài xế ${dbOrders[idx].assignedShipperPhone} đã hết hạn.`);
      dbOrders[idx].declinedShippers = dbOrders[idx].declinedShippers || [];
      const oldPhone = cleanPhone(dbOrders[idx].assignedShipperPhone);
      if (oldPhone && !dbOrders[idx].declinedShippers.includes(oldPhone)) {
        dbOrders[idx].declinedShippers.push(oldPhone);
      }

      const nextNearest = findNearestAvailableShipper(
        dbOrders[idx].restaurantLat,
        dbOrders[idx].restaurantLon,
        dbOrders[idx].declinedShippers,
        dbOrders[idx]
      );
      if (nextNearest) {
        assignOfferToShipper(dbOrders[idx], nextNearest);
        console.log(`[Dispatch] 🎯 Đơn ${dbOrders[idx].id} chuyển tiếp đề xuất cho ${nextNearest.name} (${nextNearest.phone})`);
      } else {
        clearOrderOffer(dbOrders[idx]);
        console.log(`[Dispatch] ⏳ Đơn ${dbOrders[idx].id} chưa có tài xế phù hợp — giữ chờ đề xuất (ẩn bể chung)`);
      }
      changed = true;
    }

    for (const pending of unassignedPending) {
      const idx = dbOrders.findIndex(o => o.id === pending.id);
      if (idx === -1 || dbOrders[idx].status !== 'PENDING' || dbOrders[idx].assignedShipperPhone) continue;
      const nextNearest = findNearestAvailableShipper(
        dbOrders[idx].restaurantLat,
        dbOrders[idx].restaurantLon,
        dbOrders[idx].declinedShippers || [],
        dbOrders[idx]
      );
      if (!nextNearest) continue;
      if (nextNearest.isAssisted === true) {
        dbOrders[idx].status = 'ACCEPTED';
        dbOrders[idx].acceptedAt = Date.now();
        dbOrders[idx].shipperPhone = cleanPhone(nextNearest.phone);
        dbOrders[idx].shipperName = nextNearest.name;
        clearOrderOffer(dbOrders[idx]);
        console.log(`[SOS Redispatch] ⚡ Đơn ${dbOrders[idx].id} auto-accept cho SOS ${nextNearest.name}`);
      } else {
        assignOfferToShipper(dbOrders[idx], nextNearest);
        console.log(`[Dispatch] 🔁 Đơn chờ ${dbOrders[idx].id} được đề xuất cho ${nextNearest.name} (${nextNearest.phone})`);
      }
      changed = true;
    }
    return changed;
  });
}

function orderToSupabaseRow(order) {
  return {
    id: order.id,
    restaurant_id: order.restaurantId || null,
    restaurant_name: order.restaurantName || '',
    restaurant_address: order.restaurantAddress || '',
    status: order.status,
    app_total: order.appTotal || 0,
    store_total: order.storeTotal || 0,
    shipper_earning: order.shipperEarning || 0,
    shipper_id: order.shipperId || null,
    shipper_name: order.shipperName || null,
    shipper_phone: order.shipperPhone || null,
    delivery_name: order.deliveryName || '',
    delivery_phone: order.deliveryPhone || '',
    delivery_address: order.deliveryAddress || '',
    orderer_phone: order.ordererPhone || '',
    items: order.items || [],
    created_at: order.createdAt ? new Date(order.createdAt).toISOString() : new Date().toISOString(),
    accepted_at: order.acceptedAt ? new Date(order.acceptedAt).toISOString() : null,
    purchased_at: order.purchasedAt ? new Date(order.purchasedAt).toISOString() : null,
    delivered_at: order.deliveredAt ? new Date(order.deliveredAt).toISOString() : null,
    cancelled_at: order.cancelledAt ? new Date(order.cancelledAt).toISOString() : null,
    cancel_reason: order.cancelReason || null
  };
}

async function upsertOrderToSupabase(order) {
  if (!supabase || !order) return;
  try {
    await supabase.from('orders').upsert(orderToSupabaseRow(order), { onConflict: 'id' });
  } catch (err) {
    console.warn('[Supabase Sync] upsert order cảnh báo:', err.message);
  }
}

function pruneOldOrders(orders, maxAgeDays = 7) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  return orders.filter(o => {
    if (o.status !== 'DELIVERED' && o.status !== 'CANCELLED') return true;
    const ts = o.deliveredAt || o.cancelledAt || o.createdAt || 0;
    return ts >= cutoff;
  });
}

async function hydrateOrdersFromSupabaseIfEmpty() {
  if (!supabase) return;
  try {
    const local = readOrdersDatabase();
    if (Array.isArray(local) && local.length > 0) return;

    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .not('status', 'in', '("DELIVERED","CANCELLED")')
      .order('created_at', { ascending: false })
      .limit(200);

    if (error || !Array.isArray(data) || data.length === 0) return;

    const hydrated = data.map(row => ({
      id: row.id,
      restaurantId: row.restaurant_id,
      restaurantName: row.restaurant_name || '',
      restaurantAddress: row.restaurant_address || '',
      restaurantLat: row.restaurant_lat || null,
      restaurantLon: row.restaurant_lon || null,
      items: Array.isArray(row.items) ? row.items : [],
      storeTotal: row.store_total || 0,
      appTotal: row.app_total || 0,
      shipperEarning: row.shipper_earning || 0,
      status: row.status || 'PENDING',
      shipperId: row.shipper_id || null,
      shipperName: row.shipper_name || null,
      shipperPhone: row.shipper_phone || null,
      shipperLat: null,
      shipperLon: null,
      deliveryAddress: row.delivery_address || '',
      deliveryName: row.delivery_name || '',
      deliveryPhone: row.delivery_phone || '',
      ordererPhone: row.orderer_phone || '',
      createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
      acceptedAt: row.accepted_at ? new Date(row.accepted_at).getTime() : null,
      purchasedAt: row.purchased_at ? new Date(row.purchased_at).getTime() : null,
      deliveredAt: row.delivered_at ? new Date(row.delivered_at).getTime() : null,
      cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).getTime() : null,
      cancelReason: row.cancel_reason || null,
      assignedShipperPhone: null,
      offerExpiresAt: null,
      declinedShippers: [],
      messages: []
    }));

    fs.writeFileSync(ORDERS_FILE_PATH, JSON.stringify(hydrated, null, 2), 'utf8');
    console.log(`[Hydrate] Đã khôi phục ${hydrated.length} đơn active từ Supabase vào orders-local.json`);
  } catch (e) {
    console.warn('[Hydrate] Không thể hydrate orders từ Supabase:', e.message);
  }
}

// Middleware: Authenticate Admin via Supabase JWT
const ADMIN_AUTH_CACHE_TTL_MS = 5 * 60 * 1000;
const adminAuthCache = new Map();

function getCachedAdminAuth(token) {
  const hit = adminAuthCache.get(token);
  if (!hit) return null;
  if (hit.exp <= Date.now()) {
    adminAuthCache.delete(token);
    return null;
  }
  return hit;
}

function setCachedAdminAuth(token, user, role) {
  if (adminAuthCache.size > 200) {
    const oldest = adminAuthCache.keys().next().value;
    adminAuthCache.delete(oldest);
  }
  adminAuthCache.set(token, { user, role, exp: Date.now() + ADMIN_AUTH_CACHE_TTL_MS });
}

async function authenticateAdmin(req, res, next) {
  try {
    if (!supabase) {
      return res.status(503).json({ success: false, error: 'Hệ thống đang hoạt động ở chế độ Supabase trực tuyến nhưng chưa cấu hình thông số kết nối hoặc cấu hình bị lỗi!' });
    }
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Thiếu hoặc sai token xác thực Bearer!' });
    }
    const token = authHeader.split(' ')[1];
    const cached = getCachedAdminAuth(token);
    if (cached) {
      req.adminRole = cached.role;
      req.user = cached.user;
      return next();
    }
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ success: false, error: 'Token không hợp lệ hoặc đã hết hạn!' });
    }
    const role = crm.resolveAdminRole(user);
    if (!role) {
      return res.status(403).json({ success: false, error: 'Bạn không có quyền truy cập quản trị!' });
    }
    setCachedAdminAuth(token, user, role);
    req.adminRole = role;
    req.user = user;
    next();
  } catch (e) {
    res.status(500).json({ success: false, error: 'Lỗi xác thực Admin: ' + e.message });
  }
}

// ── PRICING CONFIG (Admin-adjustable) ────────────────────────────────────────
const PRICING_CONFIG_FILE = path.join(__dirname, 'pricing-config.json');

let pricingConfig = {
  markupRate: 0.28,           // 28% markup trên giá gốc
  secondOrderDiscountRate: 0.10, // 10% giảm giá cho đơn hàng thứ 2+
  freeDistanceKm: 1.5,        // Miễn phụ thu dưới 1.5km
  surchargeCoefficient: 7000, // Hệ số đường cong sqrt
  minShipperEarning: 15000,   // Sàn thu nhập shipper/đơn (đ)
  multiItemDiscount: 0.15     // 15% giảm surcharge cho món 2+
};

function loadPricingConfig() {
  try {
    if (fs.existsSync(PRICING_CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(PRICING_CONFIG_FILE, 'utf8'));
      pricingConfig = { ...pricingConfig, ...data };
      console.log('[Pricing Config] Đã tải cấu hình pricing động:', pricingConfig);
    } else {
      fs.writeFileSync(PRICING_CONFIG_FILE, JSON.stringify(pricingConfig, null, 2), 'utf8');
      console.log('[Pricing Config] Đã khởi tạo file cấu hình mặc định.');
    }
  } catch (err) {
    console.error('[Pricing Config] Lỗi đọc cấu hình pricing:', err.message);
  }
}

loadPricingConfig();

// Đảm bảo tương thích ngược hoàn toàn với code cũ sử dụng PRICING_CONFIG
const PRICING_CONFIG = {
  get MARKUP_RATE() { return pricingConfig.markupRate; },
  get FREE_DISTANCE_KM() { return pricingConfig.freeDistanceKm; },
  get SURCHARGE_COEFFICIENT() { return pricingConfig.surchargeCoefficient; },
  get MIN_SHIPPER_EARNING() { return pricingConfig.minShipperEarning; },
  get MULTI_ITEM_DISCOUNT() { return pricingConfig.multiItemDiscount; }
};

// Helper: Làm tròn đến 100đ
function round100(value) {
  return Math.round(value / 100) * 100;
}

// Helper: Tính giá app từ giá gốc (markup 28%)
function calcAppPrice(inStorePrice) {
  return round100(inStorePrice * (1 + PRICING_CONFIG.MARKUP_RATE));
}

// ── ONLINE SHIPPERS REAL-TIME COORDINATES & DISPATCH LOGIC ──────────────────
const onlineShipperLocations = new Map(); // phone -> { lat, lon, lastSeen }

const ADMIN_SLA_PENDING_MS = 5 * 60 * 1000;
const ADMIN_SLA_ACCEPTED_MS = 25 * 60 * 1000;
const ADMIN_SLA_PURCHASED_MS = 35 * 60 * 1000;

function filterAdminOrders(orders, { status, q, from, to } = {}) {
  let list = Array.isArray(orders) ? [...orders] : [];
  if (status && status !== 'all') {
    list = list.filter(o => o.status === status);
  }
  if (from) {
    const fromTs = new Date(from).getTime();
    if (!isNaN(fromTs)) list = list.filter(o => (o.createdAt || 0) >= fromTs);
  }
  if (to) {
    const toEnd = new Date(to);
    if (!isNaN(toEnd.getTime())) {
      toEnd.setHours(23, 59, 59, 999);
      list = list.filter(o => (o.createdAt || 0) <= toEnd.getTime());
    }
  }
  if (q) {
    const ql = String(q).toLowerCase();
    list = list.filter(o =>
      (o.id || '').toLowerCase().includes(ql) ||
      (o.restaurantName || '').toLowerCase().includes(ql) ||
      (o.deliveryName || '').toLowerCase().includes(ql) ||
      (o.deliveryPhone || '').includes(q) ||
      (o.shipperPhone || '').includes(q) ||
      (o.shipperName || '').toLowerCase().includes(ql)
    );
  }
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return list;
}

function getOrderSlaInfo(order) {
  if (!order || ['DELIVERED', 'CANCELLED'].includes(order.status)) return null;
  const now = Date.now();
  if (order.status === 'PENDING') {
    const age = now - (order.createdAt || now);
    if (age > ADMIN_SLA_PENDING_MS) {
      return { type: 'PENDING_SLOW', ageMs: age, thresholdMs: ADMIN_SLA_PENDING_MS };
    }
  }
  if (order.status === 'ACCEPTED') {
    const since = order.acceptedAt || order.createdAt || now;
    const age = now - since;
    if (age > ADMIN_SLA_ACCEPTED_MS) {
      return { type: 'ACCEPTED_SLOW', ageMs: age, thresholdMs: ADMIN_SLA_ACCEPTED_MS };
    }
  }
  if (order.status === 'PURCHASED') {
    const since = order.purchasedAt || order.acceptedAt || now;
    const age = now - since;
    if (age > ADMIN_SLA_PURCHASED_MS) {
      return { type: 'PURCHASED_SLOW', ageMs: age, thresholdMs: ADMIN_SLA_PURCHASED_MS };
    }
  }
  return null;
}

function escapeCsvCell(val) {
  const s = val == null ? '' : String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function calcDistance(lat1, lon1, lat2, lon2) {
  if (lat1 === null || lon1 === null || lat2 === null || lon2 === null) return Infinity;
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function findNearestAvailableShipper(restaurantLat, restaurantLon, declinedShippers = [], candidateOrder = null) {
  try {
    const shippers = readShippersDatabase();
    const orders = readOrdersDatabase();
    const onlineShippers = shippers.filter(s => s.status === 'ONLINE');
    if (onlineShippers.length === 0) return null;

    const cleanDeclined = (declinedShippers || []).map(cleanPhone);
    const now = Date.now();
    const orderHint = candidateOrder || {
      restaurantLat,
      restaurantLon,
      pinnedLat: null,
      pinnedLon: null
    };

    // 🆘 ƯU TIÊN 1: SOS (còn chỗ nhận thêm đơn)
    let assistanceShipper = null;
    let minAssistanceDist = Infinity;
    for (const s of onlineShippers) {
      const cleanedPhone = cleanPhone(s.phone);
      if (cleanDeclined.includes(cleanedPhone)) continue;
      if (getShipperActiveOrderCount(cleanedPhone, orders) >= MAX_ACTIVE_ORDERS_PER_SHIPPER) continue;
      if (s.assistanceRequested !== true) continue;
      const loc = onlineShipperLocations.get(cleanedPhone);
      const dist = (loc && now - loc.lastSeen <= 120000)
        ? calcDistance(restaurantLat, restaurantLon, loc.lat, loc.lon)
        : 0;
      if (dist < minAssistanceDist) {
        minAssistanceDist = dist;
        assistanceShipper = {
          phone: s.phone,
          name: s.name,
          distance: dist,
          isAssisted: true,
          activeLoad: getShipperActiveOrderCount(cleanedPhone, orders),
          batchCompatible: false
        };
      }
    }
    if (assistanceShipper) {
      console.log(`[Priority Dispatch] 🎯 SOS ${assistanceShipper.name} (${assistanceShipper.phone}), load=${assistanceShipper.activeLoad}`);
      return assistanceShipper;
    }

    // 🚴 ƯU TIÊN 2: rảnh / ghép đơn theo giai đoạn / gần quán
    let bestShipper = null;
    let bestScore = Infinity;
    for (const s of onlineShippers) {
      const cleanedPhone = cleanPhone(s.phone);
      if (cleanDeclined.includes(cleanedPhone)) continue;
      const activeOrders = getShipperActiveOrders(cleanedPhone, orders);
      if (activeOrders.length >= MAX_ACTIVE_ORDERS_PER_SHIPPER) continue;
      const loc = onlineShipperLocations.get(cleanedPhone);
      if (!loc || now - loc.lastSeen > 120000) continue;

      const distToRestaurant = calcDistance(restaurantLat, restaurantLon, loc.lat, loc.lon);
      let score = distToRestaurant;
      let batchCompatible = false;
      let batchReason = 'IDLE';
      if (activeOrders.length === 1) {
        const batch = scoreBatchCandidate(activeOrders[0], orderHint, distToRestaurant);
        score = batch.score;
        batchCompatible = batch.batchCompatible;
        batchReason = batch.reason;
        if (batchCompatible) {
          console.log(`[Batch Dispatch] 📦 ${s.name} status=${activeOrders[0].status} reason=${batch.reason} score=${score.toFixed(2)}`);
        }
      }
      if (score < bestScore) {
        bestScore = score;
        bestShipper = {
          phone: s.phone,
          name: s.name,
          distance: distToRestaurant,
          activeLoad: activeOrders.length,
          batchCompatible,
          batchReason,
          score
        };
      }
    }
    if (bestShipper) {
      const tag = bestShipper.batchCompatible
        ? `GHÉP ĐƠN:${bestShipper.batchReason}`
        : (bestShipper.activeLoad === 0 ? 'ĐƠN LẺ' : 'LOAD+1');
      console.log(`[Dispatch] 🎯 Chọn ${bestShipper.name} (${bestShipper.phone}) [${tag}] dist=${bestShipper.distance.toFixed(2)}km score=${bestScore.toFixed(2)}`);
    }
    return bestShipper;
  } catch (e) {
    console.error('[Dispatch Error] findNearestAvailableShipper:', e.message);
    return null;
  }
}

// ── CONCURRENCY LIMITER & REQUEST COLLAPSING ────────────────────────────────
class ConcurrencyLimiter {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
    this.activeCount = 0;
    this.queue = [];
  }

  async run(fn) {
    if (this.activeCount >= this.maxConcurrent) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.activeCount++;
    try {
      return await fn();
    } finally {
      this.activeCount--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        next();
      }
    }
  }
}

const scraperLimiter = new ConcurrencyLimiter(3); // Giới hạn tối đa 3 trình duyệt Puppeteer chạy đồng thời toàn hệ thống
const ACTIVE_SCRAPE_PROMISES = new Map(); // id -> Promise để gộp các request chi tiết trùng lặp (Request Collapsing)

const app  = express();
const PORT = 3001;

// ── PERFORMANCE MIDDLEWARE ───────────────────────────────────────────────────
// Gzip compression: giảm ~70% bandwidth cho tất cả JSON responses
app.use(compression({
  level: 6,          // Mức nén cân bằng tốc độ vs kích thước (1-9)
  threshold: 1024,   // Chỉ nén response > 1KB
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// CORS: cho phép localhost và các tên miền Vercel gọi API
const whitelist = [
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'https://shipfee.vercel.app',
  'https://shipfee-hieuhuynh234s-projects.vercel.app'
];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    const isVercel = origin.endsWith('.vercel.app');
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
    const isWhitelisted = whitelist.indexOf(origin) !== -1;
    if (isWhitelisted || isVercel || isLocal) {
      callback(null, true);
    } else {
      console.warn('[CORS] Blocked origin:', origin);
      callback(null, false);
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 200
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

function triggerCrawler() {
  // Crawler ngầm được quản lý tập trung bởi Sweep Worker trong tiến trình chính
  // và daemon crawl_scheduler.js bên ngoài để tối ưu hóa hiệu năng RAM trên Render.
}

function removeVietnameseTones(str) {
  if (!str) return '';
  str = str.replace(/à|á|ạ|ả|ã|â|ầ|ấ|ậ|ẩ|ẫ|ă|ằ|ắ|ặ|ẳ|ẵ/g, "a");
  str = str.replace(/è|é|ẹ|ẻ|ẽ|ê|ề|ế|ệ|ể|ễ/g, "e");
  str = str.replace(/ì|í|ị|ỉ|ĩ/g, "i");
  str = str.replace(/ò|ó|ọ|ỏ|õ|ô|ồ|ố|ộ|ổ|ỗ|ơ|ờ|ớ|ợ|ở|ỡ/g, "o");
  str = str.replace(/ù|ú|ụ|ủ|ũ|ư|ừ|ứ|ự|ử|ữ/g, "u");
  str = str.replace(/ỳ|ý|ỵ|ỷ|ỹ/g, "y");
  str = str.replace(/đ/g, "d");
  str = str.replace(/À|Á|Ạ|Ả|Ã|Â|Ầ|Ấ|Ậ|Ẩ|Ẫ|Ă|Ằ|Ắ|Ặ|Ẳ|Ẵ/g, "A");
  str = str.replace(/È|É|Ẹ|Ẻ|Ẽ|Ê|Ề|Ế|Ệ|Ể|Ễ/g, "E");
  str = str.replace(/Ì|Í|Ị|Ỉ|Ĩ/g, "I");
  str = str.replace(/Ò|Ó|Ọ|Ỏ|Õ|Ô|Ồ|Ố|Ộ|Ổ|Ỗ|Ơ|Ờ|Ớ|Ợ|Ở|Ỡ/g, "O");
  str = str.replace(/Ù|Ú|Ụ|Ủ|Ũ|Ư|Ừ|Ứ|Ự|Ử|Ữ/g, "U");
  str = str.replace(/Ỳ|Ý|Ỵ|Ỷ|Ỹ/g, "Y");
  str = str.replace(/Đ/g, "D");
  str = str.normalize('NFD').replace(/[\u0300-\u036f]/g, "");
  return str;
}

function normalizeText(str) {
  if (!str) return '';
  let res = str.toLowerCase();
  res = removeVietnameseTones(res);
  // Thay đổi y thành i để xử lý đồng âm
  res = res.replace(/y/g, 'i');
  // Thay thế ký tự đặc biệt thành khoảng trắng
  res = res.replace(/[^a-z0-9\s]/g, ' ');
  return res.trim().replace(/\s+/g, ' ');
}

function hasReopenTime(reason) {
  if (!reason) return false;
  const lower = reason.toLowerCase();
  
  const permanentKeywords = [
    'ngưng hoạt động',
    'không tồn tại',
    'địa điểm này chưa có',
    'bài viết không tồn tại',
    'chưa có dịch vụ',
    'tạm ngưng dịch vụ trực tuyến',
    'tạm ngưng hoạt động'
  ];
  if (permanentKeywords.some(kw => lower.includes(kw))) {
    return false;
  }

  const tempKeywords = [
    'ngày mai',
    'hôm sau',
    'giờ làm việc',
    'trở lại sau',
    'quay lại',
    'hẹn đơn',
    'mở cửa',
    'ngoài giờ',
    'khung giờ'
  ];
  
  const timePattern = /\d{1,2}[:h]\d{2}/;
  
  return tempKeywords.some(kw => lower.includes(kw)) || timePattern.test(lower);
}

function resetClosedIfNextAttemptReached(restaurant) {
  if (restaurant && restaurant.isClosed && restaurant.crawlNextAttempt) {
    if (new Date() >= new Date(restaurant.crawlNextAttempt)) {
      console.log(`[Database] 🔄 Resetting closed state for "${restaurant.name}" as crawlNextAttempt (${restaurant.crawlNextAttempt}) has been reached.`);
      restaurant.isClosed = false;
      delete restaurant.closedAt;
      delete restaurant.closedReason;
      delete restaurant.crawlNextAttempt;
      return true;
    }
  }
  return false;
}


// ── DYNAMIC MENU GENERATORS (Bản sao đồng bộ để chạy Search trực tiếp) ───────
const SEARCHED_RESTAURANTS_CACHE = new Map(); // id -> restaurant object

// Bản đồ dịch ngược Slug Hệ thống sang Slug chi nhánh ShopeeFood thực tế
const SLUG_REWRITER_MAP = {
  // Brand portals maps
  'he-thong-lumos-coffee-cake': 'lumos-bakery-joy-banh-au-tra',
  'he-thong-lau-bang-chuyen-kichi-kichi': 'kichi-kichi-lotte-mart-can-tho',
  'he-thong-quan-itada-am-thuc-han-quoc': 'itada-mi-cay-han-quoc-duong-3-thang-2',
  'jollibee-can-tho': 'ga-ran-va-mi-y-jollibee-duong-30-thang-4',
  'highlands-coffee-can-tho': 'highlands-coffee-go-can-tho',
  'kfc-can-tho': 'ga-ran-kfc-lotte-mart-can-tho',
  'lotteria-can-tho': 'ga-ran-burger-lotteria-can-tho-nguyen-van-cu',

  // Jollibee branch legacy slug maps
  'jollibee-duong-30-thang-4': 'ga-ran-va-mi-y-jollibee-duong-30-thang-4',
  'jollibee-cach-mang-thang-8': 'ga-ran-va-mi-y-jollibee-cach-mang-thang-8',
  'jollibee-ec-tran-hung-dao-can-tho': 'ga-ran-va-mi-y-jollibee-ec-tran-hung-dao-can-tho',
  'jollibee-ec-ba-thang-hai-can-tho': 'ga-ran-va-mi-y-jollibee-ec-ba-thang-hai-can-tho',
  'jollibee-nguyen-van-cu': 'ga-ran-va-mi-y-jollibee-nguyen-van-cu',
  'jollibee-ec-nguyen-van-cu-noi-dai-can-tho': 'ga-ran-va-my-y-jollibee-ec-nguyen-van-cu-noi-dai-can-tho',
  'jollibee-ec-sts-tower-hoa-binh': 'ga-ran-va-my-y-jollibee-ec-sts-tower-hoa-binh',

  // Highlands Coffee branch legacy slug maps
  'highlands-coffee-vincom-can-tho': 'highlands-coffee-tra-ca-phe-banh-vincom-can-tho',
  'highlands-coffee-go': 'highlands-coffee-go-can-tho',
  'highlands-coffee-nguyen-van-cu-can-tho': 'highlands-coffee-tra-ca-phe-banh-nguyen-van-cu-can-tho',
  'highlands-coffee-cv-song-hau-can-tho': 'highlands-coffee-tra-ca-phe-banh-cv-song-hau-can-tho',
  'highlands-coffee-huynh-cuong-can-tho': 'highlands-coffee-tra-ca-phe-banh-huynh-cuong-can-tho',
  'highlands-coffee-tra-ca-phe-banh-vincom-can-tho': 'highlands-coffee-tra-ca-phe-banh-vincom-can-tho',
  'highlands-coffee-tra-ca-phe-banh-lotte-mart-can-tho': 'highlands-coffee-tra-ca-phe-banh-lotte-mart-can-tho',
  'highlands-coffee-tra-ca-phe-banh-sense-city-can-tho': 'highlands-coffee-tra-ca-phe-banh-sense-city-can-tho',
  'highlands-coffee-tra-ca-phe-banh-vincom-xuan-khanh': 'highlands-coffee-tra-ca-phe-banh-vincom-xuan-khanh',
  'highlands-coffee-tra-ca-phe-banh-1-3-2-can-tho': 'highlands-coffee-tra-ca-phe-banh-1-3-2-can-tho',
  'highlands-coffee-tra-ca-phe-banh-nguyen-van-cu-can-tho': 'highlands-coffee-tra-ca-phe-banh-nguyen-van-cu-can-tho',
  'highlands-coffee-tra-ca-phe-banh-ttc-hotel-can-tho': 'highlands-coffee-tra-ca-phe-banh-ttc-hotel-can-tho',
  'highlands-coffee-tra-ca-phe-banh-cv-song-hau-can-tho': 'highlands-coffee-tra-ca-phe-banh-cv-song-hau-can-tho',
  'highlands-coffee-tra-ca-phe-banh-tran-van-kheo-can-tho': 'highlands-coffee-tra-ca-phe-banh-tran-van-kheo-can-tho',
  'highlands-coffee-tra-ca-phe-banh-huynh-cuong-can-tho': 'highlands-coffee-tra-ca-phe-banh-huynh-cuong-can-tho',
  'highlands-coffee-tra-ca-phe-banh-91-3-2-can-tho': 'highlands-coffee-tra-ca-phe-banh-91-3-2-can-tho',
  'highlands-coffee-tra-ca-phe-banh-bv-hoan-my-cuu-long': 'highlands-coffee-tra-ca-phe-banh-bv-hoan-my-cuu-long',

  // KFC branch legacy slug maps
  'kfc-big-c-hung-phu': 'ga-ran-kfc-big-c-hung-phu-can-tho',
  'kfc-tran-hoang-na': 'ga-ran-kfc-duong-tran-hoang-na-can-tho',
  'kfc-lotte-mart-can-tho': 'ga-ran-kfc-lotte-mart-can-tho',
  'ga-ran-kfc-vinmart-vinatex-can-tho': 'ga-ran-kfc-vinmart-vinatex-can-tho',
  'ga-ran-kfc-big-c-hung-phu-can-tho': 'ga-ran-kfc-big-c-hung-phu-can-tho',
  'ga-ran-kfc-lotte-mart-can-tho': 'ga-ran-kfc-lotte-mart-can-tho',
  'ga-ran-kfc-duong-tran-hoang-na-can-tho': 'ga-ran-kfc-duong-tran-hoang-na-can-tho',
  'ga-ran-kfc-kfc-ba-thang-hai': 'ga-ran-kfc-kfc-ba-thang-hai',

  // Lotteria branch legacy slug maps
  'lotteria-can-tho-big-c': 'ga-ran-burger-lotteria-can-tho-big-c',
  'lotteria-can-tho-nguyen-van-cu': 'ga-ran-burger-lotteria-can-tho-nguyen-van-cu',
  'lotteria-can-tho-lotte-mart': 'lotteria-can-tho-lottemart',
  'ga-ran-burger-lotteria-can-tho-big-c': 'ga-ran-burger-lotteria-can-tho-big-c',
  'ga-ran-burger-lotteria-cach-mang-thang-8': 'ga-ran-burger-lotteria-cach-mang-thang-8',
  'ga-ran-burger-lotteria-can-tho-nguyen-van-cu': 'ga-ran-burger-lotteria-can-tho-nguyen-van-cu',
  'lotteria-can-tho-lottemart': 'lotteria-can-tho-lottemart',
  'lotteria-vincom-xuan-khanh': 'lotteria-vincom-xuan-khanh',

  // Jollibee additional branch slug maps
  'ga-ran-va-mi-y-jollibee-ec-o-mon-can-tho': 'ga-ran-va-mi-y-jollibee-ec-o-mon-can-tho',
  'jollibee-coopmart-thot-not': 'jollibee-coopmart-thot-not',
  'jollibee-ec-vincom-can-tho': 'ga-ran-va-mi-y-jollibee-ec-vincom-can-tho',

  // Generic fallback: map COCO-specific old IDs
  'he-thong-coko': 'coko-tra-ca-phe-nguyen-van-cu',
  'he-thong-two-ti': 'two-ti-tra-sua-bap-xao-nguyen-van-cu'
};

const MENU_TEMPLATES = {
  com_tam: [
    { name: 'Cơm Tấm Sườn Nướng Lu', desc: 'Sườn heo cốt lết dày được tẩm mật ong nướng lu thơm lừng, thịt mềm mọng nước.', inStorePrice: 40000, img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80', category: 'Cơm Tấm' },
    { name: 'Cơm Tấm Sườn Bì Chả Đặc Biệt', desc: 'Đầy đủ sườn nướng mật ong, bì thính vàng thơm, chả trứng hấp béo ngậy.', inStorePrice: 48000, img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80', category: 'Cơm Tấm' },
    { name: 'Cơm Tấm Ba Chỉ Heo Quay Giòn Bì', desc: 'Ba chỉ quay lu da siêu giòn rụm chấm nước mắm tỏi ớt kẹo.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=400&q=80', category: 'Cơm Tấm' },
    { name: 'Cơm Tấm Đùi Gà Xối Mỡ', desc: 'Đùi gà xối mỡ giòn rụm ăn kèm cơm tấm thơm béo mỡ hành.', inStorePrice: 42000, img: 'https://images.unsplash.com/photo-1598515213692-80e7c7e4c47c?w=400&q=80', category: 'Cơm Tấm' },
    { name: 'Canh Khổ Qua Nhồi Thịt Heo', desc: 'Khổ qua nhồi nhân thịt băm mộc nhĩ ngọt thanh giải nhiệt.', inStorePrice: 15000, img: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=80', category: 'Canh & Ăn Kèm' }
  ],
  com_ga: [
    { name: 'Cơm Gà Xối Mỡ Da Giòn (Đùi)', desc: 'Cơm chiên hạt vàng dẻo ăn kèm đùi gà góc tư xối mỡ nóng da giòn rụm.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1598515213692-80e7c7e4c47c?w=400&q=80', category: 'Cơm Gà' },
    { name: 'Cơm Gà Hải Nam Luộc', desc: 'Thịt gà ta luộc da vàng óng chắc thịt chấm mắm gừng sả.', inStorePrice: 40000, img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80', category: 'Cơm Gà' },
    { name: 'Cơm Gà Quay Chảo Sốt Mật Ong', desc: 'Đùi gà quay chảo tẩm sốt mật ong đậm đà thơm ngậy.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1598515213692-80e7c7e4c47c?w=400&q=80', category: 'Cơm Gà' },
    { name: 'Cơm Gà Xé Phay Hành Tây', desc: 'Lườn gà xé phay bóp gỏi rau răm hành tây tắc chua ngọt.', inStorePrice: 38000, img: 'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=400&q=80', category: 'Cơm Gà' },
    { name: 'Canh Gà Lá Giang Lá Chanh', desc: 'Nước dùng chua thanh thơm mùi lá giang và thịt băm ngọt nước.', inStorePrice: 15000, img: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=80', category: 'Món Ăn Kèm' }
  ],
  com_general: [
    { name: 'Cơm Chiên Dương Châu Đặc Biệt', desc: 'Cơm chiên tơi hạt thơm bùi lạp xưởng, đậu cô ve, cá rốt và trứng.', inStorePrice: 40000, img: 'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=400&q=80', category: 'Cơm Đĩa' },
    { name: 'Cơm Sườn Rim Chua Ngọt Vị Quê', desc: 'Sườn heo rim chua ngọt mặn mà đưa cơm cực kỳ.', inStorePrice: 42000, img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80', category: 'Cơm Đĩa' },
    { name: 'Cơm Thịt Kho Tàu Trứng Cút', desc: 'Thịt ba chỉ heo kho mềm nhừ với nước dừa xiêm thơm béo ngọt ngào.', inStorePrice: 40000, img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80', category: 'Cơm Đĩa' },
    { name: 'Cơm Bò Xào Bông Cải Xanh', desc: 'Bò phi lê mềm xào bông cải ngọt giòn mướt.', inStorePrice: 48000, img: 'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=400&q=80', category: 'Cơm Đĩa' },
    { name: 'Canh Chua Cá Lóc Nam Bộ', desc: 'Nước canh chua cay đậm vị me, thơm, dọc mùng cá lóc tươi.', inStorePrice: 20000, img: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=80', category: 'Canh Thêm' }
  ],
  bun_bo: [
    { name: 'Bún Bò Huế Đặc Biệt Giò Chả', desc: 'Sợi bún to chuẩn Huế, nước dùng ninh xương bò thơm nồng mùi ruốc sả, giò khoanh mềm ngon kèm chả cua béo ngậy.', inStorePrice: 50000, img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80', category: 'Bún Bò' },
    { name: 'Bún Bò Tái Nạm Gầu Bò', desc: 'Thịt bò tái mềm kết hợp nạm gầu giòn béo thơm phức.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43?w=400&q=80', category: 'Bún Bò' },
    { name: 'Bún Bò Huế Thường (Thịt + Chả)', desc: 'Thịt bò chín lát mỏng kèm chả Huế giòn dai.', inStorePrice: 40000, img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80', category: 'Bún Bò' },
    { name: 'Đĩa Chả Cua / Chả Huế Thêm', desc: 'Topping nhúng thêm tăng phần ngon miệng béo ngậy.', inStorePrice: 15000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Topping' },
    { name: 'Bánh Quẩy Chiên Giòn (2 cái)', desc: 'Chiên vàng giòn rụm chấm nước bún bò ăn cực hợp vị.', inStorePrice: 8000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Ăn Kèm' }
  ],
  hu_tieu_muc: [
    { name: 'Hủ Tiếu Mực Ống Tươi Sườn Heo', desc: 'Nước dùng trong thơm mực nướng hành phi, mực ống tươi giòn sần sật kèm sườn non hầm.', inStorePrice: 48000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Hủ Tiếu Mực' },
    { name: 'Hủ Tiếu Mực Tôm Trứng Cút', desc: 'Mực ống giòn ngọt kết hợp tôm sú đỏ au trứng cút nhỏ bùi béo.', inStorePrice: 50000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Hủ Tiếu Mực' },
    { name: 'Hủ Tiếu Mực Trộn Khô Sốt Đặc Biệt', desc: 'Hủ tiếu dai trộn sốt đặc trưng, mực tôm sườn để bát riêng nước dùng ngọt lịm.', inStorePrice: 52000, img: 'https://images.unsplash.com/photo-1552611052-33e04de081de?w=400&q=80', category: 'Hủ Tiếu Mực' },
    { name: 'Đĩa Mực Ống Tươi Nhúng Thêm', desc: 'Thêm đĩa mực ống làm sạch trụng chín giòn ngọt.', inStorePrice: 25000, img: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=80', category: 'Topping' },
    { name: 'Nước Sâm Dứa Lá Nếp Mát Lạnh', desc: 'Nước giải khát mát ngọt thanh hương lá dứa nếp phảng phất.', inStorePrice: 10000, img: 'https://images.unsplash.com/photo-1621263764928-df1444c5e859?w=400&q=80', category: 'Giải Khát' }
  ],
  hu_tieu: [
    { name: 'Hủ Tiếu Nam Vang Sườn Tôm Thịt Bằm', desc: 'Hủ tiếu Nam Vang nước xương hầm sườn non, tôm sú tươi, gan tim heo bùi ngậy và thịt bằm nhuyễn.', inStorePrice: 42000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Hủ Tiếu' },
    { name: 'Hủ Tiếu Nam Vang Khô Trộn Sốt', desc: 'Hủ tiếu trộn sốt dầu hào tỏi phi thơm đậm vị, kèm bát nước lèo sườn tôm thơm ngọt.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1552611052-33e04de081de?w=400&q=80', category: 'Hủ Tiếu' },
    { name: 'Hủ Tiếu Hoành Thánh Xá Xíu', desc: 'Thịt xá xíu thái lát mềm ngọt, hoành thánh nhân tôm thịt vỏ mỏng chín mướt.', inStorePrice: 40000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Hủ Tiếu Mì' },
    { name: 'Xương Ống Hầm Mềm Thêm', desc: 'Bát xương ống tủy ngọt ngào nhúng hành trần béo bùi ngon tuyệt.', inStorePrice: 20000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Topping' },
    { name: 'Bánh Quẩy Chiên Giòn (2 cái)', desc: 'Ăn kèm nước hủ tiếu chấm mắm ớt cay ngon tuyệt hảo.', inStorePrice: 8000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Ăn Kèm' }
  ],
  pho: [
    { name: 'Phở Bò Đặc Biệt (Tái, Nạm, Gầu, Gân)', desc: 'Phở truyền thống nước dùng hầm xương 12 tiếng thơm quế hồi, đầy đủ tái nạm gầu gân.', inStorePrice: 50000, img: 'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43?w=400&q=80', category: 'Phở Bò' },
    { name: 'Phở Bò Tái Bắp Hoa Tươi', desc: 'Thịt bò bắp hoa giòn ngọt thái mỏng trụng chín vừa thơm lừng.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43?w=400&q=80', category: 'Phở Bò' },
    { name: 'Phở Gà Ta Xé Đùi Trứng Non', desc: 'Nước dùng gà ngọt thanh, thịt đùi gà ta xé giòn dai kèm trứng non béo ngậy.', inStorePrice: 48000, img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80', category: 'Phở Gà' },
    { name: 'Đĩa Thịt Bò Tái Thêm', desc: 'Thêm đĩa bò tái phi lê ngọt lịm nhúng lèo.', inStorePrice: 20000, img: 'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43?w=400&q=80', category: 'Topping' },
    { name: 'Quẩy Giòn Chấm Phở (2 cái)', desc: 'Quẩy dài vàng ruộm chiên giòn tan.', inStorePrice: 8000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Ăn Kèm' }
  ],
  bun_rieu: [
    { name: 'Bún Riêu Cua Giò Heo Ốc Đặc Biệt', desc: 'Nước riêu chua thanh dịu dấm bỗng thơm nồng, riêu cua béo múp, giò heo hầm mềm dẻo, ốc giòn sần sật.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80', category: 'Bún Riêu' },
    { name: 'Bún Riêu Bắp Bò Chả Huế', desc: 'Thịt bò bắp thái mỏng trần tái giòn kết hợp chả Huế thơm nồng sa tế.', inStorePrice: 42000, img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80', category: 'Bún Riêu' },
    { name: 'Bún Riêu Ốc Đậu Hũ Chiên Giòn', desc: 'Ốc nhồi dai giòn sần sật kết hợp đậu hũ chiên phồng thấm đẫm nước riêu.', inStorePrice: 38000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Bún Riêu' },
    { name: 'Khoanh Giò Heo Hầm Mềm Thêm', desc: 'Giò heo khoanh tròn nạc mỡ đan xen hầm nhừ dẻo thơm.', inStorePrice: 15000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Topping' },
    { name: 'Trà Đá Nhài Thanh Mát', desc: 'Nước trà xanh hương nhài đá giải khát cực mát mẻ.', inStorePrice: 5000, img: 'https://images.unsplash.com/photo-1621263764928-df1444c5e859?w=400&q=80', category: 'Giải Khát' }
  ],
  banh_mi: [
    { name: 'Bánh Mì Heo Quay Giòn Bì Đặc Biệt', desc: 'Vỏ bánh mì nướng nóng giòn tan, nhân ba chỉ heo quay lu da giòn sần sật sốt ớt kẹo đặc trưng.', inStorePrice: 25000, img: 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?w=400&q=80', category: 'Bánh Mì' },
    { name: 'Bánh Mì Xá Xíu Pâté Bơ Tươi', desc: 'Thịt xá xíu thái mỏng ngọt đậm đà, pâté gan béo ngậy quết bơ béo bùi hành dưa.', inStorePrice: 22000, img: 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?w=400&q=80', category: 'Bánh Mì' },
    { name: 'Bánh Mì Chả Lụa Thịt Nguội Pâté', desc: 'Bánh mì kẹp chả lụa thủ công dăm bông heo ngọt vị quết đầy đặn bơ sốt.', inStorePrice: 20000, img: 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?w=400&q=80', category: 'Bánh Mì' },
    { name: 'Bánh Mì Ốp La 2 Trứng Xúc Xích', desc: '2 trứng ốp la lòng đào chảy mềm kèm xúc xích heo chiên rạch múi.', inStorePrice: 18000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Bánh Mì' },
    { name: 'Sữa Đậu Nành Nguyên Chất Mát Lạnh', desc: 'Sữa đậu nành tự nấu ngọt béo thơm ngậy hạt đậu nành hữu cơ.', inStorePrice: 10000, img: 'https://images.unsplash.com/photo-1621263764928-df1444c5e859?w=400&q=80', category: 'Đồ Uống' }
  ],
  banh_canh: [
    { name: 'Bánh Canh Cua Bột Gạo Đặc Biệt', desc: 'Sợi bánh canh bột gạo nước sốt gạch cua sệt đỏ cam, thịt cua bể béo ngậy chả cá thác lác sần sật.', inStorePrice: 48000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Bánh Canh' },
    { name: 'Bánh Canh Giò Heo Sườn Non', desc: 'Sườn non heo chặt khúc ngọt thịt kèm khoanh giò heo hầm mềm giòn da.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Bánh Canh' },
    { name: 'Bánh Canh Tôm Thịt Chả Cá Thác Lác', desc: 'Tôm sú tươi đỏ au chả cá thác lác dai giòn sần sật vị ngọt thanh.', inStorePrice: 40000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Bánh Canh' },
    { name: 'Bánh Quẩy Chiên Giòn Thêm (2 cái)', desc: 'Quẩy giòn tan cắt khoanh chấm nước lèo bánh canh sền sệt.', inStorePrice: 8000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Ăn Kèm' },
    { name: 'Nước Sâm La Hán Quả Mát Lạnh', desc: 'Nước sâm la hán quả nấu thanh nhiệt giải độc ngày hè.', inStorePrice: 12000, img: 'https://images.unsplash.com/photo-1621263764928-df1444c5e859?w=400&q=80', category: 'Giải Khát' }
  ],
  ga_ran: [
    { name: 'Set 2 Miếng Gà Giòn Cay Rụm', desc: '2 miếng gà giòn rụm cay nhẹ đậm đà thấm vị tẩm bột chiên vàng.', inStorePrice: 69000, img: 'https://images.unsplash.com/photo-1606755962773-d324e0a13086?w=400&q=80', category: 'Gà Rán' },
    { name: 'Combo Gà Giòn + Khoai Tây + Pepsi', desc: '1 miếng gà giòn rụm kèm 1 đĩa khoai tây chiên muối thơm lừng lon Pepsi lạnh.', inStorePrice: 89000, img: 'https://images.unsplash.com/photo-1606755962773-d324e0a13086?w=400&q=80', category: 'Combo' },
    { name: 'Burger Gà Giòn Sốt Mayo', desc: 'Burger kẹp đùi gà chiên xù xà lách tươi béo bùi sốt mayo sữa.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400&q=80', category: 'Burger' },
    { name: 'Khoai Tây Chiên Lắc Bột Phô Mai', desc: 'Khoai tây cắt thanh chiên vàng giòn rụm lắc đẫm bột phô mai cam béo ngậy.', inStorePrice: 32000, img: 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=400&q=80', category: 'Món Phụ' },
    { name: 'Mỳ Ý Sốt Bò Bằm Bolognaise', desc: 'Sợi mỳ Ý dai mềm phủ sốt bò bằm cà chua thơm ngào ngạt bột phô mai.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=400&q=80', category: 'Món Phụ' }
  ],
  western: [
    { name: 'Pizza Thập Cẩm Phô Mai Mozzarella (M)', desc: 'Pizza đế mỏng lò đất giòn rụm, xúc xích pepperoni, giăm bông thịt heo, dứa, phô mai kéo sợi đặc trưng.', inStorePrice: 129000, img: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=400&q=80', category: 'Pizza' },
    { name: 'Pizza Hải Sản Sốt Pesto (Size M)', desc: 'Tôm sú mực tươi xào bơ tỏi sốt pesto xanh ngát ngập phô mai Mozzarella.', inStorePrice: 149000, img: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=400&q=80', category: 'Pizza' },
    { name: 'Mỳ Ý Sốt Bò Bằm Bolognaise', desc: 'Mì Ý truyền thống sốt cà chua thịt bò bằm phi thơm dầu oliu bột phô mai cam.', inStorePrice: 65000, img: 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=400&q=80', category: 'Mỳ Ý' },
    { name: 'Burger Bò Phô Mai Double Cheesy', desc: '2 lớp bò áp chảo thơm lừng kẹp phô mai Cheddar béo ngậy sốt BBQ khói.', inStorePrice: 60000, img: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400&q=80', category: 'Burger' },
    { name: 'Khoai Tây Bổ Múi Bơ Tỏi (Lớn)', desc: 'Khoai tây bổ múi cau dày giòn da thơm lừng mùi bơ tỏi.', inStorePrice: 35000, img: 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=400&q=80', category: 'Món Kèm' }
  ],
  tra_sua: [
    { name: 'Trà Sữa Trân Châu Hoàng Kim', desc: 'Trà đen đậm vị kết hợp sữa béo ngậy kèm trân châu hoàng kim giòn dai ngọt nhẹ.', inStorePrice: 35000, img: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&q=80', category: 'Trà Sữa' },
    { name: 'Trà Sữa Matcha Đậu Đỏ Dẻo', desc: 'Matcha Nhật Bản kết hợp sữa thơm mát và đậu đỏ ngọt béo bùi vị.', inStorePrice: 38000, img: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&q=80', category: 'Trà Sữa' },
    { name: 'Lục Trà Nhài Sữa Kem Macchiato', desc: 'Lục trà nhài thanh mát phủ lớp kem sữa muối mằn mặn béo ngậy.', inStorePrice: 32000, img: 'https://images.unsplash.com/photo-1556881286-fc6915169721?w=400&q=80', category: 'Trà Trái Cây' },
    { name: 'Trà Đào Cam Sả Tươi Mát', desc: 'Trà đào sả tươi ngọt thanh kèm 3 miếng đào giòn dai ngâm.', inStorePrice: 32000, img: 'https://images.unsplash.com/photo-1556881286-fc6915169721?w=400&q=80', category: 'Trà Trái Cây' },
    { name: 'Thạch Trân Châu Hoàng Kim Thêm', desc: 'Trân châu giòn sật rim mật ong vàng óng.', inStorePrice: 8000, img: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&q=80', category: 'Topping' }
  ],
  cafe: [
    { name: 'Cà Phê Sữa Đá Truyền Thống', desc: 'Robusta Tây Nguyên pha phin chậm thơm đắng nồng kết hợp sữa đặc ngọt béo.', inStorePrice: 22000, img: 'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?w=400&q=80', category: 'Cà Phê' },
    { name: 'Bạc Xỉu Sương Sáo Cốt Dừa', desc: 'Nhiều sữa ít cà phê béo ngậy nước cốt dừa xiêm cùng thạch sương sáo thanh mát.', inStorePrice: 25000, img: 'https://images.unsplash.com/photo-1541167760496-1628856ab772?w=400&q=80', category: 'Cà Phê' },
    { name: 'Cà Phê Muối Kem Bông Thơm Béo', desc: 'Cà phê nâu pha muối biển và lớp kem mặn mằn mặn ngậy béo thơm ngon.', inStorePrice: 28000, img: 'https://images.unsplash.com/photo-1541167760496-1628856ab772?w=400&q=80', category: 'Cà Phê' },
    { name: 'Trà Đào Cam Sả Hạt Chia', desc: 'Trà đào sả tươi ngọt thanh kết hợp hạt chia bổ dưỡng.', inStorePrice: 32000, img: 'https://images.unsplash.com/photo-1556881286-fc6915169721?w=400&q=80', category: 'Trà Trái Cây' },
    { name: 'Bánh Croissant Bơ Tỏi Nướng Giòn', desc: 'Bánh sừng bò ngập bơ tỏi đút lò giòn tan thơm phức.', inStorePrice: 25000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Bánh Ngọt' }
  ],
  an_vat: [
    { name: 'Mẹt Cá Viên Chiên Thập Cẩm Sốt Mắm', desc: 'Đầy đủ cá viên, bò viên, tôm viên, xúc xích, đậu hũ chiên xối sốt tỏi ớt kẹo.', inStorePrice: 55000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Ăn Vặt' },
    { name: 'Bánh Tráng Trộn Sa Tế Tôm Trứng Cút', desc: 'Bánh tráng trộn muối tôm sa tế cay nồng xoài xanh khô bò khô mực lạc rang trứng cút.', inStorePrice: 20000, img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80', category: 'Bánh Tráng' },
    { name: 'Bánh Tráng Cuộn Bơ Hành Phi', desc: 'Bánh tráng cuộn nhân bơ lòng đỏ trứng béo ngậy hành phi thơm giòn ruộm.', inStorePrice: 22000, img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80', category: 'Bánh Tráng' },
    { name: 'Tokbokki Phô Mai Cay Ly Lớn', desc: 'Bánh gạo cay dẻo quánh ngập sốt Gochujang đỏ rực chả cá phô mai kéo sợi.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Món Hàn' },
    { name: 'Trà Tắc Hạt Chia Giải Khát', desc: 'Trà xanh nhài pha mật ong chanh sả tắc chua ngọt giải khát.', inStorePrice: 15000, img: 'https://images.unsplash.com/photo-1621263764928-df1444c5e859?w=400&q=80', category: 'Nước Giải Khát' }
  ],
  lau_nuong: [
    { name: 'Set Lẩu Thái Hải Sản Chua Cay (2 Người)', desc: 'Nước lẩu Thái chua cay cốt dừa béo nhẹ đầy tôm mực ngao chả viên mỳ tôm.', inStorePrice: 189000, img: 'https://images.unsplash.com/photo-1547592180-85f173990554?w=400&q=80', category: 'Lẩu' },
    { name: 'Set Lẩu Gà Lá Giang Lá Chanh (2 Người)', desc: 'Lẩu gà ta chặt khúc thịt dai ngọt nước chua chua lá giang lá chanh sả.', inStorePrice: 169000, img: 'https://images.unsplash.com/photo-1547592180-85f173990554?w=400&q=80', category: 'Lẩu' },
    { name: 'Ba Chỉ Bò Mỹ Cuộn Nhúng Lẩu (150g)', desc: 'Thịt ba chỉ bò Mỹ vân mỡ đẹp dẻo mềm béo nhúng ngọt lịm.', inStorePrice: 79000, img: 'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43?w=400&q=80', category: 'Nhúng Kèm' },
    { name: 'Đĩa Hải Sản Tổng Hợp Nhúng Kèm', desc: 'Mực tươi khoanh tròn, tôm thẻ đỏ au và ngao sần sật nhúng lèo.', inStorePrice: 95000, img: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=80', category: 'Nhúng Kèm' },
    { name: 'Rau Nấm Lẩu Thập Cẩm Sạch', desc: 'Cải thảo, rau muống, nấm kim châm nấm đùi gà cải cúc.', inStorePrice: 25000, img: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=80', category: 'Nhúng Kèm' }
  ],
  oc_hai_san: [
    { name: 'Ốc Hương Rang Muối Ớt Cay Nồng', desc: 'Ốc hương tươi giòn ngọt béo rang đẫm muối tôm tỏi ớt cay xè dậy mùi.', inStorePrice: 65000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Món Ốc' },
    { name: 'Ốc Móng Tay Xào Tỏi Hành Thơm Lừng', desc: 'Ốc móng tay dai béo ngọt tự nhiên xào cháy tỏi hành bơ ngậy thơm.', inStorePrice: 55000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Món Ốc' },
    { name: 'Sò Huyết Cháy Tỏi Bơ Ngọt Béo', desc: 'Sò huyết tươi sống xào chín tái bơ cháy tỏi ngọt nước thịt béo ngậy.', inStorePrice: 60000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Món Ốc' },
    { name: 'Mực Trứng Hấp Sả Hành Gừng Tươi', desc: 'Mực trứng ngọt đầy ụ trứng hấp nồng nàn vị sả gừng cay ấm.', inStorePrice: 95000, img: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=80', category: 'Hải Sản' },
    { name: 'Càng Ghẹ Rang Muối Cay Kéo Sợi', desc: 'Càng ghẹ dày thịt rang phủ muối ớt cay kéo sợi.', inStorePrice: 85000, img: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=80', category: 'Hải Sản' }
  ],
  japanese_korean: [
    { name: 'Set Sushi Thập Cẩm Premium (10 Viên)', desc: 'Sushi cá hồi, tôm sú, trứng cuộn ngọt, lươn nướng Nhật cùng gừng hồng mù tạt cay nồng.', inStorePrice: 120000, img: 'https://images.unsplash.com/photo-1563245372-f21724e3856d?w=400&q=80', category: 'Sushi' },
    { name: 'Tokbokki Phô Mai Cay Kéo Sợi', desc: 'Bánh gạo cay dẻo quánh ngập sốt Gochujang đỏ rực chả cá phô mai kéo sợi.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Món Hàn' },
    { name: 'Kimbap Chiên Xù Giòn Rụm Lớn', desc: 'Cơm cuộn Hàn Quốc chiên xù xốp giòn vỏ bên trong nhân xúc xích củ cải vàng sốt mayo.', inStorePrice: 35000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Món Hàn' },
    { name: 'Mỳ Tương Đen Jajangmyeon Đặc Trưng', desc: 'Sợi mỳ to dai trộn nước sốt tương đen thịt băm ngọt bùi hành tây.', inStorePrice: 55000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Món Hàn' },
    { name: 'Cơm Trộn Thịt Bò Bulgogi Trứng Lòng Đào', desc: 'Cơm nóng thố đá đầy đủ giá đỗ, rau nấm, kim chi, bò xào Bulgogi ngọt lịm trứng lòng đào sốt cay.', inStorePrice: 65000, img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80', category: 'Món Hàn' }
  ],
  noodles_general: [
    { name: 'Mì Cay Thập Cẩm 7 Cấp Độ', desc: 'Mì Hàn Quốc dai ngon, hải sản tôm mực bắp bò súp kim chi cay nồng hấp dẫn.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Mì Cay' },
    { name: 'Mì Xào Giòn Hải Sản Đặc Biệt', desc: 'Sợi mì trứng chiên vàng giòn rụm rưới sốt hải sản tôm mực cải ngọt sền sệt béo bùi.', inStorePrice: 48000, img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80', category: 'Món Xào' },
    { name: 'Hủ Tiếu Gõ Khô Trộn Tỏi Phi', desc: 'Hủ tiếu bình dân mà thơm ngon nức nở trộn tỏi phi thơm xá xíu trứng cút.', inStorePrice: 25000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Hủ Tiếu Gõ' },
    { name: 'Mì Trộn Trứng Lòng Đào Tóp Mỡ', desc: 'Mì gói trụng dai dai trộn sốt sa tế cay cay lòng đào tóp mỡ giòn rụm.', inStorePrice: 32000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Mì Trộn' },
    { name: 'Nước Sâm Lạnh Râu Ngô Đường Phèn', desc: 'Nước sâm mát lạnh nấu từ râu ngô và lá dứa đường phèn giải nhiệt.', inStorePrice: 8000, img: 'https://images.unsplash.com/photo-1621263764928-df1444c5e859?w=400&q=80', category: 'Giải Khát' }
  ],
  bun_xao: [
    { name: 'Bún Xào Thịt Nướng Đặc Biệt', desc: 'Thịt nướng tẩm vị sa tế, chả giò chiên giòn rụm kèm nước mắm tỏi ớt đặc trưng.', inStorePrice: 35000, img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80', category: 'Bún Xào' },
    { name: 'Bún Xào Ba Chỉ Heo Cực Ngon', desc: 'Thịt ba chỉ heo thái mỏng xào lăn tỏi hành thơm béo bùi.', inStorePrice: 38000, img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80', category: 'Bún Xào' },
    { name: 'Bún Xào Hải Sản Tôm Mực Tươi', desc: 'Tôm mực tươi xào tỏi hành tây cải ngọt ngọt lịm dai giòn.', inStorePrice: 42000, img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80', category: 'Bún Xào' },
    { name: 'Bún Xào Chay Đậu Hũ Rau Củ', desc: 'Đậu hũ chiên phồng xào cùng cải ngọt, nấm đùi gà thanh đạm tốt cho sức khỏe.', inStorePrice: 28000, img: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=80', category: 'Món Chay' },
    { name: 'Nước Sâm Lạnh Râu Ngô Đường Phèn', desc: 'Nước sâm tự nấu ngọt dịu mát thanh giải nhiệt cực đã ngày hè.', inStorePrice: 10000, img: 'https://images.unsplash.com/photo-1621263764928-df1444c5e859?w=400&q=80', category: 'Giải Khát' }
  ],
  default: [
    { name: 'Bánh Xèo Miền Tây Khổng Lồ', desc: 'Vỏ bánh xèo giòn rụm bột nghệ nước cốt dừa, nhân thịt heo tôm sú giá đỗ hành tây, ăn kèm rau rừng nước mắm chua ngọt.', inStorePrice: 45000, img: 'https://images.unsplash.com/photo-1563245372-f21724e3856d?w=400&q=80', category: 'Món Việt' },
    { name: 'Gỏi Cuốn Tôm Thịt Heo (3 cái)', desc: 'Tôm sú hấp đỏ, thịt ba chỉ luộc mỏng cuộn bún tươi rau thơm hẹ lá bánh tráng phơi sương, chấm tương đậu phộng.', inStorePrice: 30000, img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80', category: 'Khai vị' },
    { name: 'Nem Nướng Nha Trang (Set 1 người)', desc: 'Nem heo nướng sả, bánh tráng giòn chiên phồng cuộn rau sống xoài xanh dưa chuột chấm nước sốt sệt độc quyền.', inStorePrice: 55000, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80', category: 'Món cuốn' },
    { name: 'Trà Đá Chanh Sả Mát Lạnh', desc: 'Trà xanh nhài pha mật ong chanh sả đá mát giải khát ngày hè cực đã.', inStorePrice: 10000, img: 'https://images.unsplash.com/photo-1621263764928-df1444c5e859?w=400&q=80', category: 'Đồ uống' }
  ]
};

function getShortBrand(name) {
  let brand = (name || '').split(/[-|,|(|]/)[0].trim();
  // Loại bỏ các tiền tố chung chung để lấy thương hiệu ngắn gọn
  brand = brand.replace(/^(hệ thống|quán cơm|quán bún|quán phở|quán|tiệm cơm|tiệm bánh|tiệm|bánh mì|bánh mỳ|cơm tấm|cơm gà|bún bò huế|bún bò|hủ tiếu mực|hủ tiếu|phở bò|phở|bún riêu|bánh canh|gà rán|sushi|ốc|lẩu nướng|lẩu|nướng|trà sữa|cà phê|càphê|cafe|coffee|ăn vặt)\s+/i, '');
  return brand.trim() || 'ShipFee';
}

function selectMenuTemplate(name) {
  const n = (name || '').toLowerCase();
  
  if (n.includes('cơm tấm') || n.includes('com tam')) {
    return MENU_TEMPLATES.com_tam;
  }
  if (n.includes('cơm gà') || n.includes('com ga')) {
    return MENU_TEMPLATES.com_ga;
  }
  if (n.includes('cơm') || n.includes('com') || n.includes('quán cơm') || n.includes('rice')) {
    return MENU_TEMPLATES.com_general;
  }
  if (n.includes('bún bò') || n.includes('bun bo')) {
    return MENU_TEMPLATES.bun_bo;
  }
  if (n.includes('hủ tiếu mực') || n.includes('hu tieu muc')) {
    return MENU_TEMPLATES.hu_tieu_muc;
  }
  if (n.includes('hủ tiếu') || n.includes('hu tieu') || n.includes('hủ tiêú')) {
    return MENU_TEMPLATES.hu_tieu;
  }
  if (n.includes('phở') || n.includes('pho')) {
    return MENU_TEMPLATES.pho;
  }
  if (n.includes('bún riêu') || n.includes('bun rieu')) {
    return MENU_TEMPLATES.bun_rieu;
  }
  if (n.includes('bánh mì') || n.includes('bánh mỳ') || n.includes('banh mi') || n.includes('xôi') || n.includes('xoi')) {
    return MENU_TEMPLATES.banh_mi;
  }
  if (n.includes('bánh canh') || n.includes('banh canh')) {
    return MENU_TEMPLATES.banh_canh;
  }
  if (n.includes('gà rán') || n.includes('ga ran') || n.includes('kfc') || n.includes('jollibee') || n.includes('lotteria') || n.includes('mcdonald')) {
    return MENU_TEMPLATES.ga_ran;
  }
  if (n.includes('pizza') || n.includes('burger') || n.includes('mỳ ý') || n.includes('spaghetti') || n.includes('pasta') || n.includes('mì ý') || n.includes('italia') || n.split(/[\s,.\-\(\)]+/).includes('ý')) {
    return MENU_TEMPLATES.western;
  }
  if (n.includes('trà sữa') || n.includes('tra sua') || n.includes('milk tea') || n.includes('chè') || n.includes('che') || n.includes('bingsu') || n.includes('kem')) {
    return MENU_TEMPLATES.tra_sua;
  }
  if (n.includes('coffee') || n.includes('cà phê') || n.includes('ca phe') || n.includes('café') || n.includes('sinh tố')) {
    return MENU_TEMPLATES.cafe;
  }
  if (n.includes('bún xào') || n.includes('bun xao')) {
    return MENU_TEMPLATES.bun_xao;
  }
  if (n.includes('mì cay') || n.includes('mi cay') || n.includes('mì xào') || n.includes('mỳ xào') || n.includes('xào') || n.includes('xao') || n.includes('mì gõ') || n.includes('mi go')) {
    return MENU_TEMPLATES.noodles_general;
  }
  if (n.includes('ăn vặt') || n.includes('an vat') || n.includes('cá viên') || n.includes('ca vien') || n.includes('bánh tráng') || n.includes('banh trang') || n.includes('tokbokki')) {
    return MENU_TEMPLATES.an_vat;
  }
  if (n.includes('lẩu') || n.includes('nướng') || n.includes('hotpot') || n.includes('bbq') || n.includes('buffet')) {
    return MENU_TEMPLATES.lau_nuong;
  }
  if (n.includes('ốc') || n.includes('oc') || n.includes('hải sản') || n.includes('hai san') || n.includes('tôm') || n.includes('mực') || n.includes('ghẹ')) {
    return MENU_TEMPLATES.oc_hai_san;
  }
  if (n.includes('sushi') || n.includes('kimbap') || n.includes('nhật') || n.includes('hàn quốc') || n.includes('món hàn') || n.split(/[\s,.\-\(\)]+/).includes('hàn') || n.includes('sashimi')) {
    return MENU_TEMPLATES.japanese_korean;
  }
  return MENU_TEMPLATES.default;
}

function generateMenuForRestaurant(name, resId) {
  if (String(resId).includes('bun_xao_khang')) {
    const items = [
      {
        id: `${resId}-item-0`,
        name: 'Bún Thịt Xào Chả Giò',
        desc: 'Hộp bao gồm: Bún tươi, rau thơm, xà lách, dưa leo, dưa chua, thịt xào sả, nem nướng, chả giò rế nhà làm, đậu phộng.',
        inStorePrice: 33000,
        img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80',
        category: 'MENU ĐỒ ĂN'
      },
      {
        id: `${resId}-item-1`,
        name: 'Bún Thịt Xào Nem Nướng',
        desc: 'Hộp bao gồm: Bún tươi, rau thơm, xà lách, dưa leo, dưa chua, thịt xào sả, nem nướng, đậu phộng.',
        inStorePrice: 29000,
        img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80',
        category: 'MENU ĐỒ ĂN'
      },
      {
        id: `${resId}-item-2`,
        name: 'Bánh Ướt Chả Lụa',
        desc: 'Hộp bao gồm: Bánh ướt, rau thơm, xà lách, giá trụng, chả lụa, chả chiên, nem nướng, nem chua, đậu phộng, hành phi.',
        inStorePrice: 29000,
        img: 'https://images.unsplash.com/photo-1563245372-f21724e3856d?w=400&q=80',
        category: 'MENU ĐỒ ĂN'
      },
      {
        id: `${resId}-item-3`,
        name: 'Bún Chả Giò',
        desc: 'Hộp bao gồm: Bún tươi, rau thơm, xà lách, dưa leo, dưa chua, chả giò rế nhà làm, đậu phộng.',
        inStorePrice: 27000,
        img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80',
        category: 'MENU ĐỒ ĂN'
      },
      {
        id: `${resId}-item-4`,
        name: 'Bún Nem Nướng',
        desc: 'Hộp bao gồm: Bún tươi, rau thơm, xà lách, dưa leo, dưa chua, nem nướng, đậu phộng.',
        inStorePrice: 29000,
        img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80',
        category: 'MENU ĐỒ ĂN'
      },
      {
        id: `${resId}-item-5`,
        name: 'Chả Giò Rế 4 Cuốn',
        desc: 'Chả giò rế chiên vàng giòn rụm, vỏ rế xốp giòn nhân tôm thịt thơm ngon chấm nước mắm chua ngọt.',
        inStorePrice: 17000,
        img: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=80',
        category: 'Món Ăn Kèm'
      }
    ];
    return items.map(item => ({
      ...item,
      appPrice: calcAppPrice(item.inStorePrice)
    }));
  }
  const template = selectMenuTemplate(name);
  const brand = getShortBrand(name);
  
  return template.map((item, i) => {
    // Tính giá app cố định 28% markup (làm tròn 100đ)
    const appPrice = calcAppPrice(item.inStorePrice);

    // Cá nhân hóa tên món ăn theo thương hiệu quán
    let itemName = item.name;
    if (i === 0 || i === 1 || item.name.includes('Đặc Biệt') || item.name.includes('Truyền Thống') || item.name.includes('Đặc Trưng')) {
      if (item.name.includes('Đặc Biệt')) {
        itemName = item.name.replace('Đặc Biệt', `${brand} Đặc Biệt`);
      } else if (item.name.includes('Truyền Thống')) {
        itemName = item.name.replace('Truyền Thống', `${brand} Gia Truyền`);
      } else {
        itemName = `${item.name} ${brand}`;
      }
    }
    
    // Tránh bị trùng lặp thương hiệu
    itemName = itemName.replace(new RegExp(`${brand}\\s+${brand}`, 'ig'), brand).trim();

    return {
      id:           `${resId}-item-${i}`,
      name:         itemName,
      desc:         item.desc.replace(/gia truyền|truyền thống|trứ danh/ig, `gia truyền của hiệu ${brand}`),
      inStorePrice: item.inStorePrice,
      appPrice:     appPrice,
      img:          item.img,
      category:     item.category
    };
  });
}

const MENUS_DIR = path.join(__dirname, 'menus');
let dbQueuePromise = Promise.resolve();

// ══════════════════════════════════════════════════════════════════════════════
// IN-MEMORY CACHE + PRE-BUILT SEARCH INDEX (Phần 3: Tối ưu tốc độ tìm kiếm)
// Thay vì đọc file 7MB mỗi request, load 1 lần vào RAM + auto-reload khi thay đổi
// ══════════════════════════════════════════════════════════════════════════════
let cachedRestaurants = [];      // Dữ liệu restaurant đầy đủ trong RAM
let searchIndex = [];            // Pre-normalized search index
let cacheLoadedAt = 0;           // Timestamp lần load gần nhất
let adminRestaurantStats = { total: 0, open: 0, closed: 0, withMenu: 0 };
let adminChangedCache = { at: 0, ids: new Set(), count: 0 };
const ADMIN_CHANGED_CACHE_TTL_MS = 30 * 1000;
// "Biến động gần đây" chỉ tính thay đổi trong khung thời gian này (mặc định 24h).
const RECENT_CHANGE_WINDOW_MS = Math.max(
  0,
  parseInt(process.env.RECENT_CHANGE_WINDOW_MS || String(24 * 60 * 60 * 1000), 10) || 24 * 60 * 60 * 1000
);

// Declared before loadRestaurantsIntoMemory() — used during boot precompute
const geocodeCache = new Map();
const nearbyListCache = new Map(); // key -> { at, data }
const NEARBY_LIST_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Puppeteer scrape kills free Render dynos — off on Render unless explicitly enabled
const IS_RENDER = !!process.env.RENDER;
const MENU_SCRAPE_ENABLED = process.env.ENABLE_MENU_SCRAPE === 'true'
  || (!IS_RENDER && process.env.ENABLE_MENU_SCRAPE !== 'false');

function buildSearchIndex(restaurants) {
  return restaurants.map((r, idx) => ({
    idx,
    id: r.id,
    normName: normalizeText(r.name),
    normCategory: normalizeText(r.category),
    normDishNames: (r.dishNames || []).map(d => normalizeText(d)),
    normAddress: normalizeText(r.address),
    isClosed: !!r.isClosed,
  }));
}

function loadRestaurantsIntoMemory() {
  const startMs = Date.now();
  try {
    const data = dbHelper.read();
    if (Array.isArray(data)) {
      cachedRestaurants = data;
      searchIndex = buildSearchIndex(data);
      cacheLoadedAt = Date.now();
      recomputeAdminRestaurantStats(data);
      adminChangedCache = { at: 0, ids: new Set(), count: 0 };
      try { nearbyListCache.clear(); } catch (_) {}
      // Warm geocode for all restaurants once — list requests then only do haversine
      try { precomputeRestaurantCoordinates(); } catch (geoErr) {
        console.warn('[Geo] Precompute skipped at load:', geoErr.message);
      }
      const elapsed = Date.now() - startMs;
      console.log(`[Cache] ✅ Loaded ${cachedRestaurants.length} restaurants into memory (${elapsed}ms, index: ${searchIndex.length} entries)`);
    }
  } catch (err) {
    console.error('[Cache] ❌ Error loading DB:', err.message);
  }
}

// Load on startup
loadRestaurantsIntoMemory();

/**
 * Restore a single restaurant menu from Supabase (fast path for detail views).
 * Returns menu array or null.
 */
async function hydrateOneMenuFromSupabase(restaurantId) {
  if (!supabase || !restaurantId) return null;
  try {
    const { data, error } = await supabase
      .from('restaurants')
      .select('id, menu, dish_names, has_real_menu, updated_at')
      .eq('id', String(restaurantId))
      .maybeSingle();

    if (error) {
      console.error(`[Menu Hydrate] Lỗi lấy menu ${restaurantId}:`, error.message);
      return null;
    }
    if (!data || !Array.isArray(data.menu) || data.menu.length === 0) return null;

    const quality = analyzeMenuQuality(data.menu);
    // Never persist pure template menus as if they were scraped
    if (quality.isTemplate) {
      const mem = cachedRestaurants.find(r => String(r.id) === String(restaurantId));
      if (mem) {
        mem.hasRealMenu = false;
        mem.menuTemplateFallback = true;
        mem.menuQuality = quality.reason;
      }
      console.log(`[Menu Hydrate] ⏭️ Skip template menu từ Supabase: ${restaurantId} (${quality.reason})`);
      return null;
    }

    writeRestaurantMenu(restaurantId, data.menu);
    const mem = cachedRestaurants.find(r => String(r.id) === String(restaurantId));
    if (mem) {
      applyMenuFlags(mem, data.menu);
      mem.menuUpdatedAt = data.updated_at || new Date().toISOString();
      if (Array.isArray(data.dish_names) && data.dish_names.length > 0 && quality.isReal) {
        mem.dishNames = data.dish_names;
      } else {
        mem.dishNames = data.menu.map(m => m.name).filter(Boolean);
      }
    }
    console.log(`[Menu Hydrate] ✅ Restore 1 menu từ Supabase: ${restaurantId} (${data.menu.length} món, ${quality.reason})`);
    return data.menu;
  } catch (err) {
    console.error(`[Menu Hydrate] Lỗi hydrateOne ${restaurantId}:`, err.message);
    return null;
  }
}

/**
 * Reconcile hasRealMenu / menuTemplateFallback from actual menu payloads in Supabase.
 * Promotes scraped menus wrongly marked fallback; demotes unsplash templates wrongly marked real.
 * Light on memory: pages of 40, updates flags + writes real menus for promoted rows only.
 */
async function reconcileMenuFlagsFromSupabase({ maxPages = 200, pageSize = 40 } = {}) {
  if (!supabase) {
    console.log('[Menu Reconcile] Supabase chưa cấu hình — bỏ qua.');
    return { promoted: 0, demoted: 0, scanned: 0 };
  }

  let promoted = 0;
  let demoted = 0;
  let scanned = 0;
  let offset = 0;
  const localUpdates = new Map(); // id -> { hasRealMenu, menuTemplateFallback, dishNames?, menu? }

  for (let page = 0; page < maxPages; page++) {
    const { data, error } = await supabase
      .from('restaurants')
      .select('id, name, has_real_menu, menu, dish_names')
      .range(offset, offset + pageSize - 1);

    if (error) {
      console.error('[Menu Reconcile] Query error:', error.message);
      break;
    }
    if (!Array.isArray(data) || data.length === 0) break;

    for (const row of data) {
      scanned += 1;
      const quality = analyzeMenuQuality(row.menu);
      const markedReal = row.has_real_menu === true;

      if (quality.isReal && !markedReal) {
        promoted += 1;
        localUpdates.set(String(row.id), {
          hasRealMenu: true,
          menuTemplateFallback: false,
          dishNames: (Array.isArray(row.dish_names) && row.dish_names.length)
            ? row.dish_names
            : (row.menu || []).map(m => m && m.name).filter(Boolean),
          menu: row.menu,
          menuQuality: quality.reason
        });
      } else if (quality.isTemplate && markedReal) {
        demoted += 1;
        localUpdates.set(String(row.id), {
          hasRealMenu: false,
          menuTemplateFallback: true,
          menuQuality: quality.reason
        });
      }
    }

    offset += pageSize;
    if (data.length < pageSize) break;
  }

  if (localUpdates.size === 0) {
    console.log(`[Menu Reconcile] ✅ Scanned ${scanned}. No flag changes needed.`);
    return { promoted, demoted, scanned };
  }

  // Apply to in-memory cache + chunk DB
  let memChanged = 0;
  for (const r of cachedRestaurants) {
    if (!r || !r.id) continue;
    const u = localUpdates.get(String(r.id));
    if (!u) continue;
    r.hasRealMenu = u.hasRealMenu;
    if (u.hasRealMenu) delete r.menuTemplateFallback;
    else r.menuTemplateFallback = true;
    if (u.dishNames) r.dishNames = u.dishNames;
    if (u.menuQuality) r.menuQuality = u.menuQuality;
    if (u.menu && u.hasRealMenu) {
      // Write file without per-row Supabase sync (flags synced in batch below)
      try {
        if (!fs.existsSync(MENUS_DIR)) fs.mkdirSync(MENUS_DIR, { recursive: true });
        fs.writeFileSync(getMenuFilePath(r.id), JSON.stringify(u.menu, null, 2), 'utf8');
      } catch (_) {}
    }
    memChanged += 1;
  }

  await updateLocalDatabase((localData) => {
    let changed = false;
    for (let i = 0; i < localData.length; i++) {
      const r = localData[i];
      if (!r || !r.id) continue;
      const u = localUpdates.get(String(r.id));
      if (!u) continue;
      const nextReal = u.hasRealMenu === true;
      const nextFb = !nextReal;
      if (r.hasRealMenu !== nextReal || !!r.menuTemplateFallback !== nextFb) {
        r.hasRealMenu = nextReal;
        if (nextReal) delete r.menuTemplateFallback;
        else r.menuTemplateFallback = true;
        if (u.dishNames) r.dishNames = u.dishNames;
        delete r.menu;
        changed = true;
      }
    }
    return changed;
  });

  // Correct Supabase flags for promoted/demoted (not soft)
  let sbUpdated = 0;
  for (const [id, u] of localUpdates) {
    try {
      const payload = {
        has_real_menu: u.hasRealMenu === true,
        updated_at: new Date().toISOString()
      };
      if (u.dishNames) payload.dish_names = u.dishNames;
      // Do not push template menus as real; for demote leave menu as-is but fix flag
      const { error } = await supabase.from('restaurants').update(payload).eq('id', id);
      if (!error) sbUpdated += 1;
    } catch (e) {
      console.warn('[Menu Reconcile] Supabase update failed', id, e.message);
    }
  }

  searchIndex = buildSearchIndex(cachedRestaurants);
  console.log(`[Menu Reconcile] ✅ scanned=${scanned} promoted=${promoted} demoted=${demoted} mem=${memChanged} supabase=${sbUpdated}`);
  return { promoted, demoted, scanned, memChanged, sbUpdated };
}

/**
 * Restore menu files from Supabase after deploy (menus/ is gitignored).
 * Runs in background so boot is not blocked.
 */
async function hydrateMenusFromSupabase() {
  if (!supabase) {
    console.log('[Menu Hydrate] Supabase chưa cấu hình — bỏ qua restore menu.');
    return;
  }
  // Bulk restore pulls full menu JSON — OOM risk on Render free. Detail uses hydrateOneMenuFromSupabase.
  if (IS_RENDER && process.env.ENABLE_BULK_MENU_HYDRATE !== 'true') {
    console.log('[Menu Hydrate] ⏭️ Skip bulk restore on Render (on-demand hydrateOne only). Set ENABLE_BULK_MENU_HYDRATE=true to force.');
    return;
  }
  try {
    const missing = cachedRestaurants.filter(r => {
      if (!r || !r.id || r.hasRealMenu !== true) return false;
      const filePath = getMenuFilePath(r.id);
      return !fs.existsSync(filePath);
    });
    if (missing.length === 0) {
      console.log('[Menu Hydrate] ✅ Tất cả quán hasRealMenu đã có file menu local.');
      return;
    }
    console.log(`[Menu Hydrate] 🔄 Cần restore ${missing.length} menu từ Supabase...`);

    let restored = 0;
    const batchSize = IS_RENDER ? 10 : 50;
    // Prioritize first batches so early customer opens hit disk sooner
    for (let i = 0; i < missing.length; i += batchSize) {
      const batch = missing.slice(i, i + batchSize);
      const ids = batch.map(r => String(r.id));
      const { data, error } = await supabase
        .from('restaurants')
        .select('id, menu, dish_names, has_real_menu, updated_at')
        .in('id', ids);

      if (error) {
        console.error('[Menu Hydrate] Lỗi query Supabase:', error.message);
        continue;
      }
      if (!Array.isArray(data)) continue;

      for (const row of data) {
        if (!row || !row.id || !Array.isArray(row.menu) || row.menu.length === 0) continue;
        const quality = analyzeMenuQuality(row.menu);
        if (quality.isTemplate) {
          const mem = cachedRestaurants.find(r => String(r.id) === String(row.id));
          if (mem) {
            mem.hasRealMenu = false;
            mem.menuTemplateFallback = true;
            mem.menuQuality = quality.reason;
          }
          continue;
        }
        if (!quality.isReal) continue;
        if (writeRestaurantMenu(row.id, row.menu)) {
          restored++;
          const mem = cachedRestaurants.find(r => String(r.id) === String(row.id));
          if (mem) {
            applyMenuFlags(mem, row.menu);
            mem.menuUpdatedAt = row.updated_at || new Date().toISOString();
            if (Array.isArray(row.dish_names) && row.dish_names.length > 0) {
              mem.dishNames = row.dish_names;
            } else {
              mem.dishNames = row.menu.map(m => m.name).filter(Boolean);
            }
          }
        }
      }
    }

    if (restored > 0) {
      searchIndex = buildSearchIndex(cachedRestaurants);
      console.log(`[Menu Hydrate] ✅ Đã restore ${restored}/${missing.length} menu từ Supabase.`);
    } else {
      console.log(`[Menu Hydrate] ⚠️ Không restore được menu nào (có thể chưa sync lên Supabase).`);
    }
  } catch (err) {
    console.error('[Menu Hydrate] Lỗi bất ngờ:', err.message);
  }
}

/**
 * DELTA-HYDRATE danh sách quán từ Supabase (không cần redeploy).
 * Kéo các row có updated_at > lastSync → cập nhật thẳng in-memory cache
 * (giá/tên/đóng-mở/hasRealMenu/dishNames) + thêm quán mới phát hiện.
 * Nhẹ & an toàn RAM: KHÔNG select cột `menu` (menu content vẫn hydrate on-demand).
 */
let lastRestaurantDeltaSync = null; // ISO timestamp lần đồng bộ gần nhất
const REST_DELTA_COLUMNS = 'id, name, address, lat, lon, rating, image_url, is_closed, closed_reason, has_real_menu, dish_names, updated_at';

async function hydrateRestaurantDeltaFromSupabase() {
  if (!supabase) return;
  try {
    let q = supabase.from('restaurants').select(REST_DELTA_COLUMNS);
    if (lastRestaurantDeltaSync) {
      q = q.gt('updated_at', lastRestaurantDeltaSync).order('updated_at', { ascending: true }).limit(500);
    } else {
      // Lần đầu: chỉ warm 300 quán biến động gần nhất để tránh tải nặng lúc boot
      q = q.order('updated_at', { ascending: false }).limit(300);
    }

    const { data, error } = await q;
    if (error) {
      console.warn('[Rest Delta] Không đọc được Supabase:', error.message);
      return;
    }
    if (!Array.isArray(data) || data.length === 0) return;

    const byId = new Map();
    cachedRestaurants.forEach((r, idx) => { if (r && r.id != null) byId.set(String(r.id), idx); });

    let updated = 0;
    let added = 0;
    let maxTs = lastRestaurantDeltaSync || '';

    for (const row of data) {
      if (!row || row.id == null) continue;
      if (row.updated_at && String(row.updated_at) > String(maxTs)) maxTs = String(row.updated_at);

      const idx = byId.get(String(row.id));
      if (idx != null) {
        const cur = cachedRestaurants[idx];
        if (row.name) cur.name = row.name;
        if (row.address != null) cur.address = row.address;
        if (row.lat != null) cur.latitude = row.lat;
        if (row.lon != null) cur.longitude = row.lon;
        cur.rating = row.rating || cur.rating || 4.5;
        if (row.image_url) cur.img = row.image_url;
        cur.isClosed = row.is_closed === true;
        cur.closedReason = row.closed_reason || '';
        cur.hasRealMenu = row.has_real_menu === true;
        if (Array.isArray(row.dish_names) && row.dish_names.length) cur.dishNames = row.dish_names;
        updated++;
      } else {
        cachedRestaurants.push({
          id: row.id,
          name: row.name || '',
          address: row.address || '',
          latitude: row.lat != null ? row.lat : undefined,
          longitude: row.lon != null ? row.lon : undefined,
          rating: row.rating || 4.5,
          img: row.image_url || '',
          isClosed: row.is_closed === true,
          closedReason: row.closed_reason || '',
          hasRealMenu: row.has_real_menu === true,
          dishNames: Array.isArray(row.dish_names) ? row.dish_names : []
        });
        added++;
      }
    }

    if (maxTs) lastRestaurantDeltaSync = maxTs;
    if (updated + added > 0) {
      searchIndex = buildSearchIndex(cachedRestaurants);
      try { recomputeAdminRestaurantStats(cachedRestaurants); } catch (_) {}
      try { nearbyListCache.clear(); } catch (_) {}
      if (typeof invalidateAdminChangedCache === 'function') invalidateAdminChangedCache();
      console.log(`[Rest Delta] ✅ cập nhật ${updated} · thêm mới ${added} quán từ Supabase (lastSync=${lastRestaurantDeltaSync}).`);
    }
  } catch (e) {
    console.warn('[Rest Delta] Lỗi:', e.message);
  }
}

// Auto-reload when chunk files change (debounced).
// Disabled on Render — boot sanitize/hydrate writes trigger reload storms + OOM on free dynos.
let reloadTimer = null;
const CHUNKS_DIR = path.join(__dirname, 'restaurants-chunks');
if (fs.existsSync(CHUNKS_DIR) && !IS_RENDER) {
  fs.watch(CHUNKS_DIR, () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      console.log('[Cache] 🔄 Chunk database files changed, reloading...');
      loadRestaurantsIntoMemory();
      SEARCHED_RESTAURANTS_CACHE.clear();
      console.log('[Cache] 🧹 SEARCHED_RESTAURANTS_CACHE cleared to prevent stale fallback menus.');
    }, 1000);
  });
} else if (IS_RENDER) {
  console.log('[Cache] ℹ️ Chunk file watcher disabled on Render to avoid reload/OOM loops.');
}

/**
 * Fast search using pre-built index - O(n) with pre-normalized strings
 * @param {string} query - Raw search query
 * @returns {Array} Matching restaurants
 */
function fastSearch(query) {
  const startMs = Date.now();
  const normQuery = normalizeText(query);
  const tokens = normQuery.split(/\s+/).filter(t => t.length > 0);
  if (tokens.length === 0) return [];

  // Không ghép token chéo giữa nhiều món/trường (tránh "cơm"+"gà"+"kim" → hàng trăm quán nhiễu).
  // Mỗi tiêu chí phải chứa ĐỦ mọi token; ưu tiên cụm từ trong tên quán.
  const scored = [];
  for (const entry of searchIndex) {
    const phraseName = !!normQuery && entry.normName.includes(normQuery);
    const nameAll = tokens.every(t => entry.normName.includes(t));
    const addrAll = tokens.every(t => entry.normAddress.includes(t));
    const catAll = tokens.every(t => entry.normCategory.includes(t));
    const dishPhrase = !!normQuery && entry.normDishNames.some(d => d.includes(normQuery));
    const dishAll = entry.normDishNames.some(d => tokens.every(t => d.includes(t)));
    // ≥2 từ khóa: chỉ nhận khớp tên/địa chỉ/category hoặc cả cụm trên 1 món (không ghép token rời)
    const strong = phraseName || nameAll || addrAll || catAll || dishPhrase;
    if (!strong && !(tokens.length === 1 && dishAll)) continue;

    let score = 0;
    if (phraseName) score += 100;
    if (nameAll) score += 50;
    if (addrAll) score += 15;
    if (catAll) score += 10;
    if (dishPhrase) score += 20;
    else if (dishAll) score += 8;
    if (!entry.isClosed) score += 5;
    score += tokens.filter(t => entry.normName.includes(t)).length * 3;
    scored.push({ idx: entry.idx, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const results = scored.map(s => cachedRestaurants[s.idx]);
  const elapsed = Date.now() - startMs;
  console.log(`[FastSearch] "${query}" → ${results.length} results in ${elapsed}ms`);
  return results;
}

// Tạo thư mục menus nếu chưa tồn tại
if (!fs.existsSync(MENUS_DIR)) {
  fs.mkdirSync(MENUS_DIR, { recursive: true });
}

function getMenuFilePath(restaurantId) {
  const safeId = String(restaurantId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(MENUS_DIR, `${safeId}.json`);
}

function readRestaurantMenu(restaurantId) {
  const filePath = getMenuFilePath(restaurantId);
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw) || [];
    }
  } catch (err) {
    console.error(`[DB Menu] Lỗi đọc menu cho ${restaurantId}:`, err.message);
  }
  return null;
}

function writeRestaurantMenu(restaurantId, menu) {
  // Chỉ cho phép ghi file menu nếu quán thực sự tồn tại trong database để tránh file dư thừa
  const exists = cachedRestaurants && cachedRestaurants.some(r => r && String(r.id) === String(restaurantId));
  if (!exists) {
    console.warn(`[DB Menu] ⚠️ Từ chối ghi file menu cho ID không tồn tại trong database: "${restaurantId}"`);
    return false;
  }

  const filePath = getMenuFilePath(restaurantId);
  try {
    fs.writeFileSync(filePath, JSON.stringify(menu || [], null, 2), 'utf8');
    // Đồng bộ lên Supabase ở background (không await để tránh block luồng chính)
    syncRestaurantToSupabase(restaurantId).catch(err => {
      console.error('[Supabase Sync] Background error:', err.message);
    });
    return true;
  } catch (err) {
    console.error(`[DB Menu] Lỗi ghi menu cho ${restaurantId}:`, err.message);
  }
  return false;
}

async function syncRestaurantToSupabase(restaurantId) {
  if (!supabase) return;
  try {
    const allRests = dbHelper.read();
    const restaurant = allRests.find(r => String(r.id) === String(restaurantId));
    if (!restaurant) return;
    
    // Đọc menu chi tiết từ file local
    const menuFilePath = getMenuFilePath(restaurantId);
    let menu = [];
    if (fs.existsSync(menuFilePath)) {
      try {
        const raw = fs.readFileSync(menuFilePath, 'utf8');
        menu = JSON.parse(raw) || [];
      } catch (e) {}
    }
    
    const quality = analyzeMenuQuality(menu);
    const hasReal = quality.isReal === true;
    // Delegate qua module chung supabaseSync để nhất quán schema với các script GrabFood
    const res = await supaSync.upsertRestaurant(restaurant, menu, { client: supabase, hasRealMenu: hasReal });
    if (!res.ok && !res.skipped) {
      console.error(`[Supabase Sync] Lỗi upsert quán ${restaurantId}:`, res.error);
    } else if (res.ok) {
      console.log(`[Supabase Sync] Đã đồng bộ thành công quán "${restaurant.name}" lên Supabase.`);
    }
  } catch (err) {
    console.error(`[Supabase Sync] Lỗi bất ngờ khi đồng bộ quán ${restaurantId}:`, err.message);
  }
}

/**
 * Cập nhật cơ sở dữ liệu local JSON một cách an toàn (tránh tranh chấp ghi file ghi đè dữ liệu)
 * @param {Function} updaterFn Nhận vào array restaurants, thực hiện thay đổi và trả về true nếu cần lưu
 */
function updateLocalDatabase(updaterFn) {
  return new Promise((resolve, reject) => {
    dbQueuePromise = dbQueuePromise.then(() => {
      try {
        const data = dbHelper.read();
        if (Array.isArray(data)) {
          const shouldSave = updaterFn(data);
          if (shouldSave !== false) {
            dbHelper.write(data);
          }
        }
        resolve();
      } catch (err) {
        console.error('[DB Queue] Lỗi thực thi hàng đợi DB:', err.message);
        reject(err);
      }
    });
  });
}
function getHaversineDistance(coords1, coords2) {
  const R = 6371; // Earth's radius in km
  const dLat = (coords2.lat - coords1.lat) * Math.PI / 180;
  const dLon = (coords2.lon - coords1.lon) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(coords1.lat * Math.PI / 180) * Math.cos(coords2.lat * Math.PI / 180) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Geocode cache - địa chỉ không thay đổi, cache kết quả
function hashToUnit(str) {
  let h = 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (Math.abs(h) % 10000) / 10000;
}

function geocodeAddress(address, name, restaurantId) {
  // Check cache first
  if (restaurantId && geocodeCache.has(restaurantId)) {
    return geocodeCache.get(restaurantId);
  }

  const text = ((address || '') + ' ' + (name || '')).toLowerCase();
  
  // Basic Vietnamese tone removal to improve matching
  const cleanText = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // CMT8 chạy dài nhiều quận — ưu tiên theo phường/quận trong địa chỉ
  if (cleanText.includes('cach mang thang 8') || cleanText.includes('cmt8')) {
    let result;
    if (cleanText.includes('binh thuy') || cleanText.includes('an thoi')) {
      result = { lat: 10.06014, lon: 105.76537 };
    } else {
      // Cái Khế / Ninh Kiều (mặc định đúng hơn centroid cũ gần Nguyễn Đệ)
      result = { lat: 10.05031, lon: 105.77514 };
    }
    if (restaurantId) geocodeCache.set(restaurantId, result);
    return result;
  }

  const mappings = [
    { keys: ['nguyen van cu'], lat: 10.0298, lon: 105.7584 },
    { keys: ['mau than'], lat: 10.0276, lon: 105.7725 },
    { keys: ['ba thang hai', '3 thang 2', '3/2'], lat: 10.0244, lon: 105.7676 },
    { keys: ['30 thang 4', 'ba muoi thang tu', '30/4'], lat: 10.0165, lon: 105.7708 },
    { keys: ['tran hung dao'], lat: 10.0381, lon: 105.7801 },
    { keys: ['ly tu trong'], lat: 10.0354, lon: 105.7825 },
    { keys: ['hung vuong'], lat: 10.0415, lon: 105.7818 },
    { keys: ['tran van hoai'], lat: 10.0261, lon: 105.7772 },
    { keys: ['tam vu'], lat: 10.0182, lon: 105.7720 },
    { keys: ['de tham'], lat: 10.0336, lon: 105.7828 },
    { keys: ['quang trung'], lat: 10.0229, lon: 105.7905 },
    { keys: ['vo van kiet'], lat: 10.0526, lon: 105.7502 },
    { keys: ['cai rang'], lat: 9.9968, lon: 105.7505 },
    { keys: ['o mon'], lat: 10.1205, lon: 105.6292 },
    { keys: ['binh thuy'], lat: 10.0763, lon: 105.7289 }
  ];

  // Deterministic jitter (stable across requests; no Math.random)
  const seed = restaurantId || name || address || 'x';
  const jitterLat = (hashToUnit(seed) - 0.5) * 0.003;
  const jitterLon = (hashToUnit(seed + ':lon') - 0.5) * 0.003;

  let result;
  let matched = false;
  for (const mapping of mappings) {
    if (mapping.keys.some(key => cleanText.includes(key))) {
      result = { lat: mapping.lat + jitterLat, lon: mapping.lon + jitterLon };
      matched = true;
      break;
    }
  }

  if (!matched) {
    // Default Ninh Kieu Center + jitter
    result = { lat: 10.0345 + jitterLat * 1.6, lon: 105.7876 + jitterLon * 1.6 };
  }

  // Cache the result
  if (restaurantId) {
    geocodeCache.set(restaurantId, result);
  }
  return result;
}

// Tọa độ placeholder đã biết (chia sẻ bởi nhiều quán khi discovery thiếu GPS)
// → KHÔNG coi là exact; để geocodeAddress heuristic xử lý (chỉ đường bằng địa chỉ text).
const PLACEHOLDER_COORDS = [
  [10.045158, 105.746857], // grabfood default
  [10.0345, 105.761],      // cụm placeholder khác
  [10.0452, 105.7469]      // discovery fallback
];
function isPlaceholderCoord(lat, lon) {
  return PLACEHOLDER_COORDS.some(([a, b]) => Math.abs(lat - a) < 1e-6 && Math.abs(lon - b) < 1e-6);
}

function precomputeRestaurantCoordinates() {
  const t0 = Date.now();
  let geocoded = 0;
  let exact = 0;
  let placeholder = 0;
  for (const r of cachedRestaurants) {
    if (!r || !r.id) continue;
    const hasNum =
      typeof r.latitude === 'number' && typeof r.longitude === 'number' &&
      Number.isFinite(r.latitude) && Number.isFinite(r.longitude);
    const isPlaceholder = hasNum && isPlaceholderCoord(r.latitude, r.longitude);
    if (hasNum && !isPlaceholder) {
      // Geocoder (Nominatim/Photon) chỉ đạt cấp đường/phường → dùng cho khoảng cách + bản đồ,
      // KHÔNG dùng chỉ đường Maps (nút chỉ đường dùng địa chỉ text, Google resolve chuẩn hơn).
      if (r.geoSource === 'nominatim' || r.geoSource === 'photon') {
        r.coordsSource = 'geocoded';
      } else if (r.coordsSource !== 'heuristic') {
        // GPS thật từ file cào (Grab/Shopee) hoặc đối chiếu (crossref) → nav-grade.
        r.coordsSource = 'exact';
        exact++;
      }
      geocodeCache.set(String(r.id), { lat: r.latitude, lon: r.longitude, source: r.coordsSource });
      continue;
    }
    // Không có tọa độ HOẶC là placeholder chung → ước lượng theo tên đường.
    const coords = geocodeAddress(r.address || '', r.name || '', r.id);
    r.latitude = coords.lat;
    r.longitude = coords.lon;
    r.coordsSource = 'heuristic'; // Ước lượng theo tên đường — KHÔNG dùng cho chỉ đường Maps
    geocodeCache.set(String(r.id), { lat: coords.lat, lon: coords.lon, source: 'heuristic' });
    if (isPlaceholder) placeholder++;
    else geocoded++;
  }
  console.log(`[Geo] ✅ Coords ready for ${cachedRestaurants.length} restaurants (exact ${exact}, heuristic ${geocoded}, placeholder→heuristic ${placeholder}) in ${Date.now() - t0}ms`);
}

/** Lấy bản ghi quán chuẩn từ DB RAM theo restaurantId */
function findRestaurantInCache(restaurantId) {
  if (!restaurantId || !Array.isArray(cachedRestaurants)) return null;
  return cachedRestaurants.find(r => r && String(r.id) === String(restaurantId)) || null;
}

/**
 * Đồng bộ địa chỉ + tọa độ quán từ DB đã cào vào đơn hàng.
 * - Luôn cập nhật restaurantAddress từ DB (địa chỉ cào chính xác)
 * - Chỉ gán lat/lon khi coordsSource === 'exact' (tránh heuristic đường phố sai)
 */
function hydrateOrderRestaurantCoords(order) {
  if (!order || !order.restaurantId) return order;
  const mem = findRestaurantInCache(order.restaurantId);
  if (!mem) return order;

  if (mem.address && String(mem.address).trim()) {
    order.restaurantAddress = String(mem.address).trim();
  }
  if (mem.name && String(mem.name).trim()) {
    order.restaurantName = String(mem.name).trim();
  }

  const exact =
    mem.coordsSource === 'exact' &&
    typeof mem.latitude === 'number' &&
    typeof mem.longitude === 'number' &&
    Number.isFinite(mem.latitude) &&
    Number.isFinite(mem.longitude);

  if (exact) {
    order.restaurantLat = mem.latitude;
    order.restaurantLon = mem.longitude;
    order.restaurantCoordsExact = true;
  } else {
    order.restaurantCoordsExact = false;
  }
  return order;
}

function normalizeUserCoords(lat, lon) {
  let userLat = parseFloat(lat) || 10.0345;
  let userLon = parseFloat(lon) || 105.7876;
  const dLat = (10.0345 - userLat) * Math.PI / 180;
  const dLon = (105.7876 - userLon) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(userLat * Math.PI / 180) * Math.cos(10.0345 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  if (6371 * c > 20) {
    userLat = 10.0345;
    userLon = 105.7876;
  }
  return { lat: userLat, lon: userLon };
}

function toListRestaurant(r, distKm) {
  const estMins = 12 + Math.round(distKm * 5);
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    rating: r.rating,
    reviews: r.reviews,
    address: r.address,
    phone: r.phone,
    img: r.img,
    tags: r.tags,
    minOrder: r.minOrder,
    isClosed: !!r.isClosed,
    closedAt: r.closedAt || null,
    closedReason: r.closedReason || null,
    hasRealMenu: r.hasRealMenu === true,
    menuTemplateFallback: r.menuTemplateFallback === true,
    menuUpdatedAt: r.menuUpdatedAt || null,
    latitude: r.latitude,
    longitude: r.longitude,
    distanceValue: distKm,
    distance: distKm < 1 ? `${Math.round(distKm * 1000)} m` : `${distKm.toFixed(1)} km`,
    time: `${estMins}-${estMins + 8} phút`,
    dishNames: Array.isArray(r.dishNames) ? r.dishNames.slice(0, 20) : []
  };
}

/**
 * Fast nearby list for GET /api/restaurants.
 * Cache stores light {idx, distKm, isClosed} rows — materialize only the page.
 */
function getNearbyRestaurantsPage(lat, lon, page = 1, limit = 20) {
  const t0 = Date.now();
  const user = normalizeUserCoords(lat, lon);
  const cacheKey = `${user.lat.toFixed(3)},${user.lon.toFixed(3)}`;

  let ordered; // Array<{idx, distKm, isClosed}>
  const hit = nearbyListCache.get(cacheKey);
  if (hit && (Date.now() - hit.at) < NEARBY_LIST_CACHE_TTL_MS) {
    ordered = hit.data;
  } else {
    const scored = [];
    for (let i = 0; i < cachedRestaurants.length; i++) {
      const r = cachedRestaurants[i];
      if (!r || !r.id) continue;
      let coords;
      if (typeof r.latitude === 'number' && typeof r.longitude === 'number') {
        coords = { lat: r.latitude, lon: r.longitude };
      } else {
        coords = geocodeAddress(r.address || '', r.name || '', r.id);
        r.latitude = coords.lat;
        r.longitude = coords.lon;
      }
      scored.push({ idx: i, distKm: getHaversineDistance(user, coords), isClosed: !!r.isClosed });
    }

    let filtered = scored.filter(x => x.distKm <= 3.0);
    if (filtered.length === 0) {
      filtered = scored.slice().sort((a, b) => a.distKm - b.distKm).slice(0, 10);
    }
    const open = filtered.filter(x => !x.isClosed).sort((a, b) => a.distKm - b.distKm);
    const closed = filtered.filter(x => x.isClosed).sort((a, b) => a.distKm - b.distKm);
    ordered = open.concat(closed);

    nearbyListCache.set(cacheKey, { at: Date.now(), data: ordered });
    if (nearbyListCache.size > 20) {
      const oldest = nearbyListCache.keys().next().value;
      nearbyListCache.delete(oldest);
    }
    console.log(`[Nearby] Built ${ordered.length} nearby for ${cacheKey} in ${Date.now() - t0}ms`);
  }

  const total = ordered.length;
  const startIdx = (page - 1) * limit;
  const pageRows = ordered.slice(startIdx, startIdx + limit);
  const data = pageRows.map(x => toListRestaurant(cachedRestaurants[x.idx], x.distKm)).filter(Boolean);
  return {
    data,
    total,
    page,
    limit,
    hasMore: startIdx + pageRows.length < total,
    tookMs: Date.now() - t0
  };
}

function applyDistanceMarkupToMenu(restaurant, lat, lon) {
  if (!restaurant) return restaurant;
  const userLat = parseFloat(lat);
  const userLon = parseFloat(lon);
  
  if (isNaN(userLat) || isNaN(userLon)) {
    // Không có tọa độ → chỉ áp dụng markup 28% cơ sở, không có surcharge
    const cloned = {
      ...restaurant,
      distanceSurchargePerItem: 0,
      menu: (restaurant.menu || []).map(item => ({
        ...item,
        appPrice: calcAppPrice(item.inStorePrice)
      }))
    };
    return cloned;
  }

  const userCoords = { lat: userLat, lon: userLon };
  const restCoords = geocodeAddress(restaurant.address || '', restaurant.name || '', restaurant.id);
  const distKm = getHaversineDistance(userCoords, restCoords);

  // Compute progressive distance surcharge per item using square root function
  let extraMarkupPerItem = 0;
  if (distKm > PRICING_CONFIG.FREE_DISTANCE_KM) {
    extraMarkupPerItem = PRICING_CONFIG.SURCHARGE_COEFFICIENT * Math.sqrt(distKm - PRICING_CONFIG.FREE_DISTANCE_KM);
  }

  // Round surcharge to the nearest 100đ
  extraMarkupPerItem = round100(extraMarkupPerItem);

  // Clone the restaurant object to avoid mutating memory cache/database
  const clonedRestaurant = {
    ...restaurant,
    latitude: restCoords.lat,
    longitude: restCoords.lon,
    distanceValue: distKm,
    distance: distKm < 1 ? `${Math.round(distKm * 1000)} m` : `${distKm.toFixed(1)} km`,
    time: `${12 + Math.round(distKm * 5)}-${20 + Math.round(distKm * 5)} phút`,
    distanceSurchargePerItem: extraMarkupPerItem,
    menu: (restaurant.menu || []).map(item => {
      // Giá app = markup 28% cơ sở + distance surcharge
      const baseAppPrice = calcAppPrice(item.inStorePrice);
      return {
        ...item,
        appPrice: baseAppPrice + extraMarkupPerItem
      };
    })
  };

  if (extraMarkupPerItem > 0) {
    console.log(`[Dynamic Pricing] "${restaurant.name}" cách ${distKm.toFixed(2)} km. Markup 28%: +${PRICING_CONFIG.MARKUP_RATE * 100}% | Surcharge: +${extraMarkupPerItem.toLocaleString('vi-VN')}đ/món`);
  }
  return clonedRestaurant;
}

function processRestaurantsWithLocation(localData, lat, lon, skipDistanceFilter = false) {
  if (!Array.isArray(localData)) return [];

  const userCoords = normalizeUserCoords(lat, lon);
  const { isGenericBrandPortal } = require('./slugMap');

  // Separate cache namespace from getNearbyRestaurantsPage (search / fallback only)
  const cacheKey = skipDistanceFilter
    ? null
    : `proc:${userCoords.lat.toFixed(3)},${userCoords.lon.toFixed(3)}:${localData.length}`;
  if (cacheKey) {
    const hit = nearbyListCache.get(cacheKey);
    if (hit && (Date.now() - hit.at) < NEARBY_LIST_CACHE_TTL_MS) {
      return hit.data;
    }
  }

  const processed = [];
  for (let i = 0; i < localData.length; i++) {
    const r = localData[i];
    if (!r || !r.id) continue;
    // Ẩn portal cha "N chi nhánh" — chỉ hiện chi nhánh đặt được
    if (r.isBrandPortal || isGenericBrandPortal(r.name, r.address)) continue;
    let coords;
    if (typeof r.latitude === 'number' && typeof r.longitude === 'number') {
      coords = { lat: r.latitude, lon: r.longitude };
    } else {
      coords = geocodeAddress(r.address || '', r.name || '', r.id);
      r.latitude = coords.lat;
      r.longitude = coords.lon;
    }
    const distKm = getHaversineDistance(userCoords, coords);
    processed.push(toListRestaurant(r, distKm));
  }

  let filteredData = processed;
  if (!skipDistanceFilter) {
    filteredData = processed.filter(r => r.distanceValue <= 3.0);
    if (filteredData.length === 0) {
      filteredData = [...processed].sort((a, b) => a.distanceValue - b.distanceValue).slice(0, 10);
    }
  }

  // Search (skipDistanceFilter): giữ thứ tự liên quan từ fastSearch — không xếp lại theo khoảng cách.
  // Nearby list: mở cửa trước, rồi theo khoảng cách.
  let result;
  if (skipDistanceFilter) {
    result = filteredData;
  } else {
    const openRests = filteredData.filter(r => !r.isClosed).sort((a, b) => a.distanceValue - b.distanceValue);
    const closedRests = filteredData.filter(r => r.isClosed).sort((a, b) => a.distanceValue - b.distanceValue);
    result = [...openRests, ...closedRests];
  }

  if (cacheKey) {
    nearbyListCache.set(cacheKey, { at: Date.now(), data: result });
    if (nearbyListCache.size > 60) {
      const oldest = nearbyListCache.keys().next().value;
      nearbyListCache.delete(oldest);
    }
  }
  return result;
}

function sanitizeLocalJsonData() {
  console.log('[Sanitization] 🔍 Đang quét và làm sạch dữ liệu trong cơ sở dữ liệu phân mảnh...');
  try {
    const localData = dbHelper.read();
    if (Array.isArray(localData)) {
      let changed = false;
      let migrationCount = 0;

      // Giữ nguyên các quán đóng cửa (không tự động xóa tránh mất mát dữ liệu gốc)
      const cleanData = localData;

      cleanData.forEach(restaurant => {
        // Reset trạng thái đóng cửa nếu đã đến giờ hẹn
        if (resetClosedIfNextAttemptReached(restaurant)) {
          changed = true;
        }

        // ── MIGRATION LOGIC ──
        // Nếu quán vẫn có thuộc tính menu, di trú ra file riêng
        if (restaurant.menu) {
          const menu = restaurant.menu;
          writeRestaurantMenu(restaurant.id, menu);
          restaurant.dishNames = menu.map(m => m.name).filter(Boolean);
          delete restaurant.menu;
          changed = true;
          migrationCount++;
        }
      });

      if (changed) {
        dbHelper.write(cleanData);
        console.log(`[Sanitization] 💾 Đã lưu thay đổi làm sạch vào database phân mảnh (Di trú thành công: ${migrationCount} quán)`);
      } else {
        console.log('[Sanitization] ✨ Không phát hiện sai sót menu hay quán đóng cửa cần xử lý!');
      }
    }
  } catch (err) {
    console.error('[Sanitization] ❌ Lỗi làm sạch dữ liệu phân mảnh:', err.message);
  }
}

/**
 * Phân giải Slug ShopeeFood thực tế bằng cách cào trang chi tiết Foody
 */
async function getShopeeFoodSlugFromFoody(foodySlug) {
  const tryUrls = [
    `https://www.foody.vn/can-tho/${foodySlug}`,
    `https://www.foody.vn/thuong-hieu/${foodySlug}?c=can-tho`
  ];

  for (const url of tryUrls) {
    try {
      console.log(`[Slug Resolver] 🔍 Đang phân giải slug ShopeeFood từ Foody: ${url}...`);
      
      const res = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        },
        timeout: 6000
      });
      
      if (res.status === 200) {
        const $ = cheerio.load(res.data);
        let shopeefoodUrl = '';
        
        // Tìm liên kết ShopeeFood chứa /can-tho/
        $('a').each((i, el) => {
          const href = $(el).attr('href') || '';
          if (href.includes('shopeefood.vn/can-tho/') && !href.includes('/can-tho/fresh') && !href.includes('/can-tho/food')) {
            shopeefoodUrl = href;
          }
        });
        
        if (shopeefoodUrl) {
          // Tách lấy slug
          const parts = shopeefoodUrl.split('?')[0].split('/');
          const resolvedSlug = parts.pop() || parts.pop();
          if (resolvedSlug) {
            console.log(`[Slug Resolver] ✅ Tìm thấy slug thực tế trên ShopeeFood từ ${url}: "${resolvedSlug}"`);
            return resolvedSlug;
          }
        }
      }
    } catch (err) {
      console.warn(`[Slug Resolver] ⚠️ Thử phân giải từ ${url} không thành công:`, err.message);
    }
  }
  
  // Fallback về slug mặc định ban đầu
  return foodySlug;
}

/**
 * Phân giải các chi nhánh thực tế từ trang thương hiệu Foody
 * (dùng brandResolver dùng chung với crawler — chấp nhận foody slug khi thiếu link SF)
 */
async function resolveBrandBranches(brandSlug) {
  const { resolveBrandBranches: resolve } = require('./brandResolver');
  console.log(`[Brand Resolver] 🔍 Đang phân giải các chi nhánh từ trang thương hiệu: ${brandSlug}...`);
  try {
    const branches = await resolve(brandSlug);
    console.log(`[Brand Resolver] ✅ Tìm thấy ${branches.length} chi nhánh từ thương hiệu: ${brandSlug}`);
    return branches;
  } catch (err) {
    console.warn(`[Brand Resolver] ⚠️ Lỗi phân giải chi nhánh từ thương hiệu ${brandSlug}:`, err.message);
    return [];
  }
}

async function fetchAndParseFromFoody(q = '') {
  const url = q ? `https://www.foody.vn/can-tho/dia-diem?q=${encodeURIComponent(q)}` : `https://www.foody.vn/can-tho/dia-diem`;
  console.log(`[Scraper] Gọi tới Foody: ${url}`);
  
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    }
  });
  
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const rawItems = $('.row-item');
  const list = [];
  const brandResolutions = [];

  // Đọc dữ liệu local trước để bảo tồn thực đơn thực tế và trạng thái nếu đã có
  let localData = [];
  try {
    localData = dbHelper.read();
  } catch (e) {}
  
  rawItems.each((index, el) => {
    const name = $(el).find('h2 a, .row-item-title a, a[class*="title"]').text().trim();
    const href = $(el).find('h2 a, .row-item-title a, a[class*="title"]').attr('href') || '';
    
    let img = $(el).find('.ri-avatar img, img').attr('src') || '';
    if (!img || img.includes('ratin-rank') || img.includes('arrow-top')) {
      img = 'https://images.unsplash.com/photo-1625398407796-82650a8c135f?w=800&q=80';
    }

    let ratingText = $(el).find('.point, .highlight-text').text().trim();
    let rating = parseFloat(ratingText);
    if (isNaN(rating) || rating <= 0) rating = 4.6;

    let address = $(el).find('.address, .row-item-address').text().trim();
    address = address.replace(/\s+/g, ' ').replace(/ ,/g, ',').trim();

    const commentsText = $(el).find('.stats a span').first().text().trim();
    let reviews = parseInt(commentsText);
    if (isNaN(reviews) || reviews <= 0) reviews = 100 + Math.floor(Math.random() * 500);

    if (href.includes('/thuong-hieu/')) {
      const brandSlug = href.split('?')[0].split('/').pop();
      brandResolutions.push(
        resolveBrandBranches(brandSlug).then(branches => {
          branches.forEach(branch => {
            let cat = 'Đồ ăn';
            const bn = branch.name.toLowerCase();
            if (bn.includes('coffee') || bn.includes('café') || bn.includes('cà phê')) cat = 'Cà phê';
            else if (bn.includes('trà sữa') || bn.includes('milk tea')) cat = 'Trà sữa';
            else if (bn.includes('bún bò')) cat = 'Bún Bò';
            else if (bn.includes('hủ tiếu')) cat = 'Hủ Tiếu';
            else if (bn.includes('bánh mì')) cat = 'Bánh Mì';
            else if (bn.includes('lẩu')) cat = 'Lẩu';
            else if (bn.includes('pizza') || bn.includes('burger')) cat = 'Fast Food';
            else if (bn.includes('cơm')) cat = 'Cơm tấm';

            // Bảo tồn dữ liệu thực tế đã có trong database
            let existingMenu = null;
            let hasRealMenu = false;
            let isClosed = false;
            let closedAt = null;
            let closedReason = null;
            let menuTemplateFallback = false;

            const existing = Array.isArray(localData) ? localData.find(r => String(r.id) === String(branch.id)) : null;
            if (existing) {
              if (existing.hasRealMenu) {
                existingMenu = existing.menu;
                hasRealMenu = true;
              }
              if (existing.isClosed) {
                isClosed = true;
                closedAt = existing.closedAt;
                closedReason = existing.closedReason;
              }
              if (existing.menuTemplateFallback) {
                menuTemplateFallback = true;
              }
            }

            const menu = existingMenu || generateMenuForRestaurant(branch.name, branch.id);
            if (!existingMenu) {
              menuTemplateFallback = true;
            }
            const menuUpdatedAt = existing ? existing.menuUpdatedAt : null;

            list.push({
              id:       branch.id,
              name:     branch.name,
              category: cat,
              rating:   rating,
              reviews:  reviews,
              distance: (Math.random() * 2 + 0.3).toFixed(1) + ' km',
              time:     `${15 + Math.floor(Math.random() * 20)}-${25 + Math.floor(Math.random() * 20)} phút`,
              address:  branch.address,
              phone:    '0292 3' + Math.floor(100000 + Math.random() * 900000),
              img:      branch.img,
              tags:     [rating > 7.5 ? 'Nổi bật' : 'Đang mở', reviews > 400 ? 'Yêu thích' : 'Mới mở'].slice(0, 2),
              minOrder: 30000,
              menu,
              hasRealMenu,
              isClosed,
              closedAt,
              closedReason,
              menuTemplateFallback,
              menuUpdatedAt,
              shopeefoodSlug: branch.shopeefoodSlug
            });
          });
        })
      );
    } else {
      let resId = 'r_ct_';
      if (href) {
        // Loại bỏ phần query parameter (ví dụ: ?c=can-tho) trước khi split lấy slug làm ID
        resId += href.split('?')[0].split('/').pop().replace(/-/g, '_');
      } else {
        resId += index;
      }

      const distanceVal = (Math.random() * 2 + 0.3);
      const distance = distanceVal.toFixed(1) + ' km';
      const timeVal = Math.round(distanceVal * 6 + 10);
      const time = `${timeVal}-${timeVal + 8} phút`;

      let category = 'Đồ ăn';
      const n = name.toLowerCase();
      if (n.includes('coffee') || n.includes('café') || n.includes('cà phê')) category = 'Cà phê';
      else if (n.includes('trà sữa') || n.includes('milk tea')) category = 'Trà sữa';
      else if (n.includes('bún bò')) category = 'Bún Bò';
      else if (n.includes('hủ tiếu')) category = 'Hủ Tiếu';
      else if (n.includes('bánh mì')) category = 'Bánh Mì';
      else if (n.includes('lẩu')) category = 'Lẩu';
      else if (n.includes('pizza') || n.includes('burger')) category = 'Fast Food';
      else if (n.includes('cơm')) category = 'Cơm tấm';

      // Bảo tồn dữ liệu thực tế đã có trong database
      let existingMenu = null;
      let hasRealMenu = false;
      let isClosed = false;
      let closedAt = null;
      let closedReason = null;
      let menuTemplateFallback = false;

      const existing = Array.isArray(localData) ? localData.find(r => String(r.id) === String(resId)) : null;
      if (existing) {
        if (existing.hasRealMenu) {
          existingMenu = existing.menu;
          hasRealMenu = true;
        }
        if (existing.isClosed) {
          isClosed = true;
          closedAt = existing.closedAt;
          closedReason = existing.closedReason;
        }
        if (existing.menuTemplateFallback) {
          menuTemplateFallback = true;
        }
      }

      const menu = existingMenu || generateMenuForRestaurant(name, resId);
      if (!existingMenu) {
        menuTemplateFallback = true;
      }
      const menuUpdatedAt = existing ? existing.menuUpdatedAt : null;

      list.push({
        id:       resId,
        name,
        category,
        rating,
        reviews,
        distance,
        time,
        address,
        phone:    '0292 3' + Math.floor(100000 + Math.random() * 900000),
        img,
        tags:     [rating > 7.5 ? 'Nổi bật' : 'Đang mở', reviews > 400 ? 'Yêu thích' : 'Mới mở'].slice(0, 2),
        minOrder: 30000,
        menu,
        hasRealMenu,
        isClosed,
        closedAt,
        closedReason,
        menuTemplateFallback,
        menuUpdatedAt
      });
    }
  });
  
  await Promise.all(brandResolutions);
  return list;
}

// ── CONFIG ──────────────────────────────────────────────────────────────────
const CACHE_FILE     = path.join(__dirname, 'cache.json');
const FALLBACK_FILE  = path.join(__dirname, '..', 'customer-app', 'restaurants-data.js');
const CACHE_DURATION = 10 * 60 * 1000; // 10 phút

// Cần Thơ city ID trên ShopeeFood = 59
// Tọa độ trung tâm Cần Thơ
const CAN_THO_LAT  = 10.0452;
const CAN_THO_LNG  = 105.7469;
const CAN_THO_CITY = 59;

// Headers giả lập browser thật
const SHOPEEFOOD_HEADERS = {
  'User-Agent':               'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept':                   'application/json, text/plain, */*',
  'Accept-Language':          'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding':          'gzip, deflate, br',
  'Referer':                  'https://shopeefood.vn/',
  'Origin':                   'https://shopeefood.vn',
  'x-foody-client-id':        '',
  'x-foody-client-language':  'vi',
  'x-foody-client-type':      '1',
  'x-foody-api-version':      '1',
  'x-foody-client-version':   '3',
  'x-foody-support-chef-show':'true',
};

// ── CORS — cho phép web app local gọi vào ──────────────────────────────────
// Đã xử lý tập trung ở cấu hình CORS phía trên đầu file
app.use(express.json());

// Phục vụ frontend tĩnh từ thư mục root (canonical cho shipfee.vercel.app)
app.use('/app', express.static(path.join(__dirname, '..', 'customer-app')));
app.use('/shipper-app', express.static(path.join(__dirname, '..', 'shipper-app')));
app.use('/admin-app', express.static(path.join(__dirname, '..', 'admin-app')));

// ── CACHE HELPERS ────────────────────────────────────────────────────────────
function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (Date.now() - data.timestamp < CACHE_DURATION) {
        return data.restaurants;
      }
    }
  } catch {}
  return null;
}

function writeCache(restaurants) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      timestamp: Date.now(),
      restaurants
    }, null, 2), 'utf8');
  } catch(e) {
    console.warn('[Cache] Không thể ghi cache:', e.message);
  }
}

// ── DATA TRANSFORMERS ────────────────────────────────────────────────────────
/**
 * Chuyển đổi từ format ShopeeFood → format web app
 */
function transformRestaurant(r, index) {
  const menu = (r.menu_items || r.dishes || []).map((item, i) => {
    const storePrice = item.price || item.display_price || 50000;
    // Thêm 28% markup cố định (làm tròn 100đ)
    const appPrice   = calcAppPrice(storePrice);

    return {
      id:           `${r.id || index}-item-${i}`,
      name:         item.name || item.dish_name || 'Món ăn',
      desc:         item.description || item.dish_description || '',
      inStorePrice: storePrice,
      appPrice:     appPrice,
      img:          item.photos?.[0]?.value || item.photo_url || getFoodPlaceholder(i),
      category:     item.category_name || item.group_name || 'Thực đơn'
    };
  });

  // Nếu không có menu từ API, tạo menu mẫu từ category
  if (menu.length === 0) {
    const defaultStorePrice = r.min_price || 45000;
    menu.push({
      id:           `${r.id || index}-item-0`,
      name:         `${r.display_type || 'Món'} Đặc Biệt`,
      desc:         `Món đặc trưng của ${r.name}`,
      inStorePrice: defaultStorePrice,
      appPrice:     calcAppPrice(defaultStorePrice),
      img:          r.photos?.[0]?.value || r.cover_photo || getRestaurantPlaceholder(r.name),
      category:     'Món chính'
    });
  }

  const distance = r.distance_display || r.distance
    ? (typeof r.distance === 'number' ? (r.distance / 1000).toFixed(1) + ' km' : r.distance_display)
    : `${(Math.random() * 2 + 0.3).toFixed(1)} km`;

  return {
    id:       String(r.id || `r${index}`),
    name:     r.name,
    category: r.display_type || r.cuisine_type || 'Đồ ăn',
    rating:   parseFloat(r.rating?.total_review || r.rating || 4.5),
    reviews:  parseInt(r.rating?.total_reviews || r.review_count || 100),
    distance: distance,
    time:     r.delivery_time || `${15 + Math.floor(Math.random() * 20)}-${25 + Math.floor(Math.random() * 20)} phút`,
    address:  r.address || r.full_address || 'Cần Thơ',
    phone:    r.phone || '',
    img:      r.photos?.[0]?.value || r.logo_img || r.cover_photo || getRestaurantPlaceholder(r.name),
    tags:     buildTags(r),
    minOrder: r.min_order_price || 30000,
    menu
  };
}

function buildTags(r) {
  const tags = [];
  if (r.is_quality_merchant) tags.push('Nổi bật');
  if (r.rating?.total_review > 200) tags.push('Yêu thích');
  if (r.is_new_restaurant) tags.push('Mới mở');
  if (r.promo_info?.has_discount) tags.push('Giảm giá');
  if (tags.length === 0) tags.push('Đang mở');
  return tags.slice(0, 2);
}

function getFoodPlaceholder(i) {
  const imgs = [
    'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&q=80',
    'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400&q=80',
    'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80',
    'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&q=80',
    'https://images.unsplash.com/photo-1563245372-f21724e3856d?w=400&q=80',
  ];
  return imgs[i % imgs.length];
}

function getRestaurantPlaceholder(name) {
  const imgs = [
    'https://images.unsplash.com/photo-1625398407796-82650a8c135f?w=800&q=80',
    'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=800&q=80',
    'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=800&q=80',
    'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=800&q=80',
    'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43?w=800&q=80',
    'https://images.unsplash.com/photo-1547592180-85f173990554?w=800&q=80',
    'https://images.unsplash.com/photo-1606755962773-d324e0a13086?w=800&q=80',
  ];
  const hash = (name || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return imgs[hash % imgs.length];
}

// ── FETCH FROM SHOPEEFOOD ────────────────────────────────────────────────────
async function fetchFromShopeeFood() {
  const endpoints = [
    // Endpoint 1: Danh sách quán theo tọa độ
    {
      url: `https://gappapi.deliverynow.vn/api/delivery/get_delivery_list`,
      params: {
        id_city:         CAN_THO_CITY,
        discovery_type:  1,
        foody_services:  1,
        keyword:         '',
        sort_type:       0,
        offset:          0,
        limit:           30,
        latitude:        CAN_THO_LAT,
        longitude:       CAN_THO_LNG
      }
    },
    // Endpoint 2: Quán theo khu vực
    {
      url: `https://gappapi.deliverynow.vn/api/delivery/get_restaurants_by_city`,
      params: {
        id_city:         CAN_THO_CITY,
        discovery_type:  1,
        foody_services:  1,
        keyword:         '',
        sort_type:       1,
        offset:          0,
        limit:           30
      }
    },
    // Endpoint 3: Tìm kiếm chung
    {
      url: `https://gappapi.deliverynow.vn/api/delivery/get_delivery_home`,
      params: {
        id_city:  CAN_THO_CITY,
        latitude: CAN_THO_LAT,
        longitude: CAN_THO_LNG
      }
    }
  ];

  for (const ep of endpoints) {
    try {
      console.log(`[ShopeeFood] Đang thử: ${ep.url}`);
      const res = await axios.get(ep.url, {
        headers: SHOPEEFOOD_HEADERS,
        params:  ep.params,
        timeout: 12000
      });

      const data = res.data;

      // Tìm mảng restaurants trong response
      const rawList =
        data?.result?.restaurants ||
        data?.result?.items ||
        data?.reply?.delivery_items ||
        data?.reply?.restaurants ||
        data?.data?.restaurants ||
        data?.restaurants ||
        [];

      if (rawList && rawList.length > 0) {
        console.log(`[ShopeeFood] ✅ Lấy được ${rawList.length} quán từ ${ep.url}`);
        return rawList.map(transformRestaurant);
      }
    } catch (err) {
      console.warn(`[ShopeeFood] ❌ ${ep.url}: ${err.response?.status || err.message}`);
    }
  }

  return null;
}

// ── ROUTES ───────────────────────────────────────────────────────────────────

function stripMenus(restaurants) {
  if (!Array.isArray(restaurants)) return restaurants;
  return restaurants.map(r => {
    const { menu, dishNames, ...rest } = r;
    return {
      ...rest,
      // Short preview for client local search; full index stays in RAM searchIndex
      dishNames: Array.isArray(dishNames) ? dishNames.slice(0, 20) : []
    };
  });
}

/**
 * GET /api/restaurants
 * Ưu tiên: Cache → ShopeeFood API → Fallback local data
 */
app.get('/api/restaurants', async (req, res) => {
  const query = req.query.q ? String(req.query.q).trim() : '';
  console.log(`\n[${new Date().toLocaleTimeString('vi-VN')}] GET /api/restaurants${query ? ' ?q=' + query : ''}`);

  // Nếu là yêu cầu tìm kiếm từ khóa thời gian thực
  if (query) {
    console.log(`[Search] Đang thực hiện tìm kiếm gộp cho từ khóa: "${query}"...`);
    
    // 1. Tìm kiếm bằng FastSearch (in-memory pre-built index)
    let localMatches = fastSearch(query);
    console.log(`[Search] 💾 Tìm thấy ${localMatches.length} quán trùng khớp trong local database.`);

    // 2. Tìm kiếm trực tuyến từ Foody (ĐÃ VÔ HIỆU HÓA để tránh quá tải/IP block, đảm bảo chịu tải 1000+ user cùng lúc)
    let onlineResults = [];

    // 3. Gộp kết quả (Ưu tiên bản ghi local có menu thực/giả lập chất lượng hơn, tránh trùng lặp)
    let mergedResults = [...localMatches];
    onlineResults.forEach(r => {
      if (r && r.id && !mergedResults.some(m => String(m.id) === String(r.id))) {
        mergedResults.push(r);
      }
    });

    // 3.5. Mở rộng kết quả cho các chuỗi hệ thống lớn
    // Nếu phát hiện từ khóa chuỗi lớn hoặc có quán thuộc chuỗi lớn, tự động mở rộng hiển thị toàn bộ chi nhánh
    const chainKeywords = ['jollibee', 'highlands', 'kfc', 'lotteria', 'lumos', 'xo', 'anh beo em u', 'phuc tea'];
    const chainsFound = new Set();
    
    const normQuery = normalizeText(query);
    chainKeywords.forEach(kw => {
      if (normQuery.includes(kw)) chainsFound.add(kw);
    });

    mergedResults.forEach(r => {
      const normName = normalizeText(r.name);
      chainKeywords.forEach(kw => {
        if (normName.includes(kw)) chainsFound.add(kw);
      });
    });

    if (chainsFound.size > 0) {
      console.log(`[Search Expansion] 🔄 Phát hiện từ khóa chuỗi lớn: [${Array.from(chainsFound).join(', ')}]. Tự động nạp toàn bộ chi nhánh...`);
      // Sử dụng cachedRestaurants + searchIndex thay vì đọc file
      for (const entry of searchIndex) {
        let matchChain = false;
        chainsFound.forEach(kw => {
          if (entry.normName.includes(kw)) matchChain = true;
        });
        if (matchChain) {
          const r = cachedRestaurants[entry.idx];
          if (!mergedResults.some(m => String(m.id) === String(r.id))) {
            mergedResults.push(r);
          }
        }
      }

      // Lọc bỏ portal cha "Hệ thống" (address = N chi nhánh) — khách đặt tại chi nhánh cụ thể
      const { isGenericBrandPortal } = require('./slugMap');
      mergedResults = mergedResults.filter(r => !r.isBrandPortal && !isGenericBrandPortal(r.name, r.address));
    }

    // Giữ thứ tự điểm liên quan từ fastSearch (không đảo theo đóng/mở — sẽ chôn quán khớp tên)

    // 4. Đồng bộ các kết quả search này vào SEARCHED_RESTAURANTS_CACHE phía server
    mergedResults.forEach(r => {
      if (r && r.id) {
        SEARCHED_RESTAURANTS_CACHE.set(String(r.id), r);
      }
    });

    // 5. Tự động lưu tất cả các quán ăn mới được cào từ Foody vào local database file restaurants-local.json một cách an toàn
    if (onlineResults && onlineResults.length > 0) {
      try {
        await updateLocalDatabase((localData) => {
          let hasNew = false;
          onlineResults.forEach(r => {
            const idx = localData.findIndex(item => String(item.id) === String(r.id));
            if (idx === -1) {
              localData.push(r);
              hasNew = true;
              console.log(`[Auto-Save] 📥 Tự động lưu quán ăn mới cào: "${r.name}"`);
            } else {
              // Đối chiếu và tự động cập nhật nếu có thay đổi từ online cào mới
              const localRest = localData[idx];
              let hasChanged = false;
              
              if (r.name && localRest.name !== r.name) {
                console.log(`[Comparison] 🔄 Cập nhật Tên quán: "${localRest.name}" -> "${r.name}"`);
                localRest.name = r.name;
                hasChanged = true;
              }
              if (r.category && localRest.category !== r.category) {
                console.log(`[Comparison] 🔄 Cập nhật Danh mục: "${localRest.category}" -> "${r.category}"`);
                localRest.category = r.category;
                hasChanged = true;
              }
              if (r.address && localRest.address !== r.address) {
                console.log(`[Comparison] 🔄 Cập nhật Địa chỉ: "${localRest.address}" -> "${r.address}"`);
                localRest.address = r.address;
                hasChanged = true;
              }
              if (r.img && localRest.img !== r.img) {
                localRest.img = r.img;
                hasChanged = true;
              }
              if (r.rating !== undefined && localRest.rating !== r.rating) {
                console.log(`[Comparison] 🔄 Cập nhật Điểm đánh giá cho "${localRest.name}": ${localRest.rating} -> ${r.rating}`);
                localRest.rating = r.rating;
                hasChanged = true;
              }
              if (r.reviews !== undefined && localRest.reviews !== r.reviews) {
                console.log(`[Comparison] 🔄 Cập nhật Số đánh giá cho "${localRest.name}": ${localRest.reviews} -> ${r.reviews}`);
                localRest.reviews = r.reviews;
                hasChanged = true;
              }
              if (r.isClosed !== undefined && localRest.isClosed !== r.isClosed) {
                console.log(`[Comparison] 🔄 Cập nhật Trạng thái đóng cửa cho "${localRest.name}": ${localRest.isClosed} -> ${r.isClosed}`);
                localRest.isClosed = r.isClosed;
                hasChanged = true;
              }

              if (hasChanged) {
                hasNew = true;
                // Đồng bộ thay đổi này ngược lại mergedResults và cache
                const mIdx = mergedResults.findIndex(m => String(m.id) === String(r.id));
                if (mIdx !== -1) {
                  // Giữ lại menu thực tế đã có trong database
                  mergedResults[mIdx] = { ...mergedResults[mIdx], ...localRest };
                }
                SEARCHED_RESTAURANTS_CACHE.set(String(r.id), localRest);
              }

              // (Background refresh disabled to ensure ShopeeFood independence)
            }
          });
          return hasNew;
        });
      } catch (err) {
        console.error('[Auto-Save] Lỗi tự động lưu quán ăn mới cào:', err.message);
      }
    }

    // Không spawn Puppeteer hàng loạt từ search — scrape chỉ khi khách mở trang detail (queue toàn cục)

    const processedResults = processRestaurantsWithLocation(mergedResults, req.query.lat, req.query.lon, !!query);
    // Cap search payload — slim objects; allow higher limit from client (?limit=)
    const rawCap = parseInt(req.query.limit, 10);
    const SEARCH_RESULT_CAP = Number.isFinite(rawCap) && rawCap > 0
      ? Math.min(rawCap, 200)
      : 120;
    const cappedResults = processedResults.length > SEARCH_RESULT_CAP
      ? processedResults.slice(0, SEARCH_RESULT_CAP)
      : processedResults;
    console.log(`[Search] ✅ Trả về ${cappedResults.length}/${processedResults.length} quán (cap ${SEARCH_RESULT_CAP}).`);
    // Tìm kiếm thời gian thực: không cache vì kết quả thay đổi theo từ khóa
    res.set('Cache-Control', 'no-cache, no-store');
    return res.json({
      source: 'merged_search',
      data: cappedResults,
      total: processedResults.length,
      hasMore: processedResults.length > cappedResults.length
    });
  }

  const firstChunkPath = dbHelper.getChunkPath(0);
  let shouldTrigger = false;

  // 1. Kiểm tra xem file local có tồn tại và còn mới không (10 phút)
  try {
    if (fs.existsSync(firstChunkPath)) {
      const stats = fs.statSync(firstChunkPath);
      const ageMs = Date.now() - stats.mtimeMs;
      if (ageMs > 10 * 60 * 1000) { // 10 phút
        console.log(`[Cache] Dữ liệu local đã cũ (${Math.round(ageMs / 60000)} phút)`);
        shouldTrigger = true;
      }
    } else {
      console.log('[Cache] Chưa có dữ liệu local JSON');
      shouldTrigger = true;
    }
  } catch (e) {
    shouldTrigger = true;
  }

  // Nếu dữ liệu cũ hoặc chưa có, kích hoạt crawler chạy ngầm
  if (shouldTrigger && !query) {
    triggerCrawler();
  }

  // 2. Fast nearby page from precomputed coords (no full-catalog clone)
  if (cachedRestaurants.length > 0) {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 100)
      : 20;
    const nearby = getNearbyRestaurantsPage(req.query.lat, req.query.lon, page, limit);
    const totalOpen = nearby.data.filter(r => !r.isClosed).length;
    const totalClosed = nearby.data.length - totalOpen;
    console.log(`[Response] ✅ Nearby page ${nearby.page}/${Math.ceil(nearby.total / nearby.limit) || 1}: ${nearby.data.length}/${nearby.total} quán in ${nearby.tookMs}ms (mở: ${totalOpen}, đóng: ${totalClosed})`);

    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    return res.json({
      source: 'local_cached',
      data: nearby.data,
      total: nearby.total,
      page: nearby.page,
      limit: nearby.limit,
      hasMore: nearby.hasMore,
      tookMs: nearby.tookMs
    });
  }

  // 3. Fallback: nếu chưa có local JSON, đọc từ restaurants-data.js bằng eval
  console.log('[Fallback] Đọc dữ liệu mẫu từ restaurants-data.js');
  try {
    const rawJs = fs.readFileSync(FALLBACK_FILE, 'utf8');
    const sandboxFn = new Function('module', 'exports', rawJs + '\n return RESTAURANTS;');
    const localData = sandboxFn({}, {});
    if (Array.isArray(localData) && localData.length > 0) {
      let responseData = [];
      if (query) {
        const qLower = query.toLowerCase();
        const matches = localData.filter(r =>
          r.name.toLowerCase().includes(qLower) ||
          r.category.toLowerCase().includes(qLower) ||
          r.menu.some(m => m.name.toLowerCase().includes(qLower))
        );
        responseData = processRestaurantsWithLocation(matches, req.query.lat, req.query.lon, true);
      } else {
        responseData = processRestaurantsWithLocation(localData, req.query.lat, req.query.lon, false);
      }
      console.log(`[Fallback] ✅ ${responseData.length} quán từ restaurants-data.js sau khi lọc khoảng cách`);
      return res.json({ source: 'local', data: stripMenus(responseData), total: responseData.length });
    }
  } catch (evalErr) {
    console.error('[Fallback] Lỗi đọc restaurants-data.js:', evalErr.message);
  }

  res.json({ source: 'emergency', data: [], total: 0 });
});

// Global scrape queue — prevents unbounded Chromium launches from customer traffic
const MENU_SCRAPE_CONCURRENCY = 2;
const menuScrapeQueue = [];
const menuScrapeQueuedIds = new Set();
let menuScrapeActive = 0;

function enqueueMenuScrape(restaurant) {
  if (!MENU_SCRAPE_ENABLED) {
    console.log(`[Scrape Queue] ⏭️ Skip "${restaurant?.name || '?'}" — scrape disabled on this host (ENABLE_MENU_SCRAPE=true to enable)`);
    return;
  }
  if (!restaurant || !restaurant.id) return;
  const id = String(restaurant.id);
  if (restaurant._isScraping || menuScrapeQueuedIds.has(id)) return;
  menuScrapeQueuedIds.add(id);
  menuScrapeQueue.push(restaurant);
  console.log(`[Scrape Queue] ➕ Enqueued "${restaurant.name}" (queue=${menuScrapeQueue.length}, active=${menuScrapeActive})`);
  pumpMenuScrapeQueue();
}

function pumpMenuScrapeQueue() {
  while (menuScrapeActive < MENU_SCRAPE_CONCURRENCY && menuScrapeQueue.length > 0) {
    const restaurant = menuScrapeQueue.shift();
    if (!restaurant || !restaurant.id) continue;
    const id = String(restaurant.id);
    menuScrapeQueuedIds.delete(id);
    menuScrapeActive++;
    Promise.resolve()
      .then(() => triggerBackgroundMenuScrape(restaurant))
      .catch(err => {
        console.error(`[Scrape Queue] Lỗi scrape "${restaurant.name}":`, err.message);
      })
      .finally(() => {
        menuScrapeActive = Math.max(0, menuScrapeActive - 1);
        pumpMenuScrapeQueue();
      });
  }
}

function triggerBackgroundMenuScrape(restaurant) {
  if (!restaurant || !restaurant.id) return Promise.resolve();
  if (restaurant._isScraping) return Promise.resolve();
  restaurant._isScraping = true;

  let slug = restaurant.shopeefoodSlug || restaurant.id.replace('r_ct_', '').split('?')[0].replace(/_/g, '-');
  
  console.log(`[Background Scraper] ⏳ Đang phân giải slug thực tế chạy ngầm cho: "${restaurant.name}"...`);

  const resolvePromise = restaurant.shopeefoodSlug
    ? Promise.resolve(restaurant.shopeefoodSlug)
    : getShopeeFoodSlugFromFoody(slug);

  return resolvePromise.then(resolvedSlug => {
    let finalSlug = resolvedSlug;
    if (SLUG_REWRITER_MAP[finalSlug]) {
      console.log(`[Slug Rewriter] 🔄 Chuyển hướng slug chi nhánh thực tế: "${finalSlug}" → "${SLUG_REWRITER_MAP[finalSlug]}"`);
      finalSlug = SLUG_REWRITER_MAP[finalSlug];
    }
    
    console.log(`[Background Scraper] ⏳ Đang cào menu thực tế chạy ngầm cho: "${restaurant.name}" (${finalSlug})...`);
    return menuScraper.scrapeMenu(finalSlug);
  }).then(realMenu => {
    restaurant._isScraping = false;

    let isClosed = false;
    let closedReason = '';
    let menu = null;

    if (realMenu && realMenu.blocked === true) {
      console.log(`[Background Scraper] ⏳ API bị chặn (quán vẫn tồn tại): "${restaurant.name}" — thử lại sau.`);
      return;
    }

    if (realMenu && realMenu.closed === true) {
      isClosed = true;
      closedReason = realMenu.reason || 'Quán hiện đang đóng cửa ngoài giờ phục vụ.';
      if (Array.isArray(realMenu.menu) && realMenu.menu.length > 0) {
        menu = realMenu.menu;
      }
    } else if (Array.isArray(realMenu) && realMenu.length > 0) {
      isClosed = false;
      menu = realMenu;
    }

    if (isClosed) {
      console.log(`[Background Scraper] 🔴 Xác nhận quán ĐÓNG CỬA: "${restaurant.name}" (${closedReason})`);

      if (restaurant.isClosed !== true) {
        notifyCrmAndTelegram('status_change', restaurant.id, restaurant.name, 'Quán đóng cửa', `Cửa hàng đã tạm đóng cửa hoặc ngưng hợp tác trên ShopeeFood (Lý do: ${closedReason})`);
      }

      // Quán đóng cửa tạm thời
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(7, 0, 0, 0);

      restaurant.isClosed = true;
      restaurant.closedAt = new Date().toISOString();
      restaurant.closedReason = closedReason;
      restaurant.crawlNextAttempt = tomorrow.toISOString();

      if (menu) {
        writeRestaurantMenu(restaurant.id, menu);
        restaurant.menu = menu;
        restaurant.hasRealMenu = true;
        restaurant.menuUpdatedAt = new Date().toISOString();
        delete restaurant.menuTemplateFallback;
        console.log(`[Background Scraper] ⚡ Cập nhật menu thực tế thành công cho quán ĐÓNG CỬA TẠM THỜI: "${restaurant.name}" (${menu.length} món)`);
      }

      SEARCHED_RESTAURANTS_CACHE.set(restaurant.id, restaurant);

      updateLocalDatabase((localData) => {
        const idx = localData.findIndex(r => String(r.id) === String(restaurant.id));
        if (idx !== -1) {
          localData[idx].isClosed = true;
          localData[idx].closedAt = restaurant.closedAt;
          localData[idx].closedReason = restaurant.closedReason;
          localData[idx].crawlNextAttempt = restaurant.crawlNextAttempt;
          if (menu) {
            localData[idx].hasRealMenu = true;
            localData[idx].menuUpdatedAt = restaurant.menuUpdatedAt;
            localData[idx].dishNames = menu.map(m => m.name).filter(Boolean);
            delete localData[idx].menuTemplateFallback;
            delete localData[idx].menu;
          }
          return true;
        } else {
          const toSave = { ...restaurant };
          delete toSave._isScraping;
          if (toSave.menu) {
            toSave.dishNames = toSave.menu.map(m => m.name).filter(Boolean);
            delete toSave.menu;
          }
          localData.push(toSave);
          return true;
        }
      }).then(() => {
        console.log(`[Background Scraper] 💾 Đã lưu trạng thái đóng cửa tạm thời cho "${restaurant.name}"`);
      }).catch(err => {
        console.error('[Background Scraper] Lỗi khi ghi đè cập nhật restaurants-local.json:', err.message);
      });

    } else if (menu) {
      const oldMenu = readRestaurantMenu(restaurant.id) || [];
      const oldClosedVal = restaurant.isClosed;

      writeRestaurantMenu(restaurant.id, menu);
      restaurant.menu = menu;
      restaurant.hasRealMenu = true;
      restaurant.menuUpdatedAt = new Date().toISOString();
      if (restaurant.isClosed) {
        console.log(`[Background Scraper] 🟢 Xóa trạng thái đóng cửa SAI cho: "${restaurant.name}" - quán có menu thực tế!`);
        restaurant.isClosed = false;
        delete restaurant.closedAt;
        delete restaurant.closedReason;
      }
      delete restaurant.menuTemplateFallback;
      console.log(`[Background Scraper] ⚡ Cập nhật menu thực tế thành công cho: "${restaurant.name}" (${menu.length} món)`);

      if (oldClosedVal === true) {
        notifyCrmAndTelegram('status_change', restaurant.id, restaurant.name, 'Quán hoạt động trở lại', 'Cửa hàng đã hoạt động trở lại trên ShopeeFood.');
      }

      diffAndLogMenuChanges(restaurant, oldMenu, menu);

      SEARCHED_RESTAURANTS_CACHE.set(restaurant.id, restaurant);

      updateLocalDatabase((localData) => {
        const idx = localData.findIndex(r => String(r.id) === String(restaurant.id));
        if (idx !== -1) {
          localData[idx].hasRealMenu = true;
          localData[idx].menuUpdatedAt = restaurant.menuUpdatedAt;
          localData[idx].dishNames = menu.map(m => m.name).filter(Boolean);
          if (localData[idx].isClosed) {
            localData[idx].isClosed = false;
            delete localData[idx].closedAt;
            delete localData[idx].closedReason;
          }
          delete localData[idx].menuTemplateFallback;
          delete localData[idx].menu;
          return true;
        } else {
          const toSave = { ...restaurant };
          delete toSave._isScraping;
          if (toSave.menu) {
            toSave.dishNames = toSave.menu.map(m => m.name).filter(Boolean);
            delete toSave.menu;
          }
          localData.push(toSave);
          return true;
        }
      }).then(() => {
        console.log(`[Background Scraper] 💾 Đã lưu menu thực tế của "${restaurant.name}" vào database`);
      }).catch(err => {
        console.error('[Background Scraper] Lỗi khi ghi đè cập nhật restaurants-local.json:', err.message);
      });

    } else {
      // Technical scrape failure — do NOT overwrite disk with fabricated template menus
      console.warn(`[Background Scraper] ⚠️ Lỗi kỹ thuật khi cào "${restaurant.name}". Giữ nguyên menu hiện có (không ghi template).`);
      restaurant.menuStatus = 'unavailable';
      SEARCHED_RESTAURANTS_CACHE.set(restaurant.id, restaurant);
    }
  }).catch(err => {
    restaurant._isScraping = false;
    console.error(`[Background Scraper] Lỗi luồng cào ngầm cho "${restaurant.name}":`, err.message);
    restaurant.menuStatus = 'unavailable';
  });
}

function deriveRestaurantSlug(restaurant) {
  if (!restaurant) return '';
  if (restaurant.shopeefoodSlug) return String(restaurant.shopeefoodSlug).split('?')[0].trim();
  return String(restaurant.id || '')
    .replace('r_ct_', '')
    .split('?')[0]
    .replace(/_/g, '-');
}

async function resolveRestaurantSlugForSync(restaurant, options = {}) {
  let slug = deriveRestaurantSlug(restaurant);
  if (!restaurant.shopeefoodSlug && !options.skipFoody) {
    slug = await getShopeeFoodSlugFromFoody(slug);
  }
  if (SLUG_REWRITER_MAP[slug]) {
    slug = SLUG_REWRITER_MAP[slug];
  }
  return slug;
}

async function applySyncScrapeResult(restaurant, realMenu) {
  let isClosed = false;
  let closedReason = '';
  let menu = null;

  if (realMenu && realMenu.blocked === true) {
    console.log(`[Sync Scraper] ⏳ API bị chặn (quán vẫn tồn tại): "${restaurant.name}" — thử lại sau.`);
    return { restaurant, outcome: 'blocked', reason: realMenu.reason || 'ShopeeFood chặn API menu (403/429).' };
  }

  if (realMenu && realMenu.closed === true) {
    isClosed = true;
    closedReason = realMenu.reason || 'Quán hiện đang đóng cửa ngoài giờ phục vụ.';
    if (Array.isArray(realMenu.menu) && realMenu.menu.length > 0) {
      menu = realMenu.menu;
    }
  } else if (Array.isArray(realMenu) && realMenu.length > 0) {
    isClosed = false;
    menu = realMenu;
  }

  if (isClosed) {
    console.log(`[Sync Scraper] 🔴 Xác nhận quán ĐÓNG CỬA: "${restaurant.name}"`);
    if (restaurant.isClosed !== true) {
      notifyCrmAndTelegram('status_change', restaurant.id, restaurant.name, 'Quán đóng cửa', `Cửa hàng đã tạm đóng cửa hoặc ngưng hợp tác trên ShopeeFood (Lý do: ${closedReason})`);
    }

    restaurant.isClosed = true;
    restaurant.closedAt = new Date().toISOString();
    restaurant.closedReason = closedReason;

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(7, 0, 0, 0);
    restaurant.crawlNextAttempt = tomorrow.toISOString();

    if (menu) {
      writeRestaurantMenu(restaurant.id, menu);
      restaurant.menu = menu;
      restaurant.hasRealMenu = true;
      restaurant.menuUpdatedAt = new Date().toISOString();
      delete restaurant.menuTemplateFallback;
    }

    SEARCHED_RESTAURANTS_CACHE.set(restaurant.id, restaurant);
    await updateLocalDatabase((localData) => {
      const idx = localData.findIndex(r => String(r.id) === String(restaurant.id));
      if (idx !== -1) {
        localData[idx].isClosed = true;
        localData[idx].closedAt = restaurant.closedAt;
        localData[idx].closedReason = restaurant.closedReason;
        localData[idx].crawlNextAttempt = restaurant.crawlNextAttempt;
        if (menu) {
          localData[idx].hasRealMenu = true;
          localData[idx].menuUpdatedAt = restaurant.menuUpdatedAt;
          localData[idx].dishNames = menu.map(m => m.name).filter(Boolean);
          delete localData[idx].menuTemplateFallback;
        }
        return true;
      }
      return false;
    });
    return { restaurant, outcome: menu ? 'closed_with_menu' : 'closed' };
  }

  if (menu) {
    const oldMenu = readRestaurantMenu(restaurant.id) || [];
    const oldClosedVal = restaurant.isClosed;

    writeRestaurantMenu(restaurant.id, menu);
    restaurant.menu = menu;
    restaurant.hasRealMenu = true;
    restaurant.menuUpdatedAt = new Date().toISOString();
    restaurant.isClosed = false;
    delete restaurant.closedAt;
    delete restaurant.closedReason;
    delete restaurant.menuTemplateFallback;

    console.log(`[Sync Scraper] ⚡ Cập nhật menu thực tế thành công cho: "${restaurant.name}" (${menu.length} món)`);

    if (oldClosedVal === true) {
      notifyCrmAndTelegram('status_change', restaurant.id, restaurant.name, 'Quán hoạt động trở lại', 'Cửa hàng đã hoạt động trở lại trên ShopeeFood.');
    }

    diffAndLogMenuChanges(restaurant, oldMenu, menu);

    SEARCHED_RESTAURANTS_CACHE.set(restaurant.id, restaurant);

    await updateLocalDatabase((localData) => {
      const idx = localData.findIndex(r => String(r.id) === String(restaurant.id));
      if (idx !== -1) {
        localData[idx].hasRealMenu = true;
        localData[idx].menuUpdatedAt = restaurant.menuUpdatedAt;
        localData[idx].dishNames = menu.map(m => m.name).filter(Boolean);
        localData[idx].isClosed = false;
        delete localData[idx].closedAt;
        delete localData[idx].closedReason;
        delete localData[idx].menuTemplateFallback;
        return true;
      }
      return false;
    });
    return { restaurant, outcome: 'synced' };
  }

  console.warn(`[Sync Scraper] ⚠️ Lỗi khi cào "${restaurant.name}". Không ghi menu template giả.`);
  restaurant.menuStatus = 'unavailable';
  SEARCHED_RESTAURANTS_CACHE.set(restaurant.id, restaurant);
  return { restaurant, outcome: 'failed' };
}

function isSyncMenuEmpty(realMenu) {
  if (!realMenu) return true;
  if (realMenu.blocked === true || realMenu.closed === true) return false;
  return Array.isArray(realMenu) && realMenu.length === 0;
}

function buildScrapeMenuOptions(restaurant, scrapeOptions = {}) {
  return {
    ...scrapeOptions,
    name: restaurant.name,
    address: restaurant.address
  };
}

async function scrapeRestaurantForSync(restaurant, scrapeOptions = {}) {
  const fresh = findRestaurantById(restaurant.id) || restaurant;
  if (!fresh || !fresh.id) return { restaurant: fresh, outcome: 'failed' };

  const { isGenericBrandPortal } = require('./slugMap');
  if (fresh.isBrandPortal || isGenericBrandPortal(fresh.name, fresh.address)) {
    console.log(`[Sync Scraper] ⏭️ Bỏ qua portal thương hiệu: "${fresh.name}"`);
    return { restaurant: fresh, outcome: 'brand_portal' };
  }

  const skipFoody = scrapeOptions.skipFoody !== false;
  let finalSlug = await resolveRestaurantSlugForSync(fresh, { skipFoody });
  let realMenu = await menuScraper.scrapeMenu(finalSlug, buildScrapeMenuOptions(fresh, scrapeOptions));

  let menuEmpty = isSyncMenuEmpty(realMenu);

  if (menuEmpty && skipFoody && !fresh.shopeefoodSlug) {
    console.log(`[Sync Scraper] 🔁 Thử lại với Foody slug: "${fresh.name}"`);
    finalSlug = await resolveRestaurantSlugForSync(fresh, { skipFoody: false });
    realMenu = await menuScraper.scrapeMenu(finalSlug, buildScrapeMenuOptions(fresh, { ...scrapeOptions, skipFoody: false }));
    menuEmpty = isSyncMenuEmpty(realMenu);
  }

  // Retry chế độ đầy đủ chỉ dùng cho đồng bộ ĐƠN LẺ (không có shared browser).
  // Trong bulk (shared browser) bỏ qua để tránh treo — reload non-fast rất chậm trên Render.
  if (menuEmpty && scrapeOptions.fast === true && !scrapeOptions.browser) {
    console.log(`[Sync Scraper] 🔁 Retry chế độ đầy đủ: "${fresh.name}"`);
    finalSlug = await resolveRestaurantSlugForSync(fresh, { skipFoody: false });
    realMenu = await menuScraper.scrapeMenu(finalSlug, buildScrapeMenuOptions(fresh, {
      ...scrapeOptions,
      fast: false,
      skipFoody: false
    }));
    menuEmpty = isSyncMenuEmpty(realMenu);
  }

  // Quán đóng cửa nhưng còn menu local → giữ menu (thành công), không đánh lỗi.
  if (menuEmpty && fresh.isClosed === true && restaurantHasMenuMeta(fresh)) {
    const localMenu = readRestaurantMenu(fresh.id);
    if (Array.isArray(localMenu) && localMenu.length > 0) {
      console.log(`[Sync Scraper] 📦 Giữ menu local cho quán đóng cửa: "${fresh.name}"`);
      return applySyncScrapeResult(fresh, {
        closed: true,
        reason: fresh.closedReason || 'Quán hiện đang đóng cửa ngoài giờ phục vụ.',
        menu: localMenu
      });
    }
  }

  // Rỗng KHÔNG kết luận (không phải closed/notFound rõ ràng) = bị chặn / timing.
  // KHÔNG đánh 'failed' để tránh xóa menu cũ và báo lỗi giả — coi là 'blocked' để thử lại sau.
  if (menuEmpty) {
    console.log(`[Sync Scraper] ⏳ Không lấy được menu (không kết luận) — coi là blocked để thử lại: "${fresh.name}"`);
    return { restaurant: fresh, outcome: 'blocked', reason: 'Trang tải nhưng không bắt được API menu (nghi bị chặn/timeout).' };
  }

  return applySyncScrapeResult(fresh, realMenu);
}

function triggerSyncMenuScrape(restaurant) {
  if (!MENU_SCRAPE_ENABLED) {
    console.log(`[Sync Scraper] ⏭️ Skip "${restaurant?.name || '?'}" — scrape disabled (ENABLE_MENU_SCRAPE=true to enable)`);
    return Promise.resolve(null);
  }
  if (!restaurant || !restaurant.id) return Promise.resolve(null);
  if (restaurant._isScraping) return Promise.resolve(null);

  restaurant._isScraping = true;
  console.log(`[Sync Scraper] ⏳ Đang cào menu thực tế đồng bộ cho: "${restaurant.name}"...`);

  return scrapeRestaurantForSync(restaurant, { skipFoody: false })
    .then(({ restaurant: updated, outcome }) => {
      restaurant._isScraping = false;
      if (outcome === 'blocked') return null;
      return updated;
    })
    .catch(err => {
      restaurant._isScraping = false;
      console.error(`[Sync Scraper] Lỗi luồng cào đồng bộ cho "${restaurant.name}":`, err.message);
      restaurant.menuStatus = 'unavailable';
      return restaurant;
    });
}

function findRestaurantById(id) {
  const sid = String(id);
  if (SEARCHED_RESTAURANTS_CACHE.has(sid)) {
    return SEARCHED_RESTAURANTS_CACHE.get(sid);
  }
  const localData = dbHelper.read();
  return localData.find(r => String(r.id) === sid) || null;
}

function getRestaurantChangeSummaries(limit = 50, windowMs = RECENT_CHANGE_WINDOW_MS) {
  const cutoff = windowMs > 0 ? Date.now() - windowMs : 0;
  const notifs = readNotifications().filter(n =>
    n && (n.type === 'price_change' || n.type === 'status_change') && n.restaurantId
    && (!cutoff || (n.createdAt || 0) >= cutoff)
  );
  const byRestaurant = new Map();
  for (const n of notifs) {
    const key = String(n.restaurantId);
    if (!byRestaurant.has(key)) {
      byRestaurant.set(key, {
        restaurantId: n.restaurantId,
        restaurantName: n.restaurantName || key,
        type: n.type,
        title: n.title || '',
        message: n.message || '',
        createdAt: n.createdAt,
        read: n.read === true,
        unreadCount: 0
      });
    }
    const entry = byRestaurant.get(key);
    if (n.read !== true) entry.unreadCount++;
    if (n.createdAt > entry.createdAt) {
      entry.type = n.type;
      entry.title = n.title || entry.title;
      entry.message = n.message || entry.message;
      entry.createdAt = n.createdAt;
      entry.read = n.read === true && entry.unreadCount === 0;
    }
  }
  return Array.from(byRestaurant.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

function inferRestaurantCategory(r) {
  if (r?.category && String(r.category).trim()) return String(r.category).trim();
  if (Array.isArray(r?.tags) && r.tags.length) {
    return r.tags.filter(Boolean).slice(0, 2).join(', ');
  }
  return '';
}

function restaurantHasMenuMeta(r) {
  if (!r) return false;
  if (r.hasRealMenu === true) return true;
  if (Array.isArray(r.dishNames) && r.dishNames.length > 0) return true;
  return false;
}

function recomputeAdminRestaurantStats(source) {
  const rows = Array.isArray(source) ? source.filter(r => r && r.id) : [];
  adminRestaurantStats = {
    total: rows.length,
    open: rows.filter(r => !r.isClosed).length,
    closed: rows.filter(r => !!r.isClosed).length,
    withMenu: rows.filter(r => restaurantHasMenuMeta(r)).length
  };
}

function getCachedRestaurantChangeIds() {
  const now = Date.now();
  if (adminChangedCache.at && (now - adminChangedCache.at) < ADMIN_CHANGED_CACHE_TTL_MS) {
    return adminChangedCache;
  }
  const summaries = getRestaurantChangeSummaries(500);
  adminChangedCache = {
    at: now,
    ids: new Set(summaries.map(c => String(c.restaurantId))),
    count: summaries.length
  };
  return adminChangedCache;
}

function invalidateAdminChangedCache() {
  adminChangedCache = { at: 0, ids: new Set(), count: 0 };
}

function enrichAdminRestaurantRow(r) {
  if (!r || !r.id) return null;

  const dishCount = Array.isArray(r.dishNames) ? r.dishNames.length : 0;
  const hasRealMenu = restaurantHasMenuMeta(r);

  return {
    id: r.id,
    name: r.name || '',
    category: inferRestaurantCategory(r),
    address: r.address || '',
    phone: r.phone || '',
    img: r.img || '',
    isClosed: !!r.isClosed,
    closedAt: r.closedAt || null,
    closedReason: r.closedReason || null,
    hasRealMenu,
    menuItemCount: dishCount,
    menuUpdatedAt: r.menuUpdatedAt || null,
    menuTemplateFallback: hasRealMenu ? false : r.menuTemplateFallback === true,
    shopeefoodSlug: r.shopeefoodSlug || null,
    rating: r.rating,
    updatedAt: r.updatedAt || null
  };
}

function getAdminRestaurantsList(options = {}) {
  const page = Math.max(1, parseInt(options.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(options.limit, 10) || 50));
  const q = String(options.q || '').trim().toLowerCase();
  const tab = options.tab || 'all';
  const filterName = String(options.filterName || '').trim().toLowerCase();
  const filterCategory = String(options.filterCategory || '').trim().toLowerCase();
  const filterStatus = options.filterStatus || '';
  const filterMenu = options.filterMenu || '';

  const source = cachedRestaurants.length > 0 ? cachedRestaurants : dbHelper.read();
  if (adminRestaurantStats.total !== source.length) {
    recomputeAdminRestaurantStats(source);
  }

  const changedCache = getCachedRestaurantChangeIds();
  const changedIds = changedCache.ids;

  let rows = source.filter(r => r && r.id);

  if (q) {
    rows = rows.filter(r => {
      const haystack = [
        r.name,
        r.address,
        r.category,
        r.id,
        inferRestaurantCategory(r)
      ].map(v => String(v || '').toLowerCase()).join(' ');
      return haystack.includes(q);
    });
  }

  if (tab === 'open') rows = rows.filter(r => !r.isClosed);
  else if (tab === 'closed') rows = rows.filter(r => !!r.isClosed);
  else if (tab === 'changed') rows = rows.filter(r => changedIds.has(String(r.id)));

  if (filterName) {
    rows = rows.filter(r =>
      (r.name || '').toLowerCase().includes(filterName) ||
      (r.address || '').toLowerCase().includes(filterName)
    );
  }
  if (filterCategory) {
    rows = rows.filter(r => inferRestaurantCategory(r).toLowerCase().includes(filterCategory));
  }
  if (filterStatus === 'open') rows = rows.filter(r => !r.isClosed);
  else if (filterStatus === 'closed') rows = rows.filter(r => !!r.isClosed);
  if (filterMenu === 'yes') {
    rows = rows.filter(r => restaurantHasMenuMeta(r));
  } else if (filterMenu === 'no') {
    rows = rows.filter(r => !restaurantHasMenuMeta(r));
  }

  rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'vi'));

  const total = rows.length;
  const start = (page - 1) * limit;
  const pageRows = rows.slice(start, start + limit);
  const data = pageRows.map(enrichAdminRestaurantRow).filter(Boolean);

  return {
    data,
    total,
    page,
    limit,
    hasMore: start + pageRows.length < total,
    stats: {
      total: adminRestaurantStats.total,
      open: adminRestaurantStats.open,
      closed: adminRestaurantStats.closed,
      changed: changedCache.count,
      withMenu: adminRestaurantStats.withMenu
    }
  };
}

const BULK_SYNC_CONCURRENCY = Math.max(1, Math.min(5, parseInt(process.env.BULK_SYNC_CONCURRENCY || '2', 10) || 2));
let bulkSyncJob = null;

function isBulkSyncSuccessOutcome(outcome) {
  return outcome === 'synced' || outcome === 'closed' || outcome === 'closed_with_menu';
}

async function runBulkRestaurantSync(restaurants, startIdx = 0) {
  const isResume = startIdx > 0 && bulkSyncJob && bulkSyncJob.restaurants;

  if (!isResume) {
    bulkSyncJob = {
      running: true,
      paused: false,
      pauseRequested: false,
      total: restaurants.length,
      completed: 0,
      synced: 0,
      failed: 0,
      skipped: 0,
      current: null,
      active: [],
      startedAt: Date.now(),
      finishedAt: null,
      pausedAt: null,
      errors: [],
      skips: [],
      fatalError: null,
      restaurants
    };
  } else {
    bulkSyncJob.running = true;
    bulkSyncJob.paused = false;
    bulkSyncJob.pauseRequested = false;
    bulkSyncJob.pausedAt = null;
    bulkSyncJob.finishedAt = null;
    bulkSyncJob.fatalError = null;
    bulkSyncJob.active = bulkSyncJob.active || [];
  }

  let sharedBrowser = null;
  try {
    console.log(`[Bulk Sync] 🚀 Bắt đầu (${restaurants.length} quán, concurrency=${BULK_SYNC_CONCURRENCY}, shared browser)`);
    sharedBrowser = await menuScraper.launchBrowser();

    let cursor = startIdx;
    async function worker() {
      while (!bulkSyncJob.pauseRequested) {
        const idx = cursor++;
        if (idx >= bulkSyncJob.total) break;
        const restaurant = restaurants[idx];
        if (!restaurant || !restaurant.id) {
          bulkSyncJob.completed++;
          continue;
        }

        const activeEntry = { id: restaurant.id, name: restaurant.name || restaurant.id, index: idx + 1 };
        bulkSyncJob.current = activeEntry;
        bulkSyncJob.active = [...(bulkSyncJob.active || []).filter(a => a.id !== activeEntry.id), activeEntry];

        try {
          const { outcome, reason } = await scrapeRestaurantForSync(restaurant, {
            browser: sharedBrowser,
            fast: true,
            skipFoody: true
          });
          if (isBulkSyncSuccessOutcome(outcome)) {
            bulkSyncJob.synced++;
          } else if (outcome === 'blocked' || outcome === 'brand_portal') {
            bulkSyncJob.skipped++;
            bulkSyncJob.skips = bulkSyncJob.skips || [];
            bulkSyncJob.skips.push({
              id: restaurant.id,
              name: restaurant.name || restaurant.id,
              reason: reason || (outcome === 'brand_portal' ? 'Portal thương hiệu — đồng bộ từng chi nhánh' : 'Chưa lấy được menu')
            });
          } else {
            bulkSyncJob.failed++;
            bulkSyncJob.errors.push({
              id: restaurant.id,
              name: restaurant.name || restaurant.id,
              error: outcome === 'failed' ? 'Không lấy được menu' : String(outcome)
            });
          }
        } catch (err) {
          bulkSyncJob.failed++;
          bulkSyncJob.errors.push({
            id: restaurant.id,
            name: restaurant.name || restaurant.id,
            error: err.message || 'Lỗi đồng bộ'
          });
        }

        bulkSyncJob.completed++;
        bulkSyncJob.active = (bulkSyncJob.active || []).filter(a => a.id !== activeEntry.id);
        if (bulkSyncJob.active.length > 0) {
          bulkSyncJob.current = bulkSyncJob.active[bulkSyncJob.active.length - 1];
        } else {
          bulkSyncJob.current = null;
        }
      }
    }

    const workers = Array.from(
      { length: Math.min(BULK_SYNC_CONCURRENCY, Math.max(1, bulkSyncJob.total - startIdx)) },
      () => worker()
    );
    await Promise.all(workers);
  } catch (err) {
    bulkSyncJob.fatalError = err.message || 'Không khởi động được trình duyệt đồng bộ trên server.';
    console.error('[Bulk Sync] ❌ Lỗi nghiêm trọng:', err.message);
  } finally {
    await menuScraper.closeBrowserSafe(sharedBrowser);
  }

  bulkSyncJob.current = null;
  bulkSyncJob.active = [];

  if (bulkSyncJob.pauseRequested && bulkSyncJob.completed < bulkSyncJob.total) {
    bulkSyncJob.running = false;
    bulkSyncJob.paused = true;
    bulkSyncJob.pausedAt = Date.now();
    bulkSyncJob.remaining = bulkSyncJob.total - bulkSyncJob.completed;
    console.log(`[Bulk Sync] ⏸ Tạm dừng tại ${bulkSyncJob.completed}/${bulkSyncJob.total} (synced ${bulkSyncJob.synced})`);
    return;
  }

  bulkSyncJob.running = false;
  bulkSyncJob.paused = false;
  bulkSyncJob.finishedAt = Date.now();
  bulkSyncJob.remaining = 0;
  recomputeAdminRestaurantStats(cachedRestaurants);
  invalidateAdminChangedCache();
  console.log(`[Bulk Sync] Hoàn tất: ${bulkSyncJob.synced}/${bulkSyncJob.total} synced, ${bulkSyncJob.completed} processed, lỗi ${bulkSyncJob.failed}`);
}

/**
 * GET /api/restaurants/:id
 * Thông tin chi tiết + menu của 1 quán
 */
app.get('/api/restaurants/:id', async (req, res) => {
  const id = String(req.params.id);
  console.log(`[Details] Yêu cầu chi tiết quán ăn ID: "${id}"`);

  let found = null;
  let source = '';

  // 1. Kiểm tra trong bộ nhớ tạm SEARCHED_RESTAURANTS_CACHE trước tiên
  if (SEARCHED_RESTAURANTS_CACHE.has(id)) {
    console.log(`[Details] ✅ Tìm thấy quán trong SEARCHED_RESTAURANTS_CACHE: ${id}`);
    found = SEARCHED_RESTAURANTS_CACHE.get(id);
    source = 'search_cache';
  }

  // 2. Kiểm tra trong in-memory cache (thay vì đọc file 7MB)
  if (!found) {
    const matched = cachedRestaurants.find(r => String(r.id) === id);
    if (matched) {
      console.log(`[Details] ✅ Tìm thấy quán trong memory cache: ${id}`);
      found = matched;
      source = 'memory_cache';
    }
  }

  // 3. Kiểm tra trong cache mặc định (readCache())
  if (!found) {
    const cached = readCache();
    if (cached) {
      const matched = cached.find(r => String(r.id) === id);
      if (matched) {
        console.log(`[Details] ✅ Tìm thấy quán trong readCache(): ${id}`);
        found = matched;
        source = 'cache';
      }
    }
  }

  // 4. Kiểm tra trong restaurants-data.js mẫu
  if (!found) {
    try {
      const rawJs = fs.readFileSync(FALLBACK_FILE, 'utf8');
      const sandboxFn = new Function('module', 'exports', rawJs + '\n return RESTAURANTS;');
      const localData = sandboxFn({}, {});
      if (Array.isArray(localData)) {
        const matched = localData.find(r => String(r.id) === id);
        if (matched) {
          console.log(`[Details] ✅ Tìm thấy quán trong restaurants-data.js: ${id}`);
          found = matched;
          source = 'fallback_file';
        }
      }
    } catch (err) {
      console.error('[Details] Lỗi khi đọc restaurants-data.js:', err.message);
    }
  }

  if (found) {
    const responseRestaurant = { ...found };

    if (resetClosedIfNextAttemptReached(responseRestaurant)) {
      await updateLocalDatabase((localData) => {
        const idx = localData.findIndex(r => String(r.id) === String(responseRestaurant.id));
        if (idx !== -1) {
          localData[idx].isClosed = false;
          delete localData[idx].closedAt;
          delete localData[idx].closedReason;
          delete localData[idx].crawlNextAttempt;
          return true;
        }
        return false;
      });
      responseRestaurant.isClosed = false;
      delete responseRestaurant.closedAt;
      delete responseRestaurant.closedReason;
      delete responseRestaurant.crawlNextAttempt;
      SEARCHED_RESTAURANTS_CACHE.set(responseRestaurant.id, responseRestaurant);
    }

    const originallyHadRealMenu = found.hasRealMenu === true;

    // Tải menu từ tệp riêng nếu chưa có — ưu tiên Supabase hydrate trước scrape
    if (!responseRestaurant.menu || responseRestaurant.menu.length === 0) {
      const fileMenu = readRestaurantMenu(responseRestaurant.id);
      if (fileMenu && fileMenu.length > 0) {
        const q = analyzeMenuQuality(fileMenu);
        if (q.isTemplate) {
          // Template file must not be treated as real
          console.log(`[Details] ⚠️ Menu file của "${responseRestaurant.name}" là template (${q.reason}) — không đánh dấu real.`);
          responseRestaurant.menu = fileMenu;
          applyMenuFlags(responseRestaurant, fileMenu);
          responseRestaurant.menuStatus = 'fallback';
          if (found) applyMenuFlags(found, fileMenu);
        } else {
          responseRestaurant.menu = fileMenu;
          applyMenuFlags(responseRestaurant, fileMenu);
          responseRestaurant.menuStatus = q.isReal ? 'ready' : 'fallback';
          if (found && q.isReal) applyMenuFlags(found, fileMenu);
        }
      } else {
        // Fast path: restore this one restaurant from Supabase (deploy loses menus/)
        const hydrated = await hydrateOneMenuFromSupabase(responseRestaurant.id);
        if (hydrated && hydrated.length > 0) {
          responseRestaurant.menu = hydrated;
          applyMenuFlags(responseRestaurant, hydrated);
          responseRestaurant.menuStatus = 'ready';
          source = source + '+supabase_menu';
        } else {
          console.log(`[Details] ℹ️ Quán "${responseRestaurant.name}" chưa có menu local/Supabase thật.`);
          responseRestaurant.menu = [];
          // Keep honest flags — do not claim real without a real menu payload
          if (!originallyHadRealMenu) {
            responseRestaurant.hasRealMenu = false;
            responseRestaurant.menuTemplateFallback = true;
          }
          responseRestaurant.menuStatus = responseRestaurant.isClosed ? 'unavailable' : 'loading';
        }
      }
    } else {
      // Menu already embedded — still classify so template payloads cannot look "real"
      applyMenuFlags(responseRestaurant, responseRestaurant.menu);
    }

    // Phát hiện và tự động cập nhật nếu là menu thực tế kiểu cũ (chưa có options)
    let isLegacyMenu = false;
    if (responseRestaurant.hasRealMenu && responseRestaurant.menu && responseRestaurant.menu.length > 0) {
      const hasAnyOptionsField = responseRestaurant.menu.some(m => m.options !== undefined);
      if (!hasAnyOptionsField) {
        isLegacyMenu = true;
      }
    }

    // Chỉ scrape khi thật sự cần: chưa có menu sau hydrate, hoặc legacy, hoặc forceSync
    // Không scrape nếu đã có menu sẵn sàng (tránh Puppeteer làm Render 502)
    const forceSync = req.query.forceSync === 'true';
    const missingMenu = !responseRestaurant.menu || responseRestaurant.menu.length === 0;
    const needsScrape = ((!responseRestaurant.isClosed && (missingMenu || isLegacyMenu)) || forceSync);
    if (needsScrape) {
      if (isLegacyMenu) {
        console.log(`[Details] 🔄 Phát hiện menu cũ của "${responseRestaurant.name}" (chưa có options). Enqueue scrape...`);
      }
      found.menu = responseRestaurant.menu;
      found.hasRealMenu = responseRestaurant.hasRealMenu;
      
      if (req.query.syncScrape === 'true') {
        if (MENU_SCRAPE_ENABLED) {
          await triggerSyncMenuScrape(found);
          const updated = readRestaurantMenu(responseRestaurant.id);
          if (updated && updated.length > 0) {
            responseRestaurant.menu = updated;
            responseRestaurant.hasRealMenu = true;
            responseRestaurant.menuStatus = 'ready';
            delete responseRestaurant.menuTemplateFallback;
          }
        } else if (missingMenu) {
          responseRestaurant.menuStatus = 'unavailable';
        }
      } else if (MENU_SCRAPE_ENABLED) {
        enqueueMenuScrape(found);
        if (missingMenu) {
          responseRestaurant.menuStatus = 'loading';
        }
      } else if (missingMenu) {
        // Prefer Supabase-hydrated / local menus on Render — do not launch Chromium
        responseRestaurant.menuStatus = 'unavailable';
      }
    } else if (responseRestaurant.menu && responseRestaurant.menu.length > 0) {
      responseRestaurant.menuStatus = 'ready';
    }

    return res.json({ source, data: applyDistanceMarkupToMenu(responseRestaurant, req.query.lat, req.query.lon) });
  }

  console.log(`[Details] ❌ Không tìm thấy quán ăn với ID: "${id}"`);
  res.status(404).json({ error: 'Không tìm thấy quán ăn với ID được cung cấp' });
});

/**
 * POST /api/cache/clear
 * Xóa cache để force reload từ ShopeeFood
 */
app.post('/api/cache/clear', (req, res) => {
  try {
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
    console.log('[Cache] Đã xóa cache');
    res.json({ success: true, message: 'Cache đã được xóa. Lần sau load sẽ fetch từ ShopeeFood.' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ORDER DATABASE & API ENDPOINTS ──────────────────────────────────────────
let ordersQueuePromise = Promise.resolve();
const ORDERS_FILE_PATH = path.join(__dirname, 'orders-local.json');

function readOrdersDatabase() {
  try {
    if (!fs.existsSync(ORDERS_FILE_PATH)) {
      return [];
    }
    const raw = fs.readFileSync(ORDERS_FILE_PATH, 'utf8');
    return JSON.parse(raw) || [];
  } catch (e) {
    console.error('[Orders DB] Lỗi đọc database:', e.message);
    return [];
  }
}

function hydrateOrdersRestaurantCoords(orders) {
  if (Array.isArray(orders)) return orders.map(hydrateOrderRestaurantCoords);
  return hydrateOrderRestaurantCoords(orders);
}

function updateOrdersDatabase(updaterFn) {
  return new Promise((resolve, reject) => {
    ordersQueuePromise = ordersQueuePromise.then(() => {
      try {
        if (!fs.existsSync(ORDERS_FILE_PATH)) {
          fs.writeFileSync(ORDERS_FILE_PATH, '[]', 'utf8');
        }
        const raw = fs.readFileSync(ORDERS_FILE_PATH, 'utf8');
        let data = [];
        try {
          data = JSON.parse(raw);
        } catch (e) {
          console.error('[Orders DB Queue] Lỗi parse JSON:', e.message);
          data = [];
        }
        if (Array.isArray(data)) {
          const result = updaterFn(data);
          if (result !== false) {
            fs.writeFileSync(ORDERS_FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
          }
        }
        resolve();
      } catch (err) {
        console.error('[Orders DB Queue] Lỗi thực thi hàng đợi DB:', err.message);
        reject(err);
      }
    });
  });
}

/**
 * POST /api/orders
 * Khách hàng gửi đơn hàng lên server (lưu vào orders-local.json)
 */
app.post('/api/orders', async (req, res) => {
  try {
    const orderData = req.body;
    if (!orderData || typeof orderData !== 'object') {
      return res.status(400).json({ error: 'Đơn hàng không hợp lệ' });
    }

    const orderId = orderData.id || 'SPF-' + Math.floor(100000 + Math.random() * 900000);

    // Luôn ưu tiên địa chỉ + tọa độ exact từ DB quán đã cào
    const restMem = findRestaurantInCache(orderData.restaurantId);
    let restaurantAddress = (orderData.restaurantAddress || '').trim();
    let restaurantName = (orderData.restaurantName || '').trim();
    let restLat = orderData.restaurantLat;
    let restLon = orderData.restaurantLon;
    let restaurantCoordsExact = false;

    if (restMem) {
      if (restMem.address && String(restMem.address).trim()) {
        restaurantAddress = String(restMem.address).trim();
      }
      if (restMem.name && String(restMem.name).trim()) {
        restaurantName = String(restMem.name).trim();
      }
      if (
        restMem.coordsSource === 'exact' &&
        typeof restMem.latitude === 'number' &&
        typeof restMem.longitude === 'number'
      ) {
        restLat = restMem.latitude;
        restLon = restMem.longitude;
        restaurantCoordsExact = true;
        console.log(`[Order Server] Using EXACT crawl coords for ${orderData.restaurantId}: ${restLat}, ${restLon}`);
      }
    }

    // Chuẩn hóa số (client có thể gửi string)
    if (typeof restLat === 'string') restLat = parseFloat(restLat);
    if (typeof restLon === 'string') restLon = parseFloat(restLon);
    if (!Number.isFinite(restLat) || !Number.isFinite(restLon)) {
      if (
        restMem &&
        typeof restMem.latitude === 'number' &&
        typeof restMem.longitude === 'number'
      ) {
        restLat = restMem.latitude;
        restLon = restMem.longitude;
        restaurantCoordsExact = restMem.coordsSource === 'exact';
        console.log(`[Order Server] Fallback DB coords for restaurant ${orderData.restaurantId}: ${restLat}, ${restLon} (${restMem.coordsSource || 'unknown'})`);
      } else {
        const coords = geocodeAddress(restaurantAddress || '', restaurantName || '', orderData.restaurantId);
        restLat = coords.lat;
        restLon = coords.lon;
        restaurantCoordsExact = false;
        console.log(`[Order Server] Geocoded missing restaurant coordinates for "${restaurantName}": ${restLat}, ${restLon}`);
      }
    }

    const newOrder = {
      id: orderId,
      restaurantId: orderData.restaurantId || null,
      restaurantName: restaurantName || '',
      restaurantAddress: restaurantAddress || '',
      restaurantLat: restLat,
      restaurantLon: restLon,
      restaurantCoordsExact,
      items: Array.isArray(orderData.items) ? orderData.items.map(item => ({
        id: item.id,
        name: item.name,
        price: item.price,
        quantity: item.quantity || item.qty || 1,
        note: item.note || '',
        selectedOptions: item.selectedOptions || []
      })) : [],
      storeTotal: typeof orderData.storeTotal === 'number' ? orderData.storeTotal : 0,
      appTotal: typeof orderData.appTotal === 'number' ? orderData.appTotal : 0,
      shipperEarning: typeof orderData.shipperEarning === 'number' ? orderData.shipperEarning : 0,
      discountValue: typeof orderData.discountValue === 'number' ? orderData.discountValue : 0,
      minServiceFee: typeof orderData.minServiceFee === 'number' ? orderData.minServiceFee : 0,
      promoCode: null,
      promoDiscount: 0,
      status: 'PENDING',
      shipperId: null,
      shipperName: null,
      shipperPhone: null,
      shipperLat: null,
      shipperLon: null,
      deliveryAddress: orderData.deliveryAddress || '',
      deliveryName: orderData.deliveryName || '',
      deliveryPhone: orderData.deliveryPhone || '',
      ordererPhone: orderData.ordererPhone || '',
      pinnedLat: typeof orderData.pinnedLat === 'number' ? orderData.pinnedLat : null,
      pinnedLon: typeof orderData.pinnedLon === 'number' ? orderData.pinnedLon : null,
      isRelative: orderData.isRelative === true,
      note: orderData.note || '',
      createdAt: orderData.createdAt || Date.now(),
      acceptedAt: null,
      purchasedAt: null,
      deliveredAt: null,
      rating: null,
      comment: null,
      assignedShipperPhone: null,
      offerExpiresAt: null,
      declinedShippers: []
    };

    const blocked =
      crm.isBlacklisted(newOrder.deliveryPhone) ||
      crm.isBlacklisted(newOrder.ordererPhone);
    if (blocked) {
      return res.status(403).json({
        success: false,
        error: 'Số điện thoại bị hạn chế đặt hàng. Vui lòng liên hệ hỗ trợ.'
      });
    }

    const zoneCheck = crm.isInDeliveryZone(newOrder.pinnedLat, newOrder.pinnedLon);
    if (!zoneCheck.ok) {
      return res.status(400).json({ success: false, error: zoneCheck.error });
    }

    // Kiểm tra đơn hàng thứ 2+ của cùng một khách hàng để tự động giảm giá
    const orders = readOrdersDatabase();
    const cleanedOrdererPhone = newOrder.ordererPhone.trim().replace(/\s+/g, '');
    if (cleanedOrdererPhone) {
      const hasPreviousOrders = orders.some(o => 
        o.ordererPhone.trim().replace(/\s+/g, '') === cleanedOrdererPhone &&
        o.id !== newOrder.id
      );

      if (hasPreviousOrders && pricingConfig.secondOrderDiscountRate > 0) {
        const discountPercent = pricingConfig.secondOrderDiscountRate;
        const subtotal = newOrder.appTotal;
        const discountVal = round100(subtotal * discountPercent);
        newOrder.discountValue = discountVal;
        newOrder.appTotal = Math.max(0, subtotal - discountVal);
        console.log(`[Pricing Config] Khách hàng ${cleanedOrdererPhone} được áp dụng giảm giá đơn thứ 2+ (${discountPercent * 100}%): Giảm ${discountVal}đ. Tổng mới: ${newOrder.appTotal}đ`);
      }
    }

    if (orderData.promoCode) {
      const promoResult = crm.validatePromo(orderData.promoCode, newOrder.appTotal);
      if (!promoResult.valid) {
        return res.status(400).json({ success: false, error: promoResult.error });
      }
      newOrder.promoCode = promoResult.promo.code;
      newOrder.promoDiscount = promoResult.discount;
      newOrder.discountValue = (newOrder.discountValue || 0) + promoResult.discount;
      newOrder.appTotal = Math.max(0, newOrder.appTotal - promoResult.discount);
      newOrder.shipperEarning = Math.max(0, newOrder.appTotal - newOrder.storeTotal);
      crm.incrementPromoUse(promoResult.promo.code);
    }

    // Find nearest available shipper for targeted dispatch
    const nearest = findNearestAvailableShipper(newOrder.restaurantLat, newOrder.restaurantLon, [], newOrder);
    if (nearest) {
      if (nearest.isAssisted === true) {
        // TỰ ĐỘNG GÁN THẲNG VÀ NHẬN LUÔN (Không cần bấm chấp nhận)
        newOrder.status = 'ACCEPTED';
        newOrder.acceptedAt = Date.now();
        newOrder.shipperPhone = nearest.phone.trim().replace(/\s+/g, '');
        newOrder.shipperName = nearest.name;
        newOrder.shipperId = 'shipper-default';
        
        // Tìm ID thực tế của shipper và tắt cờ SOS
        const shippers = readShippersDatabase();
        const cleanP = nearest.phone.trim().replace(/\s+/g, '');
        const targetS = shippers.find(s => s.phone.trim().replace(/\s+/g, '') === cleanP);
        if (targetS) {
          newOrder.shipperId = targetS.id || 'shipper-default';
          targetS.assistanceRequested = false;
          writeShippersDatabase(shippers);
          console.log(`[SOS Auto-Accept] 🟢 Đã tự động gán và dọn cờ SOS cho shipper ${targetS.name}`);
          
          if (supabase && targetS.id) {
            supabase
              .from('shipper_profiles')
              .update({ assistance_requested: false })
              .eq('id', targetS.id)
              .catch(err => console.error('[Supabase Sync Error] Lỗi dọn cờ hỗ trợ:', err.message));
          }
        }
        console.log(`[SOS Dispatch] ⚡ Đơn ${newOrder.id} đã được TỰ ĐỘNG NHẬN cho tài xế SOS: ${nearest.name} (${nearest.phone})`);
      } else {
        assignOfferToShipper(newOrder, nearest);
        const mode = nearest.batchCompatible ? 'GHÉP ĐƠN' : 'ĐƠN LẺ';
        console.log(`[Dispatch] 🎯 Đơn ${newOrder.id} đề xuất ${mode} cho ${nearest.name} (${nearest.phone}), cách ${nearest.distance.toFixed(2)} km`);
      }
    } else {
      console.log(`[Dispatch] ⚠️ Không có tài xế khả dụng. Đơn ${newOrder.id} chờ đề xuất — không mở bể chung`);
    }

    await updateOrdersDatabase((orders) => {
      orders.push(newOrder);
    });

    console.log(`[Order Server] 📝 Đã lưu đơn hàng mới: ${newOrder.id}`);
    upsertOrderToSupabase(newOrder).catch(() => {});
    if (telegramBot) telegramBot.sendNewOrderNotification(newOrder).catch(e => console.error('Lỗi gửi Telegram đơn mới:', e.message));
    addNotification('order_new', newOrder.restaurantId, newOrder.restaurantName, 'Đơn mới chờ xử lý', `Đơn ${newOrder.id} — ${newOrder.restaurantName} (${(newOrder.appTotal || 0).toLocaleString('vi-VN')}đ)`);
    res.json({ success: true, data: newOrder });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Helper to enrich order objects with current shipper avatar URL dynamically
function enrichOrdersWithShipperAvatar(ordersOrOrder, req) {
  const shippers = readShippersDatabase();
  const enrichSingle = (o) => {
    if (!o) return o;
    const enriched = { ...o };
    if (enriched.shipperPhone) {
      const cleanPhone = enriched.shipperPhone.trim().replace(/\s+/g, '');
      const shipper = shippers.find(s => s.phone.trim().replace(/\s+/g, '') === cleanPhone);
      if (shipper) {
        enriched.shipperAvatarUrl = normalizeImageUrl(shipper.avatarUrl || '', req);
      }
    }
    return enriched;
  };

  if (Array.isArray(ordersOrOrder)) {
    return ordersOrOrder.map(enrichSingle);
  }
  return enrichSingle(ordersOrOrder);
}

/**
 * GET /api/orders
 * Shipper/Khách hàng lấy danh sách đơn hàng (hỗ trợ filter trạng thái ?status=PENDING)
 * Read-only: expire-offer chạy nền qua processExpiredOffers().
 */
app.get('/api/orders', async (req, res) => {
  try {
    const { status, shipperPhone } = req.query;
    let orders = readOrdersDatabase();
    const now = Date.now();

    // Now filter orders
    let resultData = orders;
    if (status) {
      resultData = resultData.filter(o => o.status === status);
    }

    // If shipperPhone is provided, filter PENDING orders and assign driver ownership for ACCEPTED/DELIVERED
    if (shipperPhone) {
      const cleanInputPhone = cleanPhone(shipperPhone);
      resultData = resultData.filter(o => {
        if (o.status === 'PENDING') {
          // Chỉ đề xuất đích danh — không mở bể chung
          if (!o.assignedShipperPhone || !o.offerExpiresAt) return false;
          return cleanPhone(o.assignedShipperPhone) === cleanInputPhone && now <= o.offerExpiresAt;
        }
        return cleanPhone(o.shipperPhone) === cleanInputPhone;
      });
    }

    res.json({ success: true, data: enrichOrdersWithShipperAvatar(hydrateOrdersRestaurantCoords(resultData), req) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/orders/:id
 * Lấy thông tin chi tiết một đơn hàng kèm tọa độ shipper hiện tại
 */
app.get('/api/orders/:id', (req, res) => {
  try {
    const { id } = req.params;
    const orders = readOrdersDatabase();
    const order = orders.find(o => o.id === id);
    if (!order) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }
    // Nếu đơn chưa có GPS gắn sẵn, fallback vị trí live của tài xế đang online
    const payload = { ...order };
    const hasGps = Number.isFinite(Number(payload.shipperLat)) && Number.isFinite(Number(payload.shipperLon));
    if (!hasGps && payload.shipperPhone) {
      const liveLoc = onlineShipperLocations.get(cleanPhone(payload.shipperPhone));
      if (liveLoc && Number.isFinite(liveLoc.lat) && Number.isFinite(liveLoc.lon)) {
        payload.shipperLat = liveLoc.lat;
        payload.shipperLon = liveLoc.lon;
      }
    }
    res.json({ success: true, data: enrichOrdersWithShipperAvatar(hydrateOrderRestaurantCoords(payload), req) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/orders/:id/accept', authenticateShipper, async (req, res) => {
  try {
    const { id } = req.params;
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
            .catch(err => console.error('[Supabase Sync Error] Lỗi dọn cờ hỗ trợ:', err.message));
        }
      }
    } catch (err) {
      console.error('[Assistance Clean Error] Lỗi dọn dẹp cờ hỗ trợ tìm đơn:', err.message);
    }

    upsertOrderToSupabase(updatedOrder).catch(() => {});
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
    const { status } = req.body;
    const authPhone = req.shipperPhone;

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
      orders[idx].status = status;
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
    upsertOrderToSupabase(updatedOrder).catch(() => {});
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
      onlineShipperLocations.set(authPhone, {
        lat,
        lon,
        lastSeen: Date.now(),
        ip: getClientIp(req) || null
      });
    }

    res.json({ success: true, data: updatedOrder });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/orders/:id/rate
 * Khách hàng gửi đánh giá chất lượng shipper (rating và comment)
 */
app.post('/api/orders/:id/rate', async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, comment } = req.body;

    if (typeof rating !== 'number') {
      return res.status(400).json({ error: 'Đánh giá rating không hợp lệ' });
    }

    let found = false;
    let updatedOrder = null;

    await updateOrdersDatabase((orders) => {
      const idx = orders.findIndex(o => o.id === id);
      if (idx !== -1) {
        found = true;
        orders[idx].rating = rating;
        orders[idx].comment = comment || '';
        updatedOrder = orders[idx];
      } else {
        return false;
      }
    });

    if (!found) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }

    console.log(`[Order Server] ⭐ Khách hàng đánh giá đơn ${id}: ${rating} sao`);
    res.json({ success: true, data: updatedOrder });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/orders/:id/messages
 * Gửi tin nhắn mới cho đơn hàng (được lưu trong mảng messages của đơn hàng)
 */
app.post('/api/orders/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    const { sender, text } = req.body;

    if (!sender || !text) {
      return res.status(400).json({ error: 'Thiếu người gửi (sender) hoặc nội dung tin nhắn (text)' });
    }

    let updatedOrder = null;
    let found = false;

    await updateOrdersDatabase((orders) => {
      const idx = orders.findIndex(o => o.id === id);
      if (idx !== -1) {
        found = true;
        if (!orders[idx].messages) {
          orders[idx].messages = [];
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

// ── WebRTC VoIP CALL SIGNALING REGISTRY ───────────────────────────────────
const activeCalls = {};

/**
 * POST /api/orders/:id/call/initiate
 * Bắt đầu một cuộc gọi từ customer hoặc shipper
 */
app.post('/api/orders/:id/call/initiate', (req, res) => {
  const { id } = req.params;
  const { caller, offer } = req.body;
  
  if (!caller) {
    return res.status(400).json({ error: 'Thiếu người gọi (caller)' });
  }

  activeCalls[id] = {
    status: 'ringing',
    caller,
    offer: offer || null,
    answer: null,
    callerCandidates: [],
    calleeCandidates: [],
    timestamp: Date.now(),
    lastPollCustomer: Date.now(),
    lastPollShipper: Date.now()
  };

  console.log(`[Call Server] 📞 Khởi tạo cuộc gọi cho đơn ${id} bởi ${caller}`);
  res.json({ success: true, call: activeCalls[id] });
});

/**
 * POST /api/orders/:id/call/respond
 * Trả lời hoặc xử lý cuộc gọi (accept/decline/end)
 */
app.post('/api/orders/:id/call/respond', (req, res) => {
  const { id } = req.params;
  const { action, answer } = req.body; // action: 'accept' | 'decline' | 'end'
  
  const call = activeCalls[id];
  if (!call) {
    return res.status(404).json({ error: 'Không có cuộc gọi hoạt động cho đơn hàng này' });
  }

  if (action === 'accept') {
    call.status = 'connected';
    if (answer) call.answer = answer;
    console.log(`[Call Server] 📞 Cuộc gọi cho đơn ${id} đã được chấp nhận`);
  } else if (action === 'decline') {
    call.status = 'ended';
    console.log(`[Call Server] 📞 Cuộc gọi cho đơn ${id} bị từ chối`);
  } else if (action === 'end') {
    call.status = 'ended';
    console.log(`[Call Server] 📞 Cuộc gọi cho đơn ${id} kết thúc`);
  }

  res.json({ success: true, call });
});

/**
 * POST /api/orders/:id/call/candidate
 * Gửi ứng viên ICE candidate
 */
app.post('/api/orders/:id/call/candidate', (req, res) => {
  const { id } = req.params;
  const { sender, candidate } = req.body; // sender: 'customer' | 'shipper'
  
  const call = activeCalls[id];
  if (!call) {
    return res.status(404).json({ error: 'Không có cuộc gọi hoạt động' });
  }

  if (sender === call.caller) {
    call.callerCandidates.push(candidate);
  } else {
    call.calleeCandidates.push(candidate);
  }

  res.json({ success: true });
});

/**
 * GET /api/orders/:id/call/poll
 * Thăm dò trạng thái cuộc gọi
 */
app.get('/api/orders/:id/call/poll', (req, res) => {
  const { id } = req.params;
  const { role } = req.query; // 'customer' | 'shipper'
  const call = activeCalls[id] || null;
  
  if (call) {
    const now = Date.now();
    if (role === 'customer') {
      call.lastPollCustomer = now;
    } else if (role === 'shipper') {
      call.lastPollShipper = now;
    }
    
    // Auto-timeout detection
    if (call.status === 'ringing' || call.status === 'connected') {
      const customerTimeout = call.lastPollCustomer && (now - call.lastPollCustomer > 6000);
      const shipperTimeout = call.lastPollShipper && (now - call.lastPollShipper > 6000);
      const ringTimeout = call.status === 'ringing' && (now - call.timestamp > 30000);
      
      if (customerTimeout || shipperTimeout || ringTimeout) {
        console.log(`[Call Server] 📞 Auto-ending call for order ${id} due to connection timeout or inactive polling`);
        call.status = 'ended';
      }
    }
  }
  
  res.json({ success: true, call });
});

// ── SHIPPER AUTHENTICATION & SHIFT LOGS ────────────────────────────────────
const SHIPPERS_FILE_PATH = path.join(__dirname, 'shippers-local.json');

function readShippersDatabase() {
  try {
    if (!fs.existsSync(SHIPPERS_FILE_PATH)) {
      return [];
    }
    const raw = fs.readFileSync(SHIPPERS_FILE_PATH, 'utf8');
    return JSON.parse(raw) || [];
  } catch (e) {
    console.error('[Shippers DB] Lỗi đọc database:', e.message);
    return [];
  }
}

function writeShippersDatabase(data) {
  try {
    fs.writeFileSync(SHIPPERS_FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[Shippers DB] Lỗi ghi database:', e.message);
    return false;
  }
}

/**
 * POST /api/shippers/login
 * Xác thực trùng khớp cả SĐT và Họ tên tài xế (không phân biệt chữ hoa/thường, loại bỏ khoảng trắng thừa)
 */
app.post('/api/shippers/login', async (req, res) => {
  try {
    const { token } = req.body;

    if (!supabase) {
      return res.status(503).json({ success: false, error: 'Hệ thống đang hoạt động ở chế độ Supabase trực tuyến nhưng chưa cấu hình thông số kết nối hoặc cấu hình bị lỗi!' });
    }
    if (!token) {
      return res.status(400).json({ success: false, error: 'Thiếu token xác thực Supabase!' });
    }

    // Supabase Auth verification path
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ success: false, error: 'Token không hợp lệ hoặc đã hết hạn!' });
    }

    const shippers = readShippersDatabase();
    const userPhone = user.phone ? user.phone.replace('+84', '0') : (user.user_metadata?.phone || '');
    const userName = user.user_metadata?.full_name || user.email.split('@')[0];

    // Tìm kiếm trong database nội bộ bằng ID hoặc SĐT
    let idx = shippers.findIndex(s => s.id === user.id);
    if (idx === -1 && userPhone) {
      idx = shippers.findIndex(s => s.phone.trim().replace(/\s+/g, '') === userPhone.trim().replace(/\s+/g, ''));
    }

    let shipper = null;
    if (idx !== -1) {
      // Liên kết tài khoản
      shippers[idx].id = user.id;
      if (!shippers[idx].phone && userPhone) shippers[idx].phone = userPhone;
      shipper = shippers[idx];
    } else {
      // Tự động tạo bản ghi nội bộ nếu chưa có để đảm bảo chạy thuật toán giao đơn
      shipper = {
        id: user.id,
        phone: userPhone || '0900000000',
        name: userName,
        cccd: user.user_metadata?.cccd || '', // Lấy CCCD từ metadata Supabase Auth
        status: 'OFFLINE',
        lastCheckIn: null,
        lastCheckOut: null
      };
      shippers.push(shipper);
    }

    if (shipper && shipper.isApproved === false) {
      return res.status(403).json({ success: false, error: 'PENDING_APPROVAL', message: 'Tài khoản của bạn đang chờ Admin phê duyệt!' });
    }

    writeShippersDatabase(shippers);
    return res.json({ success: true, shipper: { name: shipper.name, phone: shipper.phone, avatarUrl: normalizeImageUrl(shipper.avatarUrl, req), isApproved: shipper.isApproved, cccd: shipper.cccd || '' } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/shippers/register
 * Cho phép shipper tự động đăng ký tài khoản
 */
app.post('/api/shippers/register', async (req, res) => {
  try {
    const { name, phone, email, password, avatar, cccd } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ success: false, error: 'Thiếu thông tin đăng ký!' });
    }
    if (!cccd) {
      return res.status(400).json({ success: false, error: 'Thiếu số CCCD của tài xế!' });
    }
    if (!supabase) {
      return res.status(503).json({ success: false, error: 'Hệ thống đang hoạt động ở chế độ Supabase trực tuyến nhưng chưa cấu hình thông số kết nối hoặc cấu hình bị lỗi!' });
    }
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Chế độ trực tuyến bắt buộc phải có Email và Mật khẩu để đăng ký!' });
    }

    const cleanedCccd = cccd.trim();
    if (cleanedCccd.length < 9 || cleanedCccd.length > 12 || !/^\d+$/.test(cleanedCccd)) {
      return res.status(400).json({ success: false, error: 'Số CCCD không hợp lệ (phải gồm 9 đến 12 chữ số)!' });
    }

    const shippers = readShippersDatabase();
    const cleanedPhone = phone.trim().replace(/\s+/g, '');
    
    // Kiểm tra trùng SĐT
    if (shippers.some(s => s.phone.trim().replace(/\s+/g, '') === cleanedPhone)) {
      return res.status(400).json({ success: false, error: 'Số điện thoại này đã được đăng ký trên hệ thống!' });
    }

    // Kiểm tra trùng CCCD
    if (shippers.some(s => s.cccd && s.cccd.trim() === cleanedCccd)) {
      return res.status(400).json({ success: false, error: 'Số CCCD này đã được đăng ký cho một tài khoản tài xế khác!' });
    }

    // Xử lý và lưu ảnh chân dung (Base64 -> PNG & Supabase Storage)
    let avatarUrl = '';
    if (avatar) {
      avatarUrl = await uploadShipperAvatar(cleanedPhone, avatar, req);
    }

    // Tạo Auth user bằng Admin API — KHÔNG gửi email.
    // Email xác nhận Supabase chỉ được gửi trong approveShipperAccount() sau khi CRM/Telegram duyệt.
    const { data: signUpData, error: signUpError } = await supabase.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password: password,
      email_confirm: false,
      user_metadata: {
        full_name: name.trim(),
        phone: cleanedPhone,
        role: 'shipper',
        is_approved: false,
        avatar_url: avatarUrl,
        cccd: cleanedCccd,
        pending_crm_approval: true
      },
      app_metadata: {
        role: 'shipper',
        pending_crm_approval: true
      }
    });

    if (signUpError || !signUpData.user) {
      return res.status(400).json({ success: false, error: 'Lỗi đăng ký Supabase Auth: ' + (signUpError?.message || 'Không thể đăng ký user') });
    }

    const user = signUpData.user;
    // Đảm bảo email vẫn chưa confirm (tránh project hook/auto-confirm)
    if (user.email_confirmed_at) {
      console.warn(`[Register] User ${user.id} bị confirm sớm — không mong muốn ở bước đăng ký`);
    }
    console.log(`[Register] Tạo Auth user ${user.id} cho ${email.trim().toLowerCase()} — chưa gửi email (chờ CRM duyệt)`);
    const newShipper = {
      id: user.id,
      phone: cleanedPhone,
      name: name.trim(),
      email: email.trim(),
      cccd: cleanedCccd,
      avatarUrl: avatarUrl,
      isApproved: false, // Mặc định chưa được duyệt
      status: 'OFFLINE',
      lastCheckIn: null,
      lastCheckOut: null,
      totalOrders: 0,
      totalEarnings: 0,
      acceptanceRate: 100,
      completionRate: 100
    };

    shippers.push(newShipper);
    writeShippersDatabase(shippers);

    // Đồng bộ lên bảng shipper_profiles
    try {
      await supabase.from('shipper_profiles').insert({
        id: user.id,
        phone: cleanedPhone,
        full_name: name.trim(),
        avatar_url: avatarUrl,
        is_approved: false, // Duy trì ở table profiles
        status: 'OFFLINE',
        total_orders: 0,
        total_earnings: 0,
        cccd: cleanedCccd,
        acceptance_rate: 100,
        completion_rate: 100
      });
    } catch (err) {
      console.error('[Supabase Register Error]:', err.message);
    }

    // Gửi thông báo phê duyệt tới Telegram Bot
    if (telegramBot) telegramBot.sendNewShipperNotification(newShipper).catch(e => console.error('Lỗi gửi Telegram:', e.message));

    return res.json({ success: true, shipper: { name: newShipper.name, phone: newShipper.phone } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/shippers/shift
 * Cập nhật trạng thái ca làm việc (Vào ca/Ra ca - Check-in/Check-out)
 */
app.post('/api/shippers/shift', authenticateShipper, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['ONLINE', 'OFFLINE'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Thông tin không hợp lệ!' });
    }

    const bound = resolveAuthenticatedShipperPhone(req, req.body?.phone);
    if (!bound.ok) {
      return res.status(403).json({ success: false, error: bound.error });
    }
    const cleanedPhone = bound.phone;

    const shippers = readShippersDatabase();
    const idx = shippers.findIndex(s => cleanPhone(s.phone) === cleanedPhone);

    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Số điện thoại tài xế không tồn tại!' });
    }

    shippers[idx].status = status;
    let nowStr = new Date().toISOString();
    if (status === 'ONLINE') {
      shippers[idx].lastCheckIn = nowStr;
    } else {
      shippers[idx].lastCheckOut = nowStr;
      onlineShipperLocations.delete(cleanedPhone);
    }

    writeShippersDatabase(shippers);
    console.log(`[Shippers DB] 🛵 Tài xế ${shippers[idx].name} (${cleanedPhone}) đã ${status === 'ONLINE' ? 'Vào ca (Check-in)' : 'Tắt ca (Check-out)'} ip=${getClientIp(req)}`);

    // Sync to Supabase shipper_profiles if active
    if (supabase && shippers[idx].id) {
      try {
        const updatePayload = {
          status,
          updated_at: nowStr
        };
        if (status === 'ONLINE') {
          updatePayload.last_check_in = nowStr;
        } else {
          updatePayload.last_check_out = nowStr;
        }
        await supabase.from('shipper_profiles').update(updatePayload).eq('id', shippers[idx].id);
      } catch (err) {
        console.error('[Supabase Sync Error] Lỗi đồng bộ ca làm việc:', err.message);
      }
    }
    
    res.json({ success: true, shipper: { ...shippers[idx], avatarUrl: normalizeImageUrl(shippers[idx].avatarUrl, req) } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/shippers/location
 * Cập nhật vị trí GPS của tài xế khi rảnh rỗi (isOnline = true nhưng chưa có đơn)
 */
app.post('/api/shippers/location', authenticateShipper, (req, res) => {
  try {
    const bound = resolveAuthenticatedShipperPhone(req, req.body?.phone);
    if (!bound.ok) {
      return res.status(403).json({ success: false, error: bound.error, code: 'PHONE_MISMATCH' });
    }
    const cleanedPhone = bound.phone;
    const lat = Number(req.body?.lat);
    const lon = Number(req.body?.lon);
    const accuracy = Number(req.body?.accuracy);
    const clientIp = getClientIp(req);

    const shippers = readShippersDatabase();
    const shipper = shippers.find(s => cleanPhone(s.phone) === cleanedPhone);
    if (!shipper) {
      return res.status(404).json({ success: false, error: 'Tài xế không tồn tại!' });
    }
    if (shipper.status !== 'ONLINE') {
      return res.status(409).json({ success: false, error: 'Cần Check-in trước khi gửi vị trí', code: 'NOT_ONLINE' });
    }

    const validated = validateShipperLocationUpdate(cleanedPhone, lat, lon);
    if (!validated.ok) {
      console.warn(`[GPS Guard] ${cleanedPhone} rejected ${validated.code} lat=${lat} lon=${lon} ip=${clientIp}`);
      return res.status(400).json({
        success: false,
        error: validated.error,
        code: validated.code
      });
    }

    onlineShipperLocations.set(cleanedPhone, {
      lat,
      lon,
      accuracy: Number.isFinite(accuracy) ? accuracy : null,
      lastSeen: Date.now(),
      ip: clientIp || null
    });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/shippers/stats
 * Cập nhật chỉ số hoạt động (AR, CR, doanh thu, số đơn) của tài xế
 */
app.post('/api/shippers/stats', authenticateShipper, async (req, res) => {
  try {
    const { stats, totalOrders, totalEarnings, acceptanceRate, completionRate } = req.body;
    const bound = resolveAuthenticatedShipperPhone(req, req.body?.phone);
    if (!bound.ok) {
      return res.status(403).json({ success: false, error: bound.error });
    }
    const cleanedPhone = bound.phone;

    const shippers = readShippersDatabase();
    const idx = shippers.findIndex(s => cleanPhone(s.phone) === cleanedPhone);

    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Tài xế không tồn tại!' });
    }

    // Cập nhật local database
    shippers[idx].stats = stats;
    shippers[idx].totalOrders = totalOrders;
    shippers[idx].totalEarnings = totalEarnings;
    shippers[idx].acceptanceRate = acceptanceRate;
    shippers[idx].completionRate = completionRate;

    writeShippersDatabase(shippers);

    // Đồng bộ lên Supabase nếu có
    if (supabase && shippers[idx].id) {
      try {
        const updatePayload = {
          total_orders: totalOrders,
          total_earnings: totalEarnings,
          acceptance_rate: acceptanceRate,
          completion_rate: completionRate,
          updated_at: new Date().toISOString()
        };
        await supabase.from('shipper_profiles').update(updatePayload).eq('id', shippers[idx].id);
      } catch (err) {
        console.error('[Supabase Sync Error] Lỗi đồng bộ chỉ số:', err.message);
      }
    }

    res.json({ success: true, shipper: { ...shippers[idx], avatarUrl: normalizeImageUrl(shippers[idx].avatarUrl, req) } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/shippers/request-assistance
 * Tài xế gửi yêu cầu hỗ trợ tìm đơn (SOS Dispatch)
 */
app.post('/api/shippers/request-assistance', authenticateShipper, async (req, res) => {
  try {
    const bound = resolveAuthenticatedShipperPhone(req, req.body?.phone);
    if (!bound.ok) {
      return res.status(403).json({ success: false, error: bound.error });
    }
    const cleanPhone = bound.phone;

    const shippers = readShippersDatabase();
    const idx = shippers.findIndex(s => s.phone.trim().replace(/\s+/g, '') === cleanPhone);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy tài xế!' });
    }

    const shipper = shippers[idx];
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    
    // Kiểm tra ngày cuối dùng hỗ trợ
    if (shipper.lastAssistanceDate !== today) {
      shipper.assistanceLimitToday = 0;
      shipper.lastAssistanceDate = today;
    }

    if (shipper.assistanceLimitToday >= 3) {
      return res.status(400).json({ 
        success: false, 
        error: 'Bạn đã sử dụng hết 3 lượt hỗ trợ tìm đơn hôm nay! Vui lòng thử lại vào ngày mai.' 
      });
    }

    // Tăng lượt sử dụng
    shipper.assistanceLimitToday = (shipper.assistanceLimitToday || 0) + 1;
    shipper.assistanceRequested = true;
    shipper.lastAssistanceDate = today;
    shippers[idx] = shipper;
    writeShippersDatabase(shippers);

    console.log(`[Order Assistance] 🆘 Shipper ${shipper.name} (${shipper.phone}) yêu cầu hỗ trợ tìm đơn. Lượt dùng: ${shipper.assistanceLimitToday}/3`);

    // Đồng bộ lên Supabase nếu có
    if (supabase && shipper.id) {
      try {
        await supabase
          .from('shipper_profiles')
          .update({
            assistance_limit_today: shipper.assistanceLimitToday,
            last_assistance_date: today,
            assistance_requested: true
          })
          .eq('id', shipper.id);
      } catch (err) {
        console.error('[Supabase Sync Error] Lỗi đồng bộ yêu cầu hỗ trợ:', err.message);
      }
    }

    // Kiểm tra xem có đơn hàng nào đang PENDING và chưa có ai nhận không
    const orders = readOrdersDatabase();
    // Lấy danh sách các đơn hàng PENDING mà không được gán cho ai hoặc offer đã hết hạn
    const pendingOrders = orders.filter(o => o.status === 'PENDING' && (!o.assignedShipperPhone || (o.offerExpiresAt && Date.now() > o.offerExpiresAt)));

    if (pendingOrders.length > 0) {
      // Chọn đơn hàng lâu nhất
      pendingOrders.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      const targetOrder = pendingOrders[0];

      // Gán đơn hàng này trực tiếp và tự động nhận luôn cho tài xế này (Auto-Accept SOS)
      let finalOrder = null;
      await updateOrdersDatabase((allOrders) => {
        const oIdx = allOrders.findIndex(o => o.id === targetOrder.id);
        if (oIdx !== -1) {
          allOrders[oIdx].status = 'ACCEPTED';
          allOrders[oIdx].acceptedAt = Date.now();
          allOrders[oIdx].shipperId = shipper.id || 'shipper-default';
          allOrders[oIdx].shipperName = shipper.name;
          allOrders[oIdx].shipperPhone = cleanPhone;
          allOrders[oIdx].assignedShipperPhone = null;
          allOrders[oIdx].offerExpiresAt = null;
          finalOrder = allOrders[oIdx];
        }
      });

      // Tắt cờ assistanceRequested của tài xế
      shipper.assistanceRequested = false;
      shippers[idx] = shipper;
      writeShippersDatabase(shippers);

      if (supabase && shipper.id) {
        supabase
          .from('shipper_profiles')
          .update({ assistance_requested: false })
          .eq('id', shipper.id)
          .catch(err => console.error('[Supabase Sync Error] Lỗi dọn cờ hỗ trợ:', err.message));
      }

      console.log(`[Priority Dispatch] 🎯 Tự động gán và nhận đơn ${targetOrder.id} cho tài xế SOS ${shipper.name}`);
      
      if (finalOrder) {
        if (telegramBot) telegramBot.sendOrderStatusUpdateNotification(finalOrder).catch(e => console.error('Lỗi gửi Telegram:', e.message));
      }

      return res.json({ 
        success: true, 
        message: 'Đã tự động gán và nhận đơn hàng phù hợp cho bạn!', 
        orderId: targetOrder.id,
        limitUsed: shipper.assistanceLimitToday
      });
    }

    if (telegramBot) telegramBot.sendSosNotification(shipper).catch(e => console.error('[Telegram Bot] Lỗi gửi tin hỗ trợ:', e.message));

    res.json({ 
      success: true, 
      message: 'Hệ thống đang tìm kiếm đơn. Đơn hàng tiếp theo phát sinh sẽ được tự động gán ưu tiên cho bạn!', 
      limitUsed: shipper.assistanceLimitToday 
    });

  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/shippers/support/thread
 * Thread chat hỗ trợ CRM của tài xế đang đăng nhập
 */
app.get('/api/shippers/support/thread', authenticateShipper, (req, res) => {
  try {
    const phone = cleanPhone(req.shipperPhone);
    const shippers = readShippersDatabase();
    const shipper = shippers.find(s => cleanPhone(s.phone) === phone);
    if (!shipper) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy tài xế' });
    }

    const threads = crm.readShipperSupportThreads();
    let thread = threads.find(t => cleanPhone(t.shipperPhone) === phone && t.status === 'open');
    if (!thread) {
      thread = threads
        .filter(t => cleanPhone(t.shipperPhone) === phone)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
    }

    if (thread) {
      crm.markShipperSupportRead(thread.id, 'shipper');
      thread = crm.readShipperSupportThreads().find(t => t.id === thread.id) || thread;
    }

    res.json({ success: true, data: thread });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/shippers/support/messages
 * Tài xế nhắn CRM (hỗ trợ đơn / khẩn cấp)
 * body: { text, orderId?, priority?: 'normal'|'emergency' }
 */
app.post('/api/shippers/support/messages', authenticateShipper, async (req, res) => {
  try {
    const phone = cleanPhone(req.shipperPhone);
    const { text, orderId = null, priority = 'normal' } = req.body || {};
    const cleanedText = String(text || '').trim();
    if (!cleanedText) {
      return res.status(400).json({ success: false, error: 'Thiếu nội dung tin nhắn' });
    }
    if (cleanedText.length > 1000) {
      return res.status(400).json({ success: false, error: 'Tin nhắn tối đa 1000 ký tự' });
    }

    const shippers = readShippersDatabase();
    const shipper = shippers.find(s => cleanPhone(s.phone) === phone);
    if (!shipper) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy tài xế' });
    }

    let linkedOrderId = orderId ? String(orderId).trim() : null;
    if (linkedOrderId) {
      const orders = readOrdersDatabase();
      const order = orders.find(o => o.id === linkedOrderId);
      if (!order) {
        return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
      }
      const orderShipper = cleanPhone(order.shipperPhone || order.assignedShipperPhone);
      if (orderShipper && orderShipper !== phone) {
        return res.status(403).json({ success: false, error: 'Đơn này không thuộc về bạn' });
      }
    }

    const isEmergency = String(priority).toLowerCase() === 'emergency';
    const thread = crm.getOrCreateShipperSupportThread(shipper, {
      priority: isEmergency ? 'emergency' : 'normal',
      orderId: linkedOrderId
    });
    if (!thread) {
      return res.status(500).json({ success: false, error: 'Không tạo được thread hỗ trợ' });
    }

    const updated = crm.appendShipperSupportMessage(thread.id, {
      sender: 'shipper',
      role: 'shipper',
      text: cleanedText,
      priority: isEmergency ? 'emergency' : undefined,
      orderId: linkedOrderId
    });

    addNotification(
      isEmergency ? 'shipper_emergency' : 'shipper_support',
      phone,
      shipper.name || phone,
      isEmergency ? '🚨 Shipper cần hỗ trợ khẩn cấp' : '💬 Shipper nhắn CRM',
      `${shipper.name || phone}: ${cleanedText.slice(0, 160)}${linkedOrderId ? `\nĐơn: ${linkedOrderId}` : ''}`
    );

    if (telegramBot && typeof telegramBot.sendShipperSupportNotification === 'function') {
      telegramBot.sendShipperSupportNotification({
        ...shipper,
        supportMessage: cleanedText,
        supportOrderId: linkedOrderId || updated?.orderId || null,
        supportPriority: isEmergency ? 'emergency' : 'normal',
        supportThreadId: updated?.id || thread.id
      }).catch(e => console.error('[Telegram] shipper support chat:', e.message));
    }

    res.json({ success: true, data: updated });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/orders/:id/decline
 * Tài xế chủ động từ chối đơn hàng đề xuất (Job Offer)
 */
app.post('/api/orders/:id/decline', authenticateShipper, async (req, res) => {
  try {
    const { id } = req.params;
    const cleanedPhone = cleanPhone(req.shipperPhone || req.body?.phone);

    if (!cleanedPhone) {
      return res.status(400).json({ success: false, error: 'Thiếu số điện thoại tài xế!' });
    }

    let found = false;
    let updatedOrder = null;

    await updateOrdersDatabase((orders) => {
      const idx = orders.findIndex(o => o.id === id);
      if (idx !== -1 && orders[idx].status === 'PENDING') {
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

    if (!found) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng hoặc đơn không ở trạng thái chờ nhận!' });
    }

    res.json({ success: true, data: updatedOrder });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/shippers
 * Lấy danh sách tài xế cùng lịch sử check-in/out phục vụ CRM
 */
app.get('/api/shippers', (req, res) => {
  try {
    const shippers = readShippersDatabase();
    const normalizedShippers = shippers.map(s => ({
      ...s,
      avatarUrl: normalizeImageUrl(s.avatarUrl, req)
    }));
    res.json({ success: true, data: normalizedShippers });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/config
 * Expose non-secret configuration (Supabase URL + Anon Key) to clients
 */
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
    markupRate: pricingConfig.markupRate,
    minShipperEarning: pricingConfig.minShipperEarning,
    freeDistanceKm: pricingConfig.freeDistanceKm,
    multiItemDiscount: pricingConfig.multiItemDiscount
  });
});

// ── ADMIN SYSTEM NOTIFICATIONS ENDPOINTS ─────────────────────────────────────
app.get('/api/admin/notifications', authenticateAdmin, (req, res) => {
  const notifs = readNotifications();
  res.json({ success: true, data: notifs });
});

app.post('/api/admin/notifications/:id/read', authenticateAdmin, (req, res) => {
  const id = String(req.params.id);
  const notifs = readNotifications();
  const idx = notifs.findIndex(n => String(n.id) === id);
  if (idx !== -1) {
    notifs[idx].read = true;
    writeNotifications(notifs);
    
    // Đồng bộ Supabase
    if (supabase) {
      supabase.from('system_notifications').update({ read: true }).eq('id', id)
        .then(({ error }) => { if (error) console.error('[Supabase Update] Lỗi update read:', error.message); });
    }
    return res.json({ success: true });
  }
  res.status(404).json({ error: 'Không tìm thấy thông báo' });
});

app.post('/api/admin/notifications/read-all', authenticateAdmin, (req, res) => {
  const notifs = readNotifications();
  notifs.forEach(n => n.read = true);
  writeNotifications(notifs);
  
  if (supabase) {
    supabase.from('system_notifications').update({ read: true }).eq('read', false)
      .then(({ error }) => { if (error) console.error('[Supabase Update] Lỗi update read-all:', error.message); });
  }
  res.json({ success: true });
});

/**
 * GET /api/admin/dashboard
 * Return dashboard KPIs for CRM admin
 */
app.get('/api/admin/dashboard', authenticateAdmin, async (req, res) => {
  try {
    const shippers = readShippersDatabase();
    const orders = readOrdersDatabase();

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTs = todayStart.getTime();
    const todayOrders = orders.filter(o => (o.createdAt || 0) >= todayTs);
    const todayCompleted = todayOrders.filter(o => o.status === 'DELIVERED');

    const onlineShippers = shippers.filter(s => s.status === 'ONLINE').length;
    const completedOrders = orders.filter(o => o.status === 'DELIVERED');
    const pendingOrders = orders.filter(o => o.status === 'PENDING').length;
    
    const totalRevenue = todayCompleted.reduce((sum, o) => sum + (o.appTotal || 0), 0);
    const totalEarnings = todayCompleted.reduce((sum, o) => sum + (o.shipperEarning || 0), 0);
    const restaurantSource = cachedRestaurants.length > 0 ? cachedRestaurants : dbHelper.read();
    if (adminRestaurantStats.total !== restaurantSource.length) {
      recomputeAdminRestaurantStats(restaurantSource);
    }
    const totalRestaurants = adminRestaurantStats.total;
    const openRestaurants = adminRestaurantStats.open;

    res.json({
      success: true,
      stats: {
        totalOrders: todayOrders.length,
        completedOrdersCount: todayCompleted.length,
        pendingOrders,
        onlineShippers,
        totalRevenue,
        totalEarnings,
        allTimeOrders: orders.length,
        allTimeCompleted: completedOrders.length,
        totalRestaurants,
        openRestaurants
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/admin/ops/live
 * Command center: active orders, SLA breaches, online shippers
 */
app.get('/api/admin/ops/live', authenticateAdmin, (req, res) => {
  try {
    const shippers = readShippersDatabase();
    const orders = readOrdersDatabase();
    const activeStatuses = ['PENDING', 'ACCEPTED', 'PURCHASED'];
    const activeOrders = orders
      .filter(o => activeStatuses.includes(o.status))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    const slaBreaches = activeOrders
      .map(o => {
        const sla = getOrderSlaInfo(o);
        if (!sla) return null;
        return {
          id: o.id,
          status: o.status,
          restaurantName: o.restaurantName,
          deliveryName: o.deliveryName,
          shipperName: o.shipperName,
          appTotal: o.appTotal,
          createdAt: o.createdAt,
          slaType: sla.type,
          ageMs: sla.ageMs,
          thresholdMs: sla.thresholdMs
        };
      })
      .filter(Boolean);

    crm.checkSlaAndNotify(activeOrders, getOrderSlaInfo, addNotification);
    if (telegramBot) telegramBot.checkAndNotifySla(activeOrders);

    const onlineList = shippers
      .filter(s => s.status === 'ONLINE')
      .map(s => ({
        phone: s.phone,
        name: s.name,
        avatarUrl: s.avatarUrl
      }));

    res.json({
      success: true,
      data: {
        activeOrders,
        slaBreaches,
        onlineShippers: onlineList,
        breachCount: slaBreaches.length,
        activeCount: activeOrders.length,
        updatedAt: Date.now()
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/admin/fleet
 * Live GPS map data: online shippers + active order markers
 */
app.get('/api/admin/fleet', authenticateAdmin, (req, res) => {
  try {
    const shippers = readShippersDatabase();
    const orders = readOrdersDatabase();
    const activeStatuses = ['PENDING', 'ACCEPTED', 'PURCHASED'];
    const activeOrders = orders.filter(o => activeStatuses.includes(o.status));

    const fleetShippers = shippers
      .filter(s => s.status === 'ONLINE')
      .map(s => {
        const phone = cleanPhone(s.phone);
        const loc = onlineShipperLocations.get(phone);
        const activeOrder = activeOrders.find(o =>
          cleanPhone(o.shipperPhone) === phone &&
          ['ACCEPTED', 'PURCHASED'].includes(o.status)
        );
        return {
          phone: s.phone,
          name: s.name,
          avatarUrl: s.avatarUrl,
          lat: typeof activeOrder?.shipperLat === 'number' ? activeOrder.shipperLat : (loc?.lat ?? null),
          lon: typeof activeOrder?.shipperLon === 'number' ? activeOrder.shipperLon : (loc?.lon ?? null),
          lastSeen: loc?.lastSeen ?? null,
          activeOrderId: activeOrder?.id ?? null
        };
      })
      .filter(s => typeof s.lat === 'number' && typeof s.lon === 'number');

    const orderMarkers = activeOrders.map(o => ({
      id: o.id,
      status: o.status,
      restaurantName: o.restaurantName,
      restaurantLat: o.restaurantLat ?? null,
      restaurantLon: o.restaurantLon ?? null,
      deliveryLat: o.pinnedLat ?? null,
      deliveryLon: o.pinnedLon ?? null,
      shipperLat: o.shipperLat ?? null,
      shipperLon: o.shipperLon ?? null,
      shipperPhone: o.shipperPhone ?? null,
      shipperName: o.shipperName ?? null,
      sla: getOrderSlaInfo(o)
    }));

    res.json({
      success: true,
      data: {
        shippers: fleetShippers,
        orders: orderMarkers,
        updatedAt: Date.now()
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/admin/shippers
 * Create a new shipper on local JSON + Supabase Auth
 */
app.post('/api/admin/shippers', authenticateAdmin, async (req, res) => {
  try {
    const { name, phone, email, password, cccd } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ success: false, error: 'Thiếu Tên hoặc SĐT tài xế!' });
    }

    const shippers = readShippersDatabase();
    const cleanedPhone = phone.trim().replace(/\s+/g, '');

    // Check if phone already exists
    const exists = shippers.some(s => s.phone.trim().replace(/\s+/g, '') === cleanedPhone);
    if (exists) {
      return res.status(400).json({ success: false, error: 'Số điện thoại này đã được đăng ký!' });
    }

    // Check if CCCD already exists
    if (cccd) {
      const cleanedCccd = cccd.trim();
      const existsCccd = shippers.some(s => s.cccd && s.cccd.trim() === cleanedCccd);
      if (existsCccd) {
        return res.status(400).json({ success: false, error: 'Số CCCD này đã được đăng ký cho một tài xế khác!' });
      }
    }

    let uuid = null;
    if (supabase && email && password) {
      // Create user on Supabase auth
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email,
        password,
        phone: cleanedPhone.startsWith('0') ? '+84' + cleanedPhone.slice(1) : cleanedPhone,
        user_metadata: { full_name: name, role: 'shipper', cccd: cccd || '' },
        email_confirm: true,
        phone_confirm: true
      });

      if (authError) {
        return res.status(400).json({ success: false, error: 'Lỗi Supabase Auth: ' + authError.message });
      }

      uuid = authData.user.id;

      // Insert profile into shipper_profiles
      const { error: profileError } = await supabase.from('shipper_profiles').insert({
        id: uuid,
        phone: cleanedPhone,
        full_name: name,
        is_approved: true, // Admin tạo thì tự động duyệt
        status: 'OFFLINE',
        cccd: cccd || ''
      });

      if (profileError) {
        console.error('[Supabase Error] Lỗi tạo profile:', profileError.message);
      }
    }

    // Add to local database
    const newShipper = {
      id: uuid,
      phone: cleanedPhone,
      name,
      email, // Lưu email để hiển thị hoặc sửa
      cccd: cccd || '', // Lưu CCCD
      isApproved: true, // Mặc định được duyệt đối với tài khoản admin tạo
      status: 'OFFLINE',
      lastCheckIn: null,
      lastCheckOut: null
    };

    shippers.push(newShipper);
    writeShippersDatabase(shippers);

    res.json({ success: true, shipper: newShipper });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * PUT /api/admin/shippers/:oldPhone
 * Update an existing shipper on local JSON + Supabase Auth
 */
app.put('/api/admin/shippers/:oldPhone', authenticateAdmin, async (req, res) => {
  try {
    const { oldPhone } = req.params;
    const { name, phone, email, password, cccd, avatar } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ success: false, error: 'Thiếu Tên hoặc SĐT tài xế!' });
    }

    const shippers = readShippersDatabase();
    const cleanedOldPhone = oldPhone.trim().replace(/\s+/g, '');
    const cleanedNewPhone = phone.trim().replace(/\s+/g, '');

    // Tìm shipper cần sửa
    const shipperIndex = shippers.findIndex(s => s.phone.trim().replace(/\s+/g, '') === cleanedOldPhone);
    if (shipperIndex === -1) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy tài xế cần cập nhật!' });
    }

    const shipper = shippers[shipperIndex];
    const uuid = shipper.id;

    // Nếu thay đổi SĐT, kiểm tra xem SĐT mới đã được dùng bởi tài xế khác chưa
    if (cleanedOldPhone !== cleanedNewPhone) {
      const exists = shippers.some((s, idx) => idx !== shipperIndex && s.phone.trim().replace(/\s+/g, '') === cleanedNewPhone);
      if (exists) {
        return res.status(400).json({ success: false, error: 'Số điện thoại mới đã được sử dụng bởi tài xế khác!' });
      }
    }

    // Nếu thay đổi hoặc cung cấp CCCD mới, kiểm tra trùng lặp với tài xế khác
    if (cccd) {
      const cleanedCccd = cccd.trim();
      const existsCccd = shippers.some((s, idx) => idx !== shipperIndex && s.cccd && s.cccd.trim() === cleanedCccd);
      if (existsCccd) {
        return res.status(400).json({ success: false, error: 'Số CCCD mới đã được sử dụng bởi một tài xế khác!' });
      }
    }

    // Xử lý và lưu ảnh chân dung (Base64 -> PNG & Supabase Storage)
    let avatarUrl = shipper.avatarUrl || '';
    if (avatar) {
      avatarUrl = await uploadShipperAvatar(cleanedNewPhone, avatar, req);
    }

    // Cập nhật thông tin trên Supabase Auth nếu có uuid và email/password
    if (supabase && uuid) {
      const updateData = {
        user_metadata: { full_name: name, role: 'shipper', cccd: cccd || '', avatar_url: avatarUrl }
      };
      if (email) updateData.email = email;
      if (password) updateData.password = password;

      const newFormatPhone = cleanedNewPhone.startsWith('0') ? '+84' + cleanedNewPhone.slice(1) : cleanedNewPhone;
      updateData.phone = newFormatPhone;

      let authError = null;
      try {
        const updateRes = await supabase.auth.admin.updateUserById(uuid, updateData);
        authError = updateRes.error;
      } catch (err) {
        authError = err;
      }

      // Nếu lỗi là User not found (lệch đồng bộ Supabase Auth), tự động xử lý bằng cách tạo mới hoặc đồng bộ UUID từ online
      if (authError && authError.message && authError.message.includes('User not found')) {
        console.log(`[Supabase Update] User ${uuid} không tồn tại trên Supabase Auth. Tiến hành tự động xử lý...`);
        let targetUser = null;

        const { data: createData, error: createError } = await supabase.auth.admin.createUser({
          email: email ? email.trim() : `${cleanedNewPhone}@shipfee.vn`,
          password: password || '123456',
          phone: newFormatPhone,
          user_metadata: { full_name: name, role: 'shipper', cccd: cccd || '', avatar_url: avatarUrl },
          email_confirm: true,
          phone_confirm: true
        });

        if (createError) {
          // Nếu email đã được đăng ký, tìm kiếm user đó trên Supabase Auth để đồng bộ UUID
          if (createError.message && (createError.message.includes('already been registered') || createError.message.includes('already exists'))) {
            console.log(`[Supabase Synced] Email ${email} đã có sẵn trên Supabase Auth. Đang truy vấn để tự động đồng bộ UUID...`);
            try {
              const { data: { users }, error: listError } = await supabase.auth.admin.listUsers();
              if (!listError && users) {
                const found = users.find(u => u.email === email.trim());
                if (found) {
                  targetUser = found;
                  console.log(`[Supabase Synced] Đã tìm thấy user online trùng khớp. Đồng bộ UUID sang: ${found.id}`);
                  // Cập nhật thông tin mới lên tài khoản online đó
                  await supabase.auth.admin.updateUserById(found.id, updateData);
                }
              }
            } catch (err) {
              console.error('[Supabase Synced Error] Lỗi truy vấn listUsers:', err.message);
            }
          }
          
          if (!targetUser) {
            console.error('[Supabase Create Error] Không thể tạo mới tài xế thay thế:', createError.message);
            return res.status(400).json({ success: false, error: 'Lỗi Supabase Auth: ' + authError.message + ' (Thử tạo mới cũng thất bại: ' + createError.message + ')' });
          }
        } else if (createData && createData.user) {
          targetUser = createData.user;
        }

        if (targetUser) {
          // Cập nhật UUID mới của tài khoản vừa tạo hoặc vừa đồng bộ
          shipper.id = targetUser.id;
          authError = null; // Bỏ qua lỗi ban đầu

          // Tạo/Cập nhật profile trong table shipper_profiles
          const { error: profileError } = await supabase.from('shipper_profiles').upsert({
            id: targetUser.id,
            phone: cleanedNewPhone,
            full_name: name,
            is_approved: true,
            status: 'OFFLINE',
            cccd: cccd || '',
            avatar_url: avatarUrl
          });
          if (profileError) {
            console.error('[Supabase Profile Upsert Error] Lỗi ghi profile:', profileError.message);
          }
        }
      } else if (authError) {
        return res.status(400).json({ success: false, error: 'Lỗi Supabase Auth: ' + authError.message });
      } else {
        // Cập nhật profile bình thường trong table shipper_profiles
        const { error: profileError } = await supabase
          .from('shipper_profiles')
          .update({
            phone: cleanedNewPhone,
            full_name: name,
            cccd: cccd || '',
            avatar_url: avatarUrl
          })
          .eq('id', uuid);

        if (profileError) {
          console.error('[Supabase Error] Lỗi cập nhật profile:', profileError.message);
        }
      }
    }

    // Cập nhật database local JSON
    shipper.name = name;
    shipper.phone = cleanedNewPhone;
    if (email) shipper.email = email;
    shipper.cccd = cccd || ''; // Cập nhật CCCD
    shipper.avatarUrl = avatarUrl; // Cập nhật avatarUrl

    shippers[shipperIndex] = shipper;
    writeShippersDatabase(shippers);

    res.json({ success: true, shipper: { ...shipper, avatarUrl: normalizeImageUrl(shipper.avatarUrl, req) } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * DELETE /api/admin/shippers/:phone
 * Delete shipper from local JSON + Supabase Auth
 */
app.delete('/api/admin/shippers/:phone', authenticateAdmin, async (req, res) => {
  try {
    const { phone } = req.params;
    const cleanedPhone = phone.trim().replace(/\s+/g, '');

    const shippers = readShippersDatabase();
    const idx = shippers.findIndex(s => s.phone.trim().replace(/\s+/g, '') === cleanedPhone);

    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy tài xế!' });
    }

    const target = shippers[idx];
    if (supabase && target.id) {
      // Delete from Auth
      const { error: authError } = await supabase.auth.admin.deleteUser(target.id);
      if (authError) {
        console.error('[Supabase Error] Lỗi xóa Auth user:', authError.message);
      }
      // Delete profile table
      await supabase.from('shipper_profiles').delete().eq('id', target.id);
    }

    shippers.splice(idx, 1);
    writeShippersDatabase(shippers);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/admin/shippers/:phone/approve
 * Manually approve a shipper by phone from CRM Admin
 */
app.post('/api/admin/shippers/:phone/approve', authenticateAdmin, async (req, res) => {
  const { phone } = req.params;
  const forceEmail = !!(req.body && (req.body.forceEmail || req.body.resendEmail));
  const shippersBefore = readShippersDatabase();
  const shipperBefore = shippersBefore.find(s => cleanPhone(s.phone) === cleanPhone(phone));
  const result = await approveShipperAccount(phone, { forceEmail });
  if (result && result.success) {
    const emailNote = result.emailSent
      ? ' — đã gửi email xác nhận Supabase'
      : result.confirmationLink
        ? ' — SMTP fail, đã tạo link thủ công'
        : result.emailError
          ? ` — duyệt OK nhưng gửi email lỗi: ${result.emailError}`
          : result.alreadyApproved
            ? ' (đã duyệt trước đó)'
            : '';
    if (!result.alreadyApproved || result.emailSent || result.confirmationLink) {
      addNotification(
        'shipper_action',
        null,
        shipperBefore?.name || phone,
        'Tài xế đã được duyệt',
        `${shipperBefore?.name || phone} (${phone}) — duyệt qua CRM Admin${emailNote}`
      );
    }
    res.json({
      success: true,
      message: result.emailSent
        ? 'Đã phê duyệt và gửi email xác nhận tới tài xế!'
        : result.confirmationLink
          ? 'Đã phê duyệt. SMTP chưa gửi được — dùng confirmationLink gửi tay cho tài xế.'
          : 'Đã phê duyệt tài xế thành công!',
      emailSent: !!result.emailSent,
      emailError: result.emailError || null,
      emailMethod: result.emailMethod || null,
      confirmationLink: result.confirmationLink || null,
      alreadyApproved: !!result.alreadyApproved
    });
  } else {
    res.status(400).json({ success: false, error: 'Phê duyệt tài xế thất bại hoặc không tìm thấy tài xế!' });
  }
});

/**
 * POST /api/admin/shippers/:phone/resend-approval-email
 * Gửi lại email / lấy link xác nhận cho tài xế đã duyệt (debug SMTP)
 */
app.post('/api/admin/shippers/:phone/resend-approval-email', authenticateAdmin, async (req, res) => {
  try {
    const { phone } = req.params;
    const result = await approveShipperAccount(phone, { forceEmail: true });
    if (!result || !result.success) {
      return res.status(400).json({ success: false, error: 'Không tìm thấy tài xế!' });
    }
    res.json({
      success: true,
      emailSent: !!result.emailSent,
      emailError: result.emailError || null,
      emailMethod: result.emailMethod || null,
      confirmationLink: result.confirmationLink || null,
      message: result.emailSent
        ? 'Đã gửi lại email xác nhận!'
        : result.confirmationLink
          ? 'SMTP chưa gửi được — copy confirmationLink gửi tay.'
          : (result.emailError || 'Không gửi được email')
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/admin/shippers/:phone/reject
 * Từ chối và xóa tài xế chờ duyệt (mirror Telegram reject)
 */
app.post('/api/admin/shippers/:phone/reject', authenticateAdmin, async (req, res) => {
  const { phone } = req.params;
  const success = await rejectShipperAccount(phone);
  if (success) {
    res.json({ success: true, message: 'Đã từ chối và xóa tài xế!' });
  } else {
    res.status(400).json({ success: false, error: 'Từ chối tài xế thất bại hoặc không tìm thấy tài xế!' });
  }
});

/**
 * GET /api/shippers/profile
 * Get specific shipper profile details and approval status by phone number
 */
app.get('/api/shippers/profile', (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) {
      return res.status(400).json({ success: false, error: 'Thiếu số điện thoại!' });
    }
    const shippers = readShippersDatabase();
    const cleanedPhone = phone.trim().replace(/\s+/g, '');
    const shipper = shippers.find(s => s.phone.trim().replace(/\s+/g, '') === cleanedPhone);
    if (!shipper) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy tài xế!' });
    }
    const responseShipper = {
      ...shipper,
      avatarUrl: normalizeImageUrl(shipper.avatarUrl, req)
    };
    res.json({ success: true, shipper: responseShipper });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/admin/restaurants
 * Danh sách quán cho CRM — toàn bộ database, không giới hạn bán kính 3km
 */
app.get('/api/admin/restaurants', authenticateAdmin, (req, res) => {
  try {
    const result = getAdminRestaurantsList({
      page: req.query.page,
      limit: req.query.limit,
      q: req.query.q,
      tab: req.query.tab,
      filterName: req.query.filterName,
      filterCategory: req.query.filterCategory,
      filterStatus: req.query.filterStatus,
      filterMenu: req.query.filterMenu
    });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * PUT /api/admin/restaurants/:id
 * Update restaurant basic info
 */
app.put('/api/admin/restaurants/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, address, category, isClosed } = req.body;
    let found = false;
    let updatedData = null;

    await updateLocalDatabase((restaurants) => {
      const idx = restaurants.findIndex(r => String(r.id) === String(id));
      if (idx !== -1) {
        if (name) restaurants[idx].name = name;
        if (address) restaurants[idx].address = address;
        if (category) restaurants[idx].category = category;
        if (typeof isClosed === 'boolean') {
          restaurants[idx].isClosed = isClosed;
          if (isClosed) {
            restaurants[idx].closedAt = new Date().toISOString();
            restaurants[idx].closedReason = 'Admin đóng cửa thủ công';
          } else {
            delete restaurants[idx].closedAt;
            delete restaurants[idx].closedReason;
          }
        }
        restaurants[idx].updatedAt = Date.now();
        updatedData = restaurants[idx];
        found = true;
        return true; // Save
      }
      return false; // No save if not found
    });

    if (!found) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy quán ăn!' });
    }

    res.json({ success: true, data: updatedData });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * PUT /api/admin/restaurants/:id/menu
 * Update restaurant menu / prices
 */
app.put('/api/admin/restaurants/:id/menu', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { menu } = req.body;

    if (!Array.isArray(menu)) {
      return res.status(400).json({ success: false, error: 'Menu phải là một mảng!' });
    }

    const updatedMenu = menu.map(item => {
      const inStorePrice = Number(item.inStorePrice) || 0;
      const appPrice = calcAppPrice(inStorePrice);
      return {
        ...item,
        inStorePrice,
        appPrice
      };
    });

    writeRestaurantMenu(id, updatedMenu);

    await updateLocalDatabase((restaurants) => {
      const idx = restaurants.findIndex(r => String(r.id) === String(id));
      if (idx !== -1) {
        restaurants[idx].hasRealMenu = true;
        restaurants[idx].menuUpdatedAt = new Date().toISOString();
        restaurants[idx].dishNames = updatedMenu.map(m => m.name).filter(Boolean);
        return true;
      }
      return false;
    });

    res.json({ success: true, data: updatedMenu });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/admin/restaurants/changes
 * Danh sách quán có biến động giá / trạng thái gần đây
 */
app.get('/api/admin/restaurants/changes', authenticateAdmin, (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const data = getRestaurantChangeSummaries(limit);
    const priceCount = data.filter(d => d.type === 'price_change').length;
    const statusCount = data.filter(d => d.type === 'status_change').length;
    res.json({
      success: true,
      data,
      total: data.length,
      priceCount,
      statusCount,
      windowHours: Math.round(RECENT_CHANGE_WINDOW_MS / 3600000),
      unreadTotal: data.filter(d => !d.read || d.unreadCount > 0).length
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/admin/restaurants/sync-status
 * Trạng thái job đồng bộ hàng loạt
 */
app.get('/api/admin/restaurants/sync-status', authenticateAdmin, (req, res) => {
  if (!bulkSyncJob) {
    return res.json({ success: true, running: false, paused: false, total: 0, completed: 0, synced: 0, failed: 0 });
  }
  const elapsedMs = bulkSyncJob.startedAt ? Date.now() - bulkSyncJob.startedAt : 0;
  const processed = bulkSyncJob.completed || 0;
  const avgMs = processed > 0 ? elapsedMs / processed : 0;
  const remainingCount = Math.max(0, bulkSyncJob.total - processed);
  const etaMs = avgMs > 0 ? Math.round(avgMs * remainingCount) : null;

  res.json({
    success: true,
    running: bulkSyncJob.running,
    paused: bulkSyncJob.paused,
    pauseRequested: bulkSyncJob.pauseRequested,
    total: bulkSyncJob.total,
    completed: bulkSyncJob.completed,
    synced: bulkSyncJob.synced || 0,
    failed: bulkSyncJob.failed,
    skipped: bulkSyncJob.skipped || 0,
    remaining: bulkSyncJob.remaining || remainingCount,
    current: bulkSyncJob.current,
    active: (bulkSyncJob.active || []).slice(0, BULK_SYNC_CONCURRENCY),
    etaMs,
    startedAt: bulkSyncJob.startedAt,
    finishedAt: bulkSyncJob.finishedAt,
    pausedAt: bulkSyncJob.pausedAt,
    errors: bulkSyncJob.errors.slice(-10),
    skips: (bulkSyncJob.skips || []).slice(-10),
    fatalError: bulkSyncJob.fatalError || null,
    menuScrapeEnabled: MENU_SCRAPE_ENABLED,
    concurrency: BULK_SYNC_CONCURRENCY
  });
});

/**
 * POST /api/admin/restaurants/sync-pause
 * Tạm dừng job đồng bộ hàng loạt (hoàn tất quán đang xử lý rồi dừng)
 */
app.post('/api/admin/restaurants/sync-pause', authenticateAdmin, (req, res) => {
  if (!bulkSyncJob?.running) {
    return res.json({ success: false, error: 'Không có tiến trình đồng bộ đang chạy.' });
  }
  if (bulkSyncJob.pauseRequested) {
    return res.json({ success: true, message: 'Đã gửi yêu cầu tạm dừng trước đó.' });
  }
  bulkSyncJob.pauseRequested = true;
  res.json({
    success: true,
    message: 'Đang tạm dừng... Hoàn tất quán hiện tại rồi dừng.',
    completed: bulkSyncJob.completed,
    total: bulkSyncJob.total
  });
});

/**
 * POST /api/admin/restaurants/sync-resume
 * Tiếp tục job đồng bộ đã tạm dừng
 */
app.post('/api/admin/restaurants/sync-resume', authenticateAdmin, async (req, res) => {
  try {
    if (bulkSyncJob?.running) {
      return res.json({ success: false, error: 'Đồng bộ đang chạy.' });
    }
    if (!bulkSyncJob?.paused || !bulkSyncJob.restaurants?.length) {
      return res.json({ success: false, error: 'Không có job tạm dừng để tiếp tục.' });
    }
    if (!MENU_SCRAPE_ENABLED) {
      return res.status(503).json({
        success: false,
        error: 'Menu scrape đang tắt trên server (ENABLE_MENU_SCRAPE=true để bật).'
      });
    }

    const startIdx = bulkSyncJob.completed;
    const restaurants = bulkSyncJob.restaurants;
    const remaining = bulkSyncJob.total - startIdx;

    runBulkRestaurantSync(restaurants, startIdx).catch(err => {
      console.error('[Bulk Sync] Lỗi resume:', err.message);
      if (bulkSyncJob) {
        bulkSyncJob.running = false;
        bulkSyncJob.finishedAt = Date.now();
      }
    });

    res.json({
      success: true,
      message: `Tiếp tục đồng bộ ${remaining} quán còn lại.`,
      remaining,
      completed: startIdx,
      total: bulkSyncJob.total
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/admin/restaurants/sync-all
 * Kích hoạt đồng bộ ShopeeFood và lưu ngay vào database
 * Body: { scope: 'all' | 'changed' }
 */
app.post('/api/admin/restaurants/sync-all', authenticateAdmin, async (req, res) => {
  try {
    if (bulkSyncJob?.running) {
      return res.json({ success: false, error: 'Đồng bộ hàng loạt đang chạy. Dùng Tạm dừng nếu cần dừng.' });
    }

    if (!MENU_SCRAPE_ENABLED) {
      return res.status(503).json({
        success: false,
        error: 'Menu scrape đang tắt trên server (ENABLE_MENU_SCRAPE=true để bật).'
      });
    }

    const scope = req.body?.scope === 'changed' ? 'changed' : 'all';
    let restaurants = [];

    if (scope === 'changed') {
      const { isGenericBrandPortal } = require('./slugMap');
      const changes = getRestaurantChangeSummaries(200);
      restaurants = changes
        .map(c => findRestaurantById(c.restaurantId))
        .filter(r => r && r.id && !r.isBrandPortal && !isGenericBrandPortal(r.name, r.address));
    } else {
      restaurants = dbHelper.read().filter(r => r && r.id);
    }

    if (restaurants.length === 0) {
      return res.json({ success: false, error: scope === 'changed' ? 'Không có quán nào có biến động.' : 'Không có quán trong database.' });
    }

    runBulkRestaurantSync(restaurants).catch(err => {
      console.error('[Bulk Sync] Lỗi job:', err.message);
      if (bulkSyncJob) {
        bulkSyncJob.running = false;
        bulkSyncJob.finishedAt = Date.now();
      }
    });

    res.json({
      success: true,
      message: `Đã bắt đầu đồng bộ ${restaurants.length} quán với ShopeeFood. Dữ liệu sẽ được lưu ngay sau mỗi quán.`,
      total: restaurants.length,
      scope
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/admin/restaurants/:id/sync-price
 * Trigger manual ShopeeFood scraper for a restaurant (đồng bộ + lưu ngay)
 */
app.post('/api/admin/restaurants/:id/sync-price', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const found = findRestaurantById(id);

    if (!found) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy quán ăn!' });
    }

    if (!MENU_SCRAPE_ENABLED) {
      return res.status(503).json({
        success: false,
        error: 'Menu scrape đang tắt trên server (ENABLE_MENU_SCRAPE=true để bật).'
      });
    }

    if (found._isScraping) {
      return res.json({ success: true, message: 'Tiến trình đồng bộ đang chạy cho quán này!' });
    }

    const updated = await triggerSyncMenuScrape(found);
    const menu = readRestaurantMenu(id) || updated?.menu || [];
    const menuCount = Array.isArray(menu) ? menu.length : 0;

    res.json({
      success: true,
      message: menuCount > 0
        ? `Đã đồng bộ & lưu ${menuCount} món từ ShopeeFood.`
        : (updated?.isClosed
          ? 'Quán đang đóng cửa trên ShopeeFood — trạng thái đã lưu.'
          : 'Đồng bộ xong nhưng không lấy được menu mới.'),
      menuCount,
      isClosed: !!updated?.isClosed,
      menuUpdatedAt: updated?.menuUpdatedAt || null
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/admin/customers
 * Extract customer list from orders
 */
app.get('/api/admin/customers', authenticateAdmin, (req, res) => {
  try {
    const orders = readOrdersDatabase();
    const customerMap = new Map();
    
    orders.forEach(o => {
      const phone = o.deliveryPhone || o.ordererPhone;
      if (!phone) return;
      if (!customerMap.has(phone)) {
        customerMap.set(phone, {
          name: o.deliveryName || '—',
          phone,
          address: o.deliveryAddress || '',
          ordersCount: 0,
          totalSpent: 0
        });
      }
      const c = customerMap.get(phone);
      c.ordersCount++;
      c.totalSpent += (o.appTotal || 0);
    });
    
    res.json({ success: true, data: Array.from(customerMap.values()) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/admin/orders
 * List orders with filter, search, pagination
 */
app.get('/api/admin/orders', authenticateAdmin, (req, res) => {
  try {
    const { status, q, from, to, page = '1', limit = '50' } = req.query;
    const orders = readOrdersDatabase();
    const filtered = filterAdminOrders(orders, { status, q, from, to });
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const start = (pageNum - 1) * limitNum;
    const slice = filtered.slice(start, start + limitNum);

    res.json({
      success: true,
      data: slice,
      total: filtered.length,
      page: pageNum,
      limit: limitNum,
      hasMore: start + limitNum < filtered.length
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/admin/orders/export
 * Export filtered orders as CSV
 */
app.get('/api/admin/orders/export', authenticateAdmin, (req, res) => {
  try {
    const { status, q, from, to } = req.query;
    const orders = readOrdersDatabase();
    const filtered = filterAdminOrders(orders, { status, q, from, to });
    const headers = ['id', 'status', 'restaurantName', 'deliveryName', 'deliveryPhone', 'shipperName', 'shipperPhone', 'appTotal', 'storeTotal', 'shipperEarning', 'createdAt'];
    const rows = filtered.map(o => [
      o.id,
      o.status,
      o.restaurantName,
      o.deliveryName,
      o.deliveryPhone,
      o.shipperName,
      o.shipperPhone,
      o.appTotal,
      o.storeTotal,
      o.shipperEarning,
      o.createdAt ? new Date(o.createdAt).toISOString() : ''
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.map(escapeCsvCell).join(','))].join('\r\n');
    const filename = `shipfee-orders-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + csv);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/admin/orders/stats
 * Return orders and revenue statistics grouped by date
 */
app.get('/api/admin/orders/stats', authenticateAdmin, (req, res) => {
  try {
    const orders = readOrdersDatabase();
    const completed = orders.filter(o => o.status === 'DELIVERED');
    
    const dailyStats = {};
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const dateStr = d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
      dailyStats[dateStr] = { revenue: 0, ordersCount: 0 };
    }
    
    completed.forEach(o => {
      if (o.createdAt) {
        const dateStr = new Date(o.createdAt).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
        if (dailyStats[dateStr]) {
          dailyStats[dateStr].revenue += (o.appTotal || 0);
          dailyStats[dateStr].ordersCount++;
        }
      }
    });
    
    res.json({
      success: true,
      data: {
        totalOrders: orders.length,
        completedCount: completed.length,
        daily: Object.entries(dailyStats).map(([date, val]) => ({ date, ...val }))
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/admin/pricing-config
 * Lấy cấu hình pricing hiện tại (Markup %, giảm giá đơn 2)
 */
app.get('/api/admin/pricing-config', authenticateAdmin, (req, res) => {
  res.json({ success: true, data: pricingConfig });
});

/**
 * POST /api/admin/pricing-config
 * Cập nhật cấu hình pricing đầy đủ
 */
app.post('/api/admin/pricing-config', authenticateAdmin, crm.requireAdminRole('admin'), (req, res) => {
  try {
    const {
      markupRate,
      secondOrderDiscountRate,
      freeDistanceKm,
      surchargeCoefficient,
      minShipperEarning,
      multiItemDiscount,
      telegramConfig
    } = req.body;
    
    if (typeof markupRate === 'number') {
      pricingConfig.markupRate = markupRate;
    }
    if (typeof secondOrderDiscountRate === 'number') {
      pricingConfig.secondOrderDiscountRate = secondOrderDiscountRate;
    }
    if (typeof freeDistanceKm === 'number') {
      pricingConfig.freeDistanceKm = freeDistanceKm;
    }
    if (typeof surchargeCoefficient === 'number') {
      pricingConfig.surchargeCoefficient = surchargeCoefficient;
    }
    if (typeof minShipperEarning === 'number') {
      pricingConfig.minShipperEarning = minShipperEarning;
    }
    if (typeof multiItemDiscount === 'number') {
      pricingConfig.multiItemDiscount = multiItemDiscount;
    }
    if (telegramConfig && typeof telegramConfig === 'object') {
      pricingConfig.telegramConfig = {
        ...(pricingConfig.telegramConfig || {}),
        ...telegramConfig
      };
    }

    fs.writeFileSync(PRICING_CONFIG_FILE, JSON.stringify(pricingConfig, null, 2), 'utf8');
    if (telegramBot) telegramBot.restartPeriodicReport();
    crm.logAdminAudit(req, 'pricing_update', { pricingConfig });
    console.log('[Pricing Config] Admin đã cập nhật cấu hình:', pricingConfig);
    res.json({ success: true, data: pricingConfig });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/admin/db/sync-to-supabase
 * Đồng bộ hàng loạt toàn bộ quán ăn có menu thực tế lên Supabase (chạy background)
 */
app.post('/api/admin/db/sync-to-supabase', authenticateAdmin, (req, res) => {
  if (!supabase) {
    return res.status(500).json({ success: false, message: 'Supabase chưa được cấu hình trên server.' });
  }

  res.json({ success: true, message: 'Tiến trình đồng bộ hàng loạt lên Supabase đã được bắt đầu ở background.' });

  // Khởi chạy tiến trình đồng bộ ngầm để tránh gateway timeout
  (async () => {
    console.log('[Supabase Bulk Sync] 🚀 Bắt đầu đồng bộ hàng loạt quán ăn có menu thực tế lên Supabase...');
    try {
      const allRestaurants = dbHelper.read();
      const realRests = allRestaurants.filter(r => r && r.hasRealMenu === true);
      console.log(`[Supabase Bulk Sync] Tìm thấy ${realRests.length} quán có menu thực tế cần đồng bộ.`);

      let successCount = 0;
      let errorCount = 0;

      // Chia nhỏ thành các mẻ (batch) 50 quán để tối ưu đường truyền API
      const BATCH_SIZE = 50;
      for (let i = 0; i < realRests.length; i += BATCH_SIZE) {
        const batch = realRests.slice(i, i + BATCH_SIZE);
        const upsertData = [];

        for (const r of batch) {
          let menu = [];
          const menuFilePath = getMenuFilePath(r.id);
          if (fs.existsSync(menuFilePath)) {
            try {
              const raw = fs.readFileSync(menuFilePath, 'utf8');
              menu = JSON.parse(raw) || [];
            } catch (e) {}
          }

          upsertData.push({
            id: r.id,
            name: r.name,
            address: r.address || '',
            lat: r.lat,
            lon: r.lon,
            rating: r.rating || 4.5,
            image_url: r.image_url || '',
            is_closed: r.isClosed || false,
            closed_reason: r.closedReason || '',
            has_real_menu: r.hasRealMenu || false,
            dish_names: r.dishNames || [],
            menu: menu, // Lưu gộp menu dạng jsonb để truy cập siêu tốc
            updated_at: new Date().toISOString()
          });
        }

        const { error } = await supabase
          .from('restaurants')
          .upsert(upsertData, { onConflict: 'id' });

        if (error) {
          console.error(`[Supabase Bulk Sync] Lỗi upsert batch ${i}-${i + batch.length}:`, error.message);
          errorCount += batch.length;
        } else {
          successCount += batch.length;
          console.log(`[Supabase Bulk Sync] Đã đồng bộ thành công ${successCount}/${realRests.length} quán.`);
        }

        // Delay nhẹ để tránh bị giới hạn băng thông (rate limit)
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      console.log(`[Supabase Bulk Sync] 🏁 Hoàn tất đồng bộ! Thành công: ${successCount}, Thất bại: ${errorCount}`);
    } catch (err) {
      console.error('[Supabase Bulk Sync] Lỗi nghiêm trọng:', err.message);
    }
  })();
});

/**
 * POST /api/admin/orders/:id/assign
 * Admin chỉ định gán đơn hàng cho một tài xế cụ thể (chỉ PENDING)
 */
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

    upsertOrderToSupabase(updatedOrder).catch(() => {});
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

    upsertOrderToSupabase(updatedOrder).catch(() => {});
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

    upsertOrderToSupabase(updatedOrder).catch(() => {});
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

    upsertOrderToSupabase(updatedOrder).catch(() => {});
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

/**
 * POST /api/admin/restaurants/:id/toggle-status
 * Bật/Tắt trạng thái hoạt động của quán (OPEN/CLOSED)
 */
app.post('/api/admin/restaurants/:id/toggle-status', authenticateAdmin, async (req, res) => {
  try {
    const restId = req.params.id;
    const { status } = req.body;
    if (!status || !['OPEN', 'CLOSED'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Trạng thái hoạt động không hợp lệ!' });
    }

    const isClosed = status === 'CLOSED';
    let updatedRestaurant = null;

    await updateLocalDatabase((restaurants) => {
      const idx = restaurants.findIndex(r => String(r.id) === String(restId));
      if (idx === -1) return false;
      restaurants[idx].isClosed = isClosed;
      if (isClosed) {
        restaurants[idx].closedAt = new Date().toISOString();
        restaurants[idx].closedReason = 'Admin đóng cửa thủ công';
      } else {
        delete restaurants[idx].closedAt;
        delete restaurants[idx].closedReason;
      }
      restaurants[idx].updatedAt = Date.now();
      updatedRestaurant = restaurants[idx];
      return true;
    });

    if (!updatedRestaurant) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy quán ăn!' });
    }

    console.log(`[Admin Restaurant] 🏪 Admin đã đổi trạng thái quán "${updatedRestaurant.name}" sang ${status} (isClosed=${isClosed})`);
    res.json({ success: true, status, isClosed, data: updatedRestaurant });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/admin/restaurants/:id/menu/:itemId/toggle-availability
 * Bật/Tắt món ăn của quán (available true/false)
 */
app.post('/api/admin/restaurants/:id/menu/:itemId/toggle-availability', authenticateAdmin, async (req, res) => {
  try {
    const restId = req.params.id;
    const itemId = req.params.itemId;
    const { available } = req.body;
    if (typeof available !== 'boolean') {
      return res.status(400).json({ success: false, error: 'Trạng thái món ăn phải là boolean!' });
    }

    const menu = readRestaurantMenu(restId);
    const idx = menu.findIndex(m => m.id === itemId || m.name === itemId);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy món ăn trong thực đơn!' });
    }

    menu[idx].available = available;
    writeRestaurantMenu(restId, menu);

    await updateLocalDatabase((restaurants) => {
      const rIdx = restaurants.findIndex(r => String(r.id) === String(restId));
      if (rIdx === -1) return false;
      restaurants[rIdx].dishNames = menu.map(m => m.name).filter(Boolean);
      restaurants[rIdx].updatedAt = Date.now();
      return true;
    });

    console.log(`[Admin Menu] 🍔 Admin đã đổi trạng thái món "${menu[idx].name}" tại quán "${restId}" sang ${available ? 'Còn món' : 'Hết món'}`);
    res.json({ success: true, itemId: itemId, available: available });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/admin/crawl-queue
 * Danh sách quán cần kiểm tra lại (tạm đóng) + quán cần cào menu thực tế
 */
app.get('/api/admin/crawl-queue', authenticateAdmin, (req, res) => {
  try {
    const all = cachedRestaurants.length > 0 ? cachedRestaurants : dbHelper.read();
    
    // Phân loại quán đóng cửa
    const tempClosed = []; // Tạm đóng — cần kiểm tra lại
    const permClosed = []; // Đóng hẳn
    const needMenu = [];   // Còn hoạt động nhưng chưa có menu thực tế
    
    all.forEach(r => {
      if (r.isClosed) {
        if (r.closedReason && (r.closedReason.includes('permanently') || r.closedReason.includes('vĩnh viễn'))) {
          permClosed.push({ id: r.id, name: r.name, closedAt: r.closedAt, reason: r.closedReason });
        } else {
          tempClosed.push({ id: r.id, name: r.name, closedAt: r.closedAt, reason: r.closedReason || 'Không rõ', crawlNextAttempt: r.crawlNextAttempt });
        }
      } else if (!r.hasRealMenu) {
        needMenu.push({ id: r.id, name: r.name, menuTemplateFallback: !!r.menuTemplateFallback, dishCount: (r.dishNames || []).length });
      }
    });

    res.json({
      success: true,
      summary: {
        total: all.length,
        active: all.length - tempClosed.length - permClosed.length,
        tempClosed: tempClosed.length,
        permClosed: permClosed.length,
        needRealMenu: needMenu.length,
        hasRealMenu: all.filter(r => r.hasRealMenu && !r.isClosed).length
      },
      tempClosed: tempClosed.slice(0, 100),
      permClosed: permClosed.slice(0, 50),
      needMenu: needMenu.slice(0, 100)
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/admin/menus/reconcile
 * Đối chiếu menu Supabase: promote scraped thật, demote template gắn nhầm real
 */
app.post('/api/admin/menus/reconcile', authenticateAdmin, async (req, res) => {
  try {
    const result = await reconcileMenuFlagsFromSupabase({
      maxPages: Math.min(400, parseInt(req.body?.maxPages, 10) || 250),
      pageSize: Math.min(50, parseInt(req.body?.pageSize, 10) || 40)
    });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── WAVE 2/3 CRM: Analytics, Audit, Promos, Zones, Blacklist, Disputes, Settlement ──

/**
 * POST /api/promos/validate
 * Public — validate promo code before checkout
 */
app.post('/api/promos/validate', (req, res) => {
  try {
    const { code, subtotal } = req.body || {};
    const result = crm.validatePromo(code, Number(subtotal) || 0);
    if (!result.valid) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.json({
      success: true,
      data: {
        code: result.promo.code,
        type: result.promo.type,
        discount: result.discount
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/admin/analytics', authenticateAdmin, (req, res) => {
  try {
    const range = req.query.range || '7d';
    const orders = readOrdersDatabase();
    const shippers = readShippersDatabase();
    res.json({ success: true, data: crm.computeAnalytics(orders, shippers, range) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/admin/audit-log', authenticateAdmin, crm.requireAdminRole('admin', 'ops'), (req, res) => {
  try {
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 100);
    res.json({ success: true, data: crm.readAuditLog(limit) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/admin/shippers/export', authenticateAdmin, (req, res) => {
  try {
    const { from, to } = req.query;
    const orders = readOrdersDatabase();
    const shippers = readShippersDatabase();
    const payouts = crm.computeShipperPayouts(orders, shippers, from, to);
    const headers = ['phone', 'name', 'orders', 'earnings'];
    const rows = payouts.map(p => [p.phone, p.name, p.orders, p.earnings]);
    const csv = [headers.join(','), ...rows.map(r => r.map(crm.escapeCsvCell).join(','))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="shipfee-shipper-payouts.csv"`);
    res.send('\uFEFF' + csv);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/admin/promos', authenticateAdmin, (req, res) => {
  res.json({ success: true, data: crm.readPromos() });
});

app.post('/api/admin/promos', authenticateAdmin, crm.requireAdminRole('admin', 'ops'), (req, res) => {
  try {
    const { code, type, value, minOrder, maxUses, maxDiscount, expiresAt, active } = req.body || {};
    if (!code || !type) {
      return res.status(400).json({ success: false, error: 'Thiếu code hoặc type' });
    }
    const promos = crm.readPromos();
    if (promos.some(p => p.code.toUpperCase() === String(code).trim().toUpperCase())) {
      return res.status(400).json({ success: false, error: 'Mã đã tồn tại' });
    }
    const promo = {
      code: String(code).trim().toUpperCase(),
      type,
      value: Number(value) || 0,
      minOrder: minOrder != null ? Number(minOrder) : 0,
      maxUses: maxUses != null ? Number(maxUses) : null,
      maxDiscount: maxDiscount != null ? Number(maxDiscount) : null,
      usedCount: 0,
      active: active !== false,
      expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
      createdAt: Date.now()
    };
    promos.unshift(promo);
    crm.writePromos(promos);
    crm.logAdminAudit(req, 'promo_create', { code: promo.code });
    res.json({ success: true, data: promo });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.put('/api/admin/promos/:code', authenticateAdmin, crm.requireAdminRole('admin', 'ops'), (req, res) => {
  try {
    const code = String(req.params.code).trim().toUpperCase();
    const promos = crm.readPromos();
    const idx = promos.findIndex(p => p.code === code);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Không tìm thấy mã' });
    const body = req.body || {};
    ['type', 'value', 'minOrder', 'maxUses', 'maxDiscount', 'active'].forEach(k => {
      if (body[k] !== undefined) promos[idx][k] = body[k];
    });
    if (body.expiresAt !== undefined) {
      promos[idx].expiresAt = body.expiresAt ? new Date(body.expiresAt).getTime() : null;
    }
    crm.writePromos(promos);
    crm.logAdminAudit(req, 'promo_update', { code });
    res.json({ success: true, data: promos[idx] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/admin/delivery-zones', authenticateAdmin, (req, res) => {
  res.json({ success: true, data: crm.readZones() });
});

app.post('/api/admin/delivery-zones', authenticateAdmin, crm.requireAdminRole('admin', 'ops'), (req, res) => {
  try {
    const { name, centerLat, centerLon, radiusKm, active } = req.body || {};
    if (!name || typeof centerLat !== 'number' || typeof centerLon !== 'number') {
      return res.status(400).json({ success: false, error: 'Thiếu tên hoặc tọa độ trung tâm' });
    }
    const zones = crm.readZones();
    const zone = {
      id: 'zone-' + Date.now(),
      name,
      centerLat,
      centerLon,
      radiusKm: Number(radiusKm) || 3,
      active: active !== false,
      createdAt: Date.now()
    };
    zones.push(zone);
    crm.writeZones(zones);
    crm.logAdminAudit(req, 'zone_create', { id: zone.id, name });
    res.json({ success: true, data: zone });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/admin/delivery-zones/:id', authenticateAdmin, crm.requireAdminRole('admin', 'ops'), (req, res) => {
  try {
    const zones = crm.readZones().filter(z => z.id !== req.params.id);
    crm.writeZones(zones);
    crm.logAdminAudit(req, 'zone_delete', { id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/admin/blacklist', authenticateAdmin, (req, res) => {
  res.json({ success: true, data: crm.readBlacklist() });
});

app.post('/api/admin/blacklist', authenticateAdmin, crm.requireAdminRole('admin', 'ops'), (req, res) => {
  try {
    const { phone, reason } = req.body || {};
    const cleaned = crm.cleanPhone(phone);
    if (!cleaned) return res.status(400).json({ success: false, error: 'Thiếu SĐT' });
    const list = crm.readBlacklist();
    if (list.some(b => crm.cleanPhone(b.phone) === cleaned)) {
      return res.status(400).json({ success: false, error: 'SĐT đã có trong blacklist' });
    }
    const entry = {
      phone: cleaned,
      reason: reason || 'Không nêu lý do',
      blacklistedAt: Date.now(),
      blacklistedBy: req.user?.email || 'admin'
    };
    list.unshift(entry);
    crm.writeBlacklist(list);
    crm.logAdminAudit(req, 'blacklist_add', { phone: cleaned, reason: entry.reason });
    res.json({ success: true, data: entry });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/admin/blacklist/:phone', authenticateAdmin, crm.requireAdminRole('admin', 'ops'), (req, res) => {
  try {
    const phone = crm.cleanPhone(req.params.phone);
    const list = crm.readBlacklist().filter(b => crm.cleanPhone(b.phone) !== phone);
    crm.writeBlacklist(list);
    crm.logAdminAudit(req, 'blacklist_remove', { phone });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/admin/disputes', authenticateAdmin, (req, res) => {
  try {
    const status = req.query.status;
    let list = crm.readDisputes();
    if (status) list = list.filter(d => d.status === status);
    res.json({ success: true, data: list });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/admin/shipper-support
 * Danh sách thread chat hỗ trợ từ tài xế
 */
app.get('/api/admin/shipper-support', authenticateAdmin, (req, res) => {
  try {
    const status = req.query.status;
    let list = crm.readShipperSupportThreads();
    if (status) list = list.filter(t => t.status === status);
    list = list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    res.json({ success: true, data: list });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/admin/shipper-support/:id/messages
 * CRM trả lời tài xế
 */
app.post('/api/admin/shipper-support/:id/messages', authenticateAdmin, crm.requireAdminRole('admin', 'ops'), async (req, res) => {
  try {
    const { text } = req.body || {};
    const cleanedText = String(text || '').trim();
    if (!cleanedText) {
      return res.status(400).json({ success: false, error: 'Thiếu nội dung tin nhắn' });
    }
    const updated = crm.appendShipperSupportMessage(req.params.id, {
      sender: 'admin',
      role: 'admin',
      text: cleanedText,
      adminEmail: req.user?.email || 'admin'
    });
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy thread' });
    }

    // Đồng bộ sang chat đơn hàng để tài xế thấy trong quick chat
    if (updated.orderId) {
      await updateOrdersDatabase((orders) => {
        const idx = orders.findIndex(o => o.id === updated.orderId);
        if (idx === -1) return false;
        orders[idx].messages = orders[idx].messages || [];
        orders[idx].messages.push({
          sender: 'Admin',
          role: 'admin',
          text: cleanedText,
          timestamp: Date.now()
        });
        return true;
      });
    }

    crm.markShipperSupportRead(updated.id, 'admin');
    crm.logAdminAudit(req, 'shipper_support_message', {
      threadId: updated.id,
      shipperPhone: updated.shipperPhone,
      text: cleanedText.slice(0, 80)
    });
    res.json({
      success: true,
      data: crm.readShipperSupportThreads().find(t => t.id === updated.id) || updated
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/admin/shipper-support/:id/resolve
 */
app.post('/api/admin/shipper-support/:id/resolve', authenticateAdmin, crm.requireAdminRole('admin', 'ops'), (req, res) => {
  try {
    const resolved = crm.resolveShipperSupportThread(req.params.id, { by: req.user?.email || 'admin' });
    if (!resolved) return res.status(404).json({ success: false, error: 'Không tìm thấy thread' });
    crm.logAdminAudit(req, 'shipper_support_resolve', { threadId: req.params.id });
    res.json({ success: true, data: resolved });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/admin/shipper-support/:id/read
 */
app.post('/api/admin/shipper-support/:id/read', authenticateAdmin, (req, res) => {
  try {
    const updated = crm.markShipperSupportRead(req.params.id, 'admin');
    if (!updated) return res.status(404).json({ success: false, error: 'Không tìm thấy thread' });
    res.json({ success: true, data: updated });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/disputes', authenticateAdmin, crm.requireAdminRole('admin', 'ops'), (req, res) => {
  try {
    const { orderId, reason } = req.body || {};
    if (!orderId) return res.status(400).json({ success: false, error: 'Thiếu orderId' });
    const orders = readOrdersDatabase();
    const order = orders.find(o => o.id === orderId);
    if (!order) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn' });
    const disputes = crm.readDisputes();
    const ticket = {
      id: 'disp-' + Date.now(),
      orderId,
      status: 'open',
      reason: reason || 'Khiếu nại từ admin',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    disputes.unshift(ticket);
    crm.writeDisputes(disputes);
    crm.logAdminAudit(req, 'dispute_create', { disputeId: ticket.id, orderId });
    if (telegramBot) {
      telegramBot.sendDisputeNotification(ticket).catch(e => console.error('Lỗi Telegram dispute:', e.message));
    }
    res.json({ success: true, data: ticket });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/disputes/:id/messages', authenticateAdmin, crm.requireAdminRole('admin', 'ops'), async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ success: false, error: 'Thiếu nội dung' });
    const disputes = crm.readDisputes();
    const idx = disputes.findIndex(d => d.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Không tìm thấy ticket' });
    const msg = {
      role: 'admin',
      sender: req.user?.email || 'admin',
      text,
      createdAt: Date.now()
    };
    disputes[idx].messages = disputes[idx].messages || [];
    disputes[idx].messages.push(msg);
    disputes[idx].updatedAt = Date.now();
    crm.writeDisputes(disputes);

    const orderId = disputes[idx].orderId;
    await updateOrdersDatabase((orders) => {
      const oIdx = orders.findIndex(o => o.id === orderId);
      if (oIdx !== -1) {
        orders[oIdx].messages = orders[oIdx].messages || [];
        orders[oIdx].messages.push({ sender: 'Admin', text, timestamp: Date.now() });
      }
    });

    res.json({ success: true, data: disputes[idx] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/disputes/:id/resolve', authenticateAdmin, crm.requireAdminRole('admin', 'ops'), (req, res) => {
  try {
    const disputes = crm.readDisputes();
    const idx = disputes.findIndex(d => d.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Không tìm thấy ticket' });
    disputes[idx].status = 'resolved';
    disputes[idx].resolvedAt = Date.now();
    disputes[idx].updatedAt = Date.now();
    crm.writeDisputes(disputes);
    crm.logAdminAudit(req, 'dispute_resolve', { disputeId: req.params.id });
    res.json({ success: true, data: disputes[idx] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/orders/:id/messages', authenticateAdmin, crm.requireAdminRole('admin', 'ops'), async (req, res) => {
  try {
    const orderId = req.params.id;
    const { text } = req.body || {};
    const cleanedText = String(text || '').trim();
    if (!cleanedText) return res.status(400).json({ success: false, error: 'Thiếu nội dung tin nhắn' });
    let updatedOrder = null;
    await updateOrdersDatabase((orders) => {
      const idx = orders.findIndex(o => o.id === orderId);
      if (idx === -1) return false;
      orders[idx].messages = orders[idx].messages || [];
      orders[idx].messages.push({
        sender: 'Admin',
        role: 'admin',
        text: cleanedText,
        timestamp: Date.now()
      });
      updatedOrder = orders[idx];
      return true;
    });
    if (!updatedOrder) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn' });

    // Đồng bộ sang thread CRM Support để tài xế nhận trong app shipper
    const shipperPhone = cleanPhone(updatedOrder.shipperPhone || updatedOrder.assignedShipperPhone);
    if (shipperPhone) {
      const shippers = readShippersDatabase();
      const shipper = shippers.find(s => cleanPhone(s.phone) === shipperPhone);
      if (shipper) {
        const thread = crm.getOrCreateShipperSupportThread(shipper, { orderId, priority: 'normal' });
        if (thread) {
          crm.appendShipperSupportMessage(thread.id, {
            sender: 'admin',
            role: 'admin',
            text: cleanedText,
            adminEmail: req.user?.email || 'admin'
          });
        }
      }
    }

    crm.logAdminAudit(req, 'order_message', { orderId, text: cleanedText.slice(0, 80) });
    res.json({ success: true, data: updatedOrder.messages });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/admin/commissions', authenticateAdmin, (req, res) => {
  res.json({ success: true, data: crm.readCommissions() });
});

app.post('/api/admin/commissions', authenticateAdmin, crm.requireAdminRole('admin'), (req, res) => {
  try {
    const { defaultRate, restaurants } = req.body || {};
    const cfg = crm.readCommissions();
    if (typeof defaultRate === 'number') cfg.defaultRate = defaultRate;
    if (restaurants && typeof restaurants === 'object') cfg.restaurants = restaurants;
    crm.writeCommissions(cfg);
    crm.logAdminAudit(req, 'commission_update', cfg);
    res.json({ success: true, data: cfg });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/admin/settlements/report', authenticateAdmin, (req, res) => {
  try {
    const { from, to } = req.query;
    const orders = readOrdersDatabase();
    res.json({ success: true, data: crm.computeSettlementReport(orders, from, to) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/admin/data-stats
 * Thống kê nhanh tình trạng dữ liệu quán và menu
 */
app.get('/api/admin/data-stats', authenticateAdmin, (req, res) => {
  try {
    const all = cachedRestaurants.length > 0 ? cachedRestaurants : dbHelper.read();
    const closed = all.filter(r => r.isClosed).length;
    const active = all.length - closed;
    const hasReal = all.filter(r => r.hasRealMenu && !r.isClosed).length;
    const fallback = all.filter(r => !r.hasRealMenu && !r.isClosed).length;
    
    res.json({
      success: true,
      stats: {
        totalRestaurants: all.length,
        activeRestaurants: active,
        closedRestaurants: closed,
        closedPercent: ((closed / all.length) * 100).toFixed(1) + '%',
        withRealMenu: hasReal,
        withFallbackMenu: fallback,
        menuCoverage: ((hasReal / active) * 100).toFixed(1) + '%'
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/status
 * Health check + trạng thái cache
 */
app.get('/api/status', (req, res) => {
  let cacheInfo = null;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      const ageMs  = Date.now() - data.timestamp;
      const ageMins = Math.round(ageMs / 60000);
      cacheInfo = {
        valid:       ageMs < CACHE_DURATION,
        ageMinutes:  ageMins,
        restaurants: data.restaurants?.length || 0,
        expiresIn:   Math.max(0, Math.round((CACHE_DURATION - ageMs) / 60000)) + ' phút'
      };
    }
  } catch {}

  const mem = process.memoryUsage();
  res.json({
    status:  'online',
    version: '1.0.0',
    city:    'Cần Thơ',
    cache:   cacheInfo,
    restaurantsInMemory: cachedRestaurants.length,
    nearbyCacheEntries: nearbyListCache.size,
    menuScrapeEnabled: MENU_SCRAPE_ENABLED,
    isRender: IS_RENDER,
    supabase: {
      configured: !!supabase,
      urlConfigured: !!(SUPABASE_URL && SUPABASE_URL !== 'your_supabase_url_here')
    },
    telegram: {
      tokenConfigured: !!process.env.TELEGRAM_BOT_TOKEN,
      chatConfigured: !!process.env.TELEGRAM_CHAT_ID,
      ...(telegramBot && typeof telegramBot.getStatus === 'function' ? telegramBot.getStatus() : { pollingActive: false })
    },
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024)
    },
    endpoints: {
      restaurants:  '/api/restaurants',
      clearCache:   'POST /api/cache/clear',
      webApp:       '/app/index.html'
    }
  });
});

/**
 * GET /api/webrtc/ice-servers
 * Trả về danh sách ICE/TURN servers động cho WebRTC
 */
let cachedIceServers = null;
let cachedIceServersExpiry = 0;

app.get('/api/webrtc/ice-servers', async (req, res) => {
  // Trả về cache nếu còn hạn
  if (cachedIceServers && Date.now() < cachedIceServersExpiry) {
    return res.json(cachedIceServers);
  }

  // 1. Kiểm tra METERED_API_KEY
  const meteredApiKey = process.env.METERED_API_KEY;
  if (meteredApiKey) {
    try {
      console.log('[WebRTC] Requesting fresh TURN credentials from Metered.ca...');
      const apiFetch = globalThis.fetch || fetch;
      const meteredResponse = await apiFetch(`https://openrelay.metered.ca/api/v1/turn/credentials?apiKey=${meteredApiKey}`);
      if (meteredResponse.ok) {
        const data = await meteredResponse.json();
        if (Array.isArray(data)) {
          cachedIceServers = data;
          cachedIceServersExpiry = Date.now() + 5 * 60 * 1000; // Cache 5 phút
          console.log('[WebRTC] Successfully loaded TURN servers from Metered.ca');
          return res.json(data);
        }
      }
      console.warn('[WebRTC] Metered.ca API responded with status:', meteredResponse.status);
    } catch (e) {
      console.error('[WebRTC] Failed to fetch TURN credentials from Metered.ca:', e);
    }
  }

  // 2. Kiểm tra TURN_USERNAME và TURN_CREDENTIAL tĩnh
  const turnUsername = process.env.TURN_USERNAME;
  const turnCredential = process.env.TURN_CREDENTIAL || process.env.TURN_PASSWORD;
  const turnUrls = (process.env.TURN_URLS || '')
    .split(',')
    .map(url => url.trim())
    .filter(Boolean);

  if (turnUsername && turnCredential && turnUrls.length > 0) {
    const configuredTurnServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      ...turnUrls.map(url => ({
        urls: url,
        username: turnUsername,
        credential: turnCredential
      }))
    ];
    cachedIceServers = configuredTurnServers;
    cachedIceServersExpiry = Date.now() + 5 * 60 * 1000;
    return res.json(configuredTurnServers);
  }

  if (turnUsername && turnCredential) {
    const staticTurnServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:openrelay.metered.ca:80' },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: turnUsername,
        credential: turnCredential
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: turnUsername,
        credential: turnCredential
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: turnUsername,
        credential: turnCredential
      }
    ];
    return res.json(staticTurnServers);
  }

  // 3. Fallback: Trả về danh sách STUN servers công cộng mặc định
  const defaultStunServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.stunprotocol.org:3478' }
  ];
  res.json(defaultStunServers);
});

// ── DATABASE SWEEP WORKER DEAMON ──────────────────────────────────────────────
function startBackgroundDatabaseSweepWorker() {
  console.log('[Sweep Worker] 🚀 Khởi động luồng quét tự động toàn bộ cơ sở dữ liệu để làm mới thực đơn...');
  setTimeout(runSweepIteration, 10000); // Bắt đầu sau 10 giây
}

function runSweepIteration() {
  try {
    const localData = dbHelper.read();
    if (!Array.isArray(localData) || localData.length === 0) {
      setTimeout(runSweepIteration, 5 * 60 * 1000);
      return;
    }

    let dbChanged = false;
    localData.forEach(r => {
      if (resetClosedIfNextAttemptReached(r)) {
        dbChanged = true;
      }
    });

    if (dbChanged) {
      updateLocalDatabase((dbData) => {
        let changed = false;
        dbData.forEach(r => {
          if (resetClosedIfNextAttemptReached(r)) {
            changed = true;
          }
        });
        return changed;
      }).then(() => {
        console.log('[Sweep Worker] 💾 Đã lưu thay đổi reset các quán hết hạn đóng cửa tạm thời.');
      });
    }

    // Chọn quán chưa có menu thực tế HOẶC quán đã có menu nhưng chưa được cập nhật trong vòng 24 giờ qua (Độc lập ShopeeFood)
    const candidates = localData.filter(r => {
      if (!r || !r.id || r._isScraping) return false;
      if (r.isClosed) return false; // Không quét quán đang đóng cửa hoàn toàn
      if (!r.hasRealMenu) return true; // Chưa có menu thực tế -> cần quét gấp
      
      // Đã có menu: kiểm tra xem lần cập nhật cuối cùng có quá 24 giờ không
      const lastCheck = r.menuUpdatedAt ? new Date(r.menuUpdatedAt).getTime() : 0;
      const diffMs = Date.now() - lastCheck;
      return diffMs > 24 * 60 * 60 * 1000; // 24 giờ
    });
    
    // Sắp xếp: ưu tiên r.menuUpdatedAt chưa có (null), sau đó đến r.menuUpdatedAt cũ nhất
    candidates.sort((a, b) => {
      const timeA = a.menuUpdatedAt ? new Date(a.menuUpdatedAt).getTime() : 0;
      const timeB = b.menuUpdatedAt ? new Date(b.menuUpdatedAt).getTime() : 0;
      return timeA - timeB;
    });

    if (candidates.length === 0) {
      console.log('[Sweep Worker] ✨ Tuyệt vời! Tất cả các quán ăn trong database đã được đối chiếu thực đơn trong vòng 24 giờ.');
      setTimeout(runSweepIteration, 30 * 60 * 1000); // Quét lại sau 30 phút
      return;
    }

    const target = candidates[0];
    
    // Tránh spam quét lặp lại quá nhanh khi toàn bộ DB đều đã được quét gần đây
    if (target.menuUpdatedAt) {
      const lastCheck = new Date(target.menuUpdatedAt).getTime();
      const diffMs = Date.now() - lastCheck;
      if (diffMs < 2 * 60 * 60 * 1000) { // 2 giờ
        console.log(`[Sweep Worker] ℹ️ Quán cần đối chiếu cũ nhất "${target.name}" mới được kiểm tra cách đây ${Math.round(diffMs / 60000)} phút. Tạm dừng đối chiếu 10 phút...`);
        setTimeout(runSweepIteration, 10 * 60 * 1000);
        return;
      }
    }

    console.log(`[Sweep Worker] 🔍 Tìm thấy ${candidates.length} quán ăn cần đối chiếu giá. Tiến hành cào ngầm tuần tự...`);
    console.log(`[Sweep Worker] ⚡ Đang tiến hành đối chiếu giá cho: "${target.name}" (ID: ${target.id})...`);
    
    target._isScraping = true;
    
    let slug = target.shopeefoodSlug || target.id.replace('r_ct_', '').split('?')[0].replace(/_/g, '-');
    
    const resolvePromise = target.shopeefoodSlug
      ? Promise.resolve(target.shopeefoodSlug)
      : getShopeeFoodSlugFromFoody(slug);

    resolvePromise.then(resolvedSlug => {
      let finalSlug = resolvedSlug;
      if (SLUG_REWRITER_MAP[finalSlug]) {
        finalSlug = SLUG_REWRITER_MAP[finalSlug];
      }
      return menuScraper.scrapeMenu(finalSlug);
    }).then(realMenu => {
      target._isScraping = false;
      
      let isClosed = false;
      let closedReason = '';
      let menu = null;

      if (realMenu && realMenu.blocked === true) {
        console.log(`[Sweep Worker] ⏳ API bị chặn (quán vẫn tồn tại): "${target.name}" — bỏ qua chu kỳ này.`);
        setTimeout(runSweepIteration, 30 * 1000);
        return;
      }

      if (realMenu && realMenu.closed === true) {
        isClosed = true;
        closedReason = realMenu.reason || 'Quán hiện đang đóng cửa ngoài giờ phục vụ.';
        if (Array.isArray(realMenu.menu) && realMenu.menu.length > 0) {
          menu = realMenu.menu;
        }
      } else if (Array.isArray(realMenu) && realMenu.length > 0) {
        isClosed = false;
        menu = realMenu;
      }

      if (isClosed) {
        console.log(`[Sweep Worker] 🔒 Đánh dấu quán đóng cửa trong DB (không xóa): "${target.name}"`);
        target.isClosed = true;
        target.closedAt = new Date().toISOString();
        target.closedReason = closedReason || 'Cửa hàng tạm ngưng phục vụ.';
        
        // Đặt lịch cào lại vào ngày mai để đối chiếu tiếp
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(7, 0, 0, 0);
        target.crawlNextAttempt = tomorrow.toISOString();
        target.menuUpdatedAt = new Date().toISOString();

        // Lưu menu nếu cào được mặc dù quán đang đóng cửa
        if (menu && menu.length > 0) {
          const isFallback = !target.hasRealMenu || target.menuTemplateFallback === true;
          if (isFallback) {
            writeRestaurantMenu(target.id, menu);
            target.dishNames = menu.map(m => m.name).filter(Boolean);
            target.hasRealMenu = true;
            delete target.menuTemplateFallback;
            console.log(`[Sweep Worker] 🆕 Gán thực đơn cào được (${menu.length} món) cho quán đang đóng cửa: "${target.name}"`);
          }
        }

        updateLocalDatabase((dbData) => {
          const idx = dbData.findIndex(r => String(r.id) === String(target.id));
          if (idx !== -1) {
            dbData[idx].isClosed = true;
            dbData[idx].closedAt = target.closedAt;
            dbData[idx].closedReason = target.closedReason;
            dbData[idx].crawlNextAttempt = target.crawlNextAttempt;
            dbData[idx].menuUpdatedAt = target.menuUpdatedAt;
            if (target.hasRealMenu) {
              dbData[idx].hasRealMenu = true;
              dbData[idx].dishNames = target.dishNames;
              delete dbData[idx].menuTemplateFallback;
            }
            delete dbData[idx].menu;
            return true;
          }
          return false;
        }).then(() => {
          console.log(`[Sweep Worker] 💾 Đã lưu trạng thái đóng cửa của "${target.name}" vào database local.`);
        });
        
        setTimeout(runSweepIteration, 30 * 1000);
        return;

      } else if (menu) {
        // Tiến hành so khớp món ăn và đối chiếu cập nhật giá (ShopeeFood Price Sync)
        let priceUpdatedCount = 0;
        const localMenu = readRestaurantMenu(target.id) || [];
        
        const isFallback = !target.hasRealMenu || target.menuTemplateFallback === true;
        if (localMenu.length === 0 || isFallback) {
          // Nếu menu local trống hoặc là menu fallback mẫu, gán toàn bộ menu cào được và lưu file
          writeRestaurantMenu(target.id, menu);
          target.dishNames = menu.map(m => m.name).filter(Boolean);
          target.hasRealMenu = true;
          console.log(`[Sweep Worker] 🆕 Gán thực đơn mới cào (${menu.length} món) cho quán: "${target.name}"`);
        } else {
          // Đối chiếu và cập nhật giá món ăn cũ
          localMenu.forEach(localItem => {
            const scrapedItem = menu.find(m => m.name && localItem.name && m.name.trim().toLowerCase() === localItem.name.trim().toLowerCase());
            if (scrapedItem) {
              const oldInStore = localItem.inStorePrice;
              const newInStore = scrapedItem.inStorePrice;
              if (oldInStore !== newInStore) {
                localItem.inStorePrice = newInStore;
                localItem.appPrice = round100(newInStore * (1 + PRICING_CONFIG.MARKUP_RATE));
                priceUpdatedCount++;
              }
            }
          });
          writeRestaurantMenu(target.id, localMenu);
          target.dishNames = localMenu.map(m => m.name).filter(Boolean);
          target.hasRealMenu = true;
        }

        target.menuUpdatedAt = new Date().toISOString();
        delete target.menuTemplateFallback;
        if (target.isClosed) {
          target.isClosed = false;
          delete target.closedAt;
          delete target.closedReason;
        }

        updateLocalDatabase((dbData) => {
          const idx = dbData.findIndex(r => String(r.id) === String(target.id));
          if (idx !== -1) {
            dbData[idx].hasRealMenu = true;
            dbData[idx].menuUpdatedAt = target.menuUpdatedAt;
            dbData[idx].dishNames = target.dishNames;
            delete dbData[idx].menuTemplateFallback;
            delete dbData[idx].menu; // Xóa thuộc tính menu nếu lỡ có
            if (dbData[idx].isClosed) {
              dbData[idx].isClosed = false;
              delete dbData[idx].closedAt;
              delete dbData[idx].closedReason;
            }
            return true;
          }
          return false;
        }).then(() => {
          console.log(`[Sweep Worker] ✅ Đối chiếu hoàn tất cho "${target.name}": Đã cập nhật giá ${priceUpdatedCount} món.`);
        });
      } else {
        target.menuUpdatedAt = new Date().toISOString();

        updateLocalDatabase((dbData) => {
          const idx = dbData.findIndex(r => String(r.id) === String(target.id));
          if (idx !== -1) {
            dbData[idx].menuUpdatedAt = target.menuUpdatedAt;
            delete dbData[idx].menu;
            return true;
          }
          return false;
        }).then(() => {
          console.log(`[Sweep Worker] ⚠️ Không có menu hoặc lỗi cho: "${target.name}". Sẽ thử lại ở chu kỳ sau.`);
        });
      }
      
      setTimeout(runSweepIteration, 30 * 1000); // Chờ 30 giây để tránh spam ShopeeFood
    }).catch(err => {
      target._isScraping = false;
      console.error(`[Sweep Worker] ❌ Lỗi luồng cào ngầm cho "${target.name}":`, err.message);
      
      // Vẫn cập nhật menuUpdatedAt để lượt quét tiếp theo không bị lặp lại quán lỗi này ngay lập tức
      target.menuUpdatedAt = new Date().toISOString();
      updateLocalDatabase((dbData) => {
        const idx = dbData.findIndex(r => String(r.id) === String(target.id));
        if (idx !== -1) {
          dbData[idx].menuUpdatedAt = target.menuUpdatedAt;
          delete dbData[idx].menu;
          return true;
        }
        return false;
      }).finally(() => {
        setTimeout(runSweepIteration, 30 * 1000);
      });
    });
    
  } catch (err) {
    console.error('[Sweep Worker] Lỗi phân tích database:', err.message);
    setTimeout(runSweepIteration, 60 * 1000);
  }
}

// ── START SERVER ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║     🛵  ShipFee Proxy Server — Cần Thơ             ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  API:    http://localhost:${PORT}/api/restaurants       ║`);
  console.log(`║  App:    http://localhost:${PORT}/app/index.html        ║`);
  console.log(`║  Status: http://localhost:${PORT}/api/status            ║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  Cache tự động 10 phút | Fallback local data        ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log('👉 Mở trình duyệt tại: http://localhost:3001/app/index.html');
  console.log('   (hoặc nhấn Ctrl+Click vào link trên)');
  console.log('');

  // Persist orders across restarts: prune old terminal orders, hydrate from Supabase if empty
  try {
    if (fs.existsSync(ORDERS_FILE_PATH)) {
      const raw = fs.readFileSync(ORDERS_FILE_PATH, 'utf8');
      let orders = [];
      try { orders = JSON.parse(raw) || []; } catch (e) { orders = []; }
      if (Array.isArray(orders) && orders.length > 0) {
        const pruned = pruneOldOrders(orders, 7);
        if (pruned.length !== orders.length) {
          fs.writeFileSync(ORDERS_FILE_PATH, JSON.stringify(pruned, null, 2), 'utf8');
          console.log(`[Persist] 🧹 Đã prune ${orders.length - pruned.length} đơn cũ (>7 ngày). Còn ${pruned.length} đơn.`);
        } else {
          console.log(`[Persist] ✅ Giữ ${orders.length} đơn hàng qua restart.`);
        }
      }
    }
    hydrateOrdersFromSupabaseIfEmpty().catch(e => console.warn('[Hydrate]', e.message));
  } catch (e) {
    console.error('[Persist] Lỗi xử lý orders khi boot:', e.message);
  }

  // Kéo thông báo biến động (scheduler local/VPS) từ Supabase về — boot + định kỳ 5 phút.
  hydrateNotificationsFromSupabase().catch(e => console.warn('[Notif Hydrate]', e.message));
  setInterval(() => {
    hydrateNotificationsFromSupabase().catch(e => console.warn('[Notif Hydrate]', e.message));
  }, 5 * 60 * 1000);

  // DELTA-HYDRATE danh sách quán từ Supabase — cập nhật giá/quán mới/đóng-mở KHÔNG cần redeploy.
  // Chạy sau khi boot ổn định (tránh giành tài nguyên với khách đầu tiên) + chu kỳ 3 phút.
  setTimeout(() => {
    hydrateRestaurantDeltaFromSupabase().catch(e => console.warn('[Rest Delta]', e.message));
  }, IS_RENDER ? 60000 : 8000);
  setInterval(() => {
    hydrateRestaurantDeltaFromSupabase().catch(e => console.warn('[Rest Delta]', e.message));
  }, 3 * 60 * 1000);

  // Background expire-offer / re-dispatch (không gắn vào GET /api/orders)
  setInterval(() => {
    processExpiredOffers().catch(e => console.warn('[Dispatch Timer]', e.message));
  }, 8000);
  processExpiredOffers().catch(() => {});

  // Không ép toàn bộ OFFLINE khi boot (gây checkout khi shipper reload sau deploy).
  // Thay bằng TTL heartbeat GPS — ca ONLINE hết hạn nếu không gửi vị trí.
  console.log('[Sanitization] ⏭️ Giữ trạng thái ca ONLINE qua restart; stale TTL chạy nền.');
  setInterval(() => {
    markStaleShippersOffline();
  }, 60000);
  setTimeout(() => markStaleShippersOffline(), 15000);

  // Sanitize rewrites all chunks + can OOM free Render — skip on Render (in-memory coords already warm)
  if (!IS_RENDER) {
    sanitizeLocalJsonData();
  } else {
    console.log('[Sanitization] ⏭️ Skip chunk rewrite on Render (memory safety).');
  }

  // Tự động đồng bộ thông tin tài xế từ Supabase Auth online về local JSON
  syncShippersFromSupabase();

  // Restore menu files lost on deploy (menus/ is gitignored) — bulk skipped on Render by default
  hydrateMenusFromSupabase().catch(err => {
    console.error('[Menu Hydrate] Boot restore failed:', err.message);
  });

  // After boot settles: fix hasRealMenu flags from actual Supabase menu payloads.
  // Trên Render hoãn 120s để không giành CPU/RAM với những khách truy cập đầu tiên.
  setTimeout(() => {
    reconcileMenuFlagsFromSupabase({ maxPages: 250, pageSize: 40 })
      .then(r => console.log('[Menu Reconcile] Boot finished:', r))
      .catch(err => console.error('[Menu Reconcile] Boot failed:', err.message));
  }, IS_RENDER ? 120000 : 5000);

  // Tự động kích hoạt Crawler lấy dữ liệu mới nhất ngay khi bật server
  triggerCrawler();

  console.log(`[Server] Menu scrape: ${MENU_SCRAPE_ENABLED ? 'ENABLED' : 'DISABLED'} (Render=${IS_RENDER}, ENABLE_MENU_SCRAPE=${process.env.ENABLE_MENU_SCRAPE || 'unset'})`);

  // Khởi động luồng quét tự động toàn bộ cơ sở dữ liệu làm mới thực đơn chuẩn (chỉ chạy ở local để tránh quá tải Render)
  if (!process.env.RENDER && MENU_SCRAPE_ENABLED) {
    startBackgroundDatabaseSweepWorker();
  } else {
    console.log('[Server] ℹ️ Sweep Worker cào ngầm tắt (Render hoặc scrape disabled).');
  }

  // Khởi động Telegram Polling Daemon
  try {
    initTelegramBot();
    if (telegramBot) {
      telegramBot.startPolling();
      console.log('[Telegram Bot] Status:', JSON.stringify(telegramBot.getStatus()));
    }
  } catch (e) {
    console.error('[Telegram Bot] Không khởi động được bot:', e.message, e.stack);
  }
});
