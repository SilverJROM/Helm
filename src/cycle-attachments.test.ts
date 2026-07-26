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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b3t02-'));
  const dbPath = path.join(dir, 'test.db');
  return { dbPath, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

describe('B3-T02: cycle image attachment upload (base64, traversal-guarded)', () => {
  let cleanupDb: () => void;
  let dbs: DatabaseService;
  let ps: ProjectService;
  let cycleSvc: CycleService;
  let cycleDocsSvc: CycleDocsService;
  let projDir: string;
  let cycleId: number;
  let cycleFolder: string;

  beforeEach(async () => {
    process.env.HELM_DB_PATH = path.join(os.tmpdir(), `helm-b3t02-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const t = makeTempDb();
    cleanupDb = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    ps = new ProjectService(dbs);
    cycleSvc = new CycleService(dbs, ps);
    cycleDocsSvc = new CycleDocsService(cycleSvc);

    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b3t02-proj-'));
    const proj = ps.createProject({ name: 'B3T02-cycle-attachments', directory: projDir });
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

  function buildAttachmentsApp() {
    const app = Fastify({ bodyLimit: 1048576 + 4096 });
    const requireOwner = createRequireOwner();
    const ownerAuth = async (req: any) => { req.user = { role: 'owner' }; };

    app.post('/api/cycles/:id/attachments', { preHandler: [ownerAuth, requireOwner] }, async (req: any, reply: any) => {
      const id = Number(req.params.id);
      try {
        const body = req.body || {};
        if (typeof body.filename !== 'string' || !body.filename.trim()) {
          return reply.code(400).send({ error: 'filename required' });
        }
        if (typeof body.contentBase64 !== 'string' || !body.contentBase64.trim()) {
          return reply.code(400).send({ error: 'contentBase64 required' });
        }
        const b64 = body.contentBase64.trim();
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) {
          return reply.code(400).send({ error: 'invalid base64' });
        }
        const bytes = Buffer.from(b64, 'base64');
        if (bytes.length === 0) return reply.code(400).send({ error: 'attachment content required' });
        const result = await cycleDocsSvc.saveCycleAttachment(id, body.filename, bytes);
        return result;
      } catch (e: any) {
        if (e?.code === 'INVALID' || e?.code === 'TOO_LARGE') return reply.code(400).send({ error: e.message });
        if (e.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
        const isTraversal = e.code === 'TRAVERSAL' || /traversal|only image|symlink/i.test(String(e.message));
        return reply.code(isTraversal ? 400 : 400).send({ error: e.message || 'attachment save failed' });
      }
    });

    return app;
  }

  it('POST small image bytes → file exists BYTE-IDENTICAL, path correct, readable back', async () => {
    const app = buildAttachmentsApp();
    await app.ready();

    const postRes = await app.inject({
      method: 'POST',
      url: `/api/cycles/${cycleId}/attachments`,
      payload: {
        filename: 'mockup.png',
        contentBase64: FIXTURE_PNG.toString('base64')
      }
    });
    expect(postRes.statusCode).toBe(200);
    const body = postRes.json();
    expect(body.path).toBe('attachments/mockup.png');

    const onDisk = path.join(cycleFolder, 'attachments', 'mockup.png');
    expect(fs.existsSync(onDisk)).toBe(true);
    const readBack = fs.readFileSync(onDisk);
    expect(Buffer.compare(readBack, FIXTURE_PNG)).toBe(0);

    const readable = fs.readFileSync(onDisk);
    expect(readable.equals(FIXTURE_PNG)).toBe(true);

    await app.close();
  });

  it('traversal filename ../../etc/passwd is rejected (fence holds)', async () => {
    const app = buildAttachmentsApp();
    await app.ready();

    const outside = path.join(projDir, 'package.json');
    fs.writeFileSync(outside, '{"escaped":false}\n');

    const res = await app.inject({
      method: 'POST',
      url: `/api/cycles/${cycleId}/attachments`,
      payload: {
        filename: '../../etc/passwd',
        contentBase64: FIXTURE_PNG.toString('base64')
      }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/traversal|only image/i);

    expect(fs.readFileSync(outside, 'utf8')).toBe('{"escaped":false}\n');
    expect(fs.existsSync(path.join(cycleFolder, 'attachments'))).toBe(false);

    await app.close();
  });

  it('missing payload fields return 400', async () => {
    const app = buildAttachmentsApp();
    await app.ready();

    const noFilename = await app.inject({
      method: 'POST',
      url: `/api/cycles/${cycleId}/attachments`,
      payload: { contentBase64: FIXTURE_PNG.toString('base64') }
    });
    expect(noFilename.statusCode).toBe(400);

    const noContent = await app.inject({
      method: 'POST',
      url: `/api/cycles/${cycleId}/attachments`,
      payload: { filename: 'mockup.png' }
    });
    expect(noContent.statusCode).toBe(400);

    await app.close();
  });

  it('duplicate filename gets deterministic suffix', async () => {
    const app = buildAttachmentsApp();
    await app.ready();

    const payload = {
      filename: 'dup.png',
      contentBase64: FIXTURE_PNG.toString('base64')
    };

    const first = await app.inject({
      method: 'POST',
      url: `/api/cycles/${cycleId}/attachments`,
      payload
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().path).toBe('attachments/dup.png');

    const second = await app.inject({
      method: 'POST',
      url: `/api/cycles/${cycleId}/attachments`,
      payload
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().path).toBe('attachments/dup_1.png');

    expect(fs.existsSync(path.join(cycleFolder, 'attachments', 'dup.png'))).toBe(true);
    expect(fs.existsSync(path.join(cycleFolder, 'attachments', 'dup_1.png'))).toBe(true);

    await app.close();
  });
});