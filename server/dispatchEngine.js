'use strict';

/**
 * ShipFee dispatch engine — phát đơn đích danh (không bể chung FCFS).
 *
 * Ưu tiên:
 *  1) SOS (auto-accept)
 *  2) GPS tươi trong bán kính — idle / ghép đơn hợp lệ
 *  3) GPS stale/persisted trong bán kính rộng hơn
 *  4) ONLINE không GPS (điểm phạt) — tránh kẹt đơn
 *
 * Fairness nhẹ: ưu tiên tài xế rảnh, SSE đang kết nối, ít bị từ chối gần đây.
 */

const CONFIG = {
  MAX_ACTIVE_ORDERS_PER_SHIPPER: 2,
  BATCH_NEAR_RESTAURANT1_KM: 2,
  BATCH_NEAR_CUSTOMER1_KM: 2,
  BATCH_DELIVERY_CLUSTER_KM: 2,
  /** TTL đề xuất — đủ dài khi poll 5s / SSE nới; expire-loop ~5s để failover */
  OFFER_TTL_MS: 75000,
  GPS_FRESH_MS: 180000,
  GPS_STALE_OK_MS: 20 * 60 * 1000,
  MAX_PRIMARY_RADIUS_KM: 12,
  /** Khớp bán kính phục vụ Cần Thơ — tránh bỏ sót tài xế ở rìa thành phố */
  MAX_FALLBACK_RADIUS_KM: 30,
  /** Phạt nhẹ nếu vừa bị offer timeout / decline gần đây */
  RECENT_DECLINE_PENALTY: 1.25,
  SSE_CONNECTED_BONUS: 0.85
};

function assignOfferToShipper(order, shipper, cleanPhone, ttlMs = CONFIG.OFFER_TTL_MS) {
  if (!order || !shipper) return order;
  order.assignedShipperPhone = cleanPhone(shipper.phone);
  order.offerExpiresAt = Date.now() + ttlMs;
  order.offerAssignedAt = Date.now();
  return order;
}

function clearOrderOffer(order) {
  if (!order) return order;
  order.assignedShipperPhone = null;
  order.offerExpiresAt = null;
  return order;
}

function scoreBatchCandidate(existingOrder, candidateOrder, shipperDistToNewRestaurant, calcDistance) {
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
    const nearCust1Pickup = rest2ToCust1 <= CONFIG.BATCH_NEAR_CUSTOMER1_KM;
    const nearCust1Dropoff = deliv2ToCust1 <= CONFIG.BATCH_DELIVERY_CLUSTER_KM;
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

  const nearRest1 = rest2ToRest1 <= CONFIG.BATCH_NEAR_RESTAURANT1_KM;
  const nearCust1Dropoff = deliv2ToCust1 <= CONFIG.BATCH_DELIVERY_CLUSTER_KM;
  const nearCust1Pickup = rest2ToCust1 <= CONFIG.BATCH_NEAR_CUSTOMER1_KM;
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

function resolveShipperDispatchLocation(shipper, cleanedPhone, onlineShipperLocations, now = Date.now()) {
  const loc = onlineShipperLocations.get(cleanedPhone);
  if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) {
    const age = now - (loc.lastSeen || 0);
    if (age <= CONFIG.GPS_FRESH_MS) {
      return { lat: loc.lat, lon: loc.lon, ageMs: age, source: 'live' };
    }
    if (age <= CONFIG.GPS_STALE_OK_MS) {
      return { lat: loc.lat, lon: loc.lon, ageMs: age, source: 'memory-stale' };
    }
  }
  const lastLat = Number(shipper.lastLat);
  const lastLon = Number(shipper.lastLon);
  const lastAt = Number(shipper.lastLocationAt) || 0;
  if (Number.isFinite(lastLat) && Number.isFinite(lastLon) && lastAt && (now - lastAt) <= CONFIG.GPS_STALE_OK_MS) {
    return { lat: lastLat, lon: lastLon, ageMs: now - lastAt, source: 'persisted' };
  }
  return null;
}

