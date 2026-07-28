import path from "node:path";
import os from "node:os";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import Database from "better-sqlite3";
import { loadConfig } from "./config/config.js";
import { DatabaseService } from "./db/database.js";
import { warnModelBindingDivergences } from "./services/model-binding-check.js";
import { resolveRunDir } from "./services/run-paths.js";
import { PROVIDERS } from "./config/providers.js";
import { AuthService } from "./auth/auth-service.js";
import { createAuthMiddleware, createRequireOwner, createSseAuthMiddleware } from "./auth/auth-middleware.js";
import { registerAuthRoutes } from "./api/routes/auth-routes.js";
import { registerProjectAgentRoutes } from "./api/routes/project-agent-routes.js";
import { registerPhaseAgentRoutes } from "./api/routes/phase-agent-routes.js";
import { registerPlannerPanelRoutes } from "./api/routes/planner-panel-routes.js";
import { registerProjectRoleRosterRoutes } from "./api/routes/project-role-roster-routes.js";
import {
  isLoopbackAddress,
  createRequireLocalLaunch,
  AGENT_ROLES
} from "./guardrails.js";

// M10: static imports (top level)
import { AgentAssignmentService } from "./services/agent-assignment-service.js";
import { PhaseStaffingService } from "./services/phase-staffing.js";
import { ToolkitService } from "./services/toolkit-service.js";
import { MasterModelService } from "./services/master-model-service.js";
import { TmuxService } from "./tmux/tmux-service.js";
import { AgentEventsService } from "./services/agent-events-service.js";
import { parseCallbacksMd, toRunChatMessages, mergeChatMessages, CallbackTsCache, tsToMs } from "./services/run-chat-merge.js";
import { ProviderResolverService } from "./services/provider-resolver-service.js";
import { createScopedChatSidPre } from "./services/delivery-channel.js";
import { MasterRuntimeService } from "./services/master-runtime-service.js";
import { WorkerService } from "./services/worker-service.js";
import { HelmIdentityService, requireActiveNativeProject } from "./services/helm-identity-service.js";
import { SessionRegistryService } from "./services/session-registry-service.js";
import { SessionCloseService } from "./services/session-close-service.js";
import { registerSessionCloseRoutes } from "./api/routes/session-close-routes.js";
import { HousekeeperService } from "./services/housekeeper-service.js";
import { HouseUsageSelector } from "./services/house-usage-selector.js";
import { registerHousekeeperRoutes } from "./api/routes/housekeeper-routes.js";
import { configureWorkerRuntimeFinalize } from "./services/worker-runtime-finalize.js";
import { UsageGatewayService } from "./services/usage-gateway-service.js";
import { ModelService } from "./services/model-service.js";
import { RoleTierService } from "./services/role-tier-service.js";
import { TierResolutionService } from "./services/tier-resolution-service.js";
import { makeGrokAwareSlugAvailability } from "./services/grok-auth-availability.js";
import { aggregateImplL3Invocations } from "./services/impl-l3-telemetry.js";
import { IntendedActualService } from "./services/intended-actual-service.js";
import { TopologyFreezeService } from "./services/topology-freeze-service.js";
import { ModelValidationService } from "./services/model-validation-service.js";
import { KlooDiscoveryService } from "./services/kloo-discovery-service.js";
import { ChatSessionService, AgentBusyError } from "./services/chat-session-service.js";
import { PlumbingWatcherService } from "./services/plumbing-watcher-service.js";
import { ProjectService, serializeProjectTags } from "./services/project-service.js";
import { ProjectAgentService } from "./services/project-agent-service.js";
import { PlannerPanelService } from "./services/planner-panel-service.js";
import { ProjectDocsService } from "./services/project-docs-service.js";
import { ProjectStatusService } from "./services/project-status-service.js";
import { TaskService } from "./services/task-service.js";
import { CycleService } from "./services/cycle-service.js";
import { CycleDocsService } from "./services/cycle-docs-service.js";
import { CycleChatFileService } from "./services/cycle-chat-file-service.js";
import { CANONICAL_CYCLE_ARTIFACTS } from "./services/cycle-artifact-paths.js";
import { maybeAutoStartCycleImplementation, startCycleImplementationAfterApproval } from "./services/cycle-auto-start.js";
import { MemoryService } from "./services/memory-service.js";
import { AgentProposalService } from './services/agent-proposal-service.js';
import {
  decisionActorFromIngest,
  decisionActorFromRequestUser,
} from "./services/decision-authority.js";
import { getWriteFenceStatus } from "./security/landlock-sandbox.js";
import { runCliFreshnessPreflight } from "./services/cli-preflight.js";
import { RunArtifactService } from "./services/run-artifact-service.js";
import { RunIngestService, RunIngestValidationError, RunIngestConflictError } from "./services/run-ingest-service.js";
import { TrackingReadService } from "./services/ovm-tracking-read-service.js";
import { PlanParserService } from "./services/plan-parser-service.js";
import { PlanningPhaseService } from "./services/planning-phase-service.js";
import { TaskQueueService } from "./services/task-queue-service.js";
import { RunOrchestratorService } from "./services/run-orchestrator-service.js";
import type { ITransport } from "./services/fake-transport.js";
import { FakeTransport } from "./services/fake-transport.js";
import { RealTransport } from "./services/real-transport.js";
import { EscalationService } from "./services/escalation-service.js";
import { TeamService } from "./services/team-service.js";
import { PanelService } from "./services/panel-service.js";
import { RoutingConfigService, RoutingCoreProtectedError, RoutingValidationError } from "./services/routing-config-service.js";

// Test-only tmux stub (USE_FAKE_TMUX=1) so e2e/dev can exercise spawn→running→reap
// deterministically without a real CLI. Implements every method MasterRuntimeService +
// WorkerService call; readyProbe signal present in capturePane so workers reach 'running'.
class FakeTmuxService {
  private readonly panes = new Map<string, string>();
  private readonly bootstraps = new Map<string, string>();

  private basePane() { return '❯ ready\n> ready\n'; }

  async createSession(name: string) {
    const target = `${name}:0.0`;
    this.panes.set(target, this.basePane());
    return target;
  }
  async sendCommand(target: string, _cmd: string, _a?: boolean, _b?: boolean) {
    if (!this.panes.has(target)) this.panes.set(target, this.basePane());
    return true;
  }
  async sendAndSubmit(target: string, text: string) {
    const cur = this.panes.get(target) ?? this.basePane();
    this.panes.set(target, `${cur}\n${text}\n`);
    if (text.includes('HELM_BOOTSTRAP_END:')) {
      this.bootstraps.set(target, text);
    } else {
      const boot = this.bootstraps.get(target) ?? '';
      const roleMatch = boot.match(/role:\s*([^\n]+)/i) || boot.match(/#\s+([^\n—]+)/);
      const roleHint = roleMatch ? roleMatch[1].trim() : 'configured agent';
      const reply = `Agent: I am the ${roleHint}. Per injected rules I use Helm app/project memory (not native CLI memory) and I am in Helm test-chat mode.\n`;
      this.panes.set(target, `${this.panes.get(target)!}${reply}`);
    }
    return true;
  }
  async sendKeys(_target: string, _keys: string) { return true; }
  async getPanePid(_target: string) { return '12345'; }
  async sessionExists(_name: string) { return true; }
  async terminateSession(_name: string) { }
  async terminatePane(_target: string) { }
  async forceKillPane(_target: string) { }
  // S14a V4: human-close tag gate under USE_FAKE_TMUX=1 — treat fake sessions as Helm-created.
  async sessionHasHelmChildTag(_name: string) { return true; }
  async sessionActivity(_name: string) { return null; }
  async sessionAttached(_name: string) { return null; }
  async capturePane(target: string, _lines = 200) { return this.panes.get(target) ?? this.basePane(); }
  async waitForReady(_target: string, _signal = '❯', _timeoutMs = 30000) { return true; }

  // B7 DSP7: support clear under fake (for server boot tests + consistency with real TmuxService)
  async clearContext(target: string, provider: string = 'codex') {
    return { issued: true, verified: true, postCapture: '❯ ready\n> ready\nHuman: ' };
  }

  // A1: support compact under fake (mirrors clearContext fake, for server boot tests + consistency with real TmuxService)
  async compactContext(target: string, provider: string = 'codex') {
    return { issued: true, verified: true, postCapture: '❯ ready\n> ready\nHuman: ' };
  }
}

class HousekeeperNoopTransport implements ITransport {
  async spawn(params: Parameters<ITransport['spawn']>[0]): Promise<{ handle: string; role: string }> {
    return {
      handle: `housekeeper-noop:${params.sessionName ?? params.role}`,
      role: params.role,
    };
  }

  async reap(_handle: string, _reason = 'complete'): Promise<void> {}
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main(): Promise<void> {
  const config = loadConfig();

  // C3: honest startup self-check. Verifies binary exists + executable, then probes Landlock (temp dir + /bin/true).
  // Reports UNAVAILABLE on any failure (never lies; fail-closed elsewhere). Status exposed on /health.
  const fence = getWriteFenceStatus();
  console.log(`[security] write-fence: ${fence.status} ${fence.detail ? "(" + fence.detail + ")" : ""}`);
  const writeFenceStatus = fence.status; // 'active' | 'UNAVAILABLE' — closed over for /health

  // Helm DB (WAL etc from prior phases)
  const db = new DatabaseService(config.dbPath);

  // Human authentication remains AGJAssist-backed. This handle is read-only and is never
  // injected into native project identity, tracking, ingest, master, or worker services.
  const agjDb = new Database(config.agjAssistDbPath, { readonly: true, fileMustExist: true });

  // O7.2: native identity is now mandatory and the ONE identity boundary — no external db, no
  // compatibility fallback. Constructed once here and injected into every launch-path service.
  const identityService = new HelmIdentityService(db);

  const app = Fastify({
    logger: false,
    bodyLimit: ((loadConfig() as any).PROJECT_DOC_BODY_MAX || 1048576) + 4096
  });

  // Serve static frontend (P1-1 unchanged)
  const publicDir = path.join(__dirname, "web/public");
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: "/",
    decorateReply: false,
    setHeaders: (res: any, filePath: string) => {
      // DEV/beta: the SPA bundle (app.js) + index.html change frequently. Without this, browsers
      // heuristically cache app.js and keep serving a STALE UI — the root cause of "new features
      // (kloo model form, routing, clear/compact) don't show". no-cache forces a conditional GET
      // (ETag) on every load: 304 when unchanged (fast), fresh bytes the moment the file changes.
      if (/\.(html|js)$/.test(filePath)) {
        res.setHeader("Cache-Control", "no-cache, must-revalidate");
      }
    }
  });

  // Health (P1-1)
  // C3: expose honest fence status (active only if binary present+executable and Landlock probe passed).
  app.get("/health", async () => {
    return {
      ok: true,
      service: "helm",
      version: "0.1.0",
      writeFence: writeFenceStatus,
      landlock: "ABIv4 via dist/tools/helm-sandbox (fail-closed; project-bound master/worker only)"
    };
  });

  // Auth reuse (lifted/adapted for shared JWT_SECRET + AGJ readonly user lookup for role)
  // HIGH red-team: generate SEPARATE master-chat secret IN-MEMORY at boot (never on disk/.env, masters can read via C3 fence).
  // Pass to AuthService so chat tokens use it (jwtSecret-signed tokens will be rejected by verifyMasterChatToken).
  // Re-issue at every master launch (H13) makes boot-time rotation sufficient.
  const masterChatSecret = randomBytes(32).toString('hex');
  const authService = new AuthService(
    config.jwtSecret,
    agjDb,
    masterChatSecret,
    config.agjAssistJwtSecret
  );
  const authMiddleware = createAuthMiddleware(authService);
  const requireOwnerPre = createRequireOwner();
  const sseAuthPre = createSseAuthMiddleware(authService);
  registerAuthRoutes(app, authService, db.raw, { port: config.port });

  // P2-2: open SSE streams tracked per-project for (a) cap 5 conn/project (reject 429), (b) shutdown .end() on all before any db.close (consensus #7)
  const openSseByProject = new Map<number, Set<any>>();

  // C1 (A0): the /api/projects LIST source is the Helm-owned projects table (via ProjectService below).
  // O7.2: all per-:id active checks, /api/projects/setup, and slugs for worker/master session naming
  // resolve through the native identity boundary (identityService below) — no external db.
  // Guardrail primitives (H19) exported ready; attached to test route for observable preHandler behavior
  const requireLocalLaunchPre = createRequireLocalLaunch();
  app.get("/api/test/local", { preHandler: requireLocalLaunchPre }, async () => ({ ok: true }));

  // (vocab/safety can be exercised via unit tests on the pure fns; preHandler attached for guardrail test)
  // L2: removed dead requireVocabPre (was instantiated but not attached to main role paths)

  // P1-4: services for bindings + master chain (M10: static)
  const assignmentService = new AgentAssignmentService(db);
  const toolkitService = new ToolkitService(db);
  const modelService = new ModelService(db);
  const roleTierService = new RoleTierService(db);
  // B15c / R3.15: process-scoped tier resolve + in-memory stamps for telemetry UI (no orch wiring).
  // Mutable availability set lets fixture inject primary-down without rebuilding the service.
  // B12 / AC-18: also probe grok auth.json expires_at so a grok-primary seat with an ALREADY-
  // expired token lateral-fails over to backup (codex) pre-spawn — not a #53 post-spawn pause.
  const tierAvailDown = new Set<string>();
  const slugProviderCache = new Map<string, string | null>();
  const providerForSlug = (slug: string): string | null => {
    if (slugProviderCache.has(slug)) return slugProviderCache.get(slug)!;
    const row = db.raw.prepare('SELECT provider FROM models WHERE slug = ? LIMIT 1').get(slug) as
      | { provider: string }
      | undefined;
    const p = row?.provider != null ? String(row.provider) : null;
    slugProviderCache.set(slug, p);
    return p;
  };
  const tierResolutionService = new TierResolutionService(
    db,
    makeGrokAwareSlugAvailability(providerForSlug, {
      base: (slug) => !tierAvailDown.has(slug),
    }),
  );
  // B20 / R5.23: intended (freeze) vs actual (resolve stamps) with structural reason.
  const intendedActualService = new IntendedActualService(db);
  const topologyFreezeService = new TopologyFreezeService(db);
  /** Last fixture cycle for Telemetry UI intended-vs-actual panel (process-scoped). */
  let lastR523CycleId: number | null = null;
  const teamService = new TeamService(db);
  // RT0 H10: seed small default agent set on fresh DB / first run so bindings dropdowns populated
  if (assignmentService.listAgents().length === 0) {
    try {
      const seeded = assignmentService.createAgent({ name: 'grok-4.5', provider: 'grok', model: 'grok-4.5' });
      assignmentService.createAgent({ name: 'codex-5.5', provider: 'codex', model: 'gpt-5.5' });
      assignmentService.createAgent({ name: 'claude-sonnet', provider: 'claude', model: 'claude-sonnet-4-6' });
      // P2-1: default the worker 'implementer' role to a non-claude agent so worker spawn works
      // out-of-box on a set-up project (resolveProjectRole returns this when no per-project binding).
      assignmentService.setRoleDefault('implementer', seeded.id);
    } catch {}
  }
  const masterService = new MasterModelService(db, identityService);

  // P1-5 runtime + events for chat (ensure running, record, send) (M10 static)
  // M2: strict gate — only the exact value '1' enables the fake (and never in production), so a
  // stray USE_FAKE_TMUX=0/false or inherited env can't silently disable real tmux launches.
  const useFakeTmux = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production';
  const tmuxService: TmuxService = (useFakeTmux ? new FakeTmuxService() : new TmuxService()) as unknown as TmuxService;
  // SL-R1: session registry wired into the shared tmuxService's create/terminate choke point so EVERY
  // Helm session (RealTransport, WorkerService, MasterRuntimeService, ChatSessionService,
  // ModelValidationService) is captured centrally. Real TmuxService only (FakeTmuxService has no hook).
  const sessionRegistry = new SessionRegistryService(db);
  // S14a: human manual close (owner=human only). Uses shared tmuxService; tests inject fake via service unit tests.
  const sessionCloseService = new SessionCloseService(sessionRegistry, tmuxService as any);
  if (typeof (tmuxService as any).setRegistryHook === 'function') {
    (tmuxService as any).setRegistryHook({
      // A2 + S05: forward projectId/runId/kind/owner from createSession so helm_sessions
      // rows land linked with decision authority at the choke point. Owner is required pre-spawn
      // in createSession; register() also refuses missing owner (defensive).
      onCreate: (name: string, opts?: { projectId?: number | null; runId?: number | null; kind?: string; owner?: 'helm' | 'human' | 'legacy:unknown' }) => {
        try { sessionRegistry.register(name, opts as any); } catch {}
      },
      onTerminate: (name: string) => { try { sessionRegistry.markReaped(name); } catch {} },
      // SL-R2/R4: active-input refreshes last_used_at so the TTL means "idle for TTL" (in-use sessions kept).
      onUse: (name: string) => { try { sessionRegistry.touch(name); } catch {} }
    });
  }
  // S02: wire markIdle into shared worker_runtimes finalizer (no SQL dup — reuses SessionRegistryService).
  // First successful terminal transition asserts helm_sessions idle so the janitor later sees ownership truth.
  configureWorkerRuntimeFinalize({
    markIdle: (name, reason) => {
      try { sessionRegistry.markIdle(name, reason); } catch {}
    },
  });
  const modelValidationService = new ModelValidationService(db, undefined, {}, tmuxService);
  // B2 (kloo/D3+D5): runtime discovery of kloo routes (profiles.json) + per-route live model catalog.
  const klooDiscovery = new KlooDiscoveryService();
  const eventsService = new AgentEventsService(db);
  // CC-CHAT-2 R3: first-seen timestamps for run callback lines (callbacks.md has no per-line time)
  const runCbTsCache = new CallbackTsCache();
  const resolverService = new ProviderResolverService();
  // P2-3: UsageGatewayService ctor-injected (tests can pass fake; no shell-out in unit tests)
  const usageGateway = new UsageGatewayService();
  const runtimeService = new MasterRuntimeService(db, eventsService, tmuxService, resolverService, masterService, usageGateway, assignmentService, toolkitService, authService, identityService);

  // H4: wire supervisor at boot
  runtimeService.startSupervisor();
  // P2-3: start auto-fallback tick (separate cadence, after supervisor)
  runtimeService.startAutoFallback();

  // P2-1: worker service + reaper. SL-R3: session registry injected so the 60s reaper also runs the
  // session janitor (helm_sessions cleanup under the SL-R4 guardrails).
  const workerService = new WorkerService(db, eventsService, tmuxService, resolverService, assignmentService, toolkitService, sessionRegistry, identityService);
  workerService.startReaper();
  // SL-R3 startup sweep: clear orphan sessions left by a crash/restart (terminal-run / no-run, past TTL).
  void workerService.sweepOrphanSessionsAtStartup();

  // E1: MemoryService (M1 + M2-backend). Wired before test-chat so B6b R-16 can inject app memories.
  const memoryService = new MemoryService(db);

  // C1: Helm-owned ProjectService (A0/P1). Declared before the test-chat transport so bootstraps can
  // inject the authoritative project directory/name/dev-url (pulled live from the project row).
  const projectService = new ProjectService(db);
  const phaseStaffingService = new PhaseStaffingService(assignmentService);
  registerPhaseAgentRoutes(app, {
    projectService,
    phaseStaffingService,
    authMiddleware,
    requireOwnerPre,
  });

  // C1 KEY-C1: agent test-chat transport (SSE+POST, DELIB consensus). Ephemeral in-memory
  // sessions; reuses the shared tmux/model/assignment/resolver services. fenceDir mirrors
  // RealTransport (HELM_FENCE_DIR || cwd) — config has no fenceDir field.
  const chatSessionService = new ChatSessionService({
    tmux: tmuxService,
    modelService,
    assignmentService,
    resolverService,
    memoryService,
    projectService,
    fenceDir: process.env.HELM_FENCE_DIR || process.cwd()
  });

  // F2 round-8 (finding #1): SID↔scope binding. ONE shared pre-handler resolves the session and verifies the
  // route scope (project:<pid> / studio:<agentId>) actually owns the :sid BEFORE any channel is selected —
  // applied to EVERY scoped chat :sid route so message/stream/ack (and logs/end/clear/compact/terminal) cannot
  // drift. On success it stashes the VALIDATED channel on request.deliveryChannel for the handler.
  const scopedChatSidPre = createScopedChatSidPre(chatSessionService);

  // B3a: PlumbingWatcherService (watcher-of-watchers substrate, exactly per consensus §1/§4)
  // Watches phase-brain master_runtimes rows. PRIMARY hash over task/agent_events, SECONDARY hb (never beats stale hash), TERTIARY tmux classify-only.
  // Emits to agent_events on transitions (SSE for B3b). Auto-pause on parked/failed. Recovery via master runtime supervisor.
  // Self-config + JROM via service (bounded). Context Steward checkpoint logging (v1).
  const plumbingWatcher = new PlumbingWatcherService(db, eventsService, tmuxService, runtimeService);
  plumbingWatcher.startWatchLoop();

  const projectStatusService = new ProjectStatusService(projectService, tmuxService);

  // C2: ProjectAgentService (P2). Per-project agents + overrides (dynamic from GLOBAL models pool, exactly-1 primary, set-to-default, add-all idempotent).
  const projectAgentService = new ProjectAgentService(db, assignmentService);

  // v93: per-project adaptive planner panel (members / lead / backups / default effort).
  const plannerPanelService = new PlannerPanelService(db);

  // C4/B13: ProjectDocsService (P4). Read .md review surface + B13 helm_docs write/delete (owner-guarded PUT/DELETE).
  const projectDocsService = new ProjectDocsService(projectService);

  // B2-T01: CycleService (create only for this slice). Folder creation fenced to project.directory.
  const cycleService = new CycleService(db, projectService);
  const cycleDocsService = new CycleDocsService(cycleService);
  // B8 / R6.27: thin HTTP over B7 CycleChatFileService (project tmp/<cycle-folder>/ chat-files).
  const cycleChatFileService = new CycleChatFileService(cycleService);

