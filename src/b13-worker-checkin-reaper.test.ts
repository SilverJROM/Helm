/**
 * B13 / AC18 (amended) — worker checkin-missed reaper uses observed tmux session_activity,
 * not elapsed-since-started_at alone. Same gate as B12's AC17 timeout pass.
 * Synthetic/fake only. HELM_SESSION_JANITOR stays 0. No live tmux/reap.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { WorkerService } from './services/worker-service.js';

// role_capabilities.checkin_ms for 'implementer' is seeded at 180000 (schema.ts) — real value, no schema change.
const CHECKIN_MS = 180_000;
// Large enough that started_at (~10min old) never satisfies AC17's own age-candidate cutoff,
// so the timeout pass cannot confound this test (inverse of B12's checkin_ms-null isolation trick).
const TIMEOUT_MS = 24 * 60 * 60 * 1000;

describe.sequential('B13 worker checkin-missed activity gate (AC18 amended)', () => {
  let db: DatabaseService;
  let tmpDb: string;
  let projectId: number;
  let projDir: string;

  beforeEach(() => {
    tmpDb = path.join(os.tmpdir(), `helm-b13-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
    db = new DatabaseService(tmpDb);
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b13-proj-'));
    const projects = new ProjectService(db);
    const proj = projects.createProject({ name: 'b13-test', directory: projDir });
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
   * Role 'implementer' has a real seeded checkin_ms (180000) so the checkin-missed pass
   * is the only pass that can fire. started_at is ~10min old: past checkin_ms, but nowhere
   * near TIMEOUT_MS, so AC17's age-candidate query never selects this row.
   */
  function insertRecentlyLaunched(session: string): number {
    const info = db.raw
      .prepare(
        `INSERT INTO worker_runtimes (project_id, role, provider, model, session, correlation_id, state, spawned_by, started_at)
         VALUES (?,?,?,?,?,?,'running','b13-test', datetime('now', '-10 minutes'))`
      )
      .run(projectId, 'implementer', 'anthropic', 'claude-sonnet-5', session, `b13-corr-${session}`);
    return Number(info.lastInsertRowid);
  }

  function makeWorker(sessionActivity: number | null) {
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

  it('checkin_ms elapsed + recent tmux activity → survives checkin-missed', async () => {
    const session = 'helm-b13-recent-act';
    const id = insertRecentlyLaunched(session);
    // Activity 30s ago — well under CHECKIN_MS.
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

  it('checkin_ms elapsed + UNKNOWN activity → survives (keep-biased)', async () => {
    const session = 'helm-b13-unknown-act';
    const id = insertRecentlyLaunched(session);
    const { worker, terminateSession } = makeWorker(null);

    await (worker as any)._reapTick(TIMEOUT_MS);

    const row = db.raw
      .prepare('SELECT state, exit_reason, ended_at FROM worker_runtimes WHERE id = ?')
      .get(id) as any;
    expect(row.state).toBe('running');
    expect(row.ended_at).toBeNull();
    expect(terminateSession).not.toHaveBeenCalled();
  });

  it('checkin_ms elapsed + known stale activity → one checkin-missed reap', async () => {
    const session = 'helm-b13-stale-act';
    const id = insertRecentlyLaunched(session);
    // Activity older than CHECKIN_MS.
    const staleSec = Math.floor((Date.now() - (CHECKIN_MS + 120_000)) / 1000);
    const { worker, terminateSession, events } = makeWorker(staleSec);

    await (worker as any)._reapTick(TIMEOUT_MS);

    const row = db.raw
      .prepare('SELECT state, exit_reason, ended_at FROM worker_runtimes WHERE id = ?')
      .get(id) as any;
    // State-machine (worker-service.ts:316): only 'timeout' terminalizes as 'failed';
    // checkin-missed is a 'reaped' terminal, same as explicit/shutdown reap.
    expect(row.state).toBe('reaped');
    expect(row.exit_reason).toBe('checkin-missed');
    expect(row.ended_at).toBeTruthy();
    expect(terminateSession).toHaveBeenCalledTimes(1);
    expect(terminateSession.mock.calls[0][0]).toBe(session);
    expect(events.recordEvent).toHaveBeenCalled();

    // Idempotent: second tick does not re-terminate.
    await (worker as any)._reapTick(TIMEOUT_MS);
    expect(terminateSession).toHaveBeenCalledTimes(1);
  });
});
