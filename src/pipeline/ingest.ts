/**
 * src/pipeline/ingest.ts
 *
 * Ingestion pipeline: parse XLSX → insert raw → deduplicate → transform.
 * Idempotent: re-ingesting the same file is safe (UNIQUE constraints + dedup logic).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getDb } from '../db/schema';
import { parseRequestViewFile } from './parseRequestView';
import { parseNpsExportFile } from './parseNpsExport';
import { transformWeightedVolume, transformMiData, transformNpsData } from './transform';
import { resolveNpsOwners } from '../automation/npsOwnerResolver';
import { logger } from '../utils/logger';

export interface IngestResult {
  ingestionId: string;
  source: 'request_view' | 'nps_export';
  filename: string;
  rowCount: number;
  status: 'success' | 'failed';
  error?: string;
  durationMs: number;
}

function makeId(filePath: string): string {
  return crypto.createHash('sha256').update(filePath + Date.now()).digest('hex').slice(0, 16);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingest Request View XLSX
// ─────────────────────────────────────────────────────────────────────────────
export function ingestRequestView(filePath: string): IngestResult {
  const start = Date.now();
  const db = getDb();
  const filename = path.basename(filePath);
  const ingestionId = makeId(filePath);

  try {
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

    const rows = parseRequestViewFile(filePath);
    if (rows.length === 0) throw new Error('No rows found in file');

    // Insert raw rows
    const insertRaw = db.prepare(`
      INSERT OR IGNORE INTO raw_requests (
        ingestion_id, request_number, request_type, accelerate, status,
        customer_number, customer_name, squad_group_name, squad_id, squad_name,
        request_title, request_comment, submitter, last_comment, requester,
        latest_update, submission_date, assign_to, needed_by, close_date,
        opportunity_num, market, country, unit, sub_unit, channel, deal_desk,
        currency, tcv_billing_amount, geo, pending_reason_code, enterprise_number,
        gbg, engagement_number, multi_unit, assign_to_organization, requester_id,
        opp_description, sector, program_type, blue_group, source,
        external_request_number, contract_type_svc, contract_number_svc,
        work_number_svc, legal_contract_svc, billing_type_svc, system_invoice_svc,
        custom_invoice_svc, change_types_svc, segment_svc, sub_segment_svc,
        division_svc, bp_request_ref_shw, install_customer_shw, order_number_shw,
        alteration_type_shw, inventory_update_shw, request_sub_type_tls,
        contract_number_tls, bp_name_tls
      ) VALUES (
        @ingestion_id, @request_number, @request_type, @accelerate, @status,
        @customer_number, @customer_name, @squad_group_name, @squad_id, @squad_name,
        @request_title, @request_comment, @submitter, @last_comment, @requester,
        @latest_update, @submission_date, @assign_to, @needed_by, @close_date,
        @opportunity_num, @market, @country, @unit, @sub_unit, @channel, @deal_desk,
        @currency, @tcv_billing_amount, @geo, @pending_reason_code, @enterprise_number,
        @gbg, @engagement_number, @multi_unit, @assign_to_organization, @requester_id,
        @opp_description, @sector, @program_type, @blue_group, @source,
        @external_request_number, @contract_type_svc, @contract_number_svc,
        @work_number_svc, @legal_contract_svc, @billing_type_svc, @system_invoice_svc,
        @custom_invoice_svc, @change_types_svc, @segment_svc, @sub_segment_svc,
        @division_svc, @bp_request_ref_shw, @install_customer_shw, @order_number_shw,
        @alteration_type_shw, @inventory_update_shw, @request_sub_type_tls,
        @contract_number_tls, @bp_name_tls
      )
    `);

    const batchInsert = db.transaction(() => {
      for (const row of rows) insertRaw.run({ ingestion_id: ingestionId, ...row });
    });
    batchInsert();
    logger.info(`[ingest] Inserted ${rows.length} raw request rows (ingestion: ${ingestionId})`);

    // Deduplicate: upsert into canonical 'requests' — keep latest by latest_update
    deduplicateRequests();

    // Recompute derived layers.
    // transformNpsData is included because NPS may have been ingested before requests,
    // leaving team_member null. Re-running it now resolves the request# → assign_to
    // mapping with the freshly populated requests table.
    transformWeightedVolume();
    transformMiData();
    transformNpsData();

    // Background: resolve any still-unassigned NPS owners via ES API (fire-and-forget).
    resolveNpsOwners().catch((e: Error) =>
      logger.warn(`[ingest] NPS owner resolution error: ${e.message}`)
    );

    const durationMs = Date.now() - start;
    logIngestion(db, ingestionId, 'request_view', filename, filePath, rows.length, 'success', null);
    return { ingestionId, source: 'request_view', filename, rowCount: rows.length, status: 'success', durationMs };

  } catch (err) {
    const error = (err as Error).message;
    logger.error(`[ingest] Request View failed: ${error}`);
    logIngestion(db, ingestionId, 'request_view', filename, filePath, 0, 'failed', error);
    return { ingestionId, source: 'request_view', filename, rowCount: 0, status: 'failed', error, durationMs: Date.now() - start };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingest NPS Export XLSX
// ─────────────────────────────────────────────────────────────────────────────
export function ingestNpsExport(filePath: string): IngestResult {
  const start = Date.now();
  const db = getDb();
  const filename = path.basename(filePath);
  const ingestionId = makeId(filePath);

  try {
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

    const rows = parseNpsExportFile(filePath);
    if (rows.length === 0) throw new Error('No rows found in NPS file');

    const insertRaw = db.prepare(`
      INSERT OR IGNORE INTO raw_nps (
        ingestion_id, rated_date, rating, pain_points, original_comment,
        translated_comment, feedback_submitter, request_number, geo, market, country,
        squad_group, squad, squad_organization, center, major_unit, unit, sub_unit,
        channel, engagement_option, request_group, request_type, deal_desk,
        sr_status_at_fb, sub_status, sr_submit_date, sr_assign_date, sr_close_date,
        generic_request, request_owner_mgr, request_owner_org, customer_name,
        oppty_num, opp_owner, opp_description, year_month_rated, year_qtr_rated,
        feedback_id, root_cause
      ) VALUES (
        @ingestion_id, @rated_date, @rating, @pain_points, @original_comment,
        @translated_comment, @feedback_submitter, @request_number, @geo, @market, @country,
        @squad_group, @squad, @squad_organization, @center, @major_unit, @unit, @sub_unit,
        @channel, @engagement_option, @request_group, @request_type, @deal_desk,
        @sr_status_at_fb, @sub_status, @sr_submit_date, @sr_assign_date, @sr_close_date,
        @generic_request, @request_owner_mgr, @request_owner_org, @customer_name,
        @oppty_num, @opp_owner, @opp_description, @year_month_rated, @year_qtr_rated,
        @feedback_id, @root_cause
      )
    `);

    const batchInsert = db.transaction(() => {
      for (const row of rows) insertRaw.run({ ingestion_id: ingestionId, ...row });
    });
    batchInsert();
    logger.info(`[ingest] Inserted ${rows.length} raw NPS rows (ingestion: ${ingestionId})`);

    // Recompute NPS derived layer
    transformNpsData();

    // Background: resolve any still-unassigned NPS owners via ES API (fire-and-forget).
    resolveNpsOwners().catch((e: Error) =>
      logger.warn(`[ingest] NPS owner resolution error: ${e.message}`)
    );

    const durationMs = Date.now() - start;
    logIngestion(db, ingestionId, 'nps_export', filename, filePath, rows.length, 'success', null);
    return { ingestionId, source: 'nps_export', filename, rowCount: rows.length, status: 'success', durationMs };

  } catch (err) {
    const error = (err as Error).message;
    logger.error(`[ingest] NPS Export failed: ${error}`);
    logIngestion(db, ingestionId, 'nps_export', filename, filePath, 0, 'failed', error);
    return { ingestionId, source: 'nps_export', filename, rowCount: 0, status: 'failed', error, durationMs: Date.now() - start };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Deduplication: canonical requests table
// Keeps the version with the latest `latest_update` per request_number
// ─────────────────────────────────────────────────────────────────────────────
function deduplicateRequests(): void {
  const db = getDb();
  // Upsert: if request_number already exists, update only if the new latest_update is newer
  db.exec(`
    INSERT OR REPLACE INTO requests (
      request_number, request_type, accelerate, status,
      customer_number, customer_name, squad_group_name, squad_id, squad_name,
      request_title, request_comment, submitter, last_comment, requester,
      latest_update, submission_date, assign_to, needed_by, close_date,
      opportunity_num, market, country, unit, sub_unit, channel, deal_desk,
      currency, tcv_billing_amount, geo, pending_reason_code, enterprise_number,
      gbg, engagement_number, multi_unit, assign_to_organization, requester_id,
      opp_description, sector, program_type, blue_group, source,
      external_request_number, updated_at
    )
    SELECT
      r.request_number, r.request_type, r.accelerate, r.status,
      r.customer_number, r.customer_name, r.squad_group_name, r.squad_id, r.squad_name,
      r.request_title, r.request_comment, r.submitter, r.last_comment, r.requester,
      r.latest_update, r.submission_date, r.assign_to, r.needed_by, r.close_date,
      r.opportunity_num, r.market, r.country, r.unit, r.sub_unit, r.channel, r.deal_desk,
      r.currency, r.tcv_billing_amount, r.geo, r.pending_reason_code, r.enterprise_number,
      r.gbg, r.engagement_number, r.multi_unit, r.assign_to_organization, r.requester_id,
      r.opp_description, r.sector, r.program_type, r.blue_group, r.source,
      r.external_request_number, datetime('now')
    FROM raw_requests r
    INNER JOIN (
      SELECT request_number, MAX(COALESCE(latest_update, '')) AS max_lu
      FROM raw_requests
      GROUP BY request_number
    ) best ON r.request_number = best.request_number
          AND COALESCE(r.latest_update, '') = best.max_lu
  `);
  const count = (db.prepare('SELECT COUNT(*) as c FROM requests').get() as { c: number }).c;
  logger.info(`[ingest] Deduplicated requests table: ${count} canonical rows`);
}

function logIngestion(
  db: import('better-sqlite3').Database,
  id: string,
  source: string,
  filename: string,
  filePath: string,
  rowCount: number,
  status: string,
  error: string | null
): void {
  db.prepare(`
    INSERT OR IGNORE INTO ingestion_log (id, source, filename, file_path, row_count, status, error)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, source, filename, filePath, rowCount, status, error);
}
