/**
 * logWatcher.ts
 *
 * Owns the fs.watch lifecycle for a single log file.
 *
 * Responsibilities:
 *   - Detect new content appended to the file (via fs.watch change events).
 *   - Detect file truncation (newSize < lastOffset) and reset cursor.
 *   - Detect file rotation (inode change) and re-open the new file.
 *   - Buffer partial lines across reads so only complete lines are emitted.
 *   - Emit 'line' events for each complete new line.
 *   - Emit 'error' events on unrecoverable conditions.
 *   - Provide a clean stop() method for graceful shutdown.
 */

import * as fs from 'fs';
import { EventEmitter } from 'events';
import { readFrom, statFile } from './fileReader';
import { logger } from '../utils/logger';

export class LogWatcher extends EventEmitter {
  on(event: 'line', listener: (line: string) => void): this;
  on(event: 'error', listener: (message: string) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  emit(event: 'line', line: string): boolean;
  emit(event: 'error', message: string): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit(event: string | symbol, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }
  private readonly filePath: string;
  private readonly pollIntervalMs: number;

  private watcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  // State tracking
  private offset = 0;
  private inode = 0;
  private remainder = ''; // buffered partial line

  // Debounce: fs.watch can fire multiple events per single append
  private pending = false;

  constructor(filePath: string, initialOffset: number, initialInode: number, pollIntervalMs = 1000) {
    super();
    this.filePath = filePath;
    this.offset = initialOffset;
    this.inode = initialInode;
    this.pollIntervalMs = pollIntervalMs;
  }

  start(): void {
    this.attachFsWatch();
    if (this.pollIntervalMs > 0) {
      this.pollTimer = setInterval(() => this.handleChange(), this.pollIntervalMs);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('LogWatcher stopped', { filePath: this.filePath });
  }

  private attachFsWatch(): void {
    try {
      // Use the .on() style (not the inline callback) so that tests can trigger
      // events via EventEmitter.emit() on a mock FSWatcher.
      this.watcher = fs.watch(this.filePath, { persistent: false });

      this.watcher.on('change', (eventType) => {
        if (eventType === 'change') {
          this.scheduleRead();
        } else if (eventType === 'rename') {
          this.handleRename();
        }
      });

      this.watcher.on('rename', () => {
        this.handleRename();
      });

      this.watcher.on('error', (err) => {
        logger.warn('fs.watch error', { filePath: this.filePath, error: (err as Error).message });
        // Polling fallback will keep things alive
      });
    } catch (err) {
      logger.warn('Could not attach fs.watch; relying on polling only', {
        filePath: this.filePath,
        error: (err as Error).message,
      });
    }
  }

  /** Debounce rapid-fire change events into a single read. */
  private scheduleRead(): void {
    if (this.pending) return;
    this.pending = true;
    // nextTick lets multiple synchronous watch events collapse into one read.
    process.nextTick(() => {
      this.pending = false;
      this.handleChange();
    });
  }

  private async handleChange(): Promise<void> {
    if (this.stopped) return;

    try {
      const { size, ino } = await statFile(this.filePath);

      // File rotation: inode changed
      if (ino !== this.inode) {
        logger.info('File rotation detected', { filePath: this.filePath, oldIno: this.inode, newIno: ino });
        this.inode = ino;
        this.offset = 0;
        this.remainder = '';
        // Re-attach watcher to the new file
        if (this.watcher) {
          this.watcher.close();
          this.watcher = null;
        }
        this.attachFsWatch();
      }

      // File truncation: file shrank
      if (size < this.offset) {
        logger.info('File truncation detected', { filePath: this.filePath, oldOffset: this.offset, newSize: size });
        this.offset = 0;
        this.remainder = '';
      }

      if (size <= this.offset) return; // nothing new

      const result = await readFrom(this.filePath, this.offset, this.remainder);
      this.offset = result.newOffset;
      this.remainder = result.remainder;

      for (const line of result.lines) {
        this.emit('line', line);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        logger.warn('Log file not found; will retry via polling', { filePath: this.filePath });
        this.emit('error', `Log file not found: ${this.filePath}`);
        // Detach broken watcher; polling will pick it back up when the file reappears
        if (this.watcher) {
          this.watcher.close();
          this.watcher = null;
        }
      } else if (code === 'EACCES' || code === 'EPERM') {
        logger.error('Permission denied reading log file', { filePath: this.filePath });
        this.emit('error', `Permission denied: ${this.filePath}`);
        this.stop();
      } else {
        logger.error('Unexpected error in LogWatcher', {
          filePath: this.filePath,
          error: (err as Error).message,
        });
      }
    }
  }

  private handleRename(): void {
    // On macOS/Linux a 'rename' event typically means the file was deleted or moved.
    // We detach the watcher (it's now invalid) and let polling re-establish it
    // when the file reappears.
    logger.info('File rename/delete event received', { filePath: this.filePath });
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.emit('error', `Log file was renamed or deleted: ${this.filePath}`);

    // Start polling for the file to reappear
    if (!this.pollTimer && this.pollIntervalMs > 0) {
      this.pollTimer = setInterval(() => this.tryReattach(), this.pollIntervalMs);
    }
  }

  private async tryReattach(): Promise<void> {
    if (this.stopped) return;
    try {
      const { ino } = await statFile(this.filePath);
      // File exists again (possibly a new file after rotation)
      logger.info('Log file reappeared; reattaching watcher', { filePath: this.filePath });
      this.inode = ino;
      this.offset = 0;
      this.remainder = '';
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      // Restart the full polling interval
      if (this.pollIntervalMs > 0) {
        this.pollTimer = setInterval(() => this.handleChange(), this.pollIntervalMs);
      }
      this.attachFsWatch();
    } catch {
      // File still not there — keep polling
    }
  }
}
