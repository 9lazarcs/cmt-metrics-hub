/**
 * src/automation/requestViewExtractor.ts
 *
 * Extracts closed EngageSupport requests for NAUS-CFCT-SW-2 via direct
 * Elasticsearch API calls — no browser UI automation.
 *
 * CONFIRMED from live network inspection (Aug 2026):
 *
 *   Count / page endpoint:
 *     GET https://engage-support.ibm.com/elasticsearch/services/search
 *       ?query=true&page=1&size=N&q=QUERY&filterType=entitled&includeDraft=true
 *
 *   Download (same endpoint, size=1000):
 *     The "download" button just fires this with size=1000.
 *     Response is JSON: { hits: { total: { value: N }, hits: [...] } }
 *     Each hit._source contains the request fields.
 *
 *   Auth: IBM SSO cookies from SESSION_PATH (Playwright storageState JSON).
 *         We open a headless browser ONCE just to validate/refresh the session,
 *         then extract cookies and use them for all subsequent fetch() calls.
 *
 *   Query structure (URL-encoded, confirmed from live capture):
 *     ((blockedBy:"" OR NOT _exists_:blockedBy))
 *     AND (status.keyword:"Closed")
 *     AND (squadName.keyword:"NAUS-CFCT-SW-2")
 *     AND (closeDate:>AFTER_DATE AND closeDate:<=BEFORE_DATE)
 *     AND (dataRestriction:"")
 *
 *   Date filter is EXCLUSIVE on the lower bound (>) so:
 *     after  = startDate − 1 day
 *     before = endDate
 *
 *   Export limit: 1000 rows per request.
 *   Chunking: binary-search date ranges so each chunk ≤ 900 rows.
 *
 * Period shortcuts:
 *   MTD  = 1st of current month → today
 *   QTD  = 1st of current quarter → today
 *   YTD  = Jan 1 of current year → today
 *   custom "YYYY-MM-DD:YYYY-MM-DD"
 */

import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import { chromium } from 'playwright';
import * as XLSX from 'xlsx';
import { logger } from '../utils/logger';
import { ensureAuthenticated } from './ibmAuth';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const ES_BASE      = 'https://engage-support.ibm.com/elasticsearch/services/search';
const GRID_URL     = 'https://engage-support.ibm.com/serviceRequestGrid';
const SESSION_PATH = process.env.SESSION_PATH ?? (() => {
  const p = path.resolve(process.cwd(), '../engagesupport-extractor/session/state.json');
  return fs.existsSync(p) ? p : path.resolve(process.cwd(), 'session/state.json');
})();
const OUTPUT_DIR  = process.env.OUTPUT_DIR ?? path.resolve(process.cwd(), 'data/downloads');
const HEADLESS    = process.env.HEADLESS !== 'false';
const SQUAD_NAME  = process.env.SQUAD_GROUP ?? 'NAUS-CFCT-SW-2';
const PAGE_SIZE   = 1000; // max the API allows
const CHUNK_MAX   = 900;  // stay under the 1000 cap

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────
export interface RvExtractResult {
  success:    boolean;
  filePath?:  string;
  filename?:  string;
  rowCount?:  number;
  chunks?:    number;
  error?:     string;
  durationMs: number;
}

export interface RvProgressEvent {
  type:          'session' | 'count' | 'chunk' | 'done';
  message:       string;
  rowsFetched?:  number;
  totalRows?:    number;
  chunkIndex?:   number;
  chunkTotal?:   number;   // estimated — may increase if binary search adds more chunks
}

