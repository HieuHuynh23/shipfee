const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');

function getBrowserPath() {
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getHighQualityImg(photos) {
  if (!photos || photos.length === 0) return '';
  const match = photos.find(p => p.width >= 350 && p.width <= 600);
  if (match) return match.value;
  return photos[photos.length - 1]?.value || photos[0]?.value || '';
}

function extractMenuFromApiData(apiData, slug) {
  const reply = apiData.reply || {};
  const menu_infos = reply.menu_infos || [];
  console.log(`[menuScraper] [API] Bắt đầu phân tích thực đơn ShopeeFood (${menu_infos.length} danh mục)...`);

  const cleanDishes = [];
  let itemIndex = 0;

  menu_infos.forEach(cat => {
    const categoryName = cat.dish_type_name || 'Món ăn';
    (cat.dishes || []).forEach(dish => {
      if (dish.is_deleted) return;
      const inStorePrice =
        dish.discount_price && dish.discount_price.value > 0
          ? dish.discount_price.value
          : dish.price?.value || 35000;
      if (inStorePrice <= 100) return;
      const appPrice = Math.round((inStorePrice * 1.28) / 100) * 100;
      let img = getHighQualityImg(dish.photos);
      if (!img || img.includes('placeholder') || img.startsWith('data:')) img = '';
      const options = (dish.options || []).map(opt => ({
        name: opt.name,
        mandatory: opt.mandatory === true || opt.mandatory === 1,
        min_select: opt.option_items?.min_select || 0,
        max_select: opt.option_items?.max_select || 1,
        items: (opt.option_items?.items || []).map(item => ({
          name: item.name,
          price: item.price?.value || 0
        }))
      }));
      cleanDishes.push({
        id: `${slug}-item-${itemIndex++}`,
        name: dish.name,
        desc: dish.description || 'Món ăn đặc trưng được chuẩn bị nóng hổi tại cửa hàng.',
        inStorePrice,
        appPrice,
        img,
        category: categoryName,
        isAvailable: dish.is_available !== false && dish.is_active !== false,
        options
      });
    });
  });

  console.log(`[menuScraper] [API] ✅ Trích xuất thành công ${cleanDishes.length} món ăn từ API!`);
  return cleanDishes;
}

function wrapResult(dishes, { closed = false, closedReason = '', slug, altSlugs = [] } = {}) {
  if (!dishes || dishes.length === 0) return null;
  if (closed) {
    return { closed: true, reason: closedReason, menu: dishes, usedSlug: slug, altSlugs };
  }
  return dishes;
}

async function apiGetJson(page, apiPath) {
  return page.evaluate(async path => {
    try {
      const resp = await fetch('https://gappapi.deliverynow.vn/api/' + path, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'x-foody-client-language': 'vi',
          'x-foody-client-type': '1',
          'x-foody-client-version': '3.0.0',
          'x-foody-api-version': '1',
          'x-foody-app-type': '1004',
          Accept: 'application/json'
        }
      });
      const data = await resp.json();
      return { status: resp.status, data };
    } catch (e) {
      return { error: e.message };
    }
  }, apiPath);
}

async function dismissModals(page) {
  return page.evaluate(() => {
    const closedKeywords = [
      'đóng cửa',
      'dong cua',
      'closed',
      'không phục vụ',
      'ngoài giờ',
      'nghỉ',
      'tạm ngưng',
      'outside working hours',
      'not available'
    ];
    let foundClosedModal = false;
    let closedText = '';
    let foundAndClicked = false;

    document
      .querySelectorAll('[class*="modal"], [class*="popup"], [class*="dialog"], [role="dialog"], .ReactModal__Overlay')
      .forEach(modal => {
        const text = modal.innerText?.toLowerCase() || '';
        if (closedKeywords.some(kw => text.includes(kw))) {
          foundClosedModal = true;
          closedText = modal.innerText?.trim() || '';
        }
      });

    const btns = document.querySelectorAll(
      '[class*="modal"] button, [class*="popup"] button, [class*="dialog"] button, [role="dialog"] button'
    );
    for (const btn of btns) {
      const text = (btn.innerText || '').toLowerCase().trim();
      // Không click nút rỗng / "x" đơn lẻ dễ miss-click
      if (
        text === 'ok' ||
        text.includes('đóng') ||
        text.includes('dong') ||
        text.includes('đồng ý') ||
        text.includes('tiếp tục')
      ) {
        btn.click();
        foundAndClicked = true;
        break;
      }
    }
    return { foundClosedModal, closedText, foundAndClicked };
  });
}

