const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Save Chromium cache inside the project directory so Render packages and deploys it.
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
