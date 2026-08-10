/**
 * src/index.ts — CMT Metrics Hub entry point.
 *
 * On startup:
 *   1. Load .env
 *   2. Initialise SQLite DB + schema
 *   3. Seed lookup tables (idempotent)
 *   4. Start Express server on PORT (default 3001)
 *
 * Data ingestion is manual-only: use the Upload cards on the Ingest page
 * or the automated extraction buttons to feed data in.
 */

import 'dotenv/config';
import { getDb } from './db/schema';
import { seedSquadMembers, seedReasonCodes } from './db/seeds';
import { startServer } from './api/server';
import { logger } from './utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info('  CMT Metrics Hub — starting up');
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 1. Init DB
  logger.info('[startup] Initialising SQLite database...');
  getDb(); // triggers initSchema

  // 2. Seed lookups
  logger.info('[startup] Seeding squad members and reason codes...');
  seedSquadMembers();
  seedReasonCodes();

  // 3. Start Express server
  startServer();

  // Graceful shutdown
  process.on('SIGTERM', () => { logger.info('[shutdown] SIGTERM received.'); process.exit(0); });
  process.on('SIGINT',  () => { logger.info('[shutdown] SIGINT received.');  process.exit(0); });
}

main().catch((err) => {
  logger.error(`[fatal] ${(err as Error).message}`);
  process.exit(1);
});
