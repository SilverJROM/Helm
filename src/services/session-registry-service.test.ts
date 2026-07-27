import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from '../db/database.js';
import { SessionRegistryService, deriveSessionKind } from './session-registry-service.js';
import { WorkerService } from './worker-service.js';

function makeTempDb(): { db: DatabaseService; cleanup: () => void } {
  const dbPath = path.join(os.tmpdir(), `helm-slr-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new DatabaseService(dbPath);
  return {
    db,
    cleanup: () => {
      try { db.close(); } catch {}
      for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suf); } catch {} }
    }
  };
}

describe('SL-R1/R2 SessionRegistryService', () => {
  let db: DatabaseService;
  let cleanup: () => void;
  let reg: SessionRegistryService;

  beforeEach(() => {
    const t = makeTempDb();
    db = t.db;
    cleanup = t.cleanup;
    reg = new SessionRegistryService(db);
  });
  afterEach(() => cleanup());

  it('register-on-create sets status active + derives kind + list/get', () => {
    reg.register('helm-batch-A1-implementer-abc123');
    const row = reg.get('helm-batch-A1-implementer-abc123');
    expect(row).toBeTruthy();
    expect(row!.status).toBe('active');
    expect(row!.kind).toBe('implementer');
    expect(row!.created_at).toBeTruthy();
    expect(reg.list().length).toBe(1);
  });

  it('kind derivation covers canonical phase brains and treats retired names as other', () => {
    expect(deriveSessionKind('helm-plancore-cards')).toBe('plancore');
    expect(deriveSessionKind('helm-ibrain-cards')).toBe('ibrain');
    expect(deriveSessionKind('helm-discovery-cards')).toBe('discovery');
    expect(deriveSessionKind('helm-projcore-cards')).toBe('other');
    expect(deriveSessionKind('helm-pm-cards')).toBe('other');
    expect(deriveSessionKind('helm-p5b-test-xyz')).toBe('test');
    expect(deriveSessionKind('helm-w-cards-42')).toBe('worker');
    expect(deriveSessionKind('helm-batch-A1-validator-deadbe')).toBe('validator');
    expect(deriveSessionKind('helm-something-random')).toBe('other');
    // non-helm names still classify but the janitor never touches them (guardrail is name-prefix).
    expect(deriveSessionKind('03_impl_grokbuild_rscf')).toBe('other');
  });

  it('markIdle then markReaped transition (idle → reaped, ended_at set)', () => {
    reg.register('helm-w-cards-7');
    reg.markIdle('helm-w-cards-7', 'run-terminal');
    expect(reg.get('helm-w-cards-7')!.status).toBe('idle');
    reg.markReaped('helm-w-cards-7', 'janitor-ttl');
    const row = reg.get('helm-w-cards-7')!;
    expect(row.status).toBe('reaped');
    expect(row.ended_at).toBeTruthy();
    expect(row.reason).toBe('janitor-ttl');
  });

  it('register is last-wins (re-create resets a reaped row to active)', () => {
    reg.register('helm-w-cards-9');
    reg.markReaped('helm-w-cards-9');
    expect(reg.get('helm-w-cards-9')!.status).toBe('reaped');
    reg.register('helm-w-cards-9');
    const row = reg.get('helm-w-cards-9')!;
    expect(row.status).toBe('active');
    expect(row.ended_at).toBeNull();
    // still one row (UNIQUE name upsert)
    expect(reg.list().filter((r) => r.name === 'helm-w-cards-9').length).toBe(1);
  });

  it('enrich fills run_id / project_id / kind', () => {
    reg.register('helm-batch-A1-implementer-z');
    reg.enrich('helm-batch-A1-implementer-z', { runId: 55, projectId: 3 });
    const row = reg.get('helm-batch-A1-implementer-z')!;
    expect(row.run_id).toBe(55);
    expect(row.project_id).toBe(3);
  });

  // A2 (R4.16): planning seats must land in helm_sessions with both ids at register time
  // (the createSession choke point calls register with opts — this is the DB half of that contract).
  it('A2: register of a planning seat with projectId+runId stores both ids (not NULL)', () => {
    reg.register('helm-batch-A2-plancore-abc12', { projectId: 42, runId: 99, kind: 'plancore' });
    reg.register('helm-batch-A2-partner-def34', { projectId: 42, runId: 99, kind: 'deliberation' });
    const plancore = reg.get('helm-batch-A2-plancore-abc12')!;
    const partner = reg.get('helm-batch-A2-partner-def34')!;
    expect(plancore.project_id).toBe(42);
    expect(plancore.run_id).toBe(99);
    expect(plancore.kind).toBe('plancore');
    expect(plancore.status).toBe('active');
    expect(partner.project_id).toBe(42);
    expect(partner.run_id).toBe(99);
    expect(partner.kind).toBe('deliberation');
  });
});

// ---------------------------------------------------------------------------
// SL-R3/R4 janitor tests — spy tmux to assert terminate calls without real tmux.
// ---------------------------------------------------------------------------
describe('SL-R3/R4 session janitor (WorkerService.sessionJanitorTick)', () => {
  let db: DatabaseService;
  let cleanup: () => void;
  let reg: SessionRegistryService;
  let terminated: string[];
  let tmuxSpy: any;
  let ws: WorkerService;

  // Build a helm_sessions row with created_at/last_used_at offset by N seconds in the past.
  function seedSession(name: string, opts: { status?: string; runId?: number | null; ageSecs?: number } = {}) {
    const status = opts.status ?? 'active';
    const runId = opts.runId ?? null;
    const ageSecs = opts.ageSecs ?? 0;
    db.prepare(
      `INSERT INTO helm_sessions (name, kind, project_id, run_id, status, created_at, last_used_at)
       VALUES (?, 'test', 1, ?, ?, datetime('now', ?), datetime('now', ?))`
    ).run(name, runId, status, `-${ageSecs} seconds`, `-${ageSecs} seconds`);
  }

  function seedRun(status: string, phase: string): number {
    // project_id NULL (nullable FK) — the janitor only reads runs.status/phase, not the project.
    const info = db.prepare(
      `INSERT INTO runs (project_id, status, phase, started_at) VALUES (NULL, ?, ?, datetime('now'))`
    ).run(status, phase);
    return Number(info.lastInsertRowid);
  }

  function seedLiveWorker(session: string, runId: number | null) {
    db.prepare(
      `INSERT INTO worker_runtimes (project_id, role, provider, model, session, state, run_id, started_at)
       VALUES (1, 'implementer', 'grok', 'grok-4.5', ?, 'running', ?, datetime('now'))`
    ).run(session, runId);
  }

  beforeEach(() => {
    const t = makeTempDb();
    db = t.db;
    cleanup = t.cleanup;
    reg = new SessionRegistryService(db);
    terminated = [];
    tmuxSpy = {
      terminateSession: async (name: string) => { terminated.push(name); },
      // ST-R2: janitor gates its kill on this. Default TRUE so every pre-existing janitor test still reaps
      // exactly as before; individual tests override it to false to exercise the untagged/error fail-safe.
      sessionHasHelmChildTag: async (_name: string) => true,
    };
    // Only the janitor path is exercised — other WorkerService deps are unused here.
    ws = new WorkerService(db, {} as any, tmuxSpy as any, {} as any, {} as any, undefined, reg);
    // Force janitor on + a tiny TTL floor via env (default 20min; we age rows past it explicitly).
    delete process.env.HELM_SESSION_JANITOR;
    delete process.env.HELM_SESSION_TTL_MS;
  });
  afterEach(() => {
    cleanup();
    delete process.env.HELM_SESSION_JANITOR;
    delete process.env.HELM_SESSION_TTL_MS;
  });

  it('reaps a done (idle) + past-TTL registered helm- session (terminate called + status reaped)', async () => {
    // idle + aged 21min (past default 20min TTL) + no live worker.
    seedSession('helm-w-cards-1', { status: 'idle', ageSecs: 21 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toContain('helm-w-cards-1');
    expect(reg.get('helm-w-cards-1')!.status).toBe('reaped');
    expect(reg.get('helm-w-cards-1')!.reason).toBe('janitor-ttl');
  });

  it('reaps a session whose mapped run is terminal + past TTL', async () => {
    const runId = seedRun('complete', 'complete');
    seedSession('helm-batch-A1-implementer-x', { status: 'active', runId, ageSecs: 25 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toContain('helm-batch-A1-implementer-x');
    expect(reg.get('helm-batch-A1-implementer-x')!.status).toBe('reaped');
  });

  it('SKIPS a session whose mapped run is ACTIVE (never reap a running worker)', async () => {
    const runId = seedRun('active', 'executing');
    seedSession('helm-batch-A1-implementer-active', { status: 'active', runId, ageSecs: 30 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-batch-A1-implementer-active')!.status).toBe('active');
  });

  it('SKIPS a session with a LIVE worker_runtime even if idle + aged', async () => {
    seedSession('helm-w-cards-live', { status: 'idle', ageSecs: 30 * 60 });
    seedLiveWorker('helm-w-cards-live', null);
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-w-cards-live')!.status).toBe('idle');
  });

  it('SKIPS a within-TTL session (idle but too fresh)', async () => {
    seedSession('helm-w-cards-fresh', { status: 'idle', ageSecs: 60 }); // 1min < 20min
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-w-cards-fresh')!.status).toBe('idle');
  });

  it('NEVER terminates a non-helm-named session even if registered/idle/aged (SL-R4 prefix guard)', async () => {
    seedSession('03_impl_grokbuild_rscf', { status: 'idle', ageSecs: 60 * 60 });
    seedSession('01_impl_something', { status: 'idle', ageSecs: 60 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    // rows remain untouched (not reaped)
    expect(reg.get('03_impl_grokbuild_rscf')!.status).toBe('idle');
  });

  it('NEVER terminates an UNregistered session (janitor only iterates registry rows)', async () => {
    // A live tmux session exists (helm-orphan-live) but is NOT in helm_sessions → janitor cannot see it.
    seedSession('helm-w-cards-2', { status: 'idle', ageSecs: 25 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual(['helm-w-cards-2']); // only the registered one; the phantom is never a target
  });

  it('HELM_SESSION_JANITOR=0 disables the sweep entirely', async () => {
    process.env.HELM_SESSION_JANITOR = '0';
    seedSession('helm-w-cards-disabled', { status: 'idle', ageSecs: 30 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
  });

  it('startup sweep reaps a terminal-run orphan past TTL', async () => {
    const runId = seedRun('failed', 'failed');
    seedSession('helm-batch-A1-validator-orphan', { status: 'active', runId, ageSecs: 40 * 60 });
    await ws.sweepOrphanSessionsAtStartup();
    expect(terminated).toContain('helm-batch-A1-validator-orphan');
    expect(reg.get('helm-batch-A1-validator-orphan')!.status).toBe('reaped');
  });

  it('reaps a GENUINELY-IDLE orphan with NO run mapping (run_id null, last_used_at stale past TTL)', async () => {
    // The leaked-test-session case: no run, no live worker, no recent use → last_used_at is stale.
    // This is the primary cleanup goal and must still work.
    seedSession('helm-batch-A1-implementer-noRun', { status: 'active', runId: null, ageSecs: 25 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toContain('helm-batch-A1-implementer-noRun');
  });

  it('does NOT reap an IN-USE standalone session (active, run_id null, touched within TTL)', async () => {
    // Simulates an actively-used persistent planning session created long ago (past TTL).
    // but recently USED (touched). last_used_at is fresh → TTL means "idle for TTL" → kept alive.
    // Regression guard for the SL-R2/R4 over-reach the gate caught.
    seedSession('helm-plancore-cards', { status: 'active', runId: null, ageSecs: 60 * 60 }); // created 60min ago
    reg.touch('helm-plancore-cards'); // used just now → last_used_at = now
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-plancore-cards')!.status).toBe('active');
  });

  it('registry.touch refreshes last_used_at (and does not resurrect a reaped row)', () => {
    seedSession('helm-plancore-touch', { status: 'active', runId: null, ageSecs: 60 * 60 });
    const before = reg.get('helm-plancore-touch')!.last_used_at;
    reg.touch('helm-plancore-touch');
    const after = reg.get('helm-plancore-touch')!.last_used_at;
    expect(after).not.toBe(before);
    // last_used_at is now ~now (much fresher than the 60min-old created_at)
    const fresh = db.prepare(
      "SELECT (last_used_at > datetime('now', '-60 seconds')) AS ok FROM helm_sessions WHERE name = 'helm-plancore-touch'"
    ).get() as any;
    expect(fresh.ok).toBe(1);
    // touch is a no-op on a reaped row (never resurrect a closed session)
    reg.markReaped('helm-plancore-touch');
    reg.touch('helm-plancore-touch');
    expect(reg.get('helm-plancore-touch')!.status).toBe('reaped');
  });

  it('onUse via active-input send methods (sendAndSubmit/sendCommand/sendEnter/sendKeys) flows through to touch', async () => {
    // Assert the TmuxService active-input → onUse → touch wiring refreshes last_used_at. All of Helm's
    // active-input paths funnel through the private touchSession(target) helper, so exercising it with a
    // pane target (session:window.pane → bare session name) proves the exact call each send method makes.
    // (The real send methods shell out to tmux; touchSession is the pure, tmux-free unit under test.)
    const { TmuxService } = await import('../tmux/tmux-service.js');
    const tmux = new (TmuxService as any)();
    tmux.setRegistryHook({
      onCreate: (n: string) => reg.register(n),
      onTerminate: (n: string) => reg.markReaped(n),
      onUse: (n: string) => reg.touch(n),
    });

    // 1) chat/message submission path (sendAndSubmit) — THE important one.
    seedSession('helm-chat-onuse', { status: 'active', runId: null, ageSecs: 60 * 60 });
    const beforeChat = reg.get('helm-chat-onuse')!.last_used_at;
    (tmux as any).touchSession('helm-chat-onuse:0.0'); // exactly what sendAndSubmit fires
    expect(reg.get('helm-chat-onuse')!.last_used_at).not.toBe(beforeChat);
    // refreshed to ~now (much fresher than the 60min-old created_at)
    const fresh = db.prepare(
      "SELECT (last_used_at > datetime('now', '-60 seconds')) AS ok FROM helm_sessions WHERE name = 'helm-chat-onuse'"
    ).get() as any;
    expect(fresh.ok).toBe(1);

    // 2) the same helper is what sendCommand/sendEnter/sendKeys also call (bare-name extraction).
    seedSession('helm-cmd-onuse', { status: 'active', runId: null, ageSecs: 60 * 60 });
    const beforeCmd = reg.get('helm-cmd-onuse')!.last_used_at;
    (tmux as any).touchSession('helm-cmd-onuse'); // bare session target (no :window.pane)
    expect(reg.get('helm-cmd-onuse')!.last_used_at).not.toBe(beforeCmd);
  });

  it('an actively-CHATTING session (touched via sendAndSubmit path) survives past the creation TTL', async () => {
    // End-to-end of the iter-2 fix: a chat session created >TTL ago but kept in active use (each message
    // → sendAndSubmit → touch) is NOT reaped. Mirrors the in-use planning-session chat path.
    seedSession('helm-batch-A1-implementer-chat', { status: 'active', runId: null, ageSecs: 90 * 60 });
    reg.touch('helm-batch-A1-implementer-chat'); // a chat message just landed
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-batch-A1-implementer-chat')!.status).toBe('active');
  });

  // ---------------------------------------------------------------------------
  // ST-R2/R5 — @helm_child tag gate: the janitor kills ONLY Helm-tagged sessions.
  // ---------------------------------------------------------------------------
  it('ST-R2 CORE GUARD: a registry+helm-prefix+past-TTL+no-worker session MISSING @helm_child is NEVER reaped', async () => {
    // The exact fatal scenario: a session that passes EVERY legacy guard (registered, helm- prefixed,
    // idle, past TTL, no live worker, terminal/no run) but is NOT Helm-tagged (someone else's session, or
    // an untagged pre-existing one) must never be terminated. This is the regression guard for the
    // whole-tmux-server death.
    tmuxSpy.sessionHasHelmChildTag = async (_name: string) => false; // not Helm's → must be skipped
    seedSession('helm-w-cards-untagged', { status: 'idle', ageSecs: 30 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);                                  // NEVER killed
    expect(reg.get('helm-w-cards-untagged')!.status).toBe('idle');   // left intact (safe default: continue)
  });

  it('ST-R2 happy path: a fully-tagged idle + past-TTL session is STILL reaped', async () => {
    tmuxSpy.sessionHasHelmChildTag = async (_name: string) => true;  // Helm-tagged → reapable
    seedSession('helm-w-cards-tagged', { status: 'idle', ageSecs: 30 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toContain('helm-w-cards-tagged');
    expect(reg.get('helm-w-cards-tagged')!.status).toBe('reaped');
  });

  it('ST-R2 fail-safe: a tag probe that ERRORS is treated as untagged → session NOT reaped', async () => {
    // sessionHasHelmChildTag itself is fail-safe (returns false on tmux error), but assert the janitor
    // honours a false/throwing probe here too: uncertainty must never escalate to a kill.
    tmuxSpy.sessionHasHelmChildTag = async (_name: string) => { throw new Error('tmux show-options: no such session'); };
    seedSession('helm-w-cards-probeerr', { status: 'idle', ageSecs: 30 * 60 });
    await expect(ws.sessionJanitorTick()).resolves.toBeUndefined();   // tick does not blow up
    expect(terminated).toEqual([]);                                   // never killed on probe error
    expect(reg.get('helm-w-cards-probeerr')!.status).toBe('idle');
  });

  it('ST-R2 NO-SPILLOVER name-collision: an untagged session that merely SHARES a helm- name is never killed', async () => {
    // A user/other-tool session that happens to be named like a Helm session (helm-ish prefix) and got
    // into the registry: it is idle + past-TTL + no worker (would reap under legacy guards) but carries NO
    // @helm_child tag → the janitor must NOT terminate it. Name similarity can never be a kill trigger;
    // only the positive Helm-applied tag can.
    tmuxSpy.sessionHasHelmChildTag = async (name: string) =>
      name === 'helm-real-worker'; // ONLY the genuine Helm session is tagged
    seedSession('helm-real-worker', { status: 'idle', ageSecs: 30 * 60 });   // Helm's own → tagged
    seedSession('helm-user-lookalike', { status: 'idle', ageSecs: 30 * 60 }); // collision → untagged
    await ws.sessionJanitorTick();
    expect(terminated).toEqual(['helm-real-worker']);                 // ONLY the tagged one
    expect(terminated).not.toContain('helm-user-lookalike');          // the look-alike is safe
    expect(reg.get('helm-user-lookalike')!.status).toBe('idle');      // untouched
  });

  it('ST-R2 NO-SPILLOVER sanity: a session NOT in the registry is never even a candidate', async () => {
    // The loop only SELECTs helm_sessions rows, so a live tmux session absent from the registry can never
    // be evaluated — let alone killed — regardless of its name or tag. Belt-and-suspenders over the tag gate.
    tmuxSpy.sessionHasHelmChildTag = async (_name: string) => true;   // even if it WERE tagged...
    seedSession('helm-registered-tagged', { status: 'idle', ageSecs: 30 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual(['helm-registered-tagged']);           // only the registered row; nothing else
  });

});
