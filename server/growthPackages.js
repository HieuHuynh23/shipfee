'use strict';

/**
 * Growth packages — ~100 chiến lược thu hút / AOV / retention.
 * Mã promo chỉ hiện app khách khi CRM Bật (enabled === true).
 * Gói đặc biệt: Ngày đôi (ngày === tháng: 1/1 … 12/12).
 */

const fs = require('fs');
const path = require('path');

const PACKAGES_FILE = path.join(__dirname, 'growth-packages.json');
const PROMOS_FILE = path.join(__dirname, 'promos-local.json');

function round100(n) {
  return Math.round(Number(n || 0) / 100) * 100;
}

function promoPkg({
  id,
  name,
  stage,
  code,
  value,
  type = 'fixed',
  minOrder = 0,
  hours = null,
  weekdays = null,
  daysOfMonth = null,
  doubleDay = false,
  doubleMonth = null,
  firstOrderOnly = false,
  forReturning = false,
  maxDiscount = null,
  minItems = null,
  copy,
  crmNote,
  priority = 100,
  highlight = false
}) {
  return {
    id,
    name,
    stage,
    enabled: false,
    kind: 'promo',
    promoCode: code,
    doubleMonth: doubleMonth != null ? doubleMonth : null,
    promo: {
      type,
      value,
      minOrder,
      maxUses: null,
      maxDiscount,
      minItems: minItems || null,
      firstOrderOnly: !!firstOrderOnly,
      forReturning: !!forReturning,
      hours: hours || null,
      weekdays: weekdays || null,
      daysOfMonth: daysOfMonth || null,
      doubleDay: !!doubleDay,
      doubleMonth: doubleMonth != null ? doubleMonth : null,
      active: false,
      description: copy || name
    },
    customerCopy: copy || name,
    crmNote: crmNote || 'Chỉ hiện app khi CRM Bật',
    priority,
    highlight: !!highlight
  };
}

/** Engine / loyalty — chạy nền, không phải mã nhập */
const ENGINE_PACKAGES = [
  {
    id: 'multi_item_15',
    name: 'Ưu đãi từ món thứ 2',
    stage: 'aov',
    enabled: true,
    kind: 'engine',
    engineKey: 'multiItemDiscount',
    customerCopy: 'Từ món thứ 2: giảm 15% giá món (trừ vào phí)',
    crmNote: 'Engine — không phải mã',
    priority: 20
  },
  {
    id: 'return_10',
    name: 'Khách quay lại',
    stage: 'retention',
    enabled: true,
    kind: 'engine',
    engineKey: 'secondOrderDiscountRate',
    customerCopy: 'Đơn thứ 2+: tự giảm thêm 10% tổng đơn',
    crmNote: 'Engine — không phải mã',
    priority: 30
  },
  {
    id: 'waive_platform_79',
    name: 'Giảm phí nền tảng',
    stage: 'aov',
    enabled: true,
    kind: 'engine',
    engineKey: 'waivePlatform',
    customerCopy: 'Đặt từ 79.000đ hoặc ≥3 món để giảm phí nền tảng',
    crmNote: 'Engine — không phải mã',
    priority: 40
  },
  {
    id: 'half_delivery_120',
    name: 'Giảm 50% phí giao',
    stage: 'aov',
    enabled: true,
    kind: 'engine',
    engineKey: 'halfDelivery',
    customerCopy: 'Đặt từ 120.000đ hoặc ≥3 món: giảm 50% phí giao',
    crmNote: 'Engine — không phải mã',
    priority: 50
  },
  {
    id: 'loyalty_boost',
    name: 'Tích điểm đổi thưởng',
    stage: 'retention',
    enabled: true,
    kind: 'loyalty',
    customerCopy: 'Giao xong tích điểm — 1 điểm ≈ 100đ khi đặt lại',
    crmNote: 'Loyalty — không phải mã',
    priority: 80
  }
];

