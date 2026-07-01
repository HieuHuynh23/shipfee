/**
 * Verification script: Test restaurant count, menu diversity, and search speed
 */

const BASE = 'http://localhost:3001';

async function test() {
  console.log('\n═══════════════════════════════════════════════');
  console.log('  VERIFICATION: Restaurants, Menus & Search');
  console.log('═══════════════════════════════════════════════\n');

  let pass = 0, fail = 0;
  function check(name, condition, detail) {
    if (condition) { console.log(`  ✅ PASS: ${name}${detail ? ' — ' + detail : ''}`); pass++; }
    else { console.log(`  ❌ FAIL: ${name}${detail ? ' — ' + detail : ''}`); fail++; }
  }

  // 1. Total restaurant count (API filters by distance, so also check status)
  console.log('── Phần 1: Kiểm tra số lượng quán ──');
  const listRes = await fetch(`${BASE}/api/restaurants`);
  const listData = await listRes.json();
  const statusRes = await fetch(`${BASE}/api/status`);
  const statusData = await statusRes.json();
  const cacheCount = statusData.cache?.restaurants || statusData.restaurants || listData.total;
  check('API returns data', listData.total > 0, `${listData.total} quán (filtered by distance)`);
  check('Source is cached', listData.source.includes('cached') || listData.source === 'local', `Source: ${listData.source}`);
  
  // 2. Check menu diversity
  console.log('\n── Phần 2: Kiểm tra menu đa dạng ──');
  const sampleIds = listData.data.slice(0, 5).map(r => r.id);
  
  for (const id of sampleIds) {
    const detailRes = await fetch(`${BASE}/api/restaurants/${id}`);
    const detailJson = await detailRes.json();
    const detail = detailJson.data || detailJson;
    const menu = detail.menu || [];
    const name = detail.name || id;
    check(`Menu "${name.substring(0, 30)}"`, menu.length >= 3, `${menu.length} items`);
    
    // Check price markup
    if (menu.length > 0) {
      const item = menu[0];
      const expectedApp = Math.round(item.inStorePrice * 1.28 / 100) * 100;
      const priceDiff = Math.abs(item.appPrice - expectedApp);
      check(`  Markup 28% correct`, priceDiff <= 200, `inStore: ${item.inStorePrice}, app: ${item.appPrice}, expected: ${expectedApp}`);
    }
  }
  
  // 3. Search speed benchmark
  console.log('\n── Phần 3: Benchmark tốc độ tìm kiếm ──');
  const searchQueries = ['cà phê', 'bún bò', 'trà sữa', 'pizza', 'lẩu', 'cơm tấm', 'gà nướng', 'hải sản'];
  const times = [];
  
  for (const q of searchQueries) {
    const start = performance.now();
    const res = await fetch(`${BASE}/api/restaurants?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    const elapsed = performance.now() - start;
    times.push(elapsed);
    check(`Search "${q}"`, elapsed < 500, `${data.total} results in ${elapsed.toFixed(0)}ms`);
  }
  
  const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
  const maxTime = Math.max(...times);
  console.log(`\n  📊 Average search time: ${avgTime.toFixed(0)}ms`);
  console.log(`  📊 Max search time: ${maxTime.toFixed(0)}ms`);
  check('Avg search < 200ms', avgTime < 200, `${avgTime.toFixed(0)}ms`);
  
  // 4. Detail lookup speed
  console.log('\n── Phần 4: Benchmark chi tiết quán ──');
  const detailTimes = [];
  for (const id of sampleIds) {
    const start = performance.now();
    await fetch(`${BASE}/api/restaurants/${id}`);
    const elapsed = performance.now() - start;
    detailTimes.push(elapsed);
  }
  const avgDetail = detailTimes.reduce((a, b) => a + b, 0) / detailTimes.length;
  check('Avg detail lookup < 100ms', avgDetail < 100, `${avgDetail.toFixed(0)}ms`);

  // Summary
  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`  KẾT QUẢ: ${pass} PASS / ${fail} FAIL`);
  console.log(`═══════════════════════════════════════════════\n`);
  
  process.exit(fail > 0 ? 1 : 0);
}

test().catch(err => { console.error('Error:', err.message); process.exit(1); });
