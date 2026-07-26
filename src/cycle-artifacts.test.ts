import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { CycleDocsService } from './services/cycle-docs-service.js';
import { createRequireOwner } from './auth/auth-middleware.js';

/** Minimal 1x1 PNG (67 bytes) — valid image fixture. */
const FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b3t03-'));
  const dbPath = path.join(dir, 'test.db');
  return { dbPath, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

describe('B3-T03: cycle artifact listing (categorized, fence-contained)', () => {
  let cleanupDb: () => void;
  let dbs: DatabaseService;
  let ps: ProjectService;
  let cycleSvc: CycleService;
  let cycleDocsSvc: CycleDocsService;
  let projDir: string;
  let cycleId: number;
  let cycleFolder: string;

  beforeEach(async () => {
    process.env.HELM_DB_PATH = path.join(os.tmpdir(), `helm-b3t03-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const t = makeTempDb();
    cleanupDb = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    ps = new ProjectService(dbs);
    cycleSvc = new CycleService(dbs, ps);
    cycleDocsSvc = new CycleDocsService(cycleSvc);

    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b3t03-proj-'));
    const proj = ps.createProject({ name: 'B3T03-cycle-artifacts', directory: projDir });
    const cycle = await cycleSvc.createCycle(proj.id, 'Discovery Run', undefined, undefined, () => new Date('2026-07-03T12:00:00Z'));
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

  function buildArtifactsApp() {
    const app = Fastify();
    const requireOwner = createRequireOwner();
    const ownerAuth = async (req: any) => { req.user = { role: 'owner' }; };

    app.get('/api/cycles/:id/artifacts', { preHandler: [ownerAuth, requireOwner] }, async (req: any, reply: any) => {
      const id = Number(req.params.id);
      try {
        const artifacts = await cycleDocsSvc.listCycleArtifacts(id);
        return artifacts;
      } catch (e: any) {
        if (e.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
        return reply.code(500).send({ error: e.message || 'artifact listing failed' });
      }
    });

    return app;
  }

  it('seeded doc + attachments image + flow file → correct categories and paths', async () => {
    fs.writeFileSync(path.join(cycleFolder, 'north_star.md'), '# North Star\n');
    fs.mkdirSync(path.join(cycleFolder, 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(cycleFolder, 'attachments', 'mockup.png'), FIXTURE_PNG);
    fs.writeFileSync(path.join(cycleFolder, 'flow_01.md'), '# Flow 01\n');

    const app = buildArtifactsApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/api/cycles/${cycleId}/artifacts`
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.docs).toEqual([{ name: 'north_star.md', path: 'north_star.md' }]);
    expect(body.images).toEqual([{ name: 'mockup.png', path: 'attachments/mockup.png' }]);
    expect(body.flow).toEqual([{ name: 'flow_01.md', path: 'flow_01.md' }]);
    expect(body.other).toEqual([]);

    await app.close();
  });

  it('empty cycle folder → all empty arrays (first-class empty state)', async () => {
    const app = buildArtifactsApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/api/cycles/${cycleId}/artifacts`
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      docs: [],
      images: [],
      flow: [],
      other: []
    });

    await app.close();
  });

  it('unknown cycle id returns 404', async () => {
    const app = buildArtifactsApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/cycles/999999/artifacts'
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});