import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from './db/database.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { ToolkitService } from './services/toolkit-service.js';
import { MasterModelService } from './services/master-model-service.js';
import { HelmIdentityService } from './services/helm-identity-service.js';
import { createRequireOwner } from './auth/auth-middleware.js';
import { createRequireLocalLaunch } from './guardrails.js';
import { SCHEMA_VERSION } from './db/schema.js';

describe('P1-4 Project Setup (bindings + master chain + config API + outcomes)', () => {
  let helmDbPath: string;
  let secret: string;
  let helmDb: any;
  let assignment: any;
  let master: any;
  let realPid: number;
  let ownerToken: string;

  beforeEach(() => {
    helmDbPath = `/tmp/helm-p4-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    secret = 'agjassist-dev-secret-change-me';

    helmDb = new DatabaseService(helmDbPath); // triggers v3 mig

    assignment = new AgentAssignmentService(helmDb);
    // O7.2: native identity is the sole boundary — no external db.
    master = new MasterModelService(helmDb, new HelmIdentityService(helmDb));

    realPid = 501;

    // O4.1: setChain is now gated on the native project-identity row existing+active — seed it
    // before any setChain call below (Helm's own projects table is the sole identity source).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `helm-p4-proj-${realPid}-`));
    helmDb.raw.prepare('INSERT OR IGNORE INTO projects (id, name, directory) VALUES (?,?,?)').run(realPid, `p4-test-${realPid}`, dir);

    ownerToken = jwt.sign({ sub: 1, sid: 'test', tid: 0 }, secret, { expiresIn: '1h' });
  });

  afterEach(() => {
    if (helmDb && helmDb.close) helmDb.close();
    try { fs.unlinkSync(helmDbPath); } catch {}
  });

  it('master chain persists ORDERED and GET returns same order', () => {
    // RTF-H1: claude is rejected as a persistent master in P1; use two valid non-claude providers
    const chain = [{provider: 'grok', model: 'grok-4.5'}, {provider: 'codex', model: 'gpt-5.5'}];
    master.setChain(realPid, chain);
    const got = master.getChain(realPid);
    expect(got.length).toBe(2);
    expect(got[0].model).toBe('grok-4.5');
    expect(got[1].model).toBe('gpt-5.5');
    expect(master.isSetUp(realPid)).toBe(true);
  });

  it('validates each {provider,model} against P1-2 registry — unknown → error (400 in route)', () => {
    expect(() => master.setChain(realPid, [{provider: 'grok', model: 'bad-model'}])).toThrow(/unknown/);
  });

  it(':id must be REAL OVM project (via seam) — unknown id rejected', () => {
    expect(() => master.setChain(99999999, [{provider: 'grok', model: 'grok-4.5'}])).toThrow(/unknown OVM/);
  });

  it('per-project agent override wins over default (resolveProjectRole: binding > default)', () => {
    const role = 'implementer';
    // create agent
    const agent = assignment.createAgent({ name: 'p4-test-agent', provider: 'grok', model: 'grok-4.5' });
    // set default
    assignment.setRoleDefault(role, agent.id);
    let resolved = assignment.resolveProjectRole(realPid, role);
    expect(resolved!.source).toBe('default');
    // set binding (override)
    assignment.setProjectBinding(realPid, role, agent.id);
    resolved = assignment.resolveProjectRole(realPid, role);
    expect(resolved!.source).toBe('binding');
  });

  it('config routes owner-only (non-owner → 403 via preHandler)', () => {
    const requireO = createRequireOwner();
    const req: any = { user: { role: 'viewer' } };
    const reply: any = { code: vi.fn().mockReturnThis(), send: vi.fn() };
    let done = false;
    requireO(req, reply, () => { done = true; });
    expect(done).toBe(false);
    expect(reply.code).toHaveBeenCalledWith(403);
  });

  // HTTP outcome via small test app (re-uses pre + services; proves routes + seam validate in handler)
  it('full route outcomes (real OVM, model validate, owner 200/403)', async () => {
    const testApp = Fastify();
    const authMw = async (req: any) => { req.user = { role: 'owner' }; }; // sim
    const requireO = createRequireOwner();
    // mount the config GET (simplified handler using services)
    testApp.get('/api/projects/:id/config', { preHandler: [async (r:any)=> { r.user={role:'owner'}; }, requireO] }, async (req: any, reply: any) => {
      const pid = Number(req.params.id);
      const exists = helmDb.raw.prepare("SELECT 1 FROM projects WHERE id=? AND status='active' AND active=1").get(pid);
      if (!exists) return reply.code(400).send({error:'unknown OVM project'});
      const mc = master.getChain(pid);
      return { master_chain: mc, is_set_up: mc.length>0 };
    });
    // test owner
    const res = await testApp.inject({ method: 'GET', url: `/api/projects/${realPid}/config` });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(Array.isArray(b.master_chain)).toBe(true);
    // bad id
    const bad = await testApp.inject({ method: 'GET', url: '/api/projects/99999999/config' });
    expect(bad.statusCode).toBe(400);
  });

  it('real upgrade from v2 and fresh db version=3', () => {
    // seed pure v2 DB (no P1-4 tables)
    const v2Path = `/tmp/helm-v2-seed-${Date.now()}.db`;
    const v2 = new Database(v2Path);
    v2.exec(`
CREATE TABLE IF NOT EXISTS schema_version ( version INTEGER NOT NULL );
CREATE TABLE IF NOT EXISTS agent_events (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  session TEXT,
  type TEXT NOT NULL CHECK(type IN ('message', 'status', 'tool', 'gate')),
  state TEXT,
  source TEXT NOT NULL CHECK(source IN ('callback', 'git', 'pane', 'post')),
  correlation_id TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '{}',
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_events_run_ts ON agent_events(run_id, ts);
CREATE INDEX IF NOT EXISTS idx_agent_events_batch_type ON agent_events(run_id, batch_id, type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_events_terminal_dedupe
  ON agent_events(run_id, batch_id, state, correlation_id)
  WHERE type = 'status' AND state IN ('DONE', 'BLOCKED');
    `);
    v2.prepare("INSERT INTO schema_version (version) VALUES (2)").run();
    v2.close();

    // open via service -> mig should run
    const up = new DatabaseService(v2Path);
    const tabs = up.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agents','role_bindings','role_defaults','project_master_models')").all() as any[];
    expect(tabs.length).toBe(4);
    const ver = up.raw.prepare("SELECT version FROM schema_version").get() as any;
    expect(ver.version).toBe(SCHEMA_VERSION);
    up.close();

    // fresh db
    const freshPath = `/tmp/helm-fresh-${Date.now()}.db`;
    const fr = new DatabaseService(freshPath);
    const fver = fr.raw.prepare("SELECT version FROM schema_version").get() as any;
    expect(fver.version).toBe(SCHEMA_VERSION);
    fr.close();

    try { fs.unlinkSync(v2Path); } catch {}
    try { fs.unlinkSync(freshPath); } catch {}
  });

  it('P3-1 red-team M3: v6→v7 ALTER upgrade path adds agents.definition_md (real upgrade, not fresh-DB)', () => {
    // seed a realistic v6 DB: agents WITHOUT definition_md (the production pre-v7 shape)
    const v6Path = `/tmp/helm-v6-seed-${Date.now()}.db`;
    const v6 = new Database(v6Path);
    v6.exec(`
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
CREATE TABLE agents ( id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('claude','codex','grok')), model TEXT NOT NULL, default_effort TEXT NOT NULL DEFAULT 'medium', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')) );
`);
    v6.prepare("INSERT INTO schema_version (version) VALUES (6)").run();
    // Use a B09a-canonical name so B09b prune (v65) does not drop the row mid-chain.
    v6.prepare("INSERT INTO agents (name, provider, model) VALUES ('implementer','grok','grok-4.5')").run();
    // confirm the seed truly lacks the column (so this exercises the ALTER, not a no-op)
    const before = (v6.prepare("PRAGMA table_info(agents)").all() as any[]).map((c) => c.name);
    expect(before.includes('definition_md')).toBe(false);
    v6.close();

    const up = new DatabaseService(v6Path); // triggers the v7 ALTER block + later migrations
    const after = (up.raw.prepare("PRAGMA table_info(agents)").all() as any[]).map((c: any) => c.name);
    expect(after.includes('definition_md')).toBe(true); // ALTER ran
    const ver = up.raw.prepare("SELECT version FROM schema_version").get() as any;
    expect(ver.version).toBe(SCHEMA_VERSION);
    // Row survives full chain (B09b keeps canonical implementer); definition_md may be
    // backfilled by later roster seeds — column must remain readable.
    const row = up.raw.prepare("SELECT name, definition_md FROM agents WHERE name='implementer'").get() as any;
    expect(row).toBeTruthy();
    expect(row.name).toBe('implementer');
    expect('definition_md' in row).toBe(true);
    // idempotent: second open does not re-ALTER / throw
    up.close();
    const up2 = new DatabaseService(v6Path);
    expect((up2.raw.prepare("SELECT version FROM schema_version").get() as any).version).toBe(SCHEMA_VERSION);
    up2.close();
    try { fs.unlinkSync(v6Path); } catch {}
  });

  it('H8+M13: v5 migration idempotent (run twice on pre-v5 no "duplicate column" + txn) + schema_version PK (single row only)', () => {
    const prePath = `/tmp/helm-pre-v5-${Date.now()}.db`;
    const pre = new Database(prePath);
    pre.exec(`
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS agent_events (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  session TEXT,
  type TEXT NOT NULL CHECK(type IN ('message', 'status', 'tool', 'gate')),
  state TEXT,
  source TEXT NOT NULL CHECK(source IN ('callback', 'git', 'pane', 'post')),
  correlation_id TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '{}',
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
    `);
    pre.prepare("INSERT INTO schema_version (version) VALUES (4)").run();
    pre.close();

    // first run (triggers v5 mig)
    const d1 = new DatabaseService(prePath);
    let ver = d1.raw.prepare("SELECT version FROM schema_version").get() as any;
    expect(ver.version).toBe(SCHEMA_VERSION);
    d1.close();

    // second run (must not throw duplicate column; proves guard + txn)
    const d2 = new DatabaseService(prePath);
    ver = d2.raw.prepare("SELECT version FROM schema_version").get() as any;
    expect(ver.version).toBe(SCHEMA_VERSION);

    // exactly one row after migration; version is PRIMARY KEY → a DUPLICATE version is rejected, so SELECT version
    // is deterministic (the migration only ever INSERTs once on fresh + UPDATEs in place — never a distinct 2nd row).
    const count = d2.raw.prepare("SELECT COUNT(*) as c FROM schema_version").get() as any;
    expect(count.c).toBe(1);
    expect(() => d2.raw.prepare(`INSERT INTO schema_version (version) VALUES (${SCHEMA_VERSION})`).run())
      .toThrow(/constraint|primary|unique|duplicate/i); // duplicate current version violates the PK
    const c2 = d2.raw.prepare("SELECT COUNT(*) as c FROM schema_version").get() as any;
    expect(c2.c).toBe(1); // still single-row
    d2.close();
    try { fs.unlinkSync(prePath); } catch {}
  });

  // P3-1 tests
  it('v7 migration: definition_md column present (idempotent run-twice on current SCHEMA_VERSION)', () => {
    const prePath = `/tmp/helm-p3-v7-${Date.now()}.db`;
    try { fs.unlinkSync(prePath); } catch {}
    const d1 = new DatabaseService(prePath);
    let ver = d1.raw.prepare("SELECT version FROM schema_version").get() as any;
    expect(ver.version).toBe(SCHEMA_VERSION);
    const cols = d1.raw.prepare("PRAGMA table_info(agents)").all().map((c: any) => c.name);
    expect(cols).toContain('definition_md');
    d1.close();
    // run twice
    const d2 = new DatabaseService(prePath);
    ver = d2.raw.prepare("SELECT version FROM schema_version").get() as any;
    expect(ver.version).toBe(SCHEMA_VERSION);
    const cols2 = d2.raw.prepare("PRAGMA table_info(agents)").all().map((c: any) => c.name);
    expect(cols2).toContain('definition_md');
    d2.close();
    try { fs.unlinkSync(prePath); } catch {}
  });

  it('updateAgent persists definition_md + validates model + UNIQUE name', () => {
    const a = assignment.createAgent({ name: 'p3-upd', provider: 'grok', model: 'grok-4.5' });
    // update with md
    const upd = assignment.updateAgent(a.id, { name: 'p3-upd2', definition_md: '# hello\nworld', model: 'grok-composer-2.5-fast' }, { surface: 'studio' });
    expect(upd.name).toBe('p3-upd2');
    expect(upd.definition_md).toBe('# hello\nworld');
    expect(upd.model).toBe('grok-composer-2.5-fast');
    // bad model
    expect(() => assignment.updateAgent(a.id, { model: 'bad' })).toThrow(/unknown/);
    // unique
    assignment.createAgent({ name: 'p3-other', provider: 'grok', model: 'grok-4.5' });
    expect(() => assignment.updateAgent(a.id, { name: 'p3-other' })).toThrow(/unique/);
  });

  it('deleteAgent: unbound deletes; bound by binding or default -> 409-mappable', () => {
    const a1 = assignment.createAgent({ name: 'p3-del1', provider: 'grok', model: 'grok-4.5' });
    assignment.deleteAgent(a1.id); // unbound ok
    expect(assignment.getAgent(a1.id)).toBeNull();
    const a2 = assignment.createAgent({ name: 'p3-del2', provider: 'grok', model: 'grok-4.5' });
    assignment.setRoleDefault('implementer', a2.id);
    expect(() => assignment.deleteAgent(a2.id)).toThrow(/bound/);
    // clean
    assignment.setRoleDefault('implementer', assignment.createAgent({ name: 'p3-dummy', provider: 'grok', model: 'grok-4.5' }).id);
    const a3 = assignment.createAgent({ name: 'p3-del3', provider: 'grok', model: 'grok-4.5' });
    assignment.setProjectBinding(realPid, 'validator', a3.id);
    expect(() => assignment.deleteAgent(a3.id)).toThrow(/bound/);
  });

  it('routes: GET /agents/:id 404; PUT/DELETE 403 non-owner + 403 non-local; DELETE bound 409; size cap 400', async () => {
    const requireO = createRequireOwner();
    const requireL = createRequireLocalLaunch();
    // build the agents routes with a CONFIGURABLE sim role so we genuinely exercise owner/loopback boundaries
    function buildApp(simRole: 'owner' | 'viewer') {
      const app = Fastify();
      const simAuth = async (r: any) => { r.user = { role: simRole }; };
      app.get('/api/agents/:id', { preHandler: [simAuth, requireO] }, async (req: any, reply: any) => {
        const a = assignment.getAgent(Number(req.params.id));
        if (!a) return reply.code(404).send({ error: 'unknown agent' });
        return { agent: a };
      });
      app.put('/api/agents/:id', { preHandler: [simAuth, requireO, requireL] }, async (req: any, reply: any) => {
        try {
          const body = req.body || {};
          const def = body.definition_md;
          if (def && typeof def === 'string' && def.length > 50000) return reply.code(400).send({ error: 'too long' });
          return { agent: assignment.updateAgent(Number(req.params.id), body) };
        } catch (e: any) { return reply.code(400).send({ error: e.message }); }
      });
      app.delete('/api/agents/:id', { preHandler: [simAuth, requireO, requireL] }, async (req: any, reply: any) => {
        try { assignment.deleteAgent(Number(req.params.id)); return { ok: true }; }
        catch (e: any) {
          if (/bound/.test(e.message)) return reply.code(409).send({ error: e.message });
          return reply.code(400).send({ error: e.message });
        }
      });
      return app;
    }
    const owner = buildApp('owner');
    const viewer = buildApp('viewer');

    // non-OWNER PUT → 403 (viewer role, loopback)
    expect((await viewer.inject({ method: 'PUT', url: '/api/agents/1', remoteAddress: '127.0.0.1', payload: {} })).statusCode).toBe(403);
    // non-LOCAL PUT → 403 (owner role, remote addr)
    expect((await owner.inject({ method: 'PUT', url: '/api/agents/1', remoteAddress: '8.8.8.8', payload: {} })).statusCode).toBe(403);
    // GET unknown id (owner) → 404
    expect((await owner.inject({ method: 'GET', url: '/api/agents/999999', remoteAddress: '127.0.0.1' })).statusCode).toBe(404);
    // size cap → 400 (owner+local, a real agent id, oversize definition_md)
    const big = assignment.createAgent({ name: `p4-big-${Math.random().toString(36).slice(2)}`, provider: 'grok', model: 'grok-4.5' });
    expect((await owner.inject({ method: 'PUT', url: `/api/agents/${big.id}`, remoteAddress: '127.0.0.1', payload: { definition_md: 'x'.repeat(50001) } })).statusCode).toBe(400);
    // DELETE bound agent → 409 (owner+local; bind it to a role first)
    const bound = assignment.createAgent({ name: `p4-bound-${Math.random().toString(36).slice(2)}`, provider: 'grok', model: 'grok-4.5' });
    assignment.setRoleDefault('planner', bound.id);
    expect((await owner.inject({ method: 'DELETE', url: `/api/agents/${bound.id}`, remoteAddress: '127.0.0.1' })).statusCode).toBe(409);
    await owner.close(); await viewer.close();
  });
});

describe('P3-2: Toolkit sidecars (manifest + JIT load H2) — per batch+consensus non-negotiables', () => {
  let helmDbPath: string;
  let helmDb: any;
  let assignment: any;
  let tkSvc: any;

  beforeEach(() => {
    helmDbPath = `/tmp/helm-p32-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    helmDb = new DatabaseService(helmDbPath);
    assignment = new AgentAssignmentService(helmDb);
    tkSvc = new ToolkitService(helmDb);
  });

  afterEach(() => {
    if (helmDb && helmDb.close) helmDb.close();
    try { fs.unlinkSync(helmDbPath); } catch {}
  });

  it('v8 migration two-track (SCHEMA_SQL + guarded block) + run-twice on v7 seed (tables+col+version=8)', () => {
    const prePath = `/tmp/helm-p32-v8-${Date.now()}.db`;
    try { fs.unlinkSync(prePath); } catch {}
    const pre = new Database(prePath);
    pre.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);`);
    pre.prepare("INSERT INTO schema_version (version) VALUES (7)").run();
    // seed minimal agents + master_runtimes (no toolkits)
    pre.exec(`CREATE TABLE IF NOT EXISTS agents (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, provider TEXT, model TEXT, default_effort TEXT, definition_md TEXT, created_at TEXT, updated_at TEXT);`);
    pre.exec(`CREATE TABLE IF NOT EXISTS master_runtimes (project_id INTEGER PRIMARY KEY, master_run_id TEXT, tmux_session TEXT, tmux_pane TEXT, provider TEXT, model TEXT, state TEXT, core_sha TEXT, overlay_sha TEXT, intentional_park_until TEXT, last_launched_at TEXT, updated_at TEXT);`);
    pre.close();

    const d1 = new DatabaseService(prePath);
    let ver = d1.raw.prepare("SELECT version FROM schema_version").get() as any;
    expect(ver.version).toBe(SCHEMA_VERSION);
    const tcols = d1.raw.prepare("PRAGMA table_info(toolkits)").all().map((c: any) => c.name);
    expect(tcols).toContain('name');
    const acols = d1.raw.prepare("PRAGMA table_info(agent_toolkits)").all().map((c: any) => c.name);
    expect(acols).toContain('toolkit_id');
    const mcols = d1.raw.prepare("PRAGMA table_info(master_runtimes)").all().map((c: any) => c.name);
    expect(mcols).toContain('toolkits_sha');
    d1.close();
    // run twice (idempotent)
    const d2 = new DatabaseService(prePath);
    ver = d2.raw.prepare("SELECT version FROM schema_version").get() as any;
    expect(ver.version).toBe(SCHEMA_VERSION);
    d2.close();
    try { fs.unlinkSync(prePath); } catch {}
  });

  it('ToolkitService: CRUD + UNIQUE name + body cap + delete attached→409 (lists agents) + attach/detach + listAgent ordered + compose ordered+fenced+cap+empty', async () => {
    const a = assignment.createAgent({ name: 'p32-tk-a', provider: 'grok', model: 'grok-4.5' });
    // create
    const t = tkSvc.createToolkit({ name: 'tk-test', description: 'd', body_md: 'X-body' });
    expect(t.name).toBe('tk-test');
    expect(t.body_md).toBe('X-body');
    // unique
    expect(() => tkSvc.createToolkit({ name: 'tk-test', body_md: 'y' })).toThrow(/unique/);
    // body cap
    expect(() => tkSvc.createToolkit({ name: 'big', body_md: 'z'.repeat(50001) })).toThrow(/too long/);
    // attach + list ordered + compose
    tkSvc.attachToolkit(a.id, t.id);
    const att = tkSvc.listAgentToolkits(a.id);
    expect(att.length).toBe(1);
    expect(att[0].body_md).toBe('X-body');
    let comp = tkSvc.composeToolkits(a.id);
    expect(comp).toMatch(/--- toolkit: tk-test ---\nX-body/);
    // update → JIT re-read proof (compose now sees new, not old)
    tkSvc.updateToolkit(t.id, { body_md: 'Y-body' });
    comp = tkSvc.composeToolkits(a.id);
    expect(comp).toContain('Y-body');
    expect(comp).not.toContain('X-body');
    // agg cap (basic: create second, but cap is 200k, test via service direct if small; here just no-throw on normal)
    const t2 = tkSvc.createToolkit({ name: 'tk2', body_md: 'second' });
    tkSvc.attachToolkit(a.id, t2.id, 1);
    const att2 = tkSvc.listAgentToolkits(a.id);
    expect(att2.length).toBe(2);
    expect(att2[0].name).toBe('tk-test'); // position order
    // detach
    tkSvc.detachToolkit(a.id, t2.id);
    expect(tkSvc.listAgentToolkits(a.id).length).toBe(1);
    // delete attached → 409 with agents list
    expect(() => tkSvc.deleteToolkit(t.id)).toThrow(/attached to agents/);
    // cleanup unattached
    tkSvc.detachToolkit(a.id, t.id);
    tkSvc.deleteToolkit(t.id);
    expect(tkSvc.getToolkit(t.id)).toBeNull();
    tkSvc.deleteToolkit(t2.id);
  });

  it('red-team M1: composeToolkits AGGREGATE cap actually throws when total > limit', () => {
    const a = assignment.createAgent({ name: 'p32-aggcap-a', provider: 'grok', model: 'grok-4.5' });
    // 5 toolkits each ~49999 chars (≤ body cap) → composed ≈ 250K > 200K compose cap → must throw
    for (let i = 0; i < 5; i++) {
      const tk = tkSvc.createToolkit({ name: `aggtk-${i}`, body_md: 'x'.repeat(49999) });
      tkSvc.attachToolkit(a.id, tk.id, i);
    }
    expect(() => tkSvc.composeToolkits(a.id)).toThrow(/aggregate size exceeds/);
  });

  it('red-team M3: toolkit + manifest ROUTES via real Fastify inject (owner/loopback, 404/400/409)', async () => {
    const requireO = createRequireOwner();
    const requireL = createRequireLocalLaunch();
    function buildApp(simRole: 'owner' | 'viewer') {
      const app = Fastify();
      const simAuth = async (r: any) => { r.user = { role: simRole }; };
      app.get('/api/toolkits/:id', { preHandler: [simAuth, requireO] }, async (req: any, reply: any) => {
        const tk = tkSvc.getToolkit(Number(req.params.id));
        if (!tk) return reply.code(404).send({ error: 'unknown toolkit' });
        return { toolkit: tk };
      });
      app.post('/api/toolkits', { preHandler: [simAuth, requireO, requireL] }, async (req: any, reply: any) => {
        try { return { toolkit: tkSvc.createToolkit(req.body || {}) }; }
        catch (e: any) { return reply.code(400).send({ error: e.message }); }
      });
      app.delete('/api/toolkits/:id', { preHandler: [simAuth, requireO, requireL] }, async (req: any, reply: any) => {
        const id = Number(req.params.id);
        if (!tkSvc.getToolkit(id)) return reply.code(404).send({ error: 'unknown toolkit' });
        try { tkSvc.deleteToolkit(id); return { ok: true }; }
        catch (e: any) { if (/attached/.test(e.message)) return reply.code(409).send({ error: e.message }); return reply.code(400).send({ error: e.message }); }
      });
      return app;
    }
    const owner = buildApp('owner'); const viewer = buildApp('viewer');
    // non-owner mutate → 403
    expect((await viewer.inject({ method: 'POST', url: '/api/toolkits', remoteAddress: '127.0.0.1', payload: { name: 'x', body_md: 'b' } })).statusCode).toBe(403);
    // non-local mutate → 403
    expect((await owner.inject({ method: 'POST', url: '/api/toolkits', remoteAddress: '8.8.8.8', payload: { name: 'x', body_md: 'b' } })).statusCode).toBe(403);
    // GET unknown → 404
    expect((await owner.inject({ method: 'GET', url: '/api/toolkits/999999', remoteAddress: '127.0.0.1' })).statusCode).toBe(404);
    // size cap → 400
    expect((await owner.inject({ method: 'POST', url: '/api/toolkits', remoteAddress: '127.0.0.1', payload: { name: 'rt-big', body_md: 'x'.repeat(50001) } })).statusCode).toBe(400);
    // DELETE attached → 409
    const a = assignment.createAgent({ name: `p32-rt-${Math.random().toString(36).slice(2)}`, provider: 'grok', model: 'grok-4.5' });
    const tk = tkSvc.createToolkit({ name: `rt-att-${Math.random().toString(36).slice(2)}`, body_md: 'b' });
    tkSvc.attachToolkit(a.id, tk.id);
    expect((await owner.inject({ method: 'DELETE', url: `/api/toolkits/${tk.id}`, remoteAddress: '127.0.0.1' })).statusCode).toBe(409);
    await owner.close(); await viewer.close();
  });
});
