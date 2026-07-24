'use strict';

/**
 * Apply 001_orders_sot_prep.sql via Postgres connection string if available.
 * Prefer: SUPABASE_DB_URL or DATABASE_URL in server/.env
 * Fallback: print instructions (SQL Editor).
 *
 * Usage: node scripts/apply_sot_prep_migration.js
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const sqlPath = path.join(__dirname, '..', 'migrations', '001_orders_sot_prep.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');
const dbUrl = (process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '').trim();

async function main() {
  if (!dbUrl) {
    console.log('[migrate] Không có SUPABASE_DB_URL / DATABASE_URL trong server/.env');
    console.log('[migrate] Hãy mở Supabase Dashboard → SQL Editor và chạy:');
    console.log('         server/migrations/001_orders_sot_prep.sql');
    console.log('[migrate] Chi tiết: server/migrations/README_SOT_PREP.md');
    process.exit(0);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (_) {
    console.error('[migrate] Cần package `pg`: cd server && npm install pg');
    process.exit(1);
  }

  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(sql);
    console.log('[migrate] ✅ Đã apply 001_orders_sot_prep.sql');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[migrate] Thất bại:', err.message);
  process.exit(1);
});
