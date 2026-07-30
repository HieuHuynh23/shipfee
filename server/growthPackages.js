'use strict';

/**
 * Growth packages — early-stage acquisition / retention offers.
 * Combines promo codes + pricing-engine levers into named packages for CRM + customer UI.
 */

const fs = require('fs');
const path = require('path');

const PACKAGES_FILE = path.join(__dirname, 'growth-packages.json');
const PROMOS_FILE = path.join(__dirname, 'promos-local.json');

const DEFAULT_PACKAGES = [
  {
    id: 'welcome_first',
    name: 'Chào khách mới',
    stage: 'acquisition',
    enabled: true,
    kind: 'promo',
    promoCode: 'WELCOME15',
    promo: {
      type: 'fixed',
      value: 15000,
      firstOrderOnly: true,
      minOrder: 0,
      maxUses: null,
      active: true,
      description: 'Giảm 15.000đ cho đơn đầu tiên'
    },
    customerCopy: 'Đơn đầu giảm 15.000đ — mã WELCOME15',
    crmNote: 'Acquisition: khách mới, clamp sàn ship 15k',
    priority: 10
  },
  {
    id: 'multi_item_15',
    name: 'Ưu đãi từ món thứ 2',
    stage: 'aov',
    enabled: true,
    kind: 'engine',
    engineKey: 'multiItemDiscount',
    customerCopy: 'Từ món thứ 2: giảm 15% giá món (trừ vào phí)',
    crmNote: 'Engine multiItemDiscount — không cần mã',
    priority: 20
  },
  {
    id: 'return_10',
    name: 'Khách quay lại',
    stage: 'retention',
    enabled: true,
    kind: 'engine',
    engineKey: 'secondOrderDiscountRate',
    customerCopy: 'Đơn thứ 2 trở đi: tự động giảm thêm 10% tổng đơn',
    crmNote: 'pricingConfig.secondOrderDiscountRate',
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
    crmNote: 'waivePlatformMinStoreTotal / MinItems',
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
    crmNote: 'halfDeliveryMinStoreTotal / MinItems',
    priority: 50
  },
  {
    id: 'lunch_deal',
    name: 'Deal giờ trưa',
    stage: 'acquisition',
    enabled: true,
    kind: 'promo',
    promoCode: 'TRUA10',
    promo: {
      type: 'fixed',
      value: 10000,
      minOrder: 50000,
      hours: [10, 14],
      active: true,
      description: 'Giảm 10.000đ đơn từ 50k (10h–14h)'
    },
    customerCopy: '10h–14h: mã TRUA10 giảm 10.000đ (đơn từ 50k)',
    crmNote: 'Peak lunch conversion',
    priority: 60
  },
  {
    id: 'evening_deal',
    name: 'Deal giờ tối',
    stage: 'acquisition',
    enabled: true,
    kind: 'promo',
    promoCode: 'TOI12',
    promo: {
      type: 'fixed',
      value: 12000,
      minOrder: 60000,
      hours: [17, 21],
      active: true,
      description: 'Giảm 12.000đ đơn từ 60k (17h–21h)'
    },
    customerCopy: '17h–21h: mã TOI12 giảm 12.000đ (đơn từ 60k)',
    crmNote: 'Dinner peak',
    priority: 70
  },
  {
    id: 'weekend_boost',
    name: 'Cuối tuần thêm món',
    stage: 'aov',
    enabled: true,
    kind: 'promo',
    promoCode: 'CUOITUAN20',
    promo: {
      type: 'fixed',
      value: 20000,
      minOrder: 100000,
      weekdays: [0, 6],
      active: true,
      description: 'CN & Thứ 7: giảm 20k đơn từ 100k'
    },
    customerCopy: 'Cuối tuần: mã CUOITUAN20 giảm 20.000đ (đơn từ 100k)',
    crmNote: 'Weekend AOV push',
    priority: 75
  },
  {
    id: 'loyalty_boost',
    name: 'Tích điểm đổi thưởng',
    stage: 'retention',
    enabled: true,
    kind: 'loyalty',
    customerCopy: 'Giao xong tích điểm — 1 điểm ≈ 100đ khi đặt lại',
    crmNote: 'customerOps loyalty',
    priority: 80
  }
];

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
    hour: 'numeric',
    weekday: 'short',
    hour12: false
  });
  const parts = fmt.formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
  const wd = parts.find((p) => p.type === 'weekday')?.value || '';
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hour, weekday: map[wd] != null ? map[wd] : new Date().getDay() };
}

function loadPackages() {
  const raw = readJson(PACKAGES_FILE, null);
  if (!raw || !Array.isArray(raw.packages) || raw.packages.length === 0) {
    const data = { updatedAt: Date.now(), packages: DEFAULT_PACKAGES };
    writeJson(PACKAGES_FILE, data);
    return data;
  }
  return raw;
}

