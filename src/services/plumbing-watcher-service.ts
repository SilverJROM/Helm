import { createHash } from "node:crypto";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";

import { DatabaseService } from "../db/database.js";
import { AgentEventsService, AgentEventInput } from "./agent-events-service.js";
import { TmuxService } from "../tmux/tmux-service.js";
import { MasterRuntimeService } from "./master-runtime-service.js";
import { loadConfig } from "../config/config.js";

export type WatchReason =
  | "ok_terminal"
  | "confirmation_stalled"
  | "checkin_due"
  | "hard_cap"
  | "progress_stall"
  | "idle_no_callback"
  | "terminal_human"
  | "handoff_result"
  | "protocol_invalid";

export interface EffectivePlumbingConfig {
  poll_ms: number;
  heartbeat_ttl_ms: number;
  refresh_every_tasks: number;
  context_watermark_pct: number;
  [k: string]: any;
}

interface CoordinatorWatchRow {
  project_id: number;
  state: string;
  last_task_hash: string | null;
  last_watch_reason: string | null;
  last_progress_at: string | null;
  current_task_id: string | null;
  tasks_since_refresh: number;
  refresh_due: number;
  dedupe_key: string | null;
  retry_count: number;
  next_wakeup_at: string | null;
}

export class PlumbingWatcherService {
  private watchInterval: NodeJS.Timeout | null = null;
  private watchInFlight = false;
  private readonly DEFAULT_POLL_MS = 30000;
  private backoff = new Map<number, { failures: number; nextRetryTs: number }>();
  private dedupe = new Map<string, number>(); // dedupe_key -> last escalation ts

  constructor(
    private readonly db: DatabaseService,
    private readonly events: AgentEventsService,
    private readonly tmux: TmuxService,
    private readonly runtime: MasterRuntimeService
  ) {}

  startWatchLoop(): void {
    if (this.watchInterval) return;
    this.watchInterval = setInterval(() => { void this.watchTick(); }, this.DEFAULT_POLL_MS);
  }

  stopWatchLoop(): void {
    if (!this.watchInterval) return;
    clearInterval(this.watchInterval);
    this.watchInterval = null;
  }

  // Public for routes / tests
  getEffectiveConfig(projectId: number, role = "plancore"): EffectivePlumbingConfig {
    const row = this.db
      .prepare("SELECT * FROM plumbing_configs WHERE project_id = ? AND role = ?")
      .get(projectId, role) as any;
    const base: EffectivePlumbingConfig = {
      poll_ms: 30000,
      heartbeat_ttl_ms: 120000,
      refresh_every_tasks: 10,
      context_watermark_pct: 80,
    };
    let eff: any = { ...base, ...(row || {}) };
    if (row && row.jrom_override_json) {
      try {
        const ov = JSON.parse(row.jrom_override_json);
        eff = { ...eff, ...ov };
      } catch {}
    }
    // Strict bounds (model cannot silence or set infinite)
    eff.poll_ms = Math.max(5000, Math.min(300000, Number(eff.poll_ms) || 30000));
    eff.heartbeat_ttl_ms = Math.max(10000, Math.min(600000, Number(eff.heartbeat_ttl_ms) || 120000));
    eff.refresh_every_tasks = Math.max(1, Math.min(100, Number(eff.refresh_every_tasks) || 10));
    eff.context_watermark_pct = Math.max(10, Math.min(90, Number(eff.context_watermark_pct) || 80));
    return eff as EffectivePlumbingConfig;
  }

