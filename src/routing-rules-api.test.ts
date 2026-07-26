// A6: HTTP-level coverage for the routing-rules mutation endpoints (POST /api/routing-rules,
// PATCH /api/routing-rules/:id, POST /api/routing-rules/:id/toggle). Route bodies below are a
// deliberate 1:1 mirror of the real handlers registered in src/index.ts — this test exists to
// pin the HTTP status/shape contract (400 core-protected, 400 {problems}, 404, 200) independent
// of the RoutingConfigService unit tests in routing-config-service.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { RoutingConfigService, RoutingCoreProtectedError, RoutingValidationError } from './services/routing-config-service.js';
import { createRequireOwner } from './auth/auth-middleware.js';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-a6-routing-api-'));
  const dbPath = path.join(dir, 'test.db');
  return {
    dbPath,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  };
}

function ownerAuth(req: any, _reply: any, done?: () => void) {
  req.user = { role: 'owner' };
  done?.();
}

async function buildApp(routingConfigService: RoutingConfigService) {
  const app = Fastify({ logger: false });
  const requireOwnerPre = createRequireOwner();

  app.get('/api/routing-rules', { preHandler: [ownerAuth, requireOwnerPre] }, async () => ({
    rules: routingConfigService.listRules(),
    validation: routingConfigService.validateConfig()
  }));

  app.post('/api/routing-rules', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
    const body = request.body || {};
    if (body.is_core != null && Number(body.is_core) !== 0) {
      return reply.code(400).send({ error: 'is_core cannot be set via API — new rules are always custom (non-core)' });
    }
    const { emitter_role, when_status, handler_role, action, note } = body;
    if (!emitter_role || !when_status || !handler_role || !action) {
      return reply.code(400).send({ error: 'emitter_role, when_status, handler_role, action are required' });
    }
    try {
      const rule = routingConfigService.addRule({ emitter_role, when_status, handler_role, action, note: note ?? null });
      return { rule, validation: routingConfigService.validateConfig() };
    } catch (e: any) {
      if (e instanceof RoutingValidationError) return reply.code(400).send({ error: e.message, problems: e.problems });
      return reply.code(400).send({ error: e.message });
    }
  });

  app.patch('/api/routing-rules/:id', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    if (!routingConfigService.getById(id)) return reply.code(404).send({ error: 'unknown routing rule id' });
    const body = request.body || {};
    const patch: { handler_role?: string; action?: string; note?: string | null; enabled?: boolean } = {};
    if (body.handler_role !== undefined) patch.handler_role = body.handler_role;
    if (body.action !== undefined) patch.action = body.action;
    if (body.note !== undefined) patch.note = body.note;
    if (body.enabled !== undefined) patch.enabled = !!body.enabled;
    try {
      const rule = routingConfigService.editRule(id, patch);
      return { rule, validation: routingConfigService.validateConfig() };
    } catch (e: any) {
      if (e instanceof RoutingCoreProtectedError) return reply.code(400).send({ error: e.message });
      if (e instanceof RoutingValidationError) return reply.code(400).send({ error: e.message, problems: e.problems });
      return reply.code(400).send({ error: e.message });
    }
  });

  app.post('/api/routing-rules/:id/toggle', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    const existing = routingConfigService.getById(id);
    if (!existing) return reply.code(404).send({ error: 'unknown routing rule id' });
    const body = request.body || {};
    const enabled = body.enabled !== undefined ? !!body.enabled : existing.enabled !== 1;
    try {
      const rule = routingConfigService.editRule(id, { enabled });
      return { rule, validation: routingConfigService.validateConfig() };
    } catch (e: any) {
      if (e instanceof RoutingValidationError) return reply.code(400).send({ error: e.message, problems: e.problems });
      return reply.code(400).send({ error: e.message });
    }
  });

  await app.ready();
  return app;
}

describe('A6 routing-rules mutation API (POST/PATCH/toggle) — HTTP contract', () => {
  let cleanup: () => void;
  let dbs: DatabaseService;
  let svc: RoutingConfigService;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    svc = new RoutingConfigService(dbs);
    app = await buildApp(svc);
  });

  afterEach(async () => {
    await app.close();
    cleanup();
  });

  it('POST /api/routing-rules adds a non-core rule (200) and rejects an explicit is_core=1 (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/routing-rules',
      payload: { emitter_role: 'panelist', when_status: 'REVIEW', handler_role: 'coord', action: 'advance', note: 'via api' }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rule.is_core).toBe(0);
    expect(body.rule.handler_role).toBe('coord');

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/routing-rules',
      payload: { emitter_role: 'x', when_status: 'y', handler_role: 'z', action: 'w', is_core: 1 }
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toMatch(/is_core/);
  });

  it('PATCH /api/routing-rules/:id edits a non-core rule (200)', async () => {
    const created = svc.addRule({ emitter_role: 'panelist', when_status: 'REVIEW', handler_role: 'coord', action: 'advance' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/routing-rules/${created.id}`,
      payload: { handler_role: 'ibrain', action: 'decide' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rule.handler_role).toBe('ibrain');
  });

  it('PATCH /api/routing-rules/:id on a core rule handler_role/action change -> 400', async () => {
    const core = svc.listRules().find(r => r.emitter_role === 'implementer' && r.when_status === 'DONE')!;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/routing-rules/${core.id}`,
      payload: { handler_role: 'someone-else' }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/core/i);
  });

  it('PATCH disabling a core rule that would leave its transition unrouted -> 400 with problems', async () => {
    const core = svc.listRules().find(r => r.emitter_role === 'implementer' && r.when_status === 'DONE')!;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/routing-rules/${core.id}`,
      payload: { enabled: false }
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(Array.isArray(body.problems)).toBe(true);
    expect(body.problems.length).toBeGreaterThan(0);
    // not persisted
    expect(svc.getById(core.id)!.enabled).toBe(1);
  });

  it('POST /api/routing-rules/:id/toggle on a non-core rule persists', async () => {
    const created = svc.addRule({ emitter_role: 'panelist', when_status: 'REVIEW', handler_role: 'coord', action: 'advance' });
    const res = await app.inject({ method: 'POST', url: `/api/routing-rules/${created.id}/toggle`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().rule.enabled).toBe(0);
    expect(svc.getById(created.id)!.enabled).toBe(0);
  });

  it('PATCH unknown id -> 404', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/routing-rules/999999', payload: { note: 'x' } });
    expect(res.statusCode).toBe(404);
  });
});
