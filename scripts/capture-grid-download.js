/**
 * scripts/capture-grid-download.js
 *
 * Diagnostic: apply filters on the grid (Status=Closed, Squad=NAUS-CFCT-SW-2,
 * Close Date after 2026-01-01), then capture the download network request URL
 * when you click the download button.
 *
 * Usage:
 *   node scripts/capture-grid-download.js
 *
 * Instructions:
 *   1. Browser opens, grid loads
 *   2. Script auto-applies the filters
 *   3. YOU: click the download button (top-right toolbar)
 *   4. Terminal shows the full download URL + headers
 */
require('dotenv/config');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SESSION_PATH = process.env.SESSION_PATH
  ?? path.resolve(__dirname, '../../engagesupport-extractor/session/state.json');
const GRID_URL  = 'https://engage-support.ibm.com/serviceRequestGrid';
const SQUAD     = process.env.SQUAD_GROUP ?? 'NAUS-CFCT-SW-2';

async function typeIntoCombobox(page, inputId, value) {
  // Click the toggle button to open the dropdown
  const toggleId = inputId.replace('-input', '-toggle-button');
  await page.evaluate((toggleId) => {
    document.getElementById(toggleId)?.click();
  }, toggleId);
  await page.waitForTimeout(600);

  // Type the search value into the input
  await page.evaluate(({ inputId, value }) => {
    const input = document.getElementById(inputId);
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, { inputId, value });
  await page.waitForTimeout(800);

  // Click the matching option
  const clicked = await page.evaluate((value) => {
    const options = document.querySelectorAll('[role="option"], .cds--list-box__menu-item');
    for (const opt of options) {
      if (opt.textContent?.trim() === value) {
        opt.click();
        return true;
      }
    }
    return false;
  }, value);
  await page.waitForTimeout(400);
  return clicked;
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const ctx     = await browser.newContext();

  if (fs.existsSync(SESSION_PATH)) {
    const raw = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8'));
    await ctx.addCookies(raw.cookies ?? []);
    console.log('[capture] Session restored.');
  }

  // Log all requests
  const downloadRequests = [];
  ctx.on('request', (req) => {
    const url = req.url();
    if (url.includes('download') || url.includes('export') || url.includes('xlsx') || url.includes('csv')) {
      downloadRequests.push({ method: req.method(), url, headers: req.headers() });
      console.log(`\n[DOWNLOAD REQUEST] ${req.method()} ${url}`);
    }
    if (url.includes('engage-support') && !url.includes('.js') && !url.includes('.css') && !url.includes('.png')) {
      console.log(`[net] ${req.method()} ${url.slice(0, 120)}`);
    }
  });

  const page = await ctx.newPage();
  await page.goto(GRID_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(4_000);
  console.log('[capture] Grid loaded.');

  // Open filter flyout
  console.log('[capture] Opening filter flyout...');
  await page.evaluate(() => {
    document.querySelector('.c4p--datagrid-filter-flyout__trigger')?.click();
  });
  await page.waitForTimeout(2_000);

  // Set Status = Closed
  console.log('[capture] Setting Status = Closed...');
  const statusSet = await typeIntoCombobox(page, 'request-status-multiselect-input', 'Closed');
  console.log('[capture] Status set:', statusSet);

  // Set Squad = NAUS-CFCT-SW-2
  console.log('[capture] Setting Squad...');
  const squadSet = await typeIntoCombobox(page, 'squads-multiselect-input', SQUAD);
  console.log('[capture] Squad set:', squadSet);

  // Set Close Date: check what's currently in the advanced filter and add a date condition
  // The advanced filter has a column selector + condition + value
  // Currently shows "Close Date | after | mm/dd/yyyy"
  // We just need to fill in the date input
  console.log('[capture] Setting Close Date after 01/01/2026...');
  await page.evaluate(() => {
    const input = document.querySelector('input[placeholder="mm/dd/yyyy"]');
    if (!input) { console.log('no date input found'); return; }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '01/01/2026');
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
  });
  await page.waitForTimeout(500);

  // Dump the current filter panel state
  const filterState = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input')).map(el => ({
      id: el.id, type: el.type, value: el.value, placeholder: el.placeholder
    })).filter(i => i.value || i.placeholder === 'mm/dd/yyyy');
    return inputs;
  });
  console.log('[capture] Filter state:', JSON.stringify(filterState, null, 2));

  // Click Apply
  console.log('[capture] Clicking Apply...');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const apply = btns.find(b => b.textContent?.trim() === 'Apply' && b.className.includes('cds--btn--primary'));
    apply?.click();
  });
  await page.waitForTimeout(4_000);

  // Read row count from pagination
  const count = await page.evaluate(() => {
    const m = document.body.innerText.match(/of\s+([\d,]+)\s+items?/i);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
  });
  console.log(`[capture] Row count after filters: ${count}`);

  // Dump the toolbar buttons so we can find the download button
  const toolbarBtns = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).map(b => ({
      text: b.textContent?.trim().slice(0, 40),
      ariaLabel: b.getAttribute('aria-label'),
      title: b.title,
      class: b.className.slice(0, 60),
    })).filter(b => b.text || b.ariaLabel || b.title)
  );
  console.log('\n[capture] Toolbar / visible buttons:');
  toolbarBtns.forEach(b => console.log(JSON.stringify(b)));

  console.log('\n══════════════════════════════════════════════');
  console.log('ACTION: Click the DOWNLOAD button now.');
  console.log('        Watching for download network requests...');
  console.log('══════════════════════════════════════════════\n');

  await page.waitForTimeout(30_000);

  console.log('\n─── CAPTURED DOWNLOAD REQUESTS ──────────────');
  downloadRequests.forEach(r => {
    console.log(`\nMETHOD: ${r.method}`);
    console.log(`URL:    ${r.url}`);
    console.log('HEADERS:', JSON.stringify(r.headers, null, 2));
  });

  await browser.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
