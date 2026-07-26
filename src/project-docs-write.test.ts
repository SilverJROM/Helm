import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { ProjectDocsService } from './services/project-docs-service.js';
import { createRequireOwner } from './auth/auth-middleware.js';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b13-docs-'));
  const dbPath = path.join(dir, 'test.db');
  return {
    dbPath,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  };
}

describe('B13: helm_docs write API (service + routes; HELM_DB_PATH=/tmp §14)', () => {
  let dbPath: string;
  let cleanupDb: () => void;
  let dbs: DatabaseService;
  let ps: ProjectService;
  let docsSvc: ProjectDocsService;
  let projDir: string;
  let projId: number;

  beforeEach(() => {
    process.env.HELM_DB_PATH = path.join(os.tmpdir(), `helm-b13-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const t = makeTempDb();
    dbPath = t.dbPath;
    cleanupDb = t.cleanup;
    dbs = new DatabaseService(dbPath);
    ps = new ProjectService(dbs);
    docsSvc = new ProjectDocsService(ps);

    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b13-proj-'));
    fs.mkdirSync(path.join(projDir, 'helm_docs'), { recursive: true });
    fs.mkdirSync(path.join(projDir, 'helm_tasks'), { recursive: true });
    fs.writeFileSync(path.join(projDir, 'package.json'), '{"name":"outside"}\n');
    dbs.raw.prepare('INSERT INTO projects (name, directory) VALUES (?,?)').run('B13-write', projDir);
    const p = dbs.raw.prepare("SELECT id FROM projects WHERE name='B13-write'").get() as any;
    projId = p.id;
  });

  afterEach(() => {
    dbs.close();
    cleanupDb();
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
    try { if (process.env.HELM_DB_PATH) fs.unlinkSync(process.env.HELM_DB_PATH); } catch {}
  });

  function buildDocsApp(simRole: 'owner' | 'viewer') {
    const app = Fastify({ bodyLimit: 1048576 + 4096 });
    const requireOwner = createRequireOwner();
    const simAuth = async (req: any) => { req.user = { role: simRole }; };
    const getProj = (pid: number) => ps.getProject(pid);

    app.put('/api/projects/:id/docs/:filename', { preHandler: [simAuth, requireOwner] }, async (req: any, reply: any) => {
      const pid = Number(req.params.id);
      const rel = req.query?.path ? req.query.path : req.params.filename;
      const proj = getProj(pid);
      if (!proj) return reply.code(404).send({ error: 'unknown project' });
      try {
        const body = req.body || {};
        if (typeof body.content !== 'string') return reply.code(400).send({ error: 'content required' });
        if (Buffer.byteLength(body.content, 'utf8') > 1048576) return reply.code(400).send({ error: 'content too large' });
        await docsSvc.scaffoldProjectFolders(proj.directory).catch(() => {});
        const doc = await docsSvc.writeProjectDoc(pid, rel, body.content);
        return { doc };
      } catch (e: any) {
        if (e?.code === 'TOO_LARGE') return reply.code(400).send({ error: e.message || 'content too large' });
        const isTraversal = e.code === 'TRAVERSAL' || /traversal|only \.md|symlink/i.test(String(e.message));
        return reply.code(isTraversal ? 400 : 404).send({ error: e.message || 'write failed' });
      }
    });

    app.get('/api/projects/:id/docs/:filename', { preHandler: [simAuth, requireOwner] }, async (req: any, reply: any) => {
      const pid = Number(req.params.id);
      const rel = req.query?.path ? req.query.path : req.params.filename;
      if (!getProj(pid)) return reply.code(404).send({ error: 'unknown project' });
      try {
        const doc = await docsSvc.readProjectDoc(pid, rel);
        return { doc };
      } catch (e: any) {
        const isTraversal = e.code === 'TRAVERSAL' || /traversal|only \.md/i.test(String(e.message));
        return reply.code(isTraversal ? 400 : 404).send({ error: e.message || 'read failed' });
      }
    });

    app.delete('/api/projects/:id/docs/:filename', { preHandler: [simAuth, requireOwner] }, async (req: any, reply: any) => {
      const pid = Number(req.params.id);
      const rel = req.query?.path ? req.query.path : req.params.filename;
      if (!getProj(pid)) return reply.code(404).send({ error: 'unknown project' });
      try {
        await docsSvc.deleteProjectDoc(pid, rel);
        return { ok: true };
      } catch (e: any) {
        const isTraversal = e.code === 'TRAVERSAL' || /traversal|only \.md|symlink/i.test(String(e.message));
        return reply.code(isTraversal ? 400 : 404).send({ error: e.message || 'delete failed' });
      }
    });

    return app;
  }

  it('B13-1: write .md round-trips to disk under helm_docs/ and is readable via GET path', async () => {
    const content = '# Agent Notes\n\nSaved by B13 test.\n';
    const doc = await docsSvc.writeProjectDoc(projId, 'agent-notes.md', content);
    expect(doc.filename).toBe('agent-notes.md');
    expect(doc.content).toBe(content);

    const onDisk = path.join(projDir, 'helm_docs', 'agent-notes.md');
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(fs.readFileSync(onDisk, 'utf8')).toBe(content);

    const readBack = await docsSvc.readProjectDoc(projId, 'helm_docs/agent-notes.md');
    expect(readBack.content).toBe(content);
  });

  it('B13-2: rejects .. traversal', async () => {
    await expect(docsSvc.writeProjectDoc(projId, '../helm_tasks/evil.md', 'x')).rejects.toMatchObject({ code: 'TRAVERSAL' });
    await expect(docsSvc.writeProjectDoc(projId, '../package.json', 'x')).rejects.toMatchObject({ code: 'TRAVERSAL' });
  });

  it('B13-3: rejects absolute path', async () => {
    const abs = path.join(os.tmpdir(), 'evil-abs.md');
    await expect(docsSvc.writeProjectDoc(projId, abs, 'x')).rejects.toMatchObject({ code: 'TRAVERSAL' });
  });

  it('B13-4: rejects non-.md extension', async () => {
    await expect(docsSvc.writeProjectDoc(projId, 'notes.txt', 'x')).rejects.toMatchObject({ code: 'TRAVERSAL' });
  });

  it('B13-5: rejects write outside helm_docs (parent escape via ..)', async () => {
    await expect(docsSvc.writeProjectDoc(projId, '../north-star.md', '# x\n')).rejects.toMatchObject({ code: 'TRAVERSAL' });
    expect(fs.existsSync(path.join(projDir, 'north-star.md'))).toBe(false);
  });

  it('B13-6: pre-planted symlink in helm_docs pointing outside blocks write and delete', async () => {
    const outside = path.join(os.tmpdir(), `helm-b13-out-${Date.now()}.md`);
    fs.writeFileSync(outside, 'SECRET');
    const link = path.join(projDir, 'helm_docs', 'escape.md');
    fs.symlinkSync(outside, link);

    await expect(docsSvc.writeProjectDoc(projId, 'escape.md', '# pwn\n')).rejects.toMatchObject({ code: 'TRAVERSAL' });
    await expect(docsSvc.deleteProjectDoc(projId, 'escape.md')).rejects.toMatchObject({ code: 'TRAVERSAL' });
    expect(fs.readFileSync(outside, 'utf8')).toBe('SECRET');

    try { fs.unlinkSync(link); fs.unlinkSync(outside); } catch {}
  });

  it('B13-7: rejects oversize content (>1MB)', async () => {
    const big = 'x'.repeat(1048577);
    await expect(docsSvc.writeProjectDoc(projId, 'big.md', big)).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('B13-8: delete round-trip removes on-disk file', async () => {
    await docsSvc.writeProjectDoc(projId, 'temp.md', '# temp\n');
    const fp = path.join(projDir, 'helm_docs', 'temp.md');
    expect(fs.existsSync(fp)).toBe(true);
    await docsSvc.deleteProjectDoc(projId, 'temp.md');
    expect(fs.existsSync(fp)).toBe(false);
    await expect(docsSvc.readProjectDoc(projId, 'helm_docs/temp.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('B13-9: API PUT/GET/DELETE round-trip at route + on-disk level', async () => {
    const app = buildDocsApp('owner');
    const payload = { content: '# Via API\n\nhello\n' };

    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projId}/docs/notes.md`,
      payload
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().doc.content).toBe(payload.content);
    expect(fs.readFileSync(path.join(projDir, 'helm_docs', 'notes.md'), 'utf8')).toBe(payload.content);

    const get = await app.inject({
      method: 'GET',
      url: `/api/projects/${projId}/docs/notes.md?path=helm_docs/notes.md`
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().doc.content).toBe(payload.content);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projId}/docs/notes.md`
    });
    expect(del.statusCode).toBe(200);
    expect(fs.existsSync(path.join(projDir, 'helm_docs', 'notes.md'))).toBe(false);
  });

  it('B13-10: API rejects traversal and symlink escape with 400', async () => {
    const app = buildDocsApp('owner');

    const trav = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projId}/docs/evil.md`,
      payload: { content: 'x' },
      query: { path: '../helm_tasks/evil.md' }
    });
    expect(trav.statusCode).toBe(400);

    const outside = path.join(os.tmpdir(), `helm-b13-api-out-${Date.now()}.md`);
    fs.writeFileSync(outside, 'OUT');
    const link = path.join(projDir, 'helm_docs', 'api-escape.md');
    fs.symlinkSync(outside, link);
    const sym = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projId}/docs/api-escape.md`,
      payload: { content: 'pwn' }
    });
    expect(sym.statusCode).toBe(400);
    expect(fs.readFileSync(outside, 'utf8')).toBe('OUT');
    try { fs.unlinkSync(link); fs.unlinkSync(outside); } catch {}
  });

  it('B13-11: API rejects oversize with 400', async () => {
    const app = buildDocsApp('owner');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projId}/docs/big.md`,
      payload: { content: 'z'.repeat(1048577) }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/too large/i);
  });

  it('B13-12: non-owner API write returns 403', async () => {
    const app = buildDocsApp('viewer');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projId}/docs/noauth.md`,
      payload: { content: '# no\n' }
    });
    expect(res.statusCode).toBe(403);
  });
});