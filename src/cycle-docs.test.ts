import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { CycleDocsService } from './services/cycle-docs-service.js';
import { LEGACY_CYCLE_ALIAS_EXPIRES_AT, materializeCanonicalArtifactSet } from './services/cycle-artifact-paths.js';
import { parseExecutionPlan } from './services/execution-plan-parser.js';
import { createRequireOwner } from './auth/auth-middleware.js';
import { resolveRequirementsText } from './services/requirements-resolver-service.js';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b3t01-'));
  const dbPath = path.join(dir, 'test.db');
  return { dbPath, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

describe('B3-T01: cycle doc read/write API (traversal-guarded)', () => {
  let cleanupDb: () => void;
  let dbs: DatabaseService;
  let ps: ProjectService;
  let cycleSvc: CycleService;
  let cycleDocsSvc: CycleDocsService;
  let projDir: string;
  let projId: number;
  let cycleId: number;
  let cycleFolder: string;

  beforeEach(async () => {
    process.env.HELM_DB_PATH = path.join(os.tmpdir(), `helm-b3t01-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const t = makeTempDb();
    cleanupDb = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    ps = new ProjectService(dbs);
    cycleSvc = new CycleService(dbs, ps);
    cycleDocsSvc = new CycleDocsService(cycleSvc);

    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b3t01-proj-'));
    const proj = ps.createProject({ name: 'B3T01-cycle-docs', directory: projDir });
    projId = proj.id;

    const cycle = await cycleSvc.createCycle(projId, 'Discovery Run', undefined, undefined, () => new Date('2026-07-03T12:00:00Z'));
    cycleId = cycle.id;
    cycleFolder = path.join(projDir, 'cycle', cycle.folder_name);
    fs.mkdirSync(cycleFolder, { recursive: true });
  });

  afterEach(() => {
    dbs.close();
    cleanupDb();
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
    try { if (process.env.HELM_DB_PATH) fs.unlinkSync(process.env.HELM_DB_PATH); } catch {}
  });

  function buildCycleDocsApp() {
    const app = Fastify({ bodyLimit: 1048576 + 4096 });
    const requireOwner = createRequireOwner();
    const ownerAuth = async (req: any) => { req.user = { role: 'owner' }; };

    app.put('/api/cycles/:id/docs/:filename', { preHandler: [ownerAuth, requireOwner] }, async (req: any, reply: any) => {
      const id = Number(req.params.id);
      const rel = req.query?.path ? req.query.path : req.params.filename;
      try {
        const body = req.body || {};
        if (typeof body.content !== 'string') return reply.code(400).send({ error: 'content required' });
        if (Buffer.byteLength(body.content, 'utf8') > 1048576) return reply.code(400).send({ error: 'content too large' });
        const doc = await cycleDocsSvc.writeCycleDoc(id, rel, body.content);
        return { doc };
      } catch (e: any) {
        if (e?.code === 'TOO_LARGE') return reply.code(400).send({ error: e.message || 'content too large' });
        if (e?.code === 'INVALID_EXECUTION_PLAN') {
          return reply.code(400).send({ error: e.message || 'execution plan validation failed', errors: e.errors || [] });
        }
        if (e.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
        const isTraversal = e.code === 'TRAVERSAL' || /traversal|only \.md|symlink/i.test(String(e.message));
        return reply.code(isTraversal ? 400 : 404).send({ error: e.message || 'write failed' });
      }
    });

    app.get('/api/cycles/:id/docs/:filename', { preHandler: [ownerAuth, requireOwner] }, async (req: any, reply: any) => {
      const id = Number(req.params.id);
      const rel = req.query?.path ? req.query.path : req.params.filename;
      try {
        const doc = await cycleDocsSvc.readCycleDoc(id, rel);
        return { doc };
      } catch (e: any) {
        if (e.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
        const isTraversal = e.code === 'TRAVERSAL' || /traversal|only \.md/i.test(String(e.message));
        return reply.code(isTraversal ? 400 : 404).send({ error: e.message || 'read failed' });
      }
    });

    return app;
  }

  it('PUT north-star.md round-trips via GET and lands under cycle/<folder_name>/', async () => {
    const content = '# North Star\n\nLiving doc for discovery.\n';
    const app = buildCycleDocsApp();
    await app.ready();

    const putRes = await app.inject({
      method: 'PUT',
      url: `/api/cycles/${cycleId}/docs/north-star.md`,
      payload: { content }
    });
    expect(putRes.statusCode).toBe(200);
    const putBody = putRes.json();
    expect(putBody.doc.content).toBe(content);

    const onDisk = path.join(cycleFolder, 'north-star.md');
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(fs.readFileSync(onDisk, 'utf8')).toBe(content);

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/cycles/${cycleId}/docs/north-star.md`
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().doc.content).toBe(content);

    await app.close();
  });

  it('GET missing file returns 404 (not crash)', async () => {
    const app = buildCycleDocsApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/api/cycles/${cycleId}/docs/missing.md`
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('traversal attempt ../../etc/passwd is rejected on GET and PUT', async () => {
    const app = buildCycleDocsApp();
    await app.ready();

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/cycles/${cycleId}/docs/${encodeURIComponent('../../etc/passwd')}`
    });
    expect(getRes.statusCode).toBe(400);
    expect(getRes.json().error).toMatch(/traversal|only \.md/i);

    const putRes = await app.inject({
      method: 'PUT',
      url: `/api/cycles/${cycleId}/docs/${encodeURIComponent('../../etc/passwd')}`,
      payload: { content: 'pwned' }
    });
    expect(putRes.statusCode).toBe(400);
    expect(putRes.json().error).toMatch(/traversal|only \.md/i);

    const outside = path.join(projDir, 'package.json');
    fs.writeFileSync(outside, '{"escaped":false}\n');
    expect(fs.readFileSync(outside, 'utf8')).toBe('{"escaped":false}\n');

    await app.close();
  });
});

