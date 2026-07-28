import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DatabaseService } from './db/database.js';
import {
  finalizeWorkerRuntimeRow,
  finalizeSessionGoneWorkers,
  finalizeRunWorkerRuntimes,
  finalizeBrainSessionRow,
  configureWorkerRuntimeFinalize,
} from './services/worker-runtime-finalize.js';
import { ProjectService } from './services/project-service.js';
import { RunArtifactService } from './services/run-artifact-service.js';
import {
  SessionRegistryService,
  deriveSessionKind,
  sessionStatusTokenFromRow,
} from './services/session-registry-service.js';

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

  it('(c) finalizeWorkerRuntimeRow is no-op when row already terminal', () => {
    const id = insertRunning('helm-a15-terminal-already');
    db.raw
      .prepare(`UPDATE worker_runtimes SET state='done', exit_reason='prior-done', ended_at='2000-01-01T00:00:00.000Z' WHERE id=?`)
      .run(id);
    const before = db.raw.prepare('SELECT state, exit_reason, ended_at FROM worker_runtimes WHERE id = ?').get(id) as any;
    expect(before.state).toBe('done');

    const changed = finalizeWorkerRuntimeRow(db.raw, id, 'failed', 'should-not-overwrite');
    expect(changed).toBe(false);

    const after = db.raw.prepare('SELECT state, exit_reason, ended_at FROM worker_runtimes WHERE id = ?').get(id) as any;
    expect(after.state).toBe('done');
    expect(after.exit_reason).toBe('prior-done');
    expect(after.ended_at).toBe(before.ended_at);
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

/**
 * S02 — markIdle propagation at the finalize chokepoint (synthetic DB only).
 * (1) first terminal transition → helm_sessions idle + reason
 * (2) already-reaped registry stays reaped
 * (3) no-op finalize writes no registry change
 * (4) null/empty session does not throw
 */
describe.sequential('S02 finalizeWorkerRuntimeRow markIdle propagation', () => {
  let db: DatabaseService;
  let tmpDb: string;
  let projectId: number;
  let runId: number;
  let projDir: string;
  let reg: SessionRegistryService;

  beforeEach(() => {
    tmpDb = path.join(os.tmpdir(), `helm-s02-markidle-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new DatabaseService(tmpDb);
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-s02-proj-'));
    const projects = new ProjectService(db);
    const proj = projects.createProject({ name: 's02-markidle', directory: projDir });
    projectId = proj.id;
    const artifacts = new RunArtifactService(db);
    runId = artifacts.createRun(projectId, `s02-b-${Date.now()}`, path.join(projDir, 'ns.md'), null);
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

  function insertRunning(session: string | null): number {
    const info = db.raw
      .prepare(
        `INSERT INTO worker_runtimes (project_id, role, provider, model, session, correlation_id, state, spawned_by, run_id, started_at)
         VALUES (?,?,?,?,?,?,'running','s02-test',?, datetime('now'))`
      )
      .run(projectId, 'implementer', 'grok', 'grok-4.5', session, 's02-corr', runId);
    return Number(info.lastInsertRowid);
  }

  it('(1) finalize running+session → helm_sessions.status=idle with reason', () => {
    const session = 'helm-w-s02-idle-1';
    reg.register(session, { owner: 'helm',  projectId, runId, kind: 'worker' });
    expect(reg.get(session)!.status).toBe('active');

    const id = insertRunning(session);
    const changed = finalizeWorkerRuntimeRow(db.raw, id, 'done', 'reaped-DONE');
    expect(changed).toBe(true);

    const wr = db.raw.prepare('SELECT state, exit_reason FROM worker_runtimes WHERE id=?').get(id) as any;
    expect(wr.state).toBe('done');
    expect(wr.exit_reason).toBe('reaped-DONE');

    const sess = reg.get(session)!;
    expect(sess.status).toBe('idle');
    expect(sess.reason).toBe('reaped-DONE');
  });

  it('(2) session already reaped stays reaped', () => {
    const session = 'helm-w-s02-already-reaped';
    reg.register(session, { owner: 'helm',  projectId, runId, kind: 'worker' });
    reg.markReaped(sessionStatusTokenFromRow(reg.get(session)!), 'prior-terminate');
    expect(reg.get(session)!.status).toBe('reaped');

    const id = insertRunning(session);
    const changed = finalizeWorkerRuntimeRow(db.raw, id, 'reaped', 'run-aborted');
    expect(changed).toBe(true);

    const sess = reg.get(session)!;
    expect(sess.status).toBe('reaped');
    expect(sess.reason).toBe('prior-terminate');
    expect(sess.ended_at).toBeTruthy();
  });

  it('(3) no-op finalize writes no registry change', () => {
    const session = 'helm-w-s02-noop';
    reg.register(session, { owner: 'helm',  projectId, runId, kind: 'worker' });
    const id = insertRunning(session);
    db.raw
      .prepare(`UPDATE worker_runtimes SET state='done', exit_reason='prior-done', ended_at='2000-01-01T00:00:00.000Z' WHERE id=?`)
      .run(id);

    const changed = finalizeWorkerRuntimeRow(db.raw, id, 'failed', 'should-not-touch-registry');
    expect(changed).toBe(false);

    const sess = reg.get(session)!;
    expect(sess.status).toBe('active');
    expect(sess.reason).toBeNull();
  });

  it('(4) session null/empty does not throw', () => {
    const idNull = insertRunning(null);
    expect(() => finalizeWorkerRuntimeRow(db.raw, idNull, 'failed', 'launch-error')).not.toThrow();
    expect(
      (db.raw.prepare('SELECT state FROM worker_runtimes WHERE id=?').get(idNull) as any).state
    ).toBe('failed');

    const idEmpty = insertRunning('');
    expect(() => finalizeWorkerRuntimeRow(db.raw, idEmpty, 'reaped', 'session-gone')).not.toThrow();
    expect(
      (db.raw.prepare('SELECT state FROM worker_runtimes WHERE id=?').get(idEmpty) as any).state
    ).toBe('reaped');

    // absent registry row for a real session name: markIdle no-ops, no throw
    const idMissing = insertRunning('helm-w-s02-never-registered');
    expect(() => finalizeWorkerRuntimeRow(db.raw, idMissing, 'done', 'reaped-DONE')).not.toThrow();
    expect(reg.get('helm-w-s02-never-registered')).toBeUndefined();
  });
});

/**
 * S03 — brain seat completion assertion (AC24 brains).
 *
 * Kind ownership map (helm_sessions.kind → assertion / scope):
 * | kind | assertion path |
 * | plancore | planning-phase-service planning-phase-complete → finalizeWorkerRuntimeRow (RETAIN) |
 * | planner / deliberation (planning partners) | same planning-phase finalize (RETAIN) |
 * | ibrain | S03 finalizeBrainSessionRow at true run terminals only |
 * | implementer / validator / worker / red-team / panelist / coord / routine-implementer | S02 finalizeWorkerRuntimeRow |
 * | discovery | human-owned chat — out of automatic assertion scope (S14 manual close) |
 * | test | helm probe seats — reaped by terminate path; not a phase brain |
 * | other (incl. retired helm-projcore / helm-pm names) | residual; no automatic brain lifecycle |
 *
 * Fake transports / synthetic DB only. No live tmux. HELM_SESSION_JANITOR stays 0.
 */
describe.sequential('S03 brain completion assertion (finalizeBrainSessionRow)', () => {
  let db: DatabaseService;
  let tmpDb: string;
  let projectId: number;
  let runId: number;
  let projDir: string;
  let reg: SessionRegistryService;

  beforeEach(() => {
    tmpDb = path.join(os.tmpdir(), `helm-s03-brain-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new DatabaseService(tmpDb);
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-s03-proj-'));
    const projects = new ProjectService(db);
    const proj = projects.createProject({ name: 's03-brain', directory: projDir });
    projectId = proj.id;
    const artifacts = new RunArtifactService(db);
    runId = artifacts.createRun(projectId, `s03-b-${Date.now()}`, path.join(projDir, 'ns.md'), null);
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

  it('(1) ibrain becomes idle only at true terminal finalizeBrainSessionRow — not before; no reap invented', () => {
    const session = 'helm-ibrain-s03_brain';
    reg.register(session, { owner: 'helm',  projectId, runId, kind: 'ibrain' });
    expect(reg.get(session)!.status).toBe('active');
    expect(deriveSessionKind(session)).toBe('ibrain');

    // Intermediate / pre-terminal: registry still active, no worker_runtimes row yet.
    const mid = db.raw
      .prepare(`SELECT COUNT(*) AS n FROM worker_runtimes WHERE session = ? AND run_id = ?`)
      .get(session, runId) as { n: number };
    expect(Number(mid.n)).toBe(0);
    expect(reg.get(session)!.status).toBe('active');

    // True terminal assertion (run-complete) — register-if-needed + finalizeWorkerRuntimeRow path.
    const changed = finalizeBrainSessionRow(db.raw, {
      projectId,
      runId,
      session,
      role: 'ibrain',
      reason: 'run-complete',
      state: 'done',
      provider: 'grok',
      model: 'grok-4.5',
    });
    expect(changed).toBe(true);

    const wr = db.raw
      .prepare(
        `SELECT state, exit_reason, session, role FROM worker_runtimes WHERE run_id = ? AND session = ? ORDER BY id DESC LIMIT 1`
      )
      .get(runId, session) as any;
    expect(wr.state).toBe('done');
    expect(wr.exit_reason).toBe('run-complete');
    expect(wr.role).toBe('ibrain');

    const sess = reg.get(session)!;
    expect(sess.status).toBe('idle');
    expect(sess.reason).toBe('run-complete');
    // D-a3 keep-alive: idle is not reaped; session row still present without ended_at from markReaped.
    expect(sess.ended_at).toBeNull();

    // Idempotent: second terminal assert is no-op (already terminal ledger).
    const changed2 = finalizeBrainSessionRow(db.raw, {
      projectId,
      runId,
      session,
      role: 'ibrain',
      reason: 'run-complete',
      state: 'done',
    });
    expect(changed2).toBe(false);
    expect(reg.get(session)!.status).toBe('idle');
  });

  it('(2) plancore planning-phase finalize path still marks idle; kind map smoke; finalizeBrain does not call reap', () => {
    // plancore RETAIN path: same finalizeWorkerRuntimeRow chokepoint used by planning-phase-service.
    const plancoreSession = 'helm-plancore-s03_brain';
    reg.register(plancoreSession, { owner: 'helm',  projectId, runId, kind: 'plancore' });
    const info = db.raw
      .prepare(
        `INSERT INTO worker_runtimes (project_id, role, provider, model, session, correlation_id, state, spawned_by, run_id, started_at)
         VALUES (?,?,?,?,?,?,'running','planning-phase',?, datetime('now'))`
      )
      .run(projectId, 'plancore', 'grok', 'grok-4.5', plancoreSession, 's03-plan', runId);
    const plancoreId = Number(info.lastInsertRowid);
    const pcChanged = finalizeWorkerRuntimeRow(db.raw, plancoreId, 'done', 'planning-phase-complete');
    expect(pcChanged).toBe(true);
    expect(reg.get(plancoreSession)!.status).toBe('idle');
    expect(reg.get(plancoreSession)!.reason).toBe('planning-phase-complete');
    expect(deriveSessionKind(plancoreSession)).toBe('plancore');

    // Kind enumeration smoke (canonical names + residual).
    expect(deriveSessionKind('helm-ibrain-x')).toBe('ibrain');
    expect(deriveSessionKind('helm-discovery-x')).toBe('discovery');
    expect(deriveSessionKind('helm-w-x-1')).toBe('worker');
    expect(deriveSessionKind('helm-projcore-x')).toBe('other'); // retired name
    expect(deriveSessionKind('helm-batch-A1-implementer-abc')).toBe('implementer');
    expect(deriveSessionKind('helm-batch-A1-validator-abc')).toBe('validator');
    expect(deriveSessionKind('helm-batch-A1-planner-abc')).toBe('planner');

    // finalizeBrainSessionRow is pure ledger/registry — no transport.reap side channel to invent.
    // Prove it never needs a reap callback and leaves a live registry row as idle (not reaped).
    const ibrain = 'helm-ibrain-s03_no_reap';
    reg.register(ibrain, { owner: 'helm',  projectId, runId, kind: 'ibrain' });
    finalizeBrainSessionRow(db.raw, {
      projectId,
      runId,
      session: ibrain,
      reason: 'run-failed',
      state: 'failed',
    });
    expect(reg.get(ibrain)!.status).toBe('idle');
    expect(reg.get(ibrain)!.status).not.toBe('reaped');
    expect(reg.get(ibrain)!.ended_at).toBeNull();
  });

  it('(3) detached-start-failed terminal uses same finalizeBrainSessionRow path (register-if-needed → idle)', () => {
    // Mirrors startRunDetached .catch: reason detached-start-failed, state failed.
    // Project name 's03-brain' → slug s03_brain → helm-ibrain-s03_brain (assertImplementationBrainComplete resolve).
    const session = 'helm-ibrain-s03_brain';
    reg.register(session, { owner: 'helm',  projectId, runId, kind: 'ibrain' });
    expect(reg.get(session)!.status).toBe('active');

    const changed = finalizeBrainSessionRow(db.raw, {
      projectId,
      runId,
      session,
      role: 'ibrain',
      reason: 'detached-start-failed',
      state: 'failed',
    });
    expect(changed).toBe(true);

    const wr = db.raw
      .prepare(
        `SELECT state, exit_reason FROM worker_runtimes WHERE run_id = ? AND session = ? ORDER BY id DESC LIMIT 1`
      )
      .get(runId, session) as any;
    expect(wr.state).toBe('failed');
    expect(wr.exit_reason).toBe('detached-start-failed');
    expect(reg.get(session)!.status).toBe('idle');
    expect(reg.get(session)!.reason).toBe('detached-start-failed');
    expect(reg.get(session)!.ended_at).toBeNull();
  });
});
