/**
 * scripts/dump-sellerfb-filterbar.js
 * Dumps the full filter bar HTML from the sellerFeedback page.
 */
'use strict';

require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { chromium } = require('playwright');

const SESSION_PATH  = process.env.SESSION_PATH ?? path.resolve(__dirname, '../../engagesupport-extractor/session/state.json');
const SELLER_FB_URL = 'https://engage-support.ibm.com/OpDashboard/#/sellerFeedback';
const OUT_DIR       = path.resolve(__dirname, '../data');

async function main() {
  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
  const ctx     = await browser.newContext({ storageState: SESSION_PATH });
  const page    = await ctx.newPage();

  await page.goto(SELLER_FB_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('button.update-btn').waitFor({ state: 'visible', timeout: 45_000 });

  // Dump the entire filter row HTML
  const filterHtml = await page.evaluate(() => {
    // Find the filter row / nav bar
    const candidates = [
      document.querySelector('nav'),
      document.querySelector('.filter-row'),
      document.querySelector('[class*="filter-row"]'),
      document.querySelector('.row.filter'),
      document.querySelector('.ng-scope > div > div'),
    ];
    for (const el of candidates) {
      if (el && el.innerHTML.length > 100) return `${el.tagName}#${el.id}.${el.className}\n` + el.outerHTML.slice(0, 8000);
    }
    // Fallback: grab everything containing "filter-btn-text"
    const all = [...document.querySelectorAll('[class*="filter"]')];
    return all.map(el => `${el.tagName}.${el.className}: ${el.outerHTML.slice(0, 400)}`).join('\n\n').slice(0, 8000);
  });

  fs.writeFileSync(path.join(OUT_DIR, 'sellerfb-filterbar-full.html'), filterHtml);
  console.log('Filter bar HTML saved. Length:', filterHtml.length);

  // Specifically find the Time Period / reportPeriod filter structure
  const periodStructure = await page.evaluate(() => {
    // Find any element whose ng-click contains 'reportPeriod'
    const match = document.querySelector('[ng-click*="reportPeriod"], [class*="reportPeriod"]');
    if (match) {
      // Go up 3 levels to get the container
      let el = match;
      for (let i = 0; i < 3; i++) if (el.parentElement) el = el.parentElement;
      return el.outerHTML.slice(0, 3000);
    }
    return 'Not found via ng-click. Trying text search...';
  });
  console.log('\nPeriod filter structure:\n', periodStructure.slice(0, 1000));
  fs.writeFileSync(path.join(OUT_DIR, 'sellerfb-period-filter.html'), periodStructure);

  // Dump all <li> items with text that look like period options
  const allLiTexts = await page.evaluate(() => {
    return [...document.querySelectorAll('li')]
      .map(li => ({ text: li.textContent?.trim().slice(0, 80), class: li.className, parent: li.parentElement?.className?.slice(0,60) }))
      .filter(li => li.text);
  });
  console.log('\nAll <li> items on page:');
  allLiTexts.forEach(li => console.log(` class="${li.class}" parent="${li.parent}" → "${li.text}"`));

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