function getShipperActiveOrders(phone, orders, cleanPhone) {
  const cleaned = cleanPhone(phone);
  return (orders || []).filter(o =>
    cleanPhone(o.shipperPhone) === cleaned &&
    (o.status === 'ACCEPTED' || o.status === 'PURCHASED')
  );
}

function wasRecentlyDeclined(order, cleanedPhone, cleanPhoneFn) {
  const list = order && Array.isArray(order.declinedShippers) ? order.declinedShippers : [];
  return list.some((p) => cleanPhoneFn(p) === cleanedPhone);
}

/**
 * @param {object} ctx
 * @param {number} restaurantLat
 * @param {number} restaurantLon
 * @param {string[]} declinedShippers
 * @param {object|null} candidateOrder
 */
function findNearestAvailableShipper(ctx, restaurantLat, restaurantLon, declinedShippers = [], candidateOrder = null) {
  const {
    calcDistance,
    cleanPhone,
    readShippersDatabase,
    readOrdersDatabase,
    onlineShipperLocations,
    isSseConnected
  } = ctx;

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
      pinnedLon: null,
      declinedShippers: declinedShippers || []
    };

    // 🆘 ƯU TIÊN 1: SOS
    let assistanceShipper = null;
    let minAssistanceDist = Infinity;
    for (const s of onlineShippers) {
      const cleanedPhone = cleanPhone(s.phone);
      if (cleanDeclined.includes(cleanedPhone)) continue;
      if (getShipperActiveOrders(cleanedPhone, orders, cleanPhone).length >= CONFIG.MAX_ACTIVE_ORDERS_PER_SHIPPER) continue;
      if (s.assistanceRequested !== true) continue;
      const resolved = resolveShipperDispatchLocation(s, cleanedPhone, onlineShipperLocations, now);
      const dist = resolved
        ? calcDistance(restaurantLat, restaurantLon, resolved.lat, resolved.lon)
        : 0;
      if (dist < minAssistanceDist) {
        minAssistanceDist = dist;
        assistanceShipper = {
          phone: s.phone,
          name: s.name,
          distance: dist,
          isAssisted: true,
          activeLoad: getShipperActiveOrders(cleanedPhone, orders, cleanPhone).length,
          batchCompatible: false
        };
      }
    }
    if (assistanceShipper) {
      console.log(`[Priority Dispatch] 🎯 SOS ${assistanceShipper.name} (${assistanceShipper.phone}), load=${assistanceShipper.activeLoad}`);
      return assistanceShipper;
    }

    const evaluateCandidate = (s, { requireLiveGps, maxRadiusKm, scorePadding }) => {
      const cleanedPhone = cleanPhone(s.phone);
      if (cleanDeclined.includes(cleanedPhone)) return null;
      const activeOrders = getShipperActiveOrders(cleanedPhone, orders, cleanPhone);
      if (activeOrders.length >= CONFIG.MAX_ACTIVE_ORDERS_PER_SHIPPER) return null;

      // Per-shipper blacklist: skip this customer for this shipper
      const customerPhone = cleanPhone(orderHint.deliveryPhone || orderHint.ordererPhone);
      if (customerPhone && ctx.customerOps) {
        const bl = ctx.customerOps.isShipperBlacklistedCustomer(cleanedPhone, customerPhone);
        if (bl) return null;
      }

      const resolved = resolveShipperDispatchLocation(s, cleanedPhone, onlineShipperLocations, now);
      if (requireLiveGps && (!resolved || resolved.source !== 'live')) return null;

      let distToRestaurant = 25;
      let locSource = 'online-no-gps';
      if (resolved) {
        distToRestaurant = calcDistance(restaurantLat, restaurantLon, resolved.lat, resolved.lon);
        if (!Number.isFinite(distToRestaurant)) distToRestaurant = 25;
        locSource = resolved.source;
      }

      if (Number.isFinite(maxRadiusKm) && distToRestaurant > maxRadiusKm) return null;

      // Đang mang 1 đơn: chỉ nhận nếu ghép được (tránh ép đơn xa)
      let score = distToRestaurant + (scorePadding || 0);
      let batchCompatible = false;
      let batchReason = activeOrders.length === 0 ? 'IDLE' : 'LOAD+1';
      if (activeOrders.length === 1) {
        if (!resolved) return null;
        const batch = scoreBatchCandidate(activeOrders[0], orderHint, distToRestaurant, calcDistance);
        if (!batch.batchCompatible) return null;
        score = batch.score + (scorePadding || 0);
        batchCompatible = true;
        batchReason = batch.reason;
      } else if (activeOrders.length === 0) {
        // Idle: ưu tiên gần quán
        score = distToRestaurant * 1.0 + (scorePadding || 0);
      }

      // Fairness / connectivity
      if (typeof isSseConnected === 'function' && isSseConnected(cleanedPhone)) {
        score *= CONFIG.SSE_CONNECTED_BONUS;
      }
      if (wasRecentlyDeclined(orderHint, cleanedPhone, cleanPhone)) {
        score += CONFIG.RECENT_DECLINE_PENALTY;
      }
      // Ưu tiên idle hơn load+1 khi điểm gần bằng
      if (activeOrders.length === 0) score *= 0.92;

      // Prefer shipper who previously delivered to this customer
      let preferCount = 0;
      if (ctx.customerOps && customerPhone) {
        const boosted = ctx.customerOps.applyPreferShipperBoost(
          score, cleanedPhone, orderHint, orders, cleanPhone
        );
        score = boosted.score;
        preferCount = boosted.preferCount;
      }

      return {
        phone: s.phone,
        name: s.name,
        distance: distToRestaurant,
        activeLoad: activeOrders.length,
        batchCompatible,
        batchReason,
        score,
        locSource,
        preferCount
      };
    };

    // 🚴 ƯU TIÊN 2: GPS tươi trong bán kính chính
    let bestShipper = null;
    let bestScore = Infinity;
    for (const s of onlineShippers) {
      const cand = evaluateCandidate(s, {
        requireLiveGps: true,
        maxRadiusKm: CONFIG.MAX_PRIMARY_RADIUS_KM,
        scorePadding: 0
      });
      if (!cand || !Number.isFinite(cand.score)) continue;
      if (cand.score < bestScore) {
        bestScore = cand.score;
        bestShipper = cand;
      }
    }
    if (bestShipper) {
      const tag = bestShipper.batchCompatible
        ? `GHÉP ĐƠN:${bestShipper.batchReason}`
        : (bestShipper.activeLoad === 0 ? 'ĐƠN LẺ' : 'LOAD+1');
      const prefer = bestShipper.preferCount
        ? ` prefer×${bestShipper.preferCount}`
        : '';
      console.log(`[Dispatch] 🎯 Chọn ${bestShipper.name} (${bestShipper.phone}) [${tag}${prefer}] dist=${bestShipper.distance.toFixed(2)}km score=${bestScore.toFixed(2)}`);
      return bestShipper;
    }

    // 🛟 ƯU TIÊN 3: GPS stale / persisted / không GPS — bán kính rộng hơn
    let fallbackShipper = null;
    let fallbackScore = Infinity;
    for (const s of onlineShippers) {
      const cand = evaluateCandidate(s, {
        requireLiveGps: false,
        maxRadiusKm: CONFIG.MAX_FALLBACK_RADIUS_KM,
        scorePadding: 2.5
      });
      if (!cand || !Number.isFinite(cand.score)) continue;
      // Không GPS: chỉ dùng khi không ai khác trong bán kính
      if (cand.locSource === 'online-no-gps') {
        cand.score += 6;
      } else if (cand.locSource !== 'live') {
        cand.score += 1.5;
      }
      if (cand.score < fallbackScore) {
        fallbackScore = cand.score;
        fallbackShipper = cand;
      }
    }

    if (fallbackShipper) {
      console.log(
        `[Dispatch] 🛟 Fallback gán ${fallbackShipper.name} (${fallbackShipper.phone}) ` +
        `source=${fallbackShipper.locSource} dist=${fallbackShipper.distance.toFixed(2)}km`
      );
    } else {
      console.log('[Dispatch] ⚠️ Không có tài xế ONLINE khả dụng trong bán kính');
    }
    return fallbackShipper;
  } catch (e) {
    console.error('[Dispatch Error] findNearestAvailableShipper:', e.message);
    return null;
  }
}

