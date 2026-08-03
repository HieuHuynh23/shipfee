#!/usr/bin/env node
/**
 * Audit restaurants sharing the same shopeefoodSlug / sibling-borrowed menus.
 * Usage: node audit_duplicate_menus.js [--apply]
 *   --apply  mark menuSuspectDuplicate + clear hasRealMenu for force re-crawl
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const dbHelper = require('./dbHelper');

const APPLY = process.argv.includes('--apply');

function main() {
  const all = dbHelper.read();
  const bySlug = new Map();
  const borrowed = [];
  const cityLevel = [];

  for (const r of all) {
    if (!r || !r.id) continue;
    const slug = String(r.shopeefoodSlug || '').split('?')[0].trim();
    if (slug) {
      if (!bySlug.has(slug)) bySlug.set(slug, []);
      bySlug.get(slug).push(r);
    }
    if (r.menuFromSiblingId || r.menuBorrowedFromSibling) borrowed.push(r);
    if (
      /^(kfc|jollibee|highlands-coffee|lotteria)-can-tho$/.test(slug) ||
      slug === 'kfc-can-tho' ||
      slug === 'jollibee-can-tho'
    ) {
      cityLevel.push(r);
    }
  }

  const dupes = [...bySlug.entries()].filter(([, rows]) => rows.length > 1);
  console.log(`Shared shopeefoodSlug groups: ${dupes.length}`);
  for (const [slug, rows] of dupes.slice(0, 40)) {
    console.log(`  ${slug} → ${rows.length} quán`);
    rows.forEach(r => console.log(`    - ${r.id} | real=${!!r.hasRealMenu} | ${r.name}`));
  }
  if (dupes.length > 40) console.log(`  ... +${dupes.length - 40} groups`);

  console.log(`\nSibling-borrowed: ${borrowed.length}`);
  console.log(`City-level slugs still stored: ${cityLevel.length}`);

  if (!APPLY) {
    console.log('\nDry-run only. Re-run with --apply to mark suspects for re-crawl.');
    return;
  }

  const markIds = new Set();
  for (const [, rows] of dupes) {
    const sorted = rows.slice().sort((a, b) => Number(!!b.hasRealMenu) - Number(!!a.hasRealMenu));
    for (let i = 1; i < sorted.length; i++) markIds.add(String(sorted[i].id));
  }
  for (const r of borrowed) markIds.add(String(r.id));
  for (const r of cityLevel) markIds.add(String(r.id));

  let changed = 0;
  for (const r of all) {
    if (!r || !markIds.has(String(r.id))) continue;
    r.menuSuspectDuplicate = true;
    r.hasRealMenu = false;
    r.menuTemplateFallback = true;
    delete r.menuFromSiblingId;
    delete r.menuBorrowedFromSibling;
    changed += 1;
  }
  dbHelper.write(all);
  console.log(`\nApplied: marked ${changed} restaurants for force re-crawl.`);
}

main();