export type RvProgressCallback = (evt: RvProgressEvent) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers
// ─────────────────────────────────────────────────────────────────────────────
function today(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function resolvePeriod(period?: string): { startDate: Date; endDate: Date } {
  const t    = today();
  const norm = (period ?? 'YTD').trim().toUpperCase();
  if (norm === 'MTD') return { startDate: new Date(t.getFullYear(), t.getMonth(), 1), endDate: t };
  if (norm === 'QTD') return { startDate: new Date(t.getFullYear(), Math.floor(t.getMonth() / 3) * 3, 1), endDate: t };
  if (norm === 'YTD') return { startDate: new Date(t.getFullYear(), 0, 1), endDate: t };
  if (norm === 'PREV-M') {
    const pm = new Date(t.getFullYear(), t.getMonth() - 1, 1);
    return { startDate: pm, endDate: addDays(new Date(t.getFullYear(), t.getMonth(), 1), -1) };
  }
  if (norm === 'PREV-Q') {
    const curQ  = Math.floor(t.getMonth() / 3);
    const prevQ = curQ === 0 ? 3 : curQ - 1;
    const prevY = curQ === 0 ? t.getFullYear() - 1 : t.getFullYear();
    const qs = new Date(prevY, prevQ * 3, 1);
    const qe = addDays(new Date(t.getFullYear(), Math.floor(t.getMonth() / 3) * 3, 1), -1);
    return { startDate: qs, endDate: qe };
  }
  if (norm === 'PREV-Y') {
    const py = t.getFullYear() - 1;
    return { startDate: new Date(py, 0, 1), endDate: new Date(py, 11, 31) };
  }
  const parts = norm.split(':');
  if (parts.length === 2) {
    const s = new Date(parts[0]);
    const e = new Date(parts[1]);
    if (!isNaN(s.getTime()) && !isNaN(e.getTime())) return { startDate: s, endDate: e };
  }
  logger.warn(`[rvExtractor] Unknown period "${period}" — using YTD`);
  return { startDate: new Date(t.getFullYear(), 0, 1), endDate: t };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session: extract cookies from Playwright storageState for use in fetch()
// ─────────────────────────────────────────────────────────────────────────────
interface PlCookie { name: string; value: string; domain: string }

function loadSessionCookies(): PlCookie[] {
  if (!fs.existsSync(SESSION_PATH)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8'));
    return (raw.cookies ?? []) as PlCookie[];
  } catch {
    return [];
  }
}

function cookieHeader(cookies: PlCookie[]): string {
  return cookies
    .filter(c => c.domain.includes('engage-support') || c.domain.includes('ibm.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Elasticsearch API helpers (pure HTTP — no browser)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the already-URL-encoded q= value for the ES search API.
 * The query string is pre-encoded exactly as the browser sends it (confirmed from
 * live network capture). We substitute dates and squad name at the right positions.
 */
function buildQuery(squad: string, afterDate: Date, beforeDate: Date): string {
  const after  = toYMD(afterDate);
  const before = toYMD(beforeDate);
  const sq     = encodeURIComponent(squad); // e.g. NAUS-CFCT-SW-2 → NAUS-CFCT-SW-2 (no special chars)
  // Literal pre-encoded query — exactly as captured from the browser's network tab
  return (
    `((request.generalInformation.blockedBy.keyword%3A%22%22)` +
    `%20OR%20(NOT(_exists_%3Arequest.generalInformation.blockedBy)))` +
    `%20AND%20(((request.generalInformation.status.keyword%3A%22Closed%22))` +
    `%20AND%20((request.generalInformation.squadName.keyword%3A%22${sq}%22))` +
    `%20AND%20((request.generalInformation.closeDate%3A%3E${after}` +
    `%20AND%20request.generalInformation.closeDate%3A%3C%3D${before})))` +
    `%20AND%20(((request.generalInformation.dataRestriction%3A%22%22)))`
  );
}

/** Thin Node.js https.get wrapper that returns parsed JSON */
function httpsGet(url: string, cookieStr: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Cookie':       cookieStr,
        'Accept':       'application/json',
        'User-Agent':   'Mozilla/5.0',
        'Referer':      GRID_URL,
        'Origin':       'https://engage-support.ibm.com',
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch (e) {
          reject(new Error(`JSON parse error (status ${res.statusCode}): ${Buffer.concat(chunks).toString().slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(60_000, () => { req.destroy(new Error('Request timed out')); });
  });
}

/**
 * Count rows for a date range.
 * Response structure (confirmed live): { count: N, seconds: N, relation: "Eq", hits: [...] }
 * The total is the top-level "count" field — NOT hits.total.
 */
async function countRows(cookieStr: string, squad: string, afterDate: Date, beforeDate: Date): Promise<number> {
  const q    = buildQuery(squad, afterDate, beforeDate);
  const url  = `${ES_BASE}?query=true&page=1&size=1&q=${q}&filterType=entitled&includeDraft=true`;
  const data = await httpsGet(url, cookieStr) as any;
  return typeof data?.count === 'number' ? data.count : 0;
}

/**
 * Fetch up to PAGE_SIZE rows for a date range.
 * Response hits are directly in data.hits (array), not data.hits.hits.
 */
async function fetchChunk(cookieStr: string, squad: string, afterDate: Date, beforeDate: Date): Promise<Record<string, unknown>[]> {
  const q    = buildQuery(squad, afterDate, beforeDate);
  const url  = `${ES_BASE}?query=true&page=1&size=${PAGE_SIZE}&q=${q}&filterType=entitled&includeDraft=true&sortBy=request.generalInformation.submitDate&order=desc`;
  const data = await httpsGet(url, cookieStr) as any;
  // hits is a flat array of objects with { id, request, ... } — no _source wrapper
  const hits: any[] = Array.isArray(data?.hits) ? data.hits : [];
  return hits.map((h: any) => flattenSource(h));
}

/**
 * Flatten the nested ES _source into the flat column format that matches
 * what the XLSX export produces (same column names as parseRequestView expects).
 */
/**
 * Flatten a raw ES hit (root-level object with { id, request: { generalInformation, ... } })
 * into the flat column format expected by parseRequestView / ingestRequestView.
 * Field paths confirmed from live API response (Aug 2026).
 */
function flattenSource(hit: any): Record<string, unknown> {
  const src = hit.request ?? hit;       // handle both {request:{...}} and flat _source
  const g  = src.generalInformation ?? {};
  const sv = src.services ?? {};
  const sh = src.shw ?? {};
  const tl = src.tls ?? {};
  return {
    'Request number':                 g.requestIdAlias     ?? g.id ?? hit.id ?? '',
    'Request type':                   g.requestType        ?? '',
    'Accelerate':                     g.generic            ?? '',
    'Status':                         g.status             ?? '',
    'Customer number':                g.customerNumber     ?? '',
    'Customer name':                  g.customerName       ?? '',
    'Squad Group Name':               g.tribeName          ?? '',
    'Squad Id':                       g.squadId            ?? '',
    'Squad Name':                     g.squadName          ?? '',
    'Request Title':                  g.title              ?? '',
    'Request Comment':                g.description        ?? '',
    'Submitter':                      g.submitterId        ?? '',
    'Last Comment':                   g.lastCommentText    ?? '',
    'Requester':                      g.requestedByNotesId ?? '',
    'Latest Update':                  g.updateDate         ?? '',
    'Submission Date':                g.submitDate         ?? '',
    'Assign to':                      g.bidManagerId       ?? '',
    'Needed by':                      g.dueDate            ?? '',
    'Close Date':                     g.closeDate          ?? '',
    'Opportunity #':                  g.opportunityNumber  ?? '',
    'Market':                         g.market             ?? '',
    'Country':                        g.country            ?? '',
    'Unit':                           g.unit               ?? '',
    'Sub-unit':                       g.subUnit            ?? '',
    'Channel':                        g.channel            ?? '',
    'Deal Desk':                      g.dealDesk           ?? '',
    'Currency':                       g.currencyCode       ?? '',
    'TCV/Billing amount':             g.tcv                ?? '',
    'GEO':                            g.geo                ?? '',
    'Pending Reason Code':            g.reasonCancellation ?? '',
    'Enterprise Number':              g.enterpriseNumber   ?? '',
    'GBG':                            g.globalBuyingGroup  ?? '',
    'Engagement Number':              g.engagementId       ?? '',
    'Multi-unit?':                    g.multiunit          ?? '',
    'Assign to Organization':         g.organization       ?? '',
    'Requester id':                   g.requestedBy        ?? '',
    'Opp. description':               g.opportunityDescription ?? '',
    'Sector':                         g.sector             ?? '',
    'Program Type':                   g.programType        ?? '',
    'BlueGroup':                      g.groupAssigned      ?? '',
    'Source':                         g.source             ?? '',
    'External Request Number':        g.externalRequestId  ?? '',
    'Contract type (Services)':       sv.contractType      ?? '',
    'Contract number (Services)':     sv.cefContractNumber ?? '',
    'Work number (Services)':         sv.wbsnumber         ?? '',
    'Legal contract number (Services)': sv.contractNumber  ?? '',
    'Billing type (Services)':        sv.billingtyperequest ?? '',
    'System invoice number (Services)': sv.systemInvoiceNumbers ?? '',
    'Custom invoice number (Services)': sv.custominvoicenumber ?? '',
    'Change types (Services)':        sv.changetypes       ?? '',
    'Segment (Services)':             sv.segment           ?? '',
    'Sub segment (Services)':         sv.subsegment        ?? '',
    'Division (Services)':            sv.division          ?? '',
    'BP request reference (SHW)':     sh.bpPORequestReference ?? '',
    'Install at Customer Name (SHW)': sh.customerInstallName  ?? '',
    'Order Number (SHW)':             sh.masterOrderNo     ?? '',
    'Alteration Type (SHW)':          sh.alterations       ?? '',
    'Type of inventory update (SHW)': sh.subRequestType    ?? '',
    'Request sub-type (TLS)':         tl.subType           ?? '',
    'Contract Number (TLS)':          tl.contractNumberTls ?? '',
    'BP Name (TLS)':                  tl.bpCustName        ?? '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// XLSX builder from row objects
// ─────────────────────────────────────────────────────────────────────────────
function rowsToXlsx(rows: Record<string, unknown>[]): Buffer {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Request View');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Session refresh: open browser once just to validate/refresh cookies
// ─────────────────────────────────────────────────────────────────────────────
async function refreshSession(): Promise<void> {
  const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext();
    await ensureAuthenticated(ctx, SESSION_PATH);
    await ctx.storageState({ path: SESSION_PATH });
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────
export async function extractRequestView(
  period?: string,
  onProgress?: RvProgressCallback,
): Promise<RvExtractResult> {
  const start = Date.now();
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const { startDate, endDate } = resolvePeriod(period);
  logger.info(`[rvExtractor] Period: ${toYMD(startDate)} → ${toYMD(endDate)} (${period ?? 'YTD'})`);

  try {
    // ── Step 1: Ensure session is valid (browser opens once, then closes) ─────
    logger.info('[rvExtractor] Validating IBM session...');
    onProgress?.({ type: 'session', message: 'Validating IBM session…' });
    await refreshSession();
    logger.info('[rvExtractor] Session valid. Extracting via API...');
    onProgress?.({ type: 'session', message: 'Session valid — starting extraction' });

    const cookies   = loadSessionCookies();
    const cookieStr = cookieHeader(cookies);
    if (!cookieStr) throw new Error('No valid session cookies found after authentication');

    // afterDate is exclusive (>), so subtract one day from startDate
    const esAfter = addDays(startDate, -1);

    // ── Step 2: Count total rows ──────────────────────────────────────────────
    const total = await countRows(cookieStr, SQUAD_NAME, esAfter, endDate);
    logger.info(`[rvExtractor] Total rows for period: ${total}`);
    onProgress?.({ type: 'count', message: `Found ${total.toLocaleString()} closed requests`, totalRows: total, rowsFetched: 0 });

    if (total === 0) {
      throw new Error(`No closed requests found for ${SQUAD_NAME} between ${toYMD(startDate)} and ${toYMD(endDate)}`);
    }

    // ── Step 3: Fetch all rows (chunked if > CHUNK_MAX) ───────────────────────
    const allRows: Record<string, unknown>[] = [];
    let chunkCount = 0;

    if (total <= CHUNK_MAX) {
      // Single fetch
      logger.info('[rvExtractor] Single fetch (within limit)...');
      onProgress?.({ type: 'chunk', message: 'Fetching all rows (single request)…', rowsFetched: 0, totalRows: total, chunkIndex: 1, chunkTotal: 1 });
      const rows = await fetchChunk(cookieStr, SQUAD_NAME, esAfter, endDate);
      allRows.push(...rows);
      chunkCount = 1;
      onProgress?.({ type: 'chunk', message: `Chunk 1/1 done — ${rows.length} rows fetched`, rowsFetched: allRows.length, totalRows: total, chunkIndex: 1, chunkTotal: 1 });

    } else {
      // Date-chunk: binary-search date sub-ranges so each chunk ≤ CHUNK_MAX
      logger.info(`[rvExtractor] ${total} rows > ${CHUNK_MAX} — chunking by date...`);
      let chunkStart = new Date(startDate);

      while (chunkStart <= endDate) {
        const remAfter  = addDays(chunkStart, -1);
        const remaining = await countRows(cookieStr, SQUAD_NAME, remAfter, endDate);

        if (remaining <= CHUNK_MAX) {
          // Everything left fits in one fetch
          chunkCount++;
          const chunkMsg = `Chunk ${chunkCount}: ${toYMD(chunkStart)}→${toYMD(endDate)} (${remaining} rows)`;
          logger.info(`[rvExtractor] ${chunkMsg}`);
          onProgress?.({ type: 'chunk', message: chunkMsg, rowsFetched: allRows.length, totalRows: total, chunkIndex: chunkCount });
          const rows = await fetchChunk(cookieStr, SQUAD_NAME, remAfter, endDate);
          allRows.push(...rows);
          onProgress?.({ type: 'chunk', message: `Chunk ${chunkCount} done — ${allRows.length}/${total} rows fetched`, rowsFetched: allRows.length, totalRows: total, chunkIndex: chunkCount });
          break;
        }

        // Binary-search for the largest end date where count ≤ CHUNK_MAX
        let lo       = new Date(chunkStart);
        let hi       = new Date(endDate);
        let chunkEnd = new Date(chunkStart); // fallback: single day
        let iters    = 0;

        while (lo <= hi && iters < 25) {
          iters++;
          const mid = new Date((lo.getTime() + hi.getTime()) / 2);
          mid.setHours(0, 0, 0, 0);
          const cnt = await countRows(cookieStr, SQUAD_NAME, addDays(chunkStart, -1), mid);
          logger.info(`[rvExtractor]   Probe ${toYMD(chunkStart)}→${toYMD(mid)}: ${cnt} rows`);
          if (cnt <= CHUNK_MAX) { chunkEnd = new Date(mid); lo = addDays(mid, 1); }
          else                  { hi = addDays(mid, -1); }
        }

        chunkCount++;
        const chunkMsg = `Chunk ${chunkCount}: ${toYMD(chunkStart)}→${toYMD(chunkEnd)}`;
        logger.info(`[rvExtractor] ${chunkMsg}`);
        onProgress?.({ type: 'chunk', message: chunkMsg, rowsFetched: allRows.length, totalRows: total, chunkIndex: chunkCount });
        const rows = await fetchChunk(cookieStr, SQUAD_NAME, addDays(chunkStart, -1), chunkEnd);
        allRows.push(...rows);
        onProgress?.({ type: 'chunk', message: `Chunk ${chunkCount} done — ${allRows.length}/${total} rows fetched`, rowsFetched: allRows.length, totalRows: total, chunkIndex: chunkCount });
        chunkStart = addDays(chunkEnd, 1);
      }
    }

    logger.info(`[rvExtractor] Fetched ${allRows.length} rows across ${chunkCount} chunk(s)`);
    onProgress?.({ type: 'done', message: `Fetched ${allRows.length} rows across ${chunkCount} chunk(s) — saving XLSX…`, rowsFetched: allRows.length, totalRows: total, chunkIndex: chunkCount, chunkTotal: chunkCount });

    // ── Step 4: Save as XLSX ──────────────────────────────────────────────────
    const buffer   = rowsToXlsx(allRows);
    const ts       = new Date().toISOString().replace(/[:.]/g, '_');
    const filename = `request_view_${ts}.xlsx`;
    const filePath = path.join(OUTPUT_DIR, filename);
    fs.writeFileSync(filePath, buffer);

    logger.info(`[rvExtractor] ✅ Saved: ${filename} (${allRows.length} rows, ${chunkCount} chunk(s), ${Date.now() - start}ms)`);
    return {
      success:    true,
      filePath,
      filename,
      rowCount:   allRows.length,
      chunks:     chunkCount,
      durationMs: Date.now() - start,
    };

  } catch (err) {
    const error = (err as Error).message;
    logger.error(`[rvExtractor] FAILED: ${error}`);
    return { success: false, error, durationMs: Date.now() - start };
  }
}