/**
 * Hết hạn offer + gán lại đơn PENDING chưa có đề xuất.
 */
async function processExpiredOffers(ctx) {
  const { readOrdersDatabase, updateOrdersDatabase, cleanPhone } = ctx;
  const now = Date.now();
  const orders = readOrdersDatabase();
  const expiredOrders = orders.filter(o =>
    o.status === 'PENDING' &&
    o.assignedShipperPhone &&
    o.offerExpiresAt &&
    now > o.offerExpiresAt
  );
  const unassignedPending = orders.filter(o => o.status === 'PENDING' && !o.assignedShipperPhone);
  if (expiredOrders.length === 0 && unassignedPending.length === 0) return { changed: false };

  let changed = false;
  await updateOrdersDatabase((dbOrders) => {
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
        ctx,
        dbOrders[idx].restaurantLat,
        dbOrders[idx].restaurantLon,
        dbOrders[idx].declinedShippers,
        dbOrders[idx]
      );
      if (nextNearest) {
        if (nextNearest.isAssisted === true) {
          dbOrders[idx].status = 'ACCEPTED';
          dbOrders[idx].acceptedAt = Date.now();
          dbOrders[idx].shipperPhone = cleanPhone(nextNearest.phone);
          dbOrders[idx].shipperName = nextNearest.name;
          clearOrderOffer(dbOrders[idx]);
          console.log(`[SOS Redispatch] ⚡ Đơn ${dbOrders[idx].id} auto-accept cho SOS ${nextNearest.name}`);
        } else {
          assignOfferToShipper(dbOrders[idx], nextNearest, cleanPhone);
          console.log(`[Dispatch] 🎯 Đơn ${dbOrders[idx].id} chuyển tiếp đề xuất cho ${nextNearest.name} (${nextNearest.phone})`);
        }
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
        ctx,
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
        assignOfferToShipper(dbOrders[idx], nextNearest, cleanPhone);
        console.log(`[Dispatch] 🔁 Đơn chờ ${dbOrders[idx].id} được đề xuất cho ${nextNearest.name} (${nextNearest.phone})`);
      }
      changed = true;
    }
    return changed;
  });

  return { changed };
}

/** Throttle redisp khi GPS/presence vừa tới */
let lastPresenceDispatchAt = 0;
const PRESENCE_DISPATCH_COOLDOWN_MS = 4000;

async function tryDispatchOnPresence(ctx, { force = false } = {}) {
  const now = Date.now();
  if (!force && (now - lastPresenceDispatchAt) < PRESENCE_DISPATCH_COOLDOWN_MS) {
    return { skipped: true };
  }
  const orders = ctx.readOrdersDatabase();
  const needs = orders.some(o =>
    o.status === 'PENDING' &&
    (!o.assignedShipperPhone || (o.offerExpiresAt && now > o.offerExpiresAt))
  );
  if (!needs) return { skipped: true, reason: 'none' };
  lastPresenceDispatchAt = now;
  return processExpiredOffers(ctx);
}

module.exports = {
  CONFIG,
  assignOfferToShipper,
  clearOrderOffer,
  scoreBatchCandidate,
  resolveShipperDispatchLocation,
  findNearestAvailableShipper,
  processExpiredOffers,
  tryDispatchOnPresence,
  getShipperActiveOrders
};
