/**
 * scripts/inspect-sellerfb-ui.js
 *
 * Opens the sellerFeedback detail page and dumps all interactive elements
 * so we can build accurate Playwright selectors.
 */
'use strict';

require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { chromium } = require('playwright');

const SESSION_PATH = process.env.SESSION_PATH
  ?? path.resolve(__dirname, '../../engagesupport-extractor/session/state.json');
const SELLER_FB_URL = 'https://engage-support.ibm.com/OpDashboard/#/sellerFeedback';
const OUT_DIR = path.resolve(__dirname, '../data');

async function main() {
  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
  const ctx     = await browser.newContext({ storageState: SESSION_PATH });
  const page    = await ctx.newPage();

  console.log('Navigating to sellerFeedback...');
  await page.goto(SELLER_FB_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Wait for Update button
  await page.locator('button.update-btn').waitFor({ state: 'visible', timeout: 45_000 });
  console.log('Page ready.');

  // Screenshot
  await page.screenshot({ path: path.join(OUT_DIR, 'sellerfb-screenshot.png'), fullPage: false });
  console.log('Screenshot saved.');

  // Dump ALL interactive elements
  const elements = await page.evaluate(() => {
    const result = [];
    // Buttons
    document.querySelectorAll('button').forEach(el => result.push({
      type: 'button', tag: 'BUTTON',
      text: el.textContent?.trim().slice(0, 80),
      id: el.id, class: el.className,
      ngClick: el.getAttribute('ng-click'),
    }));
    // Links with text
    document.querySelectorAll('a').forEach(el => result.push({
      type: 'link', tag: 'A',
      text: el.textContent?.trim().slice(0, 80),
      id: el.id, class: el.className,
      href: el.href?.slice(0, 100),
      ngClick: el.getAttribute('ng-click'),
    }));
    // Dropdowns / selects
    document.querySelectorAll('select').forEach(el => result.push({
      type: 'select', tag: 'SELECT',
      id: el.id, class: el.className,
      options: [...el.options].map(o => o.text).slice(0, 20),
    }));
    return result.filter(e => e.text || e.class);
  });

  fs.writeFileSync(path.join(OUT_DIR, 'sellerfb-elements.json'), JSON.stringify(elements, null, 2));
  console.log(`Found ${elements.length} elements — saved to sellerfb-elements.json`);
  console.log('\nAll elements:');
  elements.forEach(e => {
    const ngc = e.ngClick ? ` ng-click="${e.ngClick}"` : '';
    console.log(` [${e.tag}] class="${e.class?.slice(0,50)}" text="${e.text}"${ngc}`);
  });

  await page.waitForTimeout(3000);
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
