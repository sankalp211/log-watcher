type Level = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

function log(level: Level, message: string, meta?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  const line = JSON.stringify(entry);
  if (level === 'ERROR') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => log('INFO', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log('WARN', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log('ERROR', message, meta),
  debug: (message: string, meta?: Record<string, unknown>) => {
    if (process.env['NODE_ENV'] !== 'test') {
      log('DEBUG', message, meta);
    }
  },
};
