/**
 * scripts/capture-opdash-requests.js
 *
 * Uses Playwright with the saved IBM session to navigate to the OpDashboard,
 * intercept ALL REST API calls made by the page, and print the full URL +
 * decoded filters JSON for each call.
 *
 * Run: node scripts/capture-opdash-requests.js
 *
 * This is a diagnostic/test script. Do NOT automate the export here.
 * Purpose: capture the exact filters JSON the browser sends so we can
 * replicate it in npsExtractor.ts.
 */
'use strict';

require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { chromium } = require('playwright');

const SESSION_PATH = process.env.SESSION_PATH
  ?? path.resolve(__dirname, '../../engagesupport-extractor/session/state.json');

const OPDASH_URL = 'https://engage-support.ibm.com/OpDashboard/';
const CAPTURE_FILE = path.resolve(__dirname, '../data/captured-opdash-requests.json');

async function main() {
  if (!fs.existsSync(SESSION_PATH)) {
    console.error('No session file at', SESSION_PATH, '— run IBM auth first');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
  const ctx     = await browser.newContext({
    storageState: SESSION_PATH,
    acceptDownloads: true,
  });
  const page = await ctx.newPage();

  const captured = [];

  // Intercept all REST API calls
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('/OpDashboard/rest/')) return;

    const entry = { method: req.method(), url };

    // Decode filters param if present
    try {
      const u = new URL(url);
      const rawFilters = u.searchParams.get('filters');
      if (rawFilters) entry.filters = JSON.parse(rawFilters);
      const rawReportData = u.searchParams.get('reportData');
      if (rawReportData) entry.reportData = JSON.parse(rawReportData);
    } catch { /* ignore parse errors */ }

    captured.push(entry);
    console.log('\n─── REQUEST ───────────────────────────────────────────────────');
    console.log('URL:', url.length > 200 ? url.slice(0, 200) + '…' : url);
    if (entry.filters) {
      console.log('FILTERS:');
      console.log(JSON.stringify(entry.filters, null, 2));
    }
  });

  // Navigate to OpDashboard
  console.log('Opening OpDashboard…');
  await page.goto(OPDASH_URL, { waitUntil: 'networkidle', timeout: 60000 });
  console.log('\nPage loaded. Current URL:', page.url());

  // Wait — give the user time to set filters and click Update/Export
  console.log('\n⏳ Waiting 120 seconds for you to set filters and click Export…');
  console.log('   Set: Squad = NAUS-CFCT-SW-2, Time Period = Current Year, then click Export.');
  await page.waitForTimeout(120_000);

  // Save capture
  fs.mkdirSync(path.dirname(CAPTURE_FILE), { recursive: true });
  fs.writeFileSync(CAPTURE_FILE, JSON.stringify(captured, null, 2));
  console.log(`\n✅ Captured ${captured.length} requests → ${CAPTURE_FILE}`);

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
