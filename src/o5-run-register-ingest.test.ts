import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from './db/database.js';
import { HelmIdentityService, requireActiveNativeProject } from './services/helm-identity-service.js';
import { AuthService } from './auth/auth-service.js';
import {
  RunIngestService,
  RunIngestConflictError,
  RunIngestValidationError,
  RUN_REGISTER_ENVELOPE,
  computeRunRegisterPayloadHash,
} from './services/run-ingest-service.js';

function tempDb(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dbPath: path.join(dir, 'helm.db'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function hash64(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

function baseFields(overrides: Partial<{ event_id: string; external_run_id: string; generation: number }> = {}) {
  return {
    event_id: overrides.event_id ?? 'event-1',
    external_run_id: overrides.external_run_id ?? '9715',
    generation: overrides.generation ?? 0,
    hashes: {
      ready: hash64('ready'),
      plan: hash64('plan'),
      queue: hash64('queue'),
      topology: hash64('topology'),
    },
  };
}

function sealedEnvelope(projectId: number, overrides: Partial<{ event_id: string; external_run_id: string; generation: number }> = {}) {
  const fields = baseFields(overrides);
  const payload_hash = computeRunRegisterPayloadHash(projectId, fields);
  return { envelope: RUN_REGISTER_ENVELOPE, ...fields, payload_hash };
}

describe('O5.2 RunIngestService.register + POST /api/ingest/run-register', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  function setup() {
    const t = tempDb('helm-o52-');
    cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    dbs.raw.prepare("INSERT INTO projects (id, name, directory, status, active) VALUES (1, 'Helm', '/work/helm', 'active', 1)").run();
    const service = new RunIngestService(dbs);
    return { dbs, service };
  }

  it('T1: first valid request atomically inserts one run, one REGISTERED run_event, one receipt, returns 201; exact replay returns the stored response with 200 and no extra rows', () => {
    const { dbs, service } = setup();
    const envelope = sealedEnvelope(1);

    const created = service.register(1, envelope);
    expect(created.httpStatus).toBe(201);
    expect(created.replay).toBe(false);
    expect(created.body.ok).toBe(true);
    expect(created.body.project_id).toBe(1);
    expect(created.body.external_run_id).toBe('9715');
    // B04 fix cycle 1 (redteam C1): the response echoes the AUTHORITATIVE written generation
    // (max(fresh lifecycle_seq allocation, caller-supplied 0)), not necessarily the raw supplied
    // value — never reused/never below any generation already issued in this DB's history.
    expect(created.body.generation).toBeGreaterThanOrEqual(envelope.generation);

    expect(dbs.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 1 });
    expect(dbs.raw.prepare("SELECT COUNT(*) AS n FROM run_events WHERE event_type = 'REGISTERED'").get()).toEqual({ n: 1 });
    expect(dbs.raw.prepare('SELECT COUNT(*) AS n FROM run_ingest_receipts').get()).toEqual({ n: 1 });
    const run: any = dbs.raw.prepare('SELECT source, status, external_run_id, generation, register_seal_hash FROM runs').get();
    expect(run.source).toBe('ingest');
    expect(run.status).toBe('active');
    expect(run.external_run_id).toBe('9715');
    expect(run.generation).toBe(created.body.generation);
    expect(run.register_seal_hash).toBe(envelope.payload_hash);

    const replay = service.register(1, envelope);
    expect(replay.httpStatus).toBe(200);
    expect(replay.replay).toBe(true);
    expect(replay.body).toEqual(created.body);

    expect(dbs.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 1 });
    expect(dbs.raw.prepare("SELECT COUNT(*) AS n FROM run_events WHERE event_type = 'REGISTERED'").get()).toEqual({ n: 1 });
    expect(dbs.raw.prepare('SELECT COUNT(*) AS n FROM run_ingest_receipts').get()).toEqual({ n: 1 });
  });

  it('T2: same event_id with a different canonical hash returns a conflict with zero mutation', () => {
    const { dbs, service } = setup();
    const envelope = sealedEnvelope(1);
    service.register(1, envelope);

    const conflicting = sealedEnvelope(1, { external_run_id: '9716' }); // different identity, same event_id
    const reused = { ...conflicting, event_id: envelope.event_id };
    expect(() => service.register(1, reused)).toThrow(RunIngestConflictError);

    expect(dbs.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 1 });
    expect(dbs.raw.prepare('SELECT COUNT(*) AS n FROM run_ingest_receipts').get()).toEqual({ n: 1 });
  });

  it('T2: same semantic run key (project/external_run_id/generation) under a new event_id returns a conflict with zero mutation', () => {
    const { dbs, service } = setup();
    const first = sealedEnvelope(1);
    service.register(1, first);

    const second = sealedEnvelope(1, { event_id: 'event-2' }); // same external_run_id + generation, new event
    expect(() => service.register(1, second)).toThrow(RunIngestConflictError);

    expect(dbs.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 1 });
    expect(dbs.raw.prepare('SELECT COUNT(*) AS n FROM run_ingest_receipts').get()).toEqual({ n: 1 });
  });

  it('T2: a different generation for the same external_run_id is a distinct identity and registers cleanly', () => {
    const { dbs, service } = setup();
    service.register(1, sealedEnvelope(1));
    const nextGen = service.register(1, sealedEnvelope(1, { event_id: 'event-2', generation: 1 }));
    expect(nextGen.httpStatus).toBe(201);
    expect(dbs.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 2 });
  });

  it('T3: malformed-seal rejection — wrong envelope name, bad hash shape, and a payload_hash that disagrees with the canonical server hash', () => {
    const { dbs, service } = setup();
    expect(() => service.register(1, { ...sealedEnvelope(1), envelope: 'helm.run-ingest/v0' })).toThrow(RunIngestValidationError);
    expect(() => service.register(1, { ...sealedEnvelope(1), hashes: { ready: 'not-a-hash', plan: hash64('p'), queue: hash64('q'), topology: hash64('t') } })).toThrow(RunIngestValidationError);
    const tampered = sealedEnvelope(1);
    (tampered as any).payload_hash = hash64('tampered');
    expect(() => service.register(1, tampered)).toThrow(RunIngestValidationError);

    // AC4: zero mutation from any rejected request.
    expect(dbs.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
    expect(dbs.raw.prepare('SELECT COUNT(*) AS n FROM run_ingest_receipts').get()).toEqual({ n: 0 });
  });

  describe('route: loopback + coordinator/phase-brain-scoped token gate', () => {
    function buildApp(dbs: DatabaseService, service: RunIngestService, auth: AuthService, identity: HelmIdentityService) {
      const app = Fastify();
      const requireLocal = (request: any, reply: any, done: any) => {
        const addr = request.raw?.socket?.remoteAddress;
        if (addr !== '127.0.0.1' && addr !== '::1') {
          reply.code(403).send({ error: 'local launch required (loopback only)' });
          return;
        }
        done();
      };
      app.post('/api/ingest/run-register', { preHandler: [requireLocal] }, async (request: any, reply: any) => {
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return reply.code(401).send({ error: 'missing or invalid authorization header' });
        }
        const token = authHeader.slice(7);
        const scoped = auth.verifyScopedAgentToken(token);
        if (!scoped) return reply.code(401).send({ error: 'invalid or expired token' });
        if (!['coord', 'plancore', 'ibrain'].includes(scoped.role)) {
          return reply.code(403).send({ error: 'coordinator/phase-brain-scoped token required' });
        }
        const body = request.body || {};
        if (body.project_id != null && Number(body.project_id) !== scoped.projectId) {
          return reply.code(403).send({ error: 'cross-project spoof rejected' });
        }
        const guard = requireActiveNativeProject(identity, scoped.projectId);
        if (!guard.ok) return reply.code(400).send({ error: guard.error });
        try {
          const result = service.register(guard.project.id, body);
          return reply.code(result.httpStatus).send(result.body);
        } catch (e: any) {
          if (e instanceof RunIngestValidationError) return reply.code(400).send({ error: e.message });
          if (e instanceof RunIngestConflictError) return reply.code(409).send({ error: e.message });
          throw e;
        }
      });
      return app;
    }

    function routeSetup() {
      const t = tempDb('helm-o52-route-');
      cleanups.push(t.cleanup);
      const dbs = new DatabaseService(t.dbPath);
      dbs.raw.prepare("INSERT INTO projects (id, name, directory, status, active) VALUES (1, 'Helm', '/work/helm', 'active', 1)").run();
      const service = new RunIngestService(dbs);
      const auth = new AuthService('o52-test-secret');
      const identity = new HelmIdentityService(dbs);
      const app = buildApp(dbs, service, auth, identity);
      return { dbs, service, auth, app };
    }

    it('T3: valid coord-scoped token from loopback registers 201', async () => {
      const { app, auth } = routeSetup();
      const token = auth.issueScopedAgentToken({ projectId: 1, runId: 'r1', batchId: 'O5', role: 'coord' });
      const envelope = sealedEnvelope(1);
      const res = await app.inject({
        method: 'POST', url: '/api/ingest/run-register', remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${token}` }, payload: envelope,
      });
      expect(res.statusCode).toBe(201);
    });

    it('T3: non-loopback request is rejected before auth is even checked', async () => {
      const { app, auth } = routeSetup();
      const token = auth.issueScopedAgentToken({ projectId: 1, runId: 'r1', batchId: 'O5', role: 'coord' });
      const res = await app.inject({
        method: 'POST', url: '/api/ingest/run-register', remoteAddress: '8.8.8.8',
        headers: { authorization: `Bearer ${token}` }, payload: sealedEnvelope(1),
      });
      expect(res.statusCode).toBe(403);
    });

    it('T3: missing/invalid token → 401', async () => {
      const { app } = routeSetup();
      const missing = await app.inject({ method: 'POST', url: '/api/ingest/run-register', remoteAddress: '127.0.0.1', payload: sealedEnvelope(1) });
      expect(missing.statusCode).toBe(401);
      const bad = await app.inject({ method: 'POST', url: '/api/ingest/run-register', remoteAddress: '127.0.0.1', headers: { authorization: 'Bearer garbage' }, payload: sealedEnvelope(1) });
      expect(bad.statusCode).toBe(401);
    });

    it('T3: a worker-scoped role is rejected — only coord/phase-brain roles may register', async () => {
      const { app, auth } = routeSetup();
      const token = auth.issueScopedAgentToken({ projectId: 1, runId: 'r1', batchId: 'O5', role: 'implementer' });
      const res = await app.inject({
        method: 'POST', url: '/api/ingest/run-register', remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${token}` }, payload: sealedEnvelope(1),
      });
      expect(res.statusCode).toBe(403);
    });

    it('T3: a body project_id that disagrees with the token claim is rejected as a spoof before write', async () => {
      const { app, auth, dbs } = routeSetup();
      dbs.raw.prepare("INSERT INTO projects (id, name, directory, status, active) VALUES (2, 'Other', '/work/other', 'active', 1)").run();
      const token = auth.issueScopedAgentToken({ projectId: 1, runId: 'r1', batchId: 'O5', role: 'plancore' });
      const res = await app.inject({
        method: 'POST', url: '/api/ingest/run-register', remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${token}` }, payload: { ...sealedEnvelope(1), project_id: 2 },
      });
      expect(res.statusCode).toBe(403);
      expect(dbs.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
    });

    it('T3: an inactive/unknown project denies before any write', async () => {
      const { app, auth, dbs } = routeSetup();
      const token = auth.issueScopedAgentToken({ projectId: 999, runId: 'r1', batchId: 'O5', role: 'coord' });
      const res = await app.inject({
        method: 'POST', url: '/api/ingest/run-register', remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${token}` }, payload: sealedEnvelope(999),
      });
      expect(res.statusCode).toBe(400);
      expect(dbs.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
    });

    it('T3: malformed-seal envelope through the route returns 400 with zero mutation', async () => {
      const { app, auth, dbs } = routeSetup();
      const token = auth.issueScopedAgentToken({ projectId: 1, runId: 'r1', batchId: 'O5', role: 'coord' });
      const tampered = sealedEnvelope(1);
      (tampered as any).payload_hash = hash64('tampered');
      const res = await app.inject({
        method: 'POST', url: '/api/ingest/run-register', remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${token}` }, payload: tampered,
      });
      expect(res.statusCode).toBe(400);
      expect(dbs.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
    });
  });
});
