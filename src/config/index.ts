import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

function requireEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0) {
    throw new Error(`Config error: ${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

function resolveLogFilePath(): string {
  const raw = process.env['LOG_FILE_PATH'] ?? './logs/sample.log';
  const resolved = path.resolve(raw);

  // Fail fast at startup if the path is clearly invalid (directory, etc.)
  // We intentionally do NOT require the file to exist yet — it may be created later.
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      throw new Error(`Config error: LOG_FILE_PATH points to a directory: ${resolved}`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
    // ENOENT is fine — watcher will handle file-not-found gracefully
  }

  return resolved;
}

export interface Config {
  port: number;
  logFilePath: string;
  tailLines: number;
  readChunkSize: number;
  pollIntervalMs: number;
}

function loadConfig(): Config {
  return {
    port: requireEnvInt('PORT', 3000),
    logFilePath: resolveLogFilePath(),
    tailLines: requireEnvInt('TAIL_LINES', 10),
    readChunkSize: requireEnvInt('READ_CHUNK_SIZE', 4096),
    pollIntervalMs: requireEnvInt('POLL_INTERVAL_MS', 1000),
  };
}

// Singleton — resolved once at module load; throws immediately on bad config.
export const config: Config = loadConfig();
