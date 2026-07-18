/**
 * Resolve Foody brand portals ("Hệ thống …", address "N chi nhánh")
 * → chi nhánh Cần Thơ có thể cào menu trên ShopeeFood.
 */
'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { slugFromRestaurant, rewriteSlug } = require('./slugMap');

const FOODY_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
};

function foodySlugFromHref(href) {
  const h = String(href || '').split('?')[0];
  if (!h || h.includes('{{') || h === '#' || h.startsWith('javascript:')) return '';
  const m = h.match(/\/can-tho\/([^/?#]+)/i);
  return m ? m[1] : '';
}

function brandSlugCandidates(restaurant) {
  const seen = new Set();
  const out = [];
  const push = (s) => {
    const v = String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };

  const raw = slugFromRestaurant(restaurant).replace(/^he-thong-/, '');
  push(raw);
  push(`he-thong-${raw}`);

  const name = String(restaurant.name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/h[eệ]\s*th[oố]ng\s*/gi, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  push(name);
  push(`he-thong-${name}`);

  return out;
}

/**
 * @returns {Promise<Array<{id:string,name:string,address:string,img:string,foodySlug:string,shopeefoodSlug:string}>>}
 */
async function resolveBrandBranches(brandSlug) {
  const slug = String(brandSlug || '').replace(/^he-thong-/, '');
  const trySlugs = [...new Set([brandSlug, slug, `he-thong-${slug}`].filter(Boolean))];

  for (const trySlug of trySlugs) {
    const url = `https://www.foody.vn/thuong-hieu/${trySlug}?c=can-tho`;
    try {
      const res = await axios.get(url, { headers: FOODY_HEADERS, timeout: 12000, validateStatus: () => true });
      if (res.status !== 200) continue;
      const $ = cheerio.load(res.data);
      const title = $('title').text().toLowerCase();
      if (title.includes('không tìm thấy')) continue;

      const branches = [];
      const seen = new Set();

      $('.ldc-item').each((i, el) => {
        const nameEl = $(el).find('.ldc-item-h-name h2 a').first();
        let name = nameEl.text().trim();
        const foodyHref = nameEl.attr('href') || $(el).find('a[href*="/can-tho/"]').first().attr('href') || '';
        if (!name || name === '...' || name.includes('{{')) {
          name = $(el).find('img[alt]').first().attr('alt') || '';
          name = String(name).replace(/&amp;/g, '&').trim();
        }
        if (!name || name.includes('{{') || /đóng cửa/i.test(name)) return;

        const foodySlug = foodySlugFromHref(foodyHref);
        if (!foodySlug) return; // chỉ giữ chi nhánh Cần Thơ

        const address = $(el).find('.ldc-item-h-address span').text().trim();
        let img = $(el).find('.ldc-item-img img').attr('src') || '';
        if (!img || img.includes('{{') || img.includes('ratin-rank')) {
          img = '';
        }

        let shopeefoodSlug = '';
        $(el).find('a').each((_, aEl) => {
          const href = $(aEl).attr('href') || '';
          if (
            href.includes('shopeefood.vn/can-tho/') &&
            !href.includes('/can-tho/fresh') &&
            !href.includes('/can-tho/food')
          ) {
            const parts = href.split('?')[0].split('/').filter(Boolean);
            shopeefoodSlug = parts[parts.length - 1] || '';
          }
        });

        // Nhiều trang thương hiệu không gắn link ShopeeFood — dùng foody slug làm ứng viên
        if (!shopeefoodSlug) shopeefoodSlug = foodySlug;
        shopeefoodSlug = rewriteSlug(String(shopeefoodSlug).split('?')[0]);
        if (!shopeefoodSlug) return;

        if (seen.has(shopeefoodSlug)) return;
        seen.add(shopeefoodSlug);

        branches.push({
          id: `r_ct_${shopeefoodSlug.replace(/-/g, '_')}`,
          name,
          address,
          img:
            img ||
            'https://images.unsplash.com/photo-1625398407796-82650a8c135f?w=800&q=80',
          foodySlug,
          shopeefoodSlug
        });
      });

      if (branches.length > 0) return branches;
    } catch (_) {
      /* try next slug */
    }
  }
  return [];
}

/**
 * Fallback: tìm chi nhánh Cần Thơ qua trang địa điểm Foody (?q=).
 */
async function searchFoodyBranchesInCanTho(query) {
  const q = String(query || '').trim();
  if (!q || q.length < 2) return [];
  const url = `https://www.foody.vn/can-tho/dia-diem?q=${encodeURIComponent(q)}`;
  try {
    const res = await axios.get(url, { headers: FOODY_HEADERS, timeout: 12000, validateStatus: () => true });
    if (res.status !== 200) return [];
    const $ = cheerio.load(res.data);
    const branches = [];
    const seen = new Set();

    $('.row-item, .ldc-item').each((_, el) => {
      const nameEl = $(el).find('h2 a, .ldc-item-h-name h2 a, .row-item-title a').first();
      let name = nameEl.text().trim();
      const href = nameEl.attr('href') || '';
      if (!name || name.includes('{{')) return;
      // Bỏ chính portal cha
      if (/h[eệ]\s*th[oố]ng/i.test(name) && !/[-–]/.test(name)) return;

      const foodySlug = foodySlugFromHref(href);
      if (!foodySlug) return;

      let shopeefoodSlug = '';
      $(el).find('a').each((__, aEl) => {
        const h = $(aEl).attr('href') || '';
        if (
          h.includes('shopeefood.vn/can-tho/') &&
          !h.includes('/fresh') &&
          !h.includes('/food')
        ) {
          const parts = h.split('?')[0].split('/').filter(Boolean);
          shopeefoodSlug = parts[parts.length - 1] || '';
        }
      });
      if (!shopeefoodSlug) shopeefoodSlug = foodySlug;
      shopeefoodSlug = rewriteSlug(String(shopeefoodSlug).split('?')[0]);
      if (!shopeefoodSlug || seen.has(shopeefoodSlug)) return;
      seen.add(shopeefoodSlug);

      const address = $(el).find('.address, .row-item-address, .ldc-item-h-address span').first().text().trim();
      let img = $(el).find('img').first().attr('src') || '';
      if (!img || img.includes('ratin-rank')) img = '';

      branches.push({
        id: `r_ct_${shopeefoodSlug.replace(/-/g, '_')}`,
        name,
        address: address.replace(/\s+/g, ' ').trim(),
        img: img || 'https://images.unsplash.com/photo-1625398407796-82650a8c135f?w=800&q=80',
        foodySlug,
        shopeefoodSlug
      });
    });
    return branches;
  } catch (_) {
    return [];
  }
}

function brandDisplayName(restaurant) {
  return String(restaurant.name || '')
    .replace(/h[eệ]\s*th[oố]ng\s*/gi, '')
    .replace(/\s*[-–].*$/, '')
    .trim();
}

async function resolveBranchesForRestaurant(restaurant) {
  const candidates = brandSlugCandidates(restaurant);
  for (const slug of candidates) {
    const branches = await resolveBrandBranches(slug);
    if (branches.length > 0) return { brandSlug: slug, branches };
  }

  // Brand page Foody đôi khi không lọc đúng thành phố → search địa điểm CT
  const q = brandDisplayName(restaurant) || candidates[0];
  const searched = await searchFoodyBranchesInCanTho(q);
  if (searched.length > 0) {
    return { brandSlug: candidates[0] || q, branches: searched };
  }
  return { brandSlug: candidates[0] || '', branches: [] };
}

/**
 * Resolve ShopeeFood slug from a Foody place page (and optionally brand page).
 */
async function resolveShopeefoodSlugFromFoody(foodySlug) {
  const tryUrls = [
    `https://www.foody.vn/can-tho/${foodySlug}`,
    `https://www.foody.vn/thuong-hieu/${foodySlug}?c=can-tho`
  ];
  for (const url of tryUrls) {
    try {
      const res = await axios.get(url, { headers: FOODY_HEADERS, timeout: 10000, validateStatus: () => true });
      if (res.status !== 200) continue;
      const $ = cheerio.load(res.data);
      let shopeefoodUrl = '';
      $('a').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (
          href.includes('shopeefood.vn/can-tho/') &&
          !href.includes('/can-tho/fresh') &&
          !href.includes('/can-tho/food')
        ) {
          shopeefoodUrl = href;
        }
      });
      if (!shopeefoodUrl) continue;
      const parts = shopeefoodUrl.split('?')[0].split('/').filter(Boolean);
      const resolved = parts[parts.length - 1];
      if (resolved) return rewriteSlug(resolved);
    } catch (_) {
      /* next */
    }
  }
  return '';
}

module.exports = {
  brandSlugCandidates,
  resolveBrandBranches,
  resolveBranchesForRestaurant,
  resolveShopeefoodSlugFromFoody,
  searchFoodyBranchesInCanTho,
  foodySlugFromHref
};
