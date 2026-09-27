/** Tiny structured logger. No dependency, JSON lines in production. */
import { config } from './config.js';
import type { AdapterLogger } from './adapters/types.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta ?? {}),
  };
  const line = config.isProduction ? JSON.stringify(entry) : `${entry.ts} ${level.toUpperCase().padEnd(5)} ${msg}${
    meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : ''
  }`;
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const logger: AdapterLogger = {
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
};

export const logDebug = (msg: string, meta?: Record<string, unknown>) => {
  if (!config.isProduction) emit('debug', msg, meta);
};
