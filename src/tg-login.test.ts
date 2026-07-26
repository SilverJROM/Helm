import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION } from './db/schema.js';
import { TgLoginService } from './auth/tg-login-service.js';
import { AuthService } from './auth/auth-service.js';
import { createAuthMiddleware, createRequireOwner } from './auth/auth-middleware.js';
import { registerAuthRoutes } from './api/routes/auth-routes.js';

const OWNER_TELEGRAM_ID = 5294055107;
const HELM_SECRET = 'tg-login-helm-secret';
const AGJ_SECRET = 'tg-login-agj-secret';

function tmpDbPath(name: string): string {
  return path.join(os.tmpdir(), `helm-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanupDb(p: string): void {
  try { fs.unlinkSync(p); } catch {}
  try { fs.unlinkSync(p + '-wal'); } catch {}
  try { fs.unlinkSync(p + '-shm'); } catch {}
}

describe('TG login challenge service', () => {
  let dbPath: string;
  let db: DatabaseService;
  let nowMs: number;
  let service: TgLoginService;

  beforeEach(() => {
    dbPath = tmpDbPath('tg-service');
    db = new DatabaseService(dbPath);
    nowMs = Date.parse('2026-06-24T12:00:00.000Z');
    service = new TgLoginService(db.raw, () => new Date(nowMs));
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it('creates the v42 fresh table and generates display plus two distinct shuffled buttons', () => {
    const version = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(version.version).toBe(SCHEMA_VERSION);
    const challenge = service.generateChallenge();

    expect(challenge.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(challenge.displayNumber).toBeGreaterThanOrEqual(10);
    expect(challenge.displayNumber).toBeLessThanOrEqual(99);
    expect(challenge.buttons).toHaveLength(3);
    expect(new Set(challenge.buttons).size).toBe(3);
    expect(challenge.buttons).toContain(challenge.displayNumber);
    expect(challenge.buttons.every(n => n >= 10 && n <= 99)).toBe(true);
  });

  it('migrates a v41 database to v42 with tg_login_challenges', () => {
    const oldPath = tmpDbPath('tg-v41');
    const oldDb = new DatabaseService(oldPath);
    oldDb.prepare('UPDATE schema_version SET version = 41').run();
    oldDb.close();

    const migrated = new DatabaseService(oldPath);
    const version = migrated.prepare('SELECT version FROM schema_version').get() as { version: number };
    const table = migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tg_login_challenges'").get();
    expect(version.version).toBe(SCHEMA_VERSION);
    expect(table).toBeTruthy();
    migrated.close();
    cleanupDb(oldPath);
  });

  it('marks pass, keeps result one-shot, and consumes token issuance once', () => {
    const c = service.generateChallenge();
    service.markResult(c.challengeId, 'pass');
    service.markResult(c.challengeId, 'fail');

    expect(service.getStatus(c.challengeId)).toBe('pass');
    expect(service.consumePassForToken(c.challengeId)).toBe(true);
    expect(service.consumePassForToken(c.challengeId)).toBe(false);
    expect(service.getStatus(c.challengeId)).toBe('pass');
  });

  it('marks fail on denied callback and ignores later pass', () => {
    const c = service.generateChallenge();
    service.markResult(c.challengeId, 'fail');
    service.markResult(c.challengeId, 'pass');
    const row = db.prepare('SELECT consumed_at FROM tg_login_challenges WHERE id = ?').get(c.challengeId) as { consumed_at: string | null };
    expect(service.getStatus(c.challengeId)).toBe('fail');
    expect(row.consumed_at).toBeTruthy();
    expect(service.consumePassForToken(c.challengeId)).toBe(false);
  });

  it('expires after the two-minute TTL and ignores late marks', () => {
    const c = service.generateChallenge();
    nowMs += 121_000;
    expect(service.getStatus(c.challengeId)).toBe('expired');
    const row = db.prepare('SELECT consumed_at FROM tg_login_challenges WHERE id = ?').get(c.challengeId) as { consumed_at: string | null };
    expect(row.consumed_at).toBeTruthy();
    service.markResult(c.challengeId, 'pass');
    expect(service.getStatus(c.challengeId)).toBe('expired');
  });
});

describe('TG login auth routes', () => {
  let dbPath: string;
  let db: DatabaseService;
  let agjDb: Database.Database;
  let app: any;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dbPath = tmpDbPath('tg-routes');
    db = new DatabaseService(dbPath);
    agjDb = new Database(':memory:');
    agjDb.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        telegram_id INTEGER NOT NULL,
        username TEXT,
        display_name TEXT,
        role TEXT NOT NULL,
        active INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL,
        surface TEXT,
        expires_at TEXT NOT NULL,
        last_activity TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO users (id, telegram_id, username, display_name, role, active)
      VALUES (7, ${OWNER_TELEGRAM_ID}, 'jrom', 'JROM', 'owner', 1);
    `);
    app = Fastify({ logger: false });
    const authService = new AuthService(HELM_SECRET, agjDb, undefined, AGJ_SECRET);
    registerAuthRoutes(app, authService, db.raw, { port: 3112 });
    const authMw = createAuthMiddleware(authService);
    app.get('/api/agents', { preHandler: [authMw, createRequireOwner()] }, async () => ({ agents: [] }));
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await app.ready();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    agjDb.close();
    db.close();
    cleanupDb(dbPath);
  });

  it('starts a challenge with the exact AGJAssist contract body', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/tg-login-start' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.displayNumber).toBeGreaterThanOrEqual(10);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:3101/api/tg/login-challenge');
    const sent = JSON.parse(String(opts.body));
    expect(sent).toMatchObject({
      challengeId: body.challengeId,
      chatId: 5294055107,
      displayNumber: body.displayNumber,
      prompt: 'Sign-in attempt for Helm — tap the number you see on screen:',
      callbackUrl: 'http://127.0.0.1:3112/api/auth/tg-callback'
    });
    expect(sent.buttons).toHaveLength(3);
    expect(sent.buttons).toContain(body.displayNumber);
  });

  it('returns 502 and marks the challenge failed when AGJAssist is down', async () => {
    fetchMock.mockRejectedValueOnce(new Error('down'));
    const res = await app.inject({ method: 'POST', url: '/api/auth/tg-login-start' });
    expect(res.statusCode).toBe(502);
    const row = db.prepare("SELECT status FROM tg_login_challenges ORDER BY created_at DESC LIMIT 1").get() as { status: string };
    expect(row.status).toBe('fail');
  });

  it('guards tg-callback to loopback and treats duplicate callbacks idempotently', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/auth/tg-login-start' });
    const { challengeId } = start.json();

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/tg-callback',
      remoteAddress: '8.8.8.8',
      payload: { challengeId, result: 'pass' }
    });
    expect(blocked.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/auth/tg-status?challengeId=${challengeId}` })).json().status).toBe('pending');

    const pass = await app.inject({
      method: 'POST',
      url: '/api/auth/tg-callback',
      remoteAddress: '127.0.0.1',
      payload: { challengeId, result: 'pass' }
    });
    expect(pass.statusCode).toBe(200);
    const dupFail = await app.inject({
      method: 'POST',
      url: '/api/auth/tg-callback',
      remoteAddress: '127.0.0.1',
      payload: { challengeId, result: 'fail' }
    });
    expect(dupFail.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/auth/tg-status?challengeId=${challengeId}` })).json().status).toBe('pass');
  });

  it('mints the owner JWT exactly once on first pass status and token works for owner route', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/auth/tg-login-start' });
    const { challengeId } = start.json();
    await app.inject({
      method: 'POST',
      url: '/api/auth/tg-callback',
      remoteAddress: '127.0.0.1',
      payload: { challengeId, result: 'pass' }
    });

    const first = await app.inject({ method: 'GET', url: `/api/auth/tg-status?challengeId=${challengeId}` });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.status).toBe('pass');
    expect(firstBody.token).toBeTruthy();
    expect(firstBody.user.role).toBe('owner');

    const owner = await app.inject({
      method: 'GET',
      url: '/api/agents',
      headers: { authorization: `Bearer ${firstBody.token}` }
    });
    expect(owner.statusCode).toBe(200);

    const second = await app.inject({ method: 'GET', url: `/api/auth/tg-status?challengeId=${challengeId}` });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ status: 'pass' });
  });
});
