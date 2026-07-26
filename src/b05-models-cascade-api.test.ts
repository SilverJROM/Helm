/**
 * B05 — API: dependent CLI→provider→model filters + no-cli 400.
 * Scope: cascade endpoints/query params + inject tests (no B06 UI).
 */
import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ModelService } from './services/model-service.js';
import { createRequireOwner } from './auth/auth-middleware.js';
import { createRequireLocalLaunch } from './guardrails.js';
import { B04_CANONICAL_SLUGS } from './db/schema.js';

function tempDbPath(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, `helm-test-${process.pid}.db`);
  return {
    dbPath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

function ownerAuth(req: any, _reply: any, done?: () => void) {
  req.user = { role: 'owner' };
  done?.();
}

/** Minimal Fastify surface mirroring index.ts B05 model routes (inject tests). */
async function buildModelsApiApp(ms: ModelService) {
  const app = Fastify({ logger: false });
  const requireOwnerPre = createRequireOwner();
  const requireLocalLaunchPre = createRequireLocalLaunch();
  const authMiddleware = ownerAuth;

  const modelApiError = (e: any) => {
    const msg = String(e?.message || e);
    if (/cli is required/i.test(msg)) return { status: 400, body: { error: msg, field: 'cli' } };
    if (msg.includes('unique')) return { status: 409, body: { error: msg } };
    return { status: 400, body: { error: msg } };
  };

  app.get('/api/models/clis', { preHandler: [authMiddleware, requireOwnerPre] }, async () => ({
    clis: ms.listClis(),
  }));
  app.get('/api/models/providers', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any) => {
    const cli = request.query?.cli != null ? String(request.query.cli) : undefined;
    return { providers: ms.listProviders(cli) };
  });
  app.get('/api/models', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any) => {
    const q = request.query || {};
    const filter: { cli?: string; provider?: string } = {};
    if (q.cli != null && String(q.cli).trim()) filter.cli = String(q.cli).trim();
    if (q.provider != null && String(q.provider).trim()) filter.provider = String(q.provider).trim();
    return {
      models: ms.listModels(filter.cli || filter.provider ? filter : undefined),
    };
  });
  app.get('/api/models/:id', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    const m = ms.getModel(id);
    if (!m) return reply.code(404).send({ error: 'unknown model' });
    return { model: m };
  });
  app.post(
    '/api/models',
    { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] },
    async (request: any, reply: any) => {
      try {
        const m = ms.createModel(request.body || {});
        return { model: m };
      } catch (e: any) {
        const mapped = modelApiError(e);
        return reply.code(mapped.status).send(mapped.body);
      }
    }
  );
  app.put(
    '/api/models/:id',
    { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] },
    async (request: any, reply: any) => {
      const id = Number(request.params.id);
      const body = request.body || {};
      if (!ms.getModel(id)) return reply.code(404).send({ error: 'unknown model' });
      try {
        const m = ms.updateModel(id, body);
        return { model: m };
      } catch (e: any) {
        if (!ms.getModel(id)) return reply.code(404).send({ error: 'unknown model' });
        const mapped = modelApiError(e);
        return reply.code(mapped.status).send(mapped.body);
      }
    }
  );

  await app.ready();
  return app;
}

