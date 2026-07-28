/**
 * S18a/S18b — housekeeper investigation dispatch/apply path.
 * Synthetic DB + fake tmux/transport only. HELM_SESSION_JANITOR stays 0.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION } from './db/schema.js';
import { SessionRegistryService } from './services/session-registry-service.js';
import {
  HousekeeperService,
  HOUSEKEEPER_APPLY_ERROR_EVIDENCE_NOT_IN_ENVELOPE,
  HOUSEKEEPER_ENVELOPE_MAX_CHARS,
  HOUSEKEEPER_PANE_TAIL_MAX_CHARS,
} from './services/housekeeper-service.js';
import { HouseUsageSelector } from './services/house-usage-selector.js';
import { UsageGatewayService } from './services/usage-gateway-service.js';
import { FakeTransport } from './services/fake-transport.js';
import type { UsageSnapshot } from './services/usage-provider-client.js';
import { AgentAssignmentService, assertProjectRunDispatchable } from './services/agent-assignment-service.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_PANE_FIXTURE = path.join(REPO_ROOT, 'src/test-fixtures/panes/discovery-finished-turn-20260727.txt');
const HOUSEKEEPER_SRC = path.join(REPO_ROOT, 'src/services/housekeeper-service.ts');
const INDEX_SRC = path.join(REPO_ROOT, 'src/index.ts');

/** Plausible prose that does not appear as terminal-support in non-terminal seeds. */
const FABRICATED_DONE_EVIDENCE =
  'pane showed completed prompt and no active generation; fabricated clean shutdown observed';

/**
 * Redteam fix1 probe: real task-key atom + fabricated completion while envelope is WORKING.
 */
const REDTEAM_FABRICATED_COMPLETION_EVIDENCE =
  'S18a completed successfully; no active generation observed; all work is done and the seat can be marked idle. This is intentionally fabricated because the persisted envelope only says WORKING and INTERVIEWING.';

/**
 * Redteam fix2 probe: names current S18a + generic status:done borrowed from older S17 terminal row.
 */
const REDTEAM_CROSS_TASK_REPLAY_EVIDENCE =
  'S18a completed successfully; the current task is done and the active session can be marked idle. Persisted evidence says status: done.';

/**
 * Evidence citing terminal-support phrases present in terminal seed facts (status: done / complete).
 * Must bind identity + terminal phrase for the same task (AC14 fix2).
 */
const CITING_DONE_EVIDENCE =
  'callback STATUS: DONE for S18a; task housekeeper facts status: complete';

