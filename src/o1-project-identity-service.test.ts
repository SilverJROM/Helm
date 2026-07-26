import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';

function makeDbPath(): string {
  return process.env.HELM_DB_PATH && process.env.HELM_DB_PATH.trim()
    ? process.env.HELM_DB_PATH.trim()
    : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'helm-o12-')), 'db.sqlite');
}

describe('O1.2 project identity service + API projections', () => {
  const dbPath = makeDbPath();
  let cleanup: () => void;
  let dbs: DatabaseService;
  let ps: ProjectService;
  let app: any;

  beforeEach(() => {
    cleanup = () => {
      try {
        fs.rmSync(dbPath, { force: true });
      } catch {}
    };
    try {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    } catch {}
    dbs = new DatabaseService(dbPath);
    ps = new ProjectService(dbs);
    app = Fastify({ logger: false });

    app.get('/api/projects', async () => ({ projects: ps.listProjects() }));
    app.get('/api/projects/:id', async (request: any) => {
      const row = ps.getProject(Number(request.params.id));
      return { project: row };
    });
    app.put('/api/projects/:id', async (request: any, reply: any) => {
      const id = Number(request.params.id);
      const body = request.body || {};
      const nextDirectory = typeof body.directory === 'string' ? body.directory.trim() : '';
      if (!nextDirectory) return reply.code(400).send({ error: 'directory must be non-empty' });
      try {
        dbs.prepare('UPDATE projects SET directory = ? WHERE id = ?').run(nextDirectory, id);
      } catch (e: any) {
        if (String(e.message || e).includes('UNIQUE')) return reply.code(409).send({ error: e.message });
        return reply.code(400).send({ error: String(e?.message || e) });
      }
      return { project: ps.getProject(id) };
    });

    app.ready();
  });

  afterEach(() => {
    try {
      app.close();
    } catch {}
    cleanup();
  });

  it('T1 valid create/list/get/API round-trip includes directory_name/status/active, and directory_name is basename', async () => {
    const created = ps.createProject({
      name: 'Alpha',
      directory: '/tmp/Workspace/alpha-project'
    });

    expect(created.directory_name).toBe('alpha-project');
    expect(created.status).toBe('active');
    expect(created.active).toBe(1);

    const get = ps.getProject(created.id);
    expect(get?.directory_name).toBe('alpha-project');
    expect(get?.status).toBe('active');
    expect(get?.active).toBe(1);

    expect(ps.listProjects()).toEqual([{ ...get, status: 'active', active: 1 } as any]);

    const apiList = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(apiList.statusCode).toBe(200);
    expect(apiList.json()).toEqual({ projects: [{ ...get, status: 'active', active: 1 }] });

    const apiGet = await app.inject({ method: 'GET', url: `/api/projects/${created.id}` });
    expect(apiGet.statusCode).toBe(200);
    expect(apiGet.json()).toEqual({ project: get });
  });

  it('T2 unsafe/empty/duplicate directory fails create/update with zero mutation', async () => {
    const base = ps.createProject({ name: 'Base', directory: '/work/base' });
    const beforeCount = dbs.raw.prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number };

    expect(() => ps.createProject({ name: 'Blank', directory: '   ' })).toThrow(/directory is required/);
    expect(() => ps.createProject({ name: 'Root', directory: '/' })).toThrow();
    expect(() => ps.createProject({ name: 'Unsafe', directory: '/tmp/bad name' })).toThrow();

    const duplicate = ps.createProject({ name: 'Second', directory: '/work/dupe-other' });
    expect(() => ps.createProject({ name: 'Dup', directory: '/x/dupe-other' })).toThrow();

    const afterCount = dbs.raw.prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number };
    expect(afterCount.c).toBe(beforeCount.c + 1); // base + one safe additional project
    expect(base.directory_name).toBe('base');
    expect(duplicate.directory_name).toBe('dupe-other');

    const beforeRow = ps.getProject(base.id);
    expect(beforeRow).toBeTruthy();

    const badUpdate = await app.inject({ method: 'PUT', url: `/api/projects/${base.id}`, body: { directory: '   ' } });
    expect(badUpdate.statusCode).toBe(400);

    const unsafeUpdate = await app.inject({ method: 'PUT', url: `/api/projects/${base.id}`, body: { directory: '/new/bad name' } });
    expect(unsafeUpdate.statusCode).toBe(400);

    const duplicateUpdate = await app.inject({ method: 'PUT', url: `/api/projects/${base.id}`, body: { directory: '/tmp/dupe-other' } });
    expect(duplicateUpdate.statusCode).toBe(409);

    const afterRow = ps.getProject(base.id);
    expect(afterRow?.directory).toBe(beforeRow?.directory);
    expect(afterRow?.directory_name).toBe(beforeRow?.directory_name);
    expect(afterRow?.name).toBe(beforeRow?.name);

    const afterCount2 = dbs.raw.prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number };
    expect(afterCount2.c).toBe(afterCount.c);
  });

  it('T3 directory update recomputes directory_name via API round trip', async () => {
    const seed = ps.createProject({ name: 'Update', directory: '/tmp/before-old/' });

    const update = await app.inject({
      method: 'PUT',
      url: `/api/projects/${seed.id}`,
      body: { directory: '/tmp/new/dir-name-final' }
    });

    expect(update.statusCode).toBe(200);
    const body = update.json();
    expect(body.project.directory_name).toBe('dir-name-final');
    expect(body.project.directory).toBe('/tmp/new/dir-name-final');

    const check = ps.getProject(seed.id);
    expect(check?.directory_name).toBe('dir-name-final');
  });
});
