/**
 * src/db/schema.ts
 *
 * SQLite database schema for CMT Metrics Hub.
 *
 * Layer structure:
 *   RAW     → raw_requests, raw_nps         (imported as-is from XLSX)
 *   LOOKUP  → squad_members, reason_codes   (editable reference tables)
 *   DERIVED → weighted_volume, mi_data, nps_data  (computed from raw + lookups)
 *
 * All timestamps stored as ISO-8601 strings. Numeric amounts as REAL.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../utils/logger';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const dbPath = process.env.DB_PATH ?? path.resolve(__dirname, '../../data/cmt_metrics.db');
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  // Flush any uncommitted WAL pages left from a previous unclean shutdown
  _db.pragma('wal_checkpoint(TRUNCATE)');
  initSchema(_db);
  logger.info(`[db] Connected: ${dbPath}`);
  return _db;
}

export function initSchema(db: Database.Database): void {
  db.exec(`
    -- ─────────────────────────────────────────────────────────────────────
    -- LOOKUP TABLES (editable, version-controlled by effective_date)
    -- ─────────────────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS squad_members (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      email_raw   TEXT,
      email       TEXT NOT NULL,
      name        TEXT NOT NULL,
      sap_id      TEXT,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_squad_members_email ON squad_members(email COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS reason_codes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      sub_process     TEXT NOT NULL,
      code_num        INTEGER NOT NULL,
      reason_code     TEXT NOT NULL,
      complexity      TEXT NOT NULL,
      weight          REAL NOT NULL,
      process         TEXT NOT NULL,
      effective_date  TEXT NOT NULL DEFAULT '2026-01-01',
      active          INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reason_codes_rc ON reason_codes(reason_code, effective_date);

    -- ─────────────────────────────────────────────────────────────────────
    -- RAW LAYER
    -- ─────────────────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS raw_requests (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      ingestion_id            TEXT NOT NULL,
      -- Core identifiers
      request_number          TEXT NOT NULL,
      request_type            TEXT,
      accelerate              TEXT,
      status                  TEXT,
      customer_number         TEXT,
      customer_name           TEXT,
      squad_group_name        TEXT,
      squad_id                TEXT,
      squad_name              TEXT,
      request_title           TEXT,
      request_comment         TEXT,
      submitter               TEXT,
      last_comment            TEXT,
      requester               TEXT,
      latest_update           TEXT,
      submission_date         TEXT,
      assign_to               TEXT,
      needed_by               TEXT,
      close_date              TEXT,
      opportunity_num         TEXT,
      market                  TEXT,
      country                 TEXT,
      unit                    TEXT,
      sub_unit                TEXT,
      channel                 TEXT,
      deal_desk               TEXT,
      currency                TEXT,
      tcv_billing_amount      REAL,
      geo                     TEXT,
      pending_reason_code     TEXT,
      enterprise_number       TEXT,
      gbg                     TEXT,
      engagement_number       TEXT,
      multi_unit              TEXT,
      assign_to_organization  TEXT,
      requester_id            TEXT,
      opp_description         TEXT,
      sector                  TEXT,
      program_type            TEXT,
      blue_group              TEXT,
      source                  TEXT,
      external_request_number TEXT,
      -- Services columns
      contract_type_svc       TEXT,
      contract_number_svc     TEXT,
      work_number_svc         TEXT,
      legal_contract_svc      TEXT,
      billing_type_svc        TEXT,
      system_invoice_svc      TEXT,
      custom_invoice_svc      TEXT,
      change_types_svc        TEXT,
      segment_svc             TEXT,
      sub_segment_svc         TEXT,
      division_svc            TEXT,
      -- SHW columns
      bp_request_ref_shw      TEXT,
      install_customer_shw    TEXT,
      order_number_shw        TEXT,
      alteration_type_shw     TEXT,
      inventory_update_shw    TEXT,
      -- TLS columns
      request_sub_type_tls    TEXT,
      contract_number_tls     TEXT,
      bp_name_tls             TEXT,
      -- Metadata
      created_at              TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(request_number, ingestion_id)
    );
    CREATE INDEX IF NOT EXISTS idx_raw_requests_num ON raw_requests(request_number);
    CREATE INDEX IF NOT EXISTS idx_raw_requests_close ON raw_requests(close_date);
    CREATE INDEX IF NOT EXISTS idx_raw_requests_squad ON raw_requests(squad_name);

    -- Deduplicated canonical requests (latest version by latest_update)
    CREATE TABLE IF NOT EXISTS requests (
      request_number          TEXT PRIMARY KEY,
      request_type            TEXT,
      accelerate              TEXT,
      status                  TEXT,
      customer_number         TEXT,
      customer_name           TEXT,
      squad_group_name        TEXT,
      squad_id                TEXT,
      squad_name              TEXT,
      request_title           TEXT,
      request_comment         TEXT,
      submitter               TEXT,
      last_comment            TEXT,
      requester               TEXT,
      latest_update           TEXT,
      submission_date         TEXT,
      assign_to               TEXT,
      needed_by               TEXT,
      close_date              TEXT,
      opportunity_num         TEXT,
      market                  TEXT,
      country                 TEXT,
      unit                    TEXT,
      sub_unit                TEXT,
      channel                 TEXT,
      deal_desk               TEXT,
      currency                TEXT,
      tcv_billing_amount      REAL,
      geo                     TEXT,
      pending_reason_code     TEXT,
      enterprise_number       TEXT,
      gbg                     TEXT,
      engagement_number       TEXT,
      multi_unit              TEXT,
      assign_to_organization  TEXT,
      requester_id            TEXT,
      opp_description         TEXT,
      sector                  TEXT,
      program_type            TEXT,
      blue_group              TEXT,
      source                  TEXT,
      external_request_number TEXT,
      updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS raw_nps (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      ingestion_id      TEXT NOT NULL,
      rated_date        TEXT,
      rating            INTEGER,
      pain_points       TEXT,
      original_comment  TEXT,
      translated_comment TEXT,
      feedback_submitter TEXT,
      request_number    TEXT,
      geo               TEXT,
      market            TEXT,
      country           TEXT,
      squad_group       TEXT,
      squad             TEXT,
      squad_organization TEXT,
      center            TEXT,
      major_unit        TEXT,
      unit              TEXT,
      sub_unit          TEXT,
      channel           TEXT,
      engagement_option TEXT,
      request_group     TEXT,
      request_type      TEXT,
      deal_desk         TEXT,
      sr_status_at_fb   TEXT,
      sub_status        TEXT,
      sr_submit_date    TEXT,
      sr_assign_date    TEXT,
      sr_close_date     TEXT,
      generic_request   TEXT,
      request_owner_mgr TEXT,
      request_owner_org TEXT,
      customer_name     TEXT,
      oppty_num         TEXT,
      opp_owner         TEXT,
      opp_description   TEXT,
      year_month_rated  TEXT,
      year_qtr_rated    TEXT,
      feedback_id       TEXT,
      root_cause        TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(feedback_id, ingestion_id)
    );

    -- ─────────────────────────────────────────────────────────────────────
    -- INGESTION LOG
    -- ─────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS ingestion_log (
      id          TEXT PRIMARY KEY,
      source      TEXT NOT NULL,  -- 'request_view' | 'nps_export'
      filename    TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      row_count   INTEGER,
      status      TEXT NOT NULL,  -- 'pending' | 'success' | 'failed'
      error       TEXT,
      ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ─────────────────────────────────────────────────────────────────────
    -- DERIVED LAYERS (recomputed on every ingestion)
    -- ─────────────────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS weighted_volume (
      request_number      TEXT PRIMARY KEY,
      -- Flags
      request_from_rework INTEGER DEFAULT 0,
      pending_from_req    INTEGER DEFAULT 0,
      -- Descriptive
      customer_name       TEXT,
      enterprise_number   TEXT,
      engagement_number   TEXT,
      request_type        TEXT,
      accelerate          TEXT,
      request_title       TEXT,
      squad_id            TEXT,
      squad_name          TEXT,
      squad_group_name    TEXT,
      multi_unit          TEXT,
      request_comment     TEXT,
      last_comment        TEXT,
      submitter           TEXT,
      requester           TEXT,
      latest_update       TEXT,
      submission_date     TEXT,
      status              TEXT,
      assign_to           TEXT,
      assign_to_org       TEXT,
      needed_by           TEXT,
      close_date          TEXT,
      opportunity_num     TEXT,
      opp_description     TEXT,
      market              TEXT,
      country             TEXT,
      unit                TEXT,
      sub_unit            TEXT,
      sector              TEXT,
      channel             TEXT,
      deal_desk           TEXT,
      program_type        TEXT,
      blue_group          TEXT,
      currency            TEXT,
      tcv_billing_amount  REAL,
      -- Computed
      sub_process         TEXT,
      process             TEXT,
      complexity          TEXT,
      weight              REAL,
      team_member         TEXT,
      month               TEXT,
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mi_data (
      request_number          TEXT PRIMARY KEY,
      geo                     TEXT,
      market                  TEXT,
      country                 TEXT,
      major_unit              TEXT,
      unit                    TEXT,
      sub_unit                TEXT,
      channel                 TEXT,
      engagement_option       TEXT,
      request_group           TEXT,
      request_type            TEXT,
      deal_desk               TEXT,
      customer_name           TEXT,
      global_buying_group     TEXT,
      opp                     TEXT,
      opportunity_owner       TEXT,
      tcv                     REAL,
      curr                    TEXT,
      submitter               TEXT,
      submitter_main_role_cat TEXT,
      requester               TEXT,
      center                  TEXT,
      link_to_es              TEXT,
      title                   TEXT,
      squad_group             TEXT,
      squad                   TEXT,
      squad_tier              TEXT,
      request_owner           TEXT,
      req_owner_bp_manager    TEXT,
      req_owner_func_manager  TEXT,
      status                  TEXT,
      sub_status              TEXT,
      sector                  TEXT,
      program_type            TEXT,
      forecasting_ica         TEXT,
      ssp_code                TEXT,
      sr_source               TEXT,
      is_backdated            TEXT,
      sr_received_date        TEXT,
      submit_date             TEXT,
      ym_open                 TEXT,
      yq_open                 TEXT,
      first_in_process_date   TEXT,
      due_date                TEXT,
      close_date              TEXT,
      week_close              TEXT,
      ym_close                TEXT,
      yq_close                TEXT,
      ct_days                 REAL,
      ct_in_days              TEXT,
      generic_request_ind     TEXT,
      incomplete_request_ind  TEXT,
      request_assign_count    INTEGER,
      ct_hours                REAL,
      assign_time_hours       REAL,
      funnel_hours            REAL,
      wait_hours              REAL,
      squad_hours             REAL,
      squad_member            TEXT,
      month                   TEXT,
      updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS nps_data (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      month           TEXT,
      rated_date      TEXT,
      rating          INTEGER,
      request_number  TEXT,
      csr_email       TEXT,
      original_comment TEXT,
      team_member     TEXT,
      definition      TEXT,
      promoter        INTEGER DEFAULT 0,
      detractor       INTEGER DEFAULT 0,
      passive         INTEGER DEFAULT 0,
      total           INTEGER DEFAULT 1,
      nps_rating      REAL,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(request_number, rated_date)
    );

    -- ─────────────────────────────────────────────────────────────────────
    -- NPS MEMBER OVERRIDES
    -- Stores manual team_member assignments made via the NPS page.
    -- Keyed by (request_number, rated_date) — same as nps_data UNIQUE.
    -- transformNpsData() re-applies these after every rebuild so assignments
    -- survive re-ingestion.
    -- ─────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS nps_member_overrides (
      request_number  TEXT NOT NULL,
      rated_date      TEXT NOT NULL DEFAULT '',
      team_member     TEXT NOT NULL,
      overridden_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (request_number, rated_date)
    );

    -- ─────────────────────────────────────────────────────────────────────
    -- MANUAL CLASSIFICATION OVERRIDES
    -- Rows here take precedence over reason-code lookup in transform.ts.
    -- Set via the Admin → Uncategorized page in the UI.
    -- ─────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS manual_classifications (
      request_number  TEXT PRIMARY KEY,
      sub_process     TEXT NOT NULL,
      process         TEXT NOT NULL,
      complexity      TEXT NOT NULL,
      weight          REAL NOT NULL,
      override_by     TEXT NOT NULL DEFAULT 'user',
      override_at     TEXT NOT NULL DEFAULT (datetime('now')),
      note            TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_manual_class_rn ON manual_classifications(request_number);
  `);

  // Migration: ensure nps_member_overrides.rated_date has a DEFAULT '' so that
  // rows with no rated_date (empty string) are accepted. Check the dflt_value
  // column from PRAGMA; recreate only when the default is missing.
  const rdCol = (db.prepare("PRAGMA table_info(nps_member_overrides)").all() as any[])
    .find((c) => c.name === 'rated_date');
  if (!rdCol?.dflt_value) {
    db.exec(`
      DROP TABLE IF EXISTS nps_member_overrides;
      CREATE TABLE nps_member_overrides (
        request_number  TEXT NOT NULL,
        rated_date      TEXT NOT NULL DEFAULT '',
        team_member     TEXT NOT NULL,
        overridden_at   TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (request_number, rated_date)
      );
    `);
  }

  logger.info('[db] Schema initialized.');
}
