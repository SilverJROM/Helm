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
import {
  sessionStatusTokenFromRow,
  type SessionRegistryService,
  type SessionStatusToken,
} from './session-registry-service.js';
import { HelmIdentityService } from './helm-identity-service.js';
import { finalizeWorkerRuntimeRow, finalizeSessionGoneWorkers } from './worker-runtime-finalize.js';
import { decideSessionReconcile } from './session-reconcile-decision.js';
import { gateWorkerTimeoutByActivity } from './session-observation.js';

export class WorkerService {
  private reaperInterval: NodeJS.Timeout | null = null;
  private reaperInFlight = false;
  private activeWorkerSessions = new Set<string>();
  // R7.26/B22b: userspace fence for the 3 plan/<cycle> governed docs, keyed by tmux session
  // name, for the fenced worker's lifetime (north-star.md is kernel-fenced; see helm-sandbox.c).
  private governedDocGuards = new Map<string, GovernedDocGuardHandle>();
  /**
   * B02 C1 fix cycle 2: create-time SessionStatusToken keyed by worker_runtimes.id.
   * Never re-capture by session name at cleanup (replacement lifecycle would match).
   */
  private workerSessionTokens = new Map<number, SessionStatusToken>();
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
      const workerId = Number(id);
      // B02 C1: capture CAS token at create/register — retain for launch-fail + reapWorker.
      const sessionTokenOut: { token?: SessionStatusToken } = {};
      try {
        await this.tmux.createSession(sessionName, projectDir, {
          owner: 'helm',
          kind: 'worker',
          projectId,
          runId: runId ?? null,
          sessionTokenOut,
        }); // C3 cwd lock; S05 owner=helm
        if (sessionTokenOut.token) this.workerSessionTokens.set(workerId, sessionTokenOut.token);
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
        // B02 C1: use create-time token only (never late get-by-name).
        const createTok = this.workerSessionTokens.get(workerId);
        try {
          await this.tmux.terminateSession(
            sessionName,
            createTok ? { sessionToken: createTok } : { noRegistryWrite: true }
          );
        } catch {}
        this.workerSessionTokens.delete(workerId);
        this.activeWorkerSessions.delete(sessionName);
        try { this.governedDocGuards.get(sessionName)?.stop(); } catch {}
        this.governedDocGuards.delete(sessionName);
        const reason = /ready-timeout/.test(String(e)) ? 'ready-timeout'
          : /feed-failed/.test(String(e)) ? 'feed-failed' : 'launch-error';
        // S02: shared finalizer (idempotent; markIdle no-ops after terminate→markReaped above).
        // Number(id): lastInsertRowid is number|bigint under better-sqlite3 typings (tsc TS2345).
        try { finalizeWorkerRuntimeRow(this.db.raw, Number(id), 'failed', reason); } catch {}
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
      // B02 C1: create-time token retained by worker id — never late capture by session name.
      const createTok = this.workerSessionTokens.get(id);
      try {
        await this.tmux.terminateSession(
          session,
          createTok ? { sessionToken: createTok } : { noRegistryWrite: true }
        );
      } catch {}
      this.workerSessionTokens.delete(id);
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
        // B06/F-01: tri-state probe — an UNKNOWN existence read must never assert completion.
        // Reuses the same S12 tri-state+fallback wiring as the reconciler (not the boolean
        // tmux.sessionExists, which collapses socket/permission errors into a false positive).
        await finalizeSessionGoneWorkers(this.db.raw, (name) => this.probeSessionExistsForReconcile(name));
      } catch { /* best-effort */ }

