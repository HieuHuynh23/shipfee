#!/usr/bin/env node
/**
 * local_bulk_crawler.js — wrapper tương thích ngược.
 * Logic chính đã chuyển sang crawl_restaurant_menus.js
 *
 *   node local_bulk_crawler.js
 *   node local_bulk_crawler.js --threads=2
 *   node local_bulk_crawler.js --only-fallback --open-only --limit=100
 */
const { spawn } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
// Mặc định: chỉ fallback + quán đang mở (an toàn hơn cào hết DB)
const defaults = [];
if (!args.some(a => a.startsWith('--threads='))) defaults.push('--threads=4');
if (!args.some(a => a.startsWith('--delay='))) defaults.push('--delay=1500');
if (!args.includes('--only-fallback') && !args.includes('--force') && !args.some(a => a.startsWith('--id='))) {
  defaults.push('--only-fallback', '--open-only', '--sf-priority');
}

const child = spawn(
  process.execPath,
  [path.join(__dirname, 'crawl_restaurant_menus.js'), ...defaults, ...args],
  { stdio: 'inherit', cwd: __dirname }
);

child.on('exit', code => process.exit(code || 0));
