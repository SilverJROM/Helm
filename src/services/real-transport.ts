import fs from 'node:fs/promises';
import path from 'node:path';
import type { ITransport } from './fake-transport.js';
import { TmuxService } from '../tmux/tmux-service.js';
import { DispatchService, type DispatchStartParams } from './dispatch-service.js';
import { ProviderResolverService } from './provider-resolver-service.js';
import { resolveHelmSandboxBin, makeStrictReadProfileEnv } from '../security/landlock-sandbox.js';
import { startGovernedDocGuard, type GovernedDocGuardHandle } from './doc-path-guard.js';
import { PROVIDERS, seatReadySignal } from '../config/providers.js';
import { matchInterstitial, InterstitialBlockedError } from './cli-interstitials.js';
import { applyEnvelopeIsolation } from './envelope-isolation.js';
import type { SeatInspection } from './seat-pane-state.js';

// Hard-pin the worker identity when the host CLI supports a system-prompt override (claude).
// Kept apostrophe-free so it embeds directly inside single quotes in the launch command (no shell escaping).
// Reinforces the helm_pm role alias + brief: even if any global config leaked, the model must not become
// an external named agent. (HELM_ENVELOPE_DIRECTIVE now lives in the shared envelope-isolation helper.)


interface RealTransportDeps {
  tmux?: TmuxService;
  artifacts?: any; // RunArtifactService | stub (recordDispatch only needed for dispatch.start success path)
  resolver?: ProviderResolverService;
}

// Minimal stub so RealTransport + DispatchService work in thin mode (no DB/RunArtifactService)
// and for the standalone real smoke (no artifactService in loop). recordDispatch is the only
// method called inside DispatchService.start on success.
class NoopArtifacts {
  recordDispatch(attemptId: number = 0, role: string = '', briefPath: string | null = null, transportHandle: string | null = null): number {
    return 0;
  }
}

export class RealTransport implements ITransport {
  private readonly tmux: TmuxService;
  private readonly artifacts: any;
  private readonly resolver: ProviderResolverService;
  private readonly dispatch: DispatchService;
  // R7.26/B22b-cont: userspace fence for the 3 plan/<cycle> governed docs, keyed by tmux session
  // name, for the fenced agent's lifetime. north-star.md is kernel-fenced; see helm-sandbox.c.
  private readonly governedDocGuards = new Map<string, GovernedDocGuardHandle>();

  constructor(deps: RealTransportDeps = {}) {
    const isFake = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production';
    if (isFake) {
      throw new Error('RealTransport strictly behind !USE_FAKE_TMUX=1 (non-production) per batch-A1 approval; real tmux/worker paths untouched. Use FakeTransport when the flag is set.');
    }
    this.tmux = deps.tmux ?? new TmuxService();
    this.resolver = deps.resolver ?? new ProviderResolverService();
    this.artifacts = deps.artifacts ?? new NoopArtifacts();
    this.dispatch = new DispatchService(this.tmux, this.artifacts);
  }

  private resolveProviderForModel(model: string): string {
    for (const [pname, pdef] of Object.entries(PROVIDERS)) {
      if ((pdef as any).models?.some((m: any) => m.model === model)) {
        return pname;
      }
    }
    return 'grok';
  }