function tempDbPath(prefix: string): { dbPath: string; cleanupFiles: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, `helm-test-${process.pid}.db`);
  return {
    dbPath,
    cleanupFiles: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

function snap(rungs: UsageSnapshot['rungs']): UsageSnapshot {
  return { ts: 1, stale: false, ok: 1, errors: [], rungs };
}

describe('S18a/S18b housekeeper dispatch/apply', () => {
  let db: DatabaseService;
  let cleanup: () => void;
  let reg: SessionRegistryService;
  let transport: FakeTransport;
  let tmux: {
    captures: string[];
    activity: Map<string, number | null>;
    attached: Map<string, boolean | null>;
    sessionActivity: (name: string) => Promise<number | null>;
    sessionAttached: (name: string) => Promise<boolean | null>;
    capturePane: (name: string) => Promise<string>;
    terminateCalls: string[];
    terminateSession: (name: string) => Promise<void>;
  };

  function seedSession(name: string, opts: { owner?: string | null; status?: string; runId?: number | null; ageHours?: number } = {}) {
    const ageHours = opts.ageHours ?? 8;
    db.prepare(
      `INSERT INTO helm_sessions (name, kind, project_id, run_id, owner, status, created_at, last_used_at)
       VALUES (?, 'worker', 1, ?, ?, ?, datetime('now', ?), datetime('now', ?))`
    ).run(
      name,
      opts.runId ?? null,
      opts.owner === undefined ? 'helm' : opts.owner,
      opts.status ?? 'active',
      `-${ageHours} hours`,
      `-${ageHours} hours`,
    );
    tmux.activity.set(name, Math.floor((Date.now() - ageHours * 60 * 60 * 1000) / 1000));
    tmux.attached.set(name, false);
  }

  function seedRunFacts(
    opts: { taskKey?: string; label?: string; batch?: string; terminal?: boolean } = {},
  ): number {
    const taskKey = opts.taskKey ?? 'S18a';
    const label = opts.label ?? 'housekeeper facts';
    const batch = opts.batch ?? 'S18a';
    const terminal = opts.terminal === true;
    // run_tasks.status CHECK: pending|working|complete|failed|deferred
    const taskStatus = terminal ? 'complete' : 'working';
    const callbackState = terminal ? 'DONE' : 'WORKING';
    const callbackLine = terminal
      ? `[helm callback] impl ${taskKey} STATUS: DONE`
      : `[helm callback] impl ${taskKey} STATUS: WORKING`;
    const run = db.prepare(`INSERT INTO runs (project_id, status, phase) VALUES (NULL, 'active', 'executing')`).run();
    const runId = Number(run.lastInsertRowid);
    const task = db.prepare(
      `INSERT INTO run_tasks (run_id, task_key, label, batch, status, attempts_count)
       VALUES (?, ?, ?, ?, ?, 1)`
    ).run(runId, taskKey, label, batch, taskStatus);
    const attempt = db.prepare(
      `INSERT INTO task_attempts (task_id, attempt_num, status) VALUES (?, 1, ?)`
    ).run(Number(task.lastInsertRowid), terminal ? 'complete' : 'working');
    const dispatch = db.prepare(
      `INSERT INTO dispatches (attempt_id, role, brief_path, transport_handle)
       VALUES (?, 'implementer', ?, 'fake-worker')`
    ).run(Number(attempt.lastInsertRowid), `prompts/${taskKey}.md`);
    db.prepare(
      `INSERT INTO callbacks (dispatch_id, role, state, raw_line, source)
       VALUES (?, 'implementer', ?, ?, 'file')`
    ).run(Number(dispatch.lastInsertRowid), callbackState, callbackLine);
    return runId;
  }

  /** Older S17 complete/DONE + latest S18a working/WORKING on the same run (R2 mixed history). */
  function seedMixedHistoryRun(): number {
    const run = db.prepare(`INSERT INTO runs (project_id, status, phase) VALUES (NULL, 'active', 'executing')`).run();
    const runId = Number(run.lastInsertRowid);

    const insertTask = (opts: {
      taskKey: string;
      label: string;
      batch: string;
      taskStatus: string;
      attemptStatus: string;
      callbackState: string;
      callbackLine: string;
    }) => {
      const task = db.prepare(
        `INSERT INTO run_tasks (run_id, task_key, label, batch, status, attempts_count)
         VALUES (?, ?, ?, ?, ?, 1)`
      ).run(runId, opts.taskKey, opts.label, opts.batch, opts.taskStatus);
      const attempt = db.prepare(
        `INSERT INTO task_attempts (task_id, attempt_num, status) VALUES (?, 1, ?)`
      ).run(Number(task.lastInsertRowid), opts.attemptStatus);
      const dispatch = db.prepare(
        `INSERT INTO dispatches (attempt_id, role, brief_path, transport_handle)
         VALUES (?, 'implementer', ?, 'fake-worker')`
      ).run(Number(attempt.lastInsertRowid), `prompts/${opts.taskKey}.md`);
      db.prepare(
        `INSERT INTO callbacks (dispatch_id, role, state, raw_line, source)
         VALUES (?, 'implementer', ?, ?, 'file')`
      ).run(Number(dispatch.lastInsertRowid), opts.callbackState, opts.callbackLine);
    };

    // Older terminal history first (lower id), then current working task (higher id / ORDER BY id DESC).
    insertTask({
      taskKey: 'S17',
      label: 'prior-batch-complete',
      batch: 'S17',
      taskStatus: 'complete',
      attemptStatus: 'complete',
      callbackState: 'DONE',
      callbackLine: '[helm callback] impl S17 STATUS: DONE',
    });
    insertTask({
      taskKey: 'S18a',
      label: 'housekeeper facts',
      batch: 'S18a',
      taskStatus: 'working',
      attemptStatus: 'working',
      callbackState: 'WORKING',
      callbackLine: '[helm callback] impl S18a STATUS: WORKING',
    });
    return runId;
  }

  function oversizeRunFacts(runId: number) {
    const hugeCallback = `callback-${'C'.repeat(12000)}`;
    const hugeTask = `task-${'T'.repeat(12000)}`;
    const hugeDispatch = `dispatch-${'D'.repeat(12000)}`;
    db.prepare(`UPDATE run_tasks SET label = ? WHERE run_id = ?`).run(hugeTask, runId);
    db.prepare(
      `UPDATE callbacks
       SET raw_line = ?
       WHERE dispatch_id IN (
         SELECT d.id
         FROM dispatches d
         JOIN task_attempts ta ON ta.id = d.attempt_id
         JOIN run_tasks rt ON rt.id = ta.task_id
         WHERE rt.run_id = ?
       )`
    ).run(hugeCallback, runId);
    db.prepare(
      `UPDATE dispatches
       SET brief_path = ?, transport_handle = ?
       WHERE attempt_id IN (
         SELECT ta.id
         FROM task_attempts ta
         JOIN run_tasks rt ON rt.id = ta.task_id
         WHERE rt.run_id = ?
       )`
    ).run(hugeDispatch, hugeDispatch, runId);
  }

  function makeService(usage: UsageSnapshot) {
    const selector = new HouseUsageSelector({
      gateway: new UsageGatewayService({ fetcher: async () => usage, cacheTtlMs: 0 }),
    });
    return new HousekeeperService(db, reg, tmux, selector, transport);
  }

  beforeEach(() => {
    process.env.HELM_SESSION_JANITOR = '0';
    process.env.USE_FAKE_TMUX = '1';
    const t = tempDbPath('helm-s18a-');
    db = new DatabaseService(t.dbPath);
    cleanup = () => {
      try {
        db.close();
      } catch {}
      t.cleanupFiles();
    };
    reg = new SessionRegistryService(db);
    transport = new FakeTransport();
    const pane = fs.readFileSync(REAL_PANE_FIXTURE, 'utf8');
    tmux = {
      captures: [],
      activity: new Map(),
      attached: new Map(),
      terminateCalls: [],
      sessionActivity: async (name: string) => tmux.activity.get(name) ?? null,
      sessionAttached: async (name: string) => tmux.attached.get(name) ?? null,
      capturePane: async (name: string) => {
        tmux.captures.push(name);
        return pane;
      },
      terminateSession: async (name: string) => {
        tmux.terminateCalls.push(name);
      },
    };
  });

  afterEach(() => cleanup());

  it('fresh DB has v105 investigation/apply table', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(105); // pin removed (bumps with each phase, e.g. B01 -> 106)
    const cols = db.raw.prepare(`PRAGMA table_info(housekeeper_investigations)`).all().map((c: any) => c.name);
    expect(cols).toContain('session_name');
    expect(cols).toContain('envelope_json');
    expect(cols).toContain('selected_reason');
    expect(cols).toContain('state_signature');
    expect(cols).toContain('callback_verdict');
    expect(cols).toContain('callback_evidence');
    expect(cols).toContain('callback_rationale');
    expect(cols).toContain('applied_at');
    expect(cols).toContain('apply_error');
  });

  it('v103→v105 upgrade adds investigation/apply table', () => {
    cleanup();
    const t = tempDbPath('helm-s18a-upgrade-');
    try {
      const raw = new Database(t.dbPath);
      raw.exec(`
        CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
        INSERT INTO schema_version (version) VALUES (103);
        CREATE TABLE helm_sessions (
          id INTEGER PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          kind TEXT,
          project_id INTEGER,
          run_id INTEGER,
          owner TEXT CHECK(owner IS NULL OR owner IN ('helm','human','legacy:unknown')),
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','idle','reaped')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT,
          ended_at TEXT,
          reason TEXT
        );
      `);
      raw.close();
      const migrated = new DatabaseService(t.dbPath);
      expect((migrated.raw.prepare(`SELECT version FROM schema_version`).get() as any).version).toBe(SCHEMA_VERSION);
      expect(
        migrated.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='housekeeper_investigations'`).get()
      ).toBeTruthy();
      const cols = migrated.raw.prepare(`PRAGMA table_info(housekeeper_investigations)`).all().map((c: any) => c.name);
      expect(cols).toContain('callback_verdict');
      migrated.close();
    } finally {
      t.cleanupFiles();
    }
  });

  it('owner=helm active SQL candidates only; dispatches one bounded envelope and persists rung/reason before fake spawn', async () => {
    const runId = seedRunFacts();
    seedSession('helm-human-chat', { owner: 'human' });
    seedSession('helm-legacy-seat', { owner: 'legacy:unknown' });
    seedSession('helm-null-seat', { owner: null });
    seedSession('helm-idle-seat', { owner: 'helm', status: 'idle' });
    seedSession('helm-w-target', { owner: 'helm', status: 'active', runId });

    const svc = makeService(
      snap({
        grok45: { headroom: 0, depleted: true, worst_bucket: 99 },
        spark: { headroom: 42, depleted: false, worst_bucket: 58 },
        haiku: { headroom: 50, depleted: false, worst_bucket: 50 },
      })
    );
    const result = await svc.dispatchOnce({
      nowMs: Date.now(),
      paneTailProvenance: 'fixture src/test-fixtures/panes/discovery-finished-turn-20260727.txt; captured from a real agent turn on 2026-07-27',
    });
    expect(result.outcome).toBe('dispatched');
    if (result.outcome !== 'dispatched') return;

    expect(tmux.captures).toEqual(['helm-w-target']);
    expect(transport.spawnCalls).toHaveLength(1);
    const spawn = transport.spawnCalls[0]!;
    expect(spawn.role).toBe('housekeeper');
    expect(spawn.provider).toBe('codex');
    expect(spawn.model).toBe('gpt-5.3-codex-spark');
    expect(spawn.rung).toBe(1);
    expect(spawn.brief.length).toBeLessThan(HOUSEKEEPER_ENVELOPE_MAX_CHARS + 500);
    expect(spawn.brief).toContain('housekeeper-investigation');
    expect(spawn.brief).toContain('do not repair status');

    const inv = svc.getInvestigation(result.investigationId);
    expect(inv.session_name).toBe('helm-w-target');
    expect(inv.status).toBe('dispatched');
    expect(inv.dispatch_handle).toBe(result.handle);
    expect(inv.selected_slug).toBe('spark');
    expect(inv.selected_reason).toBe('backup1_after_depleted_main');
    expect(inv.state_signature).toContain('helm-w-target');
    expect(inv.pane_tail.length).toBeLessThanOrEqual(HOUSEKEEPER_PANE_TAIL_MAX_CHARS);
    const envelope = JSON.parse(inv.envelope_json);
    expect(envelope.session.owner).toBe('helm');
    expect(envelope.session.status).toBe('active');
    expect(envelope.probe).toMatchObject({
      pane_capture: 'ok',
      pane_capture_error: null,
      facts_obtainable: true,
      facts_present: true,
    });
    expect(envelope.run_facts).toHaveLength(1);
    expect(envelope.task_facts).toHaveLength(1);
    expect(envelope.callback_facts).toHaveLength(1);
    expect(envelope.last_dispatch.role).toBe('implementer');
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(HOUSEKEEPER_ENVELOPE_MAX_CHARS);

    for (const name of ['helm-human-chat', 'helm-legacy-seat', 'helm-null-seat', 'helm-idle-seat']) {
      expect(svc.listInvestigations().some((r) => r.session_name === name)).toBe(false);
      expect(reg.get(name)?.status).toBe(name === 'helm-idle-seat' ? 'idle' : 'active');
    }
    expect(tmux.terminateCalls).toEqual([]);
    expect(transport.reapCalls).toEqual([]);
    expect(reg.get('helm-w-target')!.status).toBe('active');
  });

  it('bounds oversized callback, task, and dispatch evidence before persist and fake spawn', async () => {
    const runId = seedRunFacts();
    oversizeRunFacts(runId);
    seedSession('helm-w-huge-evidence', { owner: 'helm', status: 'active', runId });
    tmux.capturePane = async (name: string) => {
      tmux.captures.push(name);
      return 'tiny pane';
    };

    const svc = makeService(
      snap({
        grok45: { headroom: 0, depleted: true, worst_bucket: 99 },
        spark: { headroom: 42, depleted: false, worst_bucket: 58 },
        haiku: { headroom: 50, depleted: false, worst_bucket: 50 },
      })
    );
    const result = await svc.dispatchOnce({ nowMs: Date.now() });
    expect(result.outcome).toBe('dispatched');
    if (result.outcome !== 'dispatched') return;

    const inv = svc.getInvestigation(result.investigationId);
    const envelope = JSON.parse(inv.envelope_json);
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(HOUSEKEEPER_ENVELOPE_MAX_CHARS);
    expect(inv.envelope_json.length).toBeLessThanOrEqual(HOUSEKEEPER_ENVELOPE_MAX_CHARS);
    expect(transport.spawnCalls).toHaveLength(1);
    expect(transport.spawnCalls[0]!.brief.length).toBeLessThan(HOUSEKEEPER_ENVELOPE_MAX_CHARS + 500);
    expect(JSON.stringify(envelope.callback_facts)).not.toContain('C'.repeat(1000));
    expect(JSON.stringify(envelope.task_facts)).not.toContain('T'.repeat(1000));
    expect(JSON.stringify(envelope.last_dispatch)).not.toContain('D'.repeat(1000));
    expect(tmux.terminateCalls).toEqual([]);
    expect(transport.reapCalls).toEqual([]);
    expect(reg.get('helm-w-huge-evidence')!.status).toBe('active');
  });

  it('usage no_dispatch is durable and does not spawn', async () => {
    seedSession('helm-w-no-usage', { owner: 'helm', status: 'active' });
    const svc = makeService({ ts: 1, stale: true, ok: 0, errors: ['offline'], rungs: {} });
    const result = await svc.dispatchOnce({ nowMs: Date.now() });
    expect(result.outcome).toBe('no_dispatch');
    if (result.outcome !== 'no_dispatch') return;
    expect(transport.spawnCalls).toHaveLength(0);
    const inv = svc.getInvestigation(result.investigationId);
    expect(inv.status).toBe('no_dispatch');
    expect(inv.selected_provider).toBeNull();
    expect(JSON.parse(inv.usage_json).reason).toBe('stale_usage');
  });

  it('project house-dispatch fence remains intact and housekeeper service source has no repair/reap calls', () => {
    const as = new AgentAssignmentService(db);
    const housekeeper = as.listAgents().find((a) => a.name === 'housekeeper')!;
    expect(housekeeper.kind).toBe('house');
    expect(() => assertProjectRunDispatchable(housekeeper)).toThrow(/house-kind agent cannot be dispatched/i);

    const src = fs.readFileSync(HOUSEKEEPER_SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of [
      'AgentAssignmentService',
      'assertProjectRunDispatchable',
      'resolveProjectRole',
      'markReaped',
      'terminateSession',
      'sessionJanitorTick',
      '.reap(',
    ]) {
      expect(src).not.toContain(forbidden);
    }
  });

  it('apply done persists evidence/rationale and only marks helm session idle; zero terminate/reap', async () => {
    const runId = seedRunFacts({ terminal: true });
    seedSession('helm-w-apply-done', { owner: 'helm', status: 'active', runId });
    const svc = makeService(snap({ spark: { headroom: 42, depleted: false, worst_bucket: 58 } }));
    const dispatched = await svc.dispatchOnce({ nowMs: Date.now() });
    expect(dispatched.outcome).toBe('dispatched');
    if (dispatched.outcome !== 'dispatched') return;

    const envelope = JSON.parse(svc.getInvestigation(dispatched.investigationId).envelope_json);
    expect(envelope.probe).toMatchObject({
      pane_capture: 'ok',
      facts_obtainable: true,
      facts_present: true,
    });

    const applied = svc.applyCallback(dispatched.investigationId, {
      verdict: 'done',
      evidence: CITING_DONE_EVIDENCE,
      rationale: 'safe to mark idle only',
    });

    expect(applied).toMatchObject({ ok: true, outcome: 'applied_done' });
    const inv = svc.getInvestigation(dispatched.investigationId);
    expect(inv.status).toBe('applied_done');
    expect(inv.callback_verdict).toBe('done');
    expect(inv.callback_evidence).toContain('STATUS: DONE');
    expect(inv.callback_rationale).toContain('mark idle only');
    expect(reg.get('helm-w-apply-done')!.status).toBe('idle');
    expect(reg.get('helm-w-apply-done')!.reason).toBe('housekeeper-done');
    expect(tmux.terminateCalls).toEqual([]);
    expect(transport.reapCalls).toEqual([]);
  });

  it('apply done writes audit evidence before markIdle and fail-closes if audit write fails', async () => {
    const runId = seedRunFacts({ terminal: true });
    seedSession('helm-w-audit-first', { owner: 'helm', status: 'active', runId });
    const svc = makeService(snap({ spark: { headroom: 42, depleted: false, worst_bucket: 58 } }));
    const dispatched = await svc.dispatchOnce({ nowMs: Date.now() });
    expect(dispatched.outcome).toBe('dispatched');
    if (dispatched.outcome !== 'dispatched') return;

    db.exec(`
      CREATE TRIGGER force_housekeeper_audit_write_failure
      BEFORE UPDATE OF callback_verdict, callback_evidence, callback_rationale, status ON housekeeper_investigations
      WHEN NEW.id = ${dispatched.investigationId} AND NEW.status = 'applied_done'
      BEGIN
        SELECT RAISE(ABORT, 'forced audit write failure');
      END;
    `);

    expect(() => svc.applyCallback(dispatched.investigationId, {
      verdict: 'done',
      evidence: CITING_DONE_EVIDENCE,
      rationale: 'safe to mark idle only',
    })).toThrow(/forced audit write failure/);

    const inv = svc.getInvestigation(dispatched.investigationId);
    expect(inv.status).toBe('dispatched');
    expect(inv.callback_verdict).toBeNull();
    expect(inv.callback_evidence).toBeNull();
    expect(inv.callback_rationale).toBeNull();
    expect(reg.get('helm-w-audit-first')!.status).toBe('active');
    expect(tmux.terminateCalls).toEqual([]);
    expect(transport.reapCalls).toEqual([]);
  });

  it('apply done refuses empty evidence/rationale and does not mark idle', async () => {
    const runId = seedRunFacts();
    seedSession('helm-w-empty-proof', { owner: 'helm', status: 'active', runId });
    const svc = makeService(snap({ spark: { headroom: 42, depleted: false, worst_bucket: 58 } }));
    const dispatched = await svc.dispatchOnce({ nowMs: Date.now() });
    expect(dispatched.outcome).toBe('dispatched');
    if (dispatched.outcome !== 'dispatched') return;

    const rejected = svc.applyCallback(dispatched.investigationId, {
      verdict: 'done',
      evidence: '',
      rationale: '   ',
    });

    expect(rejected).toMatchObject({ ok: false, outcome: 'invalid_callback_proof' });
    const inv = svc.getInvestigation(dispatched.investigationId);
    expect(inv.status).toBe('dispatched');
    expect(inv.callback_verdict).toBeNull();
    expect(reg.get('helm-w-empty-proof')!.status).toBe('active');
    expect(tmux.terminateCalls).toEqual([]);
    expect(transport.reapCalls).toEqual([]);
  });

  it('apply done is terminal/idempotent and rejects conflicting later verdicts without another markIdle', async () => {
    const runId = seedRunFacts({ terminal: true });
    seedSession('helm-w-idempotent-done', { owner: 'helm', status: 'active', runId });
    const svc = makeService(snap({ spark: { headroom: 42, depleted: false, worst_bucket: 58 } }));
    const dispatched = await svc.dispatchOnce({ nowMs: Date.now() });
    expect(dispatched.outcome).toBe('dispatched');
    if (dispatched.outcome !== 'dispatched') return;

    const originalMarkIdle = reg.markIdle.bind(reg);
    let markIdleCalls = 0;
    reg.markIdle = ((token, reason?) => {
      markIdleCalls += 1;
      return originalMarkIdle(token, reason);
    }) as SessionRegistryService['markIdle'];

    const first = svc.applyCallback(dispatched.investigationId, {
      verdict: 'done',
      evidence: CITING_DONE_EVIDENCE,
      rationale: 'safe to mark idle only',
    });
    const duplicate = svc.applyCallback(dispatched.investigationId, {
      verdict: 'done',
      evidence: 'different duplicate evidence must not overwrite terminal audit',
      rationale: 'different duplicate rationale must not call mark idle again',
    });
    const conflict = svc.applyCallback(dispatched.investigationId, {
      verdict: 'needs-human',
      evidence: 'conflicting later callback',
      rationale: 'must not overwrite applied done',
    });

    expect(first).toMatchObject({ ok: true, outcome: 'applied_done' });
    expect(duplicate).toMatchObject({ ok: true, outcome: 'applied_done' });
    expect(conflict).toMatchObject({ ok: false, outcome: 'terminal_conflict' });
    expect(markIdleCalls).toBe(1);
    const inv = svc.getInvestigation(dispatched.investigationId);
    expect(inv.status).toBe('applied_done');
    expect(inv.callback_verdict).toBe('done');
    expect(inv.callback_evidence).toBe(CITING_DONE_EVIDENCE);
    expect(inv.callback_rationale).toBe('safe to mark idle only');
    expect(reg.get('helm-w-idempotent-done')!.status).toBe('idle');
    expect(tmux.terminateCalls).toEqual([]);
    expect(transport.reapCalls).toEqual([]);
  });

  it('apply needs-human persists uncertainty without marking idle', async () => {
    seedSession('helm-w-needs-human', { owner: 'helm', status: 'active' });
    const svc = makeService(snap({ spark: { headroom: 42, depleted: false, worst_bucket: 58 } }));
    const dispatched = await svc.dispatchOnce({ nowMs: Date.now() });
    expect(dispatched.outcome).toBe('dispatched');
    if (dispatched.outcome !== 'dispatched') return;

    const applied = svc.applyCallback(dispatched.investigationId, {
      verdict: 'needs-human',
      evidence: 'uncertain because pane has a waiting prompt',
      rationale: 'operator must decide',
    });

    expect(applied).toMatchObject({ ok: true, outcome: 'needs_human' });
    const inv = svc.getInvestigation(dispatched.investigationId);
    expect(inv.status).toBe('needs_human');
    expect(inv.callback_verdict).toBe('needs-human');
    expect(reg.get('helm-w-needs-human')!.status).toBe('active');
    expect(tmux.terminateCalls).toEqual([]);
    expect(transport.reapCalls).toEqual([]);
  });

  it('B10 AC13/AC15: capture throw + done with non-empty prose is rejected; session stays active', async () => {
    const runId = seedRunFacts();
    seedSession('helm-w-capture-throw', { owner: 'helm', status: 'active', runId });
    tmux.capturePane = async (name: string) => {
      tmux.captures.push(name);
      throw new Error('forced capturePane failure for B10');
    };
    const svc = makeService(snap({ spark: { headroom: 42, depleted: false, worst_bucket: 58 } }));
    const dispatched = await svc.dispatchOnce({ nowMs: Date.now() });
    expect(dispatched.outcome).toBe('dispatched');
    if (dispatched.outcome !== 'dispatched') return;

    const invBefore = svc.getInvestigation(dispatched.investigationId);
    const envelope = JSON.parse(invBefore.envelope_json);
    expect(envelope.probe.pane_capture).toBe('failed');
    expect(String(envelope.probe.pane_capture_error || '')).toMatch(/forced capturePane failure/);
    expect(envelope.pane_tail).toBe('');

    const rejected = svc.applyCallback(dispatched.investigationId, {
      verdict: 'done',
      evidence: 'pane showed completed prompt and no active generation',
      rationale: 'plausible prose must not override failed probe',
    });

    expect(rejected).toMatchObject({
      ok: false,
      outcome: 'invalid_callback_proof',
    });
    expect(String((rejected as any).error || '')).toMatch(/probe insufficient/i);
    const inv = svc.getInvestigation(dispatched.investigationId);
    expect(inv.status).toBe('dispatched');
    expect(inv.callback_verdict).toBeNull();
    expect(reg.get('helm-w-capture-throw')!.status).toBe('active');
    expect(tmux.terminateCalls).toEqual([]);
    expect(transport.reapCalls).toEqual([]);
  });

  it('B10 AC13: null run_id ⇒ empty/unobtainable facts ⇒ done ineligible', async () => {
    seedSession('helm-w-null-run', { owner: 'helm', status: 'active', runId: null });
    const svc = makeService(snap({ spark: { headroom: 42, depleted: false, worst_bucket: 58 } }));
    const dispatched = await svc.dispatchOnce({ nowMs: Date.now() });
    expect(dispatched.outcome).toBe('dispatched');
    if (dispatched.outcome !== 'dispatched') return;

    const envelope = JSON.parse(svc.getInvestigation(dispatched.investigationId).envelope_json);
    expect(envelope.session.run_id).toBeNull();
    expect(envelope.probe).toMatchObject({
      pane_capture: 'ok',
      facts_obtainable: false,
      facts_present: false,
    });
    expect(envelope.run_facts).toEqual([]);
    expect(envelope.task_facts).toEqual([]);
    expect(envelope.callback_facts).toEqual([]);

    const rejected = svc.applyCallback(dispatched.investigationId, {
      verdict: 'done',
      evidence: 'pane showed completed prompt and no active generation',
      rationale: 'null run_id must not allow done',
    });

    expect(rejected).toMatchObject({ ok: false, outcome: 'invalid_callback_proof' });
    expect(String((rejected as any).error || '')).toMatch(/probe insufficient/i);
    const inv = svc.getInvestigation(dispatched.investigationId);
    expect(inv.status).toBe('dispatched');
    expect(inv.callback_verdict).toBeNull();
    expect(reg.get('helm-w-null-run')!.status).toBe('active');
    expect(tmux.terminateCalls).toEqual([]);
    expect(transport.reapCalls).toEqual([]);
  });

  it('B10 AC13: needs-human still accepted under insufficient probe (capture throw)', async () => {
    seedSession('helm-w-probe-needs-human', { owner: 'helm', status: 'active', runId: null });
    tmux.capturePane = async (name: string) => {
      tmux.captures.push(name);
      throw new Error('forced capture throw under needs-human path');
    };
    const svc = makeService(snap({ spark: { headroom: 42, depleted: false, worst_bucket: 58 } }));
    const dispatched = await svc.dispatchOnce({ nowMs: Date.now() });
    expect(dispatched.outcome).toBe('dispatched');
    if (dispatched.outcome !== 'dispatched') return;

    const envelope = JSON.parse(svc.getInvestigation(dispatched.investigationId).envelope_json);
    expect(envelope.probe.pane_capture).toBe('failed');
    expect(envelope.probe.facts_obtainable).toBe(false);

    const applied = svc.applyCallback(dispatched.investigationId, {
      verdict: 'needs-human',
      evidence: 'capture failed and no run facts; operator must decide',
      rationale: 'insufficient probe keeps as needs-human',
    });

    expect(applied).toMatchObject({ ok: true, outcome: 'needs_human' });
    const inv = svc.getInvestigation(dispatched.investigationId);
    expect(inv.status).toBe('needs_human');
    expect(inv.callback_verdict).toBe('needs-human');
    expect(reg.get('helm-w-probe-needs-human')!.status).toBe('active');
    expect(tmux.terminateCalls).toEqual([]);
    expect(transport.reapCalls).toEqual([]);
  });

  it('apply rejects uncertainty/other verdicts and re-checks owner=helm before markIdle', async () => {
    const runId = seedRunFacts({ terminal: true });
    seedSession('helm-w-owner-flip', { owner: 'helm', status: 'active', runId });
    const svc = makeService(snap({ spark: { headroom: 42, depleted: false, worst_bucket: 58 } }));
    const dispatched = await svc.dispatchOnce({ nowMs: Date.now() });
    expect(dispatched.outcome).toBe('dispatched');
    if (dispatched.outcome !== 'dispatched') return;

    expect(svc.applyCallback(dispatched.investigationId, {
      verdict: 'uncertain',
      evidence: 'not enough',
      rationale: 'should be needs-human',
    })).toMatchObject({ ok: false, outcome: 'invalid_verdict' });

    db.prepare(`UPDATE helm_sessions SET owner = 'human' WHERE name = ?`).run('helm-w-owner-flip');
    const rejected = svc.applyCallback(dispatched.investigationId, {
      verdict: 'done',
      evidence: CITING_DONE_EVIDENCE,
      rationale: 'must not mark idle',
    });

    expect(rejected).toMatchObject({ ok: false, outcome: 'owner_recheck_failed', owner: 'human' });
    const inv = svc.getInvestigation(dispatched.investigationId);
    expect(inv.status).toBe('apply_rejected');
    expect(inv.callback_verdict).toBe('done');
    expect(reg.get('helm-w-owner-flip')!.status).toBe('active');
    expect(tmux.terminateCalls).toEqual([]);
    expect(transport.reapCalls).toEqual([]);
  });

  it('B10b AC14: done whose evidence cites nothing in stored envelope is rejected with typed apply_error', async () => {
    const runId = seedRunFacts();
    seedSession('helm-w-b10b-empty-cite', { owner: 'helm', status: 'active', runId });
    const svc = makeService(snap({ spark: { headroom: 42, depleted: false, worst_bucket: 58 } }));
    const dispatched = await svc.dispatchOnce({ nowMs: Date.now() });
    expect(dispatched.outcome).toBe('dispatched');
    if (dispatched.outcome !== 'dispatched') return;

    const envelope = JSON.parse(svc.getInvestigation(dispatched.investigationId).envelope_json);
    expect(envelope.probe).toMatchObject({
      pane_capture: 'ok',
      facts_obtainable: true,
      facts_present: true,
    });
    expect(String(envelope.pane_tail || '')).toContain('INTERVIEWING');
    expect(FABRICATED_DONE_EVIDENCE.toLowerCase()).not.toContain('interviewing');
    expect(FABRICATED_DONE_EVIDENCE.toLowerCase()).not.toContain('housekeeper facts');

    const rejected = svc.applyCallback(dispatched.investigationId, {
      verdict: 'done',
      evidence: FABRICATED_DONE_EVIDENCE,
      rationale: 'plausible prose must not pass without envelope citation',
    });

    expect(rejected).toMatchObject({ ok: false, outcome: 'invalid_callback_proof' });
    expect(String((rejected as any).error || '')).toContain(HOUSEKEEPER_APPLY_ERROR_EVIDENCE_NOT_IN_ENVELOPE);
    const inv = svc.getInvestigation(dispatched.investigationId);
    expect(inv.status).toBe('apply_rejected');
    expect(inv.apply_error).toBe(HOUSEKEEPER_APPLY_ERROR_EVIDENCE_NOT_IN_ENVELOPE);
    expect(inv.callback_verdict).toBe('done');
    expect(inv.callback_evidence).toBe(FABRICATED_DONE_EVIDENCE);
    expect(reg.get('helm-w-b10b-empty-cite')!.status).toBe('active');
    expect(tmux.terminateCalls).toEqual([]);
    expect(transport.reapCalls).toEqual([]);
  });

  it('B10b AC14: evidence citing real terminal envelope facts is accepted', async () => {
    const runId = seedRunFacts({ terminal: true });
    seedSession('helm-w-b10b-real-cite', { owner: 'helm', status: 'active', runId });
    const svc = makeService(snap({ spark: { headroom: 42, depleted: false, worst_bucket: 58 } }));
    const dispatched = await svc.dispatchOnce({ nowMs: Date.now() });
    expect(dispatched.outcome).toBe('dispatched');
    if (dispatched.outcome !== 'dispatched') return;

    const envelope = JSON.parse(svc.getInvestigation(dispatched.investigationId).envelope_json);
    expect(envelope.pane_tail).toContain('INTERVIEWING');
    expect(JSON.stringify(envelope.callback_facts)).toMatch(/STATUS: DONE/i);
    expect(JSON.stringify(envelope.task_facts)).toContain('complete');
    expect(fs.existsSync(REAL_PANE_FIXTURE)).toBe(true);

    const applied = svc.applyCallback(dispatched.investigationId, {
      verdict: 'done',
      evidence: CITING_DONE_EVIDENCE,
      rationale: 'evidence grounded in terminal facts of persisted envelope',
    });

    expect(applied).toMatchObject({ ok: true, outcome: 'applied_done' });
    const inv = svc.getInvestigation(dispatched.investigationId);
    expect(inv.status).toBe('applied_done');
    expect(inv.apply_error).toBeNull();
    expect(inv.callback_evidence).toBe(CITING_DONE_EVIDENCE);
    expect(reg.get('helm-w-b10b-real-cite')!.status).toBe('idle');
    expect(tmux.terminateCalls).toEqual([]);
    expect(transport.reapCalls).toEqual([]);
  });

  it('B10b AC14 fix1: WORKING envelope rejects fabricated completion that only cites real task key', async () => {
    // Redteam CRITICAL: any-atom path accepted "S18a completed…" while envelope said WORKING.
    const runId = seedRunFacts(); // non-terminal: WORKING + working task
    seedSession('helm-w-b10b-redteam-any-atom', { owner: 'helm', status: 'active', runId });
    const svc = makeService(snap({ spark: { headroom: 42, depleted: false, worst_bucket: 58 } }));
    const dispatched = await svc.dispatchOnce({ nowMs: Date.now() });
    expect(dispatched.outcome).toBe('dispatched');
    if (dispatched.outcome !== 'dispatched') return;

    const envelope = JSON.parse(svc.getInvestigation(dispatched.investigationId).envelope_json);
    expect(envelope.pane_tail).toContain('INTERVIEWING');
    expect(JSON.stringify(envelope.callback_facts)).toMatch(/STATUS: WORKING/i);
    expect(JSON.stringify(envelope.callback_facts)).not.toMatch(/STATUS: DONE/i);
    expect(JSON.stringify(envelope.task_facts)).toContain('working');
    expect(REDTEAM_FABRICATED_COMPLETION_EVIDENCE).toContain('S18a');
    expect(REDTEAM_FABRICATED_COMPLETION_EVIDENCE.toLowerCase()).toMatch(/completed|done/);

    const rejected = svc.applyCallback(dispatched.investigationId, {
      verdict: 'done',
      evidence: REDTEAM_FABRICATED_COMPLETION_EVIDENCE,
      rationale: 'fabricated completion must not free-ride on real task key',
    });

    expect(rejected).toMatchObject({ ok: false, outcome: 'invalid_callback_proof' });
    expect(String((rejected as any).error || '')).toContain(HOUSEKEEPER_APPLY_ERROR_EVIDENCE_NOT_IN_ENVELOPE);
    const inv = svc.getInvestigation(dispatched.investigationId);
    expect(inv.status).toBe('apply_rejected');
    expect(inv.apply_error).toBe(HOUSEKEEPER_APPLY_ERROR_EVIDENCE_NOT_IN_ENVELOPE);
    expect(inv.callback_evidence).toBe(REDTEAM_FABRICATED_COMPLETION_EVIDENCE);
    expect(reg.get('helm-w-b10b-redteam-any-atom')!.status).toBe('active');
    expect(tmux.terminateCalls).toEqual([]);
    expect(transport.reapCalls).toEqual([]);
  });

  it('B10b AC14 fix2: mixed S17 DONE + S18a WORKING rejects S18a claim replaying status:done', async () => {
    // Redteam R2 CRITICAL: global status:done from older S17 authenticated fabricated S18a completion.
    const runId = seedMixedHistoryRun();
    seedSession('helm-w-b10b-cross-task', { owner: 'helm', status: 'active', runId });
    const svc = makeService(snap({ spark: { headroom: 42, depleted: false, worst_bucket: 58 } }));
    const dispatched = await svc.dispatchOnce({ nowMs: Date.now() });
    expect(dispatched.outcome).toBe('dispatched');
    if (dispatched.outcome !== 'dispatched') return;

    const envelope = JSON.parse(svc.getInvestigation(dispatched.investigationId).envelope_json);
    expect(envelope.pane_tail).toContain('INTERVIEWING');
    expect(JSON.stringify(envelope.task_facts)).toContain('S17');
    expect(JSON.stringify(envelope.task_facts)).toContain('S18a');
    expect(JSON.stringify(envelope.callback_facts)).toMatch(/STATUS: DONE/i);
    expect(JSON.stringify(envelope.callback_facts)).toMatch(/STATUS: WORKING/i);
    // Callback facts carry task identity for unit binding.
    expect(JSON.stringify(envelope.callback_facts)).toMatch(/task_key/i);
    expect(REDTEAM_CROSS_TASK_REPLAY_EVIDENCE).toContain('S18a');
    expect(REDTEAM_CROSS_TASK_REPLAY_EVIDENCE.toLowerCase()).toContain('status: done');
    expect(REDTEAM_CROSS_TASK_REPLAY_EVIDENCE).not.toContain('S17');

    const rejected = svc.applyCallback(dispatched.investigationId, {
      verdict: 'done',
      evidence: REDTEAM_CROSS_TASK_REPLAY_EVIDENCE,
      rationale: 'must not replay older task terminal atoms onto current working task',
    });

    expect(rejected).toMatchObject({ ok: false, outcome: 'invalid_callback_proof' });
    expect(String((rejected as any).error || '')).toContain(HOUSEKEEPER_APPLY_ERROR_EVIDENCE_NOT_IN_ENVELOPE);
    const inv = svc.getInvestigation(dispatched.investigationId);
    expect(inv.status).toBe('apply_rejected');
    expect(inv.apply_error).toBe(HOUSEKEEPER_APPLY_ERROR_EVIDENCE_NOT_IN_ENVELOPE);
    expect(inv.callback_evidence).toBe(REDTEAM_CROSS_TASK_REPLAY_EVIDENCE);
    expect(reg.get('helm-w-b10b-cross-task')!.status).toBe('active');
    expect(tmux.terminateCalls).toEqual([]);
    expect(transport.reapCalls).toEqual([]);
  });

  it('B10b AC14: fabricated-but-plausible evidence for envelope holding different facts is rejected', async () => {
    // Envelope holds alternate terminal facts; claim cites default S18a identity + free-text completion.
    const runId = seedRunFacts({
      taskKey: 'B99-alt',
      label: 'alternate-envelope-task-label',
      batch: 'B99',
      terminal: true,
    });
    seedSession('helm-w-b10b-wrong-facts', { owner: 'helm', status: 'active', runId });
    const svc = makeService(snap({ spark: { headroom: 42, depleted: false, worst_bucket: 58 } }));
    const dispatched = await svc.dispatchOnce({ nowMs: Date.now() });
    expect(dispatched.outcome).toBe('dispatched');
    if (dispatched.outcome !== 'dispatched') return;

    const envelope = JSON.parse(svc.getInvestigation(dispatched.investigationId).envelope_json);
    expect(JSON.stringify(envelope.task_facts)).toContain('alternate-envelope-task-label');
    expect(JSON.stringify(envelope.task_facts)).not.toContain('housekeeper facts');
    expect(JSON.stringify(envelope.task_facts)).not.toContain('S18a');
    expect(JSON.stringify(envelope.callback_facts)).toMatch(/STATUS: DONE/i);

    // Identity from another universe + completion English — does not quote status: done / raw_line.
    const wrongFactsEvidence =
      'task housekeeper facts for S18a finished; pane showed completed prompt and no active generation';

    const rejected = svc.applyCallback(dispatched.investigationId, {
      verdict: 'done',
      evidence: wrongFactsEvidence,
      rationale: 'claim cites facts from a different investigation envelope',
    });

    expect(rejected).toMatchObject({ ok: false, outcome: 'invalid_callback_proof' });
    expect(String((rejected as any).error || '')).toContain(HOUSEKEEPER_APPLY_ERROR_EVIDENCE_NOT_IN_ENVELOPE);
    const inv = svc.getInvestigation(dispatched.investigationId);
    expect(inv.status).toBe('apply_rejected');
    expect(inv.apply_error).toBe(HOUSEKEEPER_APPLY_ERROR_EVIDENCE_NOT_IN_ENVELOPE);
    expect(reg.get('helm-w-b10b-wrong-facts')!.status).toBe('active');
    expect(tmux.terminateCalls).toEqual([]);
    expect(transport.reapCalls).toEqual([]);
  });

  it('cooldown allows one investigation per seat per unchanged state, then redispatches after state change', async () => {
    seedSession('helm-w-cooldown', { owner: 'helm', status: 'active', ageHours: 9 });
    const svc = makeService(snap({ spark: { headroom: 42, depleted: false, worst_bucket: 58 } }));

    const first = await svc.dispatchOnce({ nowMs: Date.now(), investigationCooldownMs: 60 * 60 * 1000 });
    expect(first.outcome).toBe('dispatched');
    const second = await svc.dispatchOnce({ nowMs: Date.now(), investigationCooldownMs: 60 * 60 * 1000 });
    expect(second).toMatchObject({ outcome: 'no_candidate' });

    db.prepare(`UPDATE helm_sessions SET last_used_at = datetime('now', '-10 hours') WHERE name = ?`).run('helm-w-cooldown');
    const third = await svc.dispatchOnce({ nowMs: Date.now(), investigationCooldownMs: 60 * 60 * 1000 });
    expect(third.outcome).toBe('dispatched');
    expect(svc.listInvestigations().filter((r) => r.session_name === 'helm-w-cooldown')).toHaveLength(2);
    expect(tmux.terminateCalls).toEqual([]);
    expect(transport.reapCalls).toEqual([]);
  });

  it('S18a production wiring uses a housekeeper-only no-op transport, never shared RealTransport', () => {
    const src = fs.readFileSync(INDEX_SRC, 'utf8');
    const housekeeperWiring = src.slice(src.indexOf('const housekeeperService = new HousekeeperService('), src.indexOf('const planningPhase ='));
    const noopClass = src.slice(src.indexOf('class HousekeeperNoopTransport implements ITransport'), src.indexOf('const __filename'));
    expect(src).toContain('class HousekeeperNoopTransport implements ITransport');
    expect(housekeeperWiring).toContain('new HousekeeperNoopTransport()');
    expect(housekeeperWiring).not.toContain('orchT');
    expect(noopClass).toContain('spawn(');
    expect(noopClass).not.toContain('terminateSession');
  });
});