async function scrollToLoad(page) {
  await page.evaluate(async () => {
    for (let i = 0; i < 12; i++) {
      window.scrollBy(0, 450);
      await new Promise(r => setTimeout(r, 180));
    }
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 250));
    for (let i = 0; i < 16; i++) {
      window.scrollBy(0, 500);
      await new Promise(r => setTimeout(r, 140));
    }
  });
}

/** Kích hoạt UI để SPA tự gọi API đã ký (không dùng fetch giả → 403). */
async function activateMenuUi(page) {
  await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('a, button, [role="tab"], [role="button"], div, span')];
    for (const el of nodes) {
      const t = (el.innerText || el.getAttribute('aria-label') || '').trim().toLowerCase();
      if (!t || t.length > 40) continue;
      if (
        t === 'thực đơn' ||
        t === 'menu' ||
        t.includes('xem thực đơn') ||
        t.includes('xem menu') ||
        t === 'món ăn'
      ) {
        try {
          el.click();
        } catch (_) {}
        return;
      }
    }
  });
  await new Promise(r => setTimeout(r, 800));
}

async function waitForMenuCapture(getCount, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (getCount() > 0) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return getCount() > 0;
}

async function extractDomDishes(page) {
  return page.evaluate(() => {
    const list = [];
    const rows = document.querySelectorAll(
      '.item-restaurant-row, [class*="dish-item"], [class*="food-item"], ' +
        '[class*="menu-item"]:not([class*="menu-item-link"]), [class*="product-item"], [class*="item-card"]'
    );

    const pushFromRow = row => {
      const nameEl = row.querySelector(
        '.item-restaurant-name, h2, h3, h4, [class*="name"], [class*="title"], [class*="dish-name"], [class*="food-name"]'
      );
      const priceEl = row.querySelector('.current-price, [class*="price"], [class*="cost"], [class*="amount"]');
      const imgEl = row.querySelector('img[src]:not([src*="icon"]):not([src*="logo"])');
      const descEl = row.querySelector('.item-restaurant-desc, [class*="desc"], [class*="description"]');
      let category = 'Món ăn';
      const menuGroup = row.closest('.menu-group, [class*="group"], [class*="section"], [class*="category"]');
      if (menuGroup) {
        const catTitleEl = menuGroup.querySelector('.menu-group-title, [class*="title"], [class*="header"], h2, h3');
        if (catTitleEl && catTitleEl !== nameEl) category = catTitleEl.innerText.trim().split('\n')[0];
      }
      const name = nameEl?.innerText?.trim();
      let priceText = priceEl?.innerText?.trim() || '';
      if (!priceText) {
        const m = (row.innerText || '').match(/(\d{1,3}(?:[.,]\d{3})+)\s*đ?/i);
        if (m) priceText = m[1];
      }
      const rowText = row.innerText.toLowerCase();
      const isOutOfStock =
        rowText.includes('hết') || rowText.includes('sold out') || rowText.includes('ngưng bán');
      if (name && name.length > 1 && priceText) {
        list.push({
          name,
          priceText,
          img: imgEl?.src || '',
          category,
          desc: descEl?.innerText?.trim() || '',
          isAvailable: !isOutOfStock
        });
      }
    };

    rows.forEach(pushFromRow);

    // Fallback: quét cặp tên + giá trong text block
    if (list.length === 0) {
      const blocks = document.querySelectorAll('li, article, section, div');
      blocks.forEach(el => {
        if (el.children.length > 8) return;
        const t = (el.innerText || '').trim();
        if (!t || t.length > 180 || t.length < 6) return;
        const m = t.match(/^(.{2,80}?)\n+(\d{1,3}(?:[.,]\d{3})+)\s*đ?/m);
        if (m) {
          list.push({
            name: m[1].replace(/\s+/g, ' ').trim(),
            priceText: m[2],
            img: '',
            category: 'Món ăn',
            desc: '',
            isAvailable: true
          });
        }
      });
    }
    return list;
  });
}

