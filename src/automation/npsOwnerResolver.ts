/**
 * src/automation/npsOwnerResolver.ts
 *
 * Background resolver: finds NPS rows with no team_member, looks up each
 * request's "Assign to" (bidManagerId) from the EngageSupport ES API, adds any
 * unknown owners to squad_members, writes overrides to nps_member_overrides,
 * then re-runs transformNpsData() so the NPS table is immediately updated.
 *
 * Design principles
 * ─────────────────
 * • Pure HTTP — uses session cookies exactly like requestViewExtractor, no
 *   browser launched. If the session is expired the whole job is skipped.
 * • Fire-and-forget — callers do NOT await. All errors are caught internally.
 * • Concurrency-limited batches (BATCH_SIZE = 5, DELAY_MS = 500ms between
 *   batches) to avoid hammering the ES API.
 * • Idempotent — re-running is safe; overrides table uses INSERT OR REPLACE.
 * • Returns a result object so the server can broadcast progress via SSE.
 *
 * ES lookup endpoint (confirmed from live network capture, same as extractor):
 *   GET https://engage-support.ibm.com/elasticsearch/services/search
 *     ?query=true&page=1&size=1
 *     &q=request.generalInformation.requestIdAlias.keyword:"<ID>"
 *     &filterType=entitled&includeDraft=true
 *
 * Response: { count: N, hits: [ { request: { generalInformation: { bidManagerId, ... } } } ] }
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as https from 'https';
import { getDb } from '../db/schema';
import { transformNpsData } from '../pipeline/transform';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const ES_BASE      = 'https://engage-support.ibm.com/elasticsearch/services/search';
const GRID_URL     = 'https://engage-support.ibm.com/serviceRequestGrid';
const SESSION_PATH = process.env.SESSION_PATH ?? (() => {
  const p = path.resolve(process.cwd(), '../engagesupport-extractor/session/state.json');
  return fs.existsSync(p) ? p : path.resolve(process.cwd(), 'session/state.json');
})();

const BATCH_SIZE = 5;    // concurrent lookups per batch
const DELAY_MS   = 500;  // ms pause between batches

// ─────────────────────────────────────────────────────────────────────────────
// Public result type
// ─────────────────────────────────────────────────────────────────────────────
export interface NpsOwnerResolveResult {
  resolved:   number;  // rows that got a team_member set
  skipped:    number;  // request numbers with no assign_to in ES
  failed:     number;  // fetch/parse errors
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session helpers (mirrors requestViewExtractor — kept local to avoid coupling)
// ─────────────────────────────────────────────────────────────────────────────
interface PlCookie { name: string; value: string; domain: string }

function loadSessionCookies(): PlCookie[] {
  if (!fs.existsSync(SESSION_PATH)) return [];
  try {
    return (JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8')).cookies ?? []) as PlCookie[];
  } catch { return []; }
}

function cookieHeader(cookies: PlCookie[]): string {
  return cookies
    .filter(c => c.domain.includes('engage-support') || c.domain.includes('ibm.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Thin https GET wrapper (same as extractor)
// ─────────────────────────────────────────────────────────────────────────────
function httpsGet(url: string, cookieStr: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        Cookie:       cookieStr,
        Accept:       'application/json',
        'User-Agent': 'Mozilla/5.0',
        Referer:      GRID_URL,
        Origin:       'https://engage-support.ibm.com',
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch {
          reject(new Error(`JSON parse error (status ${res.statusCode}): ${Buffer.concat(chunks).toString().slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(new Error('Request timed out')); });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Single-request ES lookup — returns the bidManagerId or null
// ─────────────────────────────────────────────────────────────────────────────
async function lookupAssignTo(cookieStr: string, requestNumber: string): Promise<string | null> {
  // NPS request numbers come in two forms:
  //   1. Human-readable alias: "SW-US260518769863-1" → query requestIdAlias
  //   2. Numeric internal id:  "260518769863-1"       → query by id field
  // We strip the trailing "-N" suffix to get the base numeric id, then try both.

  const tryQuery = async (q: string): Promise<string | null> => {
    const url  = `${ES_BASE}?query=true&page=1&size=1&q=${q}&filterType=entitled&includeDraft=true`;
    const data = await httpsGet(url, cookieStr) as any;
    const hit  = Array.isArray(data?.hits) ? data.hits[0] : undefined;
    if (!hit) return null;
    const g = (hit.request ?? hit)?.generalInformation ?? {};
    return (g.bidManagerId as string | null | undefined) || null;
  };

  // Try 1: requestIdAlias (works for "SW-US..." style numbers)
  const aliasQ = `request.generalInformation.requestIdAlias.keyword%3A%22${encodeURIComponent(requestNumber)}%22`;
  const fromAlias = await tryQuery(aliasQ);
  if (fromAlias) return fromAlias;

  // Try 2: numeric internal id — strip trailing "-N" suffix to get base id
  // "260518769863-1" → base id "260518769863"
  const baseId = requestNumber.replace(/-\d+$/, '');
  if (baseId !== requestNumber) {
    const idQ = `request.generalInformation.id%3A${encodeURIComponent(baseId)}`;
    const fromId = await tryQuery(idQ);
    if (fromId) return fromId;
  }

  // Try 3: exact id match with suffix (some ES instances store the full "260518769863-1")
  const fullIdQ = `request.generalInformation.id%3A%22${encodeURIComponent(requestNumber)}%22`;
  return await tryQuery(fullIdQ);
}

// ─────────────────────────────────────────────────────────────────────────────
// Name derivation from email/raw strings
// ─────────────────────────────────────────────────────────────────────────────

/** Extract email from IBM "Name/Location/IBM" format or return raw if already an email */
function extractEmail(raw: string): string {
  if (!raw) return raw;
  // "Elizabeth De Guzman/Philippines/IBM" → email not derivable from this alone
  // "elizabeth.deguzman@ibm.com" → return as-is
  if (raw.includes('@')) return raw.trim().toLowerCase();
  return raw.trim();
}

