'use strict';

/**
 * Cross-platform frontend build: copy customer/shipper/admin apps → public/
 * Replaces Unix-only mkdir/rm/cp in root package.json for Windows + Vercel.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const apps = ['customer-app', 'shipper-app', 'admin-app'];
const publicDir = path.join(root, 'public');

fs.mkdirSync(publicDir, { recursive: true });

for (const app of apps) {
  const src = path.join(root, app);
  const dest = path.join(publicDir, app);
  if (!fs.existsSync(src)) {
    console.error(`[build] Missing source: ${app}`);
    process.exit(1);
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log(`[build] copied ${app} → public/${app}`);
}

console.log('[build] ok');
