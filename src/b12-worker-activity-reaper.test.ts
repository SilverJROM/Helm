/**
 * B12 / AC17 — worker timeout reaper uses observed tmux session_activity, not age alone.
 * Synthetic/fake only. HELM_SESSION_JANITOR stays 0. No live tmux/reap.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { WorkerService } from './services/worker-service.js';

const TIMEOUT_MS = 60_000; // 1 min — started_at is 2h old so age always selects

describe.sequential('B12 worker timeout activity gate (AC17)', () => {
  let db: DatabaseService;
  let tmpDb: string;
  let projectId: number;
  let projDir: string;

  beforeEach(() => {
    tmpDb = path.join(os.tmpdir(), `helm-b12-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
    db = new DatabaseService(tmpDb);
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b12-proj-'));
    const projects = new ProjectService(db);
    const proj = projects.createProject({ name: 'b12-test', directory: projDir });
    projectId = proj.id;
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

  /**
   * Role without checkin_ms so B13 path cannot confound AC17.
   * discovery seed has checkin_ms NULL.
   */
  function insertOldRunning(session: string): number {
    const info = db.raw
      .prepare(
        `INSERT INTO worker_runtimes (project_id, role, provider, model, session, correlation_id, state, spawned_by, started_at)
         VALUES (?,?,?,?,?,?,'running','b12-test', datetime('now', '-2 hours'))`
      )
      .run(projectId, 'discovery', 'grok', 'grok-4.5', session, `b12-corr-${session}`);
    return Number(info.lastInsertRowid);
  }

  function makeWorker(sessionActivity: number | null) {
    // Typed mock: session name is the first real arg (vi.fn() alone infers zero-arg [] → TS2493).
    const terminateSession = vi.fn(async (_name: string, _opts?: unknown) => undefined);
    const sendAndSubmit = vi.fn(async () => true);
    const sendKeys = vi.fn(async () => ({ message: 'ok', blocked: false }));
    const fakeTmux = {
      sessionExists: async () => true,
      sessionExistsTriState: async () => true as boolean | null,
      sessionActivity: async () => sessionActivity,
      terminateSession,
      sendAndSubmit,
      sendKeys,
    };
    const events = { recordEvent: vi.fn() };
    const worker = new WorkerService(db, events as any, fakeTmux as any, {} as any, {} as any);
    return { worker, terminateSession, events };
  }

  it('old started_at + recent tmux activity → survives timeout pass', async () => {
    const session = 'helm-b12-recent-act';
    const id = insertOldRunning(session);
    // Activity 30s ago — well under TIMEOUT_MS.
    const recentSec = Math.floor((Date.now() - 30_000) / 1000);
    const { worker, terminateSession } = makeWorker(recentSec);

    await (worker as any)._reapTick(TIMEOUT_MS);

    const row = db.raw
      .prepare('SELECT state, exit_reason, ended_at FROM worker_runtimes WHERE id = ?')
      .get(id) as any;
    expect(row.state).toBe('running');
    expect(row.ended_at).toBeNull();
    expect(row.exit_reason).toBeNull();
    expect(terminateSession).not.toHaveBeenCalled();
  });

  it('old started_at + UNKNOWN activity → survives (keep-biased)', async () => {
    const session = 'helm-b12-unknown-act';
    const id = insertOldRunning(session);
    const { worker, terminateSession } = makeWorker(null);

    await (worker as any)._reapTick(TIMEOUT_MS);

    const row = db.raw
      .prepare('SELECT state, exit_reason, ended_at FROM worker_runtimes WHERE id = ?')
      .get(id) as any;
    expect(row.state).toBe('running');
    expect(row.ended_at).toBeNull();
    expect(terminateSession).not.toHaveBeenCalled();
  });

  it('old started_at + known stale activity → one fake timeout reap', async () => {
    const session = 'helm-b12-stale-act';
    const id = insertOldRunning(session);
    // Activity older than TIMEOUT_MS.
    const staleSec = Math.floor((Date.now() - (TIMEOUT_MS + 120_000)) / 1000);
    const { worker, terminateSession, events } = makeWorker(staleSec);

    await (worker as any)._reapTick(TIMEOUT_MS);

    const row = db.raw
      .prepare('SELECT state, exit_reason, ended_at FROM worker_runtimes WHERE id = ?')
      .get(id) as any;
    expect(row.state).toBe('failed');
    expect(row.exit_reason).toBe('timeout');
    expect(row.ended_at).toBeTruthy();
    expect(terminateSession).toHaveBeenCalledTimes(1);
    expect(terminateSession.mock.calls[0][0]).toBe(session);
    expect(events.recordEvent).toHaveBeenCalled();

    // Idempotent: second tick does not re-terminate.
    await (worker as any)._reapTick(TIMEOUT_MS);
    expect(terminateSession).toHaveBeenCalledTimes(1);
  });
});
