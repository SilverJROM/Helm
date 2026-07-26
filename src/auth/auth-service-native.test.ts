import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { AuthService } from './auth-service.js';
import { createAuthMiddleware, createRequireOwner, createSseAuthMiddleware } from './auth-middleware.js';
import { registerAuthRoutes } from '../api/routes/auth-routes.js';

const HELM_SECRET = 'hybrid-helm-secret';
const SECOND_HELM_SECRET = 'hybrid-second-helm-secret';
const AGJ_SECRET = 'hybrid-agj-secret';
const OWNER_TELEGRAM_ID = 5294055107;

function createAgjDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
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
  `);
  return db;
}

function insertUser(
  db: Database.Database,
  values: { id: number; telegramId: number; role: 'owner' | 'viewer'; active?: number; username?: string; displayName?: string }
): void {
  db.prepare(
    'INSERT INTO users (id, telegram_id, username, display_name, role, active) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    values.id,
    values.telegramId,
    values.username ?? null,
    values.displayName ?? null,
    values.role,
    values.active ?? 1
  );
}

function issueAgjToken(db: Database.Database, userId: number, telegramId: number, sid = `agj-${userId}`): string {
  const token = jwt.sign({ sub: userId, sid, tid: telegramId }, AGJ_SECRET, {
    algorithm: 'HS256',
    expiresIn: '1h'
  });
  db.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, surface, expires_at) VALUES (?, ?, ?, 'web', datetime('now', '+1 hour'))"
  ).run(sid, userId, createHash('sha256').update(token).digest('hex'));
  return token;
}

describe('hybrid AuthService — AGJAssist human auth with Helm-local issuance', () => {
  const closeables: Array<{ close: () => unknown }> = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    while (closeables.length) {
      try { closeables.pop()!.close(); } catch {}
    }
  });

  it('issues a Helm-only owner token from the unique active AGJ owner and rechecks active state', () => {
    const agjDb = createAgjDb(); closeables.push(agjDb);
    insertUser(agjDb, {
      id: 7,
      telegramId: OWNER_TELEGRAM_ID,
      role: 'owner',
      username: 'jrom',
      displayName: 'JROM'
    });
    const auth = new AuthService(HELM_SECRET, agjDb, undefined, AGJ_SECRET);

    expect(auth.resolveActiveOwner()).toEqual({
      id: 7,
      telegramId: OWNER_TELEGRAM_ID,
      username: 'jrom',
      displayName: 'JROM',
      role: 'owner'
    });
    const { token, user } = auth.issueOwnerToken();
    expect(jwt.decode(token)).toMatchObject({ iss: 'helm', aud: 'helm', sub: 7 });
    expect(auth.verifyToken(token)).toEqual(user);

    agjDb.prepare('UPDATE users SET active = 0 WHERE id = 7').run();
    expect(auth.verifyToken(token)).toBeNull();
  });

  it('accepts an active AGJ session without escalating a viewer and rejects inactive or missing users', () => {
    const agjDb = createAgjDb(); closeables.push(agjDb);
    insertUser(agjDb, {
      id: 20,
      telegramId: 2020,
      role: 'viewer',
      username: 'viewerhandle',
      displayName: 'Viewer Person'
    });
    insertUser(agjDb, { id: 30, telegramId: 3030, role: 'owner', active: 0 });
    const auth = new AuthService(HELM_SECRET, agjDb, undefined, AGJ_SECRET);

    const viewerToken = issueAgjToken(agjDb, 20, 2020);
    expect(auth.verifyToken(viewerToken)).toEqual({
      id: 20,
      telegramId: 2020,
      username: 'viewerhandle',
      displayName: 'Viewer Person',
      role: 'viewer'
    });

    const inactiveToken = issueAgjToken(agjDb, 30, 3030);
    expect(auth.verifyToken(inactiveToken)).toBeNull();

    const missingToken = issueAgjToken(agjDb, 999, 9999);
    expect(auth.verifyToken(missingToken)).toBeNull();
  });

  it('honors AGJ session revocation, token hash binding, and session expiry', () => {
    const agjDb = createAgjDb(); closeables.push(agjDb);
    insertUser(agjDb, { id: 1, telegramId: OWNER_TELEGRAM_ID, role: 'owner' });
    const auth = new AuthService(HELM_SECRET, agjDb, undefined, AGJ_SECRET);

    const revoked = issueAgjToken(agjDb, 1, OWNER_TELEGRAM_ID, 'revoked-session');
    expect(auth.verifyToken(revoked)?.role).toBe('owner');
    agjDb.prepare('DELETE FROM sessions WHERE id = ?').run('revoked-session');
    expect(auth.verifyToken(revoked)).toBeNull();

    const expired = issueAgjToken(agjDb, 1, OWNER_TELEGRAM_ID, 'expired-session');
    agjDb.prepare("UPDATE sessions SET expires_at = datetime('now', '-1 second') WHERE id = ?").run('expired-session');
    expect(auth.verifyToken(expired)).toBeNull();

    const hashMismatch = issueAgjToken(agjDb, 1, OWNER_TELEGRAM_ID, 'hash-session');
    agjDb.prepare("UPDATE sessions SET token_hash = 'wrong' WHERE id = ?").run('hash-session');
    expect(auth.verifyToken(hashMismatch)).toBeNull();
  });

  it('keeps Helm-issued tokens instance-local while the same AGJ token works across Helm instances', () => {
    const agjDb = createAgjDb(); closeables.push(agjDb);
    insertUser(agjDb, { id: 1, telegramId: OWNER_TELEGRAM_ID, role: 'owner' });
    const first = new AuthService(HELM_SECRET, agjDb, undefined, AGJ_SECRET);
    const second = new AuthService(SECOND_HELM_SECRET, agjDb, undefined, AGJ_SECRET);

    const helmToken = first.issueOwnerToken().token;
    expect(first.verifyToken(helmToken)?.role).toBe('owner');
    expect(second.verifyToken(helmToken)).toBeNull();

    const agjToken = issueAgjToken(agjDb, 1, OWNER_TELEGRAM_ID, 'shared-agj-session');
    expect(first.verifyToken(agjToken)?.role).toBe('owner');
    expect(second.verifyToken(agjToken)?.role).toBe('owner');
  });

  it('fails closed instead of issuing sub:1 when there is no unique active AGJ owner', () => {
    const agjDb = createAgjDb(); closeables.push(agjDb);
    const auth = new AuthService(HELM_SECRET, agjDb, undefined, AGJ_SECRET);
    expect(auth.resolveActiveOwner()).toBeNull();
    expect(() => auth.issueOwnerToken()).toThrow(/no unique active AGJAssist owner/);

    insertUser(agjDb, { id: 1, telegramId: 1001, role: 'owner' });
    insertUser(agjDb, { id: 2, telegramId: 1002, role: 'owner' });
    expect(auth.resolveActiveOwner()).toBeNull();
    expect(() => auth.issueOwnerToken()).toThrow(/no unique active AGJAssist owner/);
  });

  it('keeps login, owner middleware, and SSE middleware on the AGJ-backed role', async () => {
    const agjDb = createAgjDb(); closeables.push(agjDb);
    insertUser(agjDb, { id: 1, telegramId: OWNER_TELEGRAM_ID, role: 'owner' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-hybrid-auth-routes-'));
    const helmDb = new DatabaseService(path.join(dir, 'helm.db'));
    closeables.push({ close: () => { helmDb.close(); fs.rmSync(dir, { recursive: true, force: true }); } });
    vi.stubEnv('HELM_HOST', '127.0.0.1');
    vi.stubEnv('HELM_OWNER_CRED', 'hybrid-owner-cred');

    const auth = new AuthService(HELM_SECRET, agjDb, undefined, AGJ_SECRET);
    const app = Fastify({ logger: false });
    registerAuthRoutes(app, auth, helmDb.raw, { port: 3112 });
    app.get('/api/owner', { preHandler: [createAuthMiddleware(auth), createRequireOwner()] }, async () => ({ ok: true }));
    app.get('/api/stream', { preHandler: [createSseAuthMiddleware(auth), createRequireOwner()] }, async () => ({ ok: true }));
    await app.ready();

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { credential: 'hybrid-owner-cred' }
    });
    expect(login.statusCode).toBe(200);
    const token = login.json().token;
    expect((await app.inject({ method: 'GET', url: '/api/owner', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/stream?access_token=${token}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/stream' })).statusCode).toBe(401);
    await app.close();
  });
});