function savePackages(data) {
  const payload = {
    updatedAt: Date.now(),
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

/** Seed / refresh promo rows from growth packages (does not lower usedCount). */
function seedPromosFromPackages() {
  const { packages } = loadPackages();
  let promos = readPromosList();
  let changed = 0;

  for (const pkg of packages) {
    if (pkg.kind !== 'promo' || !pkg.promoCode || !pkg.promo) continue;
    if (pkg.enabled === false) continue;
    const code = String(pkg.promoCode).toUpperCase();
    const idx = promos.findIndex((p) => String(p.code || '').toUpperCase() === code);
    const base = {
      code,
      type: pkg.promo.type || 'fixed',
      value: Number(pkg.promo.value) || 0,
      minOrder: Number(pkg.promo.minOrder) || 0,
      maxUses: pkg.promo.maxUses != null ? pkg.promo.maxUses : null,
      maxDiscount: pkg.promo.maxDiscount != null ? pkg.promo.maxDiscount : null,
      firstOrderOnly: pkg.promo.firstOrderOnly === true,
      hours: Array.isArray(pkg.promo.hours) ? pkg.promo.hours : null,
      weekdays: Array.isArray(pkg.promo.weekdays) ? pkg.promo.weekdays : null,
      active: pkg.promo.active !== false && pkg.enabled !== false,
      description: pkg.promo.description || pkg.customerCopy || pkg.name,
      packageId: pkg.id,
      source: 'growth-package'
    };
    if (idx === -1) {
      promos.push({ ...base, usedCount: 0, createdAt: Date.now() });
      changed += 1;
    } else {
      const prev = promos[idx];
      promos[idx] = {
        ...prev,
        ...base,
        usedCount: prev.usedCount || 0
      };
      changed += 1;
    }
  }

  if (changed > 0) writePromosList(promos);
  return { seeded: changed, totalPromos: promos.length };
}

function isPromoTimeValid(promo) {
  const { hour, weekday } = vietnamNowParts();
  if (Array.isArray(promo.hours) && promo.hours.length >= 2) {
    const [start, end] = promo.hours;
    if (!(hour >= start && hour < end)) return false;
  }
  if (Array.isArray(promo.weekdays) && promo.weekdays.length > 0) {
    if (!promo.weekdays.includes(weekday)) return false;
  }
  return true;
}

/**
 * Customer-facing offers for checkout / home.
 * @param {{ hasPreviousOrders?: boolean, pricingConfig?: object }} ctx
 */
function resolveCustomerOffers(ctx = {}) {
  const { packages } = loadPackages();
  const hasPrevious = ctx.hasPreviousOrders === true;
  const cfg = ctx.pricingConfig || {};
  const offers = [];

  for (const pkg of packages) {
    if (pkg.enabled === false) continue;

    if (pkg.kind === 'promo') {
      if (pkg.promo?.firstOrderOnly && hasPrevious) continue;
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
        priority: pkg.priority || 100,
        actionable: true
      });
      continue;
    }

    if (pkg.kind === 'engine') {
      let copy = pkg.customerCopy;
      if (pkg.engineKey === 'secondOrderDiscountRate') {
        if (!hasPrevious) {
          copy = `Đặt đơn đầu xong — lần sau giảm thêm ${Math.round((cfg.secondOrderDiscountRate || 0.1) * 100)}% tự động`;
        } else {
          copy = `Bạn là khách quen: đơn này giảm thêm ${Math.round((cfg.secondOrderDiscountRate || 0.1) * 100)}% (tự động)`;
        }
      }
      if (pkg.engineKey === 'multiItemDiscount') {
        copy = `Từ món thứ 2: giảm ${Math.round((cfg.multiItemDiscount || 0.15) * 100)}% giá món`;
      }
      if (pkg.engineKey === 'waivePlatform') {
        const minStore = cfg.waivePlatformMinStoreTotal || 79000;
        const minItems = cfg.waivePlatformMinItems || 3;
        copy = `Đặt từ ${minStore.toLocaleString('vi-VN')}đ hoặc ≥${minItems} món để giảm phí nền tảng`;
      }
      if (pkg.engineKey === 'halfDelivery') {
        const minStore = cfg.halfDeliveryMinStoreTotal || 120000;
        const minItems = cfg.halfDeliveryMinItems || 3;
        copy = `Đặt từ ${minStore.toLocaleString('vi-VN')}đ hoặc ≥${minItems} món: giảm 50% phí giao`;
      }
      offers.push({
        id: pkg.id,
        name: pkg.name,
        stage: pkg.stage,
        kind: 'engine',
        engineKey: pkg.engineKey,
        copy,
        priority: pkg.priority || 100,
        actionable: false,
        appliesNow:
          pkg.engineKey === 'secondOrderDiscountRate'
            ? hasPrevious
            : pkg.engineKey !== 'secondOrderDiscountRate'
      });
      continue;
    }

    if (pkg.kind === 'loyalty') {
      offers.push({
        id: pkg.id,
        name: pkg.name,
        stage: pkg.stage,
        kind: 'loyalty',
        copy: pkg.customerCopy,
        priority: pkg.priority || 100,
        actionable: false
      });
    }
  }

  offers.sort((a, b) => (a.priority || 100) - (b.priority || 100));
  return offers;
}

function getSuggestedFirstOrderCode(hasPreviousOrders) {
  if (hasPreviousOrders) return null;
  const { packages } = loadPackages();
  const welcome = packages.find(
    (p) => p.enabled !== false && p.kind === 'promo' && p.promo?.firstOrderOnly && p.promoCode
  );
  return welcome ? String(welcome.promoCode).toUpperCase() : null;
}

function listPackagesForAdmin() {
  return loadPackages();
}

function updatePackage(id, patch) {
  const data = loadPackages();
  const idx = data.packages.findIndex((p) => p.id === id);
  if (idx === -1) return { error: 'Không tìm thấy gói' };
  const prev = data.packages[idx];
  data.packages[idx] = {
    ...prev,
    ...patch,
    id: prev.id,
    promo: patch.promo ? { ...prev.promo, ...patch.promo } : prev.promo
  };
  savePackages(data);
  seedPromosFromPackages();
  return { ok: true, package: data.packages[idx] };
}

module.exports = {
  DEFAULT_PACKAGES,
  loadPackages,
  savePackages,
  seedPromosFromPackages,
  resolveCustomerOffers,
  getSuggestedFirstOrderCode,
  listPackagesForAdmin,
  updatePackage,
  isPromoTimeValid,
  vietnamNowParts
};
