/**
 * scripts/find-sales-fb-url.js
 *
 * Navigates to the OpDashboard home, finds the Sales Engagement Feedback section,
 * and captures the URL for the Detail view + all links.
 */
'use strict';

require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { chromium } = require('playwright');

const SESSION_PATH = process.env.SESSION_PATH
  ?? path.resolve(__dirname, '../../engagesupport-extractor/session/state.json');
const OPDASH_URL = 'https://engage-support.ibm.com/OpDashboard/';
const OUT_DIR    = path.resolve(__dirname, '../data');

async function main() {
  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
  const ctx     = await browser.newContext({ storageState: SESSION_PATH });
  const page    = await ctx.newPage();

  console.log('Navigating to OpDashboard...');
  await page.goto(OPDASH_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('button').filter({ hasText: /^Update$/ }).waitFor({ state: 'visible', timeout: 45_000 });
  console.log('Page ready.');

  // Capture all links and their href values
  const links = await page.evaluate(() => {
    return [...document.querySelectorAll('a')]
      .map(a => ({ text: a.textContent?.trim().slice(0, 60), href: a.href, id: a.id, class: a.className?.slice(0, 60) }))
      .filter(l => l.text || l.href);
  });
  console.log('\nAll links:');
  links.forEach(l => console.log(` "${l.text}" → ${l.href} [class: ${l.class}]`));

  // Find "View details" link near Sales Engagement Feedback
  const salesFbLinks = links.filter(l =>
    l.text?.toLowerCase().includes('view details') ||
    l.href?.toLowerCase().includes('sales') ||
    l.href?.toLowerCase().includes('feedback') ||
    l.href?.toLowerCase().includes('detail')
  );
  console.log('\nSales/Feedback/Detail links:');
  salesFbLinks.forEach(l => console.log(` "${l.text}" → ${l.href}`));

  // Screenshot
  await page.screenshot({ path: path.join(OUT_DIR, 'opdash-home.png'), fullPage: true });

  // Also dump full HTML to find the "View details" link context
  const bodyHtml = await page.content();
  const salesIdx = bodyHtml.toLowerCase().indexOf('sales engagement');
  if (salesIdx >= 0) {
    console.log('\nHTML around "Sales Engagement":');
    console.log(bodyHtml.slice(Math.max(0, salesIdx - 100), salesIdx + 800));
  }

  fs.writeFileSync(path.join(OUT_DIR, 'opdash-links.json'), JSON.stringify(links, null, 2));
  await browser.close();
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
