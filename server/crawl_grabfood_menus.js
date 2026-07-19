#!/usr/bin/env node
/**
 * Cào menu GrabFood cho quán source=grabfood chưa có hasRealMenu.
 * Mỗi worker = 1 browser riêng (an toàn khi concurrency cao).
 *
 *   node crawl_grabfood_menus.js
 *   node crawl_grabfood_menus.js --concurrency=4
 *   node crawl_grabfood_menus.js --limit=50
 *   node crawl_grabfood_menus.js --force
 */
'use strict';

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const dbHelper = require('./dbHelper');
const { analyzeMenuQuality, applyMenuFlags } = require('./menuQuality');
const {
  sleep,
  getBrowserPath,
  detailUrl,
  parseGrabMenuItems,
  enrichFromMerchantDetail,
  attachLatlngRewrite,
  CANTHO_GRID
} = require('./grabfoodHelpers');

const limitArg = process.argv.find(a => a.startsWith('--limit='));
const idArg = process.argv.find(a => a.startsWith('--id='));
const concArg = process.argv.find(a => a.startsWith('--concurrency='));
const LIMIT = limitArg ? Math.max(1, parseInt(limitArg.split('=')[1], 10) || 0) : 0;
const ONLY_ID = idArg ? idArg.split('=').slice(1).join('=') : '';
// Mặc định 4 luồng; trần 6 để tránh bị Grab chặn
const CONCURRENCY = Math.max(1, Math.min(6, parseInt(concArg ? concArg.split('=')[1] : '4', 10) || 4));
const FORCE = process.argv.includes('--force');
const RESTART_EVERY = 40;

const DEFAULT_LAT = CANTHO_GRID[0].lat;
const DEFAULT_LNG = CANTHO_GRID[0].lng;

function selectCandidates(all) {
  let list = all.filter(r => r && r.source === 'grabfood' && r.grabMerchantId);
  if (ONLY_ID) list = list.filter(r => String(r.id) === ONLY_ID);
  if (!FORCE) list = list.filter(r => !r.hasRealMenu);
  list.sort((a, b) => {
    const ae = a.lastCrawlError === 'grab_menu_miss' ? 1 : 0;
    const be = b.lastCrawlError === 'grab_menu_miss' ? 1 : 0;
    if (ae !== be) return ae - be;
    return String(b.grabDiscoveredAt || '').localeCompare(String(a.grabDiscoveredAt || ''));
  });
  if (LIMIT > 0) list = list.slice(0, LIMIT);
  return list;
}

async function launchBrowser() {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: getBrowserPath() || undefined,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--window-size=1280,900'
    ]
  });
  const context = browser.defaultBrowserContext();
  await context.overridePermissions('https://food.grab.com', ['geolocation']);
  return browser;
}

