/**
 * scripts/inspect-grid-filters.js
 *
 * Diagnostic: open the EngageSupport serviceRequestGrid, wait for the filter
 * panel to be opened manually, then dump:
 *   1. The filter panel HTML (labels, inputs, buttons)
 *   2. All network requests captured (to find the download endpoint)
 *
 * Usage:
 *   node scripts/inspect-grid-filters.js
 *
 * Instructions:
 *   1. The browser opens to serviceRequestGrid
 *   2. Click the Filter button in the toolbar (funnel icon, top right)
 *   3. Wait — the script will dump the DOM after 8 seconds
 *   4. Also click the Download button so we can capture the URL
 *   5. Check the terminal output for selectors + network URL
 */

require('dotenv/config');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SESSION_PATH = process.env.SESSION_PATH
  ?? path.resolve(__dirname, '../../engagesupport-extractor/session/state.json');

const GRID_URL = 'https://engage-support.ibm.com/serviceRequestGrid';

const networkLog = [];

async function main() {
  console.log('[inspect] Launching browser (non-headless)...');
  const browser = await chromium.launch({ headless: false });
  const ctx     = await browser.newContext();

  // Restore session
  if (fs.existsSync(SESSION_PATH)) {
    const raw = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8'));
    await ctx.addCookies(raw.cookies ?? []);
    console.log('[inspect] Session cookies restored.');
  } else {
    console.warn('[inspect] No session file — you may need to log in manually.');
  }

  // Intercept all network requests to log URLs
  ctx.on('request', (req) => {
    const url = req.url();
    if (url.includes('engage-support') || url.includes('elasticsearch')) {
      networkLog.push({ method: req.method(), url });
    }
  });

  const page = await ctx.newPage();
  await page.goto(GRID_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(4_000);
  console.log('[inspect] Grid loaded. URL:', page.url());

  console.log('\n══════════════════════════════════════════════');
  console.log('ACTION: Click the FILTER button in the toolbar now.');
  console.log('        Then also click the DOWNLOAD button.');
  console.log('        Script will auto-dump in 15 seconds...');
  console.log('══════════════════════════════════════════════\n');

  await page.waitForTimeout(15_000);

  // ── Dump 1: All buttons on the page ─────────────────────────────────────
  const buttons = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).map((b) => ({
      text:       b.textContent?.trim().slice(0, 60),
      title:      b.title,
      ariaLabel:  b.getAttribute('aria-label'),
      class:      b.className.slice(0, 80),
      id:         b.id,
    }))
  );
  console.log('\n─── BUTTONS ON PAGE ──────────────────────────────────────────');
  buttons.forEach((b) => console.log(JSON.stringify(b)));

  // ── Dump 2: Full filter panel HTML ───────────────────────────────────────
  const filterPanelHtml = await page.evaluate(() => {
    // Try common panel containers
    const selectors = [
      '[class*="filter"]',
      '[class*="Filter"]',
      '[role="dialog"]',
      '[class*="panel"]',
      '[class*="sidebar"]',
      '.bx--modal',
      '.bx--table-toolbar',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerHTML.length > 200) return { selector: sel, html: el.outerHTML.slice(0, 8000) };
    }
    return { selector: 'none', html: '' };
  });
  console.log('\n─── FILTER PANEL HTML ────────────────────────────────────────');
  console.log('Matched selector:', filterPanelHtml.selector);
  console.log(filterPanelHtml.html);

  // Save full HTML to file for detailed inspection
  const dumpPath = path.join(__dirname, '../data/grid-filter-panel.html');
  if (filterPanelHtml.html) {
    fs.writeFileSync(dumpPath, filterPanelHtml.html, 'utf-8');
    console.log(`\n[inspect] Full filter HTML saved → ${dumpPath}`);
  }

  // ── Dump 3: All inputs in the filter area ────────────────────────────────
  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input, select')).map((el) => ({
      tag:          el.tagName,
      type:         el.getAttribute('type'),
      id:           el.id,
      name:         el.getAttribute('name'),
      placeholder:  el.getAttribute('placeholder'),
      ariaLabel:    el.getAttribute('aria-label'),
      class:        el.className.slice(0, 80),
      value:        el.value?.slice(0, 30),
      role:         el.getAttribute('role'),
    }))
  );
  console.log('\n─── ALL INPUTS ───────────────────────────────────────────────');
  inputs.forEach((i) => console.log(JSON.stringify(i)));

  // ── Dump 4: All labels ────────────────────────────────────────────────────
  const labels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('label, [class*="label"], .bx--label')).map((l) => ({
      text:  l.textContent?.trim().slice(0, 60),
      for:   l.getAttribute('for'),
      class: l.className.slice(0, 60),
    })).filter((l) => l.text)
  );
  console.log('\n─── ALL LABELS ───────────────────────────────────────────────');
  labels.forEach((l) => console.log(JSON.stringify(l)));

  // ── Dump 5: Network log ───────────────────────────────────────────────────
  console.log('\n─── NETWORK REQUESTS (engage-support + elasticsearch) ────────');
  networkLog.forEach((r) => console.log(`${r.method} ${r.url}`));

  console.log('\n[inspect] Done. Keeping browser open for 30s for manual inspection...');
  await page.waitForTimeout(30_000);
  await browser.close();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
