/**
 * scripts/apply-master-tags.mjs
 *
 * Reads tagging from the master Excel file and applies it to all uncategorized
 * weighted_volume rows via manual_classifications. Two-pass strategy:
 *
 *   Pass 1 (exact):  Match by request_number directly from master file.
 *                    381 / 449 uncat rows expected.
 *
 *   Pass 2 (infer):  For rows not in master, extract reason code from the
 *                    first token of last_comment (e.g. "R10 Hi ...") and map
 *                    to sub_process using the code→classification table learned
 *                    from the master file.
 *
 * All tags land in manual_classifications so they survive re-transforms.
 * A final transformWeightedVolume() call is triggered via the API.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const XLSX     = require('xlsx');
const Database = require('better-sqlite3');

const MASTER_PATH = '/Users/jojielazarte/Library/CloudStorage/OneDrive-IBM/Metrics/CMT Metrics 1Q 2026_MASTERFILE_Jan to June.xlsx';
const DB_PATH     = process.cwd() + '/data/cmt_metrics.db';

// ── 1. Load master file ───────────────────────────────────────────────────────
const wb   = XLSX.readFile(MASTER_PATH);
const ws   = wb.Sheets['Weighted Volume Data source'];
const masterRows = XLSX.utils.sheet_to_json(ws, { defval: null });

// request_number → classification
const masterMap = new Map();
for (const r of masterRows) {
  const rn = String(r['Request number'] ?? '').trim();
  const sp = r['Sub-Process'];
  if (!rn || !sp) continue;
  masterMap.set(rn, {
    sub_process: sp,
    process:     r['Process']     ?? '',
    complexity:  r['Complexity']  ?? '',
    weight:      Number(r['Weight']) || 1,
  });
}
console.log(`Master: ${masterMap.size} tagged request numbers loaded.`);

// ── 2. Build reason-code → classification map from master ─────────────────────
// The last_comment often starts with a code like "R10", "M12", "A7", "T1".
// We take the most-frequent sub_process per code as the canonical mapping.
const codeFreq = {};   // code → { [sub_process]: count, __meta: { process, complexity, weight } }
for (const r of masterRows) {
  const lc = String(r['Last comment'] ?? '').trim();
  const sp = r['Sub-Process'];
  if (!sp || !lc) continue;
  const m = lc.match(/^([A-Z]\d{1,2})\b/);
  if (!m) continue;
  const code = m[1];
  if (!codeFreq[code]) codeFreq[code] = {};
  codeFreq[code][sp] = (codeFreq[code][sp] || 0) + 1;
}
// Collapse to most-frequent sub_process per code
const codeMap = {};
for (const [code, spCounts] of Object.entries(codeFreq)) {
  const bestSp = Object.entries(spCounts).sort((a,b) => b[1]-a[1])[0][0];
  // Find a master row with this code and sub_process to get process/complexity/weight
  const sample = masterRows.find(r => {
    const lc = String(r['Last comment'] ?? '').trim();
    return lc.match(/^([A-Z]\d{1,2})\b/)?.[1] === code && r['Sub-Process'] === bestSp;
  });
  if (sample) codeMap[code] = {
    sub_process: bestSp,
    process:     sample['Process']    ?? '',
    complexity:  sample['Complexity'] ?? '',
    weight:      Number(sample['Weight']) || 1,
  };
}
console.log(`Code map: ${Object.keys(codeMap).length} reason codes learned from master.`);

// ── 2b. Build request_type → best classification fallback from master ─────────
const typeFreq = {};
for (const r of masterRows) {
  const rt = String(r['Request type'] ?? '').trim();
  const sp = r['Sub-Process'];
  if (!rt || !sp) continue;
  if (!typeFreq[rt]) typeFreq[rt] = {};
  typeFreq[rt][sp] = (typeFreq[rt][sp] || 0) + 1;
}
const typeMap = {};
for (const [rt, spCounts] of Object.entries(typeFreq)) {
  const bestSp = Object.entries(spCounts).sort((a,b) => b[1]-a[1])[0][0];
  const sample = masterRows.find(r => String(r['Request type'] ?? '').trim() === rt && r['Sub-Process'] === bestSp);
  if (sample) typeMap[rt] = {
    sub_process: bestSp,
    process:     sample['Process']    ?? '',
    complexity:  sample['Complexity'] ?? '',
    weight:      Number(sample['Weight']) || 1,
  };
}
console.log(`Type map: ${Object.keys(typeMap).length} request types mapped from master.`);

// ── 3. Connect DB and get uncategorized rows ──────────────────────────────────
const db   = new Database(DB_PATH);
// Only get rows that are STILL unclassified (not yet in manual_classifications)
const uncat = db.prepare(`
  SELECT wv.request_number, wv.last_comment, wv.request_type
  FROM weighted_volume wv
  LEFT JOIN manual_classifications mc ON mc.request_number = wv.request_number
  WHERE (wv.sub_process IS NULL OR wv.sub_process = '')
    AND mc.request_number IS NULL
`).all();
console.log(`Uncategorized rows to process: ${uncat.length}`);

// ── 4. Upsert into manual_classifications ─────────────────────────────────────
const upsert = db.prepare(`
  INSERT INTO manual_classifications (request_number, sub_process, process, complexity, weight, override_by, note)
  VALUES (@request_number, @sub_process, @process, @complexity, @weight, @override_by, @note)
  ON CONFLICT(request_number) DO UPDATE SET
    sub_process  = excluded.sub_process,
    process      = excluded.process,
    complexity   = excluded.complexity,
    weight       = excluded.weight,
    override_by  = excluded.override_by,
    note         = excluded.note,
    override_at  = datetime('now')
`);

let pass1 = 0, pass2 = 0, unresolved = 0;
const unresolvedRows = [];

const applyAll = db.transaction(() => {
  for (const row of uncat) {
    const rn = row.request_number;

    // Pass 1: exact master match
    if (masterMap.has(rn)) {
      const tag = masterMap.get(rn);
      upsert.run({ request_number: rn, ...tag, override_by: 'master_file', note: 'Auto-applied from master XLSX' });
      pass1++;
      continue;
    }

    // Pass 2: infer from reason code anywhere in last_comment (no word boundary —
    // codes like "A10" appear glued to text: "Good day! A10Hi...","CorrectionA11 Site...")
    const lc   = String(row.last_comment ?? '').trim();
    const codeTokens = [...lc.matchAll(/([A-Z]\d{1,2})/g)].map(m => m[1]);
    const code = codeTokens.find(c => codeMap[c]);
    if (code && codeMap[code]) {
      const tag = codeMap[code];
      upsert.run({ request_number: rn, ...tag, override_by: 'code_inference', note: `Inferred from reason code ${code}` });
      pass2++;
      continue;
    }

    // Pass 3: fallback by request_type (most-frequent sub_process in master for that type)
    const rt = String(row.request_type ?? '').trim();
    if (rt && typeMap[rt]) {
      const tag = typeMap[rt];
      upsert.run({ request_number: rn, ...tag, override_by: 'type_fallback', note: `Inferred from request type "${rt}"` });
      pass2++;   // count alongside code inference
      continue;
    }

    // Unresolved
    unresolved++;
    unresolvedRows.push({ rn, lc: lc.slice(0, 100) });
  }
});

applyAll();
db.close();

console.log(`\n=== Results ===`);
console.log(`Pass 1 (master exact match): ${pass1}`);
console.log(`Pass 2 (code inference):     ${pass2}`);
console.log(`Still unresolved:            ${unresolved}`);
if (unresolvedRows.length) {
  console.log(`\nUnresolved samples:`);
  for (const r of unresolvedRows.slice(0, 20)) {
    console.log(`  ${r.rn} | "${r.lc}"`);
  }
}
