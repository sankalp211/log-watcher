import { ClientManager } from '../../src/services/clientManager';
import { Response } from 'express';

function mockRes(): jest.Mocked<Pick<Response, 'write'>> {
  return { write: jest.fn() };
}

describe('ClientManager', () => {
  let manager: ClientManager;

  beforeEach(() => {
    manager = new ClientManager();
  });

  // ----- initial state ------------------------------------------------------

  test('starts with size 0', () => {
    expect(manager.size).toBe(0);
  });

  // ----- add / remove -------------------------------------------------------

  test('add() returns a unique ID and increments size', () => {
    const id1 = manager.add(mockRes() as unknown as Response);
    const id2 = manager.add(mockRes() as unknown as Response);
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
    expect(manager.size).toBe(2);
  });

  test('add() generates UUID v4 format IDs', () => {
    const id = manager.add(mockRes() as unknown as Response);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('remove() decrements size', () => {
    const id = manager.add(mockRes() as unknown as Response);
    expect(manager.size).toBe(1);
    manager.remove(id);
    expect(manager.size).toBe(0);
  });

  test('remove() with an unknown id is a no-op', () => {
    manager.add(mockRes() as unknown as Response);
    expect(() => manager.remove('non-existent-id')).not.toThrow();
    expect(manager.size).toBe(1);
  });

  test('add/remove cycle returns size to 0', () => {
    const ids = Array.from({ length: 5 }, () =>
      manager.add(mockRes() as unknown as Response)
    );
    expect(manager.size).toBe(5);
    ids.forEach(id => manager.remove(id));
    expect(manager.size).toBe(0);
  });

  test('re-adding after removing restores correct count', () => {
    const id = manager.add(mockRes() as unknown as Response);
    manager.remove(id);
    manager.add(mockRes() as unknown as Response);
    expect(manager.size).toBe(1);
  });

  // ----- broadcast ----------------------------------------------------------

  test('broadcast() writes the correct SSE data payload to all clients', () => {
    const res1 = mockRes();
    const res2 = mockRes();
    manager.add(res1 as unknown as Response);
    manager.add(res2 as unknown as Response);

    manager.broadcast('hello world');

    const expected = `data: ${JSON.stringify({ line: 'hello world' })}\n\n`;
    expect(res1.write).toHaveBeenCalledWith(expected);
    expect(res2.write).toHaveBeenCalledWith(expected);
  });

  test('broadcast() payload has correct SSE wire format (starts with "data: ", ends with "\\n\\n")', () => {
    const res = mockRes();
    manager.add(res as unknown as Response);
    manager.broadcast('test line');
    const payload = (res.write as jest.Mock).mock.calls[0][0] as string;
    expect(payload).toMatch(/^data: .+\n\n$/);
  });

  test('broadcast() is a no-op when no clients are connected', () => {
    expect(() => manager.broadcast('nobody home')).not.toThrow();
  });

  test('broadcast() removes a client that throws on write (broken pipe)', () => {
    const good = mockRes();
    const bad  = mockRes();
    bad.write.mockImplementation(() => { throw new Error('broken pipe'); });

    manager.add(good as unknown as Response);
    manager.add(bad as unknown as Response);
    expect(manager.size).toBe(2);

    manager.broadcast('test');

    expect(manager.size).toBe(1);
    expect(good.write).toHaveBeenCalled();
  });

  test('broadcast() delivers to all 50 clients in a large pool', () => {
    const responses = Array.from({ length: 50 }, () => mockRes());
    responses.forEach(r => manager.add(r as unknown as Response));

    manager.broadcast('mass message');

    const expected = `data: ${JSON.stringify({ line: 'mass message' })}\n\n`;
    responses.forEach(r => expect(r.write).toHaveBeenCalledWith(expected));
    expect(manager.size).toBe(50);
  });

  test('broadcast() JSON-encodes special characters (quotes, newlines)', () => {
    const res = mockRes();
    manager.add(res as unknown as Response);
    const specialLine = 'line with "quotes" and \nnewline';
    manager.broadcast(specialLine);
    const payload = (res.write as jest.Mock).mock.calls[0][0] as string;
    // Value must be JSON-encoded so newlines don't break the SSE framing
    expect(payload).toContain(JSON.stringify({ line: specialLine }));
    // The SSE envelope itself must not contain a raw newline inside the data value
    const dataValue = payload.replace(/^data: /, '').replace(/\n\n$/, '');
    expect(dataValue).not.toContain('\n');
  });

  // ----- broadcastError -----------------------------------------------------

  test('broadcastError() sends an SSE error event to all clients', () => {
    const res = mockRes();
    manager.add(res as unknown as Response);
    manager.broadcastError('file not found');

    const payload = (res.write as jest.Mock).mock.calls[0][0] as string;
    expect(payload).toContain('event: error');
    expect(payload).toContain('file not found');
  });

  test('broadcastError() payload has correct wire format (event: error\\ndata: ...\\n\\n)', () => {
    const res = mockRes();
    manager.add(res as unknown as Response);
    manager.broadcastError('rotation detected');
    const payload = (res.write as jest.Mock).mock.calls[0][0] as string;
    expect(payload).toMatch(/^event: error\ndata: .+\n\n$/);
  });

  test('broadcastError() payload contains valid JSON in the data field', () => {
    const res = mockRes();
    manager.add(res as unknown as Response);
    manager.broadcastError('something went wrong');
    const payload = (res.write as jest.Mock).mock.calls[0][0] as string;
    const jsonPart = payload.replace('event: error\n', '').replace(/^data: /, '').replace(/\n\n$/, '');
    expect(() => JSON.parse(jsonPart)).not.toThrow();
    expect(JSON.parse(jsonPart)).toEqual({ error: 'something went wrong' });
  });

  test('broadcastError() removes a client that throws on write', () => {
    const good = mockRes();
    const bad  = mockRes();
    bad.write.mockImplementation(() => { throw new Error('write failed'); });

    manager.add(good as unknown as Response);
    manager.add(bad as unknown as Response);

    manager.broadcastError('rotation');

    expect(manager.size).toBe(1);
    expect(good.write).toHaveBeenCalled();
  });

  // ----- multiple rapid calls -----------------------------------------------

  test('two consecutive broadcasts are each delivered once per client', () => {
    const res = mockRes();
    manager.add(res as unknown as Response);

    manager.broadcast('first');
    manager.broadcast('second');

    expect(res.write).toHaveBeenCalledTimes(2);
    const calls = (res.write as jest.Mock).mock.calls.map(([p]: [string]) => p);
    expect(calls[0]).toContain('"first"');
    expect(calls[1]).toContain('"second"');
  });

});