function normalizeDomDishes(rawDishes, slug) {
  return rawDishes.map((dish, i) => {
    const inStorePrice = parseInt(String(dish.priceText).replace(/[^\d]/g, ''), 10) || 35000;
    const appPrice = Math.round((inStorePrice * 1.28) / 100) * 100;
    let img = dish.img;
    if (!img || img.includes('placeholder') || img.startsWith('data:')) img = '';
    return {
      id: `${slug}-item-${i}`,
      name: dish.name,
      desc: dish.desc || 'Món ăn đặc trưng được chuẩn bị nóng hổi tại cửa hàng.',
      inStorePrice,
      appPrice,
      img,
      category: dish.category || 'Món chính',
      isAvailable: dish.isAvailable !== false
    };
  });
}

async function pageNotFound(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    return (
      text.includes('bài viết không tồn tại') ||
      text.includes('địa điểm này chưa có dịch vụ đặt món') ||
      text.includes('địa điểm này chưa có dịch vụ')
    );
  });
}

/**
 * Tìm slug thay thế qua ô tìm kiếm web ShopeeFood (khi URL cũ chết).
 */
async function searchAltSlugs(page, query, addressHint = '') {
  if (!query || query.length < 2) return [];
  const found = new Map();

  const onResp = async response => {
    const u = response.url();
    if (!u.includes('deliverynow.vn/api/')) return;
    if (!/search|browsing_infos|get_infos/i.test(u)) return;
    try {
      const data = JSON.parse(await response.text());
      const walk = obj => {
        if (!obj) return;
        if (Array.isArray(obj)) return obj.forEach(walk);
        if (typeof obj !== 'object') return;
        const slug = obj.url_rewrite_name || obj.url_routing || '';
        const name = obj.name || obj.restaurant_name || '';
        if (slug && name && /can-tho|/.test(String(slug))) {
          found.set(String(slug).split('?')[0], {
            slug: String(slug).split('?')[0],
            name,
            address: obj.address || ''
          });
        }
        Object.values(obj).forEach(v => {
          if (v && typeof v === 'object') walk(v);
        });
      };
      walk(data);
    } catch (_) {}
  };
  page.on('response', onResp);

  try {
    await page.goto('https://shopeefood.vn/can-tho/food', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));

    // Gõ vào ô search nếu có
    const typed = await page.evaluate(q => {
      const input =
        document.querySelector('input[type="search"]') ||
        document.querySelector('input[placeholder*="Tìm"]') ||
        document.querySelector('input[placeholder*="tìm"]') ||
        document.querySelector('input[class*="search"]');
      if (!input) return false;
      input.focus();
      input.value = '';
      const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      native.set.call(input, q);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, query);

    if (typed) {
      await page.keyboard.press('Enter').catch(() => {});
      await new Promise(r => setTimeout(r, 3500));
    }

    // Thử GET search_global kiểu query string (một số client dùng GET)
    const qEnc = encodeURIComponent(query);
    for (const cityId of [221, 59]) {
      const r = await apiGetJson(
        page,
        `delivery/search_global?city_id=${cityId}&keyword=${qEnc}&foody_services=1&count=30`
      );
      if (r.data) {
        const walk = obj => {
          if (!obj) return;
          if (Array.isArray(obj)) return obj.forEach(walk);
          if (typeof obj !== 'object') return;
          const slug = obj.url_rewrite_name || obj.url_routing;
          const name = obj.name || obj.restaurant_name;
          if (slug && name) {
            found.set(String(slug).split('?')[0], {
              slug: String(slug).split('?')[0],
              name,
              address: obj.address || ''
            });
          }
          Object.values(obj).forEach(v => {
            if (v && typeof v === 'object') walk(v);
          });
        };
        walk(r.data);
      }
    }
  } finally {
    page.off('response', onResp);
  }

  let list = [...found.values()];

  // Loại collection/deal giả (không phải quán thật)
  const junk = /(giam-\d|deal-|sieu-deal|collection|promo|voucher|freeship|nang-nong|mua-he)/i;
  const qTokens = String(query || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 2);

  list = list.filter(a => {
    if (junk.test(a.slug) || junk.test(a.name)) return false;
    const hay = `${a.slug} ${a.name}`.toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd');
    // Ít nhất 1 token tên quán khớp
    const hits = qTokens.filter(t => hay.includes(t)).length;
    return hits >= Math.min(2, qTokens.length);
  });

  const addr = String(addressHint || '').toLowerCase();
  if (addr) {
    const token = addr.split(/[,\s]+/).find(t => t.length > 3) || '';
    list.sort((a, b) => {
      const as = token && (a.address || '').toLowerCase().includes(token) ? 1 : 0;
      const bs = token && (b.address || '').toLowerCase().includes(token) ? 1 : 0;
      return bs - as;
    });
  }
  return list.slice(0, 5);
}