/**
 * Sinh catalog ~100 gói: acquisition / AOV / retention / peak / ngày đôi.
 * Tất cả mã promo mặc định OFF.
 */
function buildGeneratedPromoPackages() {
  const list = [];
  let prio = 100;

  // ── ĐẶC BIỆT: Ngày đôi (1/1, 2/2, … 12/12) ─────────────────────────────
  list.push(
    promoPkg({
      id: 'ngay_doi_mega',
      name: 'Ngày đôi siêu sale',
      stage: 'acquisition',
      code: 'NGAYDOI',
      value: 25000,
      type: 'fixed',
      minOrder: 79000,
      doubleDay: true,
      copy: 'Ngày đôi (1/1…12/12): mã NGAYDOI giảm 25.000đ (đơn từ 79k)',
      crmNote: 'FLASH ngày đôi — bật trước ngày 1/1,2/2,…12/12',
      priority: 5,
      highlight: true
    })
  );
  list.push(
    promoPkg({
      id: 'ngay_doi_percent',
      name: 'Ngày đôi −15%',
      stage: 'aov',
      code: 'DOI15',
      value: 15,
      type: 'percent',
      minOrder: 50000,
      maxDiscount: 30000,
      doubleDay: true,
      copy: 'Ngày đôi: mã DOI15 giảm 15% (tối đa 30k, đơn từ 50k)',
      crmNote: 'Ngày đôi % — cạnh tranh Shopee 11.11/12.12 style',
      priority: 6,
      highlight: true
    })
  );

  // 12 gói nhỏ theo từng tháng đôi
  for (let m = 1; m <= 12; m++) {
    const code = `DOI${String(m).padStart(2, '0')}`;
    const val = 10000 + m * 1000; // 11k…22k
    list.push(
      promoPkg({
        id: `ngay_doi_m${m}`,
        name: `Ngày đôi ${m}/${m}`,
        stage: 'acquisition',
        code,
        value: round100(val),
        minOrder: 60000,
        daysOfMonth: [m],
        // Chỉ đúng tháng m + ngày m (kiểm tra thêm monthMatch)
        doubleDay: true,
        doubleMonth: m,
        copy: `Chỉ ${m}/${m}: mã ${code} giảm ${round100(val).toLocaleString('vi-VN')}đ (đơn từ 60k)`,
        crmNote: `Bật quanh ngày ${m}/${m}`,
        priority: 7 + m
      })
    );
  }

  // Welcome / first-order ladder
  const welcomes = [
    ['WELCOME10', 10000, 0],
    ['WELCOME15', 15000, 0],
    ['WELCOME20', 20000, 40000],
    ['MOI10', 10000, 0],
    ['CHAO12', 12000, 30000]
  ];
  welcomes.forEach(([code, value, minOrder], i) => {
    list.push(
      promoPkg({
        id: `welcome_${i + 1}`,
        name: `Chào khách mới ${value / 1000}k`,
        stage: 'acquisition',
        code,
        value,
        minOrder,
        firstOrderOnly: true,
        copy: `Đơn đầu: mã ${code} giảm ${value.toLocaleString('vi-VN')}đ${minOrder ? ` (đơn từ ${minOrder.toLocaleString('vi-VN')}đ)` : ''}`,
        priority: ++prio
      })
    );
  });

  // Returning
  const returns = [
    ['QUAYLAI10', 10, 'percent', 0, 20000],
    ['QUAYLAI15', 15000, 'fixed', 50000, null],
    ['BANCU12', 12000, 'fixed', 40000, null],
    ['RETURN8', 8, 'percent', 0, 15000],
    ['LOYAL18', 18000, 'fixed', 70000, null]
  ];
  returns.forEach(([code, value, type, minOrder, maxDiscount], i) => {
    list.push(
      promoPkg({
        id: `return_code_${i + 1}`,
        name: `Khách quen ${code}`,
        stage: 'retention',
        code,
        value,
        type,
        minOrder,
        maxDiscount,
        forReturning: true,
        copy:
          type === 'percent'
            ? `Khách quay lại: mã ${code} giảm ${value}%${maxDiscount ? ` (tối đa ${maxDiscount.toLocaleString('vi-VN')}đ)` : ''}`
            : `Khách quay lại: mã ${code} giảm ${value.toLocaleString('vi-VN')}đ (đơn từ ${minOrder.toLocaleString('vi-VN')}đ)`,
        priority: ++prio
      })
    );
  });

  // Weekday Mon–Sun (0=CN … 6=T7)
  const dayNames = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
  dayNames.forEach((label, wd) => {
    const code = `THU${wd === 0 ? 'CN' : wd}`;
    list.push(
      promoPkg({
        id: `weekday_${wd}`,
        name: `Deal ${label}`,
        stage: 'acquisition',
        code,
        value: 8000 + wd * 500,
        minOrder: 45000,
        weekdays: [wd],
        copy: `${label}: mã ${code} giảm ${(8000 + wd * 500).toLocaleString('vi-VN')}đ (đơn từ 45k)`,
        priority: ++prio
      })
    );
  });

  // Peak hours
  const peaks = [
    ['SANG8', [6, 10], 8000, 40000, 'Sáng sớm'],
    ['TRUA10', [10, 14], 10000, 50000, 'Giờ trưa'],
    ['CHIEU9', [14, 17], 9000, 45000, 'Giờ chiều'],
    ['TOI12', [17, 21], 12000, 60000, 'Giờ tối'],
    ['KHUYA15', [21, 24], 15000, 55000, 'Khuya'],
    ['OT60', [11, 13], 6000, 35000, 'Giờ OT trưa'],
    ['AFTERWORK', [18, 20], 11000, 55000, 'Tan làm']
  ];
  peaks.forEach(([code, hours, value, minOrder, name], i) => {
    list.push(
      promoPkg({
        id: `peak_${i + 1}`,
        name,
        stage: 'acquisition',
        code,
        value,
        minOrder,
        hours,
        copy: `${hours[0]}h–${hours[1]}h: mã ${code} giảm ${value.toLocaleString('vi-VN')}đ (đơn từ ${minOrder.toLocaleString('vi-VN')}đ)`,
        priority: ++prio
      })
    );
  });

  // AOV ladder — khuyến khích tăng giá trị đơn
  const aovSteps = [40000, 50000, 60000, 70000, 80000, 90000, 100000, 120000, 150000, 200000];
  aovSteps.forEach((minOrder, i) => {
    const value = round100(minOrder * 0.12);
    const code = `AOV${minOrder / 1000}`;
    list.push(
      promoPkg({
        id: `aov_${minOrder}`,
        name: `Mốc ${minOrder.toLocaleString('vi-VN')}đ`,
        stage: 'aov',
        code,
        value: Math.min(value, 30000),
        minOrder,
        copy: `Đơn từ ${minOrder.toLocaleString('vi-VN')}đ: mã ${code} giảm ${Math.min(value, 30000).toLocaleString('vi-VN')}đ`,
        priority: ++prio
      })
    );
  });

  // Payday 1 & 15
  [1, 15].forEach((d) => {
    list.push(
      promoPkg({
        id: `payday_${d}`,
        name: `Ngày lương ${d}`,
        stage: 'acquisition',
        code: `LUONG${d}`,
        value: 18000,
        minOrder: 70000,
        daysOfMonth: [d],
        copy: `Ngày ${d} hàng tháng: mã LUONG${d} giảm 18.000đ (đơn từ 70k)`,
        priority: ++prio
      })
    );
  });

  // Double-digit calendar days 11 & 22 (mọi tháng)
  [11, 22].forEach((d) => {
    list.push(
      promoPkg({
        id: `digit_${d}`,
        name: `Ngày ${d} hàng tháng`,
        stage: 'aov',
        code: `NGAY${d}`,
        value: 16000,
        minOrder: 65000,
        daysOfMonth: [d],
        copy: `Ngày ${d}: mã NGAY${d} giảm 16.000đ (đơn từ 65k)`,
        crmNote: 'Ngày số đẹp — khác Ngày đôi (ngày=tháng)',
        priority: ++prio
      })
    );
  });

  // Flash fixed
  const flash = [5000, 7000, 9000, 10000, 13000, 15000, 17000, 20000, 22000, 25000];
  flash.forEach((value, i) => {
    const code = `FLASH${value / 1000}`;
    list.push(
      promoPkg({
        id: `flash_${value}`,
        name: `Flash −${value / 1000}k`,
        stage: 'acquisition',
        code,
        value,
        minOrder: Math.max(30000, value * 4),
        copy: `Flash: mã ${code} giảm ${value.toLocaleString('vi-VN')}đ (đơn từ ${Math.max(30000, value * 4).toLocaleString('vi-VN')}đ)`,
        priority: ++prio
      })
    );
  });

  // Percent caps
  const percents = [
    [5, 10000],
    [8, 15000],
    [10, 20000],
    [12, 22000],
    [15, 25000],
    [18, 28000],
    [20, 30000]
  ];
  percents.forEach(([value, maxDiscount], i) => {
    const code = `PCT${value}`;
    list.push(
      promoPkg({
        id: `pct_${value}`,
        name: `Giảm ${value}%`,
        stage: 'aov',
        code,
        value,
        type: 'percent',
        minOrder: 40000,
        maxDiscount,
        copy: `Mã ${code}: giảm ${value}% (tối đa ${maxDiscount.toLocaleString('vi-VN')}đ, đơn từ 40k)`,
        priority: ++prio
      })
    );
  });

  // Behavior nudges — copy khuyến khích thêm món / đặt lại
  const nudges = [
    ['THEM2', 10000, 2, 'Thêm món thứ 2'],
    ['THEM3', 15000, 3, 'Đơn từ 3 món'],
    ['COMBO79', 12000, 0, 'Combo 79k'],
    ['FREESHIPF', 0, 0, 'Trợ phí giao', 'free_ship'],
    ['DEMUA', 8000, 0, 'Đặt muộn'],
    ['VP5', 5000, 0, 'Văn phòng'],
    ['SV8', 8000, 0, 'Sinh viên'],
    ['GIAODUC', 10000, 0, 'Giao đúng giờ'],
    ['HOTDEAL', 14000, 0, 'Trời nóng'],
    ['MUADEAL', 14000, 0, 'Trời mưa']
  ];
  nudges.forEach(([code, value, minItems, name, type], i) => {
    list.push(
      promoPkg({
        id: `nudge_${i + 1}`,
        name,
        stage: i < 3 ? 'aov' : 'acquisition',
        code,
        value: type === 'free_ship' ? 0 : value,
        type: type || 'fixed',
        minOrder: type === 'free_ship' ? 50000 : Math.max(35000, value * 3),
        minItems: minItems || null,
        copy:
          type === 'free_ship'
            ? `Mã ${code}: miễn phí giao hàng hiển thị (đơn từ 50k)`
            : minItems
              ? `${name}: mã ${code} giảm ${value.toLocaleString('vi-VN')}đ`
              : `${name}: mã ${code} giảm ${value.toLocaleString('vi-VN')}đ`,
        priority: ++prio
      })
    );
  });

  // Weekend boosts
  list.push(
    promoPkg({
      id: 'weekend_20',
      name: 'Cuối tuần −20k',
      stage: 'aov',
      code: 'CUOITUAN20',
      value: 20000,
      minOrder: 100000,
      weekdays: [0, 6],
      copy: 'CN & T7: mã CUOITUAN20 giảm 20.000đ (đơn từ 100k)',
      priority: ++prio
    })
  );
  list.push(
    promoPkg({
      id: 'weekend_15',
      name: 'Cuối tuần −15k',
      stage: 'acquisition',
      code: 'CUOITUAN15',
      value: 15000,
      minOrder: 70000,
      weekdays: [0, 6],
      copy: 'CN & T7: mã CUOITUAN15 giảm 15.000đ (đơn từ 70k)',
      priority: ++prio
    })
  );

  // Fill to reach ~95 promos if short — micro hourly slots
  let fill = 1;
  while (list.length < 95) {
    const h0 = fill % 20;
    const code = `H${String(h0).padStart(2, '0')}K`;
    list.push(
      promoPkg({
        id: `hour_fill_${fill}`,
        name: `Khung ${h0}h−${h0 + 2}h`,
        stage: 'acquisition',
        code,
        value: 5000 + (fill % 5) * 1000,
        minOrder: 35000,
        hours: [h0, Math.min(24, h0 + 2)],
        copy: `${h0}h–${Math.min(24, h0 + 2)}h: mã ${code} giảm ${(5000 + (fill % 5) * 1000).toLocaleString('vi-VN')}đ`,
        priority: ++prio
      })
    );
    fill += 1;
    if (fill > 40) break;
  }

  return list;
}