  // D3: TaskService (C3r). list/upsert for per-project tasks + roster derivation from runtimes.
  // Coordinator updates exclusively via the sanctioned /ingest/task-update (project_id from token claim).
  const taskService = new TaskService(db);

  const agentProposalService = new AgentProposalService(db, assignmentService);

  // RunOrchestratorService wiring (phase-specific discovery/plancore/ibrain sessions).
  // A2b: real EscalationService (B8 ladder) + PanelService (B10 red-team) now passed for full live path
  const runArtifactService = new RunArtifactService(db);
  const runIngestService = new RunIngestService(db);
  const trackingReadService = new TrackingReadService(db);
  const planParser = new PlanParserService(runArtifactService);
  const taskQueue = new TaskQueueService(runArtifactService);
  // A2 (R4.16): RealTransport MUST use the shared hooked tmuxService. A private new TmuxService()
  // would bypass the session-registry choke point, so planning seats never landed in helm_sessions
  // (or landed unlinked). Workers already used this shared instance; planning now matches.
  const orchT: ITransport = useFakeTmux
    ? new FakeTransport()
    : new RealTransport({ artifacts: runArtifactService, tmux: tmuxService });
  const housekeeperService = new HousekeeperService(
    db,
    sessionRegistry,
    tmuxService as any,
    new HouseUsageSelector({ gateway: usageGateway }),
    new HousekeeperNoopTransport(),
  );
  const planningPhase = new PlanningPhaseService(orchT, runArtifactService, taskQueue);
  const escalationService = new EscalationService(db, usageGateway, assignmentService);  // B9fix2 F4: project escalation ladder via resolver
  const panelService = new PanelService(orchT, runArtifactService);
  const routingConfigService = new RoutingConfigService(db);  // A4: OrchestratorLoop consults this (routeFor); A3 seed matches hardcoded FSM => zero behavior change on real runs
  const runOrchestratorService = new RunOrchestratorService({
    artifacts: runArtifactService,
    planning: planningPhase,
    parser: planParser,
    queue: taskQueue,
    transport: orchT,
    projectService,
    assignmentService,
    escalationService,
    panelService,
    routingConfig: routingConfigService,
    events: eventsService,  // CC-CHAT-2 R3: startRunDetached persists the run prompt as an owner chat bubble
    cycleService,  // IS-R1 (impl-start): cycle-plan implementation-only path resolves <cycle folder>/execution_plan.md
    masterRuntime: runtimeService,  // A1a: seat-binary pre-flight refuses a run whose rostered CLI is missing on the seat PATH
    plannerPanelService,  // v93: adaptive planner panel config when adaptive_planning ON
  });

  // agents list for Project Setup UI (owner can list)
  // RT0 H10: owner pre + POST create + seed defaults for dropdowns
  app.get('/api/agents', { preHandler: [authMiddleware, requireOwnerPre] }, async () => ({ agents: assignmentService.listAgents() }));

  app.post('/api/agents', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    try {
      const body = request.body || {};
      const def = body.definition_md;
      const max = (loadConfig() as any).AGENT_DEFINITION_MAX || 50000;
      if (def && typeof def === 'string' && def.length > max) {
        return reply.code(400).send({ error: 'definition_md too long (max ' + max + ')' });
      }
      const actor = decisionActorFromRequestUser(request.user);
      const agent = assignmentService.createAgent(body, { surface: 'studio', actor });
      return { agent };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  // P3-1: GET /agents/:id (owner)
  // B08/R2.6: expose identity (definition_md) + tier model bindings separately from agent row.
  app.get('/api/agents/:id', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    const agent = assignmentService.getAgent(id);
    if (!agent) return reply.code(404).send({ error: 'unknown agent' });
    return {
      agent,
      identity: agent.definition_md,
      tiers: assignmentService.listAgentTierModels(id),
    };
  });

  // B08/R2.6: GET tier model bindings for one agent prompt (L1/L2/L3).
  app.get('/api/agents/:id/tiers', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    const agent = assignmentService.getAgent(id);
    if (!agent) return reply.code(404).send({ error: 'unknown agent' });
    return {
      agent_id: id,
      identity: agent.definition_md,
      tiers: assignmentService.listAgentTierModels(id),
    };
  });

  // B08/R2.6: PUT tier model bindings without touching prompt identity.
  app.put('/api/agents/:id/tiers', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    if (!assignmentService.getAgent(id)) return reply.code(404).send({ error: 'unknown agent' });
    try {
      const body = request.body || {};
      const partial: {
        L1?: number | null;
        L1_backup?: number | null;
        L2?: number | null;
        L3?: number | null;
      } = {};
      if ('L1' in body) partial.L1 = body.L1 == null ? null : Number(body.L1);
      if ('L1_backup' in body) partial.L1_backup = body.L1_backup == null ? null : Number(body.L1_backup);
      if ('L2' in body) partial.L2 = body.L2 == null ? null : Number(body.L2);
      if ('L3' in body) partial.L3 = body.L3 == null ? null : Number(body.L3);
      const result = assignmentService.bindAgentTierModels(id, partial);
      return result;
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  // P3-1: PUT /agents/:id (owner + local launch)
  app.put('/api/agents/:id', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    const body = request.body || {};
    const def = body.definition_md;
    const max = (loadConfig() as any).AGENT_DEFINITION_MAX || 50000;
    if (def && typeof def === 'string' && def.length > max) {
      return reply.code(400).send({ error: 'definition_md too long (max ' + max + ')' });
    }
    if (!assignmentService.getAgent(id)) return reply.code(404).send({ error: 'unknown agent' }); // red-team M2: 404 before update
    try {
      // B10b/R2.10: trusted actor from verified token only (never body)
      const actor = decisionActorFromRequestUser(request.user);
      const agent = assignmentService.updateAgent(id, body, { surface: 'studio', actor });
      return { agent };
    } catch (e: any) {
      if (e.code === 'FORBIDDEN') return reply.code(403).send({ error: e.message });
      if (!assignmentService.getAgent(id)) return reply.code(404).send({ error: 'unknown agent' });
      if (e.message && e.message.includes('unique')) return reply.code(400).send({ error: e.message });
      return reply.code(400).send({ error: e.message });
    }
  });

  // P3-1: DELETE /agents/:id (owner + local launch); 409 if bound (preflight both tables)
  app.delete('/api/agents/:id', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    if (!assignmentService.getAgent(id)) return reply.code(404).send({ error: 'unknown agent' }); // red-team M1: 404, not silent 200, on unknown id
    try {
      assignmentService.deleteAgent(id);
      return { ok: true };
    } catch (e: any) {
      if (!assignmentService.getAgent(id)) return reply.code(404).send({ error: 'unknown agent' });
      if (e.message && e.message.includes('bound')) return reply.code(409).send({ error: e.message });
      return reply.code(400).send({ error: e.message });
    }
  });

