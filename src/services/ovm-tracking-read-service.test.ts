import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { TrackingReadService } from './ovm-tracking-read-service.js';
import { createRequireOwner } from '../auth/auth-middleware.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-o61-'));
  const db = new DatabaseService(path.join(dir, 'helm.db'));
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('O6.1 TrackingReadService', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  it('T1: returns a multi-project native snapshot with real task progress and active children', () => {
    const { db, cleanup } = setup(); cleanups.push(cleanup);
    db.raw.prepare("INSERT INTO projects (id,name,directory) VALUES (1,'one','/tmp/one'),(2,'two','/tmp/two')").run();
    db.raw.prepare("INSERT INTO runs (id,project_id,batch_id,source,phase,status) VALUES (10,1,'a','native','executing','active'),(20,2,'b','ingest','planning','active')").run();
    db.raw.prepare("INSERT INTO run_tasks (run_id,label,status) VALUES (10,'a','complete'),(10,'b','failed'),(10,'c','deferred'),(10,'d','working')").run();
    db.raw.prepare("INSERT INTO worker_runtimes (project_id,run_id,role,provider,model,state) VALUES (1,10,'implementer','codex','x','running')").run();
    db.raw.prepare("INSERT INTO helm_sessions (name,project_id,run_id,owner,status) VALUES ('helm-a',1,10,'legacy:unknown','active')").run();
    const snapshot = new TrackingReadService(db).snapshot();
    expect(snapshot.runs).toHaveLength(2);
    const firstRun = snapshot.runs.find((r: any) => r.identity.id === 10)!;
    expect(firstRun).toMatchObject({ progress: { done: 1, failed: 1, parked: 1, total: 4 }, state: 'active' });
    expect(firstRun.active_workers).toHaveLength(1);
  });

  it('T2: represents empty, orphaned, and terminal-with-active-children states explicitly', () => {
    const { db, cleanup } = setup(); cleanups.push(cleanup);
    db.raw.prepare("INSERT INTO projects (id,name,directory) VALUES (1,'one','/tmp/one')").run();
    db.raw.prepare("INSERT INTO runs (id,project_id,phase,status) VALUES (1,1,'planning','active'),(2,1,'complete','complete')").run();
    db.raw.prepare("INSERT INTO worker_runtimes (project_id,run_id,role,provider,model,state) VALUES (1,2,'implementer','codex','x','running')").run();
    db.raw.prepare("INSERT INTO helm_sessions (name,project_id,owner,status) VALUES ('helm-orphan',1,'legacy:unknown','active')").run();
    const snapshot = new TrackingReadService(db).snapshot({ projectId: 1 });
    expect(snapshot.runs.find((r: any) => r.identity.id === 1)!.state).toBe('empty');
    expect(snapshot.runs.find((r: any) => r.identity.id === 2)!.state).toBe('terminal_with_active_children');
    expect(snapshot.orphan_sessions).toMatchObject([{ name: 'helm-orphan', state: 'orphaned' }]);
  });

  it('T3: uses the established auth + owner guard and project filter does not leak runs', async () => {
    const { db, cleanup } = setup(); cleanups.push(cleanup);
    db.raw.prepare("INSERT INTO projects (id,name,directory) VALUES (1,'one','/tmp/one'),(2,'two','/tmp/two')").run();
    db.raw.prepare("INSERT INTO runs (id,project_id) VALUES (1,1),(2,2)").run();
    const service = new TrackingReadService(db);
    const app = Fastify();
    const auth = async (req: any, reply: any) => { if (req.headers.authorization === 'Bearer owner') req.user = { role: 'owner' }; else reply.code(401).send({ error: 'missing or invalid authorization header' }); };
    app.get('/api/tracking', { preHandler: [auth, createRequireOwner()] }, async (request: any) => service.snapshot({ projectId: request.query.project_id == null ? undefined : Number(request.query.project_id) }));
    expect((await app.inject({ method: 'GET', url: '/api/tracking?project_id=1' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/tracking?project_id=1', headers: { authorization: 'Bearer viewer' } })).statusCode).toBe(401);
    const owner = await app.inject({ method: 'GET', url: '/api/tracking?project_id=1', headers: { authorization: 'Bearer owner' } });
    expect(owner.statusCode).toBe(200);
    expect(owner.json().runs.map((r: any) => r.identity.id)).toEqual([1]);
    await app.close();
  });
});
