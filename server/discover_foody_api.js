/**
 * Discover Foody.vn's internal API endpoints by capturing network requests.
 * Uses Puppeteer to load the page, scroll, and capture XHR/fetch requests.
 */
const puppeteer = require('puppeteer-core');

const CHROME_PATH = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

async function discoverApi() {
  console.log('[Discover] 🔍 Launching Puppeteer to capture Foody.vn API endpoints...\n');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });

  const page = await browser.newPage();
  
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');

  // Capture all XHR/Fetch requests
  const apiCalls = [];
  
  page.on('request', req => {
    const url = req.url();
    const method = req.method();
    if (req.resourceType() === 'xhr' || req.resourceType() === 'fetch') {
      const postData = req.postData();
      apiCalls.push({ url, method, postData, headers: req.headers() });
      console.log(`[XHR] ${method} ${url}`);
      if (postData) {
        console.log(`  POST data: ${postData.substring(0, 500)}`);
      }
    }
  });

  page.on('response', async res => {
    const url = res.url();
    if ((url.includes('__get') || url.includes('GetSearchResult') || url.includes('Directory') || url.includes('api') || url.includes('restaurant')) 
        && res.status() === 200) {
      try {
        const contentType = res.headers()['content-type'] || '';
        if (contentType.includes('json')) {
          const json = await res.json();
          const preview = JSON.stringify(json).substring(0, 500);
          console.log(`\n[RESPONSE] ${url}`);
          console.log(`  Status: ${res.status()}`);
          console.log(`  Preview: ${preview}`);
          if (json.searchItems || json.Items) {
            console.log(`  ⭐ FOUND SEARCH RESULTS! Items count: ${(json.searchItems || json.Items)?.length}`);
          }
          if (json.TotalResult || json.Total) {
            console.log(`  ⭐ Total results reported: ${json.TotalResult || json.Total}`);
          }
        }
      } catch (e) {}
    }
  });

  // Navigate to the Foody.vn Can Tho page
  console.log('\n[Discover] Navigating to https://www.foody.vn/can-tho/dia-diem ...\n');
  await page.goto('https://www.foody.vn/can-tho/dia-diem', { waitUntil: 'networkidle2', timeout: 30000 });
  
  await new Promise(r => setTimeout(r, 2000));

  // Try scrolling to trigger more loads
  console.log('\n[Discover] Scrolling to trigger lazy loading...\n');
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, 1000));
    await new Promise(r => setTimeout(r, 1500));
  }

  // Also try clicking "Load More" button if present
  try {
    const loadMore = await page.$('.load-more-btn, .btn-more, [class*="load-more"], [class*="show-more"]');
    if (loadMore) {
      console.log('[Discover] Found "Load More" button, clicking...');
      await loadMore.click();
      await new Promise(r => setTimeout(r, 3000));
    }
  } catch (e) {}

  // Try navigating to page 2 to see pagination API
  console.log('\n[Discover] Navigating to page 2...\n');
  await page.goto('https://www.foody.vn/can-tho/dia-diem?page=2', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  // Try the food delivery specific page  
  console.log('\n[Discover] Trying ShopeeFood delivery page...\n');
  await page.goto('https://www.foody.vn/can-tho/food/delivery', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  // Scroll on delivery page
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 1000));
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log('\n\n[Discover] ══════════════════════════════════════════');
  console.log('[Discover] 📋 SUMMARY: Captured', apiCalls.length, 'API calls');
  console.log('[Discover] ══════════════════════════════════════════\n');
  
  // Print unique API endpoints
  const uniqueUrls = [...new Set(apiCalls.map(c => {
    try { return new URL(c.url).pathname; } catch(e) { return c.url; }
  }))];
  console.log('Unique API paths:');
  uniqueUrls.forEach(u => console.log('  ', u));

  // Print full details of the most promising calls
  const promising = apiCalls.filter(c => 
    c.url.includes('Directory') || c.url.includes('Search') || 
    c.url.includes('restaurant') || c.url.includes('store') ||
    c.url.includes('delivery') || c.url.includes('__get')
  );
  
  if (promising.length > 0) {
    console.log('\n\n[Discover] ⭐ PROMISING API CALLS:');
    promising.forEach((c, i) => {
      console.log(`\n--- Call #${i + 1} ---`);
      console.log(`URL: ${c.url}`);
      console.log(`Method: ${c.method}`);
      if (c.postData) console.log(`POST: ${c.postData}`);
      console.log(`Headers (cookies): ${(c.headers.cookie || '').substring(0, 200)}`);
    });
  }

  await browser.close();
  console.log('\n[Discover] Done.');
}

discoverApi().catch(err => {
  console.error('[Discover] Error:', err.message);
  process.exit(1);
});