  async spawn(params: {
    role: 'implementer' | 'validator' | 'discovery' | 'plancore' | 'ibrain' | string;
    brief: string;
    runDir: string;
    batchId?: string;
    rung?: number;
    model?: string;
    effort?: string;  // C6: per-task effort from plan (base for this dispatch)
    sessionName?: string;
    provider?: string;  // POCFIX5: from role_binding (preferred over guess; threaded for projcore/partner/red)
    route?: string;  // C0: kloo route (openrouter/llamacpp) — fills `<route>` in kloo's dynamic-provider launch template; unused/undefined for non-kloo
    attemptId?: number;  // POCFIX7: real attempt id from loop for per-task; absent/0 for planning (attempt-less)
    projectDir?: string;  // POCFIX14: fence the agent to the REGISTERED project dir (e.g. cards) so the implementer can WRITE there; else writes EACCES (fence was process.cwd()=Helm)
    // B-ISO1 (2026-07-16 cheat-isolation): OPT-IN strict READ profile for THIS transport seat.
    // implementer/validator dispatched through RealTransport are a BUILDING path, so they must be
    // fenceable. Absent (every existing caller) → fencedLaunch byte-identical (default read-all).
    strictReadAllow?: string[];
  }): Promise<{ handle: string; role: string }> {
    const role = params.role;
    const runDir = params.runDir;
    const batchId = params.batchId || 'batch-A1';
    const model = params.model || 'grok-4.5';
    const provider = params.provider || this.resolveProviderForModel(model);
    const concreteModel = this.resolver.resolveConcreteModel(provider, params.model);  // POCFIX5: normalize (exact/prefix for aliases like claude-sonnet, default for null, or clear throw)
    const effort = params.effort || 'medium';

    // R9: claude defaultMode is tui; still force mode tui belt-and-braces (same as WorkerService).
    const launchOpts: { provider: string; model: string; effort: string; mode?: 'tui' | 'headless'; route?: string; ctx?: string } = {
      provider,
      model: concreteModel,
      effort,
      route: params.route,  // C0: threaded to resolveAgentLaunchSpec → fills `<route>` for kloo; undefined no-ops for non-kloo templates (no `<route>` token)
      // C1 fix: kloo's launch template has `--ctx <ctx>`; without a value it becomes `--ctx ` (empty) and kloo
      // errors → spawn fails → escalates off kloo. Default per D4: cloud route 131072, local 32768. Non-kloo
      // templates have no `<ctx>` token so this is inert for them.
      ctx: provider === 'kloo' ? (params.route === 'llamacpp' || params.route === 'lmstudio' ? '32768' : '131072') : undefined
    };
    if (provider === 'claude') {
      launchOpts.mode = 'tui';
    }
    const launchSpec = this.resolver.resolveAgentLaunchSpec(launchOpts);

    const sandboxBin = resolveHelmSandboxBin();
    // POCFIX14: fence to the registered project dir when provided (implementer/validator must WRITE there);
    // fall back to env/cwd only when no projectDir (e.g. standalone smoke). Was process.cwd() (Helm) → EACCES on cards writes.
    const fenceDir = params.projectDir || process.env.HELM_FENCE_DIR || process.cwd();
    // ENVELOPE ISOLATION: make Helm the SOLE instruction envelope. The host CLIs otherwise load the
    // operator's global config (claude: ~/.claude/CLAUDE.md + ~/.claude/agents/*, incl. the standalone
    // /projcore agent; codex: AGENTS.md project docs), so a worker could drift into acting as one of those
    // agents instead of doing its one Helm role. We strip that global config at spawn while KEEPING auth
    // (verified: --bare breaks the Max keychain login; these flags do not). Defense-in-depth on top of the
    // helm_pm role alias. See waitFor*ComposerReady — the TUI/prompt is unchanged by these flags.
    const { envPrefix, launchCmd } = applyEnvelopeIsolation(provider, launchSpec.launch_cmd);
    // B-ISO1: compose (+ fail-closed validate) the OPT-IN strict read env BEFORE the createSession
    // side effect below, so a bad allowlist refuses the spawn cleanly. Absent → '' (byte-identical).
    const strictEnv = params.strictReadAllow !== undefined ? makeStrictReadProfileEnv(params.strictReadAllow) : '';
    const fencedLaunch = `${strictEnv}${envPrefix}${sandboxBin} ${fenceDir} ${launchCmd}`;

    // POCFIX7: for claude, pre-ensure trust in launch dir (fenceDir / project cwd) so no interactive dialog blocks boot.
    // Best-effort (never abort launch). Only claude (grok/codex have no such).
    if (provider === 'claude') {
      await this.ensureClaudeTrust(fenceDir);
    }

    // Dedicated fresh session per dispatch (clean context; reuse would require explicit /clear before next)
    // Honor explicit sessionName for per-project projcore (from projects.projcore_session or default <slug>-projcore)
    const sessionName = params.sessionName || `helm-${batchId}-${role}-${Date.now().toString(36).slice(-8)}`;
    const target = await this.tmux.createSession(sessionName, fenceDir);

    try {
      // Launch the real agent (grok-4.5 etc) under fence + skipSafety (trusted launch path, like WorkerService)
      await this.tmux.sendCommand(target, fencedLaunch, true, true);
      // R7.26/B22b-cont: start the userspace guard as soon as the fenced process exists (not
      // gated on ready-probe success).
      this.governedDocGuards.set(sessionName, startGovernedDocGuard(fenceDir));

      // POCFIX6: mirror WorkerService exactly for ready-probe acquisition (dynamic import + prov?.readyProbe)
      // so claude tui (signal '>') is detected ready. Grok/codex unchanged.
      const prov = (await import('../config/providers.js')).PROVIDERS as any;
      const probe = prov[provider]?.readyProbe || { signal: '❯', timeoutMs: 30000 };
      // R1: per-spawn interstitial guard — each table entry answered at most ONCE for this spawn.
      const interstitialsHandled = new Set<string>();
      let ready = await this.waitForReadyIntercepting(target, provider, probe.signal, probe.timeoutMs || 30000, interstitialsHandled);
      if (provider === 'grok' || /grok/i.test(model || '')) {
        // POCFIX11 (1): genuine-ready wait for grok (footer 'always-approve' + no 'Starting session', >=60s; grok ~45s per manual repro).
        // Uses custom poll (reuses capturePane) after basic ❯ probe. Does not regress claude/codex.
        ready = await this.waitForGrokComposerReady(target, 60000, interstitialsHandled);
      } else if (provider === 'claude') {
        // POCFIX18: genuine-ready wait for claude TUI. The configured readyProbe signal '>' (legacy skill mode)
        // matches PREMATURELY during claude boot (banner/path), so the brief dispatched before the composer was
        // ready and was LOST ~50% of runs → projcore/validator spawned but never planned/validated. Wait for the
        // real composer footer ('bypass permissions') before dispatching. (POCFIX6 switched claude to TUI; prompt is ❯.)
        ready = await this.waitForClaudeComposerReady(target, 60000, interstitialsHandled);
      } else if (provider === 'codex') {
        ready = await this.waitForCodexComposerReady(target, 60000, interstitialsHandled);
      }
      if (!ready) {
        throw new Error(`real agent ready probe failed for ${provider}/${model} (target=${target})`);
      }

      // POCFIX11 (2): after genuine ready, only safe Esc (to dismiss onboarding if present). Removed harmful 'q' (quits menu on onboarding) and ' ' submit (speculative jam).
      // Order: wait-genuine → (safe Esc) → send brief. sendEnter kept as safe.
      await new Promise((r) => setTimeout(r, 3000));
      try { await this.tmux.sendEnter(target); } catch {}
      try { await this.tmux.sendKeys(target, '\x1b'); } catch {} // Esc safe after ready
      await new Promise((r) => setTimeout(r, 900));

      // Write the brief param (passed by planning/panel/loop callers) to prompts/<role>.brief.md BEFORE
      // dispatch reads the path. mkdir + write honors the 'brief' arg for any role (projcore etc).
      // Fixes live POST /runs ENOENT (run-orchestrator wrote 'prompt.brief.md'; planning passed
      // projcore brief string but real-transport did not persist role file; Fake used param in-mem).
      await fs.mkdir(path.join(runDir, 'prompts'), { recursive: true });
      const briefPath = path.join(runDir, 'prompts', `${role}.brief.md`);
      await fs.writeFile(briefPath, params.brief, 'utf8');

      const callbacksFile = path.join(runDir, 'callbacks.md');

      const dispatchParams: DispatchStartParams = {
        session: target, // dispatch tolerates full target (uses for send/ready/verify; splits for has-session)
        briefPath,
        runDir,
        batchId,
        role,
        attemptId: params.attemptId || 0,
        bucket: 'SHORT',
        estimateMin: 10,
        callbacksFile,
        // dispatch does a (redundant) ready-probe; real-transport already confirmed genuine-ready above.
        // Use the actual TUI composer marker: claude TUI shows '❯' (its providers.ts readyProbe.signal '>' is
        // the legacy skill/repl marker, NOT the TUI prompt — using it here hangs dispatch on claude).
        readySignal: provider === 'claude' ? '❯' : probe.signal,
      };

      // POCFIX19 (panel-reviewed): ONE clean send. The old 3-retry-on-marker + last-resort duplicate send
      // was a double-paste regression source (claude read the brief twice / queued a stray prompt) and the
      // marker-throw it looped on was the ~50% claude flakiness. With marker now non-fatal (dispatch-service)
      // and delivery confirmed via the downstream [helm callback] poll, a single send is correct + reliable.
      // sendAndSubmit already re-presses Enter internally, covering grok's first-paste sensitivity.
      await this.dispatch.start(dispatchParams);

      return { handle: target, role };
    } catch (e) {
      try { await this.tmux.terminateSession(sessionName); } catch {}
      try { this.governedDocGuards.get(sessionName)?.stop(); } catch {}
      this.governedDocGuards.delete(sessionName);
      throw e;
    }
  }