      // B12 / AC17: started_at age is a **candidate selector only** — not sufficient kill evidence.
      // H1: compare in a SINGLE time format. started_at is SQLite datetime('now') ("YYYY-MM-DD
      // HH:MM:SS", space). A JS toISOString() cutoff (with 'T') would sort lexicographically
      // wrong (space < 'T'), false-reaping fresh same-day workers. Use SQLite datetime arithmetic.
      const secs = Math.max(1, Math.floor(timeoutMs / 1000));
      const ageCandidates = this.db.prepare(
        "SELECT id, session FROM worker_runtimes WHERE state IN ('launching','running') AND started_at < datetime('now', ?)"
      ).all(`-${secs} seconds`) as { id: number; session: string | null }[];
      for (const w of ageCandidates) {
        // Keep-biased when no session name (cannot observe activity).
        if (!w.session) continue;
        let sessionActivity: number | null = null;
        try {
          const tmux = this.tmux as TmuxService & {
            sessionActivity?: (n: string) => Promise<number | null>;
          };
          if (typeof tmux.sessionActivity === 'function') {
            sessionActivity = await tmux.sessionActivity(w.session);
          } else {
            // No activity reader → treat as unknown (keep).
            sessionActivity = null;
          }
        } catch {
          sessionActivity = null;
        }
        const { gate } = gateWorkerTimeoutByActivity({
          sessionActivity,
          thresholdMs: timeoutMs,
        });
        // Recent or unknown activity vetoes timeout termination.
        if (gate !== 'STALE_ALLOW_TIMEOUT') continue;
        // Known stale activity only — existing targeted timeout path (reapWorker body unchanged).
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

  // S12 / AC6-invariant, AC14, AC25, AC27 — assertion-based reconciler (not TTL/idle heuristics).
  // Authority is S11 decideSessionReconcile(row, facts): REAP | CONVERGE | KEEP.
  // Retired kill authority: grace TTL / last_used_at age, run-terminal "done", run_id-null orphan.
  // Preserved rails: registry membership, helm- prefix, active-worker veto, final @helm_child tag,
  // targeted terminate only, idempotent markReaped, gone-session CONVERGE without kill.
  // HELM_SESSION_JANITOR='off|shadow|on' (default 0/off).
  async sessionJanitorTick(): Promise<void> {
    if (!this.sessionRegistry) return;
    const cfg = loadConfig() as any;
    const janitorMode = cfg.HELM_SESSION_JANITOR;
    if (janitorMode === "off") return;
    const shadowMode = janitorMode === "shadow";

    // Candidate rows: anything not already reaped. Decision + rails evaluate each.
    // (Registry membership guardrail: we only iterate helm_sessions rows.)
    // B02: include generation so markReaped CAS can use the snapshot token (no re-read).
    const rows = this.db.prepare(
      "SELECT id, name, run_id, status, owner, generation, created_at, last_used_at FROM helm_sessions WHERE status != 'reaped'"
    ).all() as any[];

    for (const row of rows) {
      // SL-R4: name MUST start with 'helm-'. Never touch non-helm- sessions even if registered.
      if (!row.name || !String(row.name).startsWith('helm-')) continue;

      const sessionExists = await this.probeSessionExistsForReconcile(String(row.name));
      const decision = decideSessionReconcile(
        {
          owner: row.owner,
          status: row.status,
          run_id: row.run_id,
          name: row.name,
        },
        { sessionExists }
      );

      if (decision.action === 'KEEP') {
        continue;
      }

      if (decision.action === 'CONVERGE') {
        // AC14/27: session provably gone — converge registry only; never kill.
        if (shadowMode) {
          console.warn('[session-janitor][shadow] WOULD CONVERGE row (no-write)', {
            name: row.name,
            reason: decision.reason,
          });
          continue;
        }
        try {
          // B02: CAS markReaped from janitor snapshot token (no name-only write).
          this.sessionRegistry.markReaped(
            sessionStatusTokenFromRow(row),
            `reconcile:${decision.reason}`
          );
        } catch (err) {
          console.warn('[session-janitor] markReaped(CONVERGE) failed', { name: row.name, err: String(err) });
        }
        continue;
      }

      // decision.action === 'REAP' — Helm-owned + idle assertion + live session.
      // Execution vetoes (not decision authority): active worker, non-terminal run,
      // attached keep (S12-V1), @helm_child tag.
      if (this.hasLiveWorkerForSession(row.name)) {
        continue;
      }
      if (row.run_id != null && !this.isRunTerminalForSession(row.run_id)) {
        continue;
      }

      // S12-V1: attached=true → KEEP; unknown/probe failure keep-biased → KEEP.
      // Only a positive attached===false may proceed to REAP.
      const attached = await this.probeSessionAttachedForReconcile(String(row.name));
      if (attached !== false) {
        continue;
      }

      // ST-R2 FINAL GATE: live session MUST carry @helm_child. Untagged / probe error → fail-safe KEEP.
      let helmTagged = false;
      try {
        helmTagged = await this.tmux.sessionHasHelmChildTag(row.name);
      } catch (err) {
        helmTagged = false;
        console.warn('[session-janitor] @helm_child probe threw → treating as NOT-Helm, SKIP', {
          name: row.name,
          err: String(err),
        });
      }
      if (!helmTagged) {
        console.warn('[session-janitor] SKIP: session missing @helm_child tag → never reap (not Helm-created)', {
          name: row.name,
        });
        continue;
      }

      // Targeted terminate only. S12-V2: markReaped only on success, or post-fail if provably gone.
      // In shadow mode, decide only; no termination + no persistence mutation.
      if (shadowMode) {
        console.warn('[session-janitor][shadow] WOULD REAP row (no terminate)', {
          name: row.name,
          reason: decision.reason,
        });
        continue;
      }
      // A failed kill with session still live/unknown leaves the row retryable (level-triggered).
      // B02: carry snapshot CAS token through terminate + markReaped (no name-only write).
      // B05 fix cycle 1 / AC5: exactStatusOnly — the janitor's own pre-terminate claim must match
      // the snapshot's status exactly (idle), not merely "still active or idle", so a same-id/name/
      // owner/generation row that flipped back to active since the snapshot aborts the kill.
      const reapToken = sessionStatusTokenFromRow(row, { exactStatusOnly: true });
      try {
        await this.tmux.terminateSession(row.name, { sessionToken: reapToken });
        try {
          this.sessionRegistry.markReaped(reapToken, `reconcile:${decision.reason}`);
        } catch {}
      } catch (err) {
        console.warn('[session-janitor] terminateSession failed (best-effort)', { name: row.name, err: String(err) });
        const afterExists = await this.probeSessionExistsForReconcile(String(row.name));
        if (afterExists === false) {
          // Race: session gone despite throw — converge record only (same snapshot token).
          try {
            this.sessionRegistry.markReaped(reapToken, 'reconcile:session_gone');
          } catch {}
        }
        // else still live or unknown → leave eligible for next tick (no false reaped).
      }
    }
  }

  // S12 startup reconcile: same guarded path as the tick (level-triggered, idempotent).
  // Disable with HELM_SESSION_JANITOR=off (or 0).
  async sweepOrphanSessionsAtStartup(): Promise<void> {
    if (!this.sessionRegistry) return;
    const cfg = loadConfig() as any;
    if (cfg.HELM_SESSION_JANITOR === "off") return;
    await this.sessionJanitorTick();
  }

  /**
   * S12: fail-safe existence fact for decideSessionReconcile.
   * true = live, false = provably gone, null = unknown (KEEP — never over-CONVERGE).
   * Prefers TmuxService.sessionExistsTriState when present; maps boolean sessionExists as fallback.
   */
  private async probeSessionExistsForReconcile(name: string): Promise<boolean | null> {
    const tmux = this.tmux as TmuxService & {
      sessionExistsTriState?: (n: string) => Promise<boolean | null>;
    };
    try {
      if (typeof tmux.sessionExistsTriState === 'function') {
        const v = await tmux.sessionExistsTriState(name);
        if (v === true || v === false || v === null) return v;
        return null;
      }
      // Fallback: boolean sessionExists cannot express unknown — treat throw as unknown.
      return await this.tmux.sessionExists(name);
    } catch (err) {
      console.warn('[session-janitor] existence probe failed → unknown (KEEP)', { name, err: String(err) });
      return null;
    }
  }

  /**
   * S12-V1: fail-safe attachment for REAP veto.
   * true = attached (KEEP), false = unattached (may REAP), null = unknown (KEEP, keep-biased).
   */
  private async probeSessionAttachedForReconcile(name: string): Promise<boolean | null> {
    const tmux = this.tmux as TmuxService & {
      sessionAttached?: (n: string) => Promise<boolean | null>;
    };
    try {
      if (typeof tmux.sessionAttached !== 'function') {
        // No reader → unknown → KEEP (never REAP without a positive unattached fact).
        return null;
      }
      const v = await tmux.sessionAttached(name);
      if (v === true || v === false || v === null) return v;
      return null;
    } catch (err) {
      console.warn('[session-janitor] attachment probe failed → unknown (KEEP)', { name, err: String(err) });
      return null;
    }
  }

  // Execution veto helper: is the run mapped to this session terminal (complete/failed/blocked)?
  // Used only as a REAP veto (defense-in-depth), never as kill authority.
  private isRunTerminalForSession(runId: number | null | undefined): boolean {
    if (runId == null) return false;
    try {
      const run = this.db.prepare("SELECT status, phase FROM runs WHERE id = ?").get(runId) as any;
      // AC3/F-10: a missing row is uncertainty, not proof the run finished — veto REAP (fail-safe,
      // matches the query-error branch below), never assert completion from absence.
      if (!run) return false;
      const status = String(run.status || '').toLowerCase();
      const phase = String(run.phase || '').toLowerCase();
      return ['complete', 'failed'].includes(status) || ['complete', 'failed', 'blocked'].includes(phase);
    } catch {
      return false; // unknown → do NOT treat as terminal (fail-safe: veto REAP)
    }
  }

  // SL-R4 helper: is there a live (launching/running) worker_runtime bound to this session name?
  // A live worker vetoes REAP of its session (active-run guardrail).
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
