/**
 * clientManager.ts
 *
 * Maintains the registry of active SSE connections.
 * LogWatcher calls broadcast() whenever a new line is available.
 * stream.route.ts calls add() on connect and remove() on disconnect.
 */

import { Response } from 'express';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';

export interface SseClient {
  id: string;
  res: Response;
}

export class ClientManager {
  private clients = new Map<string, SseClient>();

  add(res: Response): string {
    const id = randomUUID();
    this.clients.set(id, { id, res });
    logger.info('SSE client connected', { clientId: id, total: this.clients.size });
    return id;
  }

  remove(id: string): void {
    this.clients.delete(id);
    logger.info('SSE client disconnected', { clientId: id, total: this.clients.size });
  }

  /**
   * Send a single log line to all connected clients as an SSE `data` event.
   */
  broadcast(line: string): void {
    if (this.clients.size === 0) return;

    // SSE wire format: "data: <payload>\n\n"
    const payload = `data: ${JSON.stringify({ line })}\n\n`;

    for (const [id, client] of this.clients) {
      try {
        client.res.write(payload);
      } catch (err) {
        logger.warn('Failed to write to SSE client; removing', { clientId: id });
        this.remove(id);
      }
    }
  }

  /**
   * Send an error notification to all clients (e.g. file deleted).
   */
  broadcastError(message: string): void {
    const payload = `event: error\ndata: ${JSON.stringify({ error: message })}\n\n`;
    for (const [id, client] of this.clients) {
      try {
        client.res.write(payload);
      } catch {
        this.remove(id);
      }
    }
  }

  get size(): number {
    return this.clients.size;
  }
}
