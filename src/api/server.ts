/**
 * src/api/server.ts
 *
 * Express API server for CMT Metrics Hub.
 * Port: 3001  (Phase 1 extractor runs on 3000)
 *
 * REST Endpoints:
 *   GET    /api/health                    — server + DB health
 *   GET    /api/status                    — ingestion summary + row counts
 *   GET    /api/ingestion/history         — ingestion log
 *   POST   /api/upload/request-view       — upload + ingest a Request View XLSX
 *   POST   /api/upload/nps                — upload + ingest an NPS Export XLSX
 *   POST   /api/ingest/request-view       — ingest a Request View XLSX by server path
 *   POST   /api/ingest/nps                — ingest an NPS Export XLSX by server path
 *   POST   /api/nps/extract               — trigger Playwright NPS automation
 *   POST   /api/nps/resolve-owners        — manually trigger background ES owner resolution
 *   POST   /api/request-view/extract      — trigger Request View extraction (returns jobId immediately)
 *   GET    /api/request-view/status/:id   — poll async extraction job state
 *   GET    /api/metrics/kpi               — dashboard KPI totals
 *   GET    /api/metrics/weighted-volume   — WV rows (filterable)
 *   GET    /api/metrics/mi                — M&I rows (filterable)
 *   GET    /api/metrics/nps               — NPS rows (filterable)
 *   GET    /api/metrics/by-member         — per-member summary
 *   GET    /api/metrics/by-month          — per-month summary
 *   GET    /api/metrics/uncategorized     — WV rows with null sub_process (paginated)
 *   POST   /api/metrics/classify          — save manual override + re-transform affected rows
 *   GET    /api/admin/squad-members       — list squad members
 *   POST   /api/admin/squad-members       — add squad member
 *   GET    /api/admin/reason-codes        — list reason codes
 *   GET    /api/export                    — generate + download XLSX export
 *   GET    /api/logs                      — in-memory log tail
 *   GET    /events                        — SSE real-time log stream
 *   DELETE /api/data/clear                — wipe metric data (scoped by mode)
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import multer from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { getDb } from '../db/schema';
import { seedSquadMembers, seedReasonCodes } from '../db/seeds';
import { ingestRequestView, ingestNpsExport } from '../pipeline/ingest';
import { exportMasterXlsx } from '../pipeline/exportXlsx';
import { extractNpsExport } from '../automation/npsExtractor';
import { extractRequestView, RvProgressCallback } from '../automation/requestViewExtractor';
import { resolveNpsOwners } from '../automation/npsOwnerResolver';
import { transformWeightedVolume, transformMiData, transformNpsData } from '../pipeline/transform';
import { logger, getLogBuffer } from '../utils/logger';

const PORT         = parseInt(process.env.PORT ?? '3001', 10);
const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
const UPLOAD_DIR   = process.env.OUTPUT_DIR ?? path.resolve(__dirname, '../../data/downloads');

// multer: save uploaded XLSX files to UPLOAD_DIR with their original name
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      cb(null, UPLOAD_DIR);
    },
    filename: (_req, file, cb) => {
      // Prefix with timestamp to avoid collisions
      const ts = new Date().toISOString().replace(/[:.]/g, '_');
      cb(null, `${ts}_${file.originalname}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    if (file.originalname.endsWith('.xlsx')) cb(null, true);
    else cb(new Error('Only .xlsx files are accepted'));
  },
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

// ─────────────────────────────────────────────────────────────────────────────
// SSE client registry
// ─────────────────────────────────────────────────────────────────────────────
const sseClients = new Set<Response>();

// ─────────────────────────────────────────────────────────────────────────────
// In-memory job store for async Request View extraction jobs
// Keys: jobId (rv_<timestamp>)
// Values: { status, extract?, ingest?, error?, startedAt, finishedAt? }
// ─────────────────────────────────────────────────────────────────────────────
const rvJobStore = new Map<string, Record<string, unknown>>();

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// Patch logger to also push to SSE
const origInfo  = logger.info.bind(logger);
const origWarn  = logger.warn.bind(logger);
const origError = logger.error.bind(logger);
(logger as any).info  = (msg: string, ...args: unknown[]) => { origInfo(msg, ...args);  broadcast('log', { level: 'info',  msg }); };
(logger as any).warn  = (msg: string, ...args: unknown[]) => { origWarn(msg, ...args);  broadcast('log', { level: 'warn',  msg }); };
(logger as any).error = (msg: string, ...args: unknown[]) => { origError(msg, ...args); broadcast('log', { level: 'error', msg }); };

// ─────────────────────────────────────────────────────────────────────────────
// App factory
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Filter clause helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a quarter token like "2026-Q1" into the three YYYY-MM strings it covers.
 * Returns null if the token is not a valid quarter.
 */