async function warmSession(browser) {
  const page = await browser.newPage();
  try {
    await page.setGeolocation({ latitude: DEFAULT_LAT, longitude: DEFAULT_LNG, accuracy: 30 });
    await attachLatlngRewrite(page, () => ({ lat: DEFAULT_LAT, lng: DEFAULT_LNG }));
    await page
      .goto(`https://food.grab.com/vn/vi/restaurants?latlng=${DEFAULT_LAT},${DEFAULT_LNG}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      })
      .catch(() => {});
    await sleep(1500);
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeOne(browser, restaurant, workerId) {
  const tag = `[W${workerId}]`;
  const mid = restaurant.grabMerchantId;
  const lat = Number(restaurant.latitude) || DEFAULT_LAT;
  const lng = Number(restaurant.longitude) || DEFAULT_LNG;
  const url = detailUrl(mid, restaurant.name, lat, lng);

  const page = await browser.newPage();
  let menuPayload = null;
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9' });
    await page.setGeolocation({ latitude: lat, longitude: lng, accuracy: 30 });
    await attachLatlngRewrite(page, () => ({ lat, lng }));

    const midRe = mid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    page.on('response', async res => {
      try {
        const u = res.url();
        if (res.status() !== 200) return;
        if (!new RegExp(`/merchants/${midRe}(\\?|$)`, 'i').test(u)) return;
        if (/recommended/i.test(u)) return;
        const body = await res.json().catch(() => null);
        if (body?.merchant) menuPayload = body;
      } catch (_) {}
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 75000 }).catch(() => {});
    await sleep(2000);
    for (let i = 0; i < 5 && !menuPayload; i++) {
      await page.evaluate(() => window.scrollBy(0, 900));
      await sleep(600);
    }

    if (!menuPayload) {
      await sleep(2500);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 75000 }).catch(() => {});
      await sleep(2200);
      for (let i = 0; i < 3 && !menuPayload; i++) {
        await page.evaluate(() => window.scrollBy(0, 900));
        await sleep(600);
      }
    }

    if (!menuPayload) {
      console.log(`${tag} ⚠️ miss: ${restaurant.name}`);
      dbHelper.updateRestaurant({
        ...restaurant,
        lastCrawlError: 'grab_menu_miss',
        crawlNextAttempt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString()
      });
      return { status: 'miss' };
    }

    const row = enrichFromMerchantDetail({ ...restaurant }, menuPayload);
    const menu = parseGrabMenuItems(menuPayload, row.id);
    const quality = analyzeMenuQuality(menu);
    if (!menu.length || !quality.isReal) {
      console.log(`${tag} 🚫 quality=${quality.reason}: ${restaurant.name}`);
      applyMenuFlags(row, menu);
      row.lastCrawlError = quality.reason || 'grab_menu_quality';
      dbHelper.updateRestaurant(row);
      return { status: 'rejected', reason: quality.reason };
    }

    applyMenuFlags(row, menu);
    row.menuUpdatedAt = new Date().toISOString();
    row.dishNames = menu.map(d => d.name).filter(Boolean);
    row.lastCrawlError = '';
    delete row.crawlNextAttempt;
    dbHelper.writeRestaurantMenu(row.id, menu);
    dbHelper.updateRestaurant(row);
    console.log(`${tag} ✅ ${menu.length} món ${row.name}`);
    return { status: 'success', dishCount: menu.length };
  } catch (err) {
    console.log(`${tag} ❌ ${restaurant.name}: ${err.message}`);
    return { status: 'error', error: err.message };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const all = dbHelper.read();
  const candidates = selectCandidates(all);
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  ShipFee — Crawl menu GrabFood (multi-browser)          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`candidates=${candidates.length} concurrency=${CONCURRENCY}`);

  if (!candidates.length) {
    console.log('Nothing to crawl.');
    return;
  }

  let ok = 0;
  let fail = 0;
  let i = 0;
  const statsLock = { n: 0 }; // processed counter

  async function worker(workerId) {
    let browser = await launchBrowser();
    await warmSession(browser);
    let localProcessed = 0;
    let missStreak = 0;

    try {
      while (true) {
        const idx = i++;
        if (idx >= candidates.length) break;
        const r = candidates[idx];

        if (localProcessed > 0 && localProcessed % RESTART_EVERY === 0) {
          console.log(`♻️  [W${workerId}] browser restart @local=${localProcessed}`);
          await browser.close().catch(() => {});
          await sleep(2000 + workerId * 300);
          browser = await launchBrowser();
          await warmSession(browser);
        }

        let res;
        try {
          res = await scrapeOne(browser, r, workerId);
        } catch (err) {
          console.log(`[W${workerId}] browser died (${err.message}) — relaunch`);
          await browser.close().catch(() => {});
          await sleep(2500);
          browser = await launchBrowser();
          await warmSession(browser);
          try {
            res = await scrapeOne(browser, r, workerId);
          } catch (err2) {
            res = { status: 'error', error: err2.message };
          }
        }

        localProcessed += 1;
        statsLock.n += 1;
        if (res.status === 'success') {
          ok += 1;
          missStreak = 0;
        } else {
          fail += 1;
          if (res.status === 'miss') missStreak += 1;
        }

        if (missStreak >= 6) {
          console.log(`⏳ [W${workerId}] miss streak — cooldown 30s`);
          await browser.close().catch(() => {});
          await sleep(30000);
          browser = await launchBrowser();
          await warmSession(browser);
          missStreak = 0;
        }

        // Delay ngắn hơn khi nhiều luồng (stagger theo worker)
        await sleep(900 + workerId * 200 + Math.floor(Math.random() * 800));
      }
    } finally {
      await browser.close().catch(() => {});
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, w) => worker(w + 1)));
  console.log(`\nDONE ok=${ok} fail/miss=${fail} processed=${statsLock.n}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
