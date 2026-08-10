/**
 * src/pipeline/exportXlsx.ts
 *
 * Regenerates a master-file-compatible multi-sheet XLSX workbook from the
 * computed SQLite tables. Mirrors the structure of:
 *   CMT Metrics 1Q 2026_MASTERFILE_Jan to June.xlsx
 *
 * Sheets produced:
 *   1. "Weighted Volume Data source"  — weighted_volume rows
 *   2. "M&I Data source"              — mi_data rows
 *   3. "NPS Data source"              — nps_data rows
 *   4. "Ingestion Log"                — ingestion_log rows
 *
 * Returns the path to the written file.
 */

import * as XLSX from 'xlsx';
import * as path from 'path';
import * as fs from 'fs';
import { getDb } from '../db/schema';
import { logger } from '../utils/logger';

export interface ExportXlsxOptions {
  outputDir?: string;
  filename?:  string;
  /** Month filter abbreviation, e.g. "Jan" | "Feb". If omitted, all months. */
  month?: string;
  /** Year-Month filter, e.g. "2026-01". If provided, overrides month. */
  yearMonth?: string;
}

export function exportMasterXlsx(opts: ExportXlsxOptions = {}): string {
  const db  = getDb();
  const dir = opts.outputDir ?? path.resolve(process.cwd(), 'data/exports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const ts       = new Date().toISOString().replace(/[:.]/g, '_');
  const filename = opts.filename ?? `cmt_metrics_export_${ts}.xlsx`;
  const filePath = path.join(dir, filename);

  // ── Weighted Volume ───────────────────────────────────────────────────────
  let wvSql = 'SELECT * FROM weighted_volume';
  const wvParams: string[] = [];
  if (opts.yearMonth) {
    wvSql += ' WHERE substr(close_date,1,7) = ?';
    wvParams.push(opts.yearMonth);
  } else if (opts.month) {
    wvSql += ' WHERE month = ?';
    wvParams.push(opts.month);
  }
  wvSql += ' ORDER BY close_date';
  const wvRows = db.prepare(wvSql).all(...wvParams) as Record<string, unknown>[];

  // ── M&I Data ──────────────────────────────────────────────────────────────
  let miSql = 'SELECT * FROM mi_data';
  const miParams: string[] = [];
  if (opts.yearMonth) {
    miSql += ' WHERE substr(close_date,1,7) = ?';
    miParams.push(opts.yearMonth);
  } else if (opts.month) {
    miSql += ' WHERE month = ?';
    miParams.push(opts.month);
  }
  miSql += ' ORDER BY close_date';
  const miRows = db.prepare(miSql).all(...miParams) as Record<string, unknown>[];

  // ── NPS Data ──────────────────────────────────────────────────────────────
  let npsSql = 'SELECT * FROM nps_data';
  const npsParams: string[] = [];
  if (opts.yearMonth) {
    npsSql += ' WHERE substr(rated_date,1,7) = ?';
    npsParams.push(opts.yearMonth);
  } else if (opts.month) {
    npsSql += ' WHERE month = ?';
    npsParams.push(opts.month);
  }
  npsSql += ' ORDER BY rated_date';
  const npsRows = db.prepare(npsSql).all(...npsParams) as Record<string, unknown>[];

  // ── Ingestion Log ─────────────────────────────────────────────────────────
  const logRows = db.prepare('SELECT * FROM ingestion_log ORDER BY ingested_at DESC').all() as Record<string, unknown>[];

  // ── Rename columns to match master file header style ─────────────────────
  function humanise(rows: Record<string, unknown>[], colMap: Record<string, string>): Record<string, unknown>[] {
    return rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const [dbCol, label] of Object.entries(colMap)) {
        out[label] = r[dbCol] ?? '';
      }
      return out;
    });
  }

  const wvColMap: Record<string, string> = {
    request_number:    'Request number',
    customer_name:     'Customer name',
    enterprise_number: 'Enterprise Number',
    engagement_number: 'Engagement Number',
    request_type:      'Request type',
    accelerate:        'Accelerate',
    request_title:     'Request Title',
    squad_id:          'Squad Id',
    squad_name:        'Squad Name',
    squad_group_name:  'Squad Group Name',
    multi_unit:        'Multi-unit?',
    last_comment:      'Last Comment',
    submitter:         'Submitter',
    requester:         'Requester',
    latest_update:     'Latest Update',
    submission_date:   'Submission Date',
    status:            'Status',
    assign_to:         'Assign to',
    close_date:        'Close Date',
    market:            'Market',
    country:           'Country',
    unit:              'Unit',
    sub_unit:          'Sub-unit',
    channel:           'Channel',
    deal_desk:         'Deal Desk',
    currency:          'Currency',
    tcv_billing_amount:'TCV/Billing amount',
    sub_process:       'Sub-Process',
    process:           'Process',
    complexity:        'Complexity',
    weight:            'Weight',
    team_member:       'Team Member',
    month:             'Month',
  };

  const miColMap: Record<string, string> = {
    request_number:         'Request number',
    geo:                    'GEO',
    market:                 'Market',
    country:                'Country',
    unit:                   'Unit',
    sub_unit:               'Sub-unit',
    channel:                'Channel',
    engagement_option:      'Engagement Option',
    request_group:          'Request Group',
    request_type:           'Request Type',
    deal_desk:              'Deal Desk',
    customer_name:          'Customer Name',
    global_buying_group:    'Global Buying Group',
    opp:                    'Opp #',
    opportunity_owner:      'Opportunity Owner',
    tcv:                    'TCV',
    curr:                   'Curr',
    submitter:              'Submitter',
    requester:              'Requester',
    title:                  'Title',
    squad_group:            'Squad Group',
    squad:                  'Squad',
    request_owner:          'Request Owner',
    status:                 'Status',
    sector:                 'Sector',
    program_type:           'Program Type',
    sr_source:              'SR Source',
    is_backdated:           'Is Backdated',
    submit_date:            'Submit Date',
    ym_open:                'YM Open',
    yq_open:                'YQ Open',
    due_date:               'Due Date',
    close_date:             'Close Date',
    week_close:             'Week Close',
    ym_close:               'YM Close',
    yq_close:               'YQ Close',
    ct_days:                'CT Days',
    ct_in_days:             'CT in Days',
    ct_hours:               'CT Hours',
    assign_time_hours:      'Assign Time (Hours)',
    funnel_hours:           'Funnel Hours',
    wait_hours:             'Wait Hours',
    squad_hours:            'Squad Hours',
    squad_member:           'Squad Member',
    month:                  'Month',
  };

  const npsColMap: Record<string, string> = {
    month:            'Month',
    rated_date:       'Rated Date',
    rating:           'Rating',
    request_number:   'Request #',
    csr_email:        'Feedback Submitter',
    original_comment: 'Original Comment',
    team_member:      'Team Member',
    definition:       'Definition',
    promoter:         'Promoter',
    detractor:        'Detractor',
    passive:          'Passive',
    total:            'Total',
    nps_rating:       'NPS Rating',
  };

  const logColMap: Record<string, string> = {
    id:          'Ingestion ID',
    source:      'Source',
    filename:    'Filename',
    file_path:   'File Path',
    row_count:   'Row Count',
    status:      'Status',
    error:       'Error',
    ingested_at: 'Ingested At',
  };

  // ── Build workbook ────────────────────────────────────────────────────────
  const wb = XLSX.utils.book_new();

  const wvSheet = XLSX.utils.json_to_sheet(humanise(wvRows, wvColMap));
  XLSX.utils.book_append_sheet(wb, wvSheet, 'Weighted Volume Data source');

  const miSheet = XLSX.utils.json_to_sheet(humanise(miRows, miColMap));
  XLSX.utils.book_append_sheet(wb, miSheet, 'M&I Data source');

  const npsSheet = XLSX.utils.json_to_sheet(humanise(npsRows, npsColMap));
  XLSX.utils.book_append_sheet(wb, npsSheet, 'NPS Data source');

  const logSheet = XLSX.utils.json_to_sheet(humanise(logRows, logColMap));
  XLSX.utils.book_append_sheet(wb, logSheet, 'Ingestion Log');

  XLSX.writeFile(wb, filePath);
  logger.info(`[exportXlsx] Wrote ${wvRows.length} WV + ${miRows.length} MI + ${npsRows.length} NPS rows → ${filename}`);

  return filePath;
}
