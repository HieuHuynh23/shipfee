/**
 * Detect template/fallback menus vs real scraped ShopeeFood menus.
 * Template signals: unsplash placeholders, generated "-item-N" ids without options.
 * Real signals: dish options, Shopee/Foody CDN images.
 */

function analyzeMenuQuality(menu) {
  if (!Array.isArray(menu) || menu.length === 0) {
    return { isReal: false, isTemplate: false, reason: 'empty', itemCount: 0 };
  }

  let unsplash = 0;
  let opts = 0;
  let itemIds = 0;
  let cdnImg = 0;
  let dacSan = 0;

  for (const m of menu) {
    if (!m || typeof m !== 'object') continue;
    const img = String(m.img || '');
    if (img.includes('unsplash.com')) unsplash += 1;
    if (
      img.includes('susercontent.com') ||
      img.includes('shopee') ||
      img.includes('foody.vn') ||
      img.includes('down-bs') ||
      img.includes('down-vn')
    ) {
      cdnImg += 1;
    }
    if (m.options !== undefined) opts += 1;
    if (String(m.id || '').includes('-item-')) itemIds += 1;
    if (String(m.name || '').startsWith('Đặc sản ')) dacSan += 1;
  }

  const n = menu.length;

  if (unsplash >= Math.max(1, Math.floor(n / 2))) {
    return { isReal: false, isTemplate: true, reason: 'unsplash_template', itemCount: n, unsplash, opts, cdnImg };
  }
  if (dacSan >= 1 && n <= 6 && opts === 0) {
    return { isReal: false, isTemplate: true, reason: 'dac_san_template', itemCount: n, unsplash, opts, cdnImg };
  }
  if (opts >= Math.max(1, Math.floor(n / 3)) || cdnImg >= Math.max(1, Math.floor(n / 3))) {
    return { isReal: true, isTemplate: false, reason: 'scraped_signals', itemCount: n, unsplash, opts, cdnImg };
  }
  if (n <= 6 && itemIds >= Math.max(1, n - 1) && opts === 0) {
    return { isReal: false, isTemplate: true, reason: 'generated_item_ids', itemCount: n, unsplash, opts, cdnImg };
  }

  // Ambiguous: treat as non-real so UI does not claim "thực đơn chuẩn"
  return { isReal: false, isTemplate: false, reason: 'ambiguous', itemCount: n, unsplash, opts, cdnImg };
}

function applyMenuFlags(restaurant, menu) {
  if (!restaurant) return restaurant;
  const q = analyzeMenuQuality(menu);
  if (q.isReal) {
    restaurant.hasRealMenu = true;
    delete restaurant.menuTemplateFallback;
  } else if (q.isTemplate || q.reason === 'empty') {
    restaurant.hasRealMenu = false;
    restaurant.menuTemplateFallback = true;
  } else {
    // ambiguous — keep conservative: not real
    restaurant.hasRealMenu = false;
    restaurant.menuTemplateFallback = true;
  }
  restaurant.menuQuality = q.reason;
  return restaurant;
}

module.exports = {
  analyzeMenuQuality,
  applyMenuFlags
};