function buildFullCatalog() {
  const promos = buildGeneratedPromoPackages();
  const all = [...ENGINE_PACKAGES, ...promos];
  // Đảm bảo ~100
  const seen = new Set();
  const unique = [];
  for (const p of all) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    unique.push(p);
  }
  return unique.slice(0, 100);
}

const DEFAULT_PACKAGES = buildFullCatalog();

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function vietnamNowParts() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    weekday: 'short',
    hour12: false
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const hour = Number(get('hour') || 0);
  const day = Number(get('day') || 1);
  const month = Number(get('month') || 1);
  const wd = get('weekday') || '';
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    hour,
    day,
    month,
    weekday: map[wd] != null ? map[wd] : new Date().getDay(),
    isDoubleDay: day === month
  };
}

/**
 * Merge catalog mới vào file cũ — giữ trạng thái enabled CRM đã bật.
 */
function loadPackages() {
  const catalog = buildFullCatalog();
  const raw = readJson(PACKAGES_FILE, null);
  if (!raw || !Array.isArray(raw.packages) || raw.packages.length === 0) {
    const data = { updatedAt: Date.now(), version: 2, packages: catalog };
    writeJson(PACKAGES_FILE, data);
    return data;
  }

  const byId = new Map(raw.packages.map((p) => [p.id, p]));
  let changed = raw.packages.length < 90 || raw.version !== 2;
  const merged = catalog.map((fresh) => {
    const prev = byId.get(fresh.id);
    if (!prev) {
      changed = true;
      return fresh;
    }
    // Giữ enabled / used CRM overrides
    return {
      ...fresh,
      enabled: prev.enabled === true,
      promo: fresh.promo
        ? {
            ...fresh.promo,
            active: prev.enabled === true,
            usedCount: prev.promo?.usedCount
          }
        : fresh.promo
    };
  });

  // Giữ gói custom admin tạo thêm (không có trong catalog)
  for (const prev of raw.packages) {
    if (!catalog.find((c) => c.id === prev.id)) {
      merged.push(prev);
    }
  }

  const data = { updatedAt: Date.now(), version: 2, packages: merged.slice(0, 120) };
  if (changed) writeJson(PACKAGES_FILE, data);
  return data;
}

