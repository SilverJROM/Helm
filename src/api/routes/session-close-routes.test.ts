// S14a V3 — real Fastify app.inject() API tests for session close routes.
// Synthetic DB + fake tmux only. HELM_SESSION_JANITOR stays 0. Never live kill-session.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from '../../db/database.js';
import { SessionRegistryService } from '../../services/session-registry-service.js';
import { SessionCloseService, type SessionCloseTmux } from '../../services/session-close-service.js';
import { createRequireOwner } from '../../auth/auth-middleware.js';
import { createRequireLocalLaunch } from '../../guardrails.js';
import { registerSessionCloseRoutes } from './session-close-routes.js';

function makeTempDb(): { db: DatabaseService; cleanup: () => void } {
  const dbPath = path.join(os.tmpdir(), `helm-s14a-api-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new DatabaseService(dbPath);
  return {
    db,
    cleanup: () => {
      try {
        db.close();
      } catch {}
      for (const suf of ['', '-wal', '-shm']) {
        try {
          fs.unlinkSync(dbPath + suf);
        } catch {}
      }
    },
  };
}

function ownerAuth(req: any, _reply: any, done?: () => void) {
  req.user = { role: 'owner' };
  done?.();
}

function viewerAuth(req: any, _reply: any, done?: () => void) {
  req.user = { role: 'viewer' };
  done?.();
}

function unauth(_req: any, reply: any) {
  reply.code(401).send({ error: 'missing or invalid authorization header' });
}

async function buildApp(opts: {
  auth: 'owner' | 'viewer' | 'none';
  reg: SessionRegistryService;
  tmux: SessionCloseTmux;
}) {
  const authMiddleware =
    opts.auth === 'owner' ? ownerAuth : opts.auth === 'viewer' ? viewerAuth : unauth;
  const svc = new SessionCloseService(opts.reg, opts.tmux);
  const app = Fastify({ logger: false });
  registerSessionCloseRoutes(app, {
    sessionRegistry: opts.reg,
    sessionCloseService: svc,
    authMiddleware,
    requireOwnerPre: createRequireOwner(),
    requireLocalLaunchPre: createRequireLocalLaunch(),
  });
  await app.ready();
  return { app, svc };
}

describe('S14a session-close routes (app.inject)', () => {
  let db: DatabaseService;
  let cleanup: () => void;
  let reg: SessionRegistryService;
  let terminated: string[];
  let tagOk: boolean;
  let tmux: SessionCloseTmux;

  function seed(
    name: string,
    opts: { owner?: string | null; status?: string; kind?: string } = {}
  ) {
    const owner = opts.owner === undefined ? 'human' : opts.owner;
    const status = opts.status ?? 'active';
    const kind = opts.kind ?? 'discovery';
    db.prepare(
      `INSERT INTO helm_sessions (name, kind, project_id, run_id, owner, status, created_at, last_used_at)
       VALUES (?, ?, 1, NULL, ?, ?, datetime('now'), datetime('now'))`
    ).run(name, kind, owner, status);
  }

  beforeEach(() => {
    process.env.HELM_SESSION_JANITOR = '0';
    const t = makeTempDb();
    db = t.db;
    cleanup = t.cleanup;
    reg = new SessionRegistryService(db);
    terminated = [];
    tagOk = true;
    tmux = {
      terminateSession: async (name: string) => {
        terminated.push(name);
      },
      sessionHasHelmChildTag: async () => tagOk,
    };
  });

  afterEach(() => cleanup());

  it('non-owner → 403 (auth preHandler)', async () => {
    seed('helm-chat-auth');
    const { app } = await buildApp({ auth: 'viewer', reg, tmux });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/helm-chat-auth/close',
        remoteAddress: '127.0.0.1',
      });
      expect(res.statusCode).toBe(403);
      expect(terminated).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('unauth → 401', async () => {
    seed('helm-chat-unauth');
    const { app } = await buildApp({ auth: 'none', reg, tmux });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/helm-chat-unauth/close',
        remoteAddress: '127.0.0.1',
      });
      expect(res.statusCode).toBe(401);
      expect(terminated).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('owner + human → 200 with exactly one terminate', async () => {
    seed('helm-chat-ok');
    const { app } = await buildApp({ auth: 'owner', reg, tmux });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/helm-chat-ok/close',
        remoteAddress: '127.0.0.1',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.closed).toBe('helm-chat-ok');
      expect(body.already_reaped).toBe(false);
      expect(terminated).toEqual(['helm-chat-ok']);
      expect(reg.get('helm-chat-ok')!.status).toBe('reaped');
    } finally {
      await app.close();
    }
  });

  it('helm / legacy owner → 403 zero terminate', async () => {
    seed('helm-w-1', { owner: 'helm', kind: 'worker' });
    seed('helm-leg', { owner: 'legacy:unknown' });
    const { app } = await buildApp({ auth: 'owner', reg, tmux });
    try {
      for (const name of ['helm-w-1', 'helm-leg']) {
        const res = await app.inject({
          method: 'POST',
          url: `/api/sessions/${name}/close`,
          remoteAddress: '127.0.0.1',
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().reason).toBe('not_human');
      }
      expect(terminated).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('missing → 404', async () => {
    const { app } = await buildApp({ auth: 'owner', reg, tmux });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/helm-ghost/close',
        remoteAddress: '127.0.0.1',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().reason).toBe('missing');
      expect(terminated).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('invalid charset and non-helm- → 400', async () => {
    seed('other-x', { owner: 'human' });
    const { app } = await buildApp({ auth: 'owner', reg, tmux });
    try {
      const bad = await app.inject({
        method: 'POST',
        url: '/api/sessions/helm-bad%3Bname/close',
        remoteAddress: '127.0.0.1',
      });
      // Fastify may decode ; or leave encoded — either invalid or missing is refuse without terminate
      expect([400, 404]).toContain(bad.statusCode);
      const nonHelm = await app.inject({
        method: 'POST',
        url: '/api/sessions/other-x/close',
        remoteAddress: '127.0.0.1',
      });
      expect(nonHelm.statusCode).toBe(400);
      expect(nonHelm.json().reason).toBe('non_helm_name');
      expect(terminated).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('tag-fail → 403', async () => {
    seed('helm-chat-notag');
    tagOk = false;
    const { app } = await buildApp({ auth: 'owner', reg, tmux });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/helm-chat-notag/close',
        remoteAddress: '127.0.0.1',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().reason).toBe('tag_failed');
      expect(terminated).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('duplicate → 200 already_reaped: true, one terminate total', async () => {
    seed('helm-chat-dup');
    const { app } = await buildApp({ auth: 'owner', reg, tmux });
    try {
      const r1 = await app.inject({
        method: 'POST',
        url: '/api/sessions/helm-chat-dup/close',
        remoteAddress: '127.0.0.1',
      });
      expect(r1.statusCode).toBe(200);
      expect(r1.json().already_reaped).toBe(false);
      const r2 = await app.inject({
        method: 'POST',
        url: '/api/sessions/helm-chat-dup/close',
        remoteAddress: '127.0.0.1',
      });
      expect(r2.statusCode).toBe(200);
      expect(r2.json().already_reaped).toBe(true);
      expect(terminated).toEqual(['helm-chat-dup']);
    } finally {
      await app.close();
    }
  });

  it('GET /api/sessions returns owner + status', async () => {
    seed('helm-chat-list', { owner: 'human', status: 'active' });
    const { app } = await buildApp({ auth: 'owner', reg, tmux });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/sessions',
        remoteAddress: '127.0.0.1',
      });
      expect(res.statusCode).toBe(200);
      const sessions = res.json().sessions;
      expect(Array.isArray(sessions)).toBe(true);
      const row = sessions.find((s: any) => s.name === 'helm-chat-list');
      expect(row).toMatchObject({ owner: 'human', status: 'active' });
    } finally {
      await app.close();
    }
  });
});