  /** Read-only liveness inspection. Empty capture remains unknown while sessionAlive stays true. */
  async inspectSeat(target: string, brief: string, _provider?: string): Promise<SeatInspection> {
    const sessionAlive = await this.tmux.sessionExists(target);
    if (!sessionAlive) return { sessionAlive: false, pane: '', composerHoldsBrief: false };
    const pane = await this.tmux.capturePane(target, 200);
    return {
      sessionAlive: true,
      pane,
      composerHoldsBrief: pane.trim().length > 0 && this.tmux.paneHoldsUnsubmittedText(pane, brief),
    };
  }

  /** One semantic callback-repair nudge, sent only after the wait loop proves an idle composer. */
  async nudgeSeat(target: string, provider?: string): Promise<boolean> {
    const nudge = 'CALLBACK REQUIRED — control returned without your callback. Do NOT redo the task. Append your DONE/BLOCKED/PASS/FAIL now.';
    return this.tmux.sendAndSubmit(target, nudge, { readySignal: seatReadySignal(provider) });
  }

  // Compatibility seam for any external caller left from the old kloo-only watchdog. The orchestration
  // loop now uses provider-neutral nudgeSeat after footer-scoped idle-prompt classification.
  async nudgeKlooIfIdle(target: string): Promise<boolean> {
    return this.nudgeSeat(target, 'kloo');
  }

