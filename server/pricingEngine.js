'use strict';

/**
 * ShipFee pricing engine — pure functions (server-authoritative).
 * Matches PRICING.md: markup, distance surcharge, multi-item discount, min earning floor.
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
    const appUnit =
      calcAppPrice(inStoreBase, markupRate) +
      calcAppPrice(toppingResult.toppingsInStore, markupRate) +
      surchargePerItem;

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
  let appTotalRaw = 0;
  lineUnits.forEach((u) => {
    storeTotal += u.inStorePrice;
    appTotalRaw += u.appPrice;
  });

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

  let discountValue = 0;
  if (lineUnits.length > 1) {
    const perExtra = Math.max(2000, round100(surchargePerItem * multiItemDiscount));
    discountValue = perExtra * (lineUnits.length - 1);
  }

  const shipperEarningBeforeDiscount = appTotalRaw - storeTotal;
  let minServiceFee = 0;
  let appTotal = appTotalRaw;

  if (shipperEarningBeforeDiscount >= minShipperEarning) {
    discountValue = Math.min(
      discountValue,
      shipperEarningBeforeDiscount - minShipperEarning
    );
    appTotal = Math.max(0, appTotalRaw - discountValue);
  } else {
    discountValue = 0;
    minServiceFee = round100(minShipperEarning - shipperEarningBeforeDiscount);
    appTotal = appTotalRaw + minServiceFee;
  }

  return {
    items: pricedItems,
    storeTotal,
    appTotal,
    shipperEarning: Math.max(0, appTotal - storeTotal),
    discountValue,
    minServiceFee,
    surchargePerItem,
    itemCount: lineUnits.length
  };
}

module.exports = {
  round100,
  calcAppPrice,
  haversineKm,
  computeDistanceSurchargePerItem,
  recomputeOrderPricingFromMenu
};
