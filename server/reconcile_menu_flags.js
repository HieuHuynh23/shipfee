/**
 * Offline/local reconcile: read menus from Supabase (anon or service key),
 * fix hasRealMenu / menuTemplateFallback in restaurants-chunks, write real menus.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... node reconcile_menu_flags.js
 *   # or with service role for pushing flag corrections back:
 *   SUPABASE_SERVICE_ROLE_KEY=... node reconcile_menu_flags.js --push
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const dbHelper = require('./dbHelper');
const { analyzeMenuQuality } = require('./menuQuality');

const MENUS_DIR = path.join(__dirname, 'menus');
const PUSH = process.argv.includes('--push');

const url = (process.env.SUPABASE_URL || '').trim();
const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();

if (!url || !key) {
  console.error('Missing SUPABASE_URL / key in env');
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function main() {
  if (!fs.existsSync(MENUS_DIR)) fs.mkdirSync(MENUS_DIR, { recursive: true });

  const local = dbHelper.read();
  const byId = new Map(local.map(r => [String(r.id), r]));

  let promoted = 0;
  let demoted = 0;
  let scanned = 0;
  let offset = 0;
  const pageSize = 40;
  const pushRows = [];

  while (offset < 10000) {
    const { data, error } = await supabase
      .from('restaurants')
      .select('id, name, has_real_menu, menu, dish_names')
      .range(offset, offset + pageSize - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const row of data) {
      scanned += 1;
      const quality = analyzeMenuQuality(row.menu);
      const markedReal = row.has_real_menu === true;
      const localRow = byId.get(String(row.id));
      if (!localRow) continue;

      if (quality.isReal && !markedReal) {
        promoted += 1;
        localRow.hasRealMenu = true;
        delete localRow.menuTemplateFallback;
        localRow.dishNames = (Array.isArray(row.dish_names) && row.dish_names.length)
          ? row.dish_names
          : (row.menu || []).map(m => m && m.name).filter(Boolean);
        delete localRow.menu;
        const safeId = String(row.id).replace(/[^a-zA-Z0-9_-]/g, '_');
        fs.writeFileSync(path.join(MENUS_DIR, `${safeId}.json`), JSON.stringify(row.menu, null, 2), 'utf8');
        pushRows.push({ id: row.id, has_real_menu: true, dish_names: localRow.dishNames });
      } else if (quality.isTemplate && markedReal) {
        demoted += 1;
        localRow.hasRealMenu = false;
        localRow.menuTemplateFallback = true;
        pushRows.push({ id: row.id, has_real_menu: false });
      } else if (quality.isReal && markedReal && localRow.hasRealMenu !== true) {
        // Local lagging behind Supabase
        promoted += 1;
        localRow.hasRealMenu = true;
        delete localRow.menuTemplateFallback;
        localRow.dishNames = (Array.isArray(row.dish_names) && row.dish_names.length)
          ? row.dish_names
          : (row.menu || []).map(m => m && m.name).filter(Boolean);
        const safeId = String(row.id).replace(/[^a-zA-Z0-9_-]/g, '_');
        fs.writeFileSync(path.join(MENUS_DIR, `${safeId}.json`), JSON.stringify(row.menu, null, 2), 'utf8');
      } else if (quality.isTemplate && localRow.hasRealMenu === true) {
        demoted += 1;
        localRow.hasRealMenu = false;
        localRow.menuTemplateFallback = true;
      }
    }

    offset += pageSize;
    if (data.length < pageSize) break;
    if (offset % 400 === 0) console.log(`… scanned ${offset}, promoted ${promoted}, demoted ${demoted}`);
  }

  // Strip embedded menus before write
  local.forEach(r => { if (r) delete r.menu; });
  dbHelper.write(local);

  console.log(`\nDone. scanned=${scanned} promoted=${promoted} demoted=${demoted}`);
  console.log(`Local chunks updated. Menu files in ${MENUS_DIR}`);

  if (PUSH && pushRows.length) {
    console.log(`Pushing ${pushRows.length} flag corrections to Supabase…`);
    let ok = 0;
    for (const row of pushRows) {
      const { error } = await supabase.from('restaurants').update({
        has_real_menu: row.has_real_menu,
        dish_names: row.dish_names,
        updated_at: new Date().toISOString()
      }).eq('id', row.id);
      if (!error) ok += 1;
      else console.warn('push fail', row.id, error.message);
    }
    console.log(`Supabase updated: ${ok}/${pushRows.length}`);
  } else if (pushRows.length) {
    console.log(`(${pushRows.length} Supabase flag fixes pending — re-run with --push and service role)`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
