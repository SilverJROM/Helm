import { DatabaseService } from '../db/database.js';
import { AgentEventsService } from './agent-events-service.js';
import { TmuxService } from '../tmux/tmux-service.js';
import { ProviderResolverService } from './provider-resolver-service.js';
import { AgentAssignmentService } from './agent-assignment-service.js';
import { ToolkitService } from './toolkit-service.js';
import { AGENT_ROLES } from '../guardrails.js';
import { loadConfig } from '../config/config.js';
import { PROVIDERS } from '../config/providers.js';
import { resolveHelmSandboxBin, makeWriteFencePolicy, makeStrictReadProfileEnv } from '../security/landlock-sandbox.js';
import { startGovernedDocGuard, type GovernedDocGuardHandle } from './doc-path-guard.js';
import { applyEnvelopeIsolation } from './envelope-isolation.js';
import type { SessionRegistryService } from './session-registry-service.js';
import { HelmIdentityService } from './helm-identity-service.js';
import { finalizeWorkerRuntimeRow, finalizeSessionGoneWorkers } from './worker-runtime-finalize.js';

export class WorkerService {
  private reaperInterval: NodeJS.Timeout | null = null;
  private reaperInFlight = false;
  private activeWorkerSessions = new Set<string>();
  // R7.26/B22b: userspace fence for the 3 plan/<cycle> governed docs, keyed by tmux session
  // name, for the fenced worker's lifetime (north-star.md is kernel-fenced; see helm-sandbox.c).
  private governedDocGuards = new Map<string, GovernedDocGuardHandle>();
  private readonly identity?: HelmIdentityService;

  constructor(
    private readonly db: DatabaseService,
    private readonly events: AgentEventsService,
    private readonly tmux: TmuxService,
    private readonly resolver: ProviderResolverService,
    private readonly assignment: AgentAssignmentService,
    private readonly toolkitService?: ToolkitService,
    // SL-R3: optional session registry. When present, the 60s reaper also runs the session janitor
    // (helm_sessions cleanup). Absent (existing tests / thin construction) → janitor is inert.
    private readonly sessionRegistry?: SessionRegistryService,
    identity?: HelmIdentityService
  ) {
    this.identity = identity;
  }

  // AC1/AC2: the native active project (never a legacy numeric-ID match) is the sole slug source;
  // resolves to null when the project is missing/inactive/erroring so the caller fails BEFORE
  // any tmux/runtime mutation rather than silently launching under an 'unknown' session name.
  private resolveNativeProject(projectId: number): { directory_name: string } | null {
    if (!this.identity) return null;
    const resolution = this.identity.resolveProject(projectId);
    return resolution.project ? { directory_name: resolution.project.directory_name } : null;
  }

  /**
   * B25 fix1+fix2 / R6.25: launch model resolution.
   * Precedence (N4 — do NOT invert):
   * 1) Keep agent.model when it is already launch-legal (allow-listed, dynamic provider, or
   *    project-effective override already applied by assignment).
   * 2) Else fall back to default_model_id → models.model_id only when same provider AND
   *    launch-legal (N5: never silently swap provider / never launch banned slug).
   * 3) Else return raw agent.model (resolver fails closed if still unknown).
   */
  private resolveLaunchProviderModel(agent: {
    provider: string;
    model: string;
    default_model_id?: number | null;
  }): { provider: string; model: string } {
    if (this.isLaunchLegalModel(agent.provider, agent.model)) {
      return { provider: agent.provider, model: agent.model };
    }
    const defId = agent.default_model_id;
    if (defId != null) {
      try {
        const row = this.db
          .prepare('SELECT provider, model_id FROM models WHERE id = ?')
          .get(defId) as { provider?: string; model_id?: string } | undefined;
        if (row?.model_id) {
          const prov = row.provider || agent.provider;
          const mid = String(row.model_id);
          // N5: same-provider only + must itself be launch-legal.
          if (prov === agent.provider && this.isLaunchLegalModel(prov, mid)) {
            return { provider: prov, model: mid };
          }
        }
      } catch {
        /* models table absent in thin fixtures — fall through to legacy */
      }
    }
    return { provider: agent.provider, model: agent.model };
  }