/**
 * @param {string} slug
 * @param {{ name?: string, address?: string, altSlugs?: string[] }} [options]
 */
async function scrapeMenu(slug, options = {}) {
  const executablePath = getBrowserPath();
  if (!executablePath) {
    console.log('[menuScraper] ℹ️ Không phát hiện Chrome/Edge. Dùng Chromium tích hợp.');
  }

  const fast = options.fast === true;
  const defaultWatchdog = parseInt(process.env.CRAWL_TIMEOUT_MS || '90000', 10) || 90000;
  const bulkWatchdog = parseInt(process.env.BULK_SYNC_TIMEOUT_MS || '45000', 10) || 45000;
  const WATCHDOG_MS = fast
    ? Math.max(25000, bulkWatchdog)
    : Math.max(45000, defaultWatchdog);
  const API_WAIT_MS = fast
    ? Math.min(12000, parseInt(process.env.BULK_SYNC_API_WAIT_MS || '10000', 10) || 10000)
    : Math.min(WATCHDOG_MS - 15000, Math.max(12000, parseInt(process.env.CRAWL_API_WAIT_MS || '20000', 10) || 20000));

  const trySlugs = [
    slug,
    ...(options.altSlugs || [])
  ]
    .map(s => String(s || '').split('?')[0].trim())
    .filter(Boolean);
  const seenSlug = new Set();
  const uniqueSlugs = trySlugs.filter(s => (seenSlug.has(s) ? false : (seenSlug.add(s), true)));

  console.log(
    `[menuScraper] 🚀 Cào menu: ${uniqueSlugs[0]} (candidates=${uniqueSlugs.length}, timeout=${WATCHDOG_MS}ms${fast ? ', fast' : ''})`
  );

  const launchOptions = buildLaunchOptions(executablePath);
  const ownsBrowser = !options.browser;
  const browser = options.browser || await puppeteer.launch(launchOptions);
  let watchdog = null;
  if (ownsBrowser) {
    watchdog = setTimeout(async () => {
      console.warn(`[menuScraper] 🕒 Watchdog ${Math.round(WATCHDOG_MS / 1000)}s — đóng browser.`);
      try {
        const proc = browser.process();
        if (proc) proc.kill('SIGKILL');
        else await browser.close();
      } catch (_) {}
    }, WATCHDOG_MS);
  }

  const discoveredAlts = [];
  let page = null;

  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7' });

    // Warm cookies
    await page.goto('https://shopeefood.vn/can-tho', { waitUntil: 'domcontentloaded', timeout: fast ? 12000 : 20000 }).catch(() => {});
    await new Promise(r => setTimeout(r, fast ? 350 : 800));

    const scrapeOneSlug = async (currentSlug, { blockMedia = true } = {}) => {
      let apiData = null;
      let apiCapturedCount = 0;
      let apiOkEmpty = false; // HTTP 200 nhưng 0 món
      let apiBlocked = false; // 403/429/503 — quán vẫn có thể tồn tại
      let requestId = null;
      let detailOk = false;
      let closedDetected = false;
      let closedReason = '';

      const onResponse = async response => {
        const respUrl = response.url();
        try {
          const idMatch = respUrl.match(/[?&]request_id=(\d+)/);
          if (idMatch) requestId = idMatch[1];

          if (respUrl.includes('get_delivery_dishes')) {
            const status = response.status();
            if ([403, 429, 503].includes(status)) {
              apiBlocked = true;
              console.log(`[menuScraper] [API] get_delivery_dishes status=${status} (blocked — sẽ retry)`);
              return;
            }
            if (status !== 200) {
              console.log(`[menuScraper] [API] get_delivery_dishes status=${status} items=?`);
              return;
            }
            const text = await response.text();
            const parsed = JSON.parse(text);
            const items = (parsed?.reply?.menu_infos || []).reduce((acc, c) => acc + (c.dishes || []).length, 0);
            if (items > apiCapturedCount) {
              apiData = parsed;
              apiCapturedCount = items;
              apiBlocked = false;
            } else if (items === 0) {
              apiOkEmpty = true;
              if (!apiData) apiData = parsed;
            }
            console.log(`[menuScraper] [API] get_delivery_dishes status=200 items=${items}`);
          }

          if (respUrl.includes('get_detail') && respUrl.includes('deliverynow')) {
            const status = response.status();
            if (status === 200) {
              detailOk = true;
              const text = await response.text();
              const parsed = JSON.parse(text);
              if (parsed?.reply?.menu_infos?.length && apiCapturedCount === 0) {
                apiData = parsed;
                apiCapturedCount = parsed.reply.menu_infos.reduce((a, c) => a + (c.dishes || []).length, 0);
              }
            } else if ([403, 429, 503].includes(status)) {
              apiBlocked = true;
            }
          }
        } catch (_) {}
      };

      page.on('response', onResponse);

      const harvestPass = async label => {
        const modalInfo = await dismissModals(page);
        if (modalInfo.foundClosedModal) {
          closedDetected = true;
          closedReason = modalInfo.closedText;
          console.log('[menuScraper] 🔴 Modal đóng cửa:', closedReason.slice(0, 80));
        }
        if (modalInfo.foundAndClicked) await new Promise(r => setTimeout(r, 400));

        if (apiCapturedCount > 0) return;

        console.log(`[menuScraper] ${label}`);
        await activateMenuUi(page);
        await Promise.race([scrollToLoad(page), new Promise(r => setTimeout(r, 8000))]);
        await waitForMenuCapture(() => apiCapturedCount, Math.min(API_WAIT_MS, 15000));
      };

      try {
        if (blockMedia) {
          await page.setRequestInterception(true);
          page.removeAllListeners('request');
          page.on('request', req => {
            try {
              const t = req.resourceType();
              if (['image', 'font', 'media'].includes(t)) req.abort().catch(() => {});
              else req.continue().catch(() => {});
            } catch (_) {}
          });
        } else {
          try {
            await page.setRequestInterception(false);
          } catch (_) {}
        }

        const url = `https://shopeefood.vn/can-tho/${currentSlug}`;
        console.log(`[menuScraper] 📄 ${url}`);
        if (fast) {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        } else {
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 }).catch(async () => {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          });
        }

        // Cho response handler async kịp gán apiCapturedCount
        await new Promise(r => setTimeout(r, fast ? 900 : 1500));
        for (let i = 0; i < 10 && apiCapturedCount === 0; i++) {
          await new Promise(r => setTimeout(r, 200));
        }

        if (apiCapturedCount > 0) {
          console.log(`[menuScraper] ✅ API đã có ${apiCapturedCount} món ngay khi load trang`);
        } else {
          await harvestPass('Scroll + UI kích hoạt menu (request đã ký)...');
        }

        // Retry reload tự nhiên khi bị chặn / chưa bắt được dishes (KHÔNG fetch giả → 403)
        if (!fast && apiCapturedCount === 0 && (apiBlocked || requestId || detailOk)) {
          const retries = apiBlocked ? 2 : 1;
          for (let r = 0; r < retries && apiCapturedCount === 0; r++) {
            const waitMs = 1500 + r * 1500 + Math.floor(Math.random() * 800);
            console.log(
              `[menuScraper] 🔁 Reload tự nhiên #${r + 1} (blocked=${apiBlocked}, requestId=${requestId || '-'}) chờ ${waitMs}ms...`
            );
            await new Promise(res => setTimeout(res, waitMs));
            apiBlocked = false;
            await page.reload({ waitUntil: 'networkidle2', timeout: 45000 }).catch(async () => {
              await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            });
            await new Promise(res => setTimeout(res, 1200));
            await harvestPass(`Sau reload #${r + 1}: scroll + UI...`);
          }
        }

        if (apiCapturedCount > 0 && apiData) {
          const dishes = extractMenuFromApiData(apiData, currentSlug);
          const wrapped = wrapResult(dishes, { closed: closedDetected, closedReason, slug: currentSlug });
          if (wrapped) return { ok: true, result: wrapped, slug: currentSlug };
        }

        // DOM fallback
        console.log('[menuScraper] 🔄 DOM fallback...');
        const raw = await extractDomDishes(page);
        console.log(`[menuScraper] [DOM] ${raw.length} món thô`);
        if (raw.length > 0) {
          const dishes = normalizeDomDishes(raw, currentSlug);
          const wrapped = wrapResult(dishes, { closed: closedDetected, closedReason, slug: currentSlug });
          if (wrapped) return { ok: true, result: wrapped, slug: currentSlug };
        }

        const nf = await pageNotFound(page);
        if (nf) {
          console.log('[menuScraper] 🚫 Trang báo không tồn tại / chưa có dịch vụ');
          return { ok: false, notFound: true, slug: currentSlug };
        }

        // 403/429: quán vẫn tồn tại — không đánh closed / empty vĩnh viễn
        if (apiBlocked) {
          console.log('[menuScraper] ⏳ API bị chặn nhưng trang quán còn — trả blocked để thử lại sau');
          return {
            ok: true,
            result: {
              blocked: true,
              reason: 'ShopeeFood tạm chặn API menu (403/429). Quán vẫn tồn tại — sẽ cào lại.',
              usedSlug: currentSlug,
              detailOk,
              requestId: requestId || undefined
            }
          };
        }

        // Có get_detail OK / requestId nhưng không dishes → thường là rate-limit im lặng
        if ((detailOk || requestId) && apiCapturedCount === 0 && !apiOkEmpty) {
          console.log('[menuScraper] ⏳ Có chi tiết quán nhưng chưa lấy dishes — coi như blocked tạm');
          return {
            ok: true,
            result: {
              blocked: true,
              reason: 'Chưa bắt được menu API (quán tồn tại). Sẽ thử lại sau.',
              usedSlug: currentSlug,
              detailOk,
              requestId: requestId || undefined
            }
          };
        }

        if (closedDetected) {
          return {
            ok: true,
            result: { closed: true, reason: closedReason || 'Quán đang đóng cửa.', usedSlug: currentSlug }
          };
        }

        // Chỉ khi API 200 thật sự trả 0 món mới coi ngoài giờ / không nhận đơn
        if (apiOkEmpty) {
          return {
            ok: true,
            result: {
              closed: true,
              reason: 'Quán hiện không nhận đơn giao hàng. Vui lòng quay lại vào giờ làm việc.',
              usedSlug: currentSlug
            }
          };
        }

        return { ok: false, empty: true, slug: currentSlug };
      } finally {
        page.off('response', onResponse);
        try {
          await page.setRequestInterception(false);
        } catch (_) {}
      }
    };

    // ── Thử từng slug ──
    let lastNotFound = false;
    for (let i = 0; i < uniqueSlugs.length; i++) {
      const s = uniqueSlugs[i];
      let attempt = await scrapeOneSlug(s, { blockMedia: true });
      // Retry bỏ chặn media khi empty hoặc bị 403 (script menu đôi khi cần asset đầy đủ)
      const needMediaRetry = !fast && (
        (!attempt.ok && attempt.empty && !attempt.notFound) ||
        (attempt.ok && attempt.result && attempt.result.blocked === true)
      );
      if (needMediaRetry) {
        console.log('[menuScraper] 🔁 Retry không chặn media...');
        const retry = await scrapeOneSlug(s, { blockMedia: false });
        const retryHasMenu =
          (Array.isArray(retry.result) && retry.result.length > 0) ||
          (retry.result?.menu && retry.result.menu.length > 0);
        if (retry.ok && (retryHasMenu || !retry.result?.blocked)) {
          attempt = retry;
        }
      }
      if (attempt.ok) {
        if (Array.isArray(attempt.result)) return attempt.result;
        return { ...attempt.result, altSlugs: discoveredAlts.map(a => a.slug) };
      }
      lastNotFound = !!attempt.notFound;
    }

    // ── Search theo tên khi slug chết (bỏ qua nếu không có ứng viên khớp tên) ──
    if (options.name && lastNotFound) {
      console.log(`[menuScraper] 🔍 Search slug thay thế cho "${options.name}"...`);
      const alts = await searchAltSlugs(page, options.name, options.address || '');
      if (alts.length === 0) {
        console.log('[menuScraper] 🔍 Không có ứng viên search khớp tên quán');
      }
      for (const a of alts) {
        if (!uniqueSlugs.includes(a.slug)) {
          discoveredAlts.push(a);
          console.log(`[menuScraper]   candidate: ${a.slug} | ${a.name}`);
        }
      }
      for (const a of discoveredAlts) {
        if (uniqueSlugs.includes(a.slug)) continue;
        const attempt = await scrapeOneSlug(a.slug, { blockMedia: true });
        if (attempt.ok) {
          const res = attempt.result;
          if (Array.isArray(res)) {
            return Object.assign(res, { usedSlug: a.slug });
          }
          return {
            ...res,
            usedSlug: a.slug,
            altSlugs: discoveredAlts.map(x => x.slug),
            recoveredFromSearch: true
          };
        }
      }
    }

    if (lastNotFound) {
      return {
        closed: true,
        notFound: true,
        reason: 'Cửa hàng chưa có hoặc đã ngưng dịch vụ đặt món trên ShopeeFood.',
        altSlugs: discoveredAlts.map(a => a.slug)
      };
    }

    console.log('[menuScraper] ⚠️ Tất cả chiến lược thất bại.');
    return [];
  } catch (err) {
    console.error(`[menuScraper] ❌ Thất bại "${slug}":`, err.message);
    return [];
  } finally {
    if (watchdog) clearTimeout(watchdog);
    try {
      if (page) await page.close();
    } catch (_) {}
    if (ownsBrowser) {
      try {
        await browser.close();
      } catch (_) {}
    }
  }
}

function buildLaunchOptions(executablePath) {
  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process,TrackingPrevention',
      '--lang=vi-VN,vi,en-US,en',
      '--window-size=1280,900'
    ]
  };
  if (executablePath) launchOptions.executablePath = executablePath;
  return launchOptions;
}

async function launchBrowser() {
  const executablePath = getBrowserPath();
  return puppeteer.launch(buildLaunchOptions(executablePath));
}

async function closeBrowserSafe(browser) {
  if (!browser) return;
  try {
    await browser.close();
  } catch (_) {}
}

module.exports = {
  scrapeMenu,
  launchBrowser,
  closeBrowserSafe,
  extractMenuFromApiData
};
