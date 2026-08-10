/**
 * src/pipeline/transform.ts
 *
 * Core transformation engine.
 * Converts raw_requests + squad_members + reason_codes → weighted_volume, mi_data
 * Converts raw_nps + requests (assign_to join) → nps_data
 *
 * Classification priority (highest → lowest):
 *   1. manual_classifications table  — user override via UI Admin → Uncategorized
 *   2. reason_codes lookup by Last Comment first token (e.g. "A6", "M12", "T1")
 *      → date-aware: uses most recent effective_date ≤ close_date
 *   3. TReX fallback: if request_type contains "Shipment" or "Delivery" and
 *      no code was matched → assign TReX / TReX / Less Complex / 1.0
 *
 * Month derivation:
 *   Weighted Volume & M&I → month from close_date
 *   NPS → month from rated_date
 *
 * Team Member:
 *   Weighted Volume / M&I → lookup(assign_to email) against squad_members
 *   NPS → join(request_number → requests.assign_to → squad_members)
 */

import Database from 'better-sqlite3';
import { getDb } from '../db/schema';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the set of all valid reason-code strings (e.g. "A6", "M12", "T1")
 * from the DB so we can use it as an allowlist during comment scanning.
 * Cached at module level after first build to avoid repeated DB hits.
 */
let _validCodeSet: Set<string> | null = null;
function getValidCodeSet(db: Database.Database): Set<string> {
  if (_validCodeSet) return _validCodeSet;
  const rows = db.prepare('SELECT DISTINCT reason_code FROM reason_codes WHERE active = 1').all() as { reason_code: string }[];
  _validCodeSet = new Set(rows.map((r) => r.reason_code.toUpperCase()));
  // Always include T1 for the TReX/TREX literal fallback
  _validCodeSet.add('T1');
  return _validCodeSet;
}

/**
 * Extract a reason code from a Last Comment string.
 *
 * SCAN STRATEGY — checks the entire comment, not just the start:
 *
 *  Pass 1 — start-of-string patterns (highest confidence):
 *    "A6 ICN Creation..."       → "A6"
 *    "A6Hi Jeff..."             → "A6"  (code immediately followed by letter, no space)
 *    "T1Hi Team..."             → "T1"
 *    "M15Hi Kim..."             → "M15"
 *    "TREX..." / "TReX..."      → "T1"  (literal TReX process marker)
 *
 *  Pass 2 — code anywhere in comment (preceded by word-break characters):
 *    "closing this request -A8 ICN Update"   → "A8"
 *    "Hello Manuel. A8 ICN Update..."        → "A8"
 *    "completed.\nA6 - site updated"         → "A6"
 *
 *  Allowlist guard: candidate must be in the DB reason_codes table to avoid
 *  false positives on tokens like "ICN#", "ESA", "CL2", "PO42", "SW-US...".
 *
 * @param lastComment  Raw Last Comment text from EngageSupport
 * @param validCodes   Set of valid reason_code strings (uppercase) from DB
 */
function extractReasonCode(
  lastComment: string | null,
  validCodes: Set<string>,
): string | null {
  if (!lastComment) return null;
  const s = lastComment.trim();

  // ── Pass 0: literal TReX marker (must be checked before code scan) ──────
  if (/^TReX\b/i.test(s) || /\bTReX\b/i.test(s)) return 'T1';

  // ── Build the global scan regex from the valid-code allowlist ────────────
  // Sort longest-first so "M12" matches before "M1" on the same position.
  // Pattern: (?:^|[\s\-.,;:/\\()\[\]"'!?]) + CODE + (?=\W|$)
  // This means the code must be preceded by a word-break char (or start of
  // string) and followed by a non-word char or end-of-string.
  const sorted = [...validCodes].sort((a, b) => b.length - a.length);
  const altPattern = sorted.join('|');

  // Regex explanation:
  //   (?:^|[\s\-.,;:/\\()\[\]"'!?\n]) — word-break before the code
  //   (A6|M12|T1|...)                  — the allowlisted code (longest first)
  //   (?=[^A-Za-z0-9]|$)              — must NOT be immediately followed by
  //                                      more letters/digits (avoids "A6Hi"
  //                                      matching as A6 mid-word when scanning
  //                                      body — but pass-1 below handles that
  //                                      for start-of-comment)
  const bodyRe = new RegExp(
    `(?:^|[\\s\\-.,;:/\\\\()\\[\\]"'!?\n\r])(${altPattern})(?=[^A-Za-z0-9]|$)`,
    'i',
  );

  // ── Pass 1: start-of-comment — code may run directly into text ("A6Hi") ─
  // Grab up to 2 uppercase letters then 1–3 digits at the very start.
  const startM = s.match(/^([A-Z]{1,2})(\d{1,3})/);
  if (startM) {
    const candidate = (startM[1] + startM[2]).toUpperCase();
    if (validCodes.has(candidate)) return candidate;
  }

  // ── Pass 2: scan entire comment for code preceded by a word-break char ──
  const bodyM = s.match(bodyRe);
  if (bodyM) {
    // bodyM[1] is the captured code group
    return bodyM[1].toUpperCase();
  }

  return null;
}

