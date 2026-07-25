'use strict';

/**
 * Shared proximity rules for shipper pickup (PURCHASED) + delivery (DELIVERED).
 * Requires a fresh GPS fix — never rely on stale order.shipperLat alone.
 */

const CONFIG = {
  DELIVERY_PROXIMITY_KM: 0.35,
  PICKUP_PROXIMITY_KM: 0.5,
  /** Quán chưa có GPS exact — vẫn kiểm tra với bán kính rộng hơn */
  PICKUP_INEXACT_PROXIMITY_KM: 0.85,
  /** GPS live trên server phải mới hơn ngưỡng này */
  FRESH_GPS_MS: 90000
};

/**
 * @param {object} opts
 * @param {'PURCHASED'|'DELIVERED'} opts.status
 * @param {object} opts.order
 * @param {number} opts.lat
 * @param {number} opts.lon
 * @param {number} [opts.gpsAgeMs] — age of the fix used (0 = body GPS just sent)
 * @param {function} opts.calcDistance
 */
function assertTripProximity(opts) {
  const {
    status,
    order,
    lat,
    lon,
    gpsAgeMs = 0,
    calcDistance
  } = opts || {};

  if (!order) return { ok: false, error: 'Không có đơn hàng' };
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { ok: false, error: 'Cần GPS để cập nhật trạng thái. Bật định vị và thử lại.' };
  }
  if (Number.isFinite(gpsAgeMs) && gpsAgeMs > CONFIG.FRESH_GPS_MS) {
    return {
      ok: false,
      error: 'GPS quá cũ. Chờ định vị cập nhật rồi thử lại.'
    };
  }

  if (status === 'DELIVERED') {
    const destLat = Number(order.pinnedLat ?? order.deliveryLat);
    const destLon = Number(order.pinnedLon ?? order.deliveryLon);
    if (!Number.isFinite(destLat) || !Number.isFinite(destLon)) {
      return {
        ok: false,
        error: 'Đơn chưa có tọa độ giao hàng. Liên hệ hỗ trợ trước khi hoàn thành.'
      };
    }
    const distKm = calcDistance(lat, lon, destLat, destLon);
    if (!Number.isFinite(distKm) || distKm > CONFIG.DELIVERY_PROXIMITY_KM) {
      return {
        ok: false,
        error:
          `Bạn còn cách điểm giao khoảng ${Math.round((distKm || 0) * 1000)}m. ` +
          `Hãy đến trong ${Math.round(CONFIG.DELIVERY_PROXIMITY_KM * 1000)}m rồi hoàn thành.`,
        distKm,
        limitKm: CONFIG.DELIVERY_PROXIMITY_KM
      };
    }
    return { ok: true, distKm, limitKm: CONFIG.DELIVERY_PROXIMITY_KM, target: 'delivery' };
  }

  if (status === 'PURCHASED') {
    const restLat = Number(order.restaurantLat);
    const restLon = Number(order.restaurantLon);
    if (!Number.isFinite(restLat) || !Number.isFinite(restLon)) {
      return {
        ok: false,
        error: 'Chưa có tọa độ quán trên đơn. Dùng nút chỉ đường và thử lại sau khi GPS quán sẵn sàng.'
      };
    }
    const exact = order.restaurantCoordsExact === true || order.restaurantCoordsExact === 'true';
    const limitKm = exact ? CONFIG.PICKUP_PROXIMITY_KM : CONFIG.PICKUP_INEXACT_PROXIMITY_KM;
    const distKm = calcDistance(lat, lon, restLat, restLon);
    if (!Number.isFinite(distKm) || distKm > limitKm) {
      return {
        ok: false,
        error:
          `Bạn còn cách quán khoảng ${Math.round((distKm || 0) * 1000)}m. ` +
          `Hãy đến trong ${Math.round(limitKm * 1000)}m rồi xác nhận lấy hàng.`,
        distKm,
        limitKm
      };
    }
    return { ok: true, distKm, limitKm, target: 'restaurant', exact };
  }

  return { ok: true };
}

module.exports = { CONFIG, assertTripProximity };