function quarterMonths(q: string): string[] | null {
  const m = q.match(/^(\d{4})-Q([1-4])$/i);
  if (!m) return null;
  const year = m[1];
  const qNum = parseInt(m[2], 10);
  const startMonth = (qNum - 1) * 3 + 1;
  return [startMonth, startMonth + 1, startMonth + 2]
    .map((mo) => `${year}-${String(mo).padStart(2, '0')}`);
}

/**
 * Build a WHERE fragment for a date column given the active period filters.
 * Precedence: quarter > year > yearMonth > (nothing).
 *   quarter   → "2026-Q1"  → col IN ('2026-01','2026-02','2026-03')
 *   year      → "2026"     → substr(col,1,4) = '2026'
 *   yearMonth → "2026-05"  → substr(col,1,7) = '2026-05'
 */
function periodClause(col: string, quarter?: string, yearMonth?: string, year?: string): string | null {
  if (quarter) {
    const months = quarterMonths(quarter);
    if (months) return `substr(${col},1,7) IN ('${months.join("','")}')`;
  }
  if (year && /^\d{4}$/.test(year)) return `substr(${col},1,4) = '${year}'`;
  if (yearMonth) return `substr(${col},1,7) = '${yearMonth}'`;
  return null;
}

/**
 * Build a WHERE fragment for a team_member column given one or more member names.
 * Accepts a single string or an array (from repeated ?member=A&member=B).
 * Sanitizes by escaping single quotes.
 */
function memberClause(col: string, member: string | string[] | undefined): string | null {
  if (!member) return null;
  const names = (Array.isArray(member) ? member : [member])
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/'/g, "''"));
  if (names.length === 0) return null;
  if (names.length === 1) return `${col} = '${names[0]}'`;
  return `${col} IN ('${names.join("','")}')`;
}