/** Format ISO date string to "Jan", "Feb", ... "Dec" */
function toMonthAbbr(isoDate: string | null): string | null {
  if (!isoDate) return null;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  try {
    const d = new Date(isoDate);
    if (isNaN(d.getTime())) return null;
    return months[d.getUTCMonth()];
  } catch { return null; }
}

/** Format ISO date string to "YYYY-MM" */
function toYearMonth(isoDate: string | null): string | null {
  if (!isoDate) return null;
  try {
    const d = new Date(isoDate);
    if (isNaN(d.getTime())) return null;
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  } catch { return null; }
}

/** Format ISO date string to "YYYY-Qn" */
function toYearQuarter(isoDate: string | null): string | null {
  if (!isoDate) return null;
  try {
    const d = new Date(isoDate);
    if (isNaN(d.getTime())) return null;
    const q = Math.ceil((d.getUTCMonth() + 1) / 3);
    return `${d.getUTCFullYear()}-Q${q}`;
  } catch { return null; }
}

/** Format ISO date to ISO week "YYYY-Www" */
function toWeek(isoDate: string | null): string | null {
  if (!isoDate) return null;
  try {
    const d = new Date(isoDate);
    if (isNaN(d.getTime())) return null;
    const jan4 = new Date(d.getUTCFullYear(), 0, 4);
    const dayOfYear = Math.floor((d.getTime() - new Date(d.getUTCFullYear(), 0, 0).getTime()) / 86400000);
    const week = Math.ceil((dayOfYear + jan4.getDay()) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  } catch { return null; }
}

/** Hours between two ISO strings. Returns null if either is null/invalid. */
function hoursBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  try {
    const diff = new Date(to).getTime() - new Date(from).getTime();
    if (isNaN(diff)) return null;
    return diff / 3_600_000;
  } catch { return null; }
}

/** Normalize email for case-insensitive lookup */
function normalizeEmail(email: string | null): string | null {
  return email?.trim().toLowerCase() ?? null;
}