function savePackages(data) {
  const payload = {
    updatedAt: Date.now(),
    version: 2,
    packages: Array.isArray(data.packages) ? data.packages : DEFAULT_PACKAGES
  };
  writeJson(PACKAGES_FILE, payload);
  return payload;
}

function readPromosList() {
  return readJson(PROMOS_FILE, []);
}

function writePromosList(list) {
  writeJson(PROMOS_FILE, list);
}

function seedPromosFromPackages() {
  const { packages } = loadPackages();
  let promos = readPromosList();
  let changed = 0;

  for (const pkg of packages) {
    if (pkg.kind !== 'promo' || !pkg.promoCode || !pkg.promo) continue;
    const code = String(pkg.promoCode).toUpperCase();
    const pkgOn = pkg.enabled === true;
    const idx = promos.findIndex((p) => String(p.code || '').toUpperCase() === code);
    const base = {
      code,
      type: pkg.promo.type || 'fixed',
      value: Number(pkg.promo.value) || 0,
      minOrder: Number(pkg.promo.minOrder) || 0,
      maxUses: pkg.promo.maxUses != null ? pkg.promo.maxUses : null,
      maxDiscount: pkg.promo.maxDiscount != null ? pkg.promo.maxDiscount : null,
      firstOrderOnly: pkg.promo.firstOrderOnly === true,
      forReturning: pkg.promo.forReturning === true,
      hours: Array.isArray(pkg.promo.hours) ? pkg.promo.hours : null,
      weekdays: Array.isArray(pkg.promo.weekdays) ? pkg.promo.weekdays : null,
      daysOfMonth: Array.isArray(pkg.promo.daysOfMonth) ? pkg.promo.daysOfMonth : null,
      doubleDay: pkg.promo.doubleDay === true,
      doubleMonth: pkg.doubleMonth != null ? pkg.doubleMonth : pkg.promo.doubleMonth,
      minItems: pkg.promo.minItems != null ? Number(pkg.promo.minItems) : null,
      active: pkgOn,
      description: pkg.promo.description || pkg.customerCopy || pkg.name,
      packageId: pkg.id,
      source: 'growth-package'
    };
    if (idx === -1) {
      promos.push({ ...base, usedCount: 0, createdAt: Date.now() });
      changed += 1;
    } else {
      const prev = promos[idx];
      promos[idx] = { ...prev, ...base, usedCount: prev.usedCount || 0 };
      changed += 1;
    }
  }

  if (changed > 0) writePromosList(promos);
  return { seeded: changed, totalPromos: promos.length, totalPackages: packages.length };
}

