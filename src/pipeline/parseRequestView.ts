/**
 * src/pipeline/parseRequestView.ts
 *
 * Parses the 61-column Request View XLSX export from EngageSupport.
 * Returns typed row objects ready for insertion into raw_requests.
 *
 * Date format from export: "30/Jul/2026" (DD/MMM/YYYY) → stored as ISO string.
 * Amount format: "233,114.62" string → parsed to REAL.
 * "None" / null → stored as NULL.
 */

import * as XLSX from 'xlsx';
import * as path from 'path';
import { logger } from '../utils/logger';

export interface RawRequestRow {
  request_number: string;
  request_type: string | null;
  accelerate: string | null;
  status: string | null;
  customer_number: string | null;
  customer_name: string | null;
  squad_group_name: string | null;
  squad_id: string | null;
  squad_name: string | null;
  request_title: string | null;
  request_comment: string | null;
  submitter: string | null;
  last_comment: string | null;
  requester: string | null;
  latest_update: string | null;
  submission_date: string | null;
  assign_to: string | null;
  needed_by: string | null;
  close_date: string | null;
  opportunity_num: string | null;
  market: string | null;
  country: string | null;
  unit: string | null;
  sub_unit: string | null;
  channel: string | null;
  deal_desk: string | null;
  currency: string | null;
  tcv_billing_amount: number | null;
  geo: string | null;
  pending_reason_code: string | null;
  enterprise_number: string | null;
  gbg: string | null;
  engagement_number: string | null;
  multi_unit: string | null;
  assign_to_organization: string | null;
  requester_id: string | null;
  opp_description: string | null;
  sector: string | null;
  program_type: string | null;
  blue_group: string | null;
  source: string | null;
  external_request_number: string | null;
  [key: string]: string | number | null;
}

/** Convert "30/Jul/2026" to ISO "2026-07-30T00:00:00.000Z". Returns null if unparseable. */
function parseEngageDate(raw: unknown): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s === 'None' || s === '') return null;
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(s).toISOString();
  // DD/MMM/YYYY
  const m = s.match(/^(\d{1,2})\/([A-Za-z]{3})\/(\d{4})$/);
  if (m) {
    const months: Record<string, string> = {
      Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
      Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
    };
    const mon = months[m[2]] ?? '01';
    return `${m[3]}-${mon}-${m[1].padStart(2, '0')}T00:00:00.000Z`;
  }
  // Excel serial date number
  if (/^\d+(\.\d+)?$/.test(s)) {
    const d = XLSX.SSF.parse_date_code(parseFloat(s));
    if (d) return new Date(d.y, d.m - 1, d.d).toISOString();
  }
  return null;
}

function parseAmount(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === 'None') return null;
  const s = String(raw).replace(/,/g, '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function nullify(v: unknown): string | null {
  if (v === null || v === undefined || String(v).trim() === '' || String(v).trim() === 'None') return null;
  return String(v).trim();
}

export function parseRequestViewFile(filePath: string): RawRequestRow[] {
  logger.info(`[parseRequestView] Reading: ${path.basename(filePath)}`);
  const wb = XLSX.readFile(filePath, { cellDates: false, raw: false });
  const ws = wb.Sheets['Request View'] ?? wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('No sheet found in Request View file');

  const rawRows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(ws, { defval: null, raw: false });
  if (rawRows.length === 0) throw new Error('Request View file is empty');

  const dateFields = ['Latest Update', 'Submission Date', 'Needed by', 'Close Date'];

  return rawRows.map((row) => ({
    request_number:          String(row['Request number'] ?? '').trim(),
    request_type:            nullify(row['Request type']),
    accelerate:              nullify(row['Accelerate']),
    status:                  nullify(row['Status']),
    customer_number:         nullify(row['Customer number']),
    customer_name:           nullify(row['Customer name']),
    squad_group_name:        nullify(row['Squad Group Name']),
    squad_id:                nullify(row['Squad Id']),
    squad_name:              nullify(row['Squad Name']),
    request_title:           nullify(row['Request Title']),
    request_comment:         nullify(row['Request Comment']),
    submitter:               nullify(row['Submitter']),
    last_comment:            nullify(row['Last Comment']),
    requester:               nullify(row['Requester']),
    latest_update:           parseEngageDate(row['Latest Update']),
    submission_date:         parseEngageDate(row['Submission Date']),
    assign_to:               nullify(row['Assign to']),
    needed_by:               parseEngageDate(row['Needed by']),
    close_date:              parseEngageDate(row['Close Date']),
    opportunity_num:         nullify(row['Opportunity #']),
    market:                  nullify(row['Market']),
    country:                 nullify(row['Country']),
    unit:                    nullify(row['Unit']),
    sub_unit:                nullify(row['Sub-unit']),
    channel:                 nullify(row['Channel']),
    deal_desk:               nullify(row['Deal Desk']),
    currency:                nullify(row['Currency']),
    tcv_billing_amount:      parseAmount(row['TCV/Billing amount']),
    geo:                     nullify(row['GEO']),
    pending_reason_code:     nullify(row['Pending Reason Code']),
    enterprise_number:       nullify(row['Enterprise Number']),
    gbg:                     nullify(row['GBG']),
    engagement_number:       nullify(row['Engagement Number']),
    multi_unit:              nullify(row['Multi-unit?']),
    assign_to_organization:  nullify(row['Assign to Organization']),
    requester_id:            nullify(row['Requester id']),
    opp_description:         nullify(row['Opp. description']),
    sector:                  nullify(row['Sector']),
    program_type:            nullify(row['Program Type']),
    blue_group:              nullify(row['BlueGroup']),
    source:                  nullify(row['Source']),
    external_request_number: nullify(row['External Request Number']),
    contract_type_svc:       nullify(row['Contract type (Services)']),
    contract_number_svc:     nullify(row['Contract number (Services)']),
    work_number_svc:         nullify(row['Work number (Services)']),
    legal_contract_svc:      nullify(row['Legal contract number (Services)']),
    billing_type_svc:        nullify(row['Billing type (Services)']),
    system_invoice_svc:      nullify(row['System invoice number (Services)']),
    custom_invoice_svc:      nullify(row['Custom invoice number (Services)']),
    change_types_svc:        nullify(row['Change types (Services)']),
    segment_svc:             nullify(row['Segment (Services)']),
    sub_segment_svc:         nullify(row['Sub segment (Services)']),
    division_svc:            nullify(row['Division (Services)']),
    bp_request_ref_shw:      nullify(row['BP request reference (SHW)']),
    install_customer_shw:    nullify(row['Install at Customer Name (SHW)']),
    order_number_shw:        nullify(row['Order Number (SHW)']),
    alteration_type_shw:     nullify(row['Alteration Type (SHW)']),
    inventory_update_shw:    nullify(row['Type of inventory update (SHW)']),
    request_sub_type_tls:    nullify(row['Request sub-type (TLS)']),
    contract_number_tls:     nullify(row['Contract Number (TLS)']),
    bp_name_tls:             nullify(row['BP Name (TLS)']),
  }));
}