  // R8 (CC-CHAT-3) — composer submit watchdog primitive. Even the ~55s sendAndSubmit backoff was
  // beaten once live (run 80: the codex Enter-drop window is VARIABLE, likely tied to codex's async
  // startup fetches; a manual Enter minutes later submitted instantly). Generalizes the kloo-nudge
  // probe shape for ANY provider: if the dispatched brief text is still visible UN-submitted in the
  // session's composer (ANSI-stripped check via tmux.composerHoldsText — same heuristic as
  // sendAndSubmit's own verification), press Enter once (after Esc-dismissing the codex
  // "Create a plan?" nudge that swallows C-m). Caller bounds/throttles the presses and logs loudly.
  // Returns true only when the composer held the text and Enter was pressed.
  // G1: delegate to the canonical impl now on TmuxService (reuses composerHoldsText/sendEnter/esc logic;
  // avoids duplication while keeping this.stripAnsi for other real-transport concerns).
  async resubmitIfComposerHeld(target: string, briefText: string): Promise<boolean> {
    return this.tmux.resubmitIfComposerHeld(target, briefText);
  }

  // R1 helper: consult the shared interstitial table (cli-interstitials.ts) against an
  // ANSI-stripped pane snapshot. On a keys-match: send the mapped tmux keys ONCE (per-spawn
  // `handled` guard), log loudly, and let the caller keep polling for the real ready marker.
  // On a BLOCKED match (auth/login expired): throw the distinct InterstitialBlockedError so the
  // spawn fails as BLOCKED (needs a human) instead of hanging to a generic timeout.
  // Returns true when keys were sent (caller should re-capture before checking its ready marker —
  // the stale pre-keys snapshot can contain marker glyphs inside the menu itself).
  private async consultInterstitials(
    target: string,
    provider: string,
    strippedPane: string,
    handled: Set<string>
  ): Promise<boolean> {
    const action = matchInterstitial(strippedPane, { provider, handled });
    if (!action) return false;
    if (action.blocked) {
      console.warn(`[real-transport] interstitial BLOCKED target=${target} id=${action.id}: ${action.note}`);
      throw new InterstitialBlockedError(action.id, action.note);
    }
    handled.add(action.id);
    console.warn(`[real-transport] interstitial intercepted target=${target} id=${action.id} → keys=[${action.keys.join(' ')}] (${action.note})`);
    for (const k of action.keys) {
      try { await this.tmux.sendKeys(target, k); } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    return action.keys.length > 0;
  }

  // R1: generic ready-marker probe (replaces the plain tmux.waitForReady call in spawn) that
  // consults the interstitial table BEFORE checking the marker on every poll — a CLI showing an
  // interactive interstitial (codex update nag etc) never prints the marker, so the old probe
  // just hung to timeout while the whole run stalled. Marker detection stays delegated to
  // tmux.waitForReady (in short slices) so its semantics — and test doubles that stub it — are
  // preserved; the table is consulted between slices.
  private async waitForReadyIntercepting(
    target: string,
    provider: string,
    signal: string,
    timeoutMs: number,
    handled: Set<string>
  ): Promise<boolean> {
    const start = Date.now();
    while (true) {
      let pane = '';
      try { pane = this.stripAnsi(await this.tmux.capturePane(target, 150)); } catch {}
      const acted = await this.consultInterstitials(target, provider, pane, handled); // throws distinct BLOCKED on auth
      if (acted) { await new Promise((r) => setTimeout(r, 500)); continue; } // let the menu clear before probing the marker
      const remaining = timeoutMs - (Date.now() - start);
      if (remaining <= 0) return false;
      if (await this.tmux.waitForReady(target, signal, Math.min(2000, remaining))) return true;
    }
  }

  // POCFIX (2026-06-30, outer-projcore): strip ANSI escape codes before matching readiness markers.
  // claude/grok/codex per-word-color the composer footer (e.g. "\x1b[91mbypass\x1b[39m permissions on"),
  // so a raw regex over the capturePane '-e' output never matches and the ready-probe fails at spawn.
  // Strip the CSI codes first so the marker text is contiguous. (capturePane keeps -e for the UI stream.)
  private stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  }