/** Extract the email portion from "Firstname Lastname/Location/IBM" or return as-is if already an email */
function emailFromRaw(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  // Already an email
  if (s.includes('@')) return s.toLowerCase();
  // "Name/Location/IBM" — not directly usable as email
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build lookup maps from DB
// ─────────────────────────────────────────────────────────────────────────────
interface ReasonCodeRow { reason_code: string; sub_process: string; process: string; complexity: string; weight: number; effective_date: string; }
interface SquadMemberRow { email: string; email_raw: string; name: string; }
interface ManualClassRow { request_number: string; sub_process: string; process: string; complexity: string; weight: number; }

/**
 * Build a reason-code map that is date-aware.
 * For each unique reason_code, keeps the row with the LATEST effective_date
 * that is ≤ the provided reference date (or latest overall if no date given).
 * This means March+ codes override Jan/Feb codes for the same code letter.
 */
function buildReasonCodeMap(
  db: Database.Database,
  referenceDate?: string,
): Map<string, ReasonCodeRow> {
  // Pull all active rows ordered newest-first so we can just take first match
  const rows = db.prepare(
    `SELECT * FROM reason_codes WHERE active = 1 ORDER BY effective_date DESC, reason_code ASC`
  ).all() as ReasonCodeRow[];

  const map = new Map<string, ReasonCodeRow>();
  for (const r of rows) {
    const key = r.reason_code.toUpperCase();
    if (map.has(key)) continue; // already have a newer (or equal) effective_date row
    // If referenceDate provided, only use rows with effective_date ≤ referenceDate
    if (referenceDate && r.effective_date > referenceDate) continue;
    map.set(key, r);
  }
  return map;
}

/**
 * Build a map of manual classification overrides: request_number → classification.
 * These take precedence over reason-code lookup.
 */
function buildManualOverrideMap(db: Database.Database): Map<string, ManualClassRow> {
  const rows = db.prepare('SELECT * FROM manual_classifications').all() as ManualClassRow[];
  const map = new Map<string, ManualClassRow>();
  for (const r of rows) map.set(r.request_number.trim(), r);
  return map;
}

function buildSquadMemberMap(db: Database.Database): Map<string, string> {
  // Maps lowercase email → display name
  const rows = db.prepare('SELECT email, email_raw, name FROM squad_members WHERE active = 1').all() as SquadMemberRow[];
  const map = new Map<string, string>();
  for (const r of rows) {
    map.set(r.email.toLowerCase(), r.name);
    if (r.email_raw) map.set(r.email_raw.toLowerCase(), r.name);
  }
  return map;
}

function lookupMember(raw: string | null, memberMap: Map<string, string>): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  // Try direct email lookup
  if (memberMap.has(s)) return memberMap.get(s) ?? null;
  // Try email extracted from "Name/Location/IBM" pattern
  const email = emailFromRaw(raw);
  if (email && memberMap.has(email)) return memberMap.get(email) ?? null;
  // Try email_raw exact match
  if (memberMap.has(s)) return memberMap.get(s) ?? null;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Weighted Volume transform
// ─────────────────────────────────────────────────────────────────────────────

/** TReX fallback: requests with "Shipment / Delivery" type and no code match */
const TREX_FALLBACK: Pick<ReasonCodeRow, 'sub_process'|'process'|'complexity'|'weight'> = {
  sub_process: 'TReX',
  process:     'TReX',
  complexity:  'Less Complex',
  weight:      1.0,
};

export function transformWeightedVolume(): number {
  const db = getDb();

  // Build a single "latest" reason-code map using today as the reference ceiling
  // so we always use the most up-to-date effective block available.
  const today = new Date().toISOString().slice(0, 10);

  // Always refresh the valid-code cache when a full re-transform is triggered
  // (handles cases where reason codes were updated between runs)
  _validCodeSet = null;
  const validCodes  = getValidCodeSet(db);
  const rcMap       = buildReasonCodeMap(db, today);
  const overrideMap = buildManualOverrideMap(db);
  const memberMap   = buildSquadMemberMap(db);

  // Read canonical (deduped) requests
  const requests = db.prepare('SELECT * FROM requests').all() as Record<string, unknown>[];

  const upsert = db.prepare(`
    INSERT INTO weighted_volume (
      request_number, customer_name, enterprise_number, engagement_number,
      request_type, accelerate, request_title, squad_id, squad_name, squad_group_name,
      multi_unit, request_comment, last_comment, submitter, requester,
      latest_update, submission_date, status, assign_to, assign_to_org,
      needed_by, close_date, opportunity_num, opp_description,
      market, country, unit, sub_unit, sector, channel, deal_desk, program_type,
      blue_group, currency, tcv_billing_amount,
      sub_process, process, complexity, weight, team_member, month,
      updated_at
    ) VALUES (
      @request_number, @customer_name, @enterprise_number, @engagement_number,
      @request_type, @accelerate, @request_title, @squad_id, @squad_name, @squad_group_name,
      @multi_unit, @request_comment, @last_comment, @submitter, @requester,
      @latest_update, @submission_date, @status, @assign_to, @assign_to_org,
      @needed_by, @close_date, @opportunity_num, @opp_description,
      @market, @country, @unit, @sub_unit, @sector, @channel, @deal_desk, @program_type,
      @blue_group, @currency, @tcv_billing_amount,
      @sub_process, @process, @complexity, @weight, @team_member, @month,
      datetime('now')
    )
    ON CONFLICT(request_number) DO UPDATE SET
      sub_process=excluded.sub_process, process=excluded.process,
      complexity=excluded.complexity, weight=excluded.weight,
      team_member=excluded.team_member, month=excluded.month,
      status=excluded.status, close_date=excluded.close_date,
      latest_update=excluded.latest_update, updated_at=datetime('now')
  `);

  db.prepare('DELETE FROM weighted_volume').run();

  let count = 0;
  const run = db.transaction(() => {
    for (const req of requests) {
      const reqNum      = String(req.request_number ?? '').trim();
      const requestType = (req.request_type as string | null) ?? '';

      // ── Priority 1: manual override from UI ─────────────────────────────
      const manualRow = overrideMap.get(reqNum);

      // ── Priority 2: reason-code lookup from Last Comment ─────────────────
      // Scans the ENTIRE comment (not just the start) using the allowlist.
      const rc    = extractReasonCode(req.last_comment as string | null, validCodes);
      const rcRow = !manualRow && rc ? rcMap.get(rc) : undefined;

      // ── Priority 3: TReX fallback for Shipment/Delivery requests ─────────
      const useTrex = !manualRow && !rcRow && /shipment|delivery/i.test(requestType);

      const classification = manualRow ?? rcRow ?? (useTrex ? TREX_FALLBACK : undefined);

      const member = lookupMember(req.assign_to as string | null, memberMap);
      const month  = toMonthAbbr(req.close_date as string | null);

      upsert.run({
        request_number:    reqNum,
        customer_name:     req.customer_name ?? null,
        enterprise_number: req.enterprise_number ?? null,
        engagement_number: req.engagement_number ?? null,
        request_type:      req.request_type ?? null,
        accelerate:        req.accelerate ?? null,
        request_title:     req.request_title ?? null,
        squad_id:          req.squad_id ?? null,
        squad_name:        req.squad_name ?? null,
        squad_group_name:  req.squad_group_name ?? null,
        multi_unit:        req.multi_unit ?? null,
        request_comment:   req.request_comment ?? null,
        last_comment:      req.last_comment ?? null,
        submitter:         req.submitter ?? null,
        requester:         req.requester ?? null,
        latest_update:     req.latest_update ?? null,
        submission_date:   req.submission_date ?? null,
        status:            req.status ?? null,
        assign_to:         req.assign_to ?? null,
        assign_to_org:     req.assign_to_organization ?? null,
        needed_by:         req.needed_by ?? null,
        close_date:        req.close_date ?? null,
        opportunity_num:   req.opportunity_num ?? null,
        opp_description:   req.opp_description ?? null,
        market:            req.market ?? null,
        country:           req.country ?? null,
        unit:              req.unit ?? null,
        sub_unit:          req.sub_unit ?? null,
        sector:            req.sector ?? null,
        channel:           req.channel ?? null,
        deal_desk:         req.deal_desk ?? null,
        program_type:      req.program_type ?? null,
        blue_group:        req.blue_group ?? null,
        currency:          req.currency ?? null,
        tcv_billing_amount: req.tcv_billing_amount ?? null,
        sub_process:  classification?.sub_process ?? null,
        process:      classification?.process     ?? null,
        complexity:   classification?.complexity  ?? null,
        weight:       classification?.weight      ?? null,
        team_member:  member,
        month,
      });
      count++;
    }
  });
  run();
  logger.info(`[transform] Weighted Volume: ${count} rows computed.`);
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// M&I transform
// ─────────────────────────────────────────────────────────────────────────────
export function transformMiData(): number {
  const db = getDb();
  const memberMap = buildSquadMemberMap(db);
  const requests = db.prepare('SELECT * FROM requests').all() as Record<string, unknown>[];

  db.prepare('DELETE FROM mi_data').run();

  const upsert = db.prepare(`
    INSERT INTO mi_data (
      request_number, geo, market, country, major_unit, unit, sub_unit, channel,
      engagement_option, request_group, request_type, deal_desk, customer_name,
      global_buying_group, opp, opportunity_owner, tcv, curr, submitter,
      submitter_main_role_cat, requester, center, link_to_es, title,
      squad_group, squad, squad_tier, request_owner, req_owner_bp_manager,
      req_owner_func_manager, status, sub_status, sector, program_type,
      sr_source, is_backdated, sr_received_date, submit_date, ym_open, yq_open,
      first_in_process_date, due_date, close_date, week_close, ym_close, yq_close,
      ct_days, ct_in_days, generic_request_ind, incomplete_request_ind,
      request_assign_count, ct_hours, assign_time_hours, funnel_hours,
      wait_hours, squad_hours, squad_member, month, updated_at
    ) VALUES (
      @request_number, @geo, @market, @country, @major_unit, @unit, @sub_unit, @channel,
      @engagement_option, @request_group, @request_type, @deal_desk, @customer_name,
      @global_buying_group, @opp, @opportunity_owner, @tcv, @curr, @submitter,
      @submitter_main_role_cat, @requester, @center, @link_to_es, @title,
      @squad_group, @squad, @squad_tier, @request_owner, @req_owner_bp_manager,
      @req_owner_func_manager, @status, @sub_status, @sector, @program_type,
      @sr_source, @is_backdated, @sr_received_date, @submit_date, @ym_open, @yq_open,
      @first_in_process_date, @due_date, @close_date, @week_close, @ym_close, @yq_close,
      @ct_days, @ct_in_days, @generic_request_ind, @incomplete_request_ind,
      @request_assign_count, @ct_hours, @assign_time_hours, @funnel_hours,
      @wait_hours, @squad_hours, @squad_member, @month, datetime('now')
    )
    ON CONFLICT(request_number) DO UPDATE SET
      ct_hours=excluded.ct_hours, ct_days=excluded.ct_days,
      squad_member=excluded.squad_member, month=excluded.month,
      updated_at=datetime('now')
  `);

  let count = 0;
  const run = db.transaction(() => {
    for (const req of requests) {
      const submitDate  = req.submission_date as string | null;
      const closeDate   = req.close_date as string | null;
      const assignDate  = req.latest_update as string | null; // proxy for first-in-process

      // CT Hours = total calendar hours from submission to close
      const ctHours = hoursBetween(submitDate, closeDate);
      const ctDays  = ctHours !== null ? Math.round(ctHours / 24 * 100) / 100 : null;

      // Funnel Hours = time from submission to first assignment (proxy: same, 0 if same day)
      const funnelHours = hoursBetween(submitDate, assignDate);
      // Squad Hours = time from assignment to close
      const squadHours = hoursBetween(assignDate, closeDate);
      // Wait Hours = 0 (not derivable from available data without intermediate states)
      const waitHours = 0;
      // Assign Time = same as funnel for now
      const assignTimeHours = funnelHours;

      const ctInDays = ctDays !== null
        ? (ctDays <= 1 ? '<=1' : ctDays <= 3 ? '>1,<=3' : ctDays <= 5 ? '>3,<=5' : ctDays <= 10 ? '>5,<=10' : '>10')
        : null;

      // Is Backdated: close_date < submission_date or submission_date is same as close_date
      let isBackdated = 'N';
      if (submitDate && closeDate) {
        const sub = new Date(submitDate).getTime();
        const cls = new Date(closeDate).getTime();
        if (sub >= cls) isBackdated = 'Y';
      }

      const member = lookupMember(req.assign_to as string | null, memberMap);
      const month  = toMonthAbbr(closeDate);
      const ymOpen  = toYearMonth(submitDate);
      const yqOpen  = toYearQuarter(submitDate);
      const ymClose = toYearMonth(closeDate);
      const yqClose = toYearQuarter(closeDate);
      const weekClose = toWeek(closeDate);

      // Request URL
      const reqNum = String(req.request_number ?? '');
      const linkToEs = reqNum
        ? `https://engage-support.ibm.com/#serviceRequest/${reqNum}/requestDetails/generalInformation`
        : null;

      // Engagement Option — derived from Request Type
      const requestType = (req.request_type as string | null) ?? '';
      let engagementOption = 'Post-Sales Support';
      if (/bid/i.test(requestType)) engagementOption = 'Bid Support';
      else if (/renewal|quote/i.test(requestType)) engagementOption = 'Renewal';

      // Request Group — derived from Request Type
      let requestGroup = 'Customer Data Management';
      if (/shipment|delivery/i.test(requestType)) requestGroup = 'Shipping';
      else if (/billing|invoic/i.test(requestType)) requestGroup = 'Billing & Invoicing';
      else if (/contract|order/i.test(requestType)) requestGroup = 'Contract / Order Registration';
      else if (/bid/i.test(requestType)) requestGroup = 'Bid Support';

      upsert.run({
        request_number: req.request_number,
        geo:            req.geo ?? null,
        market:         req.market ?? null,
        country:        req.country ?? null,
        major_unit:     req.unit ?? null,
        unit:           req.unit ?? null,
        sub_unit:       req.sub_unit ?? null,
        channel:        req.channel === 'DIR' ? 'Direct' : req.channel === 'BP' ? 'Business Partner' : req.channel ?? null,
        engagement_option: engagementOption,
        request_group:  requestGroup,
        request_type:   req.request_type ?? null,
        deal_desk:      req.deal_desk === 'STD' ? 'Standard' : req.deal_desk ?? null,
        customer_name:  req.customer_name ?? null,
        global_buying_group: req.gbg ?? 'N/A',
        opp:            req.opportunity_num ?? 'N/A',
        opportunity_owner: req.requester_id ?? null,
        tcv:            req.tcv_billing_amount ?? 0,
        curr:           req.currency ?? null,
        submitter:      req.submitter ?? null,
        submitter_main_role_cat: 'STS',
        requester:      req.requester ?? null,
        center:         'Quezon City',
        link_to_es:     linkToEs,
        title:          req.request_title ?? null,
        squad_group:    req.squad_group_name ?? null,
        squad:          req.squad_name ?? null,
        squad_tier:     'Tier 3',
        request_owner:  req.assign_to ?? null,
        req_owner_bp_manager:   null,
        req_owner_func_manager: null,
        status:         req.status ?? null,
        sub_status:     req.status ?? null,
        sector:         req.sector ?? null,
        program_type:   req.program_type ?? null,
        sr_source:      req.source ?? null,
        is_backdated:   isBackdated,
        sr_received_date:     null,
        submit_date:    submitDate,
        ym_open:        ymOpen,
        yq_open:        yqOpen,
        first_in_process_date: assignDate,
        due_date:       req.needed_by ?? null,
        close_date:     closeDate,
        week_close:     weekClose,
        ym_close:       ymClose,
        yq_close:       yqClose,
        ct_days:        ctDays,
        ct_in_days:     ctInDays,
        generic_request_ind:     isBackdated,
        incomplete_request_ind:  'N',
        request_assign_count:    0,
        ct_hours:        ctHours,
        assign_time_hours: assignTimeHours,
        funnel_hours:    funnelHours,
        wait_hours:      waitHours,
        squad_hours:     squadHours,
        squad_member:    member,
        month,
      });
      count++;
    }
  });
  run();
  logger.info(`[transform] M&I Data: ${count} rows computed.`);
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// NPS transform
// ─────────────────────────────────────────────────────────────────────────────
export function transformNpsData(): number {
  const db = getDb();
  const memberMap = buildSquadMemberMap(db);

  // Build request# → assign_to map from canonical requests
  const reqRows = db.prepare('SELECT request_number, assign_to FROM requests').all() as { request_number: string; assign_to: string | null }[];
  const reqAssignMap = new Map<string, string | null>();
  for (const r of reqRows) reqAssignMap.set(r.request_number.trim(), r.assign_to);

  // Only process NPS rows that belong to our squad. The OpDashboard export covers
  // the whole squad group (e.g. "AG SW II"), so rows for other squads like
  // NA-MKTCT-CLOUD-SVS can be present. Filter to SQUAD_GROUP env var or default.
  //
  // Deduplicate at query time: the UNIQUE constraint on raw_nps is (feedback_id,
  // ingestion_id), so the same feedback row from multiple ingestion files each
  // get their own raw_nps row. We collapse them here by taking one representative
  // per distinct feedback_id (or per rated_date+request_number+submitter for rows
  // without a feedback_id), so transformNpsData stays O(distinct feedbacks).
  const targetSquad = process.env.SQUAD_GROUP ?? 'NAUS-CFCT-SW-2';
  const npsRows = db.prepare(`
    SELECT * FROM raw_nps
    WHERE id IN (
      SELECT MIN(id) FROM raw_nps
      WHERE (squad IS NULL OR squad = ?)
      GROUP BY
        CASE WHEN feedback_id IS NOT NULL AND feedback_id != '' THEN feedback_id
             ELSE (rated_date || '|' || COALESCE(request_number,'') || '|' || COALESCE(feedback_submitter,''))
        END
    )
  `).all(targetSquad) as Record<string, unknown>[];
  logger.info(`[transform] NPS: processing ${npsRows.length} deduplicated rows for squad=${targetSquad}`);

  db.prepare('DELETE FROM nps_data').run();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO nps_data (
      month, rated_date, rating, request_number, csr_email, original_comment,
      team_member, definition, promoter, detractor, passive, total, nps_rating, updated_at
    ) VALUES (
      @month, @rated_date, @rating, @request_number, @csr_email, @original_comment,
      @team_member, @definition, @promoter, @detractor, @passive, @total, @nps_rating, datetime('now')
    )
  `);

  let count = 0;
  const run = db.transaction(() => {
    for (const row of npsRows) {
      const rating = Number(row.rating ?? 0);
      const ratedDate = row.rated_date as string | null;
      const month = toMonthAbbr(ratedDate);

      // NPS classification
      let definition = 'Passive';
      let promoter = 0, detractor = 0, passive = 0;
      if (rating >= 9)      { definition = 'Promoters'; promoter = 1; }
      else if (rating <= 6) { definition = 'Detractors'; detractor = 1; }
      else                  { definition = 'Passive'; passive = 1; }

      // NPS Rating per row: Promoter=100, Detractor=-100, Passive=0 (individual)
      // Aggregate NPS computed at query time: (Promoters - Detractors) / Total * 100
      const npsRating = promoter ? 100 : detractor ? -100 : 0;

      // Resolve Team Member:
      // NPS request_number may have suffix (-12, -13, etc.) — try exact, then strip suffix
      const reqNum = String(row.request_number ?? '').trim();
      let assignTo = reqAssignMap.get(reqNum) ?? null;
      if (!assignTo) {
        // Try stripping trailing suffix e.g. "23092912596693-12" → look for base
        const base = reqNum.replace(/-\d+$/, '');
        for (const [key, val] of reqAssignMap) {
          if (key.includes(base) || base.includes(key.replace(/-\d+$/, ''))) {
            assignTo = val;
            break;
          }
        }
      }
      const teamMember = lookupMember(assignTo, memberMap);

      insert.run({
        month,
        rated_date:       ratedDate,
        rating,
        request_number:   reqNum,
        csr_email:        row.feedback_submitter as string | null,
        original_comment: row.original_comment as string | null,
        team_member:      teamMember,
        definition,
        promoter,
        detractor,
        passive,
        total: 1,
        nps_rating: npsRating,
      });
      count++;
    }
  });
  run();

  // Re-apply manual member overrides so assignments set via the UI survive
  // re-ingestion / re-transforms. Matches on (request_number, rated_date).
  // COALESCE handles NPS rows where rated_date is NULL — the override stores ''.
  const overrideResult = db.prepare(`
    UPDATE nps_data
    SET team_member = (
      SELECT team_member FROM nps_member_overrides o
      WHERE o.request_number = nps_data.request_number
        AND o.rated_date      = COALESCE(nps_data.rated_date, '')
    )
    WHERE EXISTS (
      SELECT 1 FROM nps_member_overrides o
      WHERE o.request_number = nps_data.request_number
        AND o.rated_date      = COALESCE(nps_data.rated_date, '')
    )
  `).run();
  if (overrideResult.changes > 0) {
    logger.info(`[transform] NPS: re-applied ${overrideResult.changes} manual member override(s)`);
  }

  logger.info(`[transform] NPS Data: ${count} rows computed.`);
  return count;
}
