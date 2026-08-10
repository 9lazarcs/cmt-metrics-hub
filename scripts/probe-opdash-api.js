/**
 * scripts/probe-opdash-api.js
 *
 * Probes the OpDashboard getDetailsSales endpoint with different filter
 * combinations and prints the response size + first record date range.
 * This helps identify which filter parameter actually controls the date range.
 *
 * Run: node scripts/probe-opdash-api.js
 */
'use strict';

require('dotenv').config();
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const { chromium } = require('playwright');

const SESSION_PATH    = process.env.SESSION_PATH
  ?? path.resolve(__dirname, '../../engagesupport-extractor/session/state.json');
const SQUAD_GROUP_API = process.env.SQUAD_GROUP_API ?? 'AG SW II';
const IBM_EMAIL       = process.env.IBM_EMAIL ?? '';
const OPDASH_BASE     = 'https://engage-support.ibm.com/OpDashboard';
const DETAILS_URL     = `${OPDASH_BASE}/rest/SELLERFDB/getDetailsSales/`;
const USER_URL        = `${OPDASH_BASE}/rest/User`;

function httpsGet(url, cookieStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: {
        Cookie: cookieStr,
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        Referer: OPDASH_BASE + '/',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function probe(cookieStr, label, filters) {
  const params = new URLSearchParams({
    field: 'Geo', fieldValue: 'All', filters: JSON.stringify(filters),
    bluegroupAccess: 'false', page: '1', pageSize: '10',
    skip: '0', take: '10', sortby: '', sortorder: '',
  });
  const body = await httpsGet(`${DETAILS_URL}?${params}`, cookieStr);
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* not JSON */ }

  const totalCount = parsed?.totalCount ?? parsed?.total ?? 'unknown';
  const firstRecord = Array.isArray(parsed?.data) && parsed.data[0]
    ? parsed.data[0]['Rated Date'] ?? parsed.data[0]['ratedDate'] ?? JSON.stringify(Object.keys(parsed.data[0]).slice(0,4))
    : 'n/a';

  console.log(`\n[${label}]`);
  console.log(`  Response: ${body.length} bytes`);
  console.log(`  totalCount: ${totalCount}`);
  console.log(`  First record sample: ${typeof firstRecord === 'string' ? firstRecord.slice(0,80) : JSON.stringify(firstRecord)}`);
  console.log(`  Filters sent: ${JSON.stringify({ reportPeriod: filters.reportPeriod, reqStatus: filters.reqStatus, startDate: filters.startDate, endDate: filters.endDate })}`);
  return totalCount;
}

async function main() {
  // Load session
  const state = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8'));
  const now = Date.now() / 1000;
  const cookies = (state.cookies ?? []).filter(c =>
    c.domain && (c.domain.includes('engage-support') || c.domain.includes('ibm.com')) &&
    (!c.expires || c.expires < 0 || c.expires > now)
  );
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  console.log(`Using ${cookies.length} session cookies`);

  // Step 1: init user session
  console.log('\nInitialising /rest/User...');
  await httpsGet(USER_URL, cookieStr);

  const baseFilters = {
    iot: [], tribe: [{ tribe: SQUAD_GROUP_API }], squadOrg: [], center: [],
    majorBrand: [], engOpt: [], channel: [], reqown: [], reqownfm: [],
    org: [], viewName: '', submRole: [],
    ctDay: [], rating: [], painpoint: [], dealdesk: [], programType: [],
    userId: IBM_EMAIL,
  };

  // Probe 1: Current Year label, empty reqStatus, no dates
  await probe(cookieStr, 'reportPeriod=Current Year, reqStatus=empty', {
    ...baseFilters, reqStatus: '', reportPeriod: 'Current Year', startDate: '', endDate: '',
  });

  // Probe 2: Year to Date label, empty reqStatus
  await probe(cookieStr, 'reportPeriod=Year to Date, reqStatus=empty', {
    ...baseFilters, reqStatus: '', reportPeriod: 'Year to Date', startDate: '', endDate: '',
  });

  // Probe 3: Current Year + explicit 2026 date bounds
  const today = new Date();
  const todayStr = `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}/${today.getFullYear()}`;
  await probe(cookieStr, 'reportPeriod=Current Year + startDate=01/01/2026', {
    ...baseFilters, reqStatus: '', reportPeriod: 'Current Year', startDate: '01/01/2026', endDate: todayStr,
  });

  // Probe 4: No period, just date bounds
  await probe(cookieStr, 'reportPeriod=empty + startDate=01/01/2026', {
    ...baseFilters, reqStatus: '', reportPeriod: '', startDate: '01/01/2026', endDate: todayStr,
  });
}

main().catch(e => { console.error(e); process.exit(1); });
