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
  computeRunCompletePayloadHash,
} from './services/run-ingest-service.js';

function tempDb(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dbPath: path.join(dir, 'helm.db'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function hash64(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

function registerFields(overrides: Partial<{ event_id: string; external_run_id: string; generation: number }> = {}) {
  return {
    event_id: overrides.event_id ?? 'event-register-1',
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

function registerEnvelope(projectId: number, overrides: Partial<{ event_id: string; external_run_id: string; generation: number }> = {}) {
  const fields = registerFields(overrides);
  const payload_hash = computeRunRegisterPayloadHash(projectId, fields);
  return { envelope: RUN_REGISTER_ENVELOPE, ...fields, payload_hash };
}

function completeFields(overrides: Partial<{
  event_id: string;
  external_run_id: string;
  generation: number;
  expected_state_revision: number;
  terminal_state: 'success' | 'failed' | 'blocked';
  seal: string;
  reason: string;
}> = {}) {
  const terminal_state = overrides.terminal_state ?? 'success';
  const fields: any = {
    event_id: overrides.event_id ?? 'event-complete-1',
    external_run_id: overrides.external_run_id ?? '9715',
    generation: overrides.generation ?? 0,
    expected_state_revision: overrides.expected_state_revision ?? 0,
    terminal_state,
  };
  if (terminal_state === 'success') {
    fields.seal = overrides.seal ?? hash64('capstone-seal');
  } else {
    fields.reason = overrides.reason ?? 'downstream dependency unavailable';
  }
  return fields;
}

function completeEnvelope(projectId: number, overrides: Parameters<typeof completeFields>[0] = {}) {
  const fields = completeFields(overrides);
  const payload_hash = computeRunCompletePayloadHash(projectId, fields);
  return { envelope: RUN_REGISTER_ENVELOPE, ...fields, payload_hash };
}

describe('O5.3 RunIngestService.complete + POST /api/ingest/run-complete', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  function setup() {
    const t = tempDb('helm-o53-');
    cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    dbs.raw.prepare("INSERT INTO projects (id, name, directory, status, active) VALUES (1, 'Helm', '/work/helm', 'active', 1)").run();
    const service = new RunIngestService(dbs);
    return { dbPath: t.dbPath, dbs, service };
  }

  function registered(service: RunIngestService, projectId = 1) {
    return service.register(projectId, registerEnvelope(projectId));
  }

  it('T1: a registered active run completes in one transaction — CAS-updates revision/status/phase/ended_at, appends one TERMINAL run_event, records one receipt; exact replay is a no-op success', () => {
    const { dbs, service } = setup();
    const reg = registered(service);

    // B04 fix cycle 1: complete() looks up the run by the AUTHORITATIVE generation register()
    // returned, which may differ from the raw supplied hint (max'd against the fresh allocator).
    const envelope = completeEnvelope(1, { generation: reg.body.generation });
    const done = service.complete(1, envelope);
    expect(done.httpStatus).toBe(200);
    expect(done.replay).toBe(false);
    expect(done.body).toEqual({
      ok: true,
      run_id: 1,
      project_id: 1,
      external_run_id: '9715',
      generation: reg.body.generation,
      event_id: 'event-complete-1',
      terminal_state: 'success',
      state_revision: 1,
    });

    const run: any = dbs.raw.prepare('SELECT status, phase, state_revision, terminal_seal_hash, ended_at FROM runs WHERE id = 1').get();
    expect(run.status).toBe('complete');
    expect(run.phase).toBe('complete');
    expect(run.state_revision).toBe(1);
    expect(run.terminal_seal_hash).toBe(envelope.seal);
    expect(run.ended_at).toBeTruthy();

    expect(dbs.raw.prepare("SELECT COUNT(*) AS n FROM run_events WHERE event_type = 'TERMINAL'").get()).toEqual({ n: 1 });
    expect(dbs.raw.prepare('SELECT COUNT(*) AS n FROM run_ingest_receipts').get()).toEqual({ n: 2 }); // register + complete

    const replay = service.complete(1, envelope);
    expect(replay.httpStatus).toBe(200);
    expect(replay.replay).toBe(true);
    expect(replay.body).toEqual(done.body);

    // AC2: replay is a no-op — no extra event, receipt, or revision bump.
    expect(dbs.raw.prepare("SELECT COUNT(*) AS n FROM run_events WHERE event_type = 'TERMINAL'").get()).toEqual({ n: 1 });
    expect(dbs.raw.prepare('SELECT COUNT(*) AS n FROM run_ingest_receipts').get()).toEqual({ n: 2 });
    expect((dbs.raw.prepare('SELECT state_revision FROM runs WHERE id = 1').get() as any).state_revision).toBe(1);
  });

  it('T2: complete-before-register is rejected with zero mutation', () => {
    const { dbs, service } = setup();
    expect(() => service.complete(1, completeEnvelope(1))).toThrow(RunIngestConflictError);
    expect(dbs.raw.prepare('SELECT COUNT(*) AS n FROM run_ingest_receipts').get()).toEqual({ n: 0 });
  });

  it('T2: a stale expected_state_revision is rejected with zero mutation', () => {
    const { dbs, service } = setup();
    const reg = registered(service);
    const stale = completeEnvelope(1, { generation: reg.body.generation, expected_state_revision: 5 });
    expect(() => service.complete(1, stale)).toThrow(RunIngestConflictError);

    const run: any = dbs.raw.prepare('SELECT status, state_revision FROM runs WHERE id = 1').get();
    expect(run.status).toBe('active');
    expect(run.state_revision).toBe(0);
    expect(dbs.raw.prepare('SELECT COUNT(*) AS n FROM run_ingest_receipts').get()).toEqual({ n: 1 }); // register only
  });

  it('T2: completing an already-terminal run under a new event_id is a conflicting terminal replay, rejected with zero mutation', () => {
    const { dbs, service } = setup();
    const reg = registered(service);
    service.complete(1, completeEnvelope(1, { generation: reg.body.generation }));

    const second = completeEnvelope(1, { generation: reg.body.generation, event_id: 'event-complete-2', expected_state_revision: 1 });
    expect(() => service.complete(1, second)).toThrow(RunIngestConflictError);

    expect(dbs.raw.prepare('SELECT COUNT(*) AS n FROM run_ingest_receipts').get()).toEqual({ n: 2 }); // register + first complete only
    expect((dbs.raw.prepare('SELECT state_revision FROM runs WHERE id = 1').get() as any).state_revision).toBe(1);
  });

  it('T2: the same event_id reused with a different outcome is a conflict, not a replay', () => {
    const { dbs, service } = setup();
    const reg = registered(service);
    const first = completeEnvelope(1, { generation: reg.body.generation });
    service.complete(1, first);

    const reused = { ...completeEnvelope(1, { generation: reg.body.generation, terminal_state: 'failed', reason: 'different outcome' }), event_id: first.event_id };
    expect(() => service.complete(1, reused)).toThrow(RunIngestConflictError);
  });

  it('T2: attempting to complete a run whose status left "active" outside the ingest path (invalid transition) is rejected before any write', () => {
    const { dbs, service } = setup();
    const reg = registered(service);
    // Simulate termination via a different path (e.g. legacy orchestrator) — no complete() receipt exists yet,
    // so this exercises the active-status guard specifically rather than the semantic-key replay guard.
    dbs.raw.prepare("UPDATE runs SET status = 'failed', phase = 'blocked' WHERE id = 1").run();

    const attempt = completeEnvelope(1, { generation: reg.body.generation });
    expect(() => service.complete(1, attempt)).toThrow(RunIngestConflictError);
    expect(dbs.raw.prepare('SELECT COUNT(*) AS n FROM run_ingest_receipts').get()).toEqual({ n: 1 }); // register only
  });

  it('T3: missing success seal, missing failed/blocked reason, and a malformed terminal_state are rejected with zero mutation', () => {
    const { dbs, service } = setup();
    const reg = registered(service);

    expect(() => service.complete(1, { ...completeEnvelope(1, { generation: reg.body.generation }), seal: undefined })).toThrow(RunIngestValidationError);
    expect(() => service.complete(1, { ...completeEnvelope(1, { generation: reg.body.generation, terminal_state: 'failed' }), reason: undefined })).toThrow(RunIngestValidationError);
    expect(() => service.complete(1, { ...completeEnvelope(1, { generation: reg.body.generation }), terminal_state: 'unknown' })).toThrow(RunIngestValidationError);

    expect(dbs.raw.prepare('SELECT COUNT(*) AS n FROM run_ingest_receipts').get()).toEqual({ n: 1 }); // register only
    const run: any = dbs.raw.prepare('SELECT status, state_revision FROM runs WHERE id = 1').get();
    expect(run.status).toBe('active');
    expect(run.state_revision).toBe(0);
  });

  it('T3: failed and blocked terminal states map to status=failed with phase=failed / phase=blocked respectively', () => {
    const { dbs, service } = setup();
    const reg = registered(service);
    service.complete(1, completeEnvelope(1, { generation: reg.body.generation, terminal_state: 'failed' }));
    const run: any = dbs.raw.prepare('SELECT status, phase, terminal_seal_hash FROM runs WHERE id = 1').get();
    expect(run.status).toBe('failed');
    expect(run.phase).toBe('failed');
    expect(run.terminal_seal_hash).toBeNull();

    const secondRun = service.register(1, registerEnvelope(1, { event_id: 'event-register-2', external_run_id: '9716' }));
    service.complete(1, completeEnvelope(1, {
      generation: secondRun.body.generation, external_run_id: '9716', event_id: 'event-complete-blocked', terminal_state: 'blocked', reason: 'awaiting upstream approval',
    }));
    const blockedRun: any = dbs.raw.prepare('SELECT status, phase FROM runs WHERE id = ?').get(secondRun.body.run_id);
    expect(blockedRun.status).toBe('failed');
    expect(blockedRun.phase).toBe('blocked');
  });

  it('T3: restart reads one consistent terminal state — a fresh DatabaseService against the same file sees the same terminal row', () => {
    const { dbPath, dbs, service } = setup();
    const reg = registered(service);
    const done = service.complete(1, completeEnvelope(1, { generation: reg.body.generation }));

    const restarted = new DatabaseService(dbPath);
    const run: any = restarted.raw.prepare('SELECT status, phase, state_revision, terminal_seal_hash FROM runs WHERE id = 1').get();
    expect(run.status).toBe('complete');
    expect(run.phase).toBe('complete');
    expect(run.state_revision).toBe(done.body.state_revision);
    expect(dbs.raw.prepare("SELECT COUNT(*) AS n FROM run_events WHERE event_type = 'TERMINAL'").get()).toEqual({ n: 1 });
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
      app.post('/api/ingest/run-complete', { preHandler: [requireLocal] }, async (request: any, reply: any) => {
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
          const result = service.complete(guard.project.id, body);
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
      const t = tempDb('helm-o53-route-');
      cleanups.push(t.cleanup);
      const dbs = new DatabaseService(t.dbPath);
      dbs.raw.prepare("INSERT INTO projects (id, name, directory, status, active) VALUES (1, 'Helm', '/work/helm', 'active', 1)").run();
      const service = new RunIngestService(dbs);
      const reg = service.register(1, registerEnvelope(1));
      const auth = new AuthService('o53-test-secret');
      const identity = new HelmIdentityService(dbs);
      const app = buildApp(dbs, service, auth, identity);
      return { dbs, service, auth, app, generation: reg.body.generation };
    }

    it('T3: valid coord-scoped token from loopback completes with 200', async () => {
      const { app, auth, generation } = routeSetup();
      const token = auth.issueScopedAgentToken({ projectId: 1, runId: 'r1', batchId: 'O5', role: 'coord' });
      const res = await app.inject({
        method: 'POST', url: '/api/ingest/run-complete', remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${token}` }, payload: completeEnvelope(1, { generation }),
      });
      expect(res.statusCode).toBe(200);
    });

    it('T3: non-loopback request is rejected before auth is even checked', async () => {
      const { app, auth, generation } = routeSetup();
      const token = auth.issueScopedAgentToken({ projectId: 1, runId: 'r1', batchId: 'O5', role: 'coord' });
      const res = await app.inject({
        method: 'POST', url: '/api/ingest/run-complete', remoteAddress: '8.8.8.8',
        headers: { authorization: `Bearer ${token}` }, payload: completeEnvelope(1, { generation }),
      });
      expect(res.statusCode).toBe(403);
    });

    it('T3: missing/invalid token → 401', async () => {
      const { app, generation } = routeSetup();
      const missing = await app.inject({ method: 'POST', url: '/api/ingest/run-complete', remoteAddress: '127.0.0.1', payload: completeEnvelope(1, { generation }) });
      expect(missing.statusCode).toBe(401);
      const bad = await app.inject({ method: 'POST', url: '/api/ingest/run-complete', remoteAddress: '127.0.0.1', headers: { authorization: 'Bearer garbage' }, payload: completeEnvelope(1, { generation }) });
      expect(bad.statusCode).toBe(401);
    });

    it('T3: a worker-scoped role is rejected — only coord/phase-brain roles may complete', async () => {
      const { app, auth, generation } = routeSetup();
      const token = auth.issueScopedAgentToken({ projectId: 1, runId: 'r1', batchId: 'O5', role: 'implementer' });
      const res = await app.inject({
        method: 'POST', url: '/api/ingest/run-complete', remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${token}` }, payload: completeEnvelope(1, { generation }),
      });
      expect(res.statusCode).toBe(403);
    });

    it('T3: a body project_id that disagrees with the token claim is rejected as a spoof before write', async () => {
      const { app, auth, dbs, generation } = routeSetup();
      dbs.raw.prepare("INSERT INTO projects (id, name, directory, status, active) VALUES (2, 'Other', '/work/other', 'active', 1)").run();
      const token = auth.issueScopedAgentToken({ projectId: 1, runId: 'r1', batchId: 'O5', role: 'ibrain' });
      const res = await app.inject({
        method: 'POST', url: '/api/ingest/run-complete', remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${token}` }, payload: { ...completeEnvelope(1, { generation }), project_id: 2 },
      });
      expect(res.statusCode).toBe(403);
      expect((dbs.raw.prepare('SELECT status FROM runs WHERE id = 1').get() as any).status).toBe('active');
    });

    it('T3: malformed-seal envelope through the route returns 400 with zero mutation', async () => {
      const { app, auth, dbs, generation } = routeSetup();
      const token = auth.issueScopedAgentToken({ projectId: 1, runId: 'r1', batchId: 'O5', role: 'coord' });
      const res = await app.inject({
        method: 'POST', url: '/api/ingest/run-complete', remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${token}` }, payload: { ...completeEnvelope(1, { generation }), seal: undefined },
      });
      expect(res.statusCode).toBe(400);
      expect((dbs.raw.prepare('SELECT status FROM runs WHERE id = 1').get() as any).status).toBe('active');
    });
  });
});
