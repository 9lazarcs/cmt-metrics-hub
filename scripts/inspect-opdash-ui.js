/**
 * scripts/inspect-opdash-ui.js
 *
 * Opens the OpDashboard with the saved session, takes a screenshot,
 * and dumps the filter bar HTML so we know the exact selectors.
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

  // Wait for Update button
  await page.locator('button').filter({ hasText: /^Update$/ }).waitFor({ state: 'visible', timeout: 45_000 });
  console.log('Page ready.');

  // Screenshot
  const screenshotPath = path.join(OUT_DIR, 'opdash-screenshot.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log('Screenshot saved:', screenshotPath);

  // Dump the entire filter bar HTML (top ~3000 chars of body)
  const filterBarHtml = await page.evaluate(() => {
    // Try to find the filter row
    const selectors = [
      '[class*="filter"]', '[class*="toolbar"]', '[class*="header"]',
      'nav', 'header', '.filterBar', '#filterBar',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return `SELECTOR: ${sel}\n` + el.outerHTML.slice(0, 4000);
    }
    return 'No filter bar found. Body start:\n' + document.body.innerHTML.slice(0, 3000);
  });
  const htmlPath = path.join(OUT_DIR, 'opdash-filterbar.html');
  fs.writeFileSync(htmlPath, filterBarHtml);
  console.log('Filter bar HTML saved:', htmlPath);

  // Also dump ALL button texts and their classes
  const buttons = await page.evaluate(() => {
    return [...document.querySelectorAll('button, [role="button"]')]
      .map(b => ({
        text:    b.textContent?.trim().slice(0, 60),
        id:      b.id,
        class:   b.className?.slice(0, 80),
        tag:     b.tagName,
      }))
      .filter(b => b.text);
  });
  const buttonsPath = path.join(OUT_DIR, 'opdash-buttons.json');
  fs.writeFileSync(buttonsPath, JSON.stringify(buttons, null, 2));
  console.log(`Found ${buttons.length} buttons — saved to`, buttonsPath);
  console.log('First 20 buttons:');
  buttons.slice(0, 20).forEach(b => console.log(` [${b.tag}] id="${b.id}" class="${b.class?.slice(0,40)}" → "${b.text}"`));

  await page.waitForTimeout(3000);
  await browser.close();
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