  // B6a: Teams CRUD + members (owner + local for mutations). Mirror agents/models style.
  app.get('/api/teams', { preHandler: [authMiddleware, requireOwnerPre] }, async () => ({ teams: teamService.listTeams() }));
  app.get('/api/teams/:id', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    const t = teamService.getTeam(id);
    if (!t) return reply.code(404).send({ error: 'unknown team' });
    return { team: t, members: teamService.listMembers(id) };
  });
  app.post('/api/teams', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    try {
      const t = teamService.createTeam(request.body || {});
      return { team: t };
    } catch (e: any) {
      if (e.message && e.message.includes('unique')) return reply.code(409).send({ error: e.message });
      return reply.code(400).send({ error: e.message });
    }
  });
  app.put('/api/teams/:id', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    if (!teamService.getTeam(id)) return reply.code(404).send({ error: 'unknown team' });
    try {
      const t = teamService.updateTeam(id, request.body || {});
      return { team: t };
    } catch (e: any) {
      if (!teamService.getTeam(id)) return reply.code(404).send({ error: 'unknown team' });
      if (e.message && e.message.includes('unique')) return reply.code(409).send({ error: e.message });
      return reply.code(400).send({ error: e.message });
    }
  });
  app.delete('/api/teams/:id', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    if (!teamService.getTeam(id)) return reply.code(404).send({ error: 'unknown team' });
    try {
      teamService.deleteTeam(id);
      return { ok: true };
    } catch (e: any) {
      if (!teamService.getTeam(id)) return reply.code(404).send({ error: 'unknown team' });
      if (e.message && e.message.includes('bound')) return reply.code(409).send({ error: e.message });
      return reply.code(400).send({ error: e.message });
    }
  });
  app.post('/api/teams/:id/members', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    if (!teamService.getTeam(id)) return reply.code(404).send({ error: 'unknown team' });
    try {
      const m = teamService.addMember(id, request.body || {});
      return { member: m };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });
  app.delete('/api/teams/:id/members/:mid', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const tid = Number(request.params.id);
    const mid = Number(request.params.mid);
    if (!teamService.getTeam(tid)) return reply.code(404).send({ error: 'unknown team' });
    teamService.removeMember(tid, mid);
    return { ok: true };
  });

  // B16 / R4.18–R4.19: studio team×tier model lists (budget|standard|elite). No UI (B17).
  const mapTeamTierError = (e: any): { status: number; body: { error: string } } => {
    const msg = String(e?.message || e);
    if (/already exists|unique|duplicate model_id/i.test(msg)) return { status: 409, body: { error: msg } };
    if (/unknown team tier/i.test(msg)) return { status: 404, body: { error: msg } };
    if (/invalid team_type|invalid tier|unknown model id|model_ids must/i.test(msg)) {
      return { status: 400, body: { error: msg } };
    }
    return { status: 400, body: { error: msg } };
  };
  app.get('/api/team-tiers', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any) => {
    const teamType = request.query?.team_type != null ? String(request.query.team_type) : undefined;
    return { team_tiers: teamService.listTeamTiers(teamType) };
  });
  app.get('/api/team-tiers/:team_type', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    try {
      return {
        team_type: String(request.params.team_type),
        team_tiers: teamService.listTeamTiers(String(request.params.team_type)),
      };
    } catch (e: any) {
      const mapped = mapTeamTierError(e);
      return reply.code(mapped.status).send(mapped.body);
    }
  });
  app.get('/api/team-tiers/:team_type/:tier', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    try {
      const row = teamService.getTeamTier(String(request.params.team_type), String(request.params.tier));
      if (!row) return reply.code(404).send({ error: 'unknown team tier' });
      return { team_tier: row };
    } catch (e: any) {
      const mapped = mapTeamTierError(e);
      return reply.code(mapped.status).send(mapped.body);
    }
  });
  app.put('/api/team-tiers/:team_type/:tier', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    try {
      const body = request.body || {};
      const modelIds = body.model_ids ?? body.models ?? [];
      const row = teamService.setTeamTierModels(
        String(request.params.team_type),
        String(request.params.tier),
        modelIds
      );
      return { team_tier: row };
    } catch (e: any) {
      const mapped = mapTeamTierError(e);
      return reply.code(mapped.status).send(mapped.body);
    }
  });
  app.delete('/api/team-tiers/:team_type/:tier', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    try {
      if (!teamService.getTeamTier(String(request.params.team_type), String(request.params.tier))) {
        return reply.code(404).send({ error: 'unknown team tier' });
      }
      teamService.clearTeamTier(String(request.params.team_type), String(request.params.tier));
      return { ok: true };
    } catch (e: any) {
      const mapped = mapTeamTierError(e);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  // B6b: agent_escalations CRUD (for studio ladder editor)
  app.get('/api/agents/:id/escalations', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    if (!assignmentService.getAgent(id)) return reply.code(404).send({ error: 'unknown agent' });
    return { escalations: assignmentService.listAgentEscalations(id) };
  });
  app.put('/api/agents/:id/escalations', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    if (!assignmentService.getAgent(id)) return reply.code(404).send({ error: 'unknown agent' });
    try {
      const body = request.body || {};
      const rungs = body.rungs !== undefined ? body.rungs : (body || []);
      const esc = assignmentService.setAgentEscalations(id, rungs);
      return { escalations: esc };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });
  app.delete('/api/agents/:id/escalations/:pos', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    const pos = Number(request.params.pos);
    if (!assignmentService.getAgent(id)) return reply.code(404).send({ error: 'unknown agent' });
    assignmentService.deleteAgentEscalation(id, pos);
    return { ok: true };
  });

  // B1 + B2 + B05: Models shared library. Owner-guarded + local for muts. Errors: 400/409/404.
  // B05 R1.1 cascade: static filter routes BEFORE /:id so "clis"/"providers" are not captured as ids.
  // GET /api/models?cli=&provider= filters; GET /api/models/clis; GET /api/models/providers?cli=.
  // POST/PUT missing/empty cli → 400 structured { error, field: 'cli' } (B03b service + B05 route).
  const modelApiError = (e: any) => {
    const msg = String(e?.message || e);
    if (/cli is required/i.test(msg)) return { status: 400, body: { error: msg, field: 'cli' } };
    if (msg.includes('unique')) return { status: 409, body: { error: msg } };
    return { status: 400, body: { error: msg } };
  };

  app.get('/api/models/clis', { preHandler: [authMiddleware, requireOwnerPre] }, async () => ({
    clis: modelService.listClis()
  }));
  app.get('/api/models/providers', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any) => {
    const cli = request.query?.cli != null ? String(request.query.cli) : undefined;
    return { providers: modelService.listProviders(cli) };
  });
  app.get('/api/models', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any) => {
    const q = request.query || {};
    const filter: { cli?: string; provider?: string } = {};
    if (q.cli != null && String(q.cli).trim()) filter.cli = String(q.cli).trim();
    if (q.provider != null && String(q.provider).trim()) filter.provider = String(q.provider).trim();
    return {
      models: modelService.listModels(
        filter.cli || filter.provider ? filter : undefined
      )
    };
  });
  app.get('/api/models/:id', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    const m = modelService.getModel(id);
    if (!m) return reply.code(404).send({ error: 'unknown model' });
    return { model: m };
  });
  app.post('/api/models', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    try {
      const m = modelService.createModel(request.body || {});
      return { model: m };
    } catch (e: any) {
      const mapped = modelApiError(e);
      return reply.code(mapped.status).send(mapped.body);
    }
  });
  app.put('/api/models/:id', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    const body = request.body || {};
    if (!modelService.getModel(id)) return reply.code(404).send({ error: 'unknown model' });
    try {
      const m = modelService.updateModel(id, body);
      return { model: m };
    } catch (e: any) {
      if (!modelService.getModel(id)) return reply.code(404).send({ error: 'unknown model' });
      const mapped = modelApiError(e);
      return reply.code(mapped.status).send(mapped.body);
    }
  });
  app.delete('/api/models/:id', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    if (!modelService.getModel(id)) return reply.code(404).send({ error: 'unknown model' });
    try {
      modelService.deleteModel(id);
      return { ok: true };
    } catch (e: any) {
      if (e.message && e.message.includes('in use by agents')) return reply.code(409).send({ error: e.message });
      return reply.code(400).send({ error: e.message });
    }
  });

  // B12a / R3.12: studio role_tiers CRUD (implementer|validator × L1|L2|L3 × primary+backup). API only (no UI).
  // Static list routes before param routes. Mutations require owner + local launch.
  const roleTierApiError = (e: any) => {
    const msg = String(e?.message || e);
    if (/already exists/i.test(msg)) return { status: 409, body: { error: msg } };
    if (/unknown role tier/i.test(msg)) return { status: 404, body: { error: msg } };
    if (/unknown model id/i.test(msg)) return { status: 400, body: { error: msg } };
    if (/invalid (role|tier)/i.test(msg)) return { status: 400, body: { error: msg } };
    // B13 / R3.16: save-time invariant violations surface as 400 with clear message (API-level; no B12c UI toast)
    if (/role_tier invariant/i.test(msg)) return { status: 400, body: { error: msg } };
    return { status: 400, body: { error: msg } };
  };
  app.get('/api/role-tiers', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any) => {
    const role = request.query?.role != null ? String(request.query.role) : undefined;
    return { role_tiers: roleTierService.listRoleTiers(role) };
  });
  app.get('/api/role-tiers/:role', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    try {
      return { role: String(request.params.role), role_tiers: roleTierService.listRoleTiers(String(request.params.role)) };
    } catch (e: any) {
      const mapped = roleTierApiError(e);
      return reply.code(mapped.status).send(mapped.body);
    }
  });
  app.get('/api/role-tiers/:role/:tier', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    try {
      const row = roleTierService.getRoleTier(String(request.params.role), String(request.params.tier));
      if (!row) return reply.code(404).send({ error: 'unknown role tier' });
      return { role_tier: row };
    } catch (e: any) {
      const mapped = roleTierApiError(e);
      return reply.code(mapped.status).send(mapped.body);
    }
  });
  app.post('/api/role-tiers', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    try {
      const row = roleTierService.createRoleTier(request.body || {});
      return { role_tier: row };
    } catch (e: any) {
      const mapped = roleTierApiError(e);
      return reply.code(mapped.status).send(mapped.body);
    }
  });
  app.put('/api/role-tiers/:role/:tier', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    try {
      if (!roleTierService.getRoleTier(String(request.params.role), String(request.params.tier))) {
        return reply.code(404).send({ error: 'unknown role tier' });
      }
      const row = roleTierService.updateRoleTier(
        String(request.params.role),
        String(request.params.tier),
        request.body || {}
      );
      return { role_tier: row };
    } catch (e: any) {
      const mapped = roleTierApiError(e);
      return reply.code(mapped.status).send(mapped.body);
    }
  });
  app.delete('/api/role-tiers/:role/:tier', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    try {
      if (!roleTierService.getRoleTier(String(request.params.role), String(request.params.tier))) {
        return reply.code(404).send({ error: 'unknown role tier' });
      }
      roleTierService.deleteRoleTier(String(request.params.role), String(request.params.tier));
      return { ok: true };
    } catch (e: any) {
      const mapped = roleTierApiError(e);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  // B15c / R3.15 Reading B telemetry (implementer-only L3; M2 denom + M5 tier-entry bucket).
  app.get('/api/telemetry/impl-l3', { preHandler: [authMiddleware, requireOwnerPre] }, async () => {
    const view = aggregateImplL3Invocations(tierResolutionService.listInvocations());
    return {
      ...view,
      question: 'Of implementer L3 invocations, how many have cause=AVAILABILITY vs DIFFICULTY vs AS_INTENDED?',
      raw_stamp_count: tierResolutionService.listInvocations().length,
    };
  });
  // Real-path fixtures (not hand-inserted rows): DIFFICULTY+AVAIL chain + plain AVAIL L3-on-backup.
  app.post('/api/telemetry/fixtures/r315', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async () => {
    tierResolutionService.clearInvocations();
    tierResolutionService.endResolve();
    tierAvailDown.clear();

    // Scenario 1: DIFFICULTY L2→L3 then AVAIL L3 primary→backup (one inv, bucket DIFFICULTY, seat=backup)
    tierResolutionService.beginResolve('fixture-diff-then-avail');
    await tierResolutionService.resolveVertical('implementer', 'L2');
    tierAvailDown.add('codex55');
    await tierResolutionService.resolveLateral('implementer', 'L3');
    tierResolutionService.endResolve();
    tierAvailDown.clear();

    // Scenario 2: plain AVAIL L3-on-backup, no vertical (one inv, bucket AVAILABILITY, seat=backup)
    tierAvailDown.add('codex55');
    tierResolutionService.beginResolve('fixture-avail-only');
    await tierResolutionService.resolveLateral('implementer', 'L3');
    tierResolutionService.endResolve();
    tierAvailDown.clear();

    const view = aggregateImplL3Invocations(tierResolutionService.listInvocations());
    return { ok: true, loaded: ['fixture-diff-then-avail', 'fixture-avail-only'], ...view };
  });

  // B20 / R5.23 — Intended vs actual (cycle freeze vs resolve stamps; structural reason).
  app.get('/api/cycles/:id/intended-vs-actual', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const cycleId = Number(request.params.id);
    if (!Number.isInteger(cycleId) || cycleId <= 0) return reply.code(400).send({ error: 'invalid cycle id' });
    const freeze = topologyFreezeService.getFreeze(cycleId);
    if (!freeze) return reply.code(404).send({ error: 'cycle has no topology freeze', code: 'NO_FREEZE' });
    const deltas = intendedActualService.listDeltas(cycleId);
    const multi_cause_chains = intendedActualService.multiCauseChains(deltas);
    return {
      cycle_id: cycleId,
      frozen_at: freeze.frozen_at,
      intended: freeze.snapshot.role_tiers.map((r) => ({
        role: r.role,
        tier: r.tier,
        primary_model_slug: r.primary_model_slug ?? null,
        backup_model_slug: r.backup_model_slug ?? null,
      })),
      deltas,
      multi_cause_chains,
    };
  });
  // Process-scoped last fixture cycle (Telemetry UI one-button load).
  app.get('/api/telemetry/intended-vs-actual', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    if (lastR523CycleId == null) {
      return { cycle_id: null, deltas: [], multi_cause_chains: [], intended: [], frozen_at: null };
    }
    const freeze = topologyFreezeService.getFreeze(lastR523CycleId);
    if (!freeze) {
      return { cycle_id: lastR523CycleId, deltas: [], multi_cause_chains: [], intended: [], frozen_at: null };
    }
    const deltas = intendedActualService.listDeltas(lastR523CycleId);
    return {
      cycle_id: lastR523CycleId,
      frozen_at: freeze.frozen_at,
      intended: freeze.snapshot.role_tiers.map((r) => ({
        role: r.role,
        tier: r.tier,
        primary_model_slug: r.primary_model_slug ?? null,
        backup_model_slug: r.backup_model_slug ?? null,
      })),
      deltas,
      multi_cause_chains: intendedActualService.multiCauseChains(deltas),
    };
  });
  // Real-path R5.23 fixture: freeze cycle + DIFFICULTY vertical + COUPLING val (M3 B15b path).
  app.post('/api/telemetry/fixtures/r523', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const pathMod = await import('node:path');
    const projDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'helm-r523-'));
    let project;
    try {
      project = projectService.createProject({
        name: `r523-fixture-${Date.now()}`,
        directory: projDir,
      });
    } catch (e: any) {
      try { fs.rmSync(projDir, { recursive: true, force: true }); } catch { /* ignore */ }
      return reply.code(400).send({ error: e?.message || 'project create failed' });
    }
    const cycle = await cycleService.createCycle(project.id, 'R523', undefined, undefined, () => new Date());
    cycleService.setCyclePhase(cycle.id, 'implementation');
    const freeze = topologyFreezeService.getFreeze(cycle.id);
    if (!freeze) {
      return reply.code(500).send({ error: 'freeze failed for fixture cycle' });
    }

    tierResolutionService.clearInvocations();
    tierResolutionService.endResolve();
    tierAvailDown.clear();

    // Multi-cause chain (M3): impl DIFFICULTY vertical + val COUPLING from real B15b path.
    tierResolutionService.beginResolve('fixture-r523-coupling');
    const impl = await tierResolutionService.resolveVertical('implementer', 'L2');
    if (!impl.to_tier) {
      return reply.code(500).send({ error: 'vertical did not land (unexpected)' });
    }
    await tierResolutionService.resolveCoupledValidator('L2', impl.to_tier);
    tierResolutionService.endResolve();

    // Second chain: plain AVAIL lateral (variety across resolve_ids).
    tierAvailDown.add('codex55');
    tierResolutionService.beginResolve('fixture-r523-avail');
    await tierResolutionService.resolveLateral('implementer', 'L3');
    tierResolutionService.endResolve();
    tierAvailDown.clear();

    const stamps = tierResolutionService.listInvocations();
    const deltas = intendedActualService.recordFromStamps(cycle.id, stamps);
    lastR523CycleId = cycle.id;
    const multi_cause_chains = intendedActualService.multiCauseChains(deltas);
    return {
      ok: true,
      cycle_id: cycle.id,
      loaded: ['fixture-r523-coupling', 'fixture-r523-avail'],
      frozen_at: freeze.frozen_at,
      intended: freeze.snapshot.role_tiers.map((r) => ({
        role: r.role,
        tier: r.tier,
        primary_model_slug: r.primary_model_slug ?? null,
        backup_model_slug: r.backup_model_slug ?? null,
      })),
      deltas,
      multi_cause_chains,
      stamps_count: stamps.length,
      coupling_rows: deltas.filter((d) => d.reason === 'COUPLING').length,
    };
  });

  // B5 R-01B5: backfill all untested models (non-blocking on startup; also callable for smoke).
  app.post('/api/models/validate-all', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async () => {
    const summary = await modelValidationService.validateAll();
    return { summary };
  });

  // B2 R-01B2: Validate model via provider round-trip. Owner + local-launch guarded (spawns tmux session).
  // Sync: awaits full validation flow (up to 120s hard wall). B3 adds the UI [test] button + spinner.
  app.post('/api/models/:id/validate', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    if (!modelService.getModel(id)) return reply.code(404).send({ error: 'unknown model' });
    try {
      const validation = await modelValidationService.validate(id);
      const model = modelService.getModel(id);
      return { model, validation };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  // B2 (kloo/D3): runtime discovery — routes parsed from ~/.config/kloo/profiles.json,
  // models live-fetched per route (cached ~5min, ?refresh=1 bypasses). Owner-gated, read-only
  // (no requireLocalLaunchPre — mirrors GET /api/models).
  app.get('/api/kloo/routes', { preHandler: [authMiddleware, requireOwnerPre] }, async () => ({
    routes: klooDiscovery.listRoutes()
  }));
  app.get('/api/kloo/routes/:route/models', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any) => {
    const refresh = request.query?.refresh === '1' || request.query?.refresh === 'true';
    const result = await klooDiscovery.listModels(request.params.route, { refresh });
    return result;
  });

  // A5: routing table view for Agent Studio.
  app.get('/api/routing-rules', { preHandler: [authMiddleware, requireOwnerPre] }, async () => ({
    rules: routingConfigService.listRules(),
    validation: routingConfigService.validateConfig()
  }));

  // A6: add a new custom (non-core) rule. is_core is always forced to 0 server-side; an explicit
  // is_core=1 in the body is rejected outright rather than silently dropped.
  app.post('/api/routing-rules', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const body = request.body || {};
    if (body.is_core != null && Number(body.is_core) !== 0) {
      return reply.code(400).send({ error: 'is_core cannot be set via API — new rules are always custom (non-core)' });
    }
    const { emitter_role, when_status, handler_role, action, note } = body;
    if (!emitter_role || !when_status || !handler_role || !action) {
      return reply.code(400).send({ error: 'emitter_role, when_status, handler_role, action are required' });
    }
    try {
      const rule = routingConfigService.addRule({ emitter_role, when_status, handler_role, action, note: note ?? null });
      return { rule, validation: routingConfigService.validateConfig() };
    } catch (e: any) {
      if (e instanceof RoutingValidationError) return reply.code(400).send({ error: e.message, problems: e.problems });
      return reply.code(400).send({ error: e.message });
    }
  });

  // A6: edit handler_role/action/note/enabled on an existing rule. PROTECTION: core (is_core=1)
  // rules reject handler_role/action changes (400) — only enabled/note may move on a core row.
  // VALIDATION GUARD: any mutation that would leave the config invalid (unrouted core condition or
  // a conflicting enabled route) is rolled back and rejected with 400 {error, problems}; nothing
  // broken is ever persisted.
  app.patch('/api/routing-rules/:id', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    if (!routingConfigService.getById(id)) return reply.code(404).send({ error: 'unknown routing rule id' });
    const body = request.body || {};
    const patch: { handler_role?: string; action?: string; note?: string | null; enabled?: boolean } = {};
    if (body.handler_role !== undefined) patch.handler_role = body.handler_role;
    if (body.action !== undefined) patch.action = body.action;
    if (body.note !== undefined) patch.note = body.note;
    if (body.enabled !== undefined) patch.enabled = !!body.enabled;
    try {
      const rule = routingConfigService.editRule(id, patch);
      return { rule, validation: routingConfigService.validateConfig() };
    } catch (e: any) {
      if (e instanceof RoutingCoreProtectedError) return reply.code(400).send({ error: e.message });
      if (e instanceof RoutingValidationError) return reply.code(400).send({ error: e.message, problems: e.problems });
      return reply.code(400).send({ error: e.message });
    }
  });

  // A6: dedicated enable/disable toggle — thin alias over PATCH {enabled}. Subject to the same
  // validation guard (disabling a core rule that would leave its transition unrouted is refused).
  app.post('/api/routing-rules/:id/toggle', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    const existing = routingConfigService.getById(id);
    if (!existing) return reply.code(404).send({ error: 'unknown routing rule id' });
    const body = request.body || {};
    const enabled = body.enabled !== undefined ? !!body.enabled : existing.enabled !== 1;
    try {
      const rule = routingConfigService.editRule(id, { enabled });
      return { rule, validation: routingConfigService.validateConfig() };
    } catch (e: any) {
      if (e instanceof RoutingValidationError) return reply.code(400).send({ error: e.message, problems: e.problems });
      return reply.code(400).send({ error: e.message });
    }
  });

  // C1 KEY-C1: agent test-chat transport (SSE+POST, DELIB consensus 2026-06-21).
  // Ephemeral tmux session per (agent, chat). POST create → POST message → GET SSE stream
  // (polls capturePane @500ms, emits diffs) → DELETE cleanup. In-memory store (chatSessionService).
  // Owner + local-launch guarded (spawns tmux). SSE route uses sseAuthPre (EventSource can't set headers).
  app.get('/api/agents/active-sessions', { preHandler: [authMiddleware, requireOwnerPre] }, async () => {
    return { sessions: await chatSessionService.listActiveSessions() };
  });

  // S14a: GET /api/sessions (+owner) + POST /api/sessions/:name/close (human-only). Extracted for inject tests.
  registerSessionCloseRoutes(app, {
    sessionRegistry,
    sessionCloseService,
    authMiddleware,
    requireOwnerPre,
    requireLocalLaunchPre,
  });
  registerHousekeeperRoutes(app, {
    housekeeperService,
    authMiddleware,
    requireOwnerPre,
    requireLocalLaunchPre,
  });

  app.post('/api/agents/:agentId/chat-session', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const agentId = Number(request.params.agentId);
    if (!assignmentService.getAgent(agentId)) return reply.code(404).send({ error: 'unknown agent' });
    // AGENTROLE T5: optional model_id override for PROJECT agent test-chats (cheap-model spawn).
    const body = (request.body as any) || {};
    const overrideModelId = body.model_id as string | undefined;
    const rawProjectId = body.project_id;
    const projectId = rawProjectId === undefined || rawProjectId === null || rawProjectId === '' ? undefined : Number(rawProjectId);
    if (projectId !== undefined) {
      if (!Number.isInteger(projectId) || projectId <= 0) return reply.code(400).send({ error: 'invalid project_id' });
      if (!projectService.getProject(projectId)) return reply.code(404).send({ error: 'unknown project' });
      if (!projectAgentService.getProjectAgent(projectId, agentId)) return reply.code(404).send({ error: 'project agent not found' });
    }
    try {
      const result = await chatSessionService.create(agentId, overrideModelId, projectId);
      // tmux_session + spawn_model surfaced so the UI can show them + JROM can `tmux attach -t <name>`.
      return { session_id: result.sessionId, tmux_session: result.tmuxSession, spawn_model: result.spawnModel };
    } catch (e: any) {
      if (e.message?.includes('not validated')) return reply.code(409).send({ error: e.message });
      return reply.code(500).send({ error: e.message });
    }
  });

  // CC-CHAT-1 B1: shared chat-session handlers — registered on BOTH the Studio routes
  // (/api/agents/:agentId/chat-session/...) and the project-scoped routes
  // (/api/projects/:pid/agent-chat/...). ONE message/logs/clear/compact/end pipeline, zero duplication.
  const chatSessionMessageHandler = async (request: any, reply: any) => {
    const sid = request.params.sid;
    if (!chatSessionService.hasSession(sid)) return reply.code(404).send({ error: 'unknown session' });
    const body = request.body || {};
    const text = (body.text || '').trim();
    if (!text) return reply.code(400).send({ error: 'text required' });
    if (text.length > 2000) return reply.code(400).send({ error: 'text too long (max 2000)' });
    // F2: STABLE message id, correlated end-to-end (optimistic UI bubble → queue → deliverOne →
    // delivery-failed SSE → UI mark-undelivered). The UI supplies its bubble id; we echo it back and thread
    // it so a failure is matched by ID, never by (possibly duplicate) text. Fallback id for non-UI callers.
    const msgId = String(body.msgId || `dm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    // F2 round-6/7: resolve + capture the LOGICAL CHANNEL when the POST is accepted, SERVER-AUTHORITATIVELY
    // from the route params (project:<pid> for CC/Discovery, studio:<agentId> for Studio). Record failures
    // under it so a failure from an OLD sid surfaces on the REPLACEMENT sid's stream (same channel). The client
    // never supplies the channel key — stream + ack derive the SAME channel from their own route params.
    // round-8 (finding #1): the channel is the VALIDATED scope-bound channel from scopedChatSidPre (which has
    // already 404'd a foreign/non-canonical scope), not a raw derivation off the trusted-blindly route string.
    const channel = request.deliveryChannel;
    // ACCEPT + deliver in the BACKGROUND. The agent may be mid-reply (codex/grok high-effort turns run
    // many minutes); we must NOT hold the HTTP request that long — the Cloudflare tunnel caps a held
    // request at ~100s and 524s. sendMessage queues + drains, waiting as long as the agent is actually
    // working (operator watches the Raw pane). The reply then streams back over the existing SSE.
    void chatSessionService.sendMessage(sid, text, msgId, channel).catch((e: any) => {
      request.log?.warn?.(`[agent-chat] background deliver failed sid=${sid}: ${e?.message || e}`);
    });
    return { ok: true, accepted: true, msgId, channel };
  };
  // F2 round-6/7: explicit delivery ACK — the UI POSTs the channel high-watermark AFTER applying a delivery-failed
  // event or rendering a gap. Only acknowledged payloads may be removed as fully-delivered notification state.
  // round-7 (finding #1): the channel is derived SERVER-SIDE from the scoped route (project:<pid> / studio:<agentId>),
  // NEVER from the body — a client cannot ack (and thereby silently consume) another owner-channel's failures.
  const chatDeliveryAckHandler = async (request: any, _reply: any) => {
    const body = request.body || {};
    // round-8 (finding #1): scopedChatSidPre resolved the SID + verified it belongs to this scope (the ACK
    // route did NO SID check before) and stashed the VALIDATED channel, so an ACK can never consume another
    // owner-channel's failures. A missing/foreign/non-canonical scope already 404'd in the pre-handler.
    const channel = request.deliveryChannel;
    const throughSeq = Number(body.throughSeq);
    if (Number.isFinite(throughSeq)) chatSessionService.ackDelivery(channel, throughSeq);
    return { ok: true };
  };
  // Raw session logs for the "Session Logs" tab — full tmux pane (ANSI-stripped, NO bootstrap hiding).
  const chatSessionLogsHandler = async (request: any, reply: any) => {
    const sid = request.params.sid;
    if (!chatSessionService.hasSession(sid)) return reply.code(404).send({ error: 'unknown session' });
    try {
      const sess = chatSessionService.getSession(sid);
      const logs = await chatSessionService.captureRawLogs(sid);
      return { logs, tmux_session: sess?.tmuxSession ?? null };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  };
  const chatSessionEndHandler = async (request: any, _reply: any) => {
    await chatSessionService.terminate(request.params.sid); // idempotent no-op if already gone
    return { ok: true };
  };
  const chatSessionClearHandler = async (request: any, reply: any) => {
    const sess = chatSessionService.getSession(request.params.sid);
    if (!sess) return reply.code(404).send({ error: 'unknown session' });
    try {
      const result = await tmuxService.clearContext(sess.paneTarget, sess.spawnProvider);
      return { issued: result.issued, verified: result.verified };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  };
  const chatSessionCompactHandler = async (request: any, reply: any) => {
    const sess = chatSessionService.getSession(request.params.sid);
    if (!sess) return reply.code(404).send({ error: 'unknown session' });
    try {
      const result = await tmuxService.compactContext(sess.paneTarget, sess.spawnProvider);
      return { issued: result.issued, verified: result.verified };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  };

  app.post('/api/agents/:agentId/chat-session/:sid/message', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre, scopedChatSidPre] }, chatSessionMessageHandler);

  // F2 round-6/7: delivery high-watermark ack — SCOPED to the authenticated route so the channel is derived
  // server-side (studio:<agentId> here; project:<pid> on the project route below). No bare/global ack endpoint.
  app.post('/api/agents/:agentId/chat-session/:sid/chat-delivery-ack', { preHandler: [authMiddleware, requireOwnerPre, scopedChatSidPre] }, chatDeliveryAckHandler);

  app.get('/api/agents/:agentId/chat-session/:sid/logs', { preHandler: [authMiddleware, requireOwnerPre, scopedChatSidPre] }, chatSessionLogsHandler);

  // F2 round-6/7: shared SSE stream handler — registered on BOTH the Studio route
  // (/api/agents/:agentId/chat-session/:sid/stream → studio:<agentId>) and the project route
  // (/api/projects/:pid/agent-chat/:sid/stream → project:<pid>). The delivery channel is derived
  // SERVER-SIDE from the route params (never a client ?channel=), so it always matches the channel the POST
  // recorded failures under.
  const chatSessionStreamHandler = async (request: any, reply: any) => {
    const sid = request.params.sid;
    if (!chatSessionService.hasSession(sid)) return reply.code(404).send({ error: 'unknown session' });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    reply.raw.write(':ok\n\n');
    reply.hijack(); // critical: Fastify must not send its own response after this
    const stream = reply.raw;

    let lastSnapshot = '';
    // F2 round-6/7: delivery notifications are keyed by LOGICAL CHANNEL (project:<pid> / studio:<agentId>),
    // derived SERVER-SIDE from the scoped route (finding #1) so a REPLACEMENT sid's stream drains a failure
    // produced by the OLD sid on the SAME channel — and a client cannot point the stream at a foreign channel.
    // Resume from the client's per-channel last-seen seq; epoch-aware (a cross-epoch cursor is ignored so a
    // stale high cursor can't suppress a new low-seq failure).
    // round-8 (finding #1): scopedChatSidPre already resolved the SID + verified this route scope owns it and
    // stashed the VALIDATED channel, so the stream cannot be pointed at a foreign project/agent channel.
    const channel = request.deliveryChannel;
    const serverEpoch = chatSessionService.deliveryEpochToken;
    const clientEpoch = String(request.query?.epoch || '');
    let lastFailSeq = clientEpoch && clientEpoch === serverEpoch ? (Number(request.query?.sinceFailSeq) || 0) : 0;
    try { stream.write(`data:${JSON.stringify({ type: 'delivery-epoch', epoch: serverEpoch, lossGeneration: chatSessionService.deliveryLossGeneration })}\n\n`); } catch {}

    // heartbeat (comment frame, does not advance Last-Event-ID)
    const hb = setInterval(() => {
      try { stream.write(': ping\n\n'); } catch {}
    }, 15000);

    let lastLossGen = -1; // emit the sticky app-wide loss warning whenever it advances
    // Poll the agent pane and emit only the diff (the backend must poll tmux — no push).
    const pollInterval = setInterval(async () => {
      try {
        // F2: surface any PERMANENT delivery failures so the exact optimistic UI bubble (matched by msgId)
        // is corrected to delivered=false — an HTTP-acked message that could not be delivered must never be
        // silently lost, even after the session was terminated/switched (the ledger is channel-keyed, decoupled
        // from session lifecycle). A behind client gets a per-channel GAP; a hard-cap loss bumps lossGeneration.
        const { gapThroughSeq, failures, lossGeneration } = chatSessionService.getDeliveryFailuresSince(channel, lastFailSeq);
        if (lossGeneration !== lastLossGen) {
          lastLossGen = lossGeneration;
          try { stream.write(`data:${JSON.stringify({ type: 'loss-generation', lossGeneration })}\n\n`); } catch {}
        }
        if (gapThroughSeq != null) {
          lastFailSeq = gapThroughSeq;
          try { stream.write(`data:${JSON.stringify({ type: 'delivery-failed-gap', channel, throughSeq: gapThroughSeq })}\n\n`); } catch {}
        }
        for (const f of failures) {
          lastFailSeq = Math.max(lastFailSeq, f.seq);
          try { stream.write(`data:${JSON.stringify({ type: 'delivery-failed', channel, seq: f.seq, msgId: f.msgId, text: f.text, reason: f.reason })}\n\n`); } catch {}
        }
        const pane = await chatSessionService.capturePane(sid);
        if (pane !== lastSnapshot) {
          lastSnapshot = pane;
          try { stream.write(`data:${JSON.stringify({ type: 'pane', content: pane })}\n\n`); } catch {}
        }
      } catch (err: any) {
        // session terminated / pane gone — notify client, stop polling, close.
        try { stream.write(`data:${JSON.stringify({ type: 'error', error: String(err?.message || err) })}\n\n`); } catch {}
        clearInterval(pollInterval);
        clearInterval(hb);
        try { stream.end(); } catch {}
      }
    }, 500);

    // Leak-safe teardown: SYNCHRONOUS attach (no await after hijack on this path).
    request.raw.on('close', () => {
      clearInterval(pollInterval);
      clearInterval(hb);
      try { stream.end(); } catch {}
    });

    // IMPORTANT: do NOT return a value / send after hijack
  };
  app.get('/api/agents/:agentId/chat-session/:sid/stream', { preHandler: [sseAuthPre, requireOwnerPre, scopedChatSidPre] }, chatSessionStreamHandler);

  app.delete('/api/agents/:agentId/chat-session/:sid', { preHandler: [authMiddleware, requireOwnerPre, scopedChatSidPre] }, chatSessionEndHandler);

  // A1: Command Center per-agent Clear + Compact — reuse tmux clearContext/compactContext against the
  // chat session's live pane (paneTarget) + resolved provider (spawnProvider). 404 if session/handle unknown.
  app.post('/api/agents/:agentId/chat-session/:sid/clear', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre, scopedChatSidPre] }, chatSessionClearHandler);

  app.post('/api/agents/:agentId/chat-session/:sid/compact', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre, scopedChatSidPre] }, chatSessionCompactHandler);

  // ── CC-CHAT-1 B1: project-scoped agent chat sessions (Command Center chat = Studio chat, fenced
  // to the project). Start spawns the agent's CLI in a dedicated tmux session cwd'd AT
  // project.directory and wrapped in the helm-sandbox Landlock fence (<sandboxBin> <projectDir> <cmd>)
  // exactly like worker spawns; session names are helm-chat-p<pid>-<agent>-<nonce> (never collide with
  // run sessions). All other verbs delegate to the SAME shared handlers as the Studio routes.
  app.post('/api/projects/:pid/agent-chat/:agentId', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.pid);
    const agentId = Number(request.params.agentId);
    const project = projectService.getProject(pid);
    if (!project) return reply.code(404).send({ error: 'unknown project' });
    if (!project.directory) return reply.code(400).send({ error: 'project has no directory (cannot fence)' });
    if (!assignmentService.getAgent(agentId)) return reply.code(404).send({ error: 'unknown agent' });
    if (!projectAgentService.getProjectAgent(pid, agentId)) return reply.code(404).send({ error: 'agent not assigned to this project' });
    // Busy guard: one live chat session per agent (attach/end the existing one instead of double-spawn).
    const live = (await chatSessionService.listActiveSessions()).find((s) => s.agent_id === agentId);
    if (live) return reply.code(409).send({ error: 'agent already has a live chat session', busy: true, session_id: live.session_id, tmux_session: live.tmux_session });
    const body = (request.body as any) || {};
    const rawCycleId = body.cycle_id;
    let activeCycle: any = null;
    if (rawCycleId !== undefined && rawCycleId !== null && rawCycleId !== '') {
      const cycleId = Number(rawCycleId);
      if (!Number.isInteger(cycleId) || cycleId <= 0) return reply.code(400).send({ error: 'invalid cycle_id' });
      const row = db.raw.prepare('SELECT * FROM cycles WHERE id = ? AND project_id = ?').get(cycleId, pid) as any;
      if (!row) return reply.code(404).send({ error: 'cycle not found for project' });
      activeCycle = {
        id: Number(row.id),
        name: String(row.name),
        folder_name: String(row.folder_name),
        folder_path: cycleService.getCycleDocDir(Number(row.id)),
        phase: String(row.phase || ''),
        autonomy: String(row.autonomy || '')
      };
    }
    try {
      const result = await chatSessionService.create(agentId, body.model_id, pid, { projectFenceDir: project.directory, activeCycle });
      return { session_id: result.sessionId, tmux_session: result.tmuxSession, spawn_model: result.spawnModel, project_dir: project.directory };
    } catch (e: any) {
      if (e.message?.includes('not validated')) return reply.code(409).send({ error: e.message });
      return reply.code(500).send({ error: e.message });
    }
  });
  app.delete('/api/projects/:pid/agent-chat/:sid', { preHandler: [authMiddleware, requireOwnerPre, scopedChatSidPre] }, chatSessionEndHandler);
  app.post('/api/projects/:pid/agent-chat/:sid/message', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre, scopedChatSidPre] }, chatSessionMessageHandler);
  app.get('/api/projects/:pid/agent-chat/:sid/logs', { preHandler: [authMiddleware, requireOwnerPre, scopedChatSidPre] }, chatSessionLogsHandler);
  app.post('/api/projects/:pid/agent-chat/:sid/clear', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre, scopedChatSidPre] }, chatSessionClearHandler);
  app.post('/api/projects/:pid/agent-chat/:sid/compact', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre, scopedChatSidPre] }, chatSessionCompactHandler);
  // F2 round-7: project-scoped delivery SSE stream + ack — the channel resolves SERVER-SIDE to project:<pid>
  // (finding #1), matching the channel the project message POST recorded failures under. CC/Discovery use these
  // (not the Studio agent route) so a client never supplies the channel identity.
  app.get('/api/projects/:pid/agent-chat/:sid/stream', { preHandler: [sseAuthPre, requireOwnerPre, scopedChatSidPre] }, chatSessionStreamHandler);
  app.post('/api/projects/:pid/agent-chat/:sid/chat-delivery-ack', { preHandler: [authMiddleware, requireOwnerPre, scopedChatSidPre] }, chatDeliveryAckHandler);

  // G1: terminal source for active agent-chat sessions (CC split view). Uses the live paneTarget
  // (same as captureRawLogs) but returns shape compatible with master /terminal. Owner-guarded.
  // Frontend loadTerminal prefers this when ccSession active for the pid (falls back to master).
  // round-8 (finding #1): scopedChatSidPre now HARD-binds the :sid to this project (was a best-effort,
  // allow-anyway check) — a foreign/nonexistent SID 404s before any pane capture. scopedSession is the
  // pre-resolved, scope-verified session.
  app.get('/api/projects/:pid/agent-chat/:sid/terminal', { preHandler: [authMiddleware, requireOwnerPre, scopedChatSidPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.pid);
    const sid = request.params.sid;
    const sess = request.scopedSession;
    try {
      const target = (sess as any).paneTarget || `${sess.tmuxSession}:0.0`;
      const content = await tmuxService.capturePane(target, 200);
      return { session: sess.tmuxSession, content: content || '', source: 'chat-session' };
    } catch (e: any) {
      console.warn('[terminal] chat-session capture failed for', pid, sid, e?.message);
      return { session: sess.tmuxSession ?? null, content: '', source: 'chat-session' };
    }
  });

  // C1: Helm-owned projects routes (A0). Owner-guarded.
  // Mutations use requireLocalLaunchPre. 409 on name unique, 404 on delete unknown.
  app.get('/api/projects', { preHandler: [authMiddleware, requireOwnerPre] }, () => {
    const projects = projectService.listProjects();
    return { projects };
  });

  app.post('/api/projects', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    try {
      const p = projectService.createProject(request.body || {});
      let scaffoldWarning: string | undefined;
      try {
        await projectDocsService.scaffoldProjectFolders(p.directory);
      } catch (e: any) {
        scaffoldWarning = String(e?.message || e);
      }
      return { project: p, ...(scaffoldWarning ? { scaffold_warning: scaffoldWarning } : {}) };
    } catch (e: any) {
      if (e.message && e.message.includes('unique')) return reply.code(409).send({ error: e.message });
      return reply.code(400).send({ error: e.message });
    }
  });

  app.delete('/api/projects/:id', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    if (!projectService.getProject(id)) return reply.code(404).send({ error: 'unknown project' });
    try {
      projectService.deleteProject(id);
      return { ok: true };
    } catch (e: any) {
      if (!projectService.getProject(id)) return reply.code(404).send({ error: 'unknown project' });
      return reply.code(400).send({ error: e.message });
    }
  });

  // B2-T01: POST /api/projects/:id/cycles — creates cycle row (autonomy inherit or override) + on-disk folder
  // <project.directory>/cycle/<slug>_<MMDD>/ . Returns cycle incl. folder_path. 409 on dup folder_name.
  // Clock derived at boundary (service default); folder always fenced under project.directory.
  app.post('/api/projects/:id/cycles', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    if (!projectService.getProject(id)) return reply.code(404).send({ error: 'unknown project' });
    try {
      const body = request.body || {};
      const c = await cycleService.createCycle(id, body.name, body.autonomy, body.final_tests_enabled);
      return { cycle: c };
    } catch (e: any) {
      if (e.code === 'CONFLICT' || /already exists/.test(String(e.message || e))) {
        return reply.code(409).send({ error: e.message });
      }
      if (e.message && /required/.test(e.message)) {
        return reply.code(400).send({ error: e.message });
      }
      return reply.code(400).send({ error: e.message });
    }
  });

  // B2-T02: GET /api/cycles/overview — cross-project cycles grouped by status for Overview board (R-A2).
  app.get('/api/cycles/overview', { preHandler: [authMiddleware, requireOwnerPre] }, async () => {
    return cycleService.listCyclesOverview();
  });

  // B2-T03: PATCH /api/cycles/:id/phase — set cycle phase; 409 when second implementation blocked (R-B3).
  app.patch('/api/cycles/:id/phase', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    try {
      const body = request.body || {};
      const phase = body.phase;
      if (!phase) return reply.code(400).send({ error: 'phase is required' });
      const c = cycleService.setCyclePhase(id, phase);
      return { cycle: c };
    } catch (e: any) {
      if (e.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
      if (e.code === 'CONFLICT') return reply.code(409).send({ error: e.message });
      if (e.message && /invalid phase/.test(e.message)) {
        return reply.code(400).send({ error: e.message });
      }
      return reply.code(400).send({ error: e.message });
    }
  });

  // A6b / R3.14: POST /api/cycles/:id/finish-planning — production finishPlanning without requiring
  // a live plancore seat cold-spawn. Same CycleService.finishPlanning the orchestrator calls at
  // planning-done (A5): gate-mode → awaiting_approval=1 (phase stays planning); autonomous →
  // implementation. Owner-only. Enables reliable post-approve proof and operator "plan is ready"
  // without burning 80–120s on first-callback seat boot (flaky under live 180s caps).
  app.post('/api/cycles/:id/finish-planning', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    try {
      const c = cycleService.finishPlanning(id);
      return { cycle: c };
    } catch (e: any) {
      if (e.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
      if (e.code === 'CONFLICT') return reply.code(409).send({ error: e.message });
      return reply.code(400).send({ error: e.message });
    }
  });

  // B6-T03: POST /api/cycles/:id/approve — gate-mode awaiting-approval → implementation (R-E3).
  // B10b: service-layer FORBIDDEN (jkage L0) → 403.
  // A6 / R3.14: the run-orchestrator parks a gate-mode cycle's planning run without dispatching
  // (pause_after_planning gate) — approval is what actually starts the implementation queue.
  // Best-effort + never let a start failure fail the 200 (mirrors IS-R3 auto-start): the phase
  // flip is the durable contract; JROM can still click Start Implementation manually if this races.
  app.post('/api/cycles/:id/approve', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    try {
      // B10b/R2.10: trusted actor from verified token only (never body)
      const actor = decisionActorFromRequestUser(request.user);
      const c = cycleService.approveCycle(id, { actor });
      let implementation: { started: boolean; reason?: string; runId?: number };
      try {
        implementation = await startCycleImplementationAfterApproval(
          { db, cycleService, runArtifacts: runArtifactService, orchestrator: runOrchestratorService },
          id
        );
      } catch (startErr: any) {
        implementation = { started: false, reason: startErr?.message || 'start failed' };
        request.log?.warn?.(`[cycle-approve] cycle ${id}: implementation start failed: ${startErr?.message || startErr}`);
      }
      return { cycle: c, implementation };
    } catch (e: any) {
      if (e.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
      if (e.code === 'CONFLICT') return reply.code(409).send({ error: e.message });
      if (e.code === 'FORBIDDEN') return reply.code(403).send({ error: e.message });
      return reply.code(400).send({ error: e.message });
    }
  });

  // B6-T02: PATCH /api/cycles/:id/autonomy — set cycle autonomy; 409 once phase is
  // implementation/final_tests/complete (locked, R-E2/E3 server-side guard).
  app.patch('/api/cycles/:id/autonomy', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    try {
      const body = request.body || {};
      const c = cycleService.setCycleAutonomy(id, body.autonomy);
      return { cycle: c };
    } catch (e: any) {
      if (e.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
      if (e.code === 'CONFLICT') return reply.code(409).send({ error: e.message });
      return reply.code(400).send({ error: e.message });
    }
  });

  // B11-T01: PATCH /api/cycles/:id/final-tests — set cycle Final Tests on/off; 409 once phase is
  // implementation/final_tests/complete (locked, R-G1 server-side guard).
  app.patch('/api/cycles/:id/final-tests', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    try {
      const body = request.body || {};
      const c = cycleService.setCycleFinalTests(id, body.enabled);
      return { cycle: c };
    } catch (e: any) {
      if (e.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
      if (e.code === 'CONFLICT') return reply.code(409).send({ error: e.message });
      return reply.code(400).send({ error: e.message });
    }
  });

  // B3-T01: cycle markdown doc read/write under <project.directory>/cycle/<folder_name>/ (traversal-guarded).
  app.get('/api/cycles/:id/docs/:filename', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    const rel = request.query && request.query.path ? request.query.path : request.params.filename;
    try {
      const doc = await cycleDocsService.readCycleDoc(id, rel);
      return { doc };
    } catch (e: any) {
      if (e.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
      const isTraversal = e.code === 'TRAVERSAL' || /traversal|only \.md/i.test(String(e.message));
      return reply.code(isTraversal ? 400 : 404).send({ error: e.message || 'read failed' });
    }
  });

  app.put('/api/cycles/:id/docs/:filename', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    const rel = request.query && request.query.path ? request.query.path : request.params.filename;
    try {
      const body = request.body || {};
      if (typeof body.content !== 'string') return reply.code(400).send({ error: 'content required' });
      const max = (loadConfig() as any).PROJECT_DOC_BODY_MAX || 1048576;
      if (Buffer.byteLength(body.content, 'utf8') > max) return reply.code(400).send({ error: 'content too large' });
      const doc = await cycleDocsService.writeCycleDoc(id, rel, body.content);
      // IS-R3 (impl-start): a valid execution_plan.md save auto-starts implementation for an
      // autonomous_after_discovery cycle (server-side, so it works unattended). Idempotent — the
      // helper's getCycleRunState guard means a re-save never starts a second run. Best-effort:
      // never let auto-start failure break the doc-save response.
      if (path.basename(doc.filename) === CANONICAL_CYCLE_ARTIFACTS.plan) {
        try {
          await maybeAutoStartCycleImplementation(
            { db, cycleService, runArtifacts: runArtifactService, orchestrator: runOrchestratorService },
            id
          );
        } catch (autoErr: any) {
          request.log?.warn?.(`[cycle-auto-start] cycle ${id}: ${autoErr?.message || autoErr}`);
        }
      }
      return { doc };
    } catch (e: any) {
      if (e?.code === 'TOO_LARGE') return reply.code(400).send({ error: e.message || 'content too large' });
      if (e?.code === 'INVALID_EXECUTION_PLAN') {
        return reply.code(400).send({ error: e.message || 'execution plan validation failed', errors: e.errors || [] });
      }
      if (e.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
      const isTraversal = e.code === 'TRAVERSAL' || /traversal|only \.md|symlink/i.test(String(e.message));
      return reply.code(isTraversal ? 400 : 404).send({ error: e.message || 'write failed' });
    }
  });

  // B3-T02: POST /api/cycles/:id/attachments — base64 image upload into cycle/<folder>/attachments/ (R-C3, R-B2).
  app.post('/api/cycles/:id/attachments', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    try {
      const body = request.body || {};
      if (typeof body.filename !== 'string' || !body.filename.trim()) {
        return reply.code(400).send({ error: 'filename required' });
      }
      if (typeof body.contentBase64 !== 'string' || !body.contentBase64.trim()) {
        return reply.code(400).send({ error: 'contentBase64 required' });
      }
      const b64 = body.contentBase64.trim();
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) {
        return reply.code(400).send({ error: 'invalid base64' });
      }
      const bytes = Buffer.from(b64, 'base64');
      if (bytes.length === 0) return reply.code(400).send({ error: 'attachment content required' });
      const max = (loadConfig() as any).PROJECT_DOC_BODY_MAX || 1048576;
      if (bytes.length > max) return reply.code(400).send({ error: 'attachment too large' });
      const result = await cycleDocsService.saveCycleAttachment(id, body.filename, bytes);
      return result;
    } catch (e: any) {
      if (e?.code === 'INVALID' || e?.code === 'TOO_LARGE') return reply.code(400).send({ error: e.message });
      if (e.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
      if (e.code === 'CONFLICT') return reply.code(409).send({ error: e.message });
      const isTraversal = e.code === 'TRAVERSAL' || /traversal|only image|symlink/i.test(String(e.message));
      return reply.code(isTraversal ? 400 : 400).send({ error: e.message || 'attachment save failed' });
    }
  });

  // B8 / R6.27: POST /api/cycles/:id/chat-files — paste/upload into project tmp/<cycle-folder>/<filename>
  // via B7 CycleChatFileService. Returns project-relative path for Discovery composer insertion.
  // Accepts content (utf8 text) OR contentBase64 (binary/image). Exclusive create; never OS /tmp.
  app.post('/api/cycles/:id/chat-files', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid cycle id' });
    try {
      const body = request.body || {};
      if (typeof body.filename !== 'string' || !body.filename.trim()) {
        return reply.code(400).send({ error: 'filename required' });
      }
      let payload: string | Buffer;
      if (typeof body.contentBase64 === 'string' && body.contentBase64.trim()) {
        const b64 = body.contentBase64.trim();
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) {
          return reply.code(400).send({ error: 'invalid base64' });
        }
        payload = Buffer.from(b64, 'base64');
      } else if (typeof body.content === 'string') {
        payload = body.content;
      } else {
        return reply.code(400).send({ error: 'content or contentBase64 required' });
      }
      const result = await cycleChatFileService.saveCycleChatFile(id, body.filename.trim(), payload);
      return result;
    } catch (e: any) {
      if (e?.code === 'INVALID') return reply.code(400).send({ error: e.message });
      if (e?.code === 'TOO_LARGE') return reply.code(413).send({ error: e.message });
      if (e?.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
      if (e?.code === 'CONFLICT') return reply.code(409).send({ error: e.message });
      const isTraversal = e?.code === 'TRAVERSAL' || /traversal|symlink/i.test(String(e?.message || ''));
      return reply.code(isTraversal ? 400 : 400).send({ error: e?.message || 'chat-file save failed' });
    }
  });

  // B7-T03: GET /api/cycles/:id/artifact-image — serve raw bytes of a saved attachment or
  // mockup image (attachments/ or mockups/ only — B7-T04 widened the prefix for R-C4 approved
  // mockups; traversal-guarded via resolveSafeAttachmentReadPath). Bearer-token auth means the
  // client can't just point an <img src> at this — it fetches + blob-URLs it (R-C3/R-C4).
  app.get('/api/cycles/:id/artifact-image', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    const rel = request.query && request.query.path;
    try {
      if (typeof rel !== 'string' || !rel.trim()) return reply.code(400).send({ error: 'path required' });
      const img = await cycleDocsService.readCycleAttachmentImage(id, rel);
      const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
      reply.header('Content-Type', mime[img.ext] || 'application/octet-stream');
      return reply.send(img.bytes);
    } catch (e: any) {
      if (e.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
      const isTraversal = e.code === 'TRAVERSAL' || /traversal|only image|only cycle attachments/i.test(String(e.message));
      return reply.code(isTraversal ? 400 : 404).send({ error: e.message || 'image read failed' });
    }
  });

  // B3-T03: GET /api/cycles/:id/artifacts — categorized listing of cycle folder docs/images/flow (R-C4, R-D3, R-G3).
  app.get('/api/cycles/:id/artifacts', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    try {
      const artifacts = await cycleDocsService.listCycleArtifacts(id);
      return artifacts;
    } catch (e: any) {
      if (e.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
      return reply.code(500).send({ error: e.message || 'artifact listing failed' });
    }
  });

  // B11-T04: GET /api/cycles/:id/final-tests-status — real Final Tests tab data (R-G3).
  // final-tests-smoke/e2e/result.json + batch-*-deploy.json live in a per-run ephemeral runDir
  // (os.tmpdir()/helm-run-<projectId>-<batchId>, same formula the writer in run-orchestrator-service.ts
  // uses), which the B3-T03 cycle-doc-folder artifacts API cannot reach — so this endpoint derives the
  // runDir server-side from cycle_id -> runs (project_id, batch_id), never from a client-supplied path,
  // and reads real files only (best-effort; missing = absent, never fabricated).
  app.get('/api/cycles/:id/final-tests-status', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    const cycle: any = db.prepare('SELECT id, project_id, status FROM cycles WHERE id = ?').get(id);
    if (!cycle) return reply.code(404).send({ error: 'unknown cycle' });

    const runs = db.prepare(
      'SELECT id, project_id, batch_id, status, phase FROM runs WHERE cycle_id = ? ORDER BY id ASC'
    ).all(id) as any[];

    const readJson = async (dir: string, filename: string): Promise<any> => {
      try { return JSON.parse(await readFile(path.join(dir, filename), 'utf8')); }
      catch { return null; }
    };
    const readMd = async (dir: string, filename: string): Promise<string | null> => {
      try { return await readFile(path.join(dir, filename), 'utf8'); }
      catch { return null; }
    };
    const listDeployFiles = async (dir: string): Promise<string[]> => {
      try { return (await readdir(dir)).filter(f => /^batch-.+-deploy\.json$/.test(f)); }
      catch { return []; }
    };

    const perRun: Array<{ run: any; runDir: string; smoke: any; e2e: any; result: any; recurrencePause: string | null; noConfigPause: string | null; deployFiles: string[] }> = [];
    for (const run of runs) {
      const runDir = resolveRunDir(run.project_id, run.batch_id); // #46: single resolver
      const [smoke, e2e, result, recurrencePause, noConfigPause, deployFiles] = await Promise.all([
        readJson(runDir, 'final-tests-smoke.json'),
        readJson(runDir, 'final-tests-e2e.json'),
        readJson(runDir, 'final-tests-result.json'),
        readMd(runDir, 'final-test-recurrence-pause.md'),
        readMd(runDir, 'final-tests-paused.md'),
        listDeployFiles(runDir)
      ]);
      perRun.push({ run, runDir, smoke, e2e, result, recurrencePause, noConfigPause, deployFiles });
    }

    const spawnedTaskFor = (runId: number): string | null => {
      const row: any = db.prepare(
        "SELECT task_key FROM run_tasks WHERE run_id = ? AND task_key LIKE 'FIX-FINAL-%' ORDER BY id ASC LIMIT 1"
      ).get(runId);
      return row?.task_key ?? null;
    };

    const runHistory: any[] = [];
    for (let i = 0; i < perRun.length; i++) {
      const cur = perRun[i];
      const next = perRun[i + 1];
      const overall = cur.result?.overall ?? null;
      if (cur.smoke) {
        const failedHere = overall === 'FAIL_SMOKE';
        runHistory.push({
          check: 'local smoke',
          env: 'LOCAL',
          firstRun: cur.smoke.result?.success ? 'passed' : 'failed',
          loopResult: failedHere && next?.result?.overall === 'PASS' ? 'cleared' : 'none',
          spawnedTask: failedHere ? spawnedTaskFor(cur.run.id) : null,
          batchId: cur.run.batch_id,
          ts: cur.smoke.ts ?? null
        });
      }
      if (cur.e2e) {
        const failedHere = overall === 'FAIL_E2E';
        runHistory.push({
          check: 'DEV e2e (authoritative)',
          env: 'DEV',
          firstRun: cur.e2e.result?.success ? 'passed' : 'failed',
          loopResult: failedHere && next?.result?.overall === 'PASS' ? 'cleared' : 'none',
          spawnedTask: failedHere ? spawnedTaskFor(cur.run.id) : null,
          batchId: cur.run.batch_id,
          ts: cur.e2e.ts ?? null
        });
      }
    }

    const deploys: any[] = [];
    for (const pr of perRun) {
      for (const filename of pr.deployFiles) {
        const dj = await readJson(pr.runDir, filename);
        if (dj) deploys.push({ batch: dj.batch, url: dj.devUrl, status: dj.result?.success ? 'passed' : 'failed', ts: dj.ts ?? null });
      }
    }

    const latest = perRun[perRun.length - 1] || null;

    let completion: any = null;
    if (cycle.status === 'completed' && latest) {
      const counts: any = db.prepare(
        "SELECT SUM(status='complete') AS done, SUM(status='deferred') AS parked, COUNT(*) AS total FROM run_tasks WHERE run_id = ?"
      ).get(latest.run.id);
      completion = {
        tasksDone: Number(counts?.done || 0),
        tasksTotal: Number(counts?.total || 0),
        parked: Number(counts?.parked || 0),
        readyForReview: true
      };
    }

    const historyCycles = (db.prepare(
      "SELECT id, name, phase, created_at AS createdAt FROM cycles WHERE project_id = ? AND status = 'completed' ORDER BY created_at DESC"
    ).all(cycle.project_id) as any[]).map(r => ({ ...r, status: 'completed' }));

    return {
      completion,
      smoke: latest?.smoke ? { success: !!latest.smoke.result?.success, cmd: latest.smoke.cmd, note: latest.smoke.result?.note ?? '', ts: latest.smoke.ts ?? null } : null,
      e2e: latest?.e2e ? { success: !!latest.e2e.result?.success, cmd: latest.e2e.cmd, note: latest.e2e.result?.note ?? '', ts: latest.e2e.ts ?? null } : null,
      recurrencePause: latest && (latest.recurrencePause || latest.noConfigPause) ? { note: latest.recurrencePause || latest.noConfigPause } : null,
      runHistory,
      deploys,
      historyCycles
    };
  });

  // B13-T01b: GET /api/cycles/:id/run-state — real per-task Implementation-tab data (R-I4/F6/B5).
  // Mirrors B11-T04: run derived server-side from cycle_id -> runs, never a client-supplied run id.
  // No run yet -> hasRun:false (honest graceful, no fabrication).
  app.get('/api/cycles/:id/run-state', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    const cycle: any = db.prepare('SELECT id FROM cycles WHERE id = ?').get(id);
    if (!cycle) return reply.code(404).send({ error: 'unknown cycle' });
    return runArtifactService.getCycleRunState(id);
  });

  // A4 (R4.18): step-level event trail from run_events — compact type+timestamp list, not transcripts.
  // Server-derives latest run from cycle_id (same guard as run-state/seats). No plan.md dependency.
  app.get('/api/cycles/:id/events', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid cycle id' });
    const cycle: any = db.prepare('SELECT id FROM cycles WHERE id = ?').get(id);
    if (!cycle) return reply.code(404).send({ error: 'unknown cycle' });
    return runArtifactService.listCycleRunEvents(id);
  });

  // LV-R2: GET /api/cycles/:id/task-terminal?role=implementer|validator — live pane of the cycle's
  // CURRENTLY-RUNNING worker for that role. PATH-SAFE + server-derived (mirrors B13-T01b's guard):
  // never accepts a client-supplied session/path — derives run + session purely from the cycle id +
  // role. Graceful 200 {session:null,text:''} when no running worker (UI keeps its "No live terminal"
  // placeholder). capturePane may throw (session vanished) → catch → {session,text:''}.
  app.get('/api/cycles/:id/task-terminal', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    const cycle: any = db.prepare('SELECT id FROM cycles WHERE id = ?').get(id);
    if (!cycle) return reply.code(404).send({ error: 'unknown cycle' });
    const role = String((request.query?.role ?? 'implementer'));
    if (role !== 'implementer' && role !== 'validator') return reply.code(400).send({ error: 'invalid role' });
    const run: any = db.prepare('SELECT id FROM runs WHERE cycle_id = ? ORDER BY id DESC LIMIT 1').get(id);
    if (!run) return { session: null, text: '' };
    const worker: any = db
      .prepare("SELECT session FROM worker_runtimes WHERE run_id = ? AND role = ? AND state IN ('launching','running') ORDER BY id DESC LIMIT 1")
      .get(run.id, role);
    if (!worker || !worker.session) return { session: null, text: '' };
    try {
      const text = await tmuxService.capturePane(worker.session, 120);
      return { session: worker.session, text: text || '' };
    } catch (e: any) {
      return { session: worker.session, text: '' };
    }
  });

  // A3 SEAM-1 (R4.17): GET /api/cycles/:id/seats — every worker_runtimes seat for runs of this cycle,
  // live OR historical (reaped/done/failed kept). Pane key = persisted worker_runtimes.id.
  // live = state launching|running AND tmux target still exists. No schema migration; join via runs.
  app.get('/api/cycles/:id/seats', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid cycle id' });
    const cycle: any = db.prepare('SELECT id FROM cycles WHERE id = ?').get(id);
    if (!cycle) return reply.code(404).send({ error: 'unknown cycle' });
    const rows: any[] = db.prepare(
      `SELECT wr.id, wr.role, wr.provider, wr.model, wr.session, wr.state,
              wr.run_id AS runId, wr.correlation_id AS batchId,
              wr.started_at AS startedAt, wr.ended_at AS endedAt
       FROM worker_runtimes wr
       JOIN runs ON runs.id = wr.run_id
       WHERE runs.cycle_id = ?
       ORDER BY wr.id ASC`
    ).all(id);
    const seats = [];
    for (const r of rows) {
      const stateLive = r.state === 'launching' || r.state === 'running';
      let tmuxAlive = false;
      if (stateLive && r.session) {
        try {
          tmuxAlive = await tmuxService.sessionExists(r.session);
        } catch {
          tmuxAlive = false;
        }
      }
      seats.push({
        id: r.id,
        role: r.role,
        provider: r.provider,
        model: r.model,
        session: r.session || null,
        state: r.state,
        runId: r.runId,
        cycleId: id,
        batchId: r.batchId || null,
        startedAt: r.startedAt || null,
        endedAt: r.endedAt || null,
        live: !!(stateLive && tmuxAlive)
      });
    }
    return { seats };
  });

  // A3 SEAM-1 path-safe capture: session resolved ONLY from (cycleId, runtimeId) in DB.
  // NEVER accepts a client-supplied session name (query/body session|sessionName ignored).
  // Foreign-cycle runtime id → 404. Mirrors /api/projects/:id/terminals/:wid security contract.
  app.get('/api/cycles/:id/seats/:runtimeId', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    const runtimeId = Number(request.params.runtimeId);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid cycle id' });
    if (!Number.isInteger(runtimeId) || runtimeId <= 0) return reply.code(400).send({ error: 'invalid runtime id' });
    const cycle: any = db.prepare('SELECT id FROM cycles WHERE id = ?').get(id);
    if (!cycle) return reply.code(404).send({ error: 'unknown cycle' });
    // Deliberately ignore request.query.session / request.body — session comes from the join only.
    const row: any = db.prepare(
      `SELECT wr.id, wr.session
       FROM worker_runtimes wr
       JOIN runs ON runs.id = wr.run_id
       WHERE wr.id = ? AND runs.cycle_id = ?`
    ).get(runtimeId, id);
    if (!row) return reply.code(404).send({ error: 'unknown seat for cycle' });
    if (!row.session) return { session: null, content: '(no session recorded for this seat)' };
    const target = `${row.session}:0.0`;
    try {
      const content = await tmuxService.capturePane(target, 200);
      return { session: row.session, content: content || '' };
    } catch (e: any) {
      console.warn('[seats] capture failed for cycle', id, 'runtime', runtimeId, e?.message);
      return { session: row.session, content: '' };
    }
  });

  // B2-T04: POST /api/cycles/:id/complete — move folder from cycle/<name> to cycle/completed/<name> + status='completed' (R-B2, R-G3).
  // Move first, status update after; 409 on collision; paths fenced under project.directory.
  app.post('/api/cycles/:id/complete', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    try {
      const c = await cycleService.completeCycle(id);
      return { cycle: c };
    } catch (e: any) {
      if (e.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
      if (e.code === 'CONFLICT') return reply.code(409).send({ error: e.message });
      if (e.code === 'FORBIDDEN') return reply.code(403).send({ error: e.message });
      return reply.code(400).send({ error: e.message });
    }
  });

  app.get('/api/projects/:id/status', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    const status = await projectStatusService.getProjectStatus(id);
    if (!status) return reply.code(404).send({ error: 'unknown project' });
    return { status };
  });

  app.get('/api/projects/:id/tech-stack-summary', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    if (!projectService.getProject(id)) return reply.code(404).send({ error: 'unknown project' });
    try {
      const summary = await projectDocsService.getTechStackSummary(id);
      return { summary };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message || 'tech-stack summary failed' });
    }
  });

  // Editable planning-brain session name (owner + local only).
  app.put('/api/projects/:id', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    if (!projectService.getProject(id)) return reply.code(404).send({ error: 'unknown project' });
    const body = request.body || {};
    const sets: string[] = [];
    const vals: any[] = [];
    if (body.name !== undefined) {
      const n = String(body.name || '').trim();
      if (!n) return reply.code(400).send({ error: 'name must be non-empty' });
      sets.push('name = ?'); vals.push(n);
    }
    if (body.directory !== undefined) {
      const d = String(body.directory || '').trim();
      if (!d) return reply.code(400).send({ error: 'directory must be non-empty' });
      sets.push('directory = ?'); vals.push(d);
    }
    if (body.description !== undefined) {
      const desc = body.description == null ? null : String(body.description);
      sets.push('description = ?'); vals.push(desc);
    }
    if (body.dev_url !== undefined) {
      const devUrl = body.dev_url == null ? null : String(body.dev_url);
      sets.push('dev_url = ?'); vals.push(devUrl);
    }
    if (body.qa_url !== undefined) {
      const qaUrl = body.qa_url == null ? null : String(body.qa_url);
      sets.push('qa_url = ?'); vals.push(qaUrl);
    }
    if (body.tags !== undefined) {
      sets.push('tags = ?'); vals.push(serializeProjectTags(body.tags));
    }
    let pc = body.plancore_session;
    if (pc !== undefined) {
      pc = pc ? String(pc).trim() : null;
      sets.push('plancore_session = ?'); vals.push(pc);
    }
    if (sets.length === 0) return reply.code(400).send({ error: 'no updatable fields provided (plancore_session, name, directory, description, dev_url, qa_url, tags)' });
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    try {
      db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      const fresh = projectService.getProject(id);
      return { project: fresh };
    } catch (e: any) {
      if (String(e.message || e).includes('UNIQUE')) return reply.code(409).send({ error: e.message });
      return reply.code(400).send({ error: e.message });
    }
  });

  // C2: per-project agents + model overrides (P2 — B9c: routes in project-agent-routes.ts + shared error mapper).
  registerProjectAgentRoutes(app, {
    projectService,
    projectAgentService,
    assignmentService,
    authMiddleware,
    requireOwnerPre,
    requireLocalLaunchPre
  });

  // v93: per-project adaptive planner panel (GET/PUT, owner + local-launch on write).
  registerPlannerPanelRoutes(app, {
    projectService,
    plannerPanelService,
    authMiddleware,
    requireOwnerPre,
    requireLocalLaunchPre,
  });

  // B8a / AC-12 + AC-12b: opt-in project role roster override + team unbind.
  registerProjectRoleRosterRoutes(app, {
    projectService,
    assignmentService,
    authMiddleware,
    requireOwnerPre,
    requireLocalLaunchPre,
  });

  // A4: role_bindings routes for per-project role assignment UI (singles + multi red-team/panelist).
  // GET (owner) returns current list (A2b already consumes listProjectBindings for red-team).
  // POST (owner + local) supports {role, agent_id}, {role, agent_ids:[]}, or {bindings:[...]}.
  // Uses setRoleBindings (clear+batch) so multiples persist for red-team; A2b run path reads them.
  // 404 on unknown project; returns fresh list on success.
  app.get('/api/projects/:id/bindings', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    const agentB = assignmentService.listProjectBindings(pid);
    const teamB = assignmentService.listProjectTeamBindings(pid);
    return { bindings: agentB, team_bindings: teamB };
  });

  app.post('/api/projects/:id/bindings', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    try {
      const body = request.body || {};
      if (body.role && Array.isArray(body.agent_ids)) {
        assignmentService.setRoleBindings(pid, body.role, body.agent_ids.map((x: any) => Number(x)));
      } else if (body.role && body.agent_id != null) {
        assignmentService.setProjectBinding(pid, body.role, Number(body.agent_id));
      } else if (body.role && body.team_id != null && (body.role === 'deliberation' || body.role === 'red-team')) {
        assignmentService.setProjectTeamBinding(pid, body.role, Number(body.team_id));
      } else if (Array.isArray(body.bindings)) {
        const byRole: Record<string, number[]> = {};
        for (const b of body.bindings) {
          if (b && b.role && b.agent_id != null) {
            (byRole[b.role] ||= []).push(Number(b.agent_id));
          }
        }
        for (const [r, aids] of Object.entries(byRole)) {
          assignmentService.setRoleBindings(pid, r, aids);
        }
        // team bindings in array
        for (const b of body.bindings) {
          if (b && b.role && b.team_id != null && (b.role==='deliberation' || b.role==='red-team')) {
            assignmentService.setProjectTeamBinding(pid, b.role, Number(b.team_id));
          }
        }
      } else {
        return reply.code(400).send({ error: 'role + (agent_id | agent_ids | team_id for team roles) or bindings[] required' });
      }
      return { bindings: assignmentService.listProjectBindings(pid) };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  // C4/B11 UI2: read-only project .md docs (now with recursive tree for project-task/run folders). Owner-guarded GETs only. 404 on unknown project. Traversal guards in service (realpath + no ..). ?tree=1 returns relPath list for tree UI; /:filename or ?path= supports subpaths for run/ etc.
  app.get('/api/projects/:id/docs', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    try {
      if (request.query && request.query.tree != null) {
        const q = request.query || {};
        const useHelmTasks = (q.scope === 'helm_tasks' || q.base === 'helm_tasks');
        if (!useHelmTasks) {
          const proj = projectService.getProject(pid);
          if (proj) await projectDocsService.scaffoldProjectFolders(proj.directory).catch(() => {});
        }
        const tree = useHelmTasks
          ? await projectDocsService.listProjectHelmTasksMdTree(pid)
          : await projectDocsService.listProjectMdTree(pid, q.base || '');
        return { docs: tree, tree: true };
      }
      const docs = await projectDocsService.listProjectDocs(pid);
      return { docs };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message || 'list failed' });
    }
  });

  app.get('/api/projects/:id/docs/:filename', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    const rel = request.query && request.query.path ? request.query.path : request.params.filename;
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    try {
      const doc = await projectDocsService.readProjectDoc(pid, rel);
      return { doc };
    } catch (e: any) {
      const isTraversal = e.code === 'TRAVERSAL' || /traversal|only \.md/i.test(String(e.message));
      return reply.code(isTraversal ? 400 : 404).send({ error: e.message || 'read failed' });
    }
  });

  // B13/R4.3: owner-guarded helm_docs write (create/update) + delete. Traversal/symlink guards in service.
  app.put('/api/projects/:id/docs/:filename', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    const rel = request.query && request.query.path ? request.query.path : request.params.filename;
    const proj = projectService.getProject(pid);
    if (!proj) return reply.code(404).send({ error: 'unknown project' });
    try {
      const body = request.body || {};
      if (typeof body.content !== 'string') return reply.code(400).send({ error: 'content required' });
      const max = (loadConfig() as any).PROJECT_DOC_BODY_MAX || 1048576;
      if (Buffer.byteLength(body.content, 'utf8') > max) return reply.code(400).send({ error: 'content too large' });
      await projectDocsService.scaffoldProjectFolders(proj.directory).catch(() => {});
      const doc = await projectDocsService.writeProjectDoc(pid, rel, body.content);
      return { doc };
    } catch (e: any) {
      if (e?.code === 'TOO_LARGE') return reply.code(400).send({ error: e.message || 'content too large' });
      const isTraversal = e.code === 'TRAVERSAL' || /traversal|only \.md|symlink/i.test(String(e.message));
      return reply.code(isTraversal ? 400 : 404).send({ error: e.message || 'write failed' });
    }
  });

  app.delete('/api/projects/:id/docs/:filename', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    const rel = request.query && request.query.path ? request.query.path : request.params.filename;
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    try {
      await projectDocsService.deleteProjectDoc(pid, rel);
      return { ok: true };
    } catch (e: any) {
      const isTraversal = e.code === 'TRAVERSAL' || /traversal|only \.md|symlink/i.test(String(e.message));
      return reply.code(isTraversal ? 400 : 404).send({ error: e.message || 'delete failed' });
    }
  });

  // P3-2: toolkits CRUD + agent manifest (LEAN prompt md sidecars).
  // Reads: owner; mutations: owner + loopback; size caps 400; 404/409 as specified; attach/detach use position auto-append in service if omitted.
  app.get('/api/toolkits', { preHandler: [authMiddleware, requireOwnerPre] }, async () => ({ toolkits: toolkitService.listToolkits() }));
  app.get('/api/toolkits/:id', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    const tk = toolkitService.getToolkit(id);
    if (!tk) return reply.code(404).send({ error: 'unknown toolkit' });
    return { toolkit: tk };
  });
  app.post('/api/toolkits', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    try {
      const body = request.body || {};
      const max = (loadConfig() as any).TOOLKIT_BODY_MAX || 50000;
      if (body.body_md && typeof body.body_md === 'string' && body.body_md.length > max) {
        return reply.code(400).send({ error: 'body_md too long (max ' + max + ')' });
      }
      const tk = toolkitService.createToolkit(body);
      return { toolkit: tk };
    } catch (e: any) {
      if (e.message && e.message.includes('unique')) return reply.code(400).send({ error: e.message });
      return reply.code(400).send({ error: e.message });
    }
  });
  app.put('/api/toolkits/:id', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    const body = request.body || {};
    const max = (loadConfig() as any).TOOLKIT_BODY_MAX || 50000;
    if (body.body_md && typeof body.body_md === 'string' && body.body_md.length > max) {
      return reply.code(400).send({ error: 'body_md too long (max ' + max + ')' });
    }
    if (!toolkitService.getToolkit(id)) return reply.code(404).send({ error: 'unknown toolkit' });
    try {
      const tk = toolkitService.updateToolkit(id, body);
      return { toolkit: tk };
    } catch (e: any) {
      if (!toolkitService.getToolkit(id)) return reply.code(404).send({ error: 'unknown toolkit' });
      if (e.message && e.message.includes('unique')) return reply.code(400).send({ error: e.message });
      return reply.code(400).send({ error: e.message });
    }
  });
  app.delete('/api/toolkits/:id', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    if (!toolkitService.getToolkit(id)) return reply.code(404).send({ error: 'unknown toolkit' });
    try {
      toolkitService.deleteToolkit(id);
      return { ok: true };
    } catch (e: any) {
      if (!toolkitService.getToolkit(id)) return reply.code(404).send({ error: 'unknown toolkit' });
      if (e.message && e.message.includes('attached')) return reply.code(409).send({ error: e.message });
      return reply.code(400).send({ error: e.message });
    }
  });

  // P3-2 agent manifest (list always observable; attach/detach 404 unknown agent or toolkit)
  app.get('/api/agents/:id/toolkits', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any) => {
    const id = Number(request.params.id);
    return { toolkits: toolkitService.listAgentToolkits(id) };
  });
  app.post('/api/agents/:id/toolkits', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const agentId = Number(request.params.id);
    const body = request.body || {};
    if (!assignmentService.getAgent(agentId)) return reply.code(404).send({ error: 'unknown agent' });
    const tkId = Number(body.toolkit_id);
    if (!toolkitService.getToolkit(tkId)) return reply.code(404).send({ error: 'unknown toolkit' });
    try {
      toolkitService.attachToolkit(agentId, tkId, body.position);
      return { ok: true };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });
  app.delete('/api/agents/:id/toolkits/:tid', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const agentId = Number(request.params.id);
    const tid = Number(request.params.tid);
    if (!assignmentService.getAgent(agentId)) return reply.code(404).send({ error: 'unknown agent' });
    if (!toolkitService.getToolkit(tid)) return reply.code(404).send({ error: 'unknown toolkit' });
    try {
      toolkitService.detachToolkit(agentId, tid);
      return { ok: true };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  // Project config API (H6/H7): owner-only, real OVM id via seam, model validate vs P1-2 registry, set-up flag
  app.get('/api/projects/:id/config', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const projectId = Number(request.params.id);
    // D1: native Helm projects table is the sole :id authority.
    const exists = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
    if (!exists) return reply.code(400).send({ error: 'unknown project' });
    const master_chain = masterService.getChain(projectId);
    const bindings = assignmentService.listProjectBindings(projectId);
    const team_bindings = assignmentService.listProjectTeamBindings(projectId);
    const role_defaults = assignmentService.listRoleDefaults();
    const is_set_up = masterService.isSetUp(projectId);
    const autonomy_default = projectService.getAutonomyDefault(projectId);
    return { master_chain, bindings, team_bindings, role_defaults, is_set_up, autonomy_default };
  });

  app.put('/api/projects/:id/config', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const projectId = Number(request.params.id);
    // D1: native Helm projects table is the sole :id authority.
    const exists = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
    if (!exists) return reply.code(400).send({ error: 'unknown project' });
    const body = request.body || {};
    const { master_chain = [], bindings = [], team_bindings = [] } = body;
    // RT0 M7: basic input validation on config write path
    if (!Array.isArray(master_chain) || master_chain.length > 10) return reply.code(400).send({ error: 'invalid master_chain (array, max 10)' });
    if (!Array.isArray(bindings)) return reply.code(400).send({ error: 'invalid bindings' });
    // RTF-M4: wrap chain + bindings in one txn
    const raw = (db as any).raw;
    raw.exec('BEGIN IMMEDIATE;');
    try {
      masterService.setChain(projectId, master_chain);
      // A4: group by role then setRoleBindings (supports multi red-team/panelist after unique relax; singles stay 1:1).
      // (Previously per-item setProjectBinding; now batch per role for A2b red-team multi + UI role-assign.)
      const byRole: Record<string, number[]> = {};
      for (const b of bindings) {
        if (b && b.role && b.agent_id != null) {
          (byRole[b.role] ||= []).push(Number(b.agent_id));
        }
      }
      for (const [r, aids] of Object.entries(byRole)) {
        assignmentService.setRoleBindings(projectId, r, aids);
      }
      for (const tb of team_bindings) {
        if (tb && tb.role && tb.team_id != null) {
          assignmentService.setProjectTeamBinding(projectId, tb.role, Number(tb.team_id));
        }
      }
      if (body.autonomy_default !== undefined) {
        projectService.setAutonomyDefault(projectId, body.autonomy_default);
      }
      raw.exec('COMMIT;');
    } catch (e: any) {
      try { raw.exec('ROLLBACK;'); } catch {}
      return reply.code(400).send({ error: e.message });
    }
    const is_set_up = masterService.isSetUp(projectId);
    const autonomy_default = projectService.getAutonomyDefault(projectId);
    return { ok: true, is_set_up, autonomy_default };
  });

  // P1-6a: Command Center chat routes (owner-only; setup list only set-up projects; ensure running; record+deliver via events/sendAndSubmit; history from agent_events)
  // RT0: added requireLocalLaunchPre (H9); use request.body (H3); input validation (M7)
  app.get('/api/projects/setup', { preHandler: [authMiddleware, requireOwnerPre] }, async () => {
    // D1 flip (C1 dep, one-at-a-time): Helm projects table is now source of truth for :id (per consensus).
    // Map to prior shape for compatibility (name -> directory_name/display_name); filter isSetUp unchanged.
    const all = db
      .prepare("SELECT id, name FROM projects ORDER BY id")
      .all();
    const setup = all.map((p: any) => ({ id: p.id, directory_name: p.name, display_name: p.name }))
      .filter((p: any) => masterService.isSetUp(p.id));
    return { projects: setup };
  });

  app.get('/api/projects/:id/chat', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const projectId = Number(request.params.id);
    // D1: native Helm projects table is the sole :id authority.
    const exists = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
    if (!exists) return reply.code(400).send({ error: 'unknown project' });
    if (!masterService.isSetUp(projectId)) return reply.code(400).send({ error: 'project not set up (no master chain)' });
    // Project-scoped, batch-keyed transcript: renders immediately (no live-master requirement) and survives hot-swaps.
    const runRow: any = db.prepare("SELECT master_run_id FROM master_runtimes WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1").get(projectId);
    let messages = eventsService.listByBatch(`chat-${projectId}`);
    // CC-CHAT-2 R3: merge the project's CURRENT run's coordinator callbacks as chat bubbles.
    // Source = the run dir's callbacks.md (the COMPLETE record: the loop only persists terminal
    // states to the `callbacks` table and never writes agent_events for run callbacks). Active
    // run preferred, else the most recent terminal one. Read-only + fast (one file read), the
    // merge is best-effort — the owner transcript always returns.
    let runInfo: any = null;
    try {
      const runSel: any = db.prepare(
        `SELECT id, batch_id, phase, status, started_at FROM runs WHERE project_id = ?
         ORDER BY (CASE WHEN phase NOT IN ('complete','failed','blocked') THEN 1 ELSE 0 END) DESC, id DESC LIMIT 1`
      ).get(projectId);
      if (runSel && runSel.batch_id) {
        runInfo = { id: runSel.id, batch_id: runSel.batch_id, phase: runSel.phase, status: runSel.status };
        let cbContent = '';
        try { cbContent = await readFile(path.join(resolveRunDir(projectId, runSel.batch_id), 'callbacks.md'), 'utf8'); } catch {} // #46
        if (cbContent) {
          const parsed = parseCallbacksMd(cbContent, runSel.batch_id);
          let startedIso = new Date(String(runSel.started_at).replace(' ', 'T') + (String(runSel.started_at).endsWith('Z') ? '' : 'Z')).toISOString();
          // Callbacks can only exist AFTER the run prompt — clamp the fallback stamp just past the
          // prompt event (runs.started_at is second-truncated; the prompt bubble has ms precision).
          const promptEv: any = messages.find((m: any) => m?.body?.kind === 'run-prompt' && m?.body?.run_pk === runSel.id);
          if (promptEv && tsToMs(promptEv.ts) >= tsToMs(startedIso)) startedIso = new Date(tsToMs(promptEv.ts) + 1).toISOString();
          const tsArr = runCbTsCache.assign(`${projectId}:${runSel.batch_id}`, parsed.length, startedIso);
          // A14 (D8/R4.31): helm_pm is a shared face for BOTH plancore and ibrain — resolve which
          // one actually emitted a given line via this run's own worker_runtimes dispatch windows
          // (same class of fix as agent-event-ingest.ts's roleMatches(run.role, parsed.role)).
          let brainDispatches: { role: 'plancore' | 'ibrain'; startedAtMs: number; endedAtMs: number | null; model?: string | null; provider?: string | null }[] = [];
          try {
            const wrRows: any[] = db.prepare(
              `SELECT role, model, provider, started_at, ended_at FROM worker_runtimes
               WHERE run_id = ? AND role IN ('plancore','ibrain') AND started_at IS NOT NULL
               ORDER BY started_at ASC`
            ).all(runSel.id);
            brainDispatches = wrRows.map((row, idx) => {
              const startedAtMs = tsToMs(row.started_at);
              const nextStart = wrRows[idx + 1] ? tsToMs(wrRows[idx + 1].started_at) : null;
              // worker_runtimes.started_at/ended_at are SQLite datetime('now') — SECOND granularity —
              // while a callback line's own ts (CallbackTsCache) is millisecond-precision. A line
              // genuinely emitted just before a new dispatch can still land in the SAME reported second
              // as that dispatch's (truncated-down) started_at. When a window's end is only IMPLICIT
              // (the next dispatch's start, not this row's own recorded ended_at), pad it by just under
              // a full second so a same-second line still resolves to the OLDER, already-active window
              // rather than being prematurely handed to a dispatch that may not truly have started yet.
              const endedAtMs = row.ended_at ? tsToMs(row.ended_at) : (nextStart != null ? nextStart + 999 : null);
              return { role: row.role, startedAtMs, endedAtMs, model: row.model, provider: row.provider };
            });
          } catch { /* best-effort — falls back to the honest helm_pm label, never a guess */ }
          const cbMsgs = toRunChatMessages(parsed, { projectId, runPk: runSel.id, batchId: runSel.batch_id, ts: tsArr, brainDispatches });
          messages = mergeChatMessages(messages, cbMsgs);
        }
      }
    } catch { /* best-effort merge */ }
    return { run_id: runRow?.master_run_id || `master:${projectId}`, run: runInfo, messages };
  });

  app.post('/api/projects/:id/chat', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const projectId = Number(request.params.id);
    // D1: native Helm projects table is the sole :id authority.
    const exists = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
    if (!exists) return reply.code(400).send({ error: 'unknown project' });
    if (!masterService.isSetUp(projectId)) return reply.code(400).send({ error: 'project not set up (no master chain)' });
    if (runtimeService.hasActiveSwapLock(projectId)) return reply.code(409).send({ error: 'swap in progress' });
    const body = request.body || {};
    const text = (body.text || '').trim();
    if (!text) return reply.code(400).send({ error: 'text is required' });
    if (text.length > 2000) return reply.code(400).send({ error: 'text too long (max 2000)' });
    const chatBatch = `chat-${projectId}`;
    const existing: any = db.prepare("SELECT master_run_id, tmux_session FROM master_runtimes WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1").get(projectId);
    // run_id is project-stable so the owner message records + renders immediately, independent of any master launch.
    const runId = existing?.master_run_id || `master:${projectId}`;
    const correlation_id = `chat:${projectId}:${Date.now()}`;
    // A3: if the project has an active run, route owner chat to the brain that owns its current phase.
    // Existing ingest/SSE/activity + chat bubbles continue to work (record under chat batch). Master launch skipped when active run (run owns the session).
    // Old master-chat path fully preserved when no active run.
    let targetSession = existing ? existing.tmux_session : null;
    let hasActiveRun = false;
    try {
      const ar: any = db.prepare("SELECT phase FROM runs WHERE project_id = ? AND phase NOT IN ('complete','failed','blocked') ORDER BY id DESC LIMIT 1").get(projectId);
      hasActiveRun = !!ar;
      if (hasActiveRun) {
        const projRow: any = db.prepare("SELECT name, plancore_session FROM projects WHERE id = ?").get(projectId);
        const slug = String(projRow?.name || 'proj').toLowerCase().replace(/[^a-z0-9]+/g, '_');
        targetSession = ar.phase === 'interview'
          ? `helm-discovery-${slug}`
          : ar.phase === 'planning'
            ? (projRow?.plancore_session || `helm-plancore-${slug}`)
            : `helm-ibrain-${slug}`;
      }
    } catch {}
    // RECORD-FIRST: the user's message is persisted (and thus rendered) immediately — never lost on a launch failure.
    const event = eventsService.recordEvent({
      run_id: runId,
      role: 'owner',
      batch_id: chatBatch,
      session: targetSession ? `${targetSession}:0.0` : null,
      type: 'message',
      source: 'post',
      correlation_id,
      body: { text }
    });
    // Deliver happens in the BACKGROUND (best-effort, quick-return — nothing on this route may block).
    // CC-CHAT-1 B2: NO auto-launch when there is no active run (was launchMaster → minutes-long block
    // class + surprise sessions; the JROM 524 report). No active run → the composer talks to the
    // project agent-chat session (B1 endpoints) instead; this route only delivers to an ALREADY-live
    // run/master phase-brain session.
    // CC-CHAT-2 R7: delivery outcome is patched onto the owner event (delivered:true/false + session)
    // so the UI can show a failed-delivery hint — delivery NEVER fails silently again.
    void (async () => {
      const markDelivered = (delivered: boolean, err?: string) => {
        try { eventsService.updateBody(event.id, { delivered, session: targetSession, ...(err ? { deliver_error: err } : {}) }); } catch {}
      };
      try {
        let target = targetSession ? `${targetSession}:0.0` : null;
        const alive = targetSession && (await tmuxService.sessionExists(targetSession)) && !!(await tmuxService.getPanePid(target!));
        if (!alive) target = null;
        if (target) {
          // hardened sendAndSubmit: literal paste + Enter with backoff re-press + nudge dismiss —
          // a plain typed answer lands in the claude TUI's AskUserQuestion-style menu via its
          // "type something" option (text + Enter).
          const submitted = await tmuxService.sendAndSubmit(target!, text);
          if (!submitted) throw new Error('sendAndSubmit returned false (delivery unconfirmed)');
          markDelivered(true);
        } else if (hasActiveRun) {
          throw new Error(`active run session not live (delivery skipped; target=${targetSession || 'none'})`);
        }
      } catch (e: any) {
        markDelivered(false, String(e?.message || e));
        eventsService.recordEvent({
          run_id: runId, role: 'system', batch_id: chatBatch, session: null,
          type: 'status', state: 'deliver-failed', source: 'post',
          correlation_id: `chat-deliver-fail:${projectId}:${Date.now()}`,
          body: { error: String(e?.message || e), text }
        });
      }
    })();
    return { ok: true, event, run_id: runId };
  });

  // D1: sanctioned POST /api/ingest/chat-reply for master replies in clean-chat channel (backend only; D2 adds UI).
  // Loopback + token-auth. SECURITY (red-team): project_id derived EXCLUSIVELY from the verified JWT claim in the token.
  // Body (even if it contains project_id=X) is ignored for scoping — records under token's pid only. Cross-project spoof rejected.
  // task_id: mandatory per convention in prompt; backend warns (does not 400) + still records.
  app.post('/api/ingest/chat-reply', { preHandler: [requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'missing or invalid authorization header' });
    }
    const token = authHeader.slice(7);
    const verified = authService.verifyMasterChatToken(token);
    if (!verified) {
      return reply.code(401).send({ error: 'invalid or expired master chat token' });
    }
    const projectId = verified.projectId; // FROM TOKEN ONLY — never body
    const body = request.body || {};
    const text = (body.text || '').trim();
    if (!text) return reply.code(400).send({ error: 'text is required' });
    if (text.length > 2000) return reply.code(400).send({ error: 'text too long (max 2000)' });
    const task_id = body.task_id;
    if (task_id == null || task_id === '') {
      console.warn(`[chat-reply] missing task_id for project ${projectId}; recording anyway (warn-only per spec)`);
    }
    const chatBatch = `chat-${projectId}`;
    const existing: any = db.prepare("SELECT master_run_id, tmux_session FROM master_runtimes WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1").get(projectId);
    const runId = existing?.master_run_id || `master:${projectId}`;
    const correlation_id = `chat-reply:${projectId}:${Date.now()}`;
    eventsService.recordEvent({
      run_id: runId,
      role: 'master',
      batch_id: chatBatch,
      session: existing ? `${existing.tmux_session}:0.0` : null,
      type: 'message',
      source: 'chat',
      correlation_id,
      body: { text, task_id: task_id ?? null }
    });
    return { ok: true };
  });

  // D3: sanctioned POST /api/ingest/task-update (coordinator path, like chat-reply D1).
  // Loopback + token-auth (requireLocalLaunchPre). SECURITY (red-team critical): project_id derived EXCLUSIVELY
  // from the verified JWT claim in the token (reuse D1 masterChatSecret + verifyMasterChatToken).
  // Body (even if it contains project_id=X) is ignored for scoping — upserts under token's pid only.
  // Cross-project spoof (token for Y + body project_id=X) is rejected by design (records under Y never X).
  // Matches chat-reply exactly for the "master-chat token" pattern.
  app.post('/api/ingest/task-update', { preHandler: [requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'missing or invalid authorization header' });
    }
    const token = authHeader.slice(7);
    const verifiedMaster = authService.verifyMasterChatToken(token);
    const scoped = authService.verifyScopedAgentToken(token);
    if (!verifiedMaster && !scoped) {
      return reply.code(401).send({ error: 'invalid or expired token' });
    }
    // B7 SEC1: close the broad unauthenticated worker-callback path.
    // Worker/agent roles (implementer/validator) must use scoped run/role/task token; master-chat (project broad) rejected for them.
    const body = request.body || {};
    if (verifiedMaster && !scoped) {
      const bodyRole = body.role || '';
      if (['implementer', 'validator'].includes(bodyRole)) {
        return reply.code(403).send({ error: 'broad unauthenticated worker-callback path closed; use scoped run/role/task token' });
      }
    }
    // cross-scope example hook (for test; real callers use claim-derived only)
    if (scoped && body.expectedBatch && scoped.batchId !== body.expectedBatch) {
      return reply.code(403).send({ error: 'cross-scope token rejected' });
    }
    const projectId = verifiedMaster ? verifiedMaster.projectId : scoped!.projectId; // FROM TOKEN ONLY — never body (no cross-project)
    const label = (body.label || '').trim();
    if (!label) return reply.code(400).send({ error: 'label is required' });
    if (label.length > 2000) return reply.code(400).send({ error: 'label too long (max 2000)' });
    const t = {
      task_key: body.task_key || null,
      label,
      status: (['completed', 'working', 'pending'].includes(body.status) ? body.status : 'pending') as 'completed' | 'working' | 'pending',
      agent: body.agent || null,
      position: typeof body.position === 'number' ? body.position : 0
    };
    const row = taskService.upsertTask(projectId, t);
    return { ok: true, task: row };
  });

  // O5.2: sealed run-ingest registration for the external OVM/tiller coordinator.
  // Loopback + coordinator/phase-brain-scoped token ONLY (master-chat and worker-scoped tokens rejected —
  // this path is coordinator-facing, not a per-task worker callback). project_id derived EXCLUSIVELY
  // from the verified token claim; a body project_id that disagrees is a spoof attempt and is rejected
  // before any write. Envelope schema/hash validation and the exactly-once transaction live in RunIngestService.
  app.post('/api/ingest/run-register', { preHandler: [requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'missing or invalid authorization header' });
    }
    const token = authHeader.slice(7);
    const scoped = authService.verifyScopedAgentToken(token);
    if (!scoped) {
      return reply.code(401).send({ error: 'invalid or expired token' });
    }
    if (!['coord', 'plancore', 'ibrain'].includes(scoped.role)) {
      return reply.code(403).send({ error: 'coordinator/phase-brain-scoped token required' });
    }
    const body = request.body || {};
    if (body.project_id != null && Number(body.project_id) !== scoped.projectId) {
      return reply.code(403).send({ error: 'cross-project spoof rejected' });
    }
    const guard = requireActiveNativeProject(identityService, scoped.projectId);
    if (!guard.ok) {
      return reply.code(400).send({ error: guard.error });
    }
    try {
      const result = runIngestService.register(guard.project.id, body);
      return reply.code(result.httpStatus).send(result.body);
    } catch (e: any) {
      if (e instanceof RunIngestValidationError) {
        return reply.code(400).send({ error: e.message });
      }
      if (e instanceof RunIngestConflictError) {
        return reply.code(409).send({ error: e.message });
      }
      throw e;
    }
  });

  // O5.3: sealed run-ingest terminal completion for the external OVM/tiller coordinator.
  // Same loopback + coordinator/phase-brain-scoped token gate and project_id-from-token-claim
  // rule as run-register. Revision CAS, terminal-state mapping, and the exactly-once
  // completion transaction live in RunIngestService.
  app.post('/api/ingest/run-complete', { preHandler: [requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'missing or invalid authorization header' });
    }
    const token = authHeader.slice(7);
    const scoped = authService.verifyScopedAgentToken(token);
    if (!scoped) {
      return reply.code(401).send({ error: 'invalid or expired token' });
    }
    if (!['coord', 'plancore', 'ibrain'].includes(scoped.role)) {
      return reply.code(403).send({ error: 'coordinator/phase-brain-scoped token required' });
    }
    const body = request.body || {};
    if (body.project_id != null && Number(body.project_id) !== scoped.projectId) {
      return reply.code(403).send({ error: 'cross-project spoof rejected' });
    }
    const guard = requireActiveNativeProject(identityService, scoped.projectId);
    if (!guard.ok) {
      return reply.code(400).send({ error: guard.error });
    }
    try {
      const result = runIngestService.complete(guard.project.id, body);
      return reply.code(result.httpStatus).send(result.body);
    } catch (e: any) {
      if (e instanceof RunIngestValidationError) {
        return reply.code(400).send({ error: e.message });
      }
      if (e instanceof RunIngestConflictError) {
        return reply.code(409).send({ error: e.message });
      }
      throw e;
    }
  });

  // D2: Command Center tmux raw log pane (owner read-only).
  // Req (1): :id validated vs Helm projects table (D1 flip pattern) + owner-guard + isSetUp.
  // Resolve tmux_session STRICTLY from master_runtimes query for the pid (trusted DB row only — NEVER from request input/params to prevent command injection in capture-pane shell cmd).
  // Uses tmuxService.capturePane (safe execFile array + ensureValidTarget inside).
  app.get('/api/projects/:id/terminal', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const projectId = Number(request.params.id);
    const exists = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
    if (!exists) return reply.code(400).send({ error: 'unknown project' });
    if (!masterService.isSetUp(projectId)) return reply.code(400).send({ error: 'project not set up (no master chain)' });
    const runRow: any = db.prepare("SELECT tmux_session FROM master_runtimes WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1").get(projectId);
    if (!runRow || !runRow.tmux_session) {
      return { session: null, content: '(no active master tmux session for project)' };
    }
    const target = `${runRow.tmux_session}:0.0`;
    try {
      const content = await tmuxService.capturePane(target, 200);
      return { session: runRow.tmux_session, content: content || '' };
    } catch (e: any) {
      console.warn('[terminal] capture failed for', projectId, e?.message);
      return { session: runRow.tmux_session, content: '' };
    }
  });

  // CC-MT: Command Center Multi-Terminal viewer support (10-command-center-terminals).
  // Lists the per-worker terminals for a project's active run so the UI can show N tmux panes at once.
  // Source of truth = master_runtimes (coordinator pseudo-worker) + worker_runtimes rows. Owner-guarded, :id validated.
  // Runtime state → status badge mapping mirrors the mockup vocabulary (WORKING/DONE/FAIL/idle).
  // A15: WORKING only when state is launching|running AND tmux target still exists; self-heal
  // finalize session-gone so stuck running/ended_at NULL never paints live.
  app.get('/api/projects/:id/terminals', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const projectId = Number(request.params.id);
    const exists = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
    if (!exists) return reply.code(400).send({ error: 'unknown project' });
    const mapState = (state: string, kind: 'master' | 'worker', tmuxAlive?: boolean): string => {
      if (state === 'running' || state === 'launching') {
        // A15: truthful live — dead tmux is historical/idle, not WORKING.
        if (kind === 'worker' && tmuxAlive === false) return 'idle';
        return 'WORKING';
      }
      if (state === 'done') return 'DONE';
      if (state === 'failed') return 'FAIL';
      if (state === 'parked') return 'idle';
      if (state === 'reaped') return 'idle';
      return kind === 'master' ? 'WORKING' : 'idle';
    };
    const out: any[] = [];
    const m: any = db.prepare("SELECT master_run_id, tmux_session, provider, model, state FROM master_runtimes WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1").get(projectId);
    if (m && m.tmux_session) {
      out.push({
        id: 'master',
        kind: 'master',
        role: 'coordinator',
        provider: m.provider || '—',
        model: m.model || '—',
        session: m.tmux_session,
        state: m.state,
        status: mapState(m.state, 'master'),
        task: null,
        batchId: m.master_run_id || null
      });
    }
    const ws: any[] = db.prepare("SELECT id, role, provider, model, session, state, task_brief, correlation_id, started_at, ended_at FROM worker_runtimes WHERE project_id = ? ORDER BY id DESC").all(projectId);
    const { finalizeWorkerRuntimeRow } = await import('./services/worker-runtime-finalize.js');
    for (const w of ws) {
      let state = String(w.state || '');
      let endedAt = w.ended_at || null;
      let tmuxAlive: boolean | undefined;
      const stateLive = state === 'launching' || state === 'running';
      if (stateLive && w.session) {
        try {
          tmuxAlive = await tmuxService.sessionExists(String(w.session));
        } catch {
          tmuxAlive = false;
        }
        if (!tmuxAlive) {
          // Self-heal: session gone but row still running → terminalize so next read is consistent.
          finalizeWorkerRuntimeRow(db, Number(w.id), 'reaped', 'session-gone');
          state = 'reaped';
          endedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
        }
      } else if (stateLive && !w.session) {
        tmuxAlive = false;
        finalizeWorkerRuntimeRow(db, Number(w.id), 'reaped', 'session-gone');
        state = 'reaped';
        endedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
      }
      out.push({
        id: String(w.id),
        kind: 'worker',
        role: w.role,
        provider: w.provider,
        model: w.model,
        session: w.session || null,
        state,
        status: mapState(state, 'worker', tmuxAlive),
        live: !!(stateLive && tmuxAlive && state !== 'reaped'),
        task: w.task_brief || null,
        batchId: w.correlation_id || null,
        startedAt: w.started_at || null,
        endedAt
      });
    }
    return { workers: out };
  });

  // CC-MT: capture a single worker/coordinator tmux pane for the multi-terminal grid.
  // SECURITY: the tmux session is resolved STRICTLY from a trusted DB row keyed by (projectId, wid) —
  // NEVER from request input — so the capture-pane target cannot be attacker-controlled (same pattern as /terminal).
  // wid = 'master' → master_runtimes.tmux_session; else numeric worker_runtimes.id scoped to this project.
  app.get('/api/projects/:id/terminals/:wid', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const projectId = Number(request.params.id);
    const wid = String(request.params.wid);
    const exists = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
    if (!exists) return reply.code(400).send({ error: 'unknown project' });
    let session: string | null = null;
    if (wid === 'master') {
      const row: any = db.prepare("SELECT tmux_session FROM master_runtimes WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1").get(projectId);
      session = row?.tmux_session || null;
    } else {
      const idNum = Number(wid);
      if (!Number.isInteger(idNum)) return reply.code(400).send({ error: 'invalid worker id' });
      const row: any = db.prepare("SELECT session FROM worker_runtimes WHERE id = ? AND project_id = ?").get(idNum, projectId);
      session = row?.session || null;
    }
    if (!session) return { session: null, content: '(no active tmux session for this worker)' };
    const target = `${session}:0.0`;
    try {
      const content = await tmuxService.capturePane(target, 200);
      return { session, content: content || '' };
    } catch (e: any) {
      console.warn('[workers] capture failed for', projectId, wid, e?.message);
      return { session, content: '' };
    }
  });

  // D3: per-project tasks + roster (C3r). Owner-guarded, :id validated vs Helm projects table (D1 flip).
  // /tasks folds roster for single roundtrip (client efficiency); /roster available standalone.
  // Roster derived server-side via TaskService from master_runtimes + worker_runtimes (state mapping).
  app.get('/api/projects/:id/tasks', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const projectId = Number(request.params.id);
    const exists = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
    if (!exists) return reply.code(400).send({ error: 'unknown project' });
    const tasks = taskService.listTasks(projectId);
    const roster = taskService.getRoster(projectId);
    return { tasks, roster };
  });

  // B11 OBS1: run timeline over agent_events (dispatch→callback→ACK→gate→validation→...) for the project's current run.
  // Real data, no mocks. Seq for UI.
  app.get('/api/projects/:id/timeline', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    const runRow: any = db.prepare("SELECT master_run_id FROM master_runtimes WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1").get(pid);
    const runId = runRow?.master_run_id || `master:${pid}`;
    const events = db.prepare('SELECT * FROM agent_events WHERE run_id = ? ORDER BY ts ASC, id ASC LIMIT 300').all(runId);
    return { run_id: runId, events };
  });

  app.get('/api/projects/:id/roster', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const projectId = Number(request.params.id);
    const exists = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
    if (!exists) return reply.code(400).send({ error: 'unknown project' });
    return { roster: taskService.getRoster(projectId) };
  });

  // A2: Run orchestrator (start a prompt-driven planned run using RealT + planning/parser/loop; owner + local for start).
  // A3: added GET /api/projects/:id/runs (latest run status for "has active?" + reload); POST accepts optional batchId (test seam for e2e pre-seed determinism).
  // A3 gate fix: NO masterService.isSetUp / old master-chain gate on /runs path (unlike /chat /terminal paths). Keep only owner + local-launch auth + project exists. Directory-registered projects (no old master chain) MUST be able to start a real run from the CC chat send.
  // GET status for phase/tasks/current (A3 will poll + timeline from agent_events + runs).
  // D-b1: POST /runs for a CC task list starts in interview with the discovery brain; autonomous execution begins only after NORTH-STAR-READY + planning.
  // B1 (N10): body.cycleId is now REQUIRED and validated against :id — this was the one starter that
  // could create an unlinked run (no UI control calls it; start-planning/start-implementation already
  // derive cycleId server-side from the URL and are unaffected).
  app.post('/api/projects/:id/runs', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    const body = request.body || {};
    // B1 (N10): every created run must be cycle-linked (R2.8) — this was the one starter that could
    // create a run with NO cycleId at all. Validate + refuse BEFORE any run row exists; never silently
    // pick a cycle. start-planning/start-implementation already derive cycleId server-side from the URL.
    const cid = Number(body.cycleId);
    if (!Number.isFinite(cid)) return reply.code(400).send({ error: 'cycleId required' });
    const cycle: any = db.prepare('SELECT id, project_id FROM cycles WHERE id = ?').get(cid);
    if (!cycle || Number(cycle.project_id) !== pid) return reply.code(400).send({ error: 'unknown cycle for this project' });
    const seedPlan = typeof body.seedPlan === 'string' && body.seedPlan.trim() ? body.seedPlan.trim() : undefined;
    // PLAN-CACHE Phase-2 replay uses the cached north-star, so a prompt is not required when seedPlan is set.
    const prompt = (body.prompt || (seedPlan ? `[plan-cache replay: ${seedPlan}]` : '')).trim();
    if (!prompt) return reply.code(400).send({ error: 'prompt required' });
    try {
      // CC-CHAT-1 B2: return IMMEDIATELY (Cloudflare-524 class fix). startRun runs in the background
      // (fire-and-forget with error logging inside startRunDetached; failures mark the run failed).
      // Callers poll GET /api/projects/:id/runs — the CC already does.
      const { runId } = runOrchestratorService.startRunDetached({ projectId: pid, cycleId: cid, prompt, roleBindings: body.roleBindings, batchId: body.batchId, seedPlan });
      return { runId, status: 'started' };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message || 'startRun failed' });
    }
  });

  // POST /api/cycles/:id/start-planning — the missing counterpart to start-implementation.
  // Planning is what PRODUCES plan.md, so this path must NOT require one (start-implementation 400s
  // without a valid plan, which left the UI with no way to reach planning at all: the only wired
  // starter was POST /api/projects/:id/runs, which no UI control ever called and which does not link
  // the run to a cycle). Same shape as start-implementation minus the plan gate: cycle-linked (so the
  // run is visible on the cycle board), same duplicate-run 409 guard, project derived server-side.
  app.post('/api/cycles/:id/start-planning', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const cid = Number(request.params.id);
    const cycle: any = db.prepare('SELECT id, project_id, phase FROM cycles WHERE id = ?').get(cid);
    if (!cycle) return reply.code(404).send({ error: 'unknown cycle' });
    const pid = Number(cycle.project_id);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    const body = request.body || {};

    // Never two concurrent runs for a cycle (mirrors IS-R4; makes a double-click idempotent).
    try {
      const rs = runArtifactService.getCycleRunState(cid);
      if (rs.hasRun && rs.runActive) {
        return reply.code(409).send({ error: 'a run is already active for this cycle' });
      }
    } catch { /* if run-state read fails, fall through to normal start */ }

    const prompt = (body.prompt || `plan cycle ${cid} from the project docs`).trim();
    if (!prompt) return reply.code(400).send({ error: 'prompt required' });
    try {
      // No seedPlan and no cyclePlan: the full front half of the engine — interview with the
      // discovery brain, then planning (D-b1). Autonomous execution begins only after
      // NORTH-STAR-READY + planning, so this is safe to trigger from a button.
      const { runId, batchId } = runOrchestratorService.startRunDetached({ projectId: pid, cycleId: cid, prompt, roleBindings: body.roleBindings, batchId: body.batchId });
      try { cycleService.setCyclePhase(cid, 'planning'); } catch { /* phase flip is cosmetic */ }
      return { runId, batchId, cycleId: cid, status: 'started' };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message || 'startRun failed' });
    }
  });

  // B13-T03d: POST /api/cycles/:id/start-implementation — start a helm-algo run LINKED to this cycle
  // (runs.cycle_id) so the run is reviewable in the cycle's Implementation tab (getCycleRunState reads
  // runs WHERE cycle_id=?). This is the CC's "drive the engine on this cycle" wire — the missing join
  // between the cycle board and the run engine. Project + cycle derived server-side from the cycle id
  // (path-safe; no client-supplied path/project). Body: { prompt?, roleBindings?, seedPlan?, batchId? }.
  app.post('/api/cycles/:id/start-implementation', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const cid = Number(request.params.id);
    const cycle: any = db.prepare('SELECT id, project_id, phase FROM cycles WHERE id = ?').get(cid);
    if (!cycle) return reply.code(404).send({ error: 'unknown cycle' });
    const pid = Number(cycle.project_id);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    const body = request.body || {};
    const seedPlan = typeof body.seedPlan === 'string' && body.seedPlan.trim() ? body.seedPlan.trim() : undefined;

    // IS-R4: duplicate-run guard — never two concurrent runs for a cycle. If a non-terminal run
    // already exists (getCycleRunState.runActive), no-op with 409 (idempotent manual click).
    try {
      const rs = runArtifactService.getCycleRunState(cid);
      if (rs.hasRun && rs.runActive) {
        return reply.code(409).send({ error: 'implementation already running for this cycle' });
      }
    } catch { /* if run-state read fails, fall through to normal start */ }

    // IS-R1: when there's no seedPlan, this is the CYCLE-PLAN implementation-only path — the cycle's
    // own execution_plan.md is ingested (no re-interview/re-plan). Validate it synchronously so a
    // missing/invalid plan is a clean 400 (startRunDetached is fire-and-forget and can't 400 later).
    let cyclePlan = false;
    let prompt: string;
    if (seedPlan) {
      prompt = (body.prompt || `[plan-cache replay: ${seedPlan}]`).trim();
    } else {
      let planValid = false;
      try {
        const doc = await cycleDocsService.readCycleDoc(cid, CANONICAL_CYCLE_ARTIFACTS.plan);
        planValid = doc.valid === true;
      } catch { planValid = false; }
      if (!planValid) return reply.code(400).send({ error: 'author a valid plan.md first' });
      cyclePlan = true;
      prompt = (body.prompt || `implement cycle ${cid} from plan.md`).trim();
    }
    if (!prompt) return reply.code(400).send({ error: 'prompt required' });
    try {
      const { runId, batchId } = runOrchestratorService.startRunDetached({ projectId: pid, cycleId: cid, prompt, roleBindings: body.roleBindings, batchId: body.batchId, seedPlan, cyclePlan });
      // Best-effort: reflect implementation phase on the CC board (ignore the one-impl-per-project
      // guard / invalid-transition — the run linkage, not the phase flip, is the contract here).
      try { cycleService.setCyclePhase(cid, 'implementation'); } catch { /* phase flip is cosmetic */ }
      return { runId, batchId, cycleId: cid, status: 'started' };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message || 'startRun failed' });
    }
  });

  // A3: latest run for project (enables frontend "has active run?" check on CC open + after start without storing runId; returns null if none or terminal)
  app.get('/api/projects/:id/runs', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    try {
      const row: any = db.prepare('SELECT id FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(pid);
      if (!row) return { run: null };
      const st = await runOrchestratorService.getRunStatus(pid, Number(row.id));
      return { run: st };
    } catch (e: any) {
      return { run: null };
    }
  });

  app.get('/api/projects/:id/runs/:runId', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    const rid = Number(request.params.runId);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    try {
      const st = await runOrchestratorService.getRunStatus(pid, rid);
      return st;
    } catch (e: any) {
      return reply.code(404).send({ error: e.message || 'run not found' });
    }
  });

  app.get('/api/tracking', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const query = request.query || {};
    try {
      return trackingReadService.snapshot({
        projectId: query.project_id == null ? undefined : Number(query.project_id),
        limit: query.limit == null ? undefined : Number(query.limit),
      });
    } catch (e: any) {
      return reply.code(400).send({ error: e.message || 'invalid tracking query' });
    }
  });

  // R5b (CC-CHAT-4): sanctioned run stop. Owner + local-launch guarded (reaps tmux sessions).
  // Marks the run terminal in the DB AND flips the in-memory abort flag (run-abort-registry)
  // that the in-process OrchestratorLoop consults every poll cycle — so stop takes effect
  // within one cycle even mid-wait. Body: { reason?: string } (recorded as an agent_events row).
  app.post('/api/runs/:id/stop', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const rid = Number(request.params.id);
    const body = request.body || {};
    try {
      const res = await runOrchestratorService.stopRun(rid, body.reason);
      return { runId: rid, ...res };
    } catch (e: any) {
      if (/run not found/i.test(String(e?.message))) return reply.code(404).send({ error: 'run not found' });
      return reply.code(400).send({ error: e.message || 'stop failed' });
    }
  });

  // Terminal blocked-run recovery. Setup/DB transition is awaited; the shared engine tail then continues
  // fire-and-forget under RunOrchestratorService's per-run recovery lock.
  app.post('/api/runs/:id/resume', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const rid = Number(request.params.id);
    try {
      const res = await runOrchestratorService.resumeExistingRun(rid);
      return reply.code(202).send(res);
    } catch (e: any) {
      const message = String(e?.message || 'resume failed');
      if (/run not found/i.test(message)) return reply.code(404).send({ error: 'run not found' });
      if (/not resumable|live worker seat|working task|already in progress|no deferred task/i.test(message)) {
        return reply.code(409).send({ error: message });
      }
      return reply.code(400).send({ error: message });
    }
  });

  // E1: mid-run structured inject/redirect from brain (owner/local). POST /api/runs/:id/inject per brief example (also works cross).
  // Payload: {label, task_key?} for new inject (enqueued at boundary); or {taskId, redirect: 'new brief'} for re-brief existing.
  // Drains at next task boundary only; dynamic queue non-empty keeps drain loop going.
  app.post('/api/runs/:id/inject', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const rid = Number(request.params.id);
    const body = request.body || {};
    try {
      const res = await runOrchestratorService.inject(rid, body);
      return { ok: true, ...res };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message || 'inject failed' });
    }
  });

  // D4: Completed archives (C4r). Owner-guarded + Helm projects :id validation (D1 flip, same as /tasks).
  // Supports /api/completed (all) and /api/projects/:id/completed (per project) per brief.
  // Body-aware: these are GETs (no body passed from UI authedFetch).
  app.get('/api/completed', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const archives = taskService.listCompletedArchives();
    return { archives };
  });

  app.get('/api/projects/:id/completed', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const projectId = Number(request.params.id);
    const exists = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
    if (!exists) return reply.code(400).send({ error: 'unknown project' });
    const archives = taskService.listCompletedArchives(projectId);
    return { archives };
  });

  // E1 Memory backend (M1 + M2). Owner-guarded CRUD + filters (curation). project exists guard for project scope.
  // Body-aware: GETs (list) are bodyless from authedFetch. Mutations carry body.
  app.get('/api/memory', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const { scope, project_id, agent_id, status, horizon } = request.query || {};
    const pid = project_id != null ? Number(project_id) : undefined;
    const aid = agent_id != null ? Number(agent_id) : undefined;
    if (scope === 'project' && pid != null) {
      const exists = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(pid);
      if (!exists) return reply.code(400).send({ error: 'unknown project' });
    }
    if (scope === 'agent') {
      if (aid == null || Number.isNaN(aid)) return reply.code(400).send({ error: 'agent_id is required for agent scope' });
      const exists = db.prepare("SELECT 1 FROM agents WHERE id = ?").get(aid);
      if (!exists) return reply.code(400).send({ error: 'unknown agent' });
    }
    const memories = memoryService.listMemories({ scope: scope as any, project_id: pid, agent_id: aid, status: status as any, horizon: horizon as any });
    return { memories };
  });

  app.post('/api/memory', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    try {
      const body = request.body || {};
      if (body.scope === 'project' && body.project_id != null) {
        const exists = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(Number(body.project_id));
        if (!exists) return reply.code(400).send({ error: 'unknown project' });
      }
      if (body.scope === 'agent') {
        if (body.agent_id == null) return reply.code(400).send({ error: 'agent_id is required for agent scope' });
        const exists = db.prepare("SELECT 1 FROM agents WHERE id = ?").get(Number(body.agent_id));
        if (!exists) return reply.code(400).send({ error: 'unknown agent' });
      }
      // B10b/R2.10: trusted actor from verified token only (never body)
      const actor = decisionActorFromRequestUser(request.user);
      const m = memoryService.createMemory(body, { approved: true, actor }); // owner direct = approved (even app)
      return { memory: m };
    } catch (e: any) {
      if (e.code === 'FORBIDDEN') return reply.code(403).send({ error: e.message });
      if (e.message && /required|title|scope/i.test(e.message)) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.put('/api/memory/:id', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    if (!memoryService.getMemory(id)) return reply.code(404).send({ error: 'unknown memory' });
    try {
      const body = request.body || {};
      // B10b/R2.10: trusted actor from verified token only (never body)
      const actor = decisionActorFromRequestUser(request.user);
      const m = memoryService.updateMemory(id, body, { actor });
      return { memory: m };
    } catch (e: any) {
      if (e.code === 'FORBIDDEN') return reply.code(403).send({ error: e.message });
      throw e;
    }
  });

  app.delete('/api/memory/:id', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    if (!memoryService.getMemory(id)) return reply.code(404).send({ error: 'unknown memory' });
    try {
      // B10b/R2.10: trusted actor from verified token only (never body)
      const actor = decisionActorFromRequestUser(request.user);
      memoryService.deleteMemory(id, { actor });
      return { ok: true };
    } catch (e: any) {
      if (e.code === 'FORBIDDEN') return reply.code(403).send({ error: e.message });
      throw e;
    }
  });

  // B11 UI3: promote short -> long (purge-and-promote flow). Owner + local launch.
  // B10b: FORBIDDEN → 403.
  app.post('/api/memory/promote', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    try {
      const { ids } = request.body || {};
      if (!Array.isArray(ids) || ids.length === 0) return { ok: true };
      // B10b/R2.10: trusted actor from verified token only (never body)
      const actor = decisionActorFromRequestUser(request.user);
      memoryService.promoteToLong(ids.map((x: any) => Number(x)), { actor });
      return { ok: true };
    } catch (e: any) {
      if (e.code === 'FORBIDDEN') return reply.code(403).send({ error: e.message });
      throw e;
    }
  });

  // B11 UI3: clear remaining short (after promote review). Owner + local.
  app.post('/api/memory/clear-short', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const { scope, project_id } = request.body || {};
    memoryService.clearShort({ scope: scope as any, project_id: project_id != null ? Number(project_id) : undefined });
    return { ok: true };
  });

  // E1: sanctioned POST /api/ingest/memory-propose (agent proposes; app-global starts 'proposed'; its-project = 'approved').
  // SECURITY (red-team critical, reuse D1/D3): project_id derived EXCLUSIVELY from verified master-chat token claim.
  // Body (even if project_id/scope) ignored for scoping — silo enforced. Cross-project write (claim A, body B) → 403.
  // requireLocalLaunchPre (loopback from inside projects).
  app.post('/api/ingest/memory-propose', { preHandler: [requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'missing or invalid authorization header' });
    }
    const token = authHeader.slice(7);
    const verified = authService.verifyMasterChatToken(token);
    if (!verified) {
      return reply.code(401).send({ error: 'invalid or expired master chat token' });
    }
    const projectId = verified.projectId; // FROM TOKEN ONLY — never body
    const body = request.body || {};
    const scope = (body.scope === 'project' ? 'project' : 'app') as 'app' | 'project';
    let targetPid: number | null = null;
    if (scope === 'project') {
      targetPid = projectId;
      if (body.project_id != null && Number(body.project_id) !== projectId) {
        return reply.code(403).send({ error: 'cross-project write rejected' });
      }
    }
    try {
      // B10b/R2.10: stamp agent actor from ingest token path (never undefined fall-through)
      const actor = decisionActorFromIngest({ name: 'master-chat' });
      const m = memoryService.createMemory(
        {
          scope,
          project_id: targetPid,
          title: body.title,
          description: body.description ?? null,
          type: body.type,
          body: body.body ?? null
        },
        { approved: scope === 'project', actor } // agent-app propose => proposed; project => approved
      );
      return { memory: m, status: m ? m.status : 'proposed' };
    } catch (e: any) {
      if (e.code === 'FORBIDDEN') return reply.code(403).send({ error: e.message });
      if (e.message && /required|title|cross-project/i.test(e.message)) return reply.code(400).send({ error: e.message });
      if (e.code === 'CROSS_PROJECT') return reply.code(403).send({ error: 'cross-project write rejected' });
      throw e;
    }
  });

  // E1: GET /api/ingest/memory-query?q= (agent JIT; returns ONLY approved app + THIS project; ranked simple match).
  // project_id from token claim only (D1 master-chat pattern). No cross-project leakage. Body-aware (no body on GET).
  app.get('/api/ingest/memory-query', { preHandler: [requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'missing or invalid authorization header' });
    }
    const token = authHeader.slice(7);
    const verified = authService.verifyMasterChatToken(token);
    if (!verified) {
      return reply.code(401).send({ error: 'invalid or expired master chat token' });
    }
    const projectId = verified.projectId;
    const q = (request.query && request.query.q) ? String(request.query.q) : '';
    const memories = memoryService.queryMemory({ project_id: projectId, q });
    return { memories };
  });

  // GET /api/ingest/agents — loopback roster read for agents (mirrors /api/agents but no owner auth required).
  app.get('/api/ingest/agents', { preHandler: [requireLocalLaunchPre] }, async () => {
    return { agents: assignmentService.listAgents() };
  });

  // E1 (KEY-E1): agent definition propose→approve substrate.
  // POST /api/ingest/agent-propose — agent proposes definition_md change (loopback only; no owner auth required)
  app.post('/api/ingest/agent-propose', { preHandler: [requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const body = request.body || {};
    const agentId = body.agent_id != null ? Number(body.agent_id) : null;
    const proposedMd = body.proposed_definition_md;
    const chatSid = body.chat_session_id ?? null;
    if (!agentId || !proposedMd) return reply.code(400).send({ error: 'agent_id and proposed_definition_md required' });
    try {
      // B10b: createProposal is propose-only (not an owner gate). Approve/reject routes
      // stamp decisionActorFromRequestUser. Ingest cannot reach those helpers here.
      const p = agentProposalService.createProposal(agentId, proposedMd, chatSid);
      return { proposal: p };
    } catch (e: any) {
      if (/unknown agent/.test(e.message)) return reply.code(404).send({ error: e.message });
      return reply.code(400).send({ error: e.message });
    }
  });

  // E1: GET /api/proposals — list proposals; filter by ?agent_id=&status=
  app.get('/api/proposals', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const q = request.query as any;
    const proposals = agentProposalService.listProposals({
      agent_id: q.agent_id ? Number(q.agent_id) : undefined,
      status: q.status || undefined
    });
    return { proposals };
  });

  // E1: POST /api/proposals/:id/approve — apply definition_md to agent (owner + local)
  // B10b: FORBIDDEN (jkage L0) → 403.
  app.post('/api/proposals/:id/approve', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    try {
      // B10b/R2.10: trusted actor from verified token only (never body)
      const actor = decisionActorFromRequestUser(request.user);
      const p = agentProposalService.approveProposal(id, { actor });
      return { proposal: p };
    } catch (e: any) {
      if (e.code === 'FORBIDDEN') return reply.code(403).send({ error: e.message });
      if (/unknown proposal/.test(e.message)) return reply.code(404).send({ error: e.message });
      return reply.code(400).send({ error: e.message });
    }
  });

  // E1: POST /api/proposals/:id/reject — mark proposal rejected (owner)
  // B10b: FORBIDDEN → 403.
  app.post('/api/proposals/:id/reject', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    try {
      // B10b/R2.10: trusted actor from verified token only (never body)
      const actor = decisionActorFromRequestUser(request.user);
      const p = agentProposalService.rejectProposal(id, { actor });
      return { proposal: p };
    } catch (e: any) {
      if (e.code === 'FORBIDDEN') return reply.code(403).send({ error: e.message });
      if (/unknown proposal/.test(e.message)) return reply.code(404).send({ error: e.message });
      return reply.code(400).send({ error: e.message });
    }
  });

  // P1-6b: owner-only manual hot-swap (loopback spawn via internal launch; 400 not-setup, 409 locked)
  // RT5: attach requireLocalLaunchPre (B6/H19 guard since it spawns with bypass)
  // RT0: use request.body (H3); M7 validation on toP/toM
  app.post('/api/projects/:id/switch-model', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const projectId = Number(request.params.id);
    // M6/O4.1/O7.2: active-project recheck via the ONE native identity boundary (no external db).
    const activeGuard = requireActiveNativeProject(identityService, projectId);
    if (!activeGuard.ok) return reply.code(400).send({ error: activeGuard.error });
    if (!masterService.isSetUp(projectId)) return reply.code(400).send({ error: 'project not set up (no master chain)' });
    if (runtimeService.hasActiveSwapLock(projectId)) return reply.code(409).send({ error: 'swap in progress' });
    const body = request.body || {};
    const toProvider = body.toProvider || body.provider;
    const toModel = body.toModel || body.model;
    if (!toProvider || !toModel) return reply.code(400).send({ error: 'toProvider and toModel required' });
    try {
      const res = await runtimeService.switchModel(projectId, toProvider, toModel, 'manual');
      return res;
    } catch (e: any) {
      if (e && e.statusCode === 409) return reply.code(409).send({ error: e.message || 'swap locked' });
      if (e && (e.statusCode === 400 || /no running master|unknown|not in providers/i.test(String(e?.message || e)))) {
        return reply.code(400).send({ error: e?.message || String(e) });
      }
      return reply.code(500).send({ error: e?.message || 'switch failed' });
    }
  });

  // B11 CC: POST /launch-master — pick agent (model pre-assigned server-side). ACTIVE-RUN guard; liveness (session+pid) decides switch vs fresh launch.
  app.post('/api/projects/:id/launch-master', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const projectId = Number(request.params.id);
    // mirror switch-model active-project recheck via the native identity boundary + isSetUp (400)
    const activeGuard = requireActiveNativeProject(identityService, projectId);
    if (!activeGuard.ok) return reply.code(400).send({ error: activeGuard.error });
    if (!masterService.isSetUp(projectId)) return reply.code(400).send({ error: 'project not set up (no master chain)' });
    const body = request.body || {};
    const agentId = Number(body.agent_id);
    if (!agentId) return reply.code(400).send({ error: 'agent_id required' });
    const agent = assignmentService.getAgent(agentId);
    if (!agent) return reply.code(400).send({ error: 'unknown agent' });
    const prov = (PROVIDERS as any)[agent.provider];
    if (!prov || !prov.models || !prov.models.some((m: any) => m.model === agent.model)) {
      return reply.code(400).send({ error: `agent model not in providers registry: ${agent.provider}/${agent.model}` });
    }
    // ACTIVE-RUN guard (same query shape as chat route A3)
    const ar = db.prepare("SELECT 1 FROM runs WHERE project_id = ? AND phase NOT IN ('complete','failed','blocked') LIMIT 1").get(projectId);
    if (ar) return reply.code(409).send({ error: 'active run in progress — chat routes to run session, not master' });
    if (runtimeService.hasActiveSwapLock(projectId)) return reply.code(409).send({ error: 'swap in progress' });
    // latest master_runtimes + liveness
    const mr: any = db.prepare("SELECT * FROM master_runtimes WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1").get(projectId);
    const sess = mr?.tmux_session;
    let alive = false;
    if (sess) {
      try {
        const exists = await tmuxService.sessionExists(sess);
        const panePid = exists ? await tmuxService.getPanePid(`${sess}:0.0`) : null;
        alive = !!exists && !!panePid;
      } catch {}
    }
    const provider = agent.provider;
    const model = agent.model;
    try {
      if (alive && mr?.state === 'running') {
        await runtimeService.switchModel(projectId, provider, model, 'manual');
        return { ok: true, action: 'switched', provider, model };
      }
      if (alive && mr?.state === 'launching') {
        return reply.code(409).send({ error: 'launch already in progress' });
      }
      // dead or no row
      // B-ISO1 (sol wiring review fix #1): re-thread the run's persisted strict read profile so a
      // manual dead-master relaunch keeps the fence (launchMaster's start-row write would otherwise
      // explicitly clear the column). Fail-closed on corrupt metadata (getPersistedStrictReadAllow
      // throws) rather than relaunching read-all — the outer catch maps it to a 500.
      const persistedAllow = runtimeService.getPersistedStrictReadAllow(projectId);
      const role = mr?.role === 'ibrain' ? 'ibrain' : 'plancore';
      await runtimeService.launchMaster(projectId, { provider, model, role, ...(persistedAllow ? { strictReadAllow: persistedAllow } : {}) });
      return { ok: true, action: 'launched', provider, model };
    } catch (e: any) {
      if (e && e.statusCode === 409) return reply.code(409).send({ error: e.message || 'swap locked' });
      if (e && (e.statusCode === 400 || /no running master|unknown|not in providers/i.test(String(e?.message || e)))) {
        return reply.code(400).send({ error: e?.message || String(e) });
      }
      return reply.code(500).send({ error: e?.message || 'launch failed' });
    }
  });

  // D-a3: POST /api/projects/:id/master/close — owner + loopback only. Tears down the active phase-brain session.
  // 409 if no master row or already closed (closed_reason or state closed). Sets state='closed', closed_reason.
  // Used by UI close-on-confirm at run complete + force-close button.
  app.post('/api/projects/:id/master/close', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const projectId = Number(request.params.id);
    const exists = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
    if (!exists) return reply.code(404).send({ error: 'unknown project' });
    // Determine session to close: prefer active run's project session (run-owned), else latest master_runtimes
    let session: string | null = null;
    let brainRole: 'discovery' | 'plancore' | 'ibrain' = 'plancore';
    let fromRun = false;
    try {
      const ar: any = db.prepare("SELECT phase FROM runs WHERE project_id = ? AND phase NOT IN ('complete','failed','blocked') ORDER BY id DESC LIMIT 1").get(projectId);
      if (ar) {
        const pr: any = db.prepare("SELECT name, plancore_session FROM projects WHERE id = ?").get(projectId);
        const slug = String(pr?.name || 'proj').toLowerCase().replace(/[^a-z0-9]+/g, '_');
        brainRole = ar.phase === 'interview' ? 'discovery' : ar.phase === 'planning' ? 'plancore' : 'ibrain';
        session = brainRole === 'discovery'
          ? `helm-discovery-${slug}`
          : brainRole === 'plancore'
            ? (pr?.plancore_session || `helm-plancore-${slug}`)
            : `helm-ibrain-${slug}`;
        fromRun = true;
      }
    } catch {}
    if (!session) {
      const mr: any = db.prepare("SELECT tmux_session, role FROM master_runtimes WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1").get(projectId);
      session = mr?.tmux_session || null;
      brainRole = mr?.role === 'ibrain' ? 'ibrain' : 'plancore';
    }
    if (!session) return reply.code(409).send({ error: 'no master session for project' });
    // already closed?
    const closedRow: any = db.prepare("SELECT state, closed_reason FROM master_runtimes WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1").get(projectId);
    if (closedRow && (closedRow.closed_reason || closedRow.state === 'closed')) {
      return reply.code(409).send({ error: 'already closed' });
    }
    try {
      await tmuxService.terminateSession(session);
    } catch (e: any) {
      // best effort; continue to mark closed
    }
    // mark runtime closed (create minimal row if none, or update)
    const nowRun = db.prepare("SELECT master_run_id FROM master_runtimes WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1").get(projectId) as any;
    const runId = nowRun?.master_run_id || `master:${projectId}`;
    const sessName = session;
    // NOTE: master_runtimes.state CHECK allows ('launching','running','parked','failed') — NOT 'closed'.
    // A close = teardown; write the allowed 'parked' state + closed_reason (the already-closed guard above
    // keys on closed_reason, and launch-master treats any non-'running' state as dead → relaunch).
    // B-ISO1 (sol wiring review fix #1): preserve strict_read_allow (read-back-and-carry) so a later
    // manual relaunch after this close keeps the fence — a reset must be EXPLICIT, never by omission.
    const priorStrict: any = db.prepare("SELECT strict_read_allow FROM master_runtimes WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1").get(projectId);
    db.prepare(
      `INSERT OR REPLACE INTO master_runtimes (project_id, master_run_id, tmux_session, tmux_pane, provider, model, state, role, closed_reason, strict_read_allow, updated_at)
       VALUES (?, ?, ?, '0.0', 'unknown', 'unknown', 'parked', ?, ?, ?, datetime('now'))`
    ).run(projectId, runId, sessName, brainRole === 'discovery' ? 'plancore' : brainRole, 'manual-close', priorStrict?.strict_read_allow ?? null);
    return { ok: true, closed: session };
  });

  // P2-1 routes
  app.get('/api/projects/:id/workers', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const projectId = Number(request.params.id);
    // D1: native Helm projects table is the sole :id authority (final workers group).
    const exists = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
    if (!exists) return reply.code(400).send({ error: 'unknown project' });
    return { workers: workerService.listWorkers(projectId) };
  });

  app.post('/api/projects/:id/workers', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const projectId = Number(request.params.id);
    // D1 :id flip (final workers group).
    const exists = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
    if (!exists) return reply.code(400).send({ error: 'unknown project' });
    const { role, task_brief, run_id } = request.body || {};
    if (!role || !task_brief) return reply.code(400).send({ error: 'role and task_brief required' });
    if (typeof task_brief !== 'string' || task_brief.length > 4000) return reply.code(400).send({ error: 'task_brief too long (max 4000)' });
    try {
      const runIdNum = run_id != null ? Number(run_id) : undefined;
      const w = await workerService.spawnWorker({ projectId, role, taskBrief: task_brief, spawnedBy: 'owner', runId: runIdNum });
      return { worker: w };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.post('/api/projects/:id/workers/:wid/reap', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const projectId = Number(request.params.id);
    const id = Number(request.params.wid);
    // D1 :id flip (final workers group).
    const exists = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
    if (!exists) return reply.code(400).send({ error: 'unknown project' });
    // M1: enforce project scoping — the worker must belong to :id (owner-only, but keep the boundary)
    const row = workerService.getWorker(id);
    if (!row || row.project_id !== projectId) return reply.code(403).send({ error: 'worker does not belong to this project' });
    try {
      await workerService.reapWorker(id, 'manual');
      return { ok: true };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  // B3a: Plumbing/Watchers self-config API (consensus §3, bounded + JROM wins; no UI).
  // GET/PUT owner-guarded (JROM override). POST coordinator-facing (local/loopback for running coordinators to "set your own alarm" at batch boundaries; rate-limited intent via caller + dedupe in watcher).
  // All values validated in bounded ranges (model cannot silence watcher or set infinite context).
  app.get('/api/plumbing/configs', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any) => {
    // For v1 return effective for projects that have master_runtimes (coordinators)
    // B3b: also return watchStates so the Context Steward table renders *real* backend state (seeded in e2e fixture for UI-PROOF)
    const projs = db.prepare("SELECT project_id, role FROM master_runtimes").all() as any[];
    const configs = projs.map((p: any) => ({
      project_id: p.project_id,
      role: p.role === 'ibrain' ? 'ibrain' : 'plancore',
      effective: plumbingWatcher.getEffectiveConfig(p.project_id, p.role === 'ibrain' ? 'ibrain' : 'plancore')
    }));
    const watchStates = plumbingWatcher.listWatchStates();
    return { configs, watchStates };
  });

  app.put('/api/plumbing/configs/:projectId', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.projectId);
    const body = request.body || {};
    try {
      plumbingWatcher.setJromOverride(pid, body);
      return { ok: true, effective: plumbingWatcher.getEffectiveConfig(pid) };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.post('/api/plumbing/config', { preHandler: [requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'missing or invalid authorization header' });
    }
    const token = authHeader.slice(7);
    const verified = authService.verifyMasterChatToken(token);
    if (!verified) {
      return reply.code(401).send({ error: 'invalid or expired master chat token' });
    }
    const projectId = verified.projectId; // FROM TOKEN CLAIM (not body) — matches /api/ingest/* pattern; rejects cross-project
    const body = request.body || {};
    const role = body.role || 'plancore';
    if (!['plancore', 'ibrain'].includes(role)) return reply.code(400).send({ error: 'role must be plancore or ibrain' });
    // LOW red-team: existence check before write (non-existent project would create orphan config).
    if (!projectService.getProject(projectId)) return reply.code(400).send({ error: 'unknown project' });
    try {
      plumbingWatcher.setSelfConfig(projectId, role, body);
      return { ok: true, effective: plumbingWatcher.getEffectiveConfig(projectId, role) };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  // P2-2: live activity board SSE (req H10). Exact per brief + consensus (APPROVE-WITH-CHANGES must-fixes):
  // - createSseAuthMiddleware (Bearer header THEN ?access_token)
  // - reply.writeHead + ':ok\n\n' + reply.hijack(); NEVER return from handler (no double response / ERR_HTTP_HEADERS_SENT)
  // - snapshot + live onEvent with FILTER: batch_id===`chat-${id}` || `master-${id}` || (worker-* && body.project_id===id)  [master events use master-<id>]
  // - heartbeat : ping\n\n every 15s
  // - request.raw.on('close', ...) attached SYNCHRONOUSLY (before any await) for leak-safe: unsub + clearInterval + remove from set + .end()
  // - cap 5 per project (429); shutdown .end() ALL open streams BEFORE db.close in onClose + SIG shutdown
  // - active OVM recheck (400)
  app.get('/api/projects/:id/activity', { preHandler: [sseAuthPre, requireOwnerPre] }, async (request: any, reply: any) => {
    const projectId = Number(request.params.id);
    // D1: native Helm projects table is the sole :id authority.
    const exists = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
    if (!exists) return reply.code(400).send({ error: 'unknown project' });

    let projSet = openSseByProject.get(projectId);
    if (!projSet) {
      projSet = new Set();
      openSseByProject.set(projectId, projSet);
    }
    if (projSet.size >= 5) {
      return reply.code(429).send({ error: 'too many concurrent SSE connections for this project' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    reply.raw.write(':ok\n\n');
    reply.hijack(); // critical: Fastify must not send its own response after this
    const stream = reply.raw;
    projSet.add(stream);

    // snapshot on connect (master row or null, current workers, recent chat+master events merged by seq)
    const master = db.prepare("SELECT * FROM master_runtimes WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1").get(projectId) || null;
    const workers = workerService.listWorkers(projectId);
    const chatEv = eventsService.listByBatch(`chat-${projectId}`);
    const masterEv = eventsService.listByBatch(`master-${projectId}`);
    const recent = [...chatEv, ...masterEv]
      .sort((a: any, b: any) => ((a.seq ?? a.id) as number) - ((b.seq ?? b.id) as number))
      .slice(-50);
    // HIGH (red-team): unnamed (default 'message') frame so the browser's es.onmessage fires.
    // A named `event: snapshot` would only dispatch to addEventListener('snapshot'), which the
    // client does not register → the initial master/workers/recent state would be silently dropped.
    // The client distinguishes snapshot vs live by the presence of master/recent keys.
    stream.write(`data:${JSON.stringify({ snapshot: true, master, workers, recent })}\n\n`);

    // heartbeat (comment frame, does not advance Last-Event-ID)
    const hb = setInterval(() => {
      try { stream.write(': ping\n\n'); } catch {}
    }, 15000);

    // live subscription with exact project filter (master-<id> mandatory)
    const unsub = eventsService.onEvent((ev: any) => {
      const bid = ev.batch_id || '';
      const body = ev.body || {};
      const keep = bid === `chat-${projectId}` ||
                   bid === `master-${projectId}` ||
                   (bid.startsWith('worker-') && body.project_id === projectId) ||
                   bid === `plumbing-${projectId}`; // B3b: forward watcher events (plumbing-${pid}) so Context Steward live table in UI receives them via existing SSE (additive)
      if (!keep) return;
      try {
        stream.write(`id:${ev.seq ?? ev.id}\ndata:${JSON.stringify(ev)}\n\n`);
      } catch {}
    });

    // Leak-safe teardown: SYNCHRONOUS attach (no await after this point in this handler path)
    request.raw.on('close', () => {
      try { unsub(); } catch {}
      clearInterval(hb);
      projSet!.delete(stream);
      if (projSet!.size === 0) openSseByProject.delete(projectId);
      try { stream.end(); } catch {}
    });

    // IMPORTANT: do NOT return a value / send after hijack
  });

  // H4: graceful shutdown hooks (stop supervisor, close dbs, best-effort kill tracked masters from M9)
  // P2-1: stopReaper + reapAll BEFORE masters + db.close (HIGH-3)
  // P2-2: .end() all open SSE streams FIRST (before any db.close) so clients do not get TCP RST
  app.addHook('onClose', async () => {
    try {
      // P2-2 close open activity streams before reaper/dbs
      for (const streams of openSseByProject.values()) {
        for (const s of streams) {
          try { s.end(); } catch {}
        }
      }
      openSseByProject.clear();
      // C1: terminate all open test-chat sessions (best-effort; idempotent)
      for (const sid of chatSessionService.sessionIds()) {
        try { await chatSessionService.terminate(sid); } catch {}
      }
      workerService.stopReaper();
      await workerService.reapAll();
      runtimeService.stopSupervisor();
      // P2-3: stop auto-fallback before dbs (like supervisor)
      runtimeService.stopAutoFallback();
      // B3a
      plumbingWatcher.stopWatchLoop();
      db.close();
      if (typeof (runtimeService as any).terminateAllActiveMasters === 'function') {
        await (runtimeService as any).terminateAllActiveMasters();
      }
    } catch {}
    // Separate guard: failures in Helm runtime cleanup above must never skip closing the
    // read-only AGJAssist authentication handle.
    try { agjDb.close(); } catch {}
  });

  const shutdown = async () => {
    try {
      // P2-2 close SSE before reap/app.close (and before onClose also runs)
      for (const streams of openSseByProject.values()) {
        for (const s of streams) {
          try { s.end(); } catch {}
        }
      }
      openSseByProject.clear();
      // C1: terminate all open test-chat sessions (best-effort; idempotent)
      for (const sid of chatSessionService.sessionIds()) {
        try { await chatSessionService.terminate(sid); } catch {}
      }
      workerService.stopReaper();
      await workerService.reapAll();
      // P2-3: stop auto-fallback (before app.close)
      runtimeService.stopAutoFallback();
      plumbingWatcher.stopWatchLoop();
      await app.close();
    } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: config.port, host: config.host });
  console.log(`Helm listening on ${config.host}:${config.port}`);

  // R2 (CC-CHAT-3): CLI freshness preflight — once, best-effort, fire-and-forget AFTER listen so
  // it can never block or fail boot (belt-and-suspenders on top of the R1 interstitial interceptor;
  // HELM_SKIP_CLI_PREFLIGHT=1 skips). Keeps codex current so its update nag rarely appears at spawn.
  runCliFreshnessPreflight().catch((err: unknown) => {
    console.warn('[cli-preflight] unexpected error (non-blocking):', err);
  });

  // B5 R-01B5: non-blocking startup backfill — validate all untested models
  setTimeout(() => {
    modelValidationService.validateAll().then((s) => {
      console.log(`[startup:backfill] considered=${s.considered} validated=${s.validated} valid=${s.valid} invalid=${s.invalid} skipped=${s.skipped}`);
    }).catch((err: unknown) => {
      console.error('[startup:backfill] error:', err);
    });
  }, 5000);

  // #48: warn loudly at startup when a project agent's model binding layers disagree (a set-but-ignored
  // default_model_id / agents.model that a configurator expected to govern). Non-fatal; pure diagnostic.
  try {
    const n = warnModelBindingDivergences(db.raw);
    if (n === 0) console.log('[model-binding] all project-agent bindings consistent (no ignored layers)');
  } catch (err) {
    console.warn('[model-binding] divergence check skipped:', err);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
