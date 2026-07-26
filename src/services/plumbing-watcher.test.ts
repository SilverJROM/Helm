import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { DatabaseService } from "../db/database.js";
import { AgentEventsService } from "./agent-events-service.js";
import { TmuxService } from "../tmux/tmux-service.js";
import { MasterRuntimeService } from "./master-runtime-service.js";
import { PlumbingWatcherService, WatchReason } from "./plumbing-watcher-service.js";
import { SCHEMA_VERSION } from "../db/schema.js";

// Minimal fake tmux for classification control in tests
class FakeTmuxForWatcher {
  sessionExists = async (_s: string) => true;
  getPanePid = async (_t: string): Promise<string | null> => "12345";
  capturePane = async (_t: string, _l = 60) => "❯ ready\n";
  // test controls
  setDead() { this.getPanePid = async () => null; this.sessionExists = async () => false; }
  setConfirm() { this.capturePane = async () => "Would you like to run this? (y/n)"; }
  setAliveNoConfirm() { this.getPanePid = async () => "12345"; this.capturePane = async () => "Working on task..."; }
}

function makeTempDb(): { svc: DatabaseService; path: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plumb-test-"));
  const p = path.join(dir, "test.db");
  const svc = new DatabaseService(p);
  return { svc, path: p, cleanup: () => { try { svc.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

describe("PlumbingWatcherService (B3a per consensus)", () => {
  let db: DatabaseService;
  let events: AgentEventsService;
  let tmux: FakeTmuxForWatcher;
  let runtime: MasterRuntimeService; // minimal stub (we only use it for recovery side-effect via direct db in watcher)
  let watcher: PlumbingWatcherService;
  let cleanup: () => void;

  beforeEach(() => {
    const t = makeTempDb();
    db = t.svc;
    cleanup = t.cleanup;
    events = new AgentEventsService(db);
    tmux = new FakeTmuxForWatcher();
    // stub runtime (recovery is done via direct UPDATE in watcher + supervisor elsewhere)
    runtime = { /* not called directly in v1 recovery path we use */ } as any;
    watcher = new PlumbingWatcherService(db, events, tmux as any, runtime);
  });

  afterEach(() => {
    try { watcher.stopWatchLoop(); } catch {}
    cleanup();
  });

  it("watch_reason classification: hash-advance = ok_terminal (PRIMARY)", async () => {
    // seed a coordinator
    db.prepare("INSERT INTO master_runtimes (project_id, master_run_id, tmux_session, provider, model, state) VALUES (42, 'r1', 'helm-42', 'grok', 'grok-4.5', 'running')").run();
    // seed some events so first hash is non-empty
    events.recordEvent({ run_id: "master:42", role: "ibrain", batch_id: "master-42", type: "gate", state: "master-launched", source: "post", correlation_id: "c1", body: { task: "t0" } });

    await (watcher as any).forceTickForTest();
    let st = db.prepare("SELECT last_watch_reason FROM coordinator_watch_states WHERE project_id=42").get() as any;
    expect(st.last_watch_reason).toBe("ok_terminal");

    // advance hash by adding distinctive work event
    events.recordEvent({ run_id: "master:42", role: "ibrain", batch_id: "master-42", type: "status", state: "WORKING", source: "post", correlation_id: "c2", body: { task: "t1", progress: "50%" } });

    await (watcher as any).forceTickForTest();
    st = db.prepare("SELECT last_watch_reason, last_task_hash FROM coordinator_watch_states WHERE project_id=42").get() as any;
    expect(st.last_watch_reason).toBe("ok_terminal");
    expect(st.last_task_hash).toBeTruthy();
  });

  it("watch_reason: hash-stale + pane-alive (no dead) → progress_stall or checkin (hash wins)", async () => {
    db.prepare("INSERT INTO master_runtimes (project_id, master_run_id, tmux_session, provider, model, state) VALUES (7, 'r7', 'helm-7', 'codex', 'gpt-5.5', 'running')").run();
    // establish a hash
    events.recordEvent({ run_id: "master:7", role: "ibrain", batch_id: "master-7", type: "gate", state: "master-launched", source: "post", correlation_id: "c1", body: {} });
    await (watcher as any).forceTickForTest();

    // now force same hash (no new events that change canonical) + alive pane (default fake)
    // (no new events → hash same)
    await (watcher as any).forceTickForTest();
    const st = db.prepare("SELECT last_watch_reason FROM coordinator_watch_states WHERE project_id=7").get() as any;
    // since hash not advanced and no hard triggers, and pane alive → progress_stall (hb secondary never overrides stale hash)
    expect(["progress_stall", "checkin_due"]).toContain(st.last_watch_reason);
  });

  it("watch_reason: hash-stale + pane-dead → idle_no_callback + marks master failed for supervisor recovery", async () => {
    db.prepare("INSERT INTO master_runtimes (project_id, master_run_id, tmux_session, provider, model, state) VALUES (9, 'r9', 'helm-9', 'grok', 'grok-4.5', 'running')").run();
    events.recordEvent({ run_id: "master:9", role: "ibrain", batch_id: "master-9", type: "gate", state: "master-launched", source: "post", correlation_id: "c1", body: {} });
    await (watcher as any).forceTickForTest();

    // force dead pane + no hash advance
    (tmux as any).setDead();
    await (watcher as any).forceTickForTest();

    const st = db.prepare("SELECT last_watch_reason FROM coordinator_watch_states WHERE project_id=9").get() as any;
    expect(st.last_watch_reason).toBe("idle_no_callback");

    const m = db.prepare("SELECT state FROM master_runtimes WHERE project_id=9").get() as any;
    expect(m.state).toBe("failed"); // recovery hook
  });

  it("heartbeat NEVER beats a stale work-hash (secondary only)", async () => {
    db.prepare("INSERT INTO master_runtimes (project_id, master_run_id, tmux_session, provider, model, state) VALUES (11, 'r11', 'helm-11', 'codex', 'gpt-5.5', 'running')").run();
    // initial
    events.recordEvent({ run_id: "master:11", role: "ibrain", batch_id: "master-11", type: "status", state: "WORKING", source: "post", correlation_id: "c1", body: { task: "base" } });
    await (watcher as any).forceTickForTest();

    // force same hash scenario (NO new events since prior tick → computeWorkHash returns identical value = stale work-hash)
    // yet prior events are recent enough for hasRecentHeartbeat=true. Set alive pane.
    // Result must NOT be ok_terminal: heartbeat NEVER beats a stale work-hash (PRIMARY hash wins; hb secondary/warning only).
    (tmux as any).setAliveNoConfirm();
    await (watcher as any).forceTickForTest();

    const st = db.prepare("SELECT last_watch_reason FROM coordinator_watch_states WHERE project_id=11").get() as any;
    // must NOT be treated as fully alive/ok just because hb; hash is what matters for progress
    expect(st.last_watch_reason).not.toBe("ok_terminal"); // heartbeat does not beat stale hash
  });

  it("self-config bounded validation + JROM override wins", () => {
    // out of range rejected
    expect(() => watcher.setSelfConfig(99, "plancore", { poll_ms: 1 })).toThrow(/out of bounds/);
    expect(() => watcher.setSelfConfig(99, "plancore", { context_watermark_pct: 200 })).toThrow(/out of bounds/);

    // valid self
    watcher.setSelfConfig(99, "plancore", { poll_ms: 45000, refresh_every_tasks: 5 });
    let eff = watcher.getEffectiveConfig(99);
    expect(eff.poll_ms).toBe(45000);
    expect(eff.refresh_every_tasks).toBe(5);

    // JROM wins
    watcher.setJromOverride(99, { poll_ms: 10000, context_watermark_pct: 75 });
    eff = watcher.getEffectiveConfig(99);
    expect(eff.poll_ms).toBe(10000); // JROM
    expect(eff.context_watermark_pct).toBe(75);
    expect(eff.refresh_every_tasks).toBe(5); // self preserved where not overridden
    expect(watcher.getEffectiveConfig(99, 'ibrain').poll_ms).toBe(10000); // shared Helm PM override
  });

  it("dedupe/backoff: repeated identical stall emits ONE escalation (no spam)", async () => {
    db.prepare("INSERT INTO master_runtimes (project_id, master_run_id, tmux_session, provider, model, state) VALUES (5, 'r5', 'helm-5', 'grok', 'grok-4.5', 'running')").run();
    // make a stable stale-hash scenario
    events.recordEvent({ run_id: "master:5", role: "ibrain", batch_id: "master-5", type: "gate", state: "master-launched", source: "post", correlation_id: "c0", body: {} });
    await (watcher as any).forceTickForTest();

    (tmux as any).setDead(); // will cause idle_no_callback (escalation reason)

    // first tick → one event
    await (watcher as any).forceTickForTest();
    let evs = events.listByBatch("plumbing-5");
    const firstCount = evs.filter((e: any) => e.state === "idle_no_callback").length;
    expect(firstCount).toBe(1);

    // immediate repeat (same reason) → deduped, no additional
    await (watcher as any).forceTickForTest();
    evs = events.listByBatch("plumbing-5");
    const secondCount = evs.filter((e: any) => e.state === "idle_no_callback").length;
    expect(secondCount).toBe(1); // still one
  });

  it("v8->v11 (and any prior) migration on COPY of live data/helm.db preserves all existing rows + adds 3 tables (no loss)", () => {
    const src = "data/helm.db";
    if (!fs.existsSync(src)) {
      // fallback: at least prove fresh + additive on a temp that starts empty
      const t = makeTempDb();
      const v = t.svc.prepare("SELECT version FROM schema_version").get() as { version: number };
      expect(v.version).toBe(SCHEMA_VERSION);
      const hasTables = t.svc.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'plumbing_%'").all() as any[];
      expect(hasTables.length).toBe(3);
      t.cleanup();
      return;
    }

    // T2: consistent readonly snapshot (never copy/unlink/modify live data/helm.db or its wal/shm).
    // Use VACUUM INTO on readonly open of live for clean, consistent dump (no WAL loss, no live touch).
    const dst = `/tmp/helm-v11-live-snap-${Date.now()}.db`;
    const live = require("better-sqlite3")(src, { readonly: true });
    live.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`);
    live.close();

    // before counts via raw (whatever version the live snapshot is at, typically v8 in this env)
    const raw = require("better-sqlite3")(dst);
    const beforeAgents = (raw.prepare("SELECT COUNT(*) as c FROM agents").get() as any).c;
    const beforeMaster = (raw.prepare("SELECT COUNT(*) as c FROM master_runtimes").get() as any).c;
    const beforeEvents = (raw.prepare("SELECT COUNT(*) as c FROM agent_events").get() as any).c;
    const beforeWorkers = (raw.prepare("SELECT COUNT(*) as c FROM worker_runtimes").get() as any).c;
    raw.close();

    // trigger full mig by opening with current DatabaseService (v26)
    const svc = new DatabaseService(dst);
    const ver = svc.prepare("SELECT version FROM schema_version").get() as { version: number };
    expect(ver.version).toBe(SCHEMA_VERSION);

    const tables = (svc.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r: any) => r.name);
    expect(tables).toContain("plumbing_configs");
    expect(tables).toContain("coordinator_watch_states");
    expect(tables).toContain("plumbing_checkpoint_log");

    const afterAgents = (svc.prepare("SELECT COUNT(*) as c FROM agents").get() as any).c;
    const afterMaster = (svc.prepare("SELECT COUNT(*) as c FROM master_runtimes").get() as any).c;
    const afterEvents = (svc.prepare("SELECT COUNT(*) as c FROM agent_events").get() as any).c;
    const afterWorkers = (svc.prepare("SELECT COUNT(*) as c FROM worker_runtimes").get() as any).c;

    // D2 stubs gone; B09b may prune non-canonical agents (floor = 9 canonical).
    const afterStubAgents = (svc.prepare("SELECT COUNT(*) as c FROM agents WHERE name IN ('grok-4.5','grok-composer','spark','codex-5.4')").get() as any).c;
    expect(afterStubAgents).toBe(0);
    expect(afterAgents).toBeLessThanOrEqual(beforeAgents + 7);
    expect(afterAgents).toBeGreaterThanOrEqual(9);
    expect(afterMaster).toBe(beforeMaster);
    expect(afterEvents).toBe(beforeEvents);
    expect(afterWorkers).toBe(beforeWorkers);

    svc.close();
  });

  it("Context Steward checkpoint-gating (corrected): mid-task signal from gate/DONE events sets refresh_due (no log yet, defer); safe boundary (DONE+gate) → log + rules-refresh event + reset due/tasks", async () => {
    const pid = 77;
    db.prepare("INSERT INTO master_runtimes (project_id, master_run_id, tmux_session, provider, model, state, last_launched_at) VALUES (?, 'r77', 'helm-77', 'grok', 'grok-4.5', 'running', datetime('now'))").run(pid);
    // baseline event so count starts
    events.recordEvent({ run_id: "master:77", role: "ibrain", batch_id: "master-77", type: "gate", state: "master-launched", source: "post", correlation_id: "c0", body: {} });
    await (watcher as any).forceTickForTest();

    // simulate completed-task signals (gate-pass / DONE) — enough to >= default 10
    for (let i = 0; i < 12; i++) {
      events.recordEvent({ run_id: "master:77", role: "ibrain", batch_id: "master-77", type: "status", state: "DONE", source: "post", correlation_id: `done-${i}`, body: { task: i } });
    }
    await (watcher as any).forceTickForTest();

    let st = db.prepare("SELECT refresh_due, tasks_since_refresh FROM coordinator_watch_states WHERE project_id=?").get(pid) as any;
    expect(st.refresh_due).toBe(1);
    expect(st.tasks_since_refresh).toBeGreaterThanOrEqual(10);

    // no checkpoint logged yet (mid-task, defer)
    let logs = db.prepare("SELECT COUNT(*) as c FROM plumbing_checkpoint_log WHERE project_id=?").get(pid) as any;
    expect(logs.c).toBe(0);
    let refreshEvents = events.listByBatch(`plumbing-77`).filter((e: any) => e.state === 'rules-refresh');
    expect(refreshEvents.length).toBe(0);

    // now inject safe boundary (DONE + gate-pass pattern)
    events.recordEvent({ run_id: "master:77", role: "ibrain", batch_id: "master-77", type: "gate", state: "gate-pass", source: "post", correlation_id: "c-safe", body: { gate: "passed" } });
    await (watcher as any).forceTickForTest();

    logs = db.prepare("SELECT COUNT(*) as c FROM plumbing_checkpoint_log WHERE project_id=?").get(pid) as any;
    expect(logs.c).toBe(1);
    refreshEvents = events.listByBatch(`plumbing-77`).filter((e: any) => e.state === 'rules-refresh');
    expect(refreshEvents.length).toBeGreaterThan(0);
    expect(refreshEvents[0].body.action).toBe('rules-refresh');

    st = db.prepare("SELECT refresh_due, tasks_since_refresh FROM coordinator_watch_states WHERE project_id=?").get(pid) as any;
    expect(st.refresh_due).toBe(0);
    expect(st.tasks_since_refresh).toBe(0);
  });

  it("config GET/PUT round-trip + JROM override wins (via service + effective)", () => {
    watcher.setSelfConfig(88, 'plancore', { refresh_every_tasks: 7 });
    let eff = watcher.getEffectiveConfig(88);
    expect(eff.refresh_every_tasks).toBe(7);

    watcher.setJromOverride(88, { refresh_every_tasks: 3, brain_agent_id: 42 });
    eff = watcher.getEffectiveConfig(88);
    expect(eff.refresh_every_tasks).toBe(3); // JROM wins
    expect(eff.brain_agent_id).toBe(42);
  });
});