function isPackagePromoEnabled(code) {
  if (!code) return false;
  const want = String(code).trim().toUpperCase();
  const { packages } = loadPackages();
  const pkg = packages.find(
    (p) => p.kind === 'promo' && String(p.promoCode || '').toUpperCase() === want
  );
  if (!pkg) return true;
  return pkg.enabled === true;
}

function isPromoTimeValid(promo) {
  const now = vietnamNowParts();
  if (promo.doubleDay === true) {
    if (!now.isDoubleDay) return false;
    const m = promo.doubleMonth != null ? Number(promo.doubleMonth) : null;
    if (m != null && now.month !== m) return false;
  }
  if (Array.isArray(promo.daysOfMonth) && promo.daysOfMonth.length > 0) {
    if (!promo.daysOfMonth.includes(now.day)) return false;
  }
  if (Array.isArray(promo.hours) && promo.hours.length >= 2) {
    const [start, end] = promo.hours;
    if (!(now.hour >= start && now.hour < end)) return false;
  }
  if (Array.isArray(promo.weekdays) && promo.weekdays.length > 0) {
    if (!promo.weekdays.includes(now.weekday)) return false;
  }
  return true;
}

function resolveCustomerOffers(ctx = {}) {
  const { packages } = loadPackages();
  const hasPrevious = ctx.hasPreviousOrders === true;
  const codesOnly = ctx.codesOnly !== false;
  const offers = [];

  for (const pkg of packages) {
    if (pkg.enabled !== true) continue;

    if (pkg.kind === 'promo') {
      if (pkg.promo?.firstOrderOnly && hasPrevious) continue;
      if (pkg.promo?.forReturning && !hasPrevious) continue;
      if (pkg.promo && !isPromoTimeValid(pkg.promo)) continue;
      offers.push({
        id: pkg.id,
        name: pkg.name,
        stage: pkg.stage,
        kind: 'promo',
        code: pkg.promoCode,
        copy: pkg.customerCopy,
        value: pkg.promo?.value,
        type: pkg.promo?.type,
        minOrder: pkg.promo?.minOrder || 0,
        firstOrderOnly: !!pkg.promo?.firstOrderOnly,
        highlight: !!pkg.highlight || pkg.promo?.doubleDay === true,
        priority: pkg.priority || 100,
        actionable: true
      });
      continue;
    }

    if (codesOnly) continue;
  }

  offers.sort((a, b) => (a.priority || 100) - (b.priority || 100));
  return offers;
}

