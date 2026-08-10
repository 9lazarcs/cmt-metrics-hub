/**
 * scripts/find-download-url.js
 * Applies filters automatically + clicks download to capture the URL.
 */
require('dotenv/config');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SESSION_PATH = process.env.SESSION_PATH
  ?? path.resolve(__dirname, '../../engagesupport-extractor/session/state.json');

async function clickCombo(page, toggleId, inputId, value) {
  await page.evaluate(id => document.getElementById(id)?.click(), toggleId);
  await page.waitForTimeout(600);
  await page.evaluate(({ id, val }) => {
    const input = document.getElementById(id);
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, val);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, { id: inputId, val: value });
  await page.waitForTimeout(800);
  await page.evaluate(val => {
    for (const o of document.querySelectorAll('[role="option"]'))
      if (o.textContent?.trim() === val) { o.click(); return; }
  }, value);
  await page.waitForTimeout(400);
}

async function main() {
  console.log('[find-dl] Launching browser...');
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();

  if (!fs.existsSync(SESSION_PATH)) {
    console.error('No session file at', SESSION_PATH); process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8'));
  await ctx.addCookies(raw.cookies ?? []);
  console.log('[find-dl] Session restored.');

  // Log ALL requests (skip static assets)
  ctx.on('request', req => {
    const url = req.url();
    if (!url.match(/\.(js|css|woff2?|png|ico|svg|jpg|gif)(\?|$)/i))
      console.log(`[NET] ${req.method()} ${url}`);
  });

  const page = await ctx.newPage();
  await page.goto('https://engage-support.ibm.com/serviceRequestGrid', {
    waitUntil: 'domcontentloaded', timeout: 60000
  });
  await page.waitForTimeout(5000);
  console.log('[find-dl] Grid loaded. URL:', page.url());

  // Open filter panel
  await page.evaluate(() =>
    document.querySelector('.c4p--datagrid-filter-flyout__trigger')?.click()
  );
  await page.waitForTimeout(2000);
  console.log('[find-dl] Filter panel opened.');

  // Set Status = Closed
  await clickCombo(page,
    'request-status-multiselect-toggle-button',
    'request-status-multiselect-input',
    'Closed');
  console.log('[find-dl] Status set.');

  // Set Squad = NAUS-CFCT-SW-2
  await clickCombo(page,
    'squads-multiselect-toggle-button',
    'squads-multiselect-input',
    'NAUS-CFCT-SW-2');
  console.log('[find-dl] Squad set.');

  // Set Close Date after 01/01/2026
  await page.evaluate(() => {
    const input = document.querySelector('input[placeholder="mm/dd/yyyy"]');
    if (!input) { console.log('no date input'); return; }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '01/01/2026');
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    try { input._flatpickr?.setDate('01/01/2026', true); } catch(e) {}
  });
  await page.waitForTimeout(500);
  console.log('[find-dl] Date set.');

  // Click Apply
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent?.trim() === 'Apply' && b.className.includes('btn--primary'))?.click();
  });
  await page.waitForTimeout(5000);

  const count = await page.evaluate(() => {
    const m = document.body.innerText.match(/of\s+([\d,]+)\s+items?/i);
    return m ? parseInt(m[1].replace(/,/g,''), 10) : 0;
  });
  console.log('[find-dl] Row count:', count);

  // Dump all buttons to find the download one
  const btns = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).map((b, i) => ({
      i,
      text:  b.textContent?.trim().slice(0, 30),
      aria:  b.getAttribute('aria-label'),
      title: b.title,
      svgD:  b.querySelector('path')?.getAttribute('d')?.slice(0, 50),
      cls:   b.className.slice(0, 50),
    })).filter(b => !b.text || b.svgD)
  );
  console.log('\n[find-dl] All icon buttons:');
  btns.forEach(b => console.log(JSON.stringify(b)));

  // Auto-click the download button
  console.log('\n[find-dl] Auto-clicking download button...');
  const dlResult = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button'));
    const byPath = all.find(b => {
      const d = b.querySelector('path')?.getAttribute('d') ?? '';
      return d.startsWith('M13 7') || d.startsWith('M13,7');
    });
    if (byPath) { byPath.click(); return 'clicked-by-path'; }
    // Try clicking ALL icon-only ghost buttons
    const ghostIcons = all.filter(b =>
      b.className.includes('icon-only') && b.className.includes('ghost')
    );
    if (ghostIcons.length > 0) {
      ghostIcons[0].click();
      return `clicked-first-ghost (${ghostIcons.length} found)`;
    }
    return 'not-found';
  });
  console.log('[find-dl] Download click:', dlResult);

  console.log('\n[find-dl] Waiting 20s for network request...');
  await page.waitForTimeout(20000);

  console.log('[find-dl] Done.');
  await browser.close();
}

main().catch(e => { console.error('[find-dl] ERROR:', e.message); process.exit(1); });