  // POCFIX11 (1): grok-specific genuine composer ready poll (footer marker + no "Starting session").
  // Called only for grok after basic probe. Reuses capturePane; polls up to timeout.
  private async waitForGrokComposerReady(target: string, timeoutMs: number, handled?: Set<string>): Promise<boolean> {
    const isFake = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production';
    if (isFake) {
      return true; // short-circuit for mocked/test spawns (capturePane returns quick '❯ ready' etc); real-path keeps >=60s + footer check
    }
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const pane = this.stripAnsi(await this.tmux.capturePane(target, 100));
        if (handled && await this.consultInterstitials(target, 'grok', pane, handled)) { // R1: interstitials before ready-marker
          await new Promise((r) => setTimeout(r, 500));
          continue; // re-capture before the ready check (stale snapshot)
        }
        if ((pane.includes('always-approve') || pane.includes('Grok Build')) && !pane.includes('Starting session')) {
          return true;
        }
      } catch (e) {
        if (e instanceof InterstitialBlockedError) throw e; // R1: distinct BLOCKED must propagate, not be swallowed
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  // POCFIX18: claude TUI genuine-ready (mirror grok's). Wait for the composer footer ('bypass permissions')
  // which only appears once the TUI accepts input — avoids the premature '>' readyProbe match that lost the
  // brief during boot (~50% of projcore/validator spawns never planned/validated). Trust pre-accepted (POCFIX7).
  private async waitForClaudeComposerReady(target: string, timeoutMs: number, handled?: Set<string>): Promise<boolean> {
    const isFake = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production';
    if (isFake) return true;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const pane = this.stripAnsi(await this.tmux.capturePane(target, 120));
        if (handled && await this.consultInterstitials(target, 'claude', pane, handled)) { // R1: interstitials before ready-marker
          await new Promise((r) => setTimeout(r, 500));
          continue; // re-capture before the ready check (stale snapshot)
        }
        if (/bypass permissions on|shift\+tab to cycle/i.test(pane) && !/Do you trust|trust this folder/i.test(pane)) {
          return true;
        }
      } catch (e) {
        if (e instanceof InterstitialBlockedError) throw e; // R1: distinct BLOCKED must propagate, not be swallowed
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  // T2 (codex genuine-ready): mirror grok/claude. After basic › probe, wait for stable footer showing model
  // (gpt-5.* or › prompt) with no "Starting" / spinner. Prevents premature brief send on boot.
  private async waitForCodexComposerReady(target: string, timeoutMs: number, handled?: Set<string>): Promise<boolean> {
    const isFake = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production';
    if (isFake) return true;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const pane = this.stripAnsi(await this.tmux.capturePane(target, 120));
        if (handled && await this.consultInterstitials(target, 'codex', pane, handled)) { // R1: interstitials (update nag!) before ready-marker
          await new Promise((r) => setTimeout(r, 500));
          continue; // re-capture before the ready check (the menu itself can contain › glyphs)
        }
        const hasStable = /gpt-5/i.test(pane) || /›/.test(pane);
        const noLoading = !/Starting|loading|spinner/i.test(pane);
        if (hasStable && noLoading) {
          return true;
        }
      } catch (e) {
        if (e instanceof InterstitialBlockedError) throw e; // R1: distinct BLOCKED must propagate, not be swallowed
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  async reap(handle: string, reason = 'complete'): Promise<void> {
    const sessionName = (handle || '').split(':')[0];
    if (!sessionName) return;

    // Reuse B7 DSP7 clearContext (provider-specific: /clear for grok/codex, clear for claude + verify clean prompt + no residue)
    try {
      const providerGuess = /claude/i.test(handle) ? 'claude' : 'grok';
      await this.tmux.clearContext(handle, providerGuess);
    } catch {
      // best-effort (matches tmux-service implementation)
    }

    try {
      await this.tmux.terminateSession(sessionName);
    } catch {
      // idempotent / best-effort reap
    }
    try { this.governedDocGuards.get(sessionName)?.stop(); } catch {}
    this.governedDocGuards.delete(sessionName);
  }

  // POCFIX7: idempotent best-effort pre-trust for claude agents (prevents "trust dialog" blocking first launch in dir).
  // Merge into ~/.claude.json projects[<abs launchDir>]. Set both flags. Only for claude; never abort launch on error.
  private async ensureClaudeTrust(launchDir: string): Promise<void> {
    try {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      if (!home) return;
      const cfgPath = path.join(home, '.claude.json');
      let cfg: any = { projects: {} };
      try {
        const raw = await fs.readFile(cfgPath, 'utf8');
        cfg = JSON.parse(raw || '{}');
      } catch {}
      if (!cfg.projects) cfg.projects = {};
      const abs = path.resolve(launchDir);
      if (!cfg.projects[abs]) cfg.projects[abs] = {};
      cfg.projects[abs].hasTrustDialogAccepted = true;
      cfg.projects[abs].hasCompletedProjectOnboarding = true;
      await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    } catch (e) {
      // best-effort only
      console.warn('[real-transport] claude trust ensure best-effort failed (continuing launch)', e);
    }
  }
}

// Selection guidance (prod default, per brief): keep this comment + the env ternary at call sites.
// Do NOT change FakeTransport or tests (they force USE_FAKE_TMUX=1 + directly construct FakeTransport).
// Example at call site (e.g. future A2 or smoke):
//   const isFake = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production';
//   const transport: ITransport = isFake ? new FakeTransport() : new RealTransport();
// RealTransport is only active when NOT USE_FAKE_TMUX (as required).
