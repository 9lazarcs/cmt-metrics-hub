/**
 * scripts/capture-es-url.js
 * Captures the full Elasticsearch URL + download URL from the grid.
 */
require('dotenv/config');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SESSION_PATH = process.env.SESSION_PATH
  ?? path.resolve(__dirname, '../../engagesupport-extractor/session/state.json');

async function typeIntoCombobox(page, inputId, value) {
  const toggleId = inputId.replace('-input', '-toggle-button');
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
  const clicked = await page.evaluate(val => {
    for (const opt of document.querySelectorAll('[role="option"], .cds--list-box__menu-item')) {
      if (opt.textContent?.trim() === val) { opt.click(); return true; }
    }
    return false;
  }, value);
  await page.waitForTimeout(400);
  return clicked;
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  if (fs.existsSync(SESSION_PATH)) {
    const raw = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8'));
    await ctx.addCookies(raw.cookies ?? []);
    console.log('[capture] Session restored.');
  }

  const allRequests = [];
  ctx.on('request', req => {
    const url = req.url();
    if (url.includes('elasticsearch') || url.includes('download') || url.includes('export')) {
      allRequests.push({ method: req.method(), url });
      console.log('\n[NET] ' + req.method() + '\n  ' + url + '\n');
    }
  });

  const page = await ctx.newPage();
  await page.goto('https://engage-support.ibm.com/serviceRequestGrid', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  console.log('[capture] Grid loaded.');

  // Open filter
  await page.evaluate(() => document.querySelector('.c4p--datagrid-filter-flyout__trigger')?.click());
  await page.waitForTimeout(2000);

  // Set Status = Closed
  const s = await typeIntoCombobox(page, 'request-status-multiselect-input', 'Closed');
  console.log('[capture] Status set:', s);

  // Set Squad = NAUS-CFCT-SW-2
  const q = await typeIntoCombobox(page, 'squads-multiselect-input', 'NAUS-CFCT-SW-2');
  console.log('[capture] Squad set:', q);

  // Show tags
  const tags = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.cds--tag')).map(t => t.textContent?.trim().replace(/\s+/g,' '))
  );
  console.log('[capture] Selected tags:', tags);

  // Set Close Date after
  await page.evaluate(() => {
    const input = document.querySelector('input[placeholder="mm/dd/yyyy"]');
    if (!input) { console.log('[capture] no date input!'); return; }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '01/01/2026');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
  });
  await page.waitForTimeout(500);

  // Click Apply
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    btns.find(b => b.textContent?.trim() === 'Apply' && b.className.includes('btn--primary'))?.click();
  });
  await page.waitForTimeout(5000);

  const count = await page.evaluate(() => {
    const m = document.body.innerText.match(/of\s+([\d,]+)\s+items?/i);
    return m ? parseInt(m[1].replace(/,/g,''),10) : 0;
  });
  console.log('[capture] Row count after filters:', count);

  // Check active filter tags in the grid toolbar (the filter chips above the table)
  const filterChips = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.cds--tag--filter, [data-testid*="filter"]')).map(t => t.textContent?.trim())
  );
  console.log('[capture] Active filter chips:', filterChips);

  // Dump icon-only buttons to find the download one
  console.log('\n[capture] Looking for download button...');
  const iconBtns = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).map(b => ({
      text: b.textContent?.trim().slice(0,40),
      ariaLabel: b.getAttribute('aria-label'),
      title: b.title,
      class: b.className.slice(0,60),
      svg: b.querySelector('svg') ? b.querySelector('path')?.getAttribute('d')?.slice(0,40) : null,
    })).filter(b => !b.text && (b.ariaLabel || b.title || b.svg))
  );
  console.log('[capture] Icon buttons:');
  iconBtns.forEach(b => console.log(JSON.stringify(b)));

  console.log('\n══════════════════════════════════════════\n');
  console.log('ACTION: Click the DOWNLOAD button in the toolbar now.');
  console.log('        (Top-right, looks like a download arrow icon)');
  console.log('        Waiting 30s...\n');
  console.log('══════════════════════════════════════════\n');

  await page.waitForTimeout(30000);
  await browser.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