describe('B3-T04: execution_plan.md validate-on-save', () => {
  let cleanupDb: () => void;
  let dbs: DatabaseService;
  let ps: ProjectService;
  let cycleSvc: CycleService;
  let cycleDocsSvc: CycleDocsService;
  let projDir: string;
  let cycleId: number;
  let cycleFolder: string;

  const VALID_TASK = {
    id: 'B3-T04',
    batch: 'B3',
    title: 'Validate execution_plan.md parses into helm-algo task rows on save',
    req_refs: ['R-D2', 'R-D3'],
    assignee: 'grok-composer',
    validator_lane: 'L1',
    effort: 'med',
    type: 'feature'
  };

  function validExecutionPlan(): string {
    return `# Execution Plan\n\n\`\`\`json\n${JSON.stringify([VALID_TASK], null, 2)}\n\`\`\`\n`;
  }

  beforeEach(async () => {
    process.env.HELM_DB_PATH = path.join(os.tmpdir(), `helm-b3t04-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const t = makeTempDb();
    cleanupDb = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    ps = new ProjectService(dbs);
    cycleSvc = new CycleService(dbs, ps);
    cycleDocsSvc = new CycleDocsService(cycleSvc);

    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b3t04-proj-'));
    const proj = ps.createProject({ name: 'B3T04-exec-plan', directory: projDir });
    const cycle = await cycleSvc.createCycle(proj.id, 'Planning Run', undefined, undefined, () => new Date('2026-07-03T12:00:00Z'));
    cycleId = cycle.id;
    cycleFolder = path.join(projDir, 'cycle', cycle.folder_name);
    fs.mkdirSync(cycleFolder, { recursive: true });
  });

  afterEach(() => {
    dbs.close();
    cleanupDb();
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
    try { if (process.env.HELM_DB_PATH) fs.unlinkSync(process.env.HELM_DB_PATH); } catch {}
  });

  function buildCycleDocsApp() {
    const app = Fastify({ bodyLimit: 1048576 + 4096 });
    const requireOwner = createRequireOwner();
    const ownerAuth = async (req: any) => { req.user = { role: 'owner' }; };

    app.put('/api/cycles/:id/docs/:filename', { preHandler: [ownerAuth, requireOwner] }, async (req: any, reply: any) => {
      const id = Number(req.params.id);
      const rel = req.query?.path ? req.query.path : req.params.filename;
      try {
        const body = req.body || {};
        if (typeof body.content !== 'string') return reply.code(400).send({ error: 'content required' });
        if (Buffer.byteLength(body.content, 'utf8') > 1048576) return reply.code(400).send({ error: 'content too large' });
        const doc = await cycleDocsSvc.writeCycleDoc(id, rel, body.content);
        return { doc };
      } catch (e: any) {
        if (e?.code === 'TOO_LARGE') return reply.code(400).send({ error: e.message || 'content too large' });
        if (e?.code === 'INVALID_EXECUTION_PLAN') {
          return reply.code(400).send({ error: e.message || 'execution plan validation failed', errors: e.errors || [] });
        }
        if (e.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
        const isTraversal = e.code === 'TRAVERSAL' || /traversal|only \.md|symlink/i.test(String(e.message));
        return reply.code(isTraversal ? 400 : 404).send({ error: e.message || 'write failed' });
      }
    });

    return app;
  }

  it('PUT valid plan.md saves and parses ok', async () => {
    const content = validExecutionPlan();
    const app = buildCycleDocsApp();
    await app.ready();

    const putRes = await app.inject({
      method: 'PUT',
      url: `/api/cycles/${cycleId}/docs/plan.md`,
      payload: { content }
    });
    expect(putRes.statusCode).toBe(200);

    const onDisk = path.join(cycleFolder, 'plan.md');
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(fs.readFileSync(onDisk, 'utf8')).toBe(content);

    const parsed = parseExecutionPlan(content);
    expect(parsed.ok).toBe(true);

    await app.close();
  });

  it('PUT plan.md with malformed JSON returns 400 and is not saved', async () => {
    const prior = validExecutionPlan();
    const priorPath = path.join(cycleFolder, 'plan.md');
    fs.writeFileSync(priorPath, prior);

    const bad = '# Plan\n\n```json\n[{not valid json}\n```\n';
    const app = buildCycleDocsApp();
    await app.ready();

    const putRes = await app.inject({
      method: 'PUT',
      url: `/api/cycles/${cycleId}/docs/plan.md`,
      payload: { content: bad }
    });
    expect(putRes.statusCode).toBe(400);
    const body = putRes.json();
    expect(body.errors?.length).toBeGreaterThan(0);
    expect(fs.readFileSync(priorPath, 'utf8')).toBe(prior);

    await app.close();
  });

  it('PUT plan.md with task missing assignee returns 400 naming the field', async () => {
    const { assignee: _omit, ...missingAssignee } = VALID_TASK;
    const bad = `# Plan\n\n\`\`\`json\n${JSON.stringify([missingAssignee], null, 2)}\n\`\`\`\n`;
    const app = buildCycleDocsApp();
    await app.ready();

    const putRes = await app.inject({
      method: 'PUT',
      url: `/api/cycles/${cycleId}/docs/plan.md`,
      payload: { content: bad }
    });
    expect(putRes.statusCode).toBe(400);
    const body = putRes.json();
    expect(body.errors?.join(' ')).toMatch(/assignee/i);

    const onDisk = path.join(cycleFolder, 'plan.md');
    expect(fs.existsSync(onDisk)).toBe(false);

    await app.close();
  });

  it('PUT north-star.md saves without plan gating', async () => {
    const content = '# North Star\n\nThis is not valid execution plan json at all {{{\n';
    const app = buildCycleDocsApp();
    await app.ready();

    const putRes = await app.inject({
      method: 'PUT',
      url: `/api/cycles/${cycleId}/docs/north-star.md`,
      payload: { content }
    });
    expect(putRes.statusCode).toBe(200);

    const onDisk = path.join(cycleFolder, 'north-star.md');
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(fs.readFileSync(onDisk, 'utf8')).toBe(content);

    await app.close();
  });
});

describe('B00.s6 R14.46: canonical cycle-artifact vocabulary', () => {
  let cleanupDb: () => void;
  let dbs: DatabaseService;
  let ps: ProjectService;
  let cycleSvc: CycleService;
  let cycleDocsSvc: CycleDocsService;
  let projDir: string;
  let cycleId: number;

  beforeEach(async () => {
    const t = makeTempDb();
    cleanupDb = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    ps = new ProjectService(dbs);
    cycleSvc = new CycleService(dbs, ps);
    cycleDocsSvc = new CycleDocsService(cycleSvc, () => new Date('2026-07-12T00:00:00.000Z'));
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b00s6-proj-'));
    const project = ps.createProject({ name: 'B00.s6 aliases', directory: projDir });
    const cycle = await cycleSvc.createCycle(project.id, 'Vocabulary', undefined, undefined, () => new Date('2026-07-12T00:00:00Z'));
    cycleId = cycle.id;
    fs.mkdirSync(cycleSvc.getCycleDocDir(cycleId), { recursive: true });
  });

  afterEach(() => {
    dbs.close();
    cleanupDb();
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
  });

  it('reads a legacy alias from its canonical artifact with an expiry warning, then expires it', async () => {
    await cycleDocsSvc.writeCycleDoc(cycleId, 'north-star.md', '# Canonical north star\n');

    const aliased = await cycleDocsSvc.readCycleDoc(cycleId, 'north_star.md');
    expect(aliased.content).toContain('Canonical north star');
    expect(aliased.warning).toContain(`expires ${LEGACY_CYCLE_ALIAS_EXPIRES_AT}`);

    const expired = new CycleDocsService(cycleSvc, () => new Date('2026-10-10T00:00:00.000Z'));
    await expect(expired.readCycleDoc(cycleId, 'north_star.md')).rejects.toMatchObject({ code: 'LEGACY_ALIAS_EXPIRED' });
  });

  it('reads a canonical name from an existing legacy artifact with an expiry warning', async () => {
    fs.writeFileSync(path.join(cycleSvc.getCycleDocDir(cycleId), 'og_req.md'), '# Legacy requirements\n');

    const canonical = await cycleDocsSvc.readCycleDoc(cycleId, 'og-requirements.md');
    expect(canonical.content).toContain('Legacy requirements');
    expect(canonical.warning).toContain('og_req.md is a read-only legacy alias');
  });

  it('keeps a present canonical plan readable after alias expiry but expires a legacy fallback', async () => {
    const plan = '# Plan\n\n```json\n[{"id":"T1","batch":"B00","title":"vocabulary","req_refs":["R14.46"],"assignee":"terra","validator_lane":"L2","effort":"low","type":"feature"}]\n```\n';
    await cycleDocsSvc.writeCycleDoc(cycleId, 'plan.md', plan);
    const expired = new CycleDocsService(cycleSvc, () => new Date('2026-10-10T00:00:00.000Z'));
    await expect(expired.readCycleDoc(cycleId, 'plan.md')).resolves.toMatchObject({ valid: true });

    fs.rmSync(path.join(cycleSvc.getCycleDocDir(cycleId), 'plan.md'));
    fs.writeFileSync(path.join(cycleSvc.getCycleDocDir(cycleId), 'execution_plan.md'), plan);
    await expect(expired.readCycleDoc(cycleId, 'plan.md')).rejects.toMatchObject({ code: 'LEGACY_ALIAS_EXPIRED' });
  });

  it('refuses writes through every legacy cycle artifact name', async () => {
    for (const legacyName of ['north_star.md', 'og_req.md', 'execution_plan.md']) {
      await expect(cycleDocsSvc.writeCycleDoc(cycleId, legacyName, '# blocked\n')).rejects.toMatchObject({ code: 'LEGACY_ALIAS_READ_ONLY' });
    }
  });

  it('writes constitution-canonical names and validates the canonical plan', async () => {
    const plan = '# Plan\n\n```json\n[{"id":"T1","batch":"B00","title":"vocabulary","req_refs":["R14.46"],"assignee":"terra","validator_lane":"L2","effort":"low","type":"feature"}]\n```\n';
    await expect(cycleDocsSvc.writeCycleDoc(cycleId, 'north-star.md', '# North\n')).resolves.toMatchObject({ filename: 'north-star.md' });
    await expect(cycleDocsSvc.writeCycleDoc(cycleId, 'og-requirements.md', '# Requirements\n')).resolves.toMatchObject({ filename: 'og-requirements.md' });
    await expect(cycleDocsSvc.writeCycleDoc(cycleId, 'plan.md', plan)).resolves.toMatchObject({ filename: 'plan.md' });
    await expect(cycleDocsSvc.readCycleDoc(cycleId, 'plan.md')).resolves.toMatchObject({ valid: true });
  });

  it('materializes one complete canonical set and overwrites stale runDir snapshots without authoring aliases', async () => {
    const cycleRoot = cycleSvc.getCycleDocDir(cycleId);
    const runDir = path.join(projDir, 'tmp-run');
    const plan = '# Plan\n\n```json\n[{"id":"T1","batch":"B00","title":"canonical handoff","req_refs":["R14.46"],"assignee":"L1","validator_lane":"L2","effort":"low","type":"feature"}]\n```\n';
    await cycleDocsSvc.writeCycleDoc(cycleId, 'north-star.md', '# Discovery canonical\n');
    await cycleDocsSvc.writeCycleDoc(cycleId, 'og-requirements.md', '- **R14.46** — Canonical acceptance.\n');
    await cycleDocsSvc.writeCycleDoc(cycleId, 'plan.md', plan);
    fs.mkdirSync(path.join(cycleRoot, 'decisions'), { recursive: true });
    fs.writeFileSync(path.join(cycleRoot, 'decisions', 'choice.md'), '# Cycle choice\n');

    fs.mkdirSync(path.join(runDir, 'decisions'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'north-star.md'), '# STALE\n');
    fs.writeFileSync(path.join(runDir, 'decisions', 'stale.md'), '# stale\n');

    await expect(materializeCanonicalArtifactSet(cycleRoot, runDir)).resolves.toEqual({
      materialized: ['north-star.md', 'og-requirements.md', 'plan.md', 'decisions/'],
    });
    expect(fs.readFileSync(path.join(runDir, 'north-star.md'), 'utf8')).toBe('# Discovery canonical\n');
    expect(fs.readFileSync(path.join(runDir, 'og-requirements.md'), 'utf8')).toContain('Canonical acceptance');
    expect(fs.readFileSync(path.join(runDir, 'plan.md'), 'utf8')).toBe(plan);
    expect(fs.readFileSync(path.join(runDir, 'decisions', 'choice.md'), 'utf8')).toContain('Cycle choice');
    expect(fs.existsSync(path.join(runDir, 'decisions', 'stale.md'))).toBe(false);
    for (const alias of ['north_star.md', 'og_req.md', 'execution_plan.md']) {
      expect(fs.existsSync(path.join(runDir, alias))).toBe(false);
    }
  });

  it('materializes legacy underscore-only cycles into a complete canonical implementation contract', async () => {
    const cycleRoot = cycleSvc.getCycleDocDir(cycleId);
    const runDir = path.join(projDir, 'legacy-run');
    const plan = '# Plan\n\n```json\n[{"id":"T1","batch":"B00","title":"legacy handoff","req_refs":["LEGACY-R1"],"assignee":"L1","validator_lane":"L2","effort":"low","type":"feature"}]\n```\n';
    fs.writeFileSync(path.join(cycleRoot, 'north_star.md'), '# Legacy discovery truth\n');
    fs.writeFileSync(path.join(cycleRoot, 'og_req.md'), '- **LEGACY-R1** — Preserve the legacy acceptance contract.\n');
    fs.writeFileSync(path.join(cycleRoot, 'execution_plan.md'), plan);

    await expect(materializeCanonicalArtifactSet(cycleRoot, runDir)).resolves.toEqual({
      materialized: ['north-star.md', 'og-requirements.md', 'plan.md'],
    });
    expect(fs.readFileSync(path.join(runDir, 'north-star.md'), 'utf8')).toContain('Legacy discovery truth');
    expect(fs.readFileSync(path.join(runDir, 'og-requirements.md'), 'utf8')).toContain('LEGACY-R1');
    expect(fs.readFileSync(path.join(runDir, 'plan.md'), 'utf8')).toBe(plan);
    expect(resolveRequirementsText(runDir, ['LEGACY-R1'])).toBe(
      '- **LEGACY-R1** — Preserve the legacy acceptance contract.',
    );
    for (const alias of ['north_star.md', 'og_req.md', 'execution_plan.md']) {
      expect(fs.existsSync(path.join(runDir, alias))).toBe(false);
    }
  });
});

describe('B8-T01: readCycleDoc exposes valid:boolean for execution_plan.md (schema-valid badge signal)', () => {
  let cleanupDb: () => void;
  let dbs: DatabaseService;
  let ps: ProjectService;
  let cycleSvc: CycleService;
  let cycleDocsSvc: CycleDocsService;
  let projDir: string;
  let cycleId: number;
  let cycleFolder: string;

  beforeEach(async () => {
    process.env.HELM_DB_PATH = path.join(os.tmpdir(), `helm-b8t01-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const t = makeTempDb();
    cleanupDb = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    ps = new ProjectService(dbs);
    cycleSvc = new CycleService(dbs, ps);
    cycleDocsSvc = new CycleDocsService(cycleSvc);

    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b8t01-proj-'));
    const proj = ps.createProject({ name: 'B8T01-plan-docs', directory: projDir });
    const cycle = await cycleSvc.createCycle(proj.id, 'Planning Run', undefined, undefined, () => new Date('2026-07-03T12:00:00Z'));
    cycleId = cycle.id;
    cycleFolder = path.join(projDir, 'cycle', cycle.folder_name);
    fs.mkdirSync(cycleFolder, { recursive: true });
  });

  afterEach(() => {
    dbs.close();
    cleanupDb();
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
    try { if (process.env.HELM_DB_PATH) fs.unlinkSync(process.env.HELM_DB_PATH); } catch {}
  });

  it('GET execution_plan.md with a parseable fenced JSON block reports valid:true', async () => {
    const task = { id: 'B8-T01', batch: 'B8', title: 'Planning doc cards', req_refs: ['R-D1'], assignee: 'sonnet', validator_lane: 'L1', effort: 'medium', type: 'feature' };
    const content = `# Execution Plan\n\n\`\`\`json\n${JSON.stringify([task], null, 2)}\n\`\`\`\n`;
    fs.writeFileSync(path.join(cycleFolder, 'execution_plan.md'), content);

    const doc = await cycleDocsSvc.readCycleDoc(cycleId, 'execution_plan.md');
    expect(doc.valid).toBe(true);
  });

  it('GET execution_plan.md with no fenced JSON block reports valid:false', async () => {
    const content = '# Execution Plan\n\nNo fenced JSON here.\n';
    fs.writeFileSync(path.join(cycleFolder, 'execution_plan.md'), content);

    const doc = await cycleDocsSvc.readCycleDoc(cycleId, 'execution_plan.md');
    expect(doc.valid).toBe(false);
  });

  it('GET og_req.md (non-execution-plan doc) does not set valid', async () => {
    const content = '# OG Requirements\n\nBuild the thing.\n';
    fs.writeFileSync(path.join(cycleFolder, 'og_req.md'), content);

    const doc = await cycleDocsSvc.readCycleDoc(cycleId, 'og_req.md');
    expect(doc.valid).toBeUndefined();
  });
});