export function createApp(): express.Application {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  // Serve frontend static files
  if (fs.existsSync(FRONTEND_DIR)) {
    app.use(express.static(FRONTEND_DIR));
  }

  // ── SSE endpoint ───────────────────────────────────────────────────────────
  app.get('/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  // ── Health ─────────────────────────────────────────────────────────────────
  app.get('/api/health', (_req: Request, res: Response) => {
    try {
      const db = getDb();
      const { count } = db.prepare('SELECT COUNT(*) AS count FROM requests').get() as { count: number };
      res.json({ status: 'ok', requests: count, ts: new Date().toISOString() });
    } catch (e) {
      res.status(500).json({ status: 'error', error: (e as Error).message });
    }
  });

  // ── Status summary ─────────────────────────────────────────────────────────
  app.get('/api/status', (_req: Request, res: Response) => {
    try {
      const db = getDb();
      const requests  = (db.prepare('SELECT COUNT(*) AS c FROM requests').get() as {c:number}).c;
      const wv        = (db.prepare('SELECT COUNT(*) AS c FROM weighted_volume').get() as {c:number}).c;
      const mi        = (db.prepare('SELECT COUNT(*) AS c FROM mi_data').get() as {c:number}).c;
      const nps       = (db.prepare('SELECT COUNT(*) AS c FROM nps_data').get() as {c:number}).c;
      const lastIngest = db.prepare(
        "SELECT * FROM ingestion_log ORDER BY ingested_at DESC LIMIT 1"
      ).get() as Record<string,unknown> | undefined;

      res.json({ requests, weighted_volume: wv, mi_data: mi, nps_data: nps, last_ingestion: lastIngest ?? null });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Ingestion History ──────────────────────────────────────────────────────
  app.get('/api/ingestion/history', (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM ingestion_log ORDER BY ingested_at DESC LIMIT 100').all();
    res.json(rows);
  });

  // ── Upload + Ingest Request View XLSX ─────────────────────────────────────
  app.post('/api/upload/request-view', upload.single('file'), (req: Request, res: Response) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const filePath = req.file.path;
    logger.info(`[api] Upload + Ingest Request View: ${req.file.originalname}`);
    broadcast('status', { type: 'ingest_start', source: 'request_view', file: req.file.originalname });
    const result = ingestRequestView(filePath);
    broadcast('status', { type: 'ingest_complete', ...result });
    return res.json(result);
  });

  // ── Upload + Ingest NPS Export XLSX ───────────────────────────────────────
  app.post('/api/upload/nps', upload.single('file'), (req: Request, res: Response) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const filePath = req.file.path;
    logger.info(`[api] Upload + Ingest NPS Export: ${req.file.originalname}`);
    broadcast('status', { type: 'ingest_start', source: 'nps_export', file: req.file.originalname });
    const result = ingestNpsExport(filePath);
    broadcast('status', { type: 'ingest_complete', ...result });
    return res.json(result);
  });

  // ── Ingest by server path (kept for backward-compat / automation use) ──────
  app.post('/api/ingest/request-view', (req: Request, res: Response) => {
    const { filePath } = req.body as { filePath?: string };
    if (!filePath) return res.status(400).json({ error: 'filePath required' });
    logger.info(`[api] Ingesting Request View: ${filePath}`);
    broadcast('status', { type: 'ingest_start', source: 'request_view', file: filePath });
    const result = ingestRequestView(filePath);
    broadcast('status', { type: 'ingest_complete', ...result });
    return res.json(result);
  });

  app.post('/api/ingest/nps', (req: Request, res: Response) => {
    const { filePath } = req.body as { filePath?: string };
    if (!filePath) return res.status(400).json({ error: 'filePath required' });
    logger.info(`[api] Ingesting NPS Export: ${filePath}`);
    broadcast('status', { type: 'ingest_start', source: 'nps_export', file: filePath });
    const result = ingestNpsExport(filePath);
    broadcast('status', { type: 'ingest_complete', ...result });
    return res.json(result);
  });

  // ── Trigger NPS Playwright extraction ─────────────────────────────────────
  app.post('/api/nps/extract', async (req: Request, res: Response) => {
    const { reportPeriod } = req.body as { reportPeriod?: string };
    logger.info(`[api] NPS extraction triggered. Period: ${reportPeriod ?? 'current'}`);
    broadcast('status', { type: 'nps_extract_start', reportPeriod });

    const result = await extractNpsExport(reportPeriod);
    broadcast('status', { type: 'nps_extract_complete', ...result });

    if (result.success && result.filePath) {
      const ingestResult = ingestNpsExport(result.filePath);
      broadcast('status', { type: 'ingest_complete', ...ingestResult });
      return res.json({ extract: result, ingest: ingestResult });
    }
    return res.status(result.success ? 200 : 500).json(result);
  });

  // ── Manually trigger NPS owner resolution ─────────────────────────────────
  // Returns { jobId } immediately; resolveNpsOwners runs in the background and
  // broadcasts nps_resolve_complete when done.
  app.post('/api/nps/resolve-owners', (_req: Request, res: Response) => {
    const jobId = `npsresolve_${Date.now()}`;
    res.json({ jobId, status: 'started' });
    broadcast('status', { type: 'nps_resolve_start', jobId });

    resolveNpsOwners()
      .then((result) => {
        broadcast('status', { type: 'nps_resolve_complete', jobId, ...result });
        logger.info(`[api] NPS resolve done — resolved: ${result.resolved}, skipped: ${result.skipped}, failed: ${result.failed}`);
      })
      .catch((err: Error) => {
        logger.error(`[api] NPS resolve failed: ${err.message}`);
        broadcast('status', { type: 'nps_resolve_complete', jobId, resolved: 0, skipped: 0, failed: 1, error: err.message });
      });
  });

  // ── Trigger Request View extraction (async job) ────────────────────────────
  // Returns a jobId immediately; progress is streamed via SSE.
  // Poll GET /api/request-view/status/:jobId for the final result.
  app.post('/api/request-view/extract', (req: Request, res: Response) => {
    const { period, incremental } = req.body as { period?: string; incremental?: boolean };
    const jobId = `rv_${Date.now()}`;

    // If incremental mode, resolve the start date from the latest close_date in the DB
    let resolvedPeriod = period;
    if (incremental) {
      const db = getDb();
      const last = db.prepare(
        "SELECT MAX(close_date) AS d FROM weighted_volume WHERE close_date IS NOT NULL AND close_date != ''"
      ).get() as { d: string | null };
      if (last?.d) {
        // Use the day after the last close_date as the start of the incremental window
        const from = new Date(last.d);
        from.setDate(from.getDate() + 1);
        const todayDate = new Date();
        todayDate.setHours(0, 0, 0, 0);
        const toYMD = (d: Date) => d.toISOString().slice(0, 10);

        // If the DB is already current (last close_date = today or tomorrow), nothing to do
        if (from > todayDate) {
          logger.info('[api] Incremental sync: already up to date');
          return res.json({ jobId: null, status: 'up_to_date', message: `Already up to date (last close: ${last.d})` });
        }

        resolvedPeriod = `${toYMD(from)}:${toYMD(todayDate)}`;
        logger.info(`[api] Incremental mode: extracting from ${toYMD(from)} (last close: ${last.d})`);
      } else {
        logger.warn('[api] Incremental mode requested but no existing data — falling back to YTD');
      }
    }

    logger.info(`[api] Request View extraction triggered. Period: ${resolvedPeriod ?? 'YTD'} (job: ${jobId})`);

    // Respond immediately so the browser doesn't time out
    res.json({ jobId, status: 'started', period: resolvedPeriod ?? 'YTD' });

    // Run the potentially-long extraction + ingest in the background
    broadcast('status', { type: 'rv_extract_start', jobId, period: resolvedPeriod });
    rvJobStore.set(jobId, { status: 'running', startedAt: new Date().toISOString() });

    const onProgress: RvProgressCallback = (evt) => {
      const { type: evtType, ...evtRest } = evt;
      broadcast('status', { type: 'rv_progress', jobId, evtType, ...evtRest });
    };

    extractRequestView(resolvedPeriod, onProgress)
      .then((result) => {
        broadcast('status', { type: 'rv_extract_complete', jobId, ...result });

        if (result.success && result.filePath) {
          const ingestResult = ingestRequestView(result.filePath);
          rvJobStore.set(jobId, { status: 'done', extract: result, ingest: ingestResult, finishedAt: new Date().toISOString() });
          broadcast('status', { type: 'ingest_complete', jobId, ...ingestResult });
        } else {
          rvJobStore.set(jobId, { status: result.success ? 'done' : 'failed', extract: result, finishedAt: new Date().toISOString() });
        }
      })
      .catch((err: Error) => {
        const error = err.message;
        logger.error(`[api] Request View job ${jobId} failed: ${error}`);
        rvJobStore.set(jobId, { status: 'failed', error, finishedAt: new Date().toISOString() });
        broadcast('status', { type: 'rv_extract_complete', jobId, success: false, error });
      });
  });

  // ── Poll Request View job status ───────────────────────────────────────────
  app.get('/api/request-view/status/:jobId', (req: Request, res: Response) => {
    const job = rvJobStore.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    return res.json(job);
  });

  // ── KPI Dashboard Totals ───────────────────────────────────────────────────
  app.get('/api/metrics/kpi', (req: Request, res: Response) => {
    const { yearMonth, quarter, year } = req.query as Record<string, string>;
    const member = req.query['member'] as string | string[] | undefined;
    const db = getDb();

    const wvConds: string[] = [];
    const wvPeriod = periodClause('close_date', quarter, yearMonth, year);
    if (wvPeriod) wvConds.push(wvPeriod);
    const wvMc = memberClause('team_member', member);
    if (wvMc) wvConds.push(wvMc);
    const clause = wvConds.length ? wvConds.join(' AND ') : '1=1';

    const totalVolume    = (db.prepare(`SELECT COUNT(*) AS c FROM weighted_volume WHERE ${clause}`).get() as {c:number}).c;
    const totalWeighted  = (db.prepare(`SELECT COALESCE(SUM(weight),0) AS s FROM weighted_volume WHERE ${clause}`).get() as {s:number}).s;

    const npsConds: string[] = [];
    const npsPeriod = periodClause('rated_date', quarter, yearMonth, year);
    if (npsPeriod) npsConds.push(npsPeriod);
    const npsMc = memberClause('team_member', member);
    if (npsMc) npsConds.push(npsMc);
    const npsClause = npsConds.length ? npsConds.join(' AND ') : '1=1';

    const npsTotal     = (db.prepare(`SELECT COUNT(*) AS c FROM nps_data WHERE ${npsClause}`).get() as {c:number}).c;
    const promoters    = (db.prepare(`SELECT SUM(promoter) AS s FROM nps_data WHERE ${npsClause}`).get() as {s:number}).s ?? 0;
    const detractors   = (db.prepare(`SELECT SUM(detractor) AS s FROM nps_data WHERE ${npsClause}`).get() as {s:number}).s ?? 0;
    const npsScore     = npsTotal > 0 ? Math.round(((promoters - detractors) / npsTotal) * 100) : null;

    // Participation = total NPS ratings / total volume (raw volume count)
    const participationRate = totalVolume > 0 ? (npsTotal / totalVolume) * 100 : 0;

    // Unique team members with work
    const activeMembers = (db.prepare(
      `SELECT COUNT(DISTINCT team_member) AS c FROM weighted_volume WHERE ${clause} AND team_member IS NOT NULL`
    ).get() as {c:number}).c;

    res.json({
      total_volume:        totalVolume,
      total_weighted:      Math.round(totalWeighted * 100) / 100,
      nps_total:           npsTotal,
      promoters,
      detractors,
      nps_score:           npsScore,
      participation_rate:  Math.round(participationRate * 100) / 100,
      active_members:      activeMembers,
    });
  });

  // ── Weighted Volume rows ───────────────────────────────────────────────────
  app.get('/api/metrics/weighted-volume', (req: Request, res: Response) => {
    const { yearMonth, quarter, year, limit = '500', offset = '0' } = req.query as Record<string, string>;
    const member = req.query['member'] as string | string[] | undefined;
    const db = getDb();

    const conds: string[] = [];
    const p = periodClause('close_date', quarter, yearMonth, year);
    if (p) conds.push(p);
    const mc = memberClause('team_member', member);
    if (mc) conds.push(mc);

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM weighted_volume ${where} ORDER BY close_date DESC LIMIT ${limit} OFFSET ${offset}`).all();
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM weighted_volume ${where}`).get() as {c:number}).c;
    res.json({ rows, total });
  });

  // ── M&I rows ───────────────────────────────────────────────────────────────
  app.get('/api/metrics/mi', (req: Request, res: Response) => {
    const { yearMonth, quarter, year, request, sortBy, sortDir, limit = '500', offset = '0' } = req.query as Record<string, string>;
    const member = req.query['member'] as string | string[] | undefined;
    const db = getDb();

    const conds: string[] = [];
    const p = periodClause('close_date', quarter, yearMonth, year);
    if (p) conds.push(p);
    const mc = memberClause('squad_member', member);
    if (mc) conds.push(mc);
    if (request) conds.push(`request_number LIKE '%${request.replace(/'/g, "''")}%'`);

    // Allowlist of sortable columns — never interpolate unsanitised user input
    const SORTABLE: Record<string, string> = {
      request_number: 'request_number',
      squad_member:   'squad_member',
      month:          'month',
      close_date:     'close_date',
      ct_days:        'ct_days',
      ct_hours:       'ct_hours',
      funnel_hours:   'funnel_hours',
      squad_hours:    'squad_hours',
      ym_close:       'ym_close',
      status:         'status',
    };
    const col = (sortBy && SORTABLE[sortBy]) ? SORTABLE[sortBy] : 'close_date';
    const dir = sortDir === 'asc' ? 'ASC' : 'DESC';

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows  = db.prepare(`SELECT * FROM mi_data ${where} ORDER BY ${col} ${dir} LIMIT ${limit} OFFSET ${offset}`).all();
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM mi_data ${where}`).get() as {c:number}).c;
    res.json({ rows, total });
  });

  // ── NPS rows ───────────────────────────────────────────────────────────────
  // Always restricts to detractors OR unassigned team_member only.
  app.get('/api/metrics/nps', (req: Request, res: Response) => {
    const { yearMonth, quarter, year, limit = '500', offset = '0' } = req.query as Record<string, string>;
    const member = req.query['member'] as string | string[] | undefined;
    const db = getDb();

    const conds: string[] = ['(detractor = 1 OR team_member IS NULL)'];
    const p = periodClause('rated_date', quarter, yearMonth, year);
    if (p) conds.push(p);
    const mc = memberClause('team_member', member);
    if (mc) conds.push(mc);

    const where = `WHERE ${conds.join(' AND ')}`;
    // Sort: detractors first, then unassigned, then newest rated_date
    const rows  = db.prepare(
      `SELECT * FROM nps_data ${where}
       ORDER BY detractor DESC,
                CASE WHEN team_member IS NULL THEN 0 ELSE 1 END ASC,
                rated_date DESC
       LIMIT ${limit} OFFSET ${offset}`
    ).all();
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM nps_data ${where}`).get() as {c:number}).c;
    res.json({ rows, total });
  });

  // ── NPS: assign team member to a row ──────────────────────────────────────
  app.post('/api/metrics/nps/assign', (req: Request, res: Response) => {
    const { id, team_member } = req.body as { id?: number; team_member?: string };
    if (!id || !team_member) return res.status(400).json({ error: 'id and team_member required' });
    const db = getDb();

    // Fetch the row first so we have request_number + rated_date for the override key
    const row = db.prepare(`SELECT request_number, COALESCE(rated_date,'') AS rated_date FROM nps_data WHERE id = ?`).get(id) as
      { request_number: string; rated_date: string } | undefined;
    if (!row) return res.status(404).json({ error: 'Row not found' });

    const name = team_member.trim();

    const save = db.transaction(() => {
      // Update nps_data immediately
      db.prepare(`UPDATE nps_data SET team_member = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(name, id);
      // Persist as an override so transformNpsData() re-applies it after any future re-transform
      db.prepare(`
        INSERT INTO nps_member_overrides (request_number, rated_date, team_member, overridden_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(request_number, rated_date) DO UPDATE SET
          team_member   = excluded.team_member,
          overridden_at = excluded.overridden_at
      `).run(row.request_number, row.rated_date, name);
    });
    save();

    return res.json({ ok: true });
  });

  // ── By Member summary ─────────────────────────────────────────────────────
  app.get('/api/metrics/by-member', (req: Request, res: Response) => {
    const { yearMonth, quarter, year } = req.query as Record<string, string>;
    const filterMember = req.query['member'] as string | string[] | undefined;
    const db = getDb();

    const wvPeriod  = periodClause('close_date', quarter, yearMonth, year);
    const npsPeriod = periodClause('rated_date', quarter, yearMonth, year);
    const wvClause  = wvPeriod  ? wvPeriod  : '1=1';
    const npsClause = npsPeriod ? npsPeriod : '1=1';

    const wvMemberFilter  = memberClause('team_member', filterMember);
    const npsMemberFilter = memberClause('team_member', filterMember);

    const wv = db.prepare(`
      SELECT team_member,
             COUNT(*) AS volume,
             COALESCE(SUM(weight),0) AS weighted_volume
      FROM weighted_volume
      WHERE ${wvClause} AND team_member IS NOT NULL${wvMemberFilter ? ` AND ${wvMemberFilter}` : ''}
      GROUP BY team_member ORDER BY volume DESC
    `).all() as { team_member: string; volume: number; weighted_volume: number }[];

    const nps = db.prepare(`
      SELECT team_member,
             COUNT(*) AS nps_total,
             SUM(promoter) AS promoters,
             SUM(detractor) AS detractors,
             SUM(passive) AS passives
      FROM nps_data
      WHERE ${npsClause} AND team_member IS NOT NULL${npsMemberFilter ? ` AND ${npsMemberFilter}` : ''}
      GROUP BY team_member
    `).all() as { team_member: string; nps_total: number; promoters: number; detractors: number; passives: number }[];

    // Avg cycle time per member from mi_data (same period filter applied to close_date)
    const miPeriod      = periodClause('close_date', quarter, yearMonth, year);
    const miClause      = miPeriod ? miPeriod : '1=1';
    const miMemberFilter = memberClause('squad_member', filterMember);
    const ct = db.prepare(`
      SELECT squad_member,
             ROUND(AVG(ct_days), 1) AS avg_ct_days
      FROM mi_data
      WHERE ct_days IS NOT NULL
        AND ${miClause}${miMemberFilter ? ` AND ${miMemberFilter}` : ''}
      GROUP BY squad_member
    `).all() as { squad_member: string; avg_ct_days: number }[];
    const ctMap = new Map(ct.map((r) => [r.squad_member, r.avg_ct_days]));

    // Merge by team_member
    const npsMap = new Map(nps.map((r) => [r.team_member, r]));
    const result = wv.map((w) => {
      const n = npsMap.get(w.team_member);
      const npsScore = n && n.nps_total > 0
        ? Math.round(((n.promoters - n.detractors) / n.nps_total) * 100)
        : null;
      return {
        team_member:       w.team_member,
        volume:            w.volume,
        weighted_volume:   Math.round(w.weighted_volume * 100) / 100,
        avg_ct_days:       ctMap.get(w.team_member) ?? null,
        nps_total:         n?.nps_total ?? 0,
        promoters:         n?.promoters ?? 0,
        detractors:        n?.detractors ?? 0,
        nps_score:         npsScore,
        participation_rate: w.volume > 0 ? Math.round(((n?.nps_total ?? 0) / w.volume) * 10000) / 100 : 0,
      };
    });
    res.json(result);
  });

  // ── By Month summary ──────────────────────────────────────────────────────
  app.get('/api/metrics/by-month', (req: Request, res: Response) => {
    const { quarter, yearMonth, year } = req.query as Record<string, string>;
    const member = req.query['member'] as string | string[] | undefined;
    const db = getDb();
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    const wvConds  = ['month IS NOT NULL'];
    const npsConds = ['month IS NOT NULL'];
    const mc = memberClause('team_member', member);
    if (mc) { wvConds.push(mc); npsConds.push(mc); }
    const wvPeriod  = periodClause('close_date', quarter, yearMonth, year);
    const npsPeriod = periodClause('rated_date',  quarter, yearMonth, year);
    if (wvPeriod)  wvConds.push(wvPeriod);
    if (npsPeriod) npsConds.push(npsPeriod);
    const wvFilter  = wvConds.join(' AND ');
    const npsFilter = npsConds.join(' AND ');

    const wv = db.prepare(`
      SELECT month,
             COUNT(*) AS volume,
             COALESCE(SUM(weight),0) AS weighted_volume
      FROM weighted_volume
      WHERE ${wvFilter}
      GROUP BY month
    `).all() as { month: string; volume: number; weighted_volume: number }[];

    const nps = db.prepare(`
      SELECT month,
             COUNT(*) AS nps_total,
             SUM(promoter) AS promoters,
             SUM(detractor) AS detractors
      FROM nps_data
      WHERE ${npsFilter}
      GROUP BY month
    `).all() as { month: string; nps_total: number; promoters: number; detractors: number }[];

    const npsMap = new Map(nps.map((r) => [r.month, r]));
    const result = wv.map((w) => {
      const n = npsMap.get(w.month);
      const npsScore = n && n.nps_total > 0
        ? Math.round(((n.promoters - n.detractors) / n.nps_total) * 100)
        : null;
      return {
        month:           w.month,
        sort_key:        MONTHS.indexOf(w.month),
        volume:          w.volume,
        weighted_volume: Math.round(w.weighted_volume * 100) / 100,
        nps_total:       n?.nps_total ?? 0,
        nps_score:       npsScore,
      };
    }).sort((a, b) => a.sort_key - b.sort_key);

    res.json(result);
  });

  // ── Available Periods ─────────────────────────────────────────────────────
  // Returns the distinct YYYY-MM values present in the DB, used to build
  // the Period dropdown dynamically in the frontend.
  app.get('/api/metrics/periods', (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db.prepare(
      `SELECT DISTINCT substr(close_date,1,7) AS ym
       FROM weighted_volume
       WHERE close_date IS NOT NULL AND close_date != ''
       ORDER BY ym ASC`
    ).all() as { ym: string }[];
    res.json(rows.map((r) => r.ym));
  });

  // ── Admin: Squad Members ───────────────────────────────────────────────────
  app.get('/api/admin/squad-members', (_req: Request, res: Response) => {
    const db   = getDb();
    const rows = db.prepare('SELECT * FROM squad_members ORDER BY name').all();
    res.json(rows);
  });

  app.post('/api/admin/squad-members', (req: Request, res: Response) => {
    const { email, email_raw, name, sap_id } = req.body as {
      email?: string; email_raw?: string; name?: string; sap_id?: string;
    };
    if (!email || !name) return res.status(400).json({ error: 'email and name required' });
    const db = getDb();
    db.prepare(`
      INSERT OR IGNORE INTO squad_members (email_raw, email, name, sap_id)
      VALUES (?, ?, ?, ?)
    `).run(email_raw ?? null, email.toLowerCase(), name, sap_id ?? null);
    res.json({ ok: true });
    return;
  });

  // ── Admin: Reason Codes ───────────────────────────────────────────────────
  app.get('/api/admin/reason-codes', (_req: Request, res: Response) => {
    const db   = getDb();
    const rows = db.prepare('SELECT * FROM reason_codes WHERE active = 1 ORDER BY process, code_num').all();
    res.json(rows);
  });

  // ── Uncategorized Items ────────────────────────────────────────────────────
  // Returns weighted_volume rows where sub_process IS NULL, joined with the
  // raw request data for display.  Supports pagination via limit/offset.
  app.get('/api/metrics/uncategorized', (req: Request, res: Response) => {
    const { limit = '100', offset = '0', search = '' } = req.query as Record<string, string>;
    const db = getDb();

    const searchClause = search
      ? `AND (wv.request_number LIKE '%${search.replace(/'/g, "''")}%'
             OR wv.request_type LIKE '%${search.replace(/'/g, "''")}%'
             OR wv.customer_name LIKE '%${search.replace(/'/g, "''")}%'
             OR wv.last_comment LIKE '%${search.replace(/'/g, "''")}%')`
      : '';

    const rows = db.prepare(`
      SELECT
        wv.request_number,
        wv.request_type,
        wv.customer_name,
        wv.last_comment,
        wv.close_date,
        wv.team_member,
        wv.month,
        wv.status,
        mc.sub_process  AS override_sub_process,
        mc.process      AS override_process,
        mc.complexity   AS override_complexity,
        mc.weight       AS override_weight,
        mc.override_at  AS override_at
      FROM weighted_volume wv
      LEFT JOIN manual_classifications mc ON mc.request_number = wv.request_number
      WHERE wv.sub_process IS NULL
      ${searchClause}
      ORDER BY wv.close_date DESC
      LIMIT ${parseInt(limit, 10)} OFFSET ${parseInt(offset, 10)}
    `).all();

    const total = (db.prepare(`
      SELECT COUNT(*) AS c FROM weighted_volume wv
      WHERE wv.sub_process IS NULL ${searchClause}
    `).get() as { c: number }).c;

    // Also return distinct reason-code options for the dropdowns
    const rcOptions = db.prepare(`
      SELECT DISTINCT sub_process, process, complexity, weight, reason_code
      FROM reason_codes WHERE active = 1
      ORDER BY process, sub_process
    `).all();

    res.json({ rows, total, limit: parseInt(limit, 10), offset: parseInt(offset, 10), reason_code_options: rcOptions });
  });

  // ── Classify (manual override) ────────────────────────────────────────────
  // Body: { items: [{ request_number, sub_process, process, complexity, weight, note? }] }
  // Saves to manual_classifications, then re-runs transformWeightedVolume() so the
  // weighted_volume table is immediately updated (only re-transforms WV, not NPS/MI).
  app.post('/api/metrics/classify', (req: Request, res: Response) => {
    type ClassifyItem = {
      request_number: string;
      sub_process: string;
      process: string;
      complexity: string;
      weight: number;
      note?: string;
    };
    const { items } = req.body as { items?: ClassifyItem[] };
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array required' });
    }

    const db = getDb();
    const upsert = db.prepare(`
      INSERT OR REPLACE INTO manual_classifications
        (request_number, sub_process, process, complexity, weight, override_by, override_at, note)
      VALUES
        (@request_number, @sub_process, @process, @complexity, @weight, 'user', datetime('now'), @note)
    `);

    // Validate all items first
    for (const item of items) {
      if (!item.request_number || !item.sub_process || !item.process || !item.complexity || item.weight == null) {
        return res.status(400).json({ error: `Missing fields in item: ${JSON.stringify(item)}` });
      }
    }

    try {
      const saveAll = db.transaction(() => {
        for (const item of items) {
          upsert.run({
            request_number: item.request_number.trim(),
            sub_process:    item.sub_process,
            process:        item.process,
            complexity:     item.complexity,
            weight:         item.weight,
            note:           item.note ?? null,
          });
        }
      });
      saveAll();

      logger.info(`[api] Manual classify: ${items.length} overrides saved. Re-transforming WV…`);
      broadcast('status', { type: 'classify_start', count: items.length });

      // Re-run WV transform so the weighted_volume table reflects the new overrides immediately
      const wvCount = transformWeightedVolume();

      broadcast('status', { type: 'classify_complete', count: items.length, wv_rows: wvCount });
      logger.info(`[api] Re-transform complete: ${wvCount} WV rows.`);

      return res.json({ ok: true, saved: items.length, wv_rows: wvCount });
    } catch (e) {
      logger.error(`[api] classify error: ${(e as Error).message}`);
      return res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Clear Data ─────────────────────────────────────────────────────────────
  // Supported modes (request body: { mode }):
  //   "derived"  — wipe weighted_volume, mi_data, nps_data then immediately re-run
  //                transforms from the preserved raw tables (no re-upload needed)
  //   "metrics"  — derived + raw_nps + raw_requests + requests (keeps lookups)
  //   "all"      — everything above + ingestion_log (full reset, keeps squad_members + reason_codes)
  app.delete('/api/data/clear', (req: Request, res: Response) => {
    try {
      const { mode = 'derived' } = req.body as { mode?: 'derived' | 'metrics' | 'all' };
      const db = getDb();

      const tablesByMode: Record<string, string[]> = {
        derived: ['weighted_volume', 'mi_data', 'nps_data'],
        metrics: ['weighted_volume', 'mi_data', 'nps_data', 'raw_nps', 'raw_requests', 'requests'],
        all:     ['weighted_volume', 'mi_data', 'nps_data', 'raw_nps', 'raw_requests', 'requests', 'ingestion_log'],
      };

      const tables = tablesByMode[mode] ?? tablesByMode['derived'];

      const counts: Record<string, number> = {};
      const clearAll = db.transaction(() => {
        for (const t of tables) {
          counts[t] = (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
          db.prepare(`DELETE FROM ${t}`).run();
        }
      });

      clearAll();

      const summary = tables.map((t) => `${t}: ${counts[t]} rows removed`).join(', ');
      logger.info(`[api] Data cleared (mode=${mode}): ${summary}`);

      // For "derived" mode, raw data is preserved — immediately re-run all three
      // transforms so the dashboard repopulates without requiring a re-upload.
      let rebuilt: Record<string, number> | undefined;
      if (mode === 'derived') {
        const rawCount = (db.prepare('SELECT COUNT(*) AS c FROM requests').get() as { c: number }).c;
        const rawNps   = (db.prepare('SELECT COUNT(*) AS c FROM raw_nps').get()  as { c: number }).c;
        if (rawCount > 0 || rawNps > 0) {
          const wv  = transformWeightedVolume();
          const mi  = transformMiData();
          const nps = transformNpsData();
          rebuilt = { weighted_volume: wv, mi_data: mi, nps_data: nps };
          logger.info(`[api] Re-transform after derived clear: WV=${wv}, MI=${mi}, NPS=${nps}`);
        }
      }

      broadcast('status', { type: 'data_cleared', mode, counts });

      res.json({ ok: true, mode, cleared: counts, ...(rebuilt ? { rebuilt } : {}) });
    } catch (e) {
      logger.error(`[api] Data clear failed: ${(e as Error).message}`);
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Export XLSX ────────────────────────────────────────────────────────────
  app.get('/api/export', (req: Request, res: Response) => {
    const { month, yearMonth } = req.query as { month?: string; yearMonth?: string };
    try {
      const filePath = exportMasterXlsx({ month, yearMonth });
      res.download(filePath, path.basename(filePath));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Log tail ───────────────────────────────────────────────────────────────
  app.get('/api/logs', (_req: Request, res: Response) => {
    res.json(getLogBuffer());
  });

  // ── Catch-all → serve SPA index ───────────────────────────────────────────
  app.get('*', (_req: Request, res: Response) => {
    const idx = path.join(FRONTEND_DIR, 'index.html');
    if (fs.existsSync(idx)) {
      res.sendFile(idx);
    } else {
      res.status(404).send('Frontend not found');
    }
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error(`[api] Unhandled error: ${err.message}`);
    res.status(500).json({ error: err.message });
  });

  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Server start
// ─────────────────────────────────────────────────────────────────────────────
export function startServer(): http.Server {
  const app    = createApp();
  const server = app.listen(PORT, () => {
    logger.info(`[server] CMT Metrics Hub running → http://localhost:${PORT}`);
  });

  // Extend socket timeout to 10 minutes so long-running automation endpoints
  // (NPS extract + IBM SSO MFA wait) are never disconnected mid-flight.
  // Node's default is 2 minutes which is shorter than the full auth+extract flow.
  const TEN_MINUTES = 10 * 60 * 1000;
  server.timeout          = TEN_MINUTES;
  server.keepAliveTimeout = TEN_MINUTES;
  server.headersTimeout   = TEN_MINUTES + 1000; // must be > keepAliveTimeout

  return server;
}
