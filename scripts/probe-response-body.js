/**
 * scripts/probe-response-body.js
 * Prints the raw response from getDetailsSales to understand what the API returns.
 */
'use strict';

require('dotenv').config();
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const SESSION_PATH    = process.env.SESSION_PATH ?? path.resolve(__dirname, '../../engagesupport-extractor/session/state.json');
const SQUAD_GROUP_API = process.env.SQUAD_GROUP_API ?? 'AG SW II';
const IBM_EMAIL       = process.env.IBM_EMAIL ?? '';
const OPDASH_BASE     = 'https://engage-support.ibm.com/OpDashboard';

function httpsGet(url, cookieStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: {
        Cookie: cookieStr, Accept: 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        Referer: OPDASH_BASE + '/',
      },
    }, (res) => {
      console.log('Status:', res.statusCode, res.statusMessage);
      console.log('Content-Type:', res.headers['content-type']);
      console.log('Headers:', JSON.stringify(res.headers, null, 2));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function main() {
  const state = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8'));
  const now = Date.now() / 1000;
  const cookies = (state.cookies ?? []).filter(c =>
    c.domain && (c.domain.includes('engage-support') || c.domain.includes('ibm.com')) &&
    (!c.expires || c.expires < 0 || c.expires > now)
  );
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  // First call /rest/User
  console.log('\n--- /rest/User ---');
  const userBuf = await httpsGet(`${OPDASH_BASE}/rest/User`, cookieStr);
  console.log('Body (first 300 chars):', userBuf.toString().slice(0, 300));

  // Then call getDetailsSales
  const filters = {
    iot: [], tribe: [{ tribe: SQUAD_GROUP_API }], squadOrg: [], center: [],
    majorBrand: [], engOpt: [], channel: [], reqown: [], reqownfm: [],
    org: [], reqStatus: '', reportPeriod: 'Current Year',
    startDate: '', endDate: '', viewName: '', submRole: [],
    ctDay: [], rating: [], painpoint: [], dealdesk: [], programType: [],
    userId: IBM_EMAIL,
  };
  const params = new URLSearchParams({
    field: 'Geo', fieldValue: 'All', filters: JSON.stringify(filters),
    bluegroupAccess: 'false', page: '1', pageSize: '5',
    skip: '0', take: '5', sortby: '', sortorder: '',
  });

  console.log('\n--- getDetailsSales ---');
  const detailsBuf = await httpsGet(`${OPDASH_BASE}/rest/SELLERFDB/getDetailsSales/?${params}`, cookieStr);
  console.log('Body length:', detailsBuf.length);
  console.log('Body (first 800 chars):', detailsBuf.toString().slice(0, 800));
  console.log('Body (last 200 chars):', detailsBuf.toString().slice(-200));
}

main().catch(e => { console.error(e); process.exit(1); });