  private isLaunchLegalModel(provider: string, model: string): boolean {
    if (!model || model === 'dynamic') return true;
    const p = (PROVIDERS as Record<string, { dynamicModels?: boolean; models?: { model: string }[] }>)[provider];
    if (!p) return false;
    if (p.dynamicModels) return true;
    return Array.isArray(p.models) && p.models.some((m) => m.model === model);
  }

  async spawnWorker({ projectId, role, taskBrief, spawnedBy = 'owner', runId, strictReadAllow }: { projectId: number; role: string; taskBrief: string; spawnedBy?: string; runId?: number;
    // B-ISO1 (2026-07-16 cheat-isolation): OPT-IN strict READ profile for THIS worker seat. Workers
    // are what actually BUILD cards2, so they must be fenceable. Absent (every existing caller) →
    // fencedCmd + fed policy are byte-identical to before (default read-all). Present → the strict env
    // prefixes the sandbox bin and the fed policy states the read restriction. Reuses the master helper.
    strictReadAllow?: string[] }) {
    if (!AGENT_ROLES.includes(role as any)) throw new Error(`invalid role: ${role}`);
    // AC2: fail closed on an inactive/unknown native project BEFORE any tmux/runtime/task mutation.
    const nativeProject = this.identity ? this.resolveNativeProject(projectId) : undefined;
    if (this.identity && !nativeProject) throw new Error(`unknown or inactive OVM project: ${projectId}`);
    const resolved = this.assignment.resolveProjectRole ? this.assignment.resolveProjectRole(projectId, role) : this._resolveFallback(projectId, role);
    if (!resolved || (!resolved.agent && !resolved.roster)) throw new Error(`no agent for role ${role} on project ${projectId}`);
    let agent = resolved.agent;
    if (!agent && resolved.roster && resolved.roster.length > 0) {
      const first = resolved.roster[0];
      // FIX B: resolve real role agent id via getProjectBinding / role default (for toolkit compose); keep roster model/provider. No id -1.
      let realId = -1;
      const binding = this.assignment.getProjectBinding ? this.assignment.getProjectBinding(projectId, role) : null;
      if (binding && binding.agent && binding.agent.id != null) {
        realId = binding.agent.id;
      } else {
        const defs = this.assignment.listRoleDefaults ? this.assignment.listRoleDefaults() : [];
        const def = defs.find((d: any) => d.role === role);
        if (def && def.agent && def.agent.id != null) realId = def.agent.id;
      }
      const effectivePa = realId >= 0 && this.assignment.resolveProjectAgent
        ? this.assignment.resolveProjectAgent(projectId, realId)
        : null;
      agent = {
        id: realId,
        name: 'team-roster-seat',
        provider: first.provider,
        model: first.model,
        default_effort: effectivePa?.effort ?? 'medium',
        definition_md: effectivePa?.definition_md ?? null
      } as any;
    }

    // C3: resolve project.directory (fail-closed if missing — never exec unfenced for project-bound workers).
    const dirRow = this.db.prepare("SELECT directory FROM projects WHERE id = ?").get(projectId) as { directory?: string } | undefined;
    const projectDir = dirRow?.directory;
    if (!projectDir) {
      throw new Error(`C3 write-fence: no directory registered for project_id=${projectId} (promote first); refusing to exec unfenced worker`);
    }

    // B9fix2 F2: toolkit sidecars + persona from resolveProjectAgent effective view (not global agent_toolkits).
    const fedBrief = this.buildWorkerFedBrief(projectId, agent.id, agent.definition_md, taskBrief);
    // B25 fix1+fix2 / R6.25: legal agents.model first; else same-provider launch-legal default_model_id.
    const launch = this.resolveLaunchProviderModel(agent);
    const launchOpts: { provider: string; model: string; effort: string; mode?: 'tui' | 'headless' } = {
      provider: launch.provider,
      model: launch.model,
      effort: agent.default_effort || 'medium'
    };
    if (launch.provider === 'claude') {
      launchOpts.mode = 'tui';
    }
    const launchSpec = this.resolver.resolveAgentLaunchSpec(launchOpts);
    // B-ISO1: compose (+ fail-closed validate) the OPT-IN strict read env HERE, before the txn /
    // worker_runtimes row / tmux session, so a bad allowlist (empty list, relative entry) refuses the
    // spawn cleanly with zero cleanup. Absent → '' (fencedCmd byte-identical to the read-all default).
    const strictEnv = strictReadAllow !== undefined ? makeStrictReadProfileEnv(strictReadAllow) : '';
    const raw = this.db.raw;
    raw.exec('BEGIN IMMEDIATE;');
    try {
      const activeCount = (this.db.prepare("SELECT COUNT(*) as c FROM worker_runtimes WHERE project_id = ? AND state IN ('launching','running')").get(projectId) as { c: number }).c;
      const cap = (loadConfig() as any).WORKER_MAX_CONCURRENT || 5;
      if (activeCount >= cap) {
        raw.exec('ROLLBACK;');
        throw new Error('per-project worker cap exceeded');
      }
      const existing = this.db.prepare("SELECT id FROM worker_runtimes WHERE project_id = ? AND role = ? AND state IN ('launching','running')").get(projectId, role);
      if (existing) {
        raw.exec('ROLLBACK;');
        throw new Error('worker already spawning/running for role on project');
      }
      const corr = `worker-${Date.now()}`;
      const id = this.db.prepare(`
INSERT INTO worker_runtimes (project_id, role, provider, model, task_brief, correlation_id, state, spawned_by, started_at, run_id)
VALUES (?,?,?,?,?,?,?,?,datetime('now'), ?)
`).run(projectId, role, launch.provider, launch.model, taskBrief, corr, 'launching', spawnedBy, runId ?? null).lastInsertRowid;
      raw.exec('COMMIT;');
      // Post-commit launch phase: cleanup-aware so ANY failure after COMMIT terminates the
      // tmux session, untracks it, and marks the row failed (H2 — never leak a session or
      // leave a row stuck 'launching'). Session col is persisted right after createSession
      // so reapAll can find/kill the session even if a later step throws.
      // AC1: native directory_name is the sole slug source (identity already confirmed above); 'unknown' only when no identity boundary is wired (thin test construction).
      const slug = nativeProject ? nativeProject.directory_name : 'unknown';
      const sessionName = `helm-w-${slug}-${id}`;
      const target = `${sessionName}:0.0`;
      try {
        await this.tmux.createSession(sessionName, projectDir); // C3 cwd lock (project-bound only)
        this.activeWorkerSessions.add(sessionName);
        this.db.prepare("UPDATE worker_runtimes SET session=? WHERE id=?").run(sessionName, id);
        // SL-R2: the registry hook fired on createSession registered this session 'active'; enrich the
        // row with the run/project context the creating path holds so the janitor can map session→run.
        try { this.sessionRegistry?.enrich(sessionName, { projectId, runId: runId ?? null, kind: 'worker' }); } catch {}
        // C3: absolute bin path (dist/tools preferred) + projectDir prefix. Only for project-bound workers.
        const sandboxBin = resolveHelmSandboxBin();
        const { envPrefix, launchCmd } = applyEnvelopeIsolation(launch.provider, launchSpec.launch_cmd);
        // B-ISO1: strictEnv (composed fail-closed above) prefixes the sandbox bin so the kernel fence
        // enforces the strict read profile on the worker seat; '' when the opt-in is absent (byte-identical).
        // B1 (send-back CRITICAL): this ad-hoc worker spawn has no run-directory concept (it writes
        // only to projectDir, never <run>/callbacks.md) — it must NOT receive a HELM_RUN_ROOT write
        // grant at all; that would only ever widen access to the shared root, never narrow to "its
        // own" run (there isn't one). See makeRunRootWriteAllowEnv's doc comment.
        const fencedCmd = `${strictEnv}${envPrefix}${sandboxBin} ${projectDir} ${launchCmd}`;
        await this.tmux.sendCommand(target, fencedCmd, true, true);
        // R7.26/B22b: start the userspace guard as soon as the fenced process exists (not
        // gated on ready-probe success) - a tampering attempt shouldn't get a free window
        // just because the ready signal hasn't printed yet.
        this.governedDocGuards.set(sessionName, startGovernedDocGuard(projectDir));
        const prov = (PROVIDERS as any)[launch.provider];
        const probe = prov?.readyProbe || { signal: '❯', timeoutMs: 30000 };
        const ready = await this._waitForReady(target, probe.signal, probe.timeoutMs || 30000);
        if (!ready) throw new Error('worker ready probe failed (ready-timeout)');
        // C3: policy-augmented fedBrief (behavioral backstop in addition to kernel fence)
        // B-ISO1: a strict worker gets the strict-read policy text (never "read anywhere"); absent → byte-identical.
        const policy = makeWriteFencePolicy(projectDir, strictReadAllow);
        const fencedBrief = `${policy}\n\n${fedBrief}`;
        // F2: interactive SEAT — gate on this provider's composer ready glyph (the same `probe.signal` the
        // worker readyProbe just confirmed above), so a seat that never reached its composer is not falsely
        // marked delivered.
        // worker-dispatch-feed (2026-07-17): this is a LIVE worker-dispatch feed (owner spawnWorker route) with
        // the identical _waitForReady→sendAndSubmit pattern as DispatchService, so it hit the SAME codex/spark
        // false-negate: the seat accepts the (large) brief, starts GENERATING, and echoes it back under a › line
        // composerRegionHoldsText misreads as "still held" → a false feed-failed. Accept a THIS-TURN generation
        // indicator as submit-proof (footer-scoped; stale scrollback never counts; a dead seat still returns false).
        const submitted = await this.tmux.sendAndSubmit(target, fencedBrief, { readySignal: probe.signal, generationCountsAsSubmitted: true });
        if (!submitted) throw new Error('sendAndSubmit returned false on worker feed (feed-failed)');
        const pid = await this.tmux.getPanePid(target) || 0;
        this.db.prepare("UPDATE worker_runtimes SET state='running', session=?, pane_pid=? WHERE id=?").run(sessionName, pid, id);
        this.events.recordEvent({
          run_id: `worker-${id}`,
          role: 'system',
          batch_id: `worker-${id}`,
          session: target,
          type: 'status',
          state: 'running',
          source: 'post',
          correlation_id: corr,
          body: { project_id: projectId, role, provider: launch.provider, model: launch.model, spawned_by: spawnedBy }
        });
        return this.db.prepare("SELECT * FROM worker_runtimes WHERE id=?").get(id);
      } catch (e: any) {
        try { await this.tmux.terminateSession(sessionName); } catch {}
        this.activeWorkerSessions.delete(sessionName);
        try { this.governedDocGuards.get(sessionName)?.stop(); } catch {}
        this.governedDocGuards.delete(sessionName);
        const reason = /ready-timeout/.test(String(e)) ? 'ready-timeout'
          : /feed-failed/.test(String(e)) ? 'feed-failed' : 'launch-error';
        try { this.db.prepare("UPDATE worker_runtimes SET state='failed', exit_reason=?, ended_at=datetime('now') WHERE id=?").run(reason, id); } catch {}
        throw e;
      }
    } catch (e) {
      try { raw.exec('ROLLBACK;'); } catch {}
      throw e;
    }
  }

