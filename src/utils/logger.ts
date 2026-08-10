/**
 * src/utils/logger.ts
 * Winston logger — daily rotating file + console.
 * Log files written to logs/cmt-metrics-YYYY-MM-DD.log
 */

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import * as path from 'path';
import * as fs from 'fs';

const logDir = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const fmt = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack }) =>
    stack
      ? `[${timestamp}] ${level.toUpperCase()}: ${message}\n${stack}`
      : `[${timestamp}] ${level.toUpperCase()}: ${message}`
  )
);

const rotate = new DailyRotateFile({
  dirname:        logDir,
  filename:       'cmt-metrics-%DATE%.log',
  datePattern:    'YYYY-MM-DD',
  maxSize:        '20m',
  maxFiles:       '30d',
  format:         fmt,
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  transports: [
    rotate,
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        fmt
      ),
    }),
  ],
});

/** Return in-memory log tail (last N lines) for UI log panel */
const logBuffer: string[] = [];
const MAX_BUFFER = 200;

logger.on('data', (chunk: { message: string; level: string; timestamp?: string }) => {
  const entry = `[${chunk.timestamp ?? new Date().toISOString()}] ${chunk.level.toUpperCase()}: ${chunk.message}`;
  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER) logBuffer.shift();
});

export function getLogBuffer(): string[] {
  return [...logBuffer];
}
