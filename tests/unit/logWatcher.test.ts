/**
 * logWatcher.test.ts
 *
 * Tests LogWatcher behaviour by mocking the underlying fileReader functions
 * and fs.watch so that no real files or OS watchers are needed.
 */

import { EventEmitter } from 'events';
import { LogWatcher } from '../../src/services/logWatcher';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../../src/services/fileReader', () => ({
  readFrom: jest.fn(),
  statFile: jest.fn(),
}));

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return { ...actual, watch: jest.fn() };
});

import * as fileReader from '../../src/services/fileReader';
import * as fs from 'fs';

const mockReadFrom = fileReader.readFrom as jest.MockedFunction<typeof fileReader.readFrom>;
const mockStatFile = fileReader.statFile as jest.MockedFunction<typeof fileReader.statFile>;
const mockFsWatch  = fs.watch as jest.MockedFunction<typeof fs.watch>;

// A fake FSWatcher that exposes EventEmitter so tests can emit events.
class FakeWatcher extends EventEmitter {
  close = jest.fn();
}

function makeFakeWatcher(): FakeWatcher {
  const w = new FakeWatcher();
  mockFsWatch.mockReturnValue(w as unknown as fs.FSWatcher);
  return w;
}

// Flush all pending nextTick + Promise microtask chains in one go.
const flush = () => new Promise(r => setImmediate(r));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LogWatcher', () => {
  beforeEach(() => jest.clearAllMocks());

  // ----- new lines ----------------------------------------------------------

  test('emits "line" for each line returned by readFrom on a change event', async () => {
    const fw = makeFakeWatcher();
    mockStatFile.mockResolvedValue({ size: 20, ino: 1 });
    mockReadFrom.mockResolvedValue({ lines: ['line A', 'line B'], newOffset: 20, remainder: '' });

    const lw = new LogWatcher('/fake/app.log', 0, 1, 0);
    const received: string[] = [];
    lw.on('line', (l) => received.push(l));
    lw.start();

    fw.emit('change', 'change', null);
    await flush();

    expect(received).toEqual(['line A', 'line B']);
    lw.stop();
  });

  test('emits all lines in order when readFrom returns a burst of 5 lines', async () => {
    const fw = makeFakeWatcher();
    const burstLines = ['l1', 'l2', 'l3', 'l4', 'l5'];
    mockStatFile.mockResolvedValue({ size: 100, ino: 1 });
    mockReadFrom.mockResolvedValue({ lines: burstLines, newOffset: 100, remainder: '' });

    const lw = new LogWatcher('/fake/app.log', 0, 1, 0);
    const received: string[] = [];
    lw.on('line', (l) => received.push(l));
    lw.start();

    fw.emit('change', 'change', null);
    await flush();

    expect(received).toEqual(burstLines);
    lw.stop();
  });

  test('emits nothing when readFrom returns an empty lines array', async () => {
    const fw = makeFakeWatcher();
    // New bytes available, but they form only a partial line (no \n yet)
    mockStatFile.mockResolvedValue({ size: 5, ino: 1 });
    mockReadFrom.mockResolvedValue({ lines: [], newOffset: 5, remainder: 'part' });

    const lw = new LogWatcher('/fake/app.log', 0, 1, 0);
    const received: string[] = [];
    lw.on('line', (l) => received.push(l));
    lw.start();

    fw.emit('change', 'change', null);
    await flush();

    expect(received).toHaveLength(0);
    lw.stop();
  });

  // ----- no-op when nothing is new -----------------------------------------

  test('does not call readFrom when file size has not grown beyond offset', async () => {
    const fw = makeFakeWatcher();
    mockStatFile.mockResolvedValue({ size: 50, ino: 1 });
    // offset is also 50 → nothing new

    const lw = new LogWatcher('/fake/app.log', 50, 1, 0);
    lw.start();

    fw.emit('change', 'change', null);
    await flush();

    expect(mockReadFrom).not.toHaveBeenCalled();
    lw.stop();
  });

  // ----- debounce ----------------------------------------------------------

  test('debounces rapid-fire change events into a single read', async () => {
    const fw = makeFakeWatcher();
    mockStatFile.mockResolvedValue({ size: 10, ino: 1 });
    mockReadFrom.mockResolvedValue({ lines: ['x'], newOffset: 10, remainder: '' });

    const lw = new LogWatcher('/fake/app.log', 0, 1, 0);
    lw.start();

    // Fire 5 change events synchronously — should collapse to 1 read
    fw.emit('change', 'change', null);
    fw.emit('change', 'change', null);
    fw.emit('change', 'change', null);
    fw.emit('change', 'change', null);
    fw.emit('change', 'change', null);

    await flush();

    expect(mockStatFile).toHaveBeenCalledTimes(1);
    lw.stop();
  });

  // ----- partial line across reads -----------------------------------------

  test('passes pending remainder to the next readFrom call', async () => {
    const fw = makeFakeWatcher();
    mockStatFile.mockResolvedValue({ size: 20, ino: 1 });

    mockReadFrom
      .mockResolvedValueOnce({ lines: ['complete'], newOffset: 13, remainder: 'partial' })
      .mockResolvedValueOnce({ lines: ['partial_rest'], newOffset: 20, remainder: '' });

    const lw = new LogWatcher('/fake/app.log', 0, 1, 0);
    const lines: string[] = [];
    lw.on('line', (l) => lines.push(l));
    lw.start();

    fw.emit('change', 'change', null);
    await flush();

    fw.emit('change', 'change', null);
    await flush();

    expect(lines[0]).toBe('complete');
    expect(mockReadFrom.mock.calls[1][2]).toBe('partial');
    lw.stop();
  });

  // ----- truncation --------------------------------------------------------

  test('resets offset to 0 when file is truncated (newSize < lastOffset)', async () => {
    const fw = makeFakeWatcher();
    mockStatFile.mockResolvedValueOnce({ size: 50, ino: 1 }); // truncated: 50 < offset 100
    mockReadFrom.mockResolvedValue({ lines: [], newOffset: 0, remainder: '' });

    const lw = new LogWatcher('/fake/app.log', 100, 1, 0);
    lw.start();

    fw.emit('change', 'change', null);
    await flush();

    expect(mockReadFrom).toHaveBeenCalledWith('/fake/app.log', 0, '');
    lw.stop();
  });

  test('clears buffered remainder when truncation is detected', async () => {
    const fw = makeFakeWatcher();
    // File shrinks — remainder from a previous read must also be discarded
    mockStatFile.mockResolvedValueOnce({ size: 10, ino: 1 }); // truncated: 10 < offset 80
    mockReadFrom.mockResolvedValue({ lines: [], newOffset: 10, remainder: '' });

    const lw = new LogWatcher('/fake/app.log', 80, 1, 0);
    lw.start();

    fw.emit('change', 'change', null);
    await flush();

    // remainder passed to readFrom should be '' (cleared on truncation)
    expect(mockReadFrom).toHaveBeenCalledWith('/fake/app.log', 0, '');
    lw.stop();
  });

  // ----- rotation ----------------------------------------------------------

  test('resets offset and re-watches when inode changes (file rotation)', async () => {
    const fw = makeFakeWatcher();
    mockStatFile.mockResolvedValue({ size: 10, ino: 999 }); // old inode was 1
    mockReadFrom.mockResolvedValue({ lines: ['rotated content'], newOffset: 10, remainder: '' });

    const lw = new LogWatcher('/fake/app.log', 50, 1, 0);
    const lines: string[] = [];
    lw.on('line', (l) => lines.push(l));
    lw.start();

    fw.emit('change', 'change', null);
    await flush();

    expect(mockReadFrom).toHaveBeenCalledWith('/fake/app.log', 0, '');
    expect(lines).toEqual(['rotated content']);
    lw.stop();
  });

  // ----- rename event -------------------------------------------------------

  test('"rename" event from FSWatcher emits error and detaches watcher', async () => {
    const fw = makeFakeWatcher();

    const lw = new LogWatcher('/fake/app.log', 0, 1, 0);
    const errors: string[] = [];
    lw.on('error', (m) => errors.push(m));
    lw.start();

    fw.emit('rename', null);
    await flush();

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('renamed or deleted');
    // The stale FSWatcher should have been closed
    expect(fw.close).toHaveBeenCalled();
    lw.stop();
  });

  // ----- error handling ----------------------------------------------------

  test('emits "error" and calls stop() when EACCES is received', async () => {
    const fw = makeFakeWatcher();
    mockStatFile.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

    const lw = new LogWatcher('/fake/app.log', 0, 1, 0);
    const errors: string[] = [];
    lw.on('error', (m) => errors.push(m));
    lw.start();

    fw.emit('change', 'change', null);
    await flush();

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('Permission denied');
    lw.stop();
  });

  test('emits "error" on ENOENT but keeps the watcher alive for retry', async () => {
    const fw = makeFakeWatcher();
    mockStatFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const lw = new LogWatcher('/fake/app.log', 0, 1, 0);
    const errors: string[] = [];
    lw.on('error', (m) => errors.push(m));
    lw.start();

    fw.emit('change', 'change', null);
    await flush();

    expect(errors[0]).toContain('not found');
    // Polling timer should still be alive — stop() should succeed cleanly
    lw.stop();
  });

  // ----- lifecycle ---------------------------------------------------------

  test('stop() closes the FSWatcher and clears the polling interval', () => {
    const fw = makeFakeWatcher();
    mockStatFile.mockResolvedValue({ size: 0, ino: 1 });

    const lw = new LogWatcher('/fake/app.log', 0, 1, 500);
    lw.start();
    lw.stop();

    expect(fw.close).toHaveBeenCalled();
  });

  test('stop() is idempotent — calling it twice does not throw', () => {
    makeFakeWatcher();
    const lw = new LogWatcher('/fake/app.log', 0, 1, 0);
    lw.start();
    expect(() => { lw.stop(); lw.stop(); }).not.toThrow();
  });

  test('does not emit lines after stop() is called', async () => {
    const fw = makeFakeWatcher();
    mockStatFile.mockResolvedValue({ size: 10, ino: 1 });
    mockReadFrom.mockResolvedValue({ lines: ['after stop'], newOffset: 10, remainder: '' });

    const lw = new LogWatcher('/fake/app.log', 0, 1, 0);
    const received: string[] = [];
    lw.on('line', (l) => received.push(l));
    lw.start();
    lw.stop();

    // Fire a change event after stop — should be ignored
    fw.emit('change', 'change', null);
    await flush();

    expect(received).toHaveLength(0);
  });

});