  async reapWorker(id: number, reason = 'manual') {
    const row = this.db.prepare("SELECT * FROM worker_runtimes WHERE id = ?").get(id) as any;
    if (!row || ['done', 'failed', 'reaped'].includes(row.state)) return; // idempotent
    const session = row.session;
    if (session) {
      const target = `${session}:0.0`;
      try {
        await this.tmux.sendAndSubmit(target, `\n\n[WORKER REAP ${reason}]`);
        await this.tmux.sendKeys(target, 'C-c');
        await new Promise(r => setTimeout(r, 500));
      } catch {}
      // H3: always best-effort kill the session when one is present. getPanePid() returns null
      // on a tmux error, so gating the kill on a truthy PID could leave a live session orphaned
      // while the row is marked terminal (idempotency then blocks any future cleanup).
      try { await this.tmux.terminateSession(session); } catch {}
      this.activeWorkerSessions.delete(session);
      try { this.governedDocGuards.get(session)?.stop(); } catch {}
      this.governedDocGuards.delete(session);
    }
    // State machine: timeout is a FAILURE terminal; explicit/shutdown reap is 'reaped'.
    // A15: shared finalize writer (idempotent if already terminal).
    const terminalState = reason === 'timeout' ? 'failed' : 'reaped';
    finalizeWorkerRuntimeRow(this.db.raw, id, terminalState as 'failed' | 'reaped', reason);
    this.events.recordEvent({
      run_id: `worker-${id}`,
      role: 'system',
      batch_id: `worker-${id}`,
      session: session ? `${session}:0.0` : null,
      type: 'status',
      state: terminalState,
      source: 'post',
      correlation_id: `worker-reap-${id}`,
      // MED (red-team): include project_id so the live-board SSE filter (worker-* && body.project_id===id)
      // delivers reap/timeout terminal events — else the board never reflects worker termination.
      body: { reason, project_id: row.project_id }
    });
    // E2: on stale/failed reap for run worker, persist to run_tasks.status='failed' (observable, not in-mem only)
    this.markRunTaskFailedForWorker(row, reason);
  }

