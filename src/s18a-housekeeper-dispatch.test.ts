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
import { HousekeeperService, HOUSEKEEPER_ENVELOPE_MAX_CHARS, HOUSEKEEPER_PANE_TAIL_MAX_CHARS } from './services/housekeeper-service.js';
import { HouseUsageSelector } from './services/house-usage-selector.js';
import { UsageGatewayService } from './services/usage-gateway-service.js';
import { FakeTransport } from './services/fake-transport.js';
import type { UsageSnapshot } from './services/usage-provider-client.js';
import { AgentAssignmentService, assertProjectRunDispatchable } from './services/agent-assignment-service.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_PANE_FIXTURE = path.join(REPO_ROOT, 'src/test-fixtures/panes/discovery-finished-turn-20260727.txt');
const HOUSEKEEPER_SRC = path.join(REPO_ROOT, 'src/services/housekeeper-service.ts');
const INDEX_SRC = path.join(REPO_ROOT, 'src/index.ts');

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

  function seedRunFacts(): number {
    const run = db.prepare(`INSERT INTO runs (project_id, status, phase) VALUES (NULL, 'active', 'executing')`).run();
    const runId = Number(run.lastInsertRowid);
    const task = db.prepare(
      `INSERT INTO run_tasks (run_id, task_key, label, batch, status, attempts_count)
       VALUES (?, 'S18a', 'housekeeper facts', 'S18a', 'working', 1)`
    ).run(runId);
    const attempt = db.prepare(
      `INSERT INTO task_attempts (task_id, attempt_num, status) VALUES (?, 1, 'working')`
    ).run(Number(task.lastInsertRowid));
    const dispatch = db.prepare(
      `INSERT INTO dispatches (attempt_id, role, brief_path, transport_handle)
       VALUES (?, 'implementer', 'prompts/S18a.md', 'fake-worker')`
    ).run(Number(attempt.lastInsertRowid));
    db.prepare(
      `INSERT INTO callbacks (dispatch_id, role, state, raw_line, source)
       VALUES (?, 'implementer', 'WORKING', '[helm callback] impl S18a STATUS: WORKING', 'file')`
    ).run(Number(dispatch.lastInsertRowid));
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
    seedSession('helm-w-apply-done', { owner: 'helm', status: 'active' });
    const svc = makeService(snap({ spark: { headroom: 42, depleted: false, worst_bucket: 58 } }));
    const dispatched = await svc.dispatchOnce({ nowMs: Date.now() });
    expect(dispatched.outcome).toBe('dispatched');
    if (dispatched.outcome !== 'dispatched') return;

    const applied = svc.applyCallback(dispatched.investigationId, {
      verdict: 'done',
      evidence: 'pane showed completed prompt and no active generation',
      rationale: 'safe to mark idle only',
    });

    expect(applied).toMatchObject({ ok: true, outcome: 'applied_done' });
    const inv = svc.getInvestigation(dispatched.investigationId);
    expect(inv.status).toBe('applied_done');
    expect(inv.callback_verdict).toBe('done');
    expect(inv.callback_evidence).toContain('completed prompt');
    expect(inv.callback_rationale).toContain('mark idle only');
    expect(reg.get('helm-w-apply-done')!.status).toBe('idle');
    expect(reg.get('helm-w-apply-done')!.reason).toBe('housekeeper-done');
    expect(tmux.terminateCalls).toEqual([]);
    expect(transport.reapCalls).toEqual([]);
  });

  it('apply done writes audit evidence before markIdle and fail-closes if audit write fails', async () => {
    seedSession('helm-w-audit-first', { owner: 'helm', status: 'active' });
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
      evidence: 'pane showed completed prompt and no active generation',
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
    seedSession('helm-w-empty-proof', { owner: 'helm', status: 'active' });
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
    seedSession('helm-w-idempotent-done', { owner: 'helm', status: 'active' });
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
      evidence: 'pane showed completed prompt and no active generation',
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
    expect(inv.callback_evidence).toBe('pane showed completed prompt and no active generation');
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

  it('apply rejects uncertainty/other verdicts and re-checks owner=helm before markIdle', async () => {
    seedSession('helm-w-owner-flip', { owner: 'helm', status: 'active' });
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
      evidence: 'stale callback after owner changed',
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
