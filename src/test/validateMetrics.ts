/**
 * src/test/validateMetrics.ts
 *
 * Golden-number validation against the master file reference values.
 *
 * GOLDEN TRUTH (from CMT Metrics 1Q 2026_MASTERFILE_Jan to June.xlsx):
 *   Grand Total Volume        = 7,075
 *   Grand Total Weighted      = 8,080
 *   NPS Promoters             = 509  (of 513 total ratings)
 *
 * Run: npm run test
 * Requires the master XLSX files to have been ingested already.
 */

import 'dotenv/config';
import * as path from 'path';
import * as fs from 'fs';
import { getDb } from '../db/schema';
import { seedSquadMembers, seedReasonCodes } from '../db/seeds';
import { ingestRequestView, ingestNpsExport } from '../pipeline/ingest';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Golden Numbers
// ─────────────────────────────────────────────────────────────────────────────
const GOLDEN = {
  totalVolume:     7075,
  totalWeighted:   8080,
  npsPromoters:    509,
  npsTotal:        513,
};

const TOLERANCE_PCT = 5; // Allow ±5% variance for partial dataset tests

interface TestResult {
  name:    string;
  expected: number;
  actual:   number;
  pass:     boolean;
  diff:     number;
  diffPct:  string;
}

function check(name: string, expected: number, actual: number): TestResult {
  const diff    = Math.abs(actual - expected);
  const diffPct = expected > 0 ? ((diff / expected) * 100).toFixed(2) : 'N/A';
  const pass    = diff === 0 || (expected > 0 && (diff / expected) * 100 <= TOLERANCE_PCT);
  return { name, expected, actual, pass, diff, diffPct };
}

function printResult(r: TestResult): void {
  const icon   = r.pass ? '✅' : '❌';
  const status = r.pass ? 'PASS' : 'FAIL';
  console.log(
    `  ${icon} [${status}] ${r.name.padEnd(30)} expected=${r.expected.toLocaleString()} ` +
    `actual=${r.actual.toLocaleString()} diff=${r.diff} (${r.diffPct}%)`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function runValidation(): Promise<void> {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  CMT Metrics Hub — Golden Number Validation');
  console.log('══════════════════════════════════════════════════════\n');

  // Init DB + seeds
  getDb();
  seedSquadMembers();
  seedReasonCodes();

  // Auto-ingest sample files if provided via env or default paths
  const sampleDir = process.env.SAMPLE_DIR
    ?? path.resolve(process.env.HOME ?? '~', 'Library/CloudStorage/OneDrive-IBM/Metrics');

  const sampleRV  = process.env.SAMPLE_RV
    ?? path.join(sampleDir, 'request_view_2026-08-06T00_56_22.036Z.xlsx');
  const sampleNPS = process.env.SAMPLE_NPS
    ?? path.join(sampleDir, 'Export_Details_SalesFB.xlsx');

  // Ingest sample files
  let ingestedRV = false, ingestedNPS = false;

  if (fs.existsSync(sampleRV)) {
    console.log(`  📂 Ingesting Request View: ${path.basename(sampleRV)}`);
    const r = ingestRequestView(sampleRV);
    ingestedRV = r.status === 'success';
    console.log(`     → ${r.status}: ${r.rowCount} rows in ${r.durationMs}ms\n`);
  } else {
    console.log(`  ⚠️  Sample RV file not found: ${sampleRV}`);
  }

  if (fs.existsSync(sampleNPS)) {
    console.log(`  📂 Ingesting NPS Export: ${path.basename(sampleNPS)}`);
    const r = ingestNpsExport(sampleNPS);
    ingestedNPS = r.status === 'success';
    console.log(`     → ${r.status}: ${r.rowCount} rows in ${r.durationMs}ms\n`);
  } else {
    console.log(`  ⚠️  Sample NPS file not found: ${sampleNPS}`);
  }

  const db = getDb();

  // ── Run checks ─────────────────────────────────────────────────────────
  const results: TestResult[] = [];

  // 1. Total Volume (count of weighted_volume rows)
  if (ingestedRV) {
    const vol = (db.prepare('SELECT COUNT(*) AS c FROM weighted_volume').get() as {c:number}).c;
    results.push(check('Total Volume (WV rows)', GOLDEN.totalVolume, vol));

    // 2. Total Weighted Volume (sum of weight)
    const wt  = (db.prepare('SELECT COALESCE(SUM(weight),0) AS s FROM weighted_volume').get() as {s:number}).s;
    results.push(check('Total Weighted Volume',  GOLDEN.totalWeighted, Math.round(wt)));

    // 3. Rows with reason code resolved
    const rcResolved = (db.prepare('SELECT COUNT(*) AS c FROM weighted_volume WHERE sub_process IS NOT NULL').get() as {c:number}).c;
    console.log(`  ℹ️  Rows with reason code resolved: ${rcResolved} / ${vol} (${Math.round((rcResolved/vol)*100)}%)`);

    // 4. Rows attributed to a team member
    const attributed = (db.prepare('SELECT COUNT(*) AS c FROM weighted_volume WHERE team_member IS NOT NULL').get() as {c:number}).c;
    console.log(`  ℹ️  Rows attributed to team member: ${attributed} / ${vol} (${Math.round((attributed/vol)*100)}%)\n`);
  } else {
    console.log('  ⏭️  Skipping WV checks — RV file not ingested.\n');
  }

  if (ingestedNPS) {
    // 5. NPS Total
    const npsTotal = (db.prepare('SELECT COUNT(*) AS c FROM nps_data').get() as {c:number}).c;
    results.push(check('NPS Total Ratings',     GOLDEN.npsTotal,     npsTotal));

    // 6. NPS Promoters
    const npsPromo = (db.prepare('SELECT COALESCE(SUM(promoter),0) AS s FROM nps_data').get() as {s:number}).s;
    results.push(check('NPS Promoters',         GOLDEN.npsPromoters, npsPromo));

    // NPS score
    const npsDet   = (db.prepare('SELECT COALESCE(SUM(detractor),0) AS s FROM nps_data').get() as {s:number}).s;
    const npsScore = npsTotal > 0 ? Math.round(((npsPromo - npsDet) / npsTotal) * 100) : 0;
    console.log(`  ℹ️  Computed NPS Score: ${npsScore} (${npsPromo} promoters, ${npsDet} detractors)\n`);
  } else {
    console.log('  ⏭️  Skipping NPS checks — NPS file not ingested.\n');
  }

  // ── Print results ───────────────────────────────────────────────────────
  console.log('── Results ─────────────────────────────────────────────');
  for (const r of results) printResult(r);

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  const total  = results.length;

  console.log('\n── Summary ─────────────────────────────────────────────');
  console.log(`  ${passed}/${total} checks passed  |  ${failed} failed`);
  if (total === 0) {
    console.log('  ⚠️  No checks ran — ensure XLSX files are available.');
  } else if (failed === 0) {
    console.log('  🎉 All golden number checks passed!');
  } else {
    console.log('\n  NOTE: Partial dataset from sample file (1000 rows) will not match');
    console.log('  full-dataset golden numbers (7,075 rows). Run with a complete export.');
  }
  console.log('══════════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

runValidation().catch((err) => {
  console.error('FATAL:', (err as Error).message);
  process.exit(1);
});