function getSuggestedFirstOrderCode(hasPreviousOrders) {
  if (hasPreviousOrders) return null;
  const { packages } = loadPackages();
  const welcome = packages.find(
    (p) =>
      p.enabled === true &&
      p.kind === 'promo' &&
      p.promo?.firstOrderOnly &&
      p.promoCode
  );
  return welcome ? String(welcome.promoCode).toUpperCase() : null;
}

function listPackagesForAdmin(query = {}) {
  const data = loadPackages();
  let list = data.packages || [];
  const q = String(query.q || '').trim().toLowerCase();
  const kind = String(query.kind || '').trim();
  const stage = String(query.stage || '').trim();
  const enabled = query.enabled;

  if (q) {
    list = list.filter((p) => {
      const blob = `${p.id} ${p.name} ${p.promoCode || ''} ${p.customerCopy || ''} ${p.engineKey || ''}`.toLowerCase();
      return blob.includes(q);
    });
  }
  if (kind) list = list.filter((p) => p.kind === kind);
  if (stage) list = list.filter((p) => p.stage === stage);
  if (enabled === '1' || enabled === 'true') list = list.filter((p) => p.enabled === true);
  if (enabled === '0' || enabled === 'false') list = list.filter((p) => p.enabled !== true);

  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(query.limit, 10) || 50));
  const start = (page - 1) * limit;
  const slice = list.slice(start, start + limit);

  return {
    updatedAt: data.updatedAt,
    version: data.version,
    total: list.length,
    catalogSize: (data.packages || []).length,
    enabledCount: (data.packages || []).filter((p) => p.enabled === true).length,
    page,
    limit,
    packages: slice,
    now: vietnamNowParts()
  };
}

