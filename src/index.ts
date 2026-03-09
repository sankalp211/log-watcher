import * as http from 'http';
import { config } from './config';
import { createApp } from './server/app';
import { ClientManager } from './services/clientManager';
import { LogWatcher } from './services/logWatcher';
import { statFileSync } from './services/fileReader';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  // Resolve initial file state so the watcher starts at the right offset.
  // If the file doesn't exist yet, start at offset 0 with inode 0.
  let initialOffset = 0;
  let initialInode = 0;
  try {
    const stat = statFileSync(config.logFilePath);
    initialOffset = stat.size;
    initialInode = stat.ino;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error('Failed to stat log file at startup', { error: (err as Error).message });
      process.exit(1);
    }
    logger.warn('Log file does not exist yet; watcher will pick it up when it appears', {
      logFilePath: config.logFilePath,
    });
  }

  const clientManager = new ClientManager();
  const app = createApp(clientManager);
  const server = http.createServer(app);

  const watcher = new LogWatcher(
    config.logFilePath,
    initialOffset,
    initialInode,
    config.pollIntervalMs
  );

  // Wire watcher events to clients
  watcher.on('line', (line) => clientManager.broadcast(line));
  watcher.on('error', (message) => clientManager.broadcastError(message));

  watcher.start();

  server.listen(config.port, () => {
    logger.info('Server started', {
      port: config.port,
      logFile: config.logFilePath,
      tailLines: config.tailLines,
    });
    logger.info(`Open http://localhost:${config.port}/log in your browser`);
  });

  // --- Graceful shutdown ---
  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}; shutting down gracefully`);
    watcher.stop();
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
    // Force exit if graceful shutdown takes too long
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Fatal startup error', { error: (err as Error).message });
  process.exit(1);
});
