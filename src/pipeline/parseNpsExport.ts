/**
 * src/pipeline/parseNpsExport.ts
 *
 * Parses the 38-column Sales Engagement Feedback XLSX from OpDashboard.
 * File: Export_Details_SalesFB.xlsx
 * Feedback Submitter is anonymized (XXXX@XXX.XXX) — Team Member is resolved
 * by joining Request # → requests.assign_to → squad_members.name.
 */

import * as XLSX from 'xlsx';
import * as path from 'path';
import { logger } from '../utils/logger';

export interface RawNpsRow {
  rated_date: string | null;
  rating: number | null;
  pain_points: string | null;
  original_comment: string | null;
  translated_comment: string | null;
  feedback_submitter: string | null;
  request_number: string | null;
  geo: string | null;
  market: string | null;
  country: string | null;
  squad_group: string | null;
  squad: string | null;
  squad_organization: string | null;
  center: string | null;
  major_unit: string | null;
  unit: string | null;
  sub_unit: string | null;
  channel: string | null;
  engagement_option: string | null;
  request_group: string | null;
  request_type: string | null;
  deal_desk: string | null;
  sr_status_at_fb: string | null;
  sub_status: string | null;
  sr_submit_date: string | null;
  sr_assign_date: string | null;
  sr_close_date: string | null;
  generic_request: string | null;
  request_owner_mgr: string | null;
  request_owner_org: string | null;
  customer_name: string | null;
  oppty_num: string | null;
  opp_owner: string | null;
  opp_description: string | null;
  year_month_rated: string | null;
  year_qtr_rated: string | null;
  feedback_id: string | null;
  root_cause: string | null;
}

function nullify(v: unknown): string | null {
  if (v === null || v === undefined || String(v).trim() === '' || String(v).trim() === 'None') return null;
  return String(v).trim();
}

/**
 * Convert an Excel serial date number to a JS Date.
 * Excel counts days from Dec 30 1899 (epoch = serial 0), with the Lotus 1-2-3
 * leap-year bug that treats 1900 as a leap year (serial 60 = Feb 29 1900, which
 * never existed). All serials > 60 must subtract 1 to compensate.
 * Range guard: 40000–60000 ≈ years 2009–2064.
 */
function excelSerialToDate(serial: number): Date {
  const adjusted = serial > 60 ? serial - 1 : serial;
  return new Date((adjusted - 25569) * 86400 * 1000);
}

/**
 * Parse a date value that may be:
 *  - an Excel serial number (integer or decimal like 46128.6124)
 *  - an ISO / locale string like "01/05/2026" or "2026-01-05"
 * Returns ISO 8601 string or null.
 */
function parseDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s === 'None') return null;

  // Detect Excel serial: a numeric value in the plausible date range 40000–60000
  const num = Number(s);
  if (!isNaN(num) && num >= 40000 && num <= 60000) {
    const d = excelSerialToDate(num);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  try {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch { /* fall through */ }
  return null;
}

/**
 * Parse the "Year Month Rated" column which is an Excel serial representing the
 * last day of the month.  Returns a YYYY-MM string (e.g. "2026-03").
 */
function parseYearMonth(v: unknown): string | null {
  const iso = parseDate(v);
  if (!iso) return null;
  return iso.slice(0, 7);   // "YYYY-MM"
}

export function parseNpsExportFile(filePath: string): RawNpsRow[] {
  logger.info(`[parseNps] Reading: ${path.basename(filePath)}`);
  const wb = XLSX.readFile(filePath, { cellDates: false, raw: false });
  const ws = wb.Sheets['Sheet1'] ?? wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('No sheet found in NPS export file');

  const rawRows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(ws, { defval: null, raw: false });
  if (rawRows.length === 0) throw new Error('NPS export file is empty');

  return rawRows.map((row) => ({
    rated_date:         parseDate(row['Rated Date']),
    rating:             row['Rating'] !== null ? Number(row['Rating']) : null,
    pain_points:        nullify(row['PainPoints']),
    original_comment:   nullify(row['Original Comment']),
    translated_comment: nullify(row['Translated Comment']),
    feedback_submitter: nullify(row['Feedback Submitter']),
    request_number:     nullify(row['Request #']),
    geo:                nullify(row['Geo']),
    market:             nullify(row['Market']),
    country:            nullify(row['Country']),
    squad_group:        nullify(row['Squad Group']),
    squad:              nullify(row['Squad']),
    squad_organization: nullify(row['Squad Organization']),
    center:             nullify(row['Center']),
    major_unit:         nullify(row['Major Unit']),
    unit:               nullify(row['Unit']),
    sub_unit:           nullify(row['Sub Unit']),
    channel:            nullify(row['Channel']),
    engagement_option:  nullify(row['Engagement Option']),
    request_group:      nullify(row['Request Group']),
    request_type:       nullify(row['Request Type']),
    deal_desk:          nullify(row['Deal Desk']),
    sr_status_at_fb:    nullify(row['SR Status at Feedback']),
    sub_status:         nullify(row['SubStatus']),
    sr_submit_date:     parseDate(row['SR Submit Date']),
    sr_assign_date:     parseDate(row['SR Assign Date']),
    sr_close_date:      parseDate(row['SR Close Date']),
    generic_request:    nullify(row['Generic Request Indicator']),
    request_owner_mgr:  nullify(row['Request Owner Manager']),
    request_owner_org:  nullify(row['Request Owner Organization']),
    customer_name:      nullify(row['Customer Name']),
    oppty_num:          nullify(row['Oppty #']),
    opp_owner:          nullify(row['OPPOWNER']),
    opp_description:    nullify(row['Opportunity Description']),
    year_month_rated:   parseYearMonth(row['Year Month Rated']),
    year_qtr_rated:     nullify(row['Year Qtr Rated']),
    feedback_id:        row['Feedback ID'] !== null ? String(row['Feedback ID']) : null,
    root_cause:         nullify(row['Root Cause']),
  }));
}