function updatePackage(id, patch) {
  const data = loadPackages();
  const idx = data.packages.findIndex((p) => p.id === id);
  if (idx === -1) return { error: 'Không tìm thấy gói' };
  const prev = data.packages[idx];
  const nextEnabled = patch.enabled !== undefined ? !!patch.enabled : prev.enabled === true;
  data.packages[idx] = {
    ...prev,
    ...patch,
    id: prev.id,
    enabled: nextEnabled,
    promo: prev.promo
      ? {
          ...prev.promo,
          ...(patch.promo || {}),
          active: nextEnabled
        }
      : prev.promo
  };
  savePackages(data);
  seedPromosFromPackages();
  return { ok: true, package: data.packages[idx] };
}

function rebuildCatalogPreserveEnabled() {
  const raw = readJson(PACKAGES_FILE, { packages: [] });
  const byId = new Map((raw.packages || []).map((p) => [p.id, p]));
  const catalog = buildFullCatalog();
  const merged = catalog.map((fresh) => {
    const prev = byId.get(fresh.id);
    if (!prev) return fresh;
    return {
      ...fresh,
      enabled: prev.enabled === true,
      promo: fresh.promo
        ? {
            ...fresh.promo,
            active: prev.enabled === true,
            usedCount: prev.promo?.usedCount
          }
        : fresh.promo
    };
  });
  savePackages({ packages: merged });
  const seed = seedPromosFromPackages();
  return { ...seed, totalPackages: merged.length, catalogSize: catalog.length };
}

module.exports = {
  DEFAULT_PACKAGES,
  buildFullCatalog,
  loadPackages,
  savePackages,
  seedPromosFromPackages,
  resolveCustomerOffers,
  getSuggestedFirstOrderCode,
  listPackagesForAdmin,
  updatePackage,
  rebuildCatalogPreserveEnabled,
  isPromoTimeValid,
  isPackagePromoEnabled,
  vietnamNowParts
};
