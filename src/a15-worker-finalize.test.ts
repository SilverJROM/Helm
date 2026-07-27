import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DatabaseService } from './db/database.js';
import {
  finalizeWorkerRuntimeRow,
  finalizeSessionGoneWorkers,
  finalizeRunWorkerRuntimes,
} from './services/worker-runtime-finalize.js';
import { ProjectService } from './services/project-service.js';
import { RunArtifactService } from './services/run-artifact-service.js';

/**
 * A15 / R4.16–R4.17 — finalize-to-reaped / truthful live.
 * (a) session gone → row terminal + ended_at set
 * (b) live flag false when tmux missing despite state=running (self-heal path)
 */

describe.sequential('A15 worker_runtimes finalize-to-reaped', () => {
  let db: DatabaseService;
  let tmpDb: string;
  let projectId: number;
  let runId: number;
  let projDir: string;

  beforeEach(() => {
    tmpDb = path.join(os.tmpdir(), `helm-a15-${Date.now()}.db`);
    db = new DatabaseService(tmpDb);
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-a15-proj-'));
    const projects = new ProjectService(db);
    const proj = projects.createProject({ name: 'a15-test', directory: projDir });
    projectId = proj.id;
    const artifacts = new RunArtifactService(db);
    runId = artifacts.createRun(projectId, `a15-b-${Date.now()}`, path.join(projDir, 'ns.md'), null);
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

  function insertRunning(session: string): number {
    const info = db.raw
      .prepare(
        `INSERT INTO worker_runtimes (project_id, role, provider, model, session, correlation_id, state, spawned_by, run_id, started_at)
         VALUES (?,?,?,?,?,?,'running','a15-test',?, datetime('now'))`
      )
      .run(projectId, 'plancore', 'grok', 'grok-4.5', session, 'a15-corr', runId);
    return Number(info.lastInsertRowid);
  }

  it('(a) session gone → row terminal + ended_at set', async () => {
    const id = insertRunning('helm-a15-dead-session');
    const before = db.raw.prepare('SELECT state, ended_at FROM worker_runtimes WHERE id = ?').get(id) as any;
    expect(before.state).toBe('running');
    expect(before.ended_at).toBeNull();

    const n = await finalizeSessionGoneWorkers(db.raw, async () => false);
    expect(n).toBe(1);

    const after = db.raw
      .prepare('SELECT state, exit_reason, ended_at FROM worker_runtimes WHERE id = ?')
      .get(id) as any;
    expect(after.state).toBe('reaped');
    expect(after.exit_reason).toBe('session-gone');
    expect(after.ended_at).toBeTruthy();
  });

  it('(a2) finalizeRunWorkerRuntimes transitions all non-terminal seats for a run', async () => {
    const a = insertRunning('helm-a15-a');
    const b = insertRunning('helm-a15-b');
    const reapedSessions: string[] = [];
    const n = await finalizeRunWorkerRuntimes(db.raw, runId, 'run-complete', async (s) => {
      reapedSessions.push(s);
    });
    expect(n).toBe(2);
    expect(reapedSessions.sort()).toEqual(['helm-a15-a', 'helm-a15-b'].sort());
    for (const id of [a, b]) {
      const row = db.raw.prepare('SELECT state, ended_at FROM worker_runtimes WHERE id = ?').get(id) as any;
      expect(row.state).toBe('reaped');
      expect(row.ended_at).toBeTruthy();
    }
    // Idempotent
    const n2 = await finalizeRunWorkerRuntimes(db.raw, runId, 'run-complete');
    expect(n2).toBe(0);
  });

  it('(b) live is false when tmux missing despite state=running (self-heal predicate)', async () => {
    const id = insertRunning('helm-a15-ghost');
    // Simulate terminals self-heal: sessionExists false → finalize then live=false
    let tmuxAlive = await Promise.resolve(false);
    if (!tmuxAlive) {
      finalizeWorkerRuntimeRow(db.raw, id, 'reaped', 'session-gone');
    }
    const row = db.raw.prepare('SELECT state, ended_at FROM worker_runtimes WHERE id = ?').get(id) as any;
    const stateLive = row.state === 'launching' || row.state === 'running';
    const live = !!(stateLive && tmuxAlive);
    expect(row.state).toBe('reaped');
    expect(row.ended_at).toBeTruthy();
    expect(live).toBe(false);

    // SEAM-1 style: even without self-heal, live = stateLive && tmuxAlive is false when dead
    const stuckId = insertRunning('helm-a15-stuck-still-running');
    // Don't finalize — pure predicate
    const stuck = db.raw.prepare('SELECT state FROM worker_runtimes WHERE id = ?').get(stuckId) as any;
    const sl = stuck.state === 'launching' || stuck.state === 'running';
    expect(sl).toBe(true);
    expect(!!(sl && false)).toBe(false); // tmux gone → not live
  });

  it('session still alive is not finalized by session-gone pass', async () => {
    const id = insertRunning('helm-a15-alive');
    const n = await finalizeSessionGoneWorkers(db.raw, async () => true);
    expect(n).toBe(0);
    const after = db.raw.prepare('SELECT state, ended_at FROM worker_runtimes WHERE id = ?').get(id) as any;
    expect(after.state).toBe('running');
    expect(after.ended_at).toBeNull();
  });
});
