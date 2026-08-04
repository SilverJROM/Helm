import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DatabaseService } from '../db/database.js';
import { finalizeBrainSessionRow } from './worker-runtime-finalize.js';
import { ProjectService } from './project-service.js';
import { RunArtifactService } from './run-artifact-service.js';

/**
 * A2 — finalizeBrainSessionRow becomes update-only (AC2). Proves the register-if-missing insert
 * path and the provider/model 'unknown' defaults are gone: a missing runtime row is a true no-op
 * (no synthesized ledger row), while an existing non-terminal row still finalizes normally.
 */
describe.sequential('A2 finalizeBrainSessionRow update-only', () => {
  let db: DatabaseService;
  let tmpDb: string;
  let projectId: number;
  let runId: number;
  let projDir: string;

  beforeEach(() => {
    tmpDb = path.join(os.tmpdir(), `helm-a2-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new DatabaseService(tmpDb);
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-a2-proj-'));
    const projects = new ProjectService(db);
    const proj = projects.createProject({ name: 'a2-brain', directory: projDir });
    projectId = proj.id;
    const artifacts = new RunArtifactService(db);
    runId = artifacts.createRun(projectId, `a2-b-${Date.now()}`, path.join(projDir, 'ns.md'), null);
  });

  afterEach(() => {
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

  function rowCountForRun(): number {
    const r = db.raw
      .prepare(`SELECT COUNT(*) AS n FROM worker_runtimes WHERE run_id = ?`)
      .get(runId) as { n: number };
    return Number(r.n);
  }

  function unknownIbrainCount(): number {
    const r = db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM worker_runtimes WHERE provider = 'unknown' AND model = 'unknown'`
      )
      .get() as { n: number };
    return Number(r.n);
  }

  function insertRow(session: string, state: 'running' | 'done' | 'failed' | 'reaped'): number {
    const info = db.raw
      .prepare(
        `INSERT INTO worker_runtimes (project_id, role, provider, model, session, correlation_id, state, spawned_by, run_id, started_at)
         VALUES (?,?,?,?,?,?,?,?,?, datetime('now'))`
      )
      .run(projectId, 'ibrain', 'grok', 'grok-4.5', session, 'a2-corr', state, 'test-setup', runId);
    return Number(info.lastInsertRowid);
  }

  it('(1) no existing runtime row → false, row count unchanged, no unknown/unknown row synthesized', () => {
    const session = 'helm-ibrain-a2_missing';
    expect(rowCountForRun()).toBe(0);

    const changed = finalizeBrainSessionRow(db.raw, {
      projectId,
      runId,
      session,
      role: 'ibrain',
      reason: 'run-complete',
      state: 'done',
    });

    expect(changed).toBe(false);
    expect(rowCountForRun()).toBe(0);
    expect(unknownIbrainCount()).toBe(0);
  });

  it('(2) already-terminal row → false, no resurrection, no second row inserted', () => {
    const session = 'helm-ibrain-a2_terminal';
    insertRow(session, 'done');
    expect(rowCountForRun()).toBe(1);

    const changed = finalizeBrainSessionRow(db.raw, {
      projectId,
      runId,
      session,
      role: 'ibrain',
      reason: 'run-complete',
      state: 'done',
    });

    expect(changed).toBe(false);
    expect(rowCountForRun()).toBe(1);
    expect(unknownIbrainCount()).toBe(0);
  });

  it('(3) existing non-terminal row → finalizes; second call is idempotent', () => {
    const session = 'helm-ibrain-a2_live';
    const id = insertRow(session, 'running');

    const changed = finalizeBrainSessionRow(db.raw, {
      projectId,
      runId,
      session,
      role: 'ibrain',
      reason: 'run-complete',
      state: 'done',
    });
    expect(changed).toBe(true);

    const wr = db.raw
      .prepare(`SELECT state, exit_reason FROM worker_runtimes WHERE id = ?`)
      .get(id) as any;
    expect(wr.state).toBe('done');
    expect(wr.exit_reason).toBe('run-complete');
    expect(rowCountForRun()).toBe(1);

    const changed2 = finalizeBrainSessionRow(db.raw, {
      projectId,
      runId,
      session,
      role: 'ibrain',
      reason: 'run-complete',
      state: 'done',
    });
    expect(changed2).toBe(false);
  });

  it('(4) expectedGeneration mismatch stays fail-closed even with a matching non-terminal row present', () => {
    const session = 'helm-ibrain-a2_gen';
    const id = insertRow(session, 'running');
    const actualGeneration = (db.raw.prepare('SELECT generation FROM runs WHERE id = ?').get(runId) as any)
      .generation;

    const changed = finalizeBrainSessionRow(db.raw, {
      projectId,
      runId,
      session,
      role: 'ibrain',
      reason: 'run-complete',
      state: 'done',
      expectedGeneration: actualGeneration + 1,
    });

    expect(changed).toBe(false);
    const wr = db.raw.prepare(`SELECT state FROM worker_runtimes WHERE id = ?`).get(id) as any;
    expect(wr.state).toBe('running');
  });
});
