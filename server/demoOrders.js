/**
 * Demo orders for shipper Hiệu suất / bottom-sheet testing.
 * All rows marked isDemo:true so they can be wiped before go-live.
 */

function cleanPhone(p) {
  return String(p || '').trim().replace(/\s+/g, '');
}

function dayOffsetMs(daysAgo, hour = 12, minute = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

function buildDemoOrders(shipper, restaurants = []) {
  const phone = cleanPhone(shipper.phone);
  const name = shipper.name || 'Shipper Demo';
  const pickRest = (i) => {
    const r = restaurants[i % Math.max(1, restaurants.length)] || null;
    return {
      id: r?.id || `demo-rest-${i}`,
      name: r?.name || `Quán Demo ${i + 1}`,
      address: r?.address || `${100 + i} Nguyễn Văn Cừ, Ninh Kiều, Cần Thơ`,
      lat: typeof r?.latitude === 'number' ? r.latitude : 10.0345 + i * 0.001,
      lon: typeof r?.longitude === 'number' ? r.longitude : 105.7876 + i * 0.001
    };
  };

  const specs = [
    // Hôm nay
    { ago: 0, h: 9, m: 20, store: 85000, app: 118000, earn: 33000, rating: 5 },
    { ago: 0, h: 12, m: 5, store: 120000, app: 162000, earn: 42000, rating: 4 },
    { ago: 0, h: 18, m: 40, store: 65000, app: 95000, earn: 30000, rating: 5 },
    // 7 ngày gần đây
    { ago: 1, h: 11, m: 10, store: 99000, app: 135000, earn: 36000, rating: 5 },
    { ago: 1, h: 19, m: 25, store: 78000, app: 110000, earn: 32000, rating: 4 },
    { ago: 3, h: 10, m: 45, store: 150000, app: 198000, earn: 48000, rating: 5 },
    { ago: 3, h: 17, m: 15, store: 55000, app: 82000, earn: 27000, rating: 3 },
    { ago: 5, h: 13, m: 30, store: 110000, app: 149000, earn: 39000, rating: 5 },
    // Tháng này (xa hơn 7 ngày nếu hôm nay >= 8)
    { ago: 10, h: 12, m: 0, store: 88000, app: 125000, earn: 37000, rating: 4 },
    { ago: 14, h: 20, m: 10, store: 140000, app: 185000, earn: 45000, rating: 5 }
  ];

  return specs.map((s, i) => {
    const rest = pickRest(i);
    const createdAt = dayOffsetMs(s.ago, s.h, s.m);
    const acceptedAt = createdAt + 2 * 60 * 1000;
    const purchasedAt = createdAt + 18 * 60 * 1000;
    const deliveredAt = createdAt + 35 * 60 * 1000;
    const id = `DEMO-${String(i + 1).padStart(3, '0')}-${s.ago}D`;
    return {
      id,
      isDemo: true,
      restaurantId: rest.id,
      restaurantName: rest.name,
      restaurantAddress: rest.address,
      restaurantLat: rest.lat,
      restaurantLon: rest.lon,
      restaurantCoordsExact: true,
      items: [
        {
          id: `demo-item-${i}-1`,
          name: 'Món demo A',
          price: Math.round(s.store * 0.6),
          quantity: 1,
          note: '',
          selectedOptions: []
        },
        {
          id: `demo-item-${i}-2`,
          name: 'Món demo B',
          price: Math.round(s.store * 0.4),
          quantity: 1,
          note: 'Ít đá',
          selectedOptions: []
        }
      ],
      storeTotal: s.store,
      appTotal: s.app,
      shipperEarning: s.earn,
      discountValue: 0,
      minServiceFee: 0,
      promoCode: null,
      promoDiscount: 0,
      status: 'DELIVERED',
      shipperId: shipper.id || null,
      shipperName: name,
      shipperPhone: phone,
      shipperLat: rest.lat + 0.002,
      shipperLon: rest.lon - 0.002,
      deliveryAddress: `${50 + i} Mậu Thân, Ninh Kiều, Cần Thơ`,
      deliveryName: `Khách Demo ${i + 1}`,
      deliveryPhone: `09${String(80000000 + i).slice(0, 8)}`,
      ordererPhone: `09${String(80000000 + i).slice(0, 8)}`,
      pinnedLat: rest.lat + 0.004,
      pinnedLon: rest.lon - 0.003,
      isRelative: false,
      note: 'Đơn mẫu — dùng để test Hiệu suất',
      createdAt,
      acceptedAt,
      purchasedAt,
      deliveredAt,
      rating: s.rating,
      comment: s.rating >= 5 ? 'Giao nhanh, thái độ tốt' : 'OK',
      assignedShipperPhone: null,
      offerExpiresAt: null,
      declinedShippers: [],
      messages: []
    };
  });
}

function stripDemoOrders(orders) {
  return (Array.isArray(orders) ? orders : []).filter(o => !o || o.isDemo !== true);
}

function upsertDemoOrders(orders, shipper, restaurants) {
  const base = stripDemoOrders(orders);
  const demos = buildDemoOrders(shipper, restaurants);
  return base.concat(demos);
}

module.exports = {
  buildDemoOrders,
  stripDemoOrders,
  upsertDemoOrders,
  cleanPhone
};
