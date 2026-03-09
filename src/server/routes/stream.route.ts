/**
 * stream.route.ts
 *
 * GET /stream
 *
 * SSE endpoint. On connect:
 *   1. Sends the initial snapshot (last N lines) as a batch event.
 *   2. Registers the client with ClientManager.
 *   3. On client disconnect, de-registers cleanly.
 *
 * The LogWatcher broadcasts live lines to ClientManager independently;
 * this route only handles handshake and teardown.
 */

import { Router, Request, Response } from 'express';
import { lastNLines } from '../../services/fileReader';
import { ClientManager } from '../../services/clientManager';
import { config } from '../../config';
import { logger } from '../../utils/logger';

export function createStreamRouter(clientManager: ClientManager): Router {
  const router = Router();

  router.get('/stream', async (req: Request, res: Response) => {
    // --- SSE headers ---
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Disable nginx / proxy buffering
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Register the close handler BEFORE any async work so we never miss a
    // disconnect that arrives while lastNLines is running.
    let clientId: string | null = null;
    let closed = false;
    const keepAlive = setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
      } catch {
        clearInterval(keepAlive);
      }
    }, 25000);

    req.on('close', () => {
      closed = true;
      clearInterval(keepAlive);
      if (clientId !== null) clientManager.remove(clientId);
    });

    // --- Initial snapshot ---
    try {
      const lines = await lastNLines(config.logFilePath, config.tailLines, config.readChunkSize);
      // Send as a single 'snapshot' event so the client can distinguish it
      // from incremental 'data' events.
      const snapshotPayload = `event: snapshot\ndata: ${JSON.stringify({ lines })}\n\n`;
      if (!closed) res.write(snapshotPayload);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      let message: string;

      if (code === 'ENOENT') {
        message = `Log file not found: ${config.logFilePath}`;
      } else if (code === 'EACCES' || code === 'EPERM') {
        message = `Permission denied reading log file: ${config.logFilePath}`;
      } else {
        message = `Failed to read log file: ${(err as Error).message}`;
      }

      logger.error(message);
      if (!closed) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
        res.end();
      }
      return;
    }

    // --- Register client for live updates ---
    if (!closed) {
      clientId = clientManager.add(res);
    }
  });

  return router;
}
