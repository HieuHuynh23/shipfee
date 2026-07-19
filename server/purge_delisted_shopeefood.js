#!/usr/bin/env node
/**
 * Loại bỏ quán đã đóng / hết hợp tác ShopeeFood khỏi DB local + Supabase.
 *
 * Tiêu chí (OR):
 *  - closedReason chứa "tạm ngưng dịch vụ" / "ngưng dịch vụ trực tuyến"
 *  - closedReason chứa "không tồn tại" / "không hoạt động trên ShopeeFood"
 *  - lastCrawlError === 'not_on_shopeefood'
 *
 * KHÔNG xóa quán chỉ "ngoài giờ phục vụ".
 *
 *   node purge_delisted_shopeefood.js              # dry-run
 *   node purge_delisted_shopeefood.js --apply       # xóa thật
 *   node purge_delisted_shopeefood.js --apply --no-supabase
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const dbHelper = require('./dbHelper');

const APPLY = process.argv.includes('--apply');
const NO_SUPABASE = process.argv.includes('--no-supabase');
const REPORT = path.join(__dirname, 'purge_delisted_report.json');

function isDelisted(r) {
  if (!r) return false;
  const reason = String(r.closedReason || '');
  const err = String(r.lastCrawlError || '');
  if (/tạm ngưng dịch vụ|ngưng dịch vụ trực tuyến/i.test(reason)) return true;
  if (/không tồn tại|không hoạt động trên ShopeeFood/i.test(reason)) return true;
  if (err === 'not_on_shopeefood') return true;
  return false;
}

async function deleteSupabaseIds(ids) {
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) {
    console.warn('Supabase credentials missing — skip remote delete');
    return { ok: 0, fail: ids.length };
  }
  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  let ok = 0;
  let fail = 0;
  const BATCH = 80;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const { error } = await supabase.from('restaurants').delete().in('id', batch);
    if (error) {
      console.error(`Supabase delete batch ${i}:`, error.message);
      fail += batch.length;
    } else {
      ok += batch.length;
      if (ok % 400 === 0 || ok === ids.length) console.log(`… supabase deleted ${ok}/${ids.length}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return { ok, fail };
}

async function main() {
  const all = dbHelper.read();
  const victims = all.filter(isDelisted);
  const keep = all.length - victims.length;

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  ShipFee — Purge quán delist / hết hợp tác ShopeeFood  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`mode: ${APPLY ? 'APPLY (xóa thật)' : 'DRY-RUN'}`);
  console.log(`total=${all.length} delisted=${victims.length} remain≈${keep}`);

  const byReason = { ngung: 0, khongTonTai: 0, notSf: 0 };
  for (const r of victims) {
    const reason = String(r.closedReason || '');
    if (/tạm ngưng|ngưng dịch vụ/i.test(reason)) byReason.ngung += 1;
    else if (/không tồn tại|không hoạt động/i.test(reason)) byReason.khongTonTai += 1;
    else if (r.lastCrawlError === 'not_on_shopeefood') byReason.notSf += 1;
  }
  console.log('breakdown:', byReason);
  console.log('sample:', victims.slice(0, 8).map(r => r.name));

  const report = {
    at: new Date().toISOString(),
    apply: APPLY,
    totalBefore: all.length,
    delisted: victims.length,
    byReason,
    sample: victims.slice(0, 30).map(r => ({
      id: r.id,
      name: r.name,
      closedReason: (r.closedReason || '').slice(0, 80),
      lastCrawlError: r.lastCrawlError || ''
    })),
    removedLocal: 0,
    supabase: null
  };

  if (!APPLY) {
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8');
    console.log(`\nDRY-RUN only. Re-run with --apply to delete. Report: ${REPORT}`);
    return;
  }

  const ids = victims.map(r => String(r.id));
  const removedLocal = dbHelper.removeRestaurantsByIds(ids);
  report.removedLocal = removedLocal;
  console.log(`Local removed: ${removedLocal}`);

  if (!NO_SUPABASE) {
    report.supabase = await deleteSupabaseIds(ids);
    console.log('Supabase:', report.supabase);
  }

  report.totalAfter = dbHelper.read().length;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n✅ DONE local=${report.totalAfter} report=${REPORT}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
