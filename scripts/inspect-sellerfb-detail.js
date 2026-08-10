/**
 * scripts/inspect-sellerfb-detail.js
 *
 * Opens sellerFeedback, sets Time Period to Current Year + Squad to NAUS-CFCT-SW-2,
 * clicks Update, then scrolls and dumps all elements to find the Export button
 * and understand the detail view structure.
 */
'use strict';

require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { chromium } = require('playwright');

const SESSION_PATH    = process.env.SESSION_PATH ?? path.resolve(__dirname, '../../engagesupport-extractor/session/state.json');
const SQUAD_NAME      = process.env.SQUAD_GROUP ?? 'NAUS-CFCT-SW-2';
const SQUAD_GROUP_API = process.env.SQUAD_GROUP_API ?? 'AG SW II';
const SELLER_FB_URL   = 'https://engage-support.ibm.com/OpDashboard/#/sellerFeedback';
const OUT_DIR         = path.resolve(__dirname, '../data');

async function main() {
  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
  const ctx     = await browser.newContext({ storageState: SESSION_PATH });
  const page    = await ctx.newPage();

  console.log('Navigating to sellerFeedback...');
  await page.goto(SELLER_FB_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('button.update-btn').waitFor({ state: 'visible', timeout: 45_000 });
  console.log('Page ready.');

  // ── Set Time Period ──────────────────────────────────────────────────────────
  // The reportPeriod filter — click the <a class="filter-btn-text ng-binding"> that
  // shows "Current Month" (it's inside .reportPeriod container)
  console.log('Setting Time Period...');
  const periodLink = page.locator('.reportPeriod a.filter-btn-text.ng-binding');
  await periodLink.waitFor({ state: 'visible', timeout: 10_000 });
  console.log('Current period text:', await periodLink.textContent());
  await periodLink.click();
  await page.waitForTimeout(500);

  // Dump dropdown options
  const dropdownItems = await page.evaluate(() => {
    return [...document.querySelectorAll('.reportPeriod li, .reportPeriod a, .reportPeriod span')]
      .map(el => ({ tag: el.tagName, text: el.textContent?.trim(), class: el.className }))
      .filter(e => e.text);
  });
  console.log('Period dropdown options:', JSON.stringify(dropdownItems, null, 2));

  // Click "Current Year"
  const yearOption = page.locator('.reportPeriod li, .reportPeriod a').filter({ hasText: 'Current Year' }).first();
  try {
    await yearOption.waitFor({ state: 'visible', timeout: 5_000 });
    await yearOption.click();
    console.log('Selected "Current Year".');
  } catch(e) {
    console.log('Could not find "Current Year" in dropdown:', e.message);
  }
  await page.waitForTimeout(500);

  // ── Set Squad Group/Squad ───────────────────────────────────────────────────
  console.log('Setting Squad...');
  const squadLink = page.locator('.tribe a.filter-btn-text.ng-binding').first();
  await squadLink.waitFor({ state: 'visible', timeout: 10_000 });
  console.log('Current squad text:', await squadLink.textContent());
  await squadLink.click();
  await page.waitForTimeout(500);

  // Try search box
  const searchInput = page.locator('.tribe input[type="text"], .tribe input[ng-model]').first();
  try {
    await searchInput.waitFor({ state: 'visible', timeout: 3_000 });
    await searchInput.fill(SQUAD_NAME);
    await page.waitForTimeout(800);
    console.log('Typed squad name in search box.');
  } catch { console.log('No search box — looking for option directly.'); }

  const squadOpt = page.locator('.tribe li, .tribe label, .tribe a').filter({ hasText: SQUAD_NAME }).first();
  try {
    await squadOpt.waitFor({ state: 'visible', timeout: 5_000 });
    await squadOpt.click();
    console.log(`Selected "${SQUAD_NAME}".`);
  } catch(e) { console.log('Could not select squad:', e.message); }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // ── Click Update ──────────────────────────────────────────────────────────
  console.log('Clicking Update...');
  await page.locator('button.update-btn').click();
  await page.waitForTimeout(6000);

  // Screenshot after update
  await page.screenshot({ path: path.join(OUT_DIR, 'sellerfb-filtered.png'), fullPage: false });
  console.log('Screenshot after filter saved.');

  // ── Scroll down and find export button ────────────────────────────────────
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT_DIR, 'sellerfb-bottom.png'), fullPage: false });

  // Dump ALL elements again after update
  const allEls = await page.evaluate(() => {
    return [...document.querySelectorAll('button, a[ng-click], a[class*="export"], a[class*="download"]')]
      .map(el => ({
        tag: el.tagName, text: el.textContent?.trim().slice(0, 80),
        class: el.className, ngClick: el.getAttribute('ng-click'),
        id: el.id, href: el.getAttribute('href'),
      }))
      .filter(e => e.text || e.ngClick);
  });

  fs.writeFileSync(path.join(OUT_DIR, 'sellerfb-filtered-elements.json'), JSON.stringify(allEls, null, 2));
  console.log('\nAll interactive elements after filter:');
  allEls.forEach(e => {
    const ngc = e.ngClick ? ` ng-click="${e.ngClick}"` : '';
    console.log(` [${e.tag}] class="${e.class?.slice(0,50)}" text="${e.text}"${ngc}`);
  });

  await page.waitForTimeout(3000);
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
