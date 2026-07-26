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

/** Minimal 1x1 PNG (67 bytes) — valid image fixture for byte-identity assertions. */
const FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b7t03-'));
  const dbPath = path.join(dir, 'test.db');
  return { dbPath, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

describe('B7-T03: GET /api/cycles/:id/artifact-image (attachments/-only, traversal-guarded)', () => {
  let cleanupDb: () => void;
  let dbs: DatabaseService;
  let ps: ProjectService;
  let cycleSvc: CycleService;
  let cycleDocsSvc: CycleDocsService;
  let projDir: string;
  let cycleId: number;
  let cycleFolder: string;

  beforeEach(async () => {
    process.env.HELM_DB_PATH = path.join(os.tmpdir(), `helm-b7t03-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const t = makeTempDb();
    cleanupDb = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    ps = new ProjectService(dbs);
    cycleSvc = new CycleService(dbs, ps);
    cycleDocsSvc = new CycleDocsService(cycleSvc);

    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b7t03-proj-'));
    const proj = ps.createProject({ name: 'B7T03-artifact-image', directory: projDir });
    const cycle = await cycleSvc.createCycle(proj.id, 'Discovery Run', undefined, undefined, () => new Date('2026-07-03T12:00:00Z'));
    cycleId = cycle.id;
    cycleFolder = path.join(projDir, 'cycle', cycle.folder_name);
    fs.mkdirSync(path.join(cycleFolder, 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(cycleFolder, 'attachments', 'mockup.png'), FIXTURE_PNG);
    fs.mkdirSync(path.join(cycleFolder, 'mockups'), { recursive: true });
    fs.writeFileSync(path.join(cycleFolder, 'mockups', 'approved.png'), FIXTURE_PNG);
  });

  afterEach(() => {
    dbs.close();
    cleanupDb();
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
    try { if (process.env.HELM_DB_PATH) fs.unlinkSync(process.env.HELM_DB_PATH); } catch {}
  });

  function buildApp() {
    const app = Fastify();
    const requireOwner = createRequireOwner();
    const ownerAuth = async (req: any) => { req.user = { role: 'owner' }; };

    app.get('/api/cycles/:id/artifact-image', { preHandler: [ownerAuth, requireOwner] }, async (req: any, reply: any) => {
      const id = Number(req.params.id);
      const rel = req.query && req.query.path;
      try {
        if (typeof rel !== 'string' || !rel.trim()) return reply.code(400).send({ error: 'path required' });
        const img = await cycleDocsSvc.readCycleAttachmentImage(id, rel);
        const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
        reply.header('Content-Type', mime[img.ext] || 'application/octet-stream');
        return reply.send(img.bytes);
      } catch (e: any) {
        if (e.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
        const isTraversal = e.code === 'TRAVERSAL' || /traversal|only image|only cycle attachments/i.test(String(e.message));
        return reply.code(isTraversal ? 400 : 404).send({ error: e.message || 'image read failed' });
      }
    });

    return app;
  }

  it('serves a saved attachment BYTE-IDENTICAL with the correct Content-Type', async () => {
    const app = buildApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/api/cycles/${cycleId}/artifact-image?path=${encodeURIComponent('attachments/mockup.png')}`
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(res.rawPayload, FIXTURE_PNG)).toBe(0);

    await app.close();
  });

  it('B7-T04: serves a saved mockups/ image BYTE-IDENTICAL (approved mockups, R-C4)', async () => {
    const app = buildApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/api/cycles/${cycleId}/artifact-image?path=${encodeURIComponent('mockups/approved.png')}`
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(res.rawPayload, FIXTURE_PNG)).toBe(0);

    await app.close();
  });

  it('rejects paths outside attachments/ (fence holds, no traversal)', async () => {
    const app = buildApp();
    await app.ready();

    const outside = path.join(projDir, 'package.json');
    fs.writeFileSync(outside, '{"escaped":false}\n');

    const traversalRes = await app.inject({
      method: 'GET',
      url: `/api/cycles/${cycleId}/artifact-image?path=${encodeURIComponent('../../../package.json')}`
    });
    expect(traversalRes.statusCode).toBe(400);

    const wrongPrefixRes = await app.inject({
      method: 'GET',
      url: `/api/cycles/${cycleId}/artifact-image?path=${encodeURIComponent('north_star.md')}`
    });
    expect(wrongPrefixRes.statusCode).toBe(400);
    expect(wrongPrefixRes.json().error).toMatch(/only cycle attachments/i);

    expect(fs.readFileSync(outside, 'utf8')).toBe('{"escaped":false}\n');

    await app.close();
  });

  it('missing attachment 404s', async () => {
    const app = buildApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/api/cycles/${cycleId}/artifact-image?path=${encodeURIComponent('attachments/nope.png')}`
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});