  setSelfConfig(projectId: number, role: string, cfg: any): void {
    const eff = this.getEffectiveConfig(projectId, role); // start from current
    const next = { ...eff };
    if (cfg.poll_ms != null) {
      const v = Number(cfg.poll_ms);
      if (v < 5000 || v > 300000) throw new Error("poll_ms out of bounds (5000-300000)");
      next.poll_ms = v;
    }
    if (cfg.heartbeat_ttl_ms != null) {
      const v = Number(cfg.heartbeat_ttl_ms);
      if (v < 10000 || v > 600000) throw new Error("heartbeat_ttl_ms out of bounds (10000-600000)");
      next.heartbeat_ttl_ms = v;
    }
    if (cfg.refresh_every_tasks != null) {
      const v = Number(cfg.refresh_every_tasks);
      if (v < 1 || v > 100) throw new Error("refresh_every_tasks out of bounds (1-100)");
      next.refresh_every_tasks = v;
    }
    if (cfg.context_watermark_pct != null) {
      const v = Number(cfg.context_watermark_pct);
      if (v < 10 || v > 90) throw new Error("context_watermark_pct out of bounds (10-90)");
      next.context_watermark_pct = v;
    }
    // rate limit note: simple last-write window (batch-boundary intent in caller)
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO plumbing_configs
         (project_id, role, poll_ms, heartbeat_ttl_ms, refresh_every_tasks, context_watermark_pct, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(projectId, role, next.poll_ms, next.heartbeat_ttl_ms, next.refresh_every_tasks, next.context_watermark_pct, now);
  }

  setJromOverride(projectId: number, override: any): void {
    // JROM always wins; both phase brains share the same Helm PM face and override policy.
    const j = JSON.stringify(override || {});
    const write = this.db.prepare(
      `INSERT OR REPLACE INTO plumbing_configs (project_id, role, jrom_override_json, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(project_id, role) DO UPDATE SET jrom_override_json=excluded.jrom_override_json, updated_at=excluded.updated_at`
    );
    const applyBoth = this.db.raw.transaction(() => {
      for (const role of ['plancore', 'ibrain']) write.run(projectId, role, j);
    });
    applyBoth();
  }

  // B3b public for UI (configs GET now returns watchStates for real seeded table)
  listWatchStates(): any[] {
    return this.db
      .prepare("SELECT * FROM coordinator_watch_states ORDER BY project_id")
      .all();
  }

  // Core watch tick — reuses superviseTick pattern exactly (inFlight, tolerant, query master_runtimes coordinators, backoff, recovery)
  private async watchTick(): Promise<void> {
    if (this.watchInFlight) return;
    this.watchInFlight = true;
    try {
      const rows = this.db
        .prepare(
          "SELECT project_id, tmux_session, role, state, closed_reason FROM master_runtimes WHERE state IN ('running','parked','failed')"
        )
        .all() as Array<{ project_id: number; tmux_session: string; role?: string | null; state: string; closed_reason?: string | null }>;

      for (const row of rows) {
        const pid = row.project_id;
        // D-a2: skip auto-recovery classification for intentionally closed / run-complete phase brains (no respawn)
        if (row.closed_reason) continue;
        if (row.state === "parked" || row.state === "failed") {
          this.db
            .prepare("UPDATE OR IGNORE coordinator_watch_states SET state='closed', updated_at=datetime('now') WHERE project_id=?")
            .run(pid);
          continue;
        }

        const eff = this.getEffectiveConfig(pid, row.role === 'ibrain' ? 'ibrain' : 'plancore');
        const currHash = this.computeWorkHash(pid);
        const prev = this.db
          .prepare("SELECT * FROM coordinator_watch_states WHERE project_id = ?")
          .get(pid) as CoordinatorWatchRow | undefined;
        const lastHash = prev?.last_task_hash || "";
        const hashAdvanced = currHash !== lastHash;

        const hb = this.hasRecentHeartbeat(pid, eff.heartbeat_ttl_ms);
        const pane = await this.classifyPane(row.tmux_session);

        let reason: WatchReason = "ok_terminal";
        if (hashAdvanced) {
          // PRIMARY: hash advance = alive (even if pane quiet). Heartbeat never relevant here.
          reason = "ok_terminal";
        } else {
          // hash STALE — heartbeat NEVER beats a stale work-hash (per consensus + explicit req)
          if (pane.dead) {
            reason = "idle_no_callback";
            // mark failed so MasterRuntimeService supervisor recovers it
            this.db
              .prepare("UPDATE master_runtimes SET state='failed', intentional_park_until=NULL WHERE project_id=?")
              .run(pid);
          } else if (pane.confirm) {
            reason = "confirmation_stalled";
          } else if (this.isHardCapBreached(pid, eff)) {
            reason = "hard_cap";
          } else if (this.isCheckinDue(pid, eff)) {
            reason = "checkin_due";
            // E2: check-in enforcement tie-in: when checkin_due on stale hash, also mark any active run_task for project's latest run as failed (persisted observable)
            try {
              const latestRun = this.db.prepare("SELECT id FROM runs WHERE project_id=? ORDER BY id DESC LIMIT 1").get(pid) as any;
              if (latestRun && latestRun.id) {
                const t = this.db.prepare("SELECT id FROM run_tasks WHERE run_id=? AND status IN ('working','pending') ORDER BY id DESC LIMIT 1").get(latestRun.id) as any;
                if (t && t.id) {
                  this.db.prepare("UPDATE run_tasks SET status='failed', updated_at=datetime('now') WHERE id=?").run(t.id);
                }
              }
            } catch {}
          } else {
            // hb present or not: still stall because hash is stale. hb is secondary (warning only)
            reason = "progress_stall";
          }
        }

        // B3b: count ACTUAL completed-task signals (gate-pass / task-DONE events in agent_events since last checkpoint) — per APPROVED-PLAN correction. Tick != task.
        const completed = this.countCompletedTasksSinceLastRefresh(pid);
        let due = prev?.refresh_due || 0;
        if (completed >= eff.refresh_every_tasks) {
          due = 1; // mid-task trip: defer until safe boundary (no premature action)
        }

        // upsert live state row — full columns to preserve tasks_since_refresh / refresh_due / last_progress (B3a incomplete upsert fixed, in-scope)
        const lp = prev?.last_progress_at || new Date().toISOString();
        this.db
          .prepare(
            `INSERT OR REPLACE INTO coordinator_watch_states
             (project_id, state, last_task_hash, last_watch_reason, last_progress_at, current_task_id, tasks_since_refresh, refresh_due, dedupe_key, retry_count, next_wakeup_at, updated_at)
             VALUES (?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
          )
          .run(pid, currHash, reason, lp, null, completed, due, `${pid}:${reason}`, (prev?.retry_count || 0), null);

        // emit agent_events on meaningful transition (for SSE / B3b); dedupe + backoff + one-repair before escalation
        const dedupeKey = `${pid}:${reason}`;
        const now = Date.now();
        const bo = this.backoff.get(pid) || { failures: 0, nextRetryTs: 0 };
        if (now < bo.nextRetryTs && reason !== "ok_terminal") {
          // backoff active
        } else {
          const lastE = this.dedupe.get(dedupeKey) || 0;
          const isEscalation = this.isEscalationReason(reason);
          if (isEscalation && now - lastE > 5 * 60 * 1000) {
            // one escalation per dedupe window (no spam)
            const input: AgentEventInput = {
              run_id: `plumbing:${pid}`,
              role: "plumbing",
              batch_id: `plumbing-${pid}`,
              session: row.tmux_session ? `${row.tmux_session}:0.0` : null,
              type: "status",
              state: reason,
              source: "post",
              correlation_id: `plumbing:${pid}:${now}`,
              body: {
                project_id: pid,
                watch_reason: reason,
                hash: currHash,
                pane_class: pane,
                hb_present: hb,
                note: hashAdvanced ? "hash-advanced" : "hash-stale (hb does not override)"
              },
            };
            this.events.recordEvent(input);
            this.dedupe.set(dedupeKey, now);
            // simple backoff for repeated
            bo.failures = (bo.failures || 0) + 1;
            bo.nextRetryTs = now + Math.min(10 * 60 * 1000, 30000 * Math.pow(2, bo.failures));
            this.backoff.set(pid, bo);
          }
        }

        // Context Steward (consensus §2 + fix): acts ONLY at safe boundaries. Mid-task (due set above) defers — no premature action.
        if (due && this.hasSafeCheckpointBoundary(pid)) {
          this.actAtSafeCheckpoint(pid, reason, currHash);
        }
      }
    } catch (e: any) {
      if (!/not open|closed|database connection/i.test(String(e))) throw e;
    } finally {
      this.watchInFlight = false;
    }
  }

  private computeWorkHash(projectId: number): string {
    // Reuse overmind.sh state-diff concept over Helm-owned records + agent_events (current task/state/gate/ACK/batch markers)
    const master = this.db
      .prepare("SELECT state, core_sha, overlay_sha FROM master_runtimes WHERE project_id = ?")
      .get(projectId) as any;
    const masterEv = this.events.listByBatch(`master-${projectId}`).slice(-30);
    const chatEv = this.events.listByBatch(`chat-${projectId}`).slice(-20);
    const activeWorkers = this.db
      .prepare(
        "SELECT role, state, provider, model FROM worker_runtimes WHERE project_id = ? AND state IN ('launching','running')"
      )
      .all(projectId) as any[];

    const canonical = {
      m: master ? { s: master.state, sh: [master.core_sha, master.overlay_sha] } : null,
      me: masterEv.map((e: any) => ({ t: e.type, s: e.state, c: e.correlation_id })),
      ce: chatEv.map((e: any) => ({ t: e.type, s: e.state, c: e.correlation_id })),
      w: activeWorkers.map((w: any) => ({ r: w.role, s: w.state })),
    };
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  }

  private hasRecentHeartbeat(projectId: number, ttlMs: number): boolean {
    // Cooperative fast-path via recent agent_events (post/source activity on project batches). SECONDARY only.
    const cutoff = new Date(Date.now() - ttlMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT 1 FROM agent_events WHERE (batch_id = ? OR batch_id = ?) AND ts > ? LIMIT 1`
      )
      .get(`master-${projectId}`, `chat-${projectId}`, cutoff);
    return !!row;
  }

  private async classifyPane(session: string | null): Promise<{ dead: boolean; confirm: boolean; alive: boolean }> {
    if (!session) return { dead: true, confirm: false, alive: false };
    const sessAlive = await this.tmux.sessionExists(session);
    if (!sessAlive) return { dead: true, confirm: false, alive: false };
    const target = `${session}:0.0`;
    const pid = await this.tmux.getPanePid(target);
    const processPresent = !!pid && pid !== "0";
    const text = await this.tmux.capturePane(target, 60);
    const confirm = /Would you like to run|Press enter to confirm|Yes, proceed|Allow this command|Approve this action|y\/n\?/i.test(text);
    return { dead: !processPresent, confirm, alive: processPresent && !confirm };
  }

  private isEscalationReason(r: WatchReason): boolean {
    return ["idle_no_callback", "hard_cap", "checkin_due", "confirmation_stalled", "progress_stall", "protocol_invalid"].includes(r);
  }

  private isHardCapBreached(projectId: number, eff: EffectivePlumbingConfig): boolean {
    // v1: simple elapsed from last known progress or master launch (test seeds control it)
    const last = this.db
      .prepare("SELECT last_progress_at FROM coordinator_watch_states WHERE project_id=?")
      .get(projectId) as any;
    if (!last || !last.last_progress_at) {
      const m = this.db.prepare("SELECT last_launched_at FROM master_runtimes WHERE project_id=?").get(projectId) as any;
      if (!m || !m.last_launched_at) return false;
      const elapsedMin = (Date.now() - Date.parse(m.last_launched_at)) / 60000;
      return elapsedMin >= 240; // conservative hard cap default
    }
    const elapsedMin = (Date.now() - Date.parse(last.last_progress_at)) / 60000;
    return elapsedMin >= 240;
  }

  private isCheckinDue(projectId: number, eff: EffectivePlumbingConfig): boolean {
    const last = this.db
      .prepare("SELECT last_progress_at, tasks_since_refresh FROM coordinator_watch_states WHERE project_id=?")
      .get(projectId) as any;
    if (!last) return false;
    const tasks = last.tasks_since_refresh || 0;
    if (tasks >= eff.refresh_every_tasks) return true;
    if (last.last_progress_at) {
      const elapsed = (Date.now() - Date.parse(last.last_progress_at)) / 60000;
      return elapsed >= 90; // simple threshold for v1
    }
    return false;
  }

  // B3b Context Steward helpers (per consensus §2 + APPROVED-PLAN correction): tasks count from *actual* gate-pass/DONE events in the stream (since last checkpoint/last_progress), mid-task sets due (defer), act *only* at safe boundary (emit rules-refresh event + log + reset).
  private countCompletedTasksSinceLastRefresh(projectId: number): number {
    // Count actual gate-pass / task-DONE signals from the event stream (per APPROVED-PLAN + correction; "since last" via due reset on act).
    // Use listByBatch (same as rest of watcher) + filter for reliable visibility in tests (no ts/cutoff/sqlite second-precision issues).
    const masterEv = this.events.listByBatch(`master-${projectId}`);
    const chatEv = this.events.listByBatch(`chat-${projectId}`);
    const all = [...masterEv, ...chatEv];
    return all.filter((e: any) =>
      (e.type === 'status' && ['DONE', 'BLOCKED'].includes(e.state)) ||
      (e.type === 'gate' && /pass|switched|gate/i.test(e.state || ''))
    ).length;
  }

  private hasSafeCheckpointBoundary(projectId: number): boolean {
    const recent = this.events.listByBatch(`master-${projectId}`).slice(-8);
    const recentPlumb = this.events.listByBatch(`plumbing-${projectId}`).slice(-5);
    // Safe boundary requires explicit gate-pass / switched / ACK marker (per consensus "task done+gate-passed" / "after coordinator ACKs a worker terminal" / batch boundary).
    // Plain DONE/BLOCKED count as *task signals* for count (so mid-task high count can set due without acting).
    const hasTerminalGate = recent.some((e: any) =>
      (e.type === 'gate' && /pass|switched|gate-pass|launched|resume/i.test(e.state || ''))
    );
    const hasWorkerAck = recentPlumb.some((e: any) => /terminal|ACK|done|complete/i.test(e.state || ''));
    return hasTerminalGate || hasWorkerAck;
  }

  private actAtSafeCheckpoint(projectId: number, currentReason: WatchReason, hash: string): void {
    // v1: LOG + rules-refresh *event* instructing coordinator to re-read rules + expect ACK (full auto-compaction/restart deferred v1.1)
    const now = Date.now();
    const input: AgentEventInput = {
      run_id: `plumbing:${projectId}`,
      role: 'plumbing',
      batch_id: `plumbing-${projectId}`,
      session: null,
      type: 'status',
      state: 'rules-refresh',
      source: 'post',
      correlation_id: `rules-refresh:${projectId}:${now}`,
      body: {
        project_id: projectId,
        action: 'rules-refresh',
        watch_reason: currentReason,
        hash,
        note: 'Context Steward: re-read rules/toolkits at safe checkpoint; expect ACK (v1 log+event only)'
      },
    };
    this.events.recordEvent(input);

    this.db
      .prepare(
        `INSERT INTO plumbing_checkpoint_log (project_id, checkpoint_type, reason, action, digest_hash, event_id, ts)
         VALUES (?, 'gate-pass', ?, 'rules-refresh', ?, ?, datetime('now'))`
      )
      .run(projectId, currentReason, hash, null);

    this.db
      .prepare(
        "UPDATE coordinator_watch_states SET refresh_due=0, tasks_since_refresh=0, last_progress_at=datetime('now'), updated_at=datetime('now') WHERE project_id=?"
      )
      .run(projectId);
  }

  // For tests: allow direct drive of tick (or seed + tick)
  async forceTickForTest(): Promise<void> {
    await this.watchTick();
  }
}
