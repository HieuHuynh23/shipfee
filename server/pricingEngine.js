'use strict';

/**
 * ShipFee pricing engine — pure functions (server-authoritative).
 * Menu = in-store price; fees at checkout (60% platform / 40% delivery display).
 * Shipper: min floor + 70% of surplus above floor.
 */

function round100(value) {
  return Math.round(Number(value || 0) / 100) * 100;
}

function calcAppPrice(inStorePrice, markupRate) {
  return round100(Number(inStorePrice || 0) * (1 + Number(markupRate || 0)));
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function computeDistanceSurchargePerItem(restLat, restLon, pinLat, pinLon, cfg) {
  const rLat = Number(restLat);
  const rLon = Number(restLon);
  const pLat = Number(pinLat);
  const pLon = Number(pinLon);
  if (![rLat, rLon, pLat, pLon].every(Number.isFinite)) return 0;
  const freeKm = Number(cfg.freeDistanceKm ?? 1.5);
  const coeff = Number(cfg.surchargeCoefficient ?? 7000);
  const distKm = haversineKm(pLat, pLon, rLat, rLon);
  if (!(distKm > freeKm)) return 0;
  return round100(coeff * Math.sqrt(distKm - freeKm));
}

function findMenuItemById(menu, itemId) {
  if (!itemId || !Array.isArray(menu)) return null;
  const id = String(itemId);
  return menu.find((m) => m && String(m.id) === id) || null;
}

function resolveToppingsFromMenu(menuItem, selectedOptions) {
  const resolved = [];
  let toppingsInStore = 0;
  for (const opt of Array.isArray(selectedOptions) ? selectedOptions : []) {
    let matched = null;
    for (const group of menuItem.options || []) {
      matched = (group.items || []).find(
        (i) =>
          (opt.id != null && String(i.id) === String(opt.id)) ||
          (opt.name && i.name === opt.name)
      );
      if (matched) break;
    }
    if (!matched) {
      return { error: `Topping không hợp lệ: ${opt.name || opt.id || '?'}` };
    }
    const price = Number(matched.price) || 0;
    toppingsInStore += price;
    resolved.push({ id: matched.id, name: matched.name, price });
  }
  return { toppingsInStore, resolved };
}

function splitFeePool(feePool, platformShare) {
  const share = Number(platformShare);
  const platformFee = round100(feePool * (Number.isFinite(share) ? share : 0.6));
  const deliveryFee = Math.max(0, feePool - platformFee);
  return { platformFee, deliveryFee };
}

function computeShipperEarning(feePool, minShipperEarning, surplusShare) {
  const minE = Number(minShipperEarning ?? 15000);
  const share = Number(surplusShare ?? 0.7);
  if (feePool <= minE) return Math.max(0, feePool);
  const surplus = feePool - minE;
  return minE + round100(surplus * share);
}

function buildFeeWaiverHint({
  storeTotal,
  itemCount,
  feePool,
  platformFee,
  deliveryFee,
  minShipperEarning,
  cfg,
  platformWaived,
  deliveryHalfApplied,
  surchargePerItem,
  markupRate
}) {
  const waiveStore = Number(cfg.waivePlatformMinStoreTotal ?? 79000);
  const waiveItems = Number(cfg.waivePlatformMinItems ?? 3);
  const halfStore = Number(cfg.halfDeliveryMinStoreTotal ?? 120000);
  const halfItems = Number(cfg.halfDeliveryMinItems ?? 3);
  const markup = Number(markupRate ?? cfg.markupRate ?? 0.28);
  const surcharge = Number(surchargePerItem || 0);

  // Ước tính số tiền giảm THỰC TẾ nếu đạt ngưỡng (không dùng maxSavable hiện tại — đơn nhỏ đang = 0)
  function estimateWaiveSave(targetStore, targetItems, kind) {
    const simStore = Math.max(storeTotal, targetStore);
    const simItems = Math.max(itemCount, targetItems);
    let simFee = round100(simStore * markup) + surcharge * simItems;
    if (simFee < minShipperEarning) simFee = minShipperEarning;
    const split = splitFeePool(simFee, Number(cfg.platformFeeShare ?? 0.6));
    if (kind === 'platform') {
      return Math.min(split.platformFee, Math.max(0, simFee - minShipperEarning));
    }
    const half = round100(split.deliveryFee * 0.5);
    return Math.min(half, Math.max(0, simFee - minShipperEarning));
  }

  if (!platformWaived && storeTotal < waiveStore && itemCount < waiveItems) {
    const amountShort = Math.max(0, waiveStore - storeTotal);
    const itemsShort = Math.max(0, waiveItems - itemCount);
    const saveAmount = estimateWaiveSave(waiveStore, waiveItems, 'platform');
    if ((amountShort > 0 || itemsShort > 0) && saveAmount > 0) {
      return {
        target: 'platform',
        amountShort,
        itemsShort,
        currentFee: platformFee,
        saveAmount,
        thresholdStoreTotal: waiveStore,
        thresholdItems: waiveItems
      };
    }
  }

  if (!deliveryHalfApplied && storeTotal < halfStore && itemCount < halfItems) {
    const amountShort = Math.max(0, halfStore - storeTotal);
    const itemsShort = Math.max(0, halfItems - itemCount);
    const saveAmount = estimateWaiveSave(halfStore, halfItems, 'delivery');
    if ((amountShort > 0 || itemsShort > 0) && saveAmount > 0) {
      return {
        target: 'delivery',
        amountShort,
        itemsShort,
        currentFee: deliveryFee,
        saveAmount,
        thresholdStoreTotal: halfStore,
        thresholdItems: halfItems
      };
    }
  }

  return null;
}

/**
 * @param {object} params
 * @param {Array} params.clientItems
 * @param {Array} params.menu
 * @param {number} params.restLat
 * @param {number} params.restLon
 * @param {number|null} params.pinLat
 * @param {number|null} params.pinLon
 * @param {object} params.cfg pricingConfig
 */
function recomputeOrderPricingFromMenu({
  clientItems,
  menu,
  restLat,
  restLon,
  pinLat,
  pinLon,
  cfg
}) {
  const markupRate = Number(cfg.markupRate ?? 0.28);
  const multiItemDiscount = Number(cfg.multiItemDiscount ?? 0.15);
  const minShipperEarning = Number(cfg.minShipperEarning ?? 15000);
  const platformShare = Number(cfg.platformFeeShare ?? 0.6);
  const surplusShare = Number(cfg.shipperSurplusShare ?? 0.7);
  const waivePlatformMinItems = Number(cfg.waivePlatformMinItems ?? 3);
  const waivePlatformMinStoreTotal = Number(cfg.waivePlatformMinStoreTotal ?? 79000);
  const halfDeliveryMinItems = Number(cfg.halfDeliveryMinItems ?? 3);
  const halfDeliveryMinStoreTotal = Number(cfg.halfDeliveryMinStoreTotal ?? 120000);

  if (!Array.isArray(clientItems) || clientItems.length === 0) {
    return { error: 'Đơn hàng không có món' };
  }
  if (!Array.isArray(menu) || menu.length === 0) {
    return { error: 'Không tải được thực đơn quán để tính giá' };
  }

  const surchargePerItem = computeDistanceSurchargePerItem(
    restLat,
    restLon,
    pinLat,
    pinLon,
    cfg
  );
  const lineUnits = [];

  for (const raw of clientItems) {
    const qty = Math.max(1, parseInt(raw.quantity || raw.qty || 1, 10) || 1);
    const lookupId = String(
      raw.realItemId || String(raw.id || '').split('::')[0] || ''
    ).trim();
    const menuItem = findMenuItemById(menu, lookupId);
    if (!menuItem) {
      return { error: `Món không hợp lệ hoặc đã hết: ${raw.name || lookupId}` };
    }
    const inStoreBase = Number(menuItem.inStorePrice);
    if (!Number.isFinite(inStoreBase) || inStoreBase < 0) {
      return { error: `Giá món không hợp lệ: ${menuItem.name}` };
    }
    const toppingResult = resolveToppingsFromMenu(menuItem, raw.selectedOptions);
    if (toppingResult.error) return { error: toppingResult.error };

    const inStoreUnit = inStoreBase + toppingResult.toppingsInStore;
    // Food line = store price only (fees are separate at checkout)
    const appUnit = inStoreUnit;

    for (let i = 0; i < qty; i++) {
      lineUnits.push({
        id: lookupId,
        name: menuItem.name,
        inStorePrice: inStoreUnit,
        appPrice: appUnit,
        selectedOptions: toppingResult.resolved,
        note: raw.note || ''
      });
    }
  }

  if (lineUnits.length === 0) {
    return { error: 'Không có món hợp lệ trong đơn' };
  }

  let storeTotal = 0;
  lineUnits.forEach((u) => {
    storeTotal += u.inStorePrice;
  });
  const itemCount = lineUnits.length;

  const mergedMap = new Map();
  lineUnits.forEach((u) => {
    const key = `${u.id}|${JSON.stringify(u.selectedOptions)}|${u.note}`;
    if (!mergedMap.has(key)) {
      mergedMap.set(key, {
        id: u.id,
        realItemId: u.id,
        name: u.name,
        price: u.appPrice,
        inStorePrice: u.inStorePrice,
        appPrice: u.appPrice,
        quantity: 0,
        note: u.note,
        selectedOptions: u.selectedOptions
      });
    }
    mergedMap.get(key).quantity += 1;
  });
  const pricedItems = Array.from(mergedMap.values());

  const distanceSurchargeTotal = surchargePerItem * itemCount;
  const markupFee = round100(storeTotal * markupRate);
  let feePoolRaw = markupFee + distanceSurchargeTotal;

  let discountValue = 0;
  if (itemCount > 1) {
    const avgUnit = storeTotal / itemCount;
    const perExtra = Math.max(
      2000,
      round100(surchargePerItem * multiItemDiscount + avgUnit * 0.03)
    );
    discountValue = perExtra * (itemCount - 1);
    discountValue = Math.min(discountValue, Math.max(0, feePoolRaw - minShipperEarning));
  }

  let feePool = Math.max(0, feePoolRaw - discountValue);
  let minServiceFee = 0;
  if (feePool < minShipperEarning) {
    minServiceFee = round100(minShipperEarning - feePool);
    feePool = minShipperEarning;
  }

  let { platformFee, deliveryFee } = splitFeePool(feePool, platformShare);

  const canWaivePlatform =
    storeTotal >= waivePlatformMinStoreTotal || itemCount >= waivePlatformMinItems;
  const canHalfDelivery =
    storeTotal >= halfDeliveryMinStoreTotal || itemCount >= halfDeliveryMinItems;

  let platformWaivedAmount = 0;
  let deliveryHalfAmount = 0;
  let platformWaived = false;
  let deliveryHalfApplied = false;

  if (canWaivePlatform && platformFee > 0) {
    const maxWaive = Math.max(0, feePool - minShipperEarning);
    platformWaivedAmount = Math.min(platformFee, maxWaive);
    if (platformWaivedAmount > 0) {
      feePool -= platformWaivedAmount;
      platformWaived = true;
      ({ platformFee, deliveryFee } = splitFeePool(feePool, platformShare));
    }
  }

  if (canHalfDelivery && deliveryFee > 0) {
    const half = round100(deliveryFee * 0.5);
    const maxWaive = Math.max(0, feePool - minShipperEarning);
    deliveryHalfAmount = Math.min(half, maxWaive);
    if (deliveryHalfAmount > 0) {
      feePool -= deliveryHalfAmount;
      deliveryHalfApplied = true;
      ({ platformFee, deliveryFee } = splitFeePool(feePool, platformShare));
    }
  }

  const shipperEarning = computeShipperEarning(feePool, minShipperEarning, surplusShare);
  const platformKeep = Math.max(0, feePool - shipperEarning);
  const appTotal = storeTotal + feePool;

  const feeWaiverHint = buildFeeWaiverHint({
    storeTotal,
    itemCount,
    feePool,
    platformFee,
    deliveryFee,
    minShipperEarning,
    cfg,
    platformWaived,
    deliveryHalfApplied,
    surchargePerItem,
    markupRate
  });

  return {
    items: pricedItems,
    storeTotal,
    appTotal,
    feePool,
    platformFee,
    deliveryFee,
    platformKeep,
    shipperEarning,
    discountValue,
    minServiceFee,
    platformWaivedAmount,
    deliveryHalfAmount,
    platformWaived,
    deliveryHalfApplied,
    surchargePerItem,
    itemCount,
    feeWaiverHint
  };
}

/** Client-side mirror: totals from cart lines already priced at in-store. */
function computeCartFeeTotals({
  storeTotal,
  itemCount,
  surchargePerItem,
  cfg
}) {
  const markupRate = Number(cfg.markupRate ?? 0.28);
  const multiItemDiscount = Number(cfg.multiItemDiscount ?? 0.15);
  const minShipperEarning = Number(cfg.minShipperEarning ?? 15000);
  const platformShare = Number(cfg.platformFeeShare ?? 0.6);
  const surplusShare = Number(cfg.shipperSurplusShare ?? 0.7);
  const waivePlatformMinItems = Number(cfg.waivePlatformMinItems ?? 3);
  const waivePlatformMinStoreTotal = Number(cfg.waivePlatformMinStoreTotal ?? 79000);
  const halfDeliveryMinItems = Number(cfg.halfDeliveryMinItems ?? 3);
  const halfDeliveryMinStoreTotal = Number(cfg.halfDeliveryMinStoreTotal ?? 120000);

  if (!itemCount || storeTotal <= 0) {
    return {
      storeTotal: 0,
      appTotal: 0,
      feePool: 0,
      platformFee: 0,
      deliveryFee: 0,
      shipperEarning: 0,
      discountValue: 0,
      minServiceFee: 0,
      platformWaivedAmount: 0,
      deliveryHalfAmount: 0,
      platformWaived: false,
      deliveryHalfApplied: false,
      itemCount: 0,
      feeWaiverHint: null
    };
  }

  const distanceSurchargeTotal = (Number(surchargePerItem) || 0) * itemCount;
  const markupFee = round100(storeTotal * markupRate);
  let feePoolRaw = markupFee + distanceSurchargeTotal;

  let discountValue = 0;
  if (itemCount > 1) {
    const avgUnit = storeTotal / itemCount;
    const perExtra = Math.max(
      2000,
      round100((Number(surchargePerItem) || 0) * multiItemDiscount + avgUnit * 0.03)
    );
    discountValue = perExtra * (itemCount - 1);
    discountValue = Math.min(discountValue, Math.max(0, feePoolRaw - minShipperEarning));
  }

  let feePool = Math.max(0, feePoolRaw - discountValue);
  let minServiceFee = 0;
  if (feePool < minShipperEarning) {
    minServiceFee = round100(minShipperEarning - feePool);
    feePool = minShipperEarning;
  }

  let { platformFee, deliveryFee } = splitFeePool(feePool, platformShare);

  const canWaivePlatform =
    storeTotal >= waivePlatformMinStoreTotal || itemCount >= waivePlatformMinItems;
  const canHalfDelivery =
    storeTotal >= halfDeliveryMinStoreTotal || itemCount >= halfDeliveryMinItems;

  let platformWaivedAmount = 0;
  let deliveryHalfAmount = 0;
  let platformWaived = false;
  let deliveryHalfApplied = false;

  if (canWaivePlatform && platformFee > 0) {
    const maxWaive = Math.max(0, feePool - minShipperEarning);
    platformWaivedAmount = Math.min(platformFee, maxWaive);
    if (platformWaivedAmount > 0) {
      feePool -= platformWaivedAmount;
      platformWaived = true;
      ({ platformFee, deliveryFee } = splitFeePool(feePool, platformShare));
    }
  }

  if (canHalfDelivery && deliveryFee > 0) {
    const half = round100(deliveryFee * 0.5);
    const maxWaive = Math.max(0, feePool - minShipperEarning);
    deliveryHalfAmount = Math.min(half, maxWaive);
    if (deliveryHalfAmount > 0) {
      feePool -= deliveryHalfAmount;
      deliveryHalfApplied = true;
      ({ platformFee, deliveryFee } = splitFeePool(feePool, platformShare));
    }
  }

  const shipperEarning = computeShipperEarning(feePool, minShipperEarning, surplusShare);
  const appTotal = storeTotal + feePool;

  const feeWaiverHint = buildFeeWaiverHint({
    storeTotal,
    itemCount,
    feePool,
    platformFee,
    deliveryFee,
    minShipperEarning,
    cfg: {
      waivePlatformMinStoreTotal,
      waivePlatformMinItems,
      halfDeliveryMinStoreTotal,
      halfDeliveryMinItems,
      platformFeeShare: platformShare,
      markupRate
    },
    platformWaived,
    deliveryHalfApplied,
    surchargePerItem: Number(surchargePerItem) || 0,
    markupRate
  });

  return {
    storeTotal,
    appTotal,
    feePool,
    platformFee,
    deliveryFee,
    shipperEarning,
    discountValue,
    minServiceFee,
    platformWaivedAmount,
    deliveryHalfAmount,
    platformWaived,
    deliveryHalfApplied,
    itemCount,
    feeWaiverHint
  };
}

module.exports = {
  round100,
  calcAppPrice,
  haversineKm,
  computeDistanceSurchargePerItem,
  splitFeePool,
  computeShipperEarning,
  recomputeOrderPricingFromMenu,
  computeCartFeeTotals
};
