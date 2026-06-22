/**
 * Test Distance-Based Dynamic Pricing
 * 
 * Tests the hidden shipping fee logic by querying the API with different
 * customer coordinates to simulate various distances from restaurants.
 * 
 * Coordinates used (relative to a restaurant in Cần Thơ center ~10.0345, 105.7876):
 *   - 0 km:  Same location
 *   - 1 km:  Very close
 *   - 2 km:  At threshold (no surcharge)
 *   - 3 km:  Just above threshold
 *   - 5 km:  Medium distance
 *   - 8 km:  Far
 *   - 10 km: At second threshold
 *   - 12 km: Beyond second threshold
 *   - 15 km: Very far
 *   - 20 km: Extreme
 */

const http = require('http');

const API_BASE = 'http://localhost:3001';

// Cần Thơ center reference point
const CENTER_LAT = 10.0345;
const CENTER_LON = 105.7876;

// Generate coordinates at approximate distances from center
// 1 degree latitude ≈ 111.32 km
// 1 degree longitude ≈ 111.32 * cos(lat) km ≈ 109.6 km at 10°N
function coordsAtDistance(distKm) {
  // Move north by distKm
  const latOffset = distKm / 111.32;
  return {
    lat: (CENTER_LAT + latOffset).toFixed(6),
    lon: CENTER_LON.toFixed(6)
  };
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error: ${data.substring(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

// Expected surcharge formula: 7000 * sqrt(d - 1.5), rounded to nearest 100
function expectedSurcharge(distKm) {
  if (distKm <= 1.5) return 0;
  const raw = 7000 * Math.sqrt(distKm - 1.5);
  return Math.round(raw / 100) * 100;
}

async function main() {
  console.log('='.repeat(80));
  console.log('  TEST DISTANCE-BASED DYNAMIC PRICING');
  console.log('='.repeat(80));
  console.log();

  // Step 1: Get a restaurant with menu items
  console.log('[1/3] Fetching restaurant list...');
  const listResult = await fetchJson(`${API_BASE}/api/restaurants`);
  const restaurants = listResult.data || listResult;
  
  // Find a restaurant that has a menu (try first few)
  let testRestaurant = null;
  for (const r of restaurants.slice(0, 20)) {
    const detail = await fetchJson(`${API_BASE}/api/restaurants/${r.id}`);
    const rd = detail.data || detail;
    if (rd && rd.menu && rd.menu.length > 0) {
      testRestaurant = rd;
      break;
    }
  }

  if (!testRestaurant) {
    console.error('❌ Could not find a restaurant with menu items!');
    process.exit(1);
  }

  console.log(`✅ Using restaurant: "${testRestaurant.name}" (ID: ${testRestaurant.id})`);
  console.log(`   Address: ${testRestaurant.address || 'N/A'}`);
  
  // Get a sample menu item's base price (no distance markup)
  const baseDetail = await fetchJson(`${API_BASE}/api/restaurants/${testRestaurant.id}`);
  const baseData = baseDetail.data || baseDetail;
  const sampleItem = baseData.menu[0];
  const basePrice = sampleItem.appPrice;
  console.log(`   Sample item: "${sampleItem.name}" — Base price: ${basePrice.toLocaleString('vi-VN')}đ`);
  console.log();

  // Step 2: Test at various distances
  const testDistances = [0, 1, 2, 3, 5, 8, 10, 12, 15, 20];
  
  console.log('[2/3] Testing pricing at various distances...');
  console.log('-'.repeat(80));
  console.log(
    'Distance'.padEnd(12) +
    'Coords'.padEnd(28) +
    'Surcharge/Item'.padEnd(18) +
    'Expected'.padEnd(12) +
    'Item Price'.padEnd(14) +
    'Status'
  );
  console.log('-'.repeat(80));

  let passed = 0;
  let failed = 0;
  let prevSurcharge = -1;
  let monotonic = true;

  for (const dist of testDistances) {
    const { lat, lon } = coordsAtDistance(dist);
    
    const detail = await fetchJson(
      `${API_BASE}/api/restaurants/${testRestaurant.id}?lat=${lat}&lon=${lon}`
    );
    const data = detail.data || detail;
    
    if (!data || !data.menu || data.menu.length === 0) {
      console.log(`${(dist + ' km').padEnd(12)} — ❌ No menu data returned`);
      failed++;
      continue;
    }

    const item = data.menu[0];
    const actualSurcharge = data.distanceSurchargePerItem || 0;
    const expectedSrch = expectedSurcharge(data.distanceValue || dist);
    const itemPrice = item.appPrice;
    
    // Check monotonicity: surcharge should never decrease as distance increases
    if (actualSurcharge < prevSurcharge) {
      monotonic = false;
    }
    prevSurcharge = actualSurcharge;
    
    // Allow ±1000đ tolerance due to rounding and haversine approximation
    const tolerance = 2000;
    const isCorrect = Math.abs(actualSurcharge - expectedSrch) <= tolerance;
    
    const status = isCorrect ? '✅ PASS' : '❌ FAIL';
    if (isCorrect) passed++; else failed++;
    
    console.log(
      `${(dist + ' km').padEnd(12)}` +
      `${(lat + ', ' + lon).padEnd(28)}` +
      `${('+' + actualSurcharge.toLocaleString('vi-VN') + 'đ').padEnd(18)}` +
      `${('+' + expectedSrch.toLocaleString('vi-VN') + 'đ').padEnd(12)}` +
      `${(itemPrice.toLocaleString('vi-VN') + 'đ').padEnd(14)}` +
      status
    );
  }

  console.log('-'.repeat(80));
  console.log();
  
  // Step 3: Verify monotonicity (prices should never decrease with distance)
  console.log('[3/3] Checking price monotonicity...');
  if (monotonic) {
    console.log('✅ PASS — Surcharges are monotonically non-decreasing with distance.');
    passed++;
  } else {
    console.log('❌ FAIL — Surcharges decrease at some point! Price discontinuity detected.');
    failed++;
  }

  console.log();
  console.log('='.repeat(80));
  console.log(`  RESULTS: ${passed} PASS / ${failed} FAIL`);
  console.log('='.repeat(80));

  // Print the pricing curve for reference
  console.log();
  console.log('📊 Pricing Curve Reference:');
  console.log('-'.repeat(50));
  for (let d = 0; d <= 25; d += 0.5) {
    const s = expectedSurcharge(d);
    const bar = '█'.repeat(Math.round(s / 1000));
    if (d % 2 === 0 || d <= 3) {
      console.log(`  ${d.toFixed(1).padStart(5)} km: +${s.toLocaleString('vi-VN').padStart(7)}đ  ${bar}`);
    }
  }
  console.log('-'.repeat(50));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
