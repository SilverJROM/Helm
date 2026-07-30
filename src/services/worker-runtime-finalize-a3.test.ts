import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DatabaseService } from '../db/database.js';
import { finalizeWorkerRuntimeRow, configureWorkerRuntimeFinalize } from './worker-runtime-finalize.js';
import { ProjectService } from './project-service.js';
import { RunArtifactService } from './run-artifact-service.js';
import { SessionRegistryService } from './session-registry-service.js';

/**
 * A3 — assertRegistryIdle binds registry-idle assertion to run-owned runtime identity, not name
 * alone (AC3). Proves a same-name but unrelated LIVE master session is never marked idle by a
 * stale/unrelated run's finalize, while a genuinely run-owned session still is.
 */
describe.sequential('A3 assertRegistryIdle run-owned identity binding', () => {
  let db: DatabaseService;
  let tmpDb: string;
  let projectId: number;
  let runA: number;
  let runB: number;
  let projDir: string;
  let reg: SessionRegistryService;

  beforeEach(() => {
    tmpDb = path.join(os.tmpdir(), `helm-a3-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new DatabaseService(tmpDb);
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-a3-proj-'));
    const projects = new ProjectService(db);
    const proj = projects.createProject({ name: 'a3-brain', directory: projDir });
    projectId = proj.id;
    const artifacts = new RunArtifactService(db);
    runA = artifacts.createRun(projectId, `a3-run-a-${Date.now()}`, path.join(projDir, 'ns.md'), null);
    runB = artifacts.createRun(projectId, `a3-run-b-${Date.now()}`, path.join(projDir, 'ns.md'), null);
    reg = new SessionRegistryService(db);
    configureWorkerRuntimeFinalize({
      markIdle: (token, reason) => reg.markIdle(token, reason),
    });
  });

  afterEach(() => {
    configureWorkerRuntimeFinalize({ markIdle: null });
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tmpDb, { force: true });
    } catch {}
    try {
      fs.rmSync(projDir, { recursive: true, force: true });
    } catch {}
  });

  function insertRuntimeRow(session: string, runId: number | null): number {
    const info = db.raw
      .prepare(
        `INSERT INTO worker_runtimes (project_id, role, provider, model, session, correlation_id, state, spawned_by, run_id, started_at)
         VALUES (?,?,?,?,?,?,'running','a3-test',?, datetime('now'))`
      )
      .run(projectId, 'ibrain', 'grok', 'grok-4.5', session, 'a3-corr', runId);
    return Number(info.lastInsertRowid);
  }

  it('(1) same-name unrelated LIVE session (owned by a different run) is not marked idle', () => {
    const session = 'helm-ibrain-a3_brain';
    // Session currently registered to runB — live, active, unrelated to the row we finalize below.
    reg.register(session, { owner: 'helm', projectId, runId: runB, kind: 'ibrain' });
    expect(reg.get(session)!.status).toBe('active');

    // A stale worker_runtimes row from runA, same session name.
    const staleId = insertRuntimeRow(session, runA);

    const changed = finalizeWorkerRuntimeRow(db.raw, staleId, 'reaped', 'run-a-stale-finalize');
    expect(changed).toBe(true); // the runtime row itself always finalizes — only markIdle is guarded.

    const wr = db.raw.prepare(`SELECT state FROM worker_runtimes WHERE id = ?`).get(staleId) as any;
    expect(wr.state).toBe('reaped');

    // runB's live session must be untouched.
    expect(reg.get(session)!.status).toBe('active');
    expect(reg.get(session)!.run_id).toBe(runB);
  });

  it('(2) matching run-owned session is still marked idle (regression guard)', () => {
    const session = 'helm-ibrain-a3_owned';
    reg.register(session, { owner: 'helm', projectId, runId: runA, kind: 'ibrain' });
    expect(reg.get(session)!.status).toBe('active');

    const id = insertRuntimeRow(session, runA);
    const changed = finalizeWorkerRuntimeRow(db.raw, id, 'done', 'run-a-complete');
    expect(changed).toBe(true);

    expect(reg.get(session)!.status).toBe('idle');
    expect(reg.get(session)!.reason).toBe('run-a-complete');
  });

  it('(3) both run_id NULL (ad-hoc no-run-context worker) still marks idle — null-safe IS preserved', () => {
    const session = 'helm-w-a3_adhoc';
    reg.register(session, { owner: 'helm', projectId, runId: null, kind: 'worker' });
    expect(reg.get(session)!.status).toBe('active');
    expect(reg.get(session)!.run_id).toBeNull();

    const id = insertRuntimeRow(session, null);
    const changed = finalizeWorkerRuntimeRow(db.raw, id, 'done', 'adhoc-complete');
    expect(changed).toBe(true);

    expect(reg.get(session)!.status).toBe('idle');
    expect(reg.get(session)!.reason).toBe('adhoc-complete');
  });
});
