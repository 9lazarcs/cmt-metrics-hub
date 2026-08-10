/**
 * src/automation/npsExtractor.ts
 *
 * NPS Export via Playwright UI automation.
 *
 * CONFIRMED FLOW (verified live Aug 2026, ground truth: 732 rows, Current Year):
 *
 *   1. Navigate to #/sellerFeedback
 *   2. Set Time Period  → radio input[id="<period>"] inside .popup-filter.reportPeriod
 *   3. Set Squad Group  → jsTree node id="tribe_AG SW II" > expand > click NAUS-CFCT-SW-2
 *   4. Click Update     → button.update-btn  (ng-click="sendPost()")
 *   5. Wait ~8s for data to reload
 *   6. Navigate to      → #/detailsSalesTree?field=Geo&fieldValue=All&level=1&levone=empty&levtwo=empty
 *      (this is the "732 All" total link in the By Geo table — carries the session filter state)
 *   7. Wait for row count to appear
 *   8. Intercept ExcelExport response, then click Export button  (button.export-btn, ng-click="detailsSalesExcel()")
 *   9. Post-filter rows to exact Squad="NAUS-CFCT-SW-2" and save
 *
 * KEY FACTS:
 *   - The API filters JSON is IGNORED for date scoping — only the browser session state matters
 *   - Time Period radio ids: "Current Year", "Current Month", "Current Quarter",
 *     "Previous Month", "Previous Quarter", "Previous Year", "Today", "Custom Date Range"
 *   - Squad jsTree node: id="tribe_AG SW II" (contains NAUS-CFCT-SW-2 as a child)
 *   - Row count after correct filtering: ~732 (Current Year, NAUS-CFCT-SW-2)
 *
 * .env keys:
 *   SQUAD_GROUP     = NAUS-CFCT-SW-2   individual squad (post-filter)
 *   SQUAD_GROUP_API = AG SW II          jsTree parent node name
 */

import * as path from 'path';
import * as fs from 'fs';
import { chromium, type Route } from 'playwright';
import { logger } from '../utils/logger';
import { ensureAuthenticated } from './ibmAuth';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const OPDASH_BASE    = 'https://engage-support.ibm.com/OpDashboard';
const SUMMARY_URL    = `${OPDASH_BASE}/#/sellerFeedback`;
const DETAIL_URL     = `${OPDASH_BASE}/#/detailsSalesTree?field=Geo&fieldValue=All&level=1&levone=empty&levtwo=empty`;

const SESSION_PATH = process.env.SESSION_PATH ?? (() => {
  const phase1 = path.resolve(process.cwd(), '../engagesupport-extractor/session/state.json');
  return fs.existsSync(phase1) ? phase1 : path.resolve(process.cwd(), 'session/state.json');
})();

const OUTPUT_DIR      = process.env.OUTPUT_DIR     ?? path.resolve(process.cwd(), 'data/downloads');
const HEADLESS        = process.env.HEADLESS !== 'false';
const SQUAD_NAME      = process.env.SQUAD_GROUP    ?? 'NAUS-CFCT-SW-2';
const SQUAD_GROUP_API = process.env.SQUAD_GROUP_API ?? 'AG SW II';

// Exact radio input id values in the Time Period popup
// Confirmed from live DOM inspection of .popup-filter.reportPeriod
const PERIOD_MAP: Record<string, string> = {
  '':       'Current Year',
  'YTD':    'Current Year',
  'MTD':    'Current Month',
  'QTD':    'Current Quarter',
  'PREV-M': 'Previous Month',
  'PREV-Q': 'Previous Quarter',
  'PREV-Y': 'Previous Year',
  'TODAY':  'Today',
};

