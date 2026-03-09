/**
 * stream.test.ts
 *
 * Integration tests for GET /stream.
 *
 * Supertest is used for synchronous header/status assertions.
 * Raw http.get is used wherever we need to inspect live SSE frames,
 * because supertest buffers the full response body before resolving.
 */

import * as http from 'http';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { createApp } from '../../src/server/app';
import { ClientManager } from '../../src/services/clientManager';

// ---------------------------------------------------------------------------
// Config mock — lets each test point the stream route at a temp file.
// ---------------------------------------------------------------------------

jest.mock('../../src/config', () => ({
  config: {
    logFilePath: '',
    tailLines: 3,
    readChunkSize: 4096,
    pollIntervalMs: 1000,
    port: 0,
  },
}));

import { config } from '../../src/config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempFile(content: string): string {
  const file = path.join(os.tmpdir(), `stream-test-${Date.now()}-${Math.random()}`);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function cleanup(...files: string[]): void {
  for (const f of files) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
}

/**
 * Open a raw SSE connection to `server` and accumulate chunks until
 * `predicate` returns true or `timeout` ms elapse.
 *
 * NOTE: We intentionally do NOT call req.destroy() inside this helper.
 * On Node 18+ that would synchronously emit an 'aborted' error that races
 * with the settle guard. Cleanup is handled by server.closeAllConnections()
 * in afterEach instead.
 */
function collectSseChunks(
  server: http.Server,
  predicate: (chunks: string[]) => boolean,
  timeout = 4000
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const chunks: string[] = [];
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = setTimeout(() => settle(() => resolve(chunks)), timeout);

    const req = http.get(`http://127.0.0.1:${addr.port}/stream`, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        chunks.push(chunk);
        if (!settled && predicate(chunks)) {
          clearTimeout(timer);
          settle(() => resolve(chunks));
        }
      });
      res.on('error', (e) => settle(() => reject(e)));
    });
    req.on('error', (e) => settle(() => reject(e)));
  });
}