  listWorkers(projectId: number) {
    return this.db.prepare("SELECT * FROM worker_runtimes WHERE project_id = ? ORDER BY id DESC").all(projectId);
  }

  getWorker(id: number): any {
    return this.db.prepare("SELECT * FROM worker_runtimes WHERE id = ?").get(id);
  }

  startReaper() {
    if (this.reaperInterval) return;
    const timeout = (loadConfig() as any).WORKER_TIMEOUT_MS || 1800000;
    this.reaperInterval = setInterval(() => { void this._reapTick(timeout); }, 60000);
  }

  stopReaper() {
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
      this.reaperInterval = null;
    }
  }

  async reapAll() {
    const active = this.db.prepare("SELECT id, session FROM worker_runtimes WHERE state IN ('launching','running')").all() as any[];
    for (const w of active) {
      await this.reapWorker(w.id, 'shutdown');
    }
  }

  private async _reapTick(timeoutMs: number) {
    if (this.reaperInFlight) return;
    this.reaperInFlight = true;
    try {
      // A15 / R4: session-gone choke — launching|running whose tmux target is gone leave
      // running/ended_at NULL without waiting for WORKER_TIMEOUT (~30min). Explicit finalize,
      // not "hope the generic age janitor".
      try {
        await finalizeSessionGoneWorkers(this.db.raw, (name) => this.tmux.sessionExists(name));
      } catch { /* best-effort */ }

      // H1: compare in a SINGLE time format. started_at is SQLite datetime('now') ("YYYY-MM-DD
      // HH:MM:SS", space). A JS toISOString() cutoff (with 'T') would sort lexicographically
      // wrong (space < 'T'), false-reaping fresh same-day workers. Use SQLite datetime arithmetic.
      const secs = Math.max(1, Math.floor(timeoutMs / 1000));
      const stale = this.db.prepare("SELECT id FROM worker_runtimes WHERE state IN ('launching','running') AND started_at < datetime('now', ?)").all(`-${secs} seconds`) as any[];
      for (const w of stale) {
        await this.reapWorker(w.id, 'timeout');
      }
      // E2: additional checkin enforcement pass: for each active worker, if role has checkin_ms and
      // elapsed since started > checkin_ms (simple proxy for missed progress check-in), reap as checkin-stale -> will mark run_task failed
      const actives = this.db.prepare("SELECT id, role FROM worker_runtimes WHERE state IN ('launching','running')").all() as any[];
      for (const w of actives) {
        const ci = this.getRoleCheckinMs(w.role);
        if (ci && ci > 0) {
          const row = this.db.prepare("SELECT started_at FROM worker_runtimes WHERE id = ?").get(w.id) as any;
          if (row && row.started_at) {
            const started = Date.parse(row.started_at.replace(' ', 'T') + 'Z') || Date.now();
            if (Date.now() - started > ci) {
              await this.reapWorker(w.id, 'checkin-missed');
            }
          }
        }
      }
      // SL-R3: session-lifecycle janitor rides the same 60s cadence (no parallel loop).
      await this.sessionJanitorTick();
    } catch (e: any) {
      if (!/not open|closed|database connection/i.test(String(e))) throw e;
    } finally {
      this.reaperInFlight = false;
    }
  }

  // SL-R3 (janitor) + SL-R4 (guardrails). On each tick, for each helm_sessions row whose work is
  // DONE and whose grace TTL has elapsed, terminate the tmux session + markReaped. Config:
  // HELM_SESSION_TTL_MS (default 20min), HELM_SESSION_JANITOR='0' disables. Best-effort — a session
  // that no longer exists in tmux still gets markReaped so the registry converges.
  //
  // "done" = status='idle' (SL-R2 explicit) OR (run_id set AND that run is terminal:
  // complete/failed/blocked) OR (no active worker_runtime bound to the session AND it is old).
  async sessionJanitorTick(): Promise<void> {
    if (!this.sessionRegistry) return;
    const cfg = loadConfig() as any;
    if (cfg.HELM_SESSION_JANITOR === false) return;
    const ttlMs = Number(cfg.HELM_SESSION_TTL_MS) || 1200000;
    const ttlSecs = Math.max(1, Math.floor(ttlMs / 1000));

    // Candidate rows: anything not already reaped. We evaluate each under the guardrails below.
    const rows = this.db.prepare(
      "SELECT id, name, run_id, status, created_at, last_used_at FROM helm_sessions WHERE status != 'reaped'"
    ).all() as any[];

    for (const row of rows) {
      // --- SL-R4 GUARDRAIL 1: never touch a session not in the registry (we only iterate registry rows).
      //     GUARDRAIL 2 (defense in depth): the name MUST start with 'helm-'. Never 01_impl_*, 03_impl_*,
      //     the pm2/master/owner session, or any non-helm- session — even if somehow registered.
      if (!row.name || !String(row.name).startsWith('helm-')) continue;

      // --- SL-R4 GUARDRAIL 3: NEVER terminate a session whose mapped run is non-terminal / active.
      //     Determine "done" only from terminal signals; an active/live worker vetoes the reap.
      const runTerminal = this.isRunTerminalForSession(row.run_id);
      const hasLiveWorker = this.hasLiveWorkerForSession(row.name);
      const isIdle = row.status === 'idle';

      // Live worker running → HARD SKIP (active run guardrail). Even if idle was set, a live worker means keep.
      if (hasLiveWorker) continue;
      // If the row carries a run that is still non-terminal, skip (run active). run_id null → fall through
      // to the age-based orphan path (no run to protect).
      if (row.run_id != null && !runTerminal) continue;

      const done = isIdle || runTerminal || row.run_id == null; // no live worker + (idle | terminal run | no run)
      if (!done) continue;

      // --- SL-R3 grace TTL: age since last_used_at (fallback created_at) must exceed TTL. SQLite datetime
      //     arithmetic to avoid the space-vs-'T' lexical bug the worker reaper documents (started_at format).
      const pastTtl = this.db.prepare(
        "SELECT (COALESCE(last_used_at, created_at) < datetime('now', ?)) AS aged FROM helm_sessions WHERE id = ?"
      ).get(`-${ttlSecs} seconds`, row.id) as any;
      if (!pastTtl || !pastTtl.aged) continue;

      // --- ST-R2 FINAL GATE (the core safety guarantee): the live session MUST carry Helm's positive
      //     `@helm_child` ownership tag (set at createSession's choke point). This is IN ADDITION to every
      //     guard above (registry membership, 'helm-' prefix, live-worker veto, non-terminal-run veto,
      //     idle-TTL, HELM_SESSION_JANITOR toggle) and sits LAST, immediately before the kill. Untagged /
      //     tag-probe-error → fail-safe SKIP: a session Helm did not create can NEVER be reaped. Safe
      //     default: `continue` (leave the row; a genuinely-Helm session will be tagged and reaped next tick).
      let helmTagged = false;
      try {
        helmTagged = await this.tmux.sessionHasHelmChildTag(row.name);
      } catch (err) {
        // Defense in depth: sessionHasHelmChildTag is itself fail-safe (returns false on any tmux error),
        // but if the probe ever throws we STILL treat it as untagged → skip. Uncertainty NEVER escalates
        // to a kill. NO-SPILLOVER invariant: a session Helm did not provably create is never terminated.
        helmTagged = false;
        console.warn('[session-janitor] @helm_child probe threw → treating as NOT-Helm, SKIP', { name: row.name, err: String(err) });
      }
      if (!helmTagged) {
        console.warn('[session-janitor] SKIP: session missing @helm_child tag → never reap (not Helm-created)', { name: row.name });
        continue;
      }

      // ST-R3: this janitor is the ONLY TTL/age-based session sweeper in Helm, and it is tag-gated (above).
      // No broad-kill path exists (no tmux kill-server / kill-session -a / pkill tmux anywhere); the per-role
      // orchestrator-loop reap uses targeted kill-session -t on its OWN worker sessions only.
      // Passed every guardrail → terminate + markReaped. terminateSession is best-effort (session may be
      // already gone); markReaped converges the registry regardless.
      try {
        await this.tmux.terminateSession(row.name);
      } catch (err) {
        console.warn('[session-janitor] terminateSession failed (best-effort)', { name: row.name, err: String(err) });
      }
      // terminateSession's registry hook also markReaps, but call explicitly with the janitor reason so
      // the reason is recorded even when the hook is absent or the kill threw.
      try { this.sessionRegistry.markReaped(row.name, 'janitor-ttl'); } catch {}
    }
  }

  // SL-R3 startup sweep: on boot, reap registry sessions whose run is terminal / has no live run and
  // whose grace TTL has elapsed. Clearly-orphaned rows (run terminal or no run, no live worker) that are
  // past TTL are reaped; SAFE — never touches active runs (same guardrails as the tick). Disable with
  // HELM_SESSION_JANITOR='0'. Reuses sessionJanitorTick (identical guarded logic) for a single code path.
  async sweepOrphanSessionsAtStartup(): Promise<void> {
    if (!this.sessionRegistry) return;
    const cfg = loadConfig() as any;
    if (cfg.HELM_SESSION_JANITOR === false) return;
    await this.sessionJanitorTick();
  }

  // SL-R3/R4 helper: is the run mapped to this session terminal (complete/failed/blocked)?
  // runs.status ∈ pending|active|complete|failed and runs.phase can be 'blocked'. Terminal = either.
  private isRunTerminalForSession(runId: number | null | undefined): boolean {
    if (runId == null) return false;
    try {
      const run = this.db.prepare("SELECT status, phase FROM runs WHERE id = ?").get(runId) as any;
      if (!run) return true; // run row gone → nothing to protect → treat as terminal/orphan
      const status = String(run.status || '').toLowerCase();
      const phase = String(run.phase || '').toLowerCase();
      return ['complete', 'failed'].includes(status) || ['complete', 'failed', 'blocked'].includes(phase);
    } catch {
      return false; // unknown → do NOT treat as terminal (fail-safe: keep the session)
    }
  }

  // SL-R4 helper: is there a live (launching/running) worker_runtime bound to this session name?
  // A live worker vetoes any reap of its session (active-run guardrail).
  private hasLiveWorkerForSession(sessionName: string): boolean {
    try {
      const row = this.db.prepare(
        "SELECT 1 FROM worker_runtimes WHERE session = ? AND state IN ('launching','running') LIMIT 1"
      ).get(sessionName);
      return !!row;
    } catch {
      return true; // unknown → assume live (fail-safe: never reap on a query error)
    }
  }

  private async _waitForReady(target: string, signal: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const pane = await this.tmux.capturePane(target, 150);
      if (pane.includes(signal)) return true;
      await new Promise(r => setTimeout(r, 250));
    }
    return false;
  }

  private buildWorkerFedBrief(projectId: number, agentId: number, definitionMd: string | null | undefined, taskBrief: string): string {
    const parts: string[] = [];
    if (definitionMd?.trim()) parts.push(definitionMd.trim());
    if (agentId >= 0 && this.toolkitService && this.assignment.resolveProjectAgent) {
      const effective = this.assignment.resolveProjectAgent(projectId, agentId);
      const tk = this.toolkitService.composeToolkitBodies(
        (effective?.toolkits ?? []).map((t) => ({ name: t.name, body_md: t.body_md }))
      );
      if (tk) parts.push(tk);
    }
    parts.push(taskBrief);
    return parts.join('\n\n');
  }

  private _resolveFallback(projectId: number, role: string) {
    const binding = this.assignment.getProjectBinding ? this.assignment.getProjectBinding(projectId, role) : null;
    if (binding && binding.agent) return { source: 'binding', agent: binding.agent };
    const defs = this.assignment.listRoleDefaults ? this.assignment.listRoleDefaults() : [];
    const def = defs.find((d: any) => d.role === role);
    if (def && def.agent) return { source: 'default', agent: def.agent };
    return null;
  }

  // E2: lookup persisted role_capabilities.checkin_ms for enforcement
  private getRoleCheckinMs(role: string): number | null {
    try {
      const row = this.db.prepare('SELECT checkin_ms FROM role_capabilities WHERE role = ?').get(role) as any;
      return row && row.checkin_ms != null ? Number(row.checkin_ms) : null;
    } catch {
      return null;
    }
  }

  // E2: when a run-scoped worker goes stale/failed (via reaper), also persist failure to its run's current run_task
  // so status='failed' is observable in run_tasks (not hidden in-mem only). Tie reaper + checkin.
  private markRunTaskFailedForWorker(worker: any, reason: string): void {
    if (!worker || !worker.run_id) return;
    const runId = worker.run_id;
    try {
      // Only the ACTUAL in-flight task ('working') may be failed by a worker reap — NEVER a 'pending'
      // future task. The old query (status IN ('working','pending') ORDER BY id DESC) picked the
      // highest-id pending task, so every stale/checkin reap wrongly failed the LAST plan task and
      // cascaded backward (T25→T24→T23…), sinking tasks the build had not even reached. If no task is
      // 'working' (DB status can lag the in-mem loop), mark nothing rather than guess a trailing task.
      const task = this.db.prepare("SELECT id FROM run_tasks WHERE run_id = ? AND status = 'working' ORDER BY updated_at DESC LIMIT 1").get(runId) as any;
      if (task && task.id) {
        this.db.prepare("UPDATE run_tasks SET status='failed', updated_at=datetime('now') WHERE id = ?").run(task.id);
      }
    } catch {}
  }
}
