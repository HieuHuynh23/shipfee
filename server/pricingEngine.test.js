'use strict';

const assert = require('assert');
const {
  round100,
  recomputeOrderPricingFromMenu,
  computeDistanceSurchargePerItem
} = require('./pricingEngine');

const cfg = {
  markupRate: 0.28,
  multiItemDiscount: 0.15,
  minShipperEarning: 15000,
  freeDistanceKm: 1.5,
  surchargeCoefficient: 7000
};

function pinAtKm(restLat, restLon, km) {
  return { lat: restLat + km / 111, lon: restLon };
}

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    console.error(`✗ ${name}`);
    throw e;
  }
}

test('surcharge ~3km ≈ 8600', () => {
  const pin = pinAtKm(10, 105, 3);
  const s = computeDistanceSurchargePerItem(10, 105, pin.lat, pin.lon, cfg);
  assert.strictEqual(s, 8600);
});

test('1 item: no multi-item discount', () => {
  const pin = pinAtKm(10, 105, 3);
  const menu = [{ id: '1', name: 'Pho', inStorePrice: 35000, options: [] }];
  const r = recomputeOrderPricingFromMenu({
    clientItems: [{ id: '1', quantity: 1 }],
    menu,
    restLat: 10,
    restLon: 105,
    pinLat: pin.lat,
    pinLon: pin.lon,
    cfg
  });
  assert.strictEqual(r.discountValue, 0);
  assert.strictEqual(r.appTotal, 53400);
});

test('2 identical items @3km: 15% of cheaper(=same) appPrice', () => {
  const pin = pinAtKm(10, 105, 3);
  const menu = [{ id: '1', name: 'Pho', inStorePrice: 35000, options: [] }];
  const r = recomputeOrderPricingFromMenu({
    clientItems: [{ id: '1', quantity: 2 }],
    menu,
    restLat: 10,
    restLon: 105,
    pinLat: pin.lat,
    pinLon: pin.lon,
    cfg
  });
  // round100(53400 * 0.15) = 8000
  assert.strictEqual(r.discountValue, 8000);
  assert.strictEqual(r.appTotal, 106800 - 8000);
  assert.strictEqual(r.shipperEarning, 98800 - 70000);
});

test('2 items different prices: discount applies to cheaper item only', () => {
  const pin = pinAtKm(10, 105, 3);
  const menu = [
    { id: '1', name: 'Pho', inStorePrice: 35000, options: [] },
    { id: '2', name: 'Tra', inStorePrice: 20000, options: [] }
  ];
  const r = recomputeOrderPricingFromMenu({
    clientItems: [
      { id: '1', quantity: 1 },
      { id: '2', quantity: 1 }
    ],
    menu,
    restLat: 10,
    restLon: 105,
    pinLat: pin.lat,
    pinLon: pin.lon,
    cfg
  });
  // Pho 53400 (primary), Tra 34200 → discount max(2000, round100(34200*0.15)) = 5100
  assert.strictEqual(r.discountValue, 5100);
  assert.strictEqual(r.appTotal, 53400 + 34200 - 5100);
});

test('2 items near: discount capped by shipper floor', () => {
  const pin = pinAtKm(10, 105, 1);
  const menu = [{ id: '1', name: 'Pho', inStorePrice: 35000, options: [] }];
  const r = recomputeOrderPricingFromMenu({
    clientItems: [{ id: '1', quantity: 2 }],
    menu,
    restLat: 10,
    restLon: 105,
    pinLat: pin.lat,
    pinLon: pin.lon,
    cfg
  });
  // raw discount 6700, earning before 19600 → cap to 4600
  assert.strictEqual(r.discountValue, 4600);
  assert.strictEqual(r.appTotal, 89600 - 4600);
  assert.strictEqual(r.shipperEarning, 15000);
  assert.strictEqual(r.minServiceFee, 0);
});

test('min 2000đ floor for very cheap second item', () => {
  const pin = pinAtKm(10, 105, 3);
  // B appPrice = 6400 + 8600 = 15000; 15% = 2250 → round100 2300? 15000*0.15=2250 → 2300
  // Use tinier item so 15% < 2000: inStore 3000 → app = round100(3840)+8600 = 3800+8600 = 12400
  // 12400*0.15 = 1860 → 1900; still need < 2000. inStore 2000 → 2600+8600=11200; *0.15=1680→1700
  const menu = [
    { id: '1', name: 'A', inStorePrice: 50000, options: [] },
    { id: '2', name: 'B', inStorePrice: 2000, options: [] }
  ];
  const r = recomputeOrderPricingFromMenu({
    clientItems: [
      { id: '1', quantity: 1 },
      { id: '2', quantity: 1 }
    ],
    menu,
    restLat: 10,
    restLon: 105,
    pinLat: pin.lat,
    pinLon: pin.lon,
    cfg
  });
  // B app = 2600+8600 = 11200; round100(11200*0.15)=1700 → floor 2000
  assert.strictEqual(r.discountValue, 2000);
});

console.log('\nAll pricingEngine tests passed.');