/** Convenience: resolve once the SSE snapshot event arrives. */
function waitForSnapshot(server: http.Server, timeoutMs = 3000): Promise<string[]> {
  return collectSseChunks(server, (c) => c.join('').includes('snapshot'), timeoutMs);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe('GET /stream', () => {
  let server: http.Server;
  let tempFile: string;

  beforeEach((done) => {
    tempFile = '';
    const app = createApp(new ClientManager());
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', done);
  });

  afterEach((done) => {
    server.closeAllConnections();
    server.close(() => {
      if (tempFile) cleanup(tempFile);
      done();
    });
  });

  // ----- SSE headers --------------------------------------------------------

  test('returns Content-Type: text/event-stream', async () => {
    tempFile = makeTempFile('line1\n');
    (config as { logFilePath: string }).logFilePath = tempFile;

    const contentType = await new Promise<string | undefined>((resolve, reject) => {
      const addr = server.address() as { port: number };
      http.get(`http://127.0.0.1:${addr.port}/stream`, (res) => {
        resolve(res.headers['content-type']);
        res.resume();
      }).on('error', reject);
    });
    expect(contentType).toMatch(/text\/event-stream/);
  });

  test('returns Cache-Control: no-cache header', async () => {
    tempFile = makeTempFile('line1\n');
    (config as { logFilePath: string }).logFilePath = tempFile;

    const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const addr = server.address() as { port: number };
      http.get(`http://127.0.0.1:${addr.port}/stream`, (res) => {
        resolve(res.headers);
        res.resume();
      }).on('error', reject);
    });
    expect(headers['cache-control']).toMatch(/no-cache/);
  });

  test('returns X-Accel-Buffering: no (disables nginx buffering)', async () => {
    tempFile = makeTempFile('line1\n');
    (config as { logFilePath: string }).logFilePath = tempFile;

    const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const addr = server.address() as { port: number };
      http.get(`http://127.0.0.1:${addr.port}/stream`, (res) => {
        resolve(res.headers);
        res.resume();
      }).on('error', reject);
    });
    expect(headers['x-accel-buffering']).toBe('no');
  });

  test('returns Connection: keep-alive header', async () => {
    tempFile = makeTempFile('line1\n');
    (config as { logFilePath: string }).logFilePath = tempFile;

    const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const addr = server.address() as { port: number };
      http.get(`http://127.0.0.1:${addr.port}/stream`, (res) => {
        resolve(res.headers);
        res.resume();
      }).on('error', reject);
    });
    expect(headers['connection']).toMatch(/keep-alive/i);
  });

  // ----- snapshot event -----------------------------------------------------

  test('sends a "snapshot" event with the last 3 lines on connect', async () => {
    const lines = ['a', 'b', 'c', 'd', 'e'];
    tempFile = makeTempFile(lines.join('\n') + '\n');
    (config as { logFilePath: string }).logFilePath = tempFile;

    const raw = (await waitForSnapshot(server)).join('');
    expect(raw).toContain('event: snapshot');

    const dataMatch = raw.match(/data: ({.*})/);
    expect(dataMatch).toBeTruthy();
    const parsed = JSON.parse(dataMatch![1]);
    expect(parsed.lines).toEqual(['c', 'd', 'e']);
  });

  test('snapshot preserves chronological line order', async () => {
    const ordered = ['first', 'second', 'third'];
    tempFile = makeTempFile(ordered.join('\n') + '\n');
    (config as { logFilePath: string }).logFilePath = tempFile;

    const raw = (await waitForSnapshot(server)).join('');
    const parsed = JSON.parse(raw.match(/data: ({.*})/)![1]);
    expect(parsed.lines).toEqual(ordered);
  });

  test('snapshot contains all lines when file has fewer than tailLines', async () => {
    tempFile = makeTempFile('only\ntwo\n');
    (config as { logFilePath: string }).logFilePath = tempFile;

    const raw = (await waitForSnapshot(server)).join('');
    const parsed = JSON.parse(raw.match(/data: ({.*})/)![1]);
    expect(parsed.lines).toEqual(['only', 'two']);
  });

  test('snapshot contains empty array for an empty log file', async () => {
    tempFile = makeTempFile('');
    (config as { logFilePath: string }).logFilePath = tempFile;

    const raw = (await waitForSnapshot(server)).join('');
    const parsed = JSON.parse(raw.match(/data: ({.*})/)![1]);
    expect(parsed.lines).toEqual([]);
  });

  test('snapshot data is valid JSON', async () => {
    tempFile = makeTempFile('line1\nline2\nline3\n');
    (config as { logFilePath: string }).logFilePath = tempFile;

    const raw = (await waitForSnapshot(server)).join('');
    const dataMatch = raw.match(/data: ({.*})/);
    expect(dataMatch).toBeTruthy();
    expect(() => JSON.parse(dataMatch![1])).not.toThrow();
  });

  // ----- error events -------------------------------------------------------

  test('sends "event: error" when log file does not exist', async () => {
    (config as { logFilePath: string }).logFilePath = '/tmp/does-not-exist-99999.log';

    const raw = (await collectSseChunks(server,
      (c) => c.join('').includes('event: error'), 3000
    )).join('');

    expect(raw).toContain('event: error');
    expect(raw).toContain('not found');
  });

  test('error event data is valid JSON with an "error" key', async () => {
    (config as { logFilePath: string }).logFilePath = '/tmp/does-not-exist-99999.log';

    const raw = (await collectSseChunks(server,
      (c) => c.join('').includes('event: error'), 3000
    )).join('');

    const dataMatch = raw.match(/event: error\ndata: ({.*})/);
    expect(dataMatch).toBeTruthy();
    const parsed = JSON.parse(dataMatch![1]);
    expect(parsed).toHaveProperty('error');
    expect(typeof parsed.error).toBe('string');
  });

  // ----- live broadcast -----------------------------------------------------

  test('newly appended line is delivered to connected client as a "data:" frame', async () => {
    tempFile = makeTempFile('existing\n');
    (config as { logFilePath: string }).logFilePath = tempFile;

    const clientManager = new ClientManager();
    const server2 = http.createServer(createApp(clientManager));
    await new Promise<void>(r => server2.listen(0, '127.0.0.1', r));

    try {
      const collectPromise = collectSseChunks(
        server2,
        (c) => c.join('').includes('live line'),
        4000
      );
      await new Promise(r => setTimeout(r, 200));
      clientManager.broadcast('live line');
      const raw = (await collectPromise).join('');
      expect(raw).toContain('live line');
    } finally {
      server2.closeAllConnections();
      await new Promise<void>(r => server2.close(() => r()));
    }
  });

  test('broadcastError event reaches connected client as "event: error"', async () => {
    tempFile = makeTempFile('line\n');
    (config as { logFilePath: string }).logFilePath = tempFile;

    const clientManager = new ClientManager();
    const server2 = http.createServer(createApp(clientManager));
    await new Promise<void>(r => server2.listen(0, '127.0.0.1', r));

    try {
      const collectPromise = collectSseChunks(
        server2,
        (c) => c.join('').includes('event: error'),
        4000
      );
      await new Promise(r => setTimeout(r, 200));
      clientManager.broadcastError('file rotation detected');
      const raw = (await collectPromise).join('');
      expect(raw).toContain('event: error');
      expect(raw).toContain('file rotation detected');
    } finally {
      server2.closeAllConnections();
      await new Promise<void>(r => server2.close(() => r()));
    }
  });

  test('multiple sequential broadcasts arrive in order', async () => {
    tempFile = makeTempFile('seed\n');
    (config as { logFilePath: string }).logFilePath = tempFile;

    const clientManager = new ClientManager();
    const server2 = http.createServer(createApp(clientManager));
    await new Promise<void>(r => server2.listen(0, '127.0.0.1', r));

    try {
      const collectPromise = collectSseChunks(
        server2,
        (c) => c.join('').includes('third'),
        4000
      );
      await new Promise(r => setTimeout(r, 200));
      clientManager.broadcast('first');
      clientManager.broadcast('second');
      clientManager.broadcast('third');

      const raw = (await collectPromise).join('');
      const firstIdx  = raw.indexOf('"first"');
      const secondIdx = raw.indexOf('"second"');
      const thirdIdx  = raw.indexOf('"third"');
      expect(firstIdx).toBeLessThan(secondIdx);
      expect(secondIdx).toBeLessThan(thirdIdx);
    } finally {
      server2.closeAllConnections();
      await new Promise<void>(r => server2.close(() => r()));
    }
  });

  // ----- multiple concurrent clients ----------------------------------------

  test('multiple concurrent clients all receive the snapshot independently', async () => {
    const lines = ['x', 'y', 'z'];
    tempFile = makeTempFile(lines.join('\n') + '\n');
    (config as { logFilePath: string }).logFilePath = tempFile;

    const [raw1, raw2, raw3] = await Promise.all([
      waitForSnapshot(server).then(c => c.join('')),
      waitForSnapshot(server).then(c => c.join('')),
      waitForSnapshot(server).then(c => c.join('')),
    ]);

    for (const raw of [raw1, raw2, raw3]) {
      expect(raw).toContain('event: snapshot');
      const parsed = JSON.parse(raw.match(/data: ({.*})/)![1]);
      expect(parsed.lines).toEqual(['x', 'y', 'z']);
    }
  });

  test('all concurrent clients receive the same broadcast', async () => {
    tempFile = makeTempFile('seed\n');
    (config as { logFilePath: string }).logFilePath = tempFile;

    const clientManager = new ClientManager();
    const server2 = http.createServer(createApp(clientManager));
    await new Promise<void>(r => server2.listen(0, '127.0.0.1', r));

    try {
      const [p1, p2] = [
        collectSseChunks(server2, (c) => c.join('').includes('shared message'), 4000),
        collectSseChunks(server2, (c) => c.join('').includes('shared message'), 4000),
      ];
      await new Promise(r => setTimeout(r, 200));
      clientManager.broadcast('shared message');

      const [raw1, raw2] = await Promise.all([p1, p2]);
      expect(raw1.join('')).toContain('shared message');
      expect(raw2.join('')).toContain('shared message');
    } finally {
      server2.closeAllConnections();
      await new Promise<void>(r => server2.close(() => r()));
    }
  });

  // ----- disconnect / reconnect ---------------------------------------------

  test('client disconnect is handled cleanly without crashing the server', async () => {
    tempFile = makeTempFile('line\n');
    (config as { logFilePath: string }).logFilePath = tempFile;

    const clientManager = new ClientManager();
    const server2 = http.createServer(createApp(clientManager));
    await new Promise<void>(r => server2.listen(0, '127.0.0.1', r));

    try {
      const addr = server2.address() as { port: number };
      await new Promise<void>((resolve) => {
        const req = http.get(`http://127.0.0.1:${addr.port}/stream`, (res) => {
          res.setEncoding('utf8');
          res.once('data', () => {
            req.destroy();
            setTimeout(resolve, 500);
          });
        });
      });
      expect(clientManager.size).toBe(0);
    } finally {
      server2.closeAllConnections();
      await new Promise<void>(r => server2.close(() => r()));
    }
  });

  test('second client can connect after first disconnects', async () => {
    tempFile = makeTempFile('a\nb\nc\n');
    (config as { logFilePath: string }).logFilePath = tempFile;

    const clientManager = new ClientManager();
    const server2 = http.createServer(createApp(clientManager));
    await new Promise<void>(r => server2.listen(0, '127.0.0.1', r));

    try {
      const addr = server2.address() as { port: number };

      // First client connects and immediately disconnects
      await new Promise<void>((resolve) => {
        const req = http.get(`http://127.0.0.1:${addr.port}/stream`, (res) => {
          res.once('data', () => { req.destroy(); setTimeout(resolve, 300); });
        });
      });

      // Second client connects and receives a snapshot
      const chunks = await collectSseChunks(
        server2,
        (c) => c.join('').includes('snapshot'),
        3000
      );
      expect(chunks.join('')).toContain('event: snapshot');
    } finally {
      server2.closeAllConnections();
      await new Promise<void>(r => server2.close(() => r()));
    }
  });

});
