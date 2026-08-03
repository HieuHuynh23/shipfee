const { execSync } = require('child_process');

try {
  const output = execSync('wmic process where "name=\'node.exe\'" get processid,commandline', { encoding: 'utf8' });
  const lines = output.split('\n');
  lines.forEach(line => {
    if (line.includes('crawl') || line.includes('bulk_crawl') || line.includes('crawl_scheduler')) {
      const match = line.match(/(\d+)\s*$/);
      if (match) {
        const pid = match[1];
        try {
          execSync(`taskkill /F /PID ${pid}`);
          console.log(`[Stop Scraper] Stopped process PID ${pid}`);
        } catch (e) {
          console.log(`[Stop Scraper] Could not stop PID ${pid}: ${e.message}`);
        }
      }
    }
  });
} catch (err) {
  console.log('[Stop Scraper] Check complete:', err.message);
}