/** Derive a display name from an email — "alexander.gabon@ibm.com" → "Alexander Gabon" */
function emailToDisplayName(email: string): string {
  const local = email.split('@')[0];                       // "alexander.gabon"
  return local
    .split(/[._-]/)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main exported function
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Resolves unassigned NPS team_member fields via ES API lookups.
 *
 * MUST be called with `resolveNpsOwners().catch(...)` — it returns a Promise
 * but callers should fire-and-forget so ingestion is not blocked.
 */
export async function resolveNpsOwners(): Promise<NpsOwnerResolveResult> {
  const start = Date.now();
  let resolved = 0, skipped = 0, failed = 0;

  // ── Session check ────────────────────────────────────────────────────────
  const cookies   = loadSessionCookies();
  const cookieStr = cookieHeader(cookies);
  if (!cookieStr) {
    logger.warn('[npsResolver] No session cookies — skipping owner resolution. Run extraction first to authenticate.');
    return { resolved: 0, skipped: 0, failed: 0, durationMs: Date.now() - start };
  }

  // ── Collect unresolved request numbers ──────────────────────────────────
  const db = getDb();
  const unresolved = db.prepare(`
    SELECT DISTINCT request_number
    FROM nps_data
    WHERE (team_member IS NULL OR team_member = '')
      AND request_number IS NOT NULL
      AND request_number != ''
  `).all() as { request_number: string }[];

  if (unresolved.length === 0) {
    logger.info('[npsResolver] No unresolved NPS request owners — nothing to do.');
    return { resolved: 0, skipped: 0, failed: 0, durationMs: Date.now() - start };
  }

  logger.info(`[npsResolver] Resolving ${unresolved.length} unassigned NPS request number(s)...`);

  // ── Squad member map for name lookups ────────────────────────────────────
  const memberRows = db.prepare(
    'SELECT email, email_raw, name FROM squad_members WHERE active = 1'
  ).all() as { email: string; email_raw: string | null; name: string }[];
  const memberMap = new Map<string, string>();
  for (const m of memberRows) {
    memberMap.set(m.email.toLowerCase(), m.name);
    if (m.email_raw) memberMap.set(m.email_raw.toLowerCase(), m.name);
  }

  // ── Process in batches ───────────────────────────────────────────────────
  const upsertOverride = db.prepare(`
    INSERT INTO nps_member_overrides (request_number, rated_date, team_member, overridden_at)
    SELECT nd.request_number, COALESCE(nd.rated_date, ''), ?, datetime('now')
    FROM nps_data nd
    WHERE nd.request_number = ?
      AND (nd.team_member IS NULL OR nd.team_member = '')
    ON CONFLICT(request_number, rated_date) DO UPDATE SET
      team_member   = excluded.team_member,
      overridden_at = excluded.overridden_at
  `);

  const addMember = db.prepare(`
    INSERT OR IGNORE INTO squad_members (email_raw, email, name)
    VALUES (?, ?, ?)
  `);

  for (let i = 0; i < unresolved.length; i += BATCH_SIZE) {
    const batch = unresolved.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async ({ request_number }) => {
      try {
        const assignTo = await lookupAssignTo(cookieStr, request_number);

        if (!assignTo) {
          logger.debug(`[npsResolver] ${request_number}: no assign_to in ES — skipping`);
          skipped++;
          return;
        }

        const emailKey  = extractEmail(assignTo);
        let displayName = memberMap.get(emailKey.toLowerCase()) ?? null;

        if (!displayName) {
          // Unknown member — derive a name from email and seed into squad_members
          // so future transforms pick it up automatically
          if (emailKey.includes('@')) {
            displayName = emailToDisplayName(emailKey);
            logger.info(`[npsResolver] New member discovered: ${emailKey} → "${displayName}" — adding to squad_members`);
            addMember.run(assignTo, emailKey, displayName);
            memberMap.set(emailKey.toLowerCase(), displayName);
          } else {
            // Format like "Name/Location/IBM" — use as display name directly
            displayName = assignTo.split('/')[0].trim();
            logger.info(`[npsResolver] ${request_number}: using raw assign_to as name: "${displayName}"`);
          }
        }

        // Upsert override for every unresolved nps_data row with this request_number
        const info = db.transaction(() => upsertOverride.run(displayName, request_number))();
        if ((info as any).changes > 0) {
          logger.info(`[npsResolver] ${request_number} → "${displayName}" (${(info as any).changes} row(s))`);
          resolved += (info as any).changes;
        } else {
          skipped++;
        }

      } catch (err) {
        logger.warn(`[npsResolver] ${request_number}: lookup failed — ${(err as Error).message}`);
        failed++;
      }
    }));

    // Pause between batches (skip delay after last batch)
    if (i + BATCH_SIZE < unresolved.length) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  // ── Re-apply all overrides into nps_data ─────────────────────────────────
  if (resolved > 0) {
    logger.info(`[npsResolver] Re-running transformNpsData() to apply ${resolved} resolved owner(s)...`);
    transformNpsData();
  }

  const durationMs = Date.now() - start;
  logger.info(`[npsResolver] Done — resolved: ${resolved}, skipped: ${skipped}, failed: ${failed} (${durationMs}ms)`);
  return { resolved, skipped, failed, durationMs };
}