describe('B05 API cascade CLI→provider→model + no-cli 400', () => {
  const cleanups: Array<() => void> = [];
  afterEach(async () => {
    while (cleanups.length) cleanups.pop()!();
  });

  function fresh(): { ms: ModelService; dbs: DatabaseService } {
    const t = tempDbPath('helm-b05-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;
    const dbs = new DatabaseService(t.dbPath);
    return { ms: new ModelService(dbs), dbs };
  }

  it('service: listClis / listProviders(cli) / listModels({cli,provider}) cascade on B04 seeds', () => {
    const { ms, dbs } = fresh();

    const clis = ms.listClis();
    expect(clis).toEqual(expect.arrayContaining(['claude', 'codex', 'grok', 'kloo']));
    // Sorted distinct
    expect(clis).toEqual([...clis].sort());

    const codexProviders = ms.listProviders('codex');
    expect(codexProviders).toEqual(['codex']);
    expect(ms.listProviders('claude')).toEqual(['claude']);
    expect(ms.listProviders('kloo')).toEqual(['kloo']);

    // Unknown cli → empty providers
    expect(ms.listProviders('no-such-cli')).toEqual([]);

    const codexModels = ms.listModels({ cli: 'codex', provider: 'codex' });
    expect(codexModels.length).toBeGreaterThan(0);
    for (const m of codexModels) {
      expect(m.cli).toBe('codex');
      expect(m.provider).toBe('codex');
    }

    const grokOnly = ms.listModels({ cli: 'grok' });
    expect(grokOnly.length).toBeGreaterThan(0);
    expect(grokOnly.every((m) => m.cli === 'grok')).toBe(true);

    // Mismatched cascade (cli=claude provider=codex) → empty
    expect(ms.listModels({ cli: 'claude', provider: 'codex' })).toEqual([]);

    // Canonical B04 slugs still present unfiltered
    const all = ms.listModels();
    const slugs = new Set(all.map((m) => m.slug));
    for (const s of B04_CANONICAL_SLUGS) {
      expect(slugs.has(s), `B04 slug present: ${s}`).toBe(true);
    }

    dbs.close();
  });

  it('inject: GET cascade endpoints constrain CLI→providers→models', async () => {
    const { ms, dbs } = fresh();
    const app = await buildModelsApiApp(ms);
    cleanups.push(() => {
      void app.close();
    });

    const clisRes = await app.inject({
      method: 'GET',
      url: '/api/models/clis',
      remoteAddress: '127.0.0.1',
    });
    expect(clisRes.statusCode).toBe(200);
    const clisBody = clisRes.json();
    expect(Array.isArray(clisBody.clis)).toBe(true);
    expect(clisBody.clis).toEqual(expect.arrayContaining(['claude', 'codex', 'grok', 'kloo']));

    // Static path must not be captured by /:id
    expect(clisBody.error).toBeUndefined();

    const provRes = await app.inject({
      method: 'GET',
      url: '/api/models/providers?cli=codex',
      remoteAddress: '127.0.0.1',
    });
    expect(provRes.statusCode).toBe(200);
    expect(provRes.json().providers).toEqual(['codex']);

    const modelsRes = await app.inject({
      method: 'GET',
      url: '/api/models?cli=codex&provider=codex',
      remoteAddress: '127.0.0.1',
    });
    expect(modelsRes.statusCode).toBe(200);
    const models = modelsRes.json().models as Array<{ cli: string; provider: string; slug: string }>;
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.cli === 'codex' && m.provider === 'codex')).toBe(true);
    // B04 codex family present under filter
    const filteredSlugs = new Set(models.map((m) => m.slug));
    expect(filteredSlugs.has('codex55') || filteredSlugs.has('codex54min') || filteredSlugs.has('spark')).toBe(
      true
    );

    const emptyCascade = await app.inject({
      method: 'GET',
      url: '/api/models?cli=claude&provider=codex',
      remoteAddress: '127.0.0.1',
    });
    expect(emptyCascade.statusCode).toBe(200);
    expect(emptyCascade.json().models).toEqual([]);

    dbs.close();
  });

  it('inject: POST without cli returns 400 structured { error, field: "cli" }', async () => {
    const { ms, dbs } = fresh();
    const app = await buildModelsApiApp(ms);
    cleanups.push(() => {
      void app.close();
    });

    const missing = await app.inject({
      method: 'POST',
      url: '/api/models',
      remoteAddress: '127.0.0.1',
      payload: { name: 'b05-no-cli', provider: 'grok', model_id: 'grok-b05' },
    });
    expect(missing.statusCode).toBe(400);
    const body = missing.json();
    expect(body.error).toMatch(/cli is required/i);
    expect(body.field).toBe('cli');

    const empty = await app.inject({
      method: 'POST',
      url: '/api/models',
      remoteAddress: '127.0.0.1',
      payload: { name: 'b05-empty-cli', provider: 'grok', model_id: 'grok-b05-e', cli: '  ' },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().field).toBe('cli');

    // Valid create still works (control)
    const ok = await app.inject({
      method: 'POST',
      url: '/api/models',
      remoteAddress: '127.0.0.1',
      payload: {
        name: 'b05-with-cli',
        provider: 'grok',
        model_id: 'grok-b05-ok',
        cli: 'grok',
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().model.cli).toBe('grok');

    dbs.close();
  });

  it('inject: PUT with empty cli returns 400 structured field=cli', async () => {
    const { ms, dbs } = fresh();
    const app = await buildModelsApiApp(ms);
    cleanups.push(() => {
      void app.close();
    });

    const created = ms.createModel({
      name: 'b05-put-target',
      provider: 'claude',
      model_id: 'claude-b05-put',
      cli: 'claude',
    });

    const bad = await app.inject({
      method: 'PUT',
      url: `/api/models/${created.id}`,
      remoteAddress: '127.0.0.1',
      payload: { cli: '' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/cli is required/i);
    expect(bad.json().field).toBe('cli');

    // GET by id still works (static routes did not break :id)
    const get = await app.inject({
      method: 'GET',
      url: `/api/models/${created.id}`,
      remoteAddress: '127.0.0.1',
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().model.cli).toBe('claude');

    dbs.close();
  });
});