export interface NpsExtractResult {
  success: boolean;
  filePath?: string;
  filename?: string;
  rowCount?: number;
  error?: string;
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────
export async function extractNpsExport(reportPeriod?: string): Promise<NpsExtractResult> {
  const start = Date.now();
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const normalized  = (reportPeriod ?? '').trim().toUpperCase();
  const periodLabel = PERIOD_MAP[normalized] ?? 'Current Year';
  logger.info(`[npsExtractor] UI extraction — Squad: ${SQUAD_NAME}, Period: ${periodLabel}`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const ctx = await browser.newContext({ acceptDownloads: true });

    // ── Step 1: Ensure valid IBM SSO session ─────────────────────────────────
    await ensureAuthenticated(ctx, SESSION_PATH);
    logger.info('[npsExtractor] Session confirmed valid.');

    const page = await ctx.newPage();

    // ── Step 2: Navigate to sellerFeedback summary ───────────────────────────
    logger.info('[npsExtractor] Loading Sales Engagement Feedback summary...');
    await page.goto(SUMMARY_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.locator('button.update-btn').waitFor({ state: 'visible', timeout: 45_000 });
    logger.info('[npsExtractor] Summary page ready.');

    // ── Step 3: Set Time Period ──────────────────────────────────────────────
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('div.filter-box[ng-click*="reportPeriod"]')?.click();
    });
    await page.waitForTimeout(500);
    const periodSet = await page.evaluate((label) => {
      const input = document.querySelector<HTMLInputElement>(
        `.popup-filter.reportPeriod input[type="radio"][id="${label}"]`
      );
      if (input) { input.click(); return true; }
      return false;
    }, periodLabel);
    await page.evaluate(() => { document.querySelector<HTMLElement>('.pop-overlay')?.click(); });
    await page.waitForTimeout(300);
    if (!periodSet) throw new Error(`Period "${periodLabel}" not found in Time Period dropdown`);
    logger.info(`[npsExtractor] Time Period set to "${periodLabel}".`);

    // ── Step 4: Set Squad (tribe jsTree) ─────────────────────────────────────
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('div.filter-box[ng-click*="tribe"]')?.click();
    });
    await page.waitForTimeout(2_000);

    // Expand the squad group node
    await page.evaluate((group) => {
      const node = Array.from(document.querySelectorAll<HTMLElement>('#tribe-jstree li[role="treeitem"]'))
        .find(li => li.id === `tribe_${group}`);
      node?.querySelector<HTMLElement>('i.jstree-ocl')?.click();
    }, SQUAD_GROUP_API);
    await page.waitForTimeout(1_500);

    // Click the individual squad node
    const squadClicked = await page.evaluate((sq) => {
      const anchor = Array.from(document.querySelectorAll<HTMLElement>('#tribe-jstree a.jstree-anchor'))
        .find(a => a.textContent?.trim() === sq);
      if (anchor) { anchor.click(); return true; }
      return false;
    }, SQUAD_NAME);
    await page.evaluate(() => { document.querySelector<HTMLElement>('.pop-overlay')?.click(); });
    await page.waitForTimeout(300);
    if (!squadClicked) logger.warn(`[npsExtractor] Squad "${SQUAD_NAME}" not found in tree — proceeding without squad filter`);
    else logger.info(`[npsExtractor] Squad set to "${SQUAD_NAME}".`);

    // ── Step 5: Click Update, wait for data ──────────────────────────────────
    await page.locator('button.update-btn').click();
    await page.waitForTimeout(8_000);
    logger.info('[npsExtractor] Filters applied.');

    // ── Step 6: Set up ExcelExport interceptor ───────────────────────────────
    let xlsxResolve!: (b: Buffer) => void;
    let xlsxReject!:  (e: Error)  => void;
    const xlsxPromise = new Promise<Buffer>((res, rej) => { xlsxResolve = res; xlsxReject = rej; });

    await page.route('**/OpDashboard/rest/ExcelExport**', async (route: Route) => {
      logger.info('[npsExtractor] ExcelExport intercepted — downloading...');
      const response = await route.fetch();
      const body     = await response.body();
      logger.info(`[npsExtractor] Raw XLSX received: ${body.length.toLocaleString()} bytes`);
      xlsxResolve(body);
      await route.fulfill({ response });
    });

    // ── Step 7: Navigate to detail page (carries session filter state) ───────
    logger.info('[npsExtractor] Navigating to Detail page...');
    await page.goto(DETAIL_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(4_000);

    const rowCount = await page.evaluate(() =>
      parseInt((document.body.innerText.match(/Row count:\s*([\d,]+)/)?.[1] ?? '0').replace(/,/g, ''), 10)
    );
    logger.info(`[npsExtractor] Detail page row count: ${rowCount}`);
    if (rowCount === 0) throw new Error('Detail page shows 0 rows — filters may not have carried over');

    // ── Step 8: Click Export ──────────────────────────────────────────────────
    logger.info('[npsExtractor] Clicking Export...');
    await page.locator('button.export-btn').click();

    // Wait for intercepted XLSX (up to 3 minutes)
    const rawBuffer = await Promise.race([
      xlsxPromise,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('ExcelExport timed out after 180s')), 180_000)
      ),
    ]);

    // Save session cookies
    await ctx.storageState({ path: SESSION_PATH });

    // ── Step 9: Post-filter to exact squad ───────────────────────────────────
    const { filteredBuffer, filteredCount, totalRows } = filterXlsxToSquad(rawBuffer, SQUAD_NAME);
    logger.info(`[npsExtractor] Filtered: ${filteredCount}/${totalRows} rows for Squad="${SQUAD_NAME}"`);

    if (filteredCount === 0) {
      throw new Error(
        `No rows found for Squad="${SQUAD_NAME}" after filtering ${totalRows} total rows.`
      );
    }

    // ── Step 10: Save ─────────────────────────────────────────────────────────
    const timestamp = new Date().toISOString().replace(/[:.]/g, '_');
    const filename  = `nps_export_${timestamp}.xlsx`;
    const filePath  = path.join(OUTPUT_DIR, filename);
    fs.writeFileSync(filePath, filteredBuffer);
    logger.info(`[npsExtractor] ✅ Saved: ${filename} (${filteredCount} rows, ${Date.now() - start}ms)`);

    return { success: true, filePath, filename, rowCount: filteredCount, durationMs: Date.now() - start };

  } catch (err) {
    const error = (err as Error).message;
    logger.error(`[npsExtractor] FAILED: ${error}`);
    return { success: false, error, durationMs: Date.now() - start };
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-filter: keep only rows where Squad === squadName
// ─────────────────────────────────────────────────────────────────────────────
function filterXlsxToSquad(
  rawBuffer: Buffer,
  squadName: string
): { filteredBuffer: Buffer; filteredCount: number; totalRows: number } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const XLSX = require('xlsx') as typeof import('xlsx');
  const wb       = XLSX.read(rawBuffer, { type: 'buffer' });
  const wsName   = wb.SheetNames[0];
  const allRows  = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wsName], { defval: '' });
  const filtered = allRows.filter(r => r['Squad'] === squadName);
  const newWs    = XLSX.utils.json_to_sheet(filtered);
  const newWb    = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(newWb, newWs, wsName);
  const filteredBuffer = Buffer.from(XLSX.write(newWb, { type: 'buffer', bookType: 'xlsx' }));
  return { filteredBuffer, filteredCount: filtered.length, totalRows: allRows.length };
}
