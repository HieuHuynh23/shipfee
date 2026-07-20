#!/usr/bin/env node
/**
 * Đồng bộ local restaurants-chunks + menus/*.json → Supabase (cho Render hydrate).
 *
 *   node sync_menus_to_supabase.js
 *   node sync_menus_to_supabase.js --only-real
 *   node sync_menus_to_supabase.js --limit=100
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const dbHelper = require('./dbHelper');
const supaSync = require('./supabaseSync');

const ONLY_REAL = process.argv.includes('--only-real');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? Math.max(1, parseInt(limitArg.split('=')[1], 10) || 0) : 0;

const supabase = supaSync.getSupabaseClient();
if (!supabase) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const MENUS_DIR = path.join(__dirname, 'menus');

function safeMenuId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function readMenu(id) {
  const p = path.join(MENUS_DIR, `${safeMenuId(id)}.json`);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) || [];
  } catch (_) {
    return [];
  }
}

async function main() {
  let list = dbHelper.read().filter(r => r && r.id);
  if (ONLY_REAL) list = list.filter(r => r.hasRealMenu === true);
  if (LIMIT > 0) list = list.slice(0, LIMIT);

  console.log(`Sync ${list.length} restaurants → Supabase (only-real=${ONLY_REAL})`);

  const BATCH = 40;
  let ok = 0;
  let fail = 0;
  let withMenu = 0;

  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    const rows = batch.map(r => {
      const menu = readMenu(r.id);
      if (menu.length > 0) withMenu += 1;
      return supaSync.buildRestaurantRow(r, menu);
    });

    const res = await supaSync.upsertRestaurantsBatch(rows, { client: supabase });
    if (!res.ok) {
      console.error(`batch ${i}-${i + batch.length} FAIL:`, res.error || 'skipped');
      fail += batch.length;
    } else {
      ok += batch.length;
      if (ok % 200 === 0 || ok === list.length) {
        console.log(`… ${ok}/${list.length} ok (menus in batch files so far ~${withMenu})`);
      }
    }
    await new Promise(r => setTimeout(r, 250));
  }

  console.log(`\nDONE ok=${ok} fail=${fail} rows_with_local_menu_file≈${withMenu}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
