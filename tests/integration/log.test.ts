import request from 'supertest';
import { createApp } from '../../src/server/app';
import { ClientManager } from '../../src/services/clientManager';

// Shared app instance — no I/O, safe to reuse across tests.
const app = createApp(new ClientManager());

// ---------------------------------------------------------------------------
// GET /log
// ---------------------------------------------------------------------------

describe('GET /log', () => {

  test('returns 200', async () => {
    const res = await request(app).get('/log');
    expect(res.status).toBe(200);
  });

  test('returns text/html content-type', async () => {
    const res = await request(app).get('/log');
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  // ----- HTML structure contracts -------------------------------------------

  test('HTML begins with a DOCTYPE declaration', async () => {
    const res = await request(app).get('/log');
    expect(res.text.trim().toLowerCase()).toMatch(/^<!doctype html>/);
  });

  test('HTML contains a <title> element', async () => {
    const res = await request(app).get('/log');
    expect(res.text).toMatch(/<title>/i);
  });

  test('HTML contains the React root mount point', async () => {
    const res = await request(app).get('/log');
    expect(res.text).toContain('id="root"');
  });

  test('HTML loads a module script for the React bundle', async () => {
    const res = await request(app).get('/log');
    expect(res.text).toContain('type="module"');
  });

});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

describe('GET /health', () => {

  test('returns 200 with { status: "ok" }', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  test('returns application/json content-type', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

});

// ---------------------------------------------------------------------------
// Unknown routes
// ---------------------------------------------------------------------------

describe('unknown routes', () => {

  test('GET /nonexistent returns 404', async () => {
    const res = await request(app).get('/nonexistent-route-xyz');
    expect(res.status).toBe(404);
  });

  test('GET /stream/subpath returns 404', async () => {
    const res = await request(app).get('/stream/subpath');
    expect(res.status).toBe(404);
  });

  test('POST /log returns 404 (only GET is defined)', async () => {
    const res = await request(app).post('/log').send({});
    expect(res.status).toBe(404);
  });

});
