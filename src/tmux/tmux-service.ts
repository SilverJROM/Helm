import { execFile } from "node:child_process";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import { promisify } from "node:util";
import { seatReadySignal } from "../config/providers.js";

const execFileAsync = promisify(execFile);

// CC-CHAT-1 fix: capturePane uses `tmux capture-pane -e` (ANSI escapes kept for xterm.js) — any
// submission-detection regex/string match MUST run on ANSI-stripped text (colour codes split words:
// e.g. the codex nudge renders "esc\x1b[0m dismiss", which silently defeated the plain-text match).
// eslint-disable-next-line no-control-regex
const TMUX_ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~])/g;
function stripAnsiForMatch(s: string): string {
  return (s ?? "").replace(TMUX_ANSI_RE, "");
}

export interface TmuxPane {
  target: string;
  session: string;
  window: string;
  pane: string;
  command: string;
  title: string;
}

export interface SendCommandResult {
  message: string;
  safetyCheck?: any;
  blocked: boolean;
}

export type TextSubmissionState = "held" | "submitted" | "indeterminate";

// SL-R1: optional registry hook injected into TmuxService. A pair of best-effort callbacks fired
// at the single createSession/terminateSession choke point so every Helm session is captured
// centrally. Defaults to a no-op — existing tests, FakeTmuxService, and any construction WITHOUT a
// registry keep working, and TmuxService never hard-depends on the DB.
// A2 (R4.16): onCreate may carry projectId/runId/kind so helm_sessions rows land linked at create
// time (planning seats via RealTransport; workers may still enrich later for late-known context).
// S04 / AC1: owner (helm|human|legacy:unknown) threaded here.
// S05 / AC2: owner REQUIRED pre-spawn — createSession refuses missing/invalid before any tmux mutation.
export type TmuxSessionOwner = 'helm' | 'human' | 'legacy:unknown';

/** B02: CAS token shape carried from create/register through terminate. */
export type TmuxSessionStatusToken = {
  id: number;
  name: string;
  owner: 'helm' | 'human' | 'legacy:unknown';
  expectedStatus: 'active' | 'idle' | 'reaped';
  generation: number;
  /**
   * B05 / B08 fix1 C2: when true, markReaped requires CURRENT status === expectedStatus
   * (idle snapshot cannot claim a same-gen flip to active during staging).
   */
  exactStatusOnly?: boolean;
};

/**
 * B02 C1: termination registry policy.
 * - `sessionToken`: decision-boundary CAS token — only path that may mutate helm_sessions.
 * - `noRegistryWrite: true`: explicit kill-only (tmux destroy, no markReaped).
 * Passing neither is treated as kill-only (fail-safe); never re-read by name to invent a token.
 */
export interface TmuxTerminateOpts {
  /**
   * Captured at create/register (or other authoritative acquire) and retained by the caller.
   * Required for any registry markReaped on terminate. Must not be rebuilt from get(name) at cleanup.
   */
  sessionToken?: TmuxSessionStatusToken;
  /**
   * Explicit: kill tmux only — do not mutate helm_sessions.
   * Use when no decision-boundary token exists (unregistered / already reaped / probe cleanup).
   */
  noRegistryWrite?: boolean;
}

export interface TmuxSessionCreateOpts {
  projectId?: number | null;
  runId?: number | null;
  kind?: string;
  /** Decision authority. Required at create (S05 pre-spawn refusal). */
  owner: TmuxSessionOwner;
  /**
   * B02 C1 fix cycle 2: when set, createSession fills `token` with the register() CAS identity
   * returned by onCreate. Callers MUST retain that token for later terminate/markReaped — never
   * re-capture by name at cleanup.
   */
  sessionTokenOut?: { token?: TmuxSessionStatusToken };
}

const VALID_SESSION_OWNERS = new Set<string>(['helm', 'human', 'legacy:unknown']);

/** S05: fail-closed owner check shared by createSession (pre-spawn) and register (defensive). */
export function assertValidSessionOwner(owner: unknown): asserts owner is TmuxSessionOwner {
  if (typeof owner !== 'string' || !VALID_SESSION_OWNERS.has(owner)) {
    throw new Error(
      `session owner required (helm|human|legacy:unknown); got ${owner === undefined || owner === null ? String(owner) : JSON.stringify(owner)}`
    );
  }
}

/** B08: registry row shape needed for same-name replace eligibility (subset of helm_sessions). */
export type TmuxSessionLookupRow = {
  id: number;
  name: string;
  owner: string | null | undefined;
  status: string;
  generation: number;
};

export interface TmuxSessionRegistryHook {
  /**
   * B02 C1: may return the register() SessionStatusToken so createSession can fill sessionTokenOut.
   */
  onCreate(name: string, opts?: TmuxSessionCreateOpts): TmuxSessionStatusToken | void;
  /**
   * B02 C1 R4: CAS registry claim for this token. Must return true only when markReaped applied.
   * terminateSession kills tmux ONLY after a true return — stale false aborts kill (protects B).
   */
  onTerminate(name: string, token?: TmuxSessionStatusToken): boolean;
  // SL-R2/R4: fired on ACTIVE INPUT to a session (sendKeys). Refreshes last_used_at so the janitor's
  // TTL means "idle for TTL" not "alive for TTL" — keeps actively-used standalone sessions alive.
  onUse(name: string): void;
  /**
   * B08 / AC9: read-only lookup of the existing same-name registry row at create-time eligibility.
   * Optional — missing hook or missing row is treated as unknown ownership (refuse live replace).
   */
  onLookup?(name: string): TmuxSessionLookupRow | null | undefined;
}

/** B08 / AC9–12: typed refusal when createSession will not destroy an existing same-name lifecycle. */
export type SessionCollisionReason =
  | 'human'
  | 'unknown_owner'
  | 'legacy_unknown'
  | 'unasserted'
  | 'untagged'
  | 'exists_unknown'
  | 'replace_refused';

export class SessionNameCollisionError extends Error {
  readonly code = 'SESSION_NAME_COLLISION' as const;
  constructor(
    public readonly sessionName: string,
    public readonly reason: SessionCollisionReason,
    message?: string
  ) {
    super(message ?? `session name collision refused (${reason}): ${sessionName}`);
    this.name = 'SessionNameCollisionError';
  }
}

const NOOP_REGISTRY_HOOK: TmuxSessionRegistryHook = {
  // fix1 / AC19: a void return is no longer proof of owner persistence — publishCreatedSession now
  // requires a truthy onCreate token, so an unhooked TmuxService can never report a successful create.
  onCreate() {},
  // No registry: never claim success (token-bearing terminate will refuse kill without a real CAS).
  onTerminate() {
    return false;
  },
  onUse() {},
  onLookup() {
    return undefined;
  },
};

export class TmuxService {
  // safetyService removed for clean lift into Helm (guardrails.checkCommand used at higher layer for external dispatches if needed)
  // sendCommand accepts skipSafetyCheck (4th arg) for trusted bare CLI launches (master)

  // SL-R1: no-op by default; the real registry is injected in src/index.ts on the shared instance.
  private registryHook: TmuxSessionRegistryHook;

  // S09 / AC19: last ANSI-stripped pane snapshot per bare session name. Used so capturePane can
  // refresh last_used_at only on real agent-output deltas — identical high-freq polls must not touch.
  private lastPaneSnapshots = new Map<string, string>();

  constructor(registryHook?: TmuxSessionRegistryHook) {
    this.registryHook = registryHook ?? NOOP_REGISTRY_HOOK;
  }

  /** SL-R1: wire the registry after construction (lets index.ts build the registry with the same db, then attach). */
  setRegistryHook(hook: TmuxSessionRegistryHook): void {
    this.registryHook = hook ?? NOOP_REGISTRY_HOOK;
  }

  // SL-R2/R4: active-input signal. Fired from EVERY method by which Helm actively drives a session
  // (sendAndSubmit — the chat/message path, sendCommand, sendEnter, sendKeys) so last_used_at is
  // refreshed and the janitor's TTL means "idle for TTL", not "alive for TTL".
  // S09 / AC19: also fired from capturePane ONLY when newly observed agent output differs from the
  // prior pane snapshot — repeated capture polling with identical content must NOT manufacture activity
  // (idle-but-monitored sessions must stay reapable). Bare session name (target may be session:window.pane).
  // Best-effort — never break a send/capture.
  private touchSession(target: string): void {
    try { this.registryHook.onUse((target ?? "").split(":")[0]); } catch (err) { console.warn('[tmux] registry onUse failed', { target, err: String(err) }); }
  }

  /**
   * S09 / AC19: observe agent output from a capture result.
   * - First non-empty snapshot for a session = baseline only (no touch).
   * - Identical subsequent content = no touch (no polling inflation).
   * - Real content delta = touchSession once (last_used_at refresh via onUse).
   * - Empty/failed captures invent no activity and do not reset the baseline.
   * Compare on ANSI-stripped text so TUI colour flicker is not treated as output.
   */
  private observeAgentOutput(target: string, paneContent: string): void {
    const name = (target ?? "").split(":")[0];
    if (!name) return;
    const stripped = stripAnsiForMatch(paneContent);
    if (!stripped) return;
    const prior = this.lastPaneSnapshots.get(name);
    if (prior === undefined) {
      this.lastPaneSnapshots.set(name, stripped);
      return;
    }
    if (prior === stripped) return;
    this.lastPaneSnapshots.set(name, stripped);
    this.touchSession(name);
  }

  async listPanes(): Promise<TmuxPane[]> {
    try {
      const format = "#{session_name}|#{window_index}|#{pane_index}|#{pane_current_command}|#{pane_title}";
      const { stdout } = await execFileAsync("tmux", ["list-panes", "-a", "-F", format]);

      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [session, window, pane, command, title] = line.split("|");
          return {
            target: `${session}:${window}.${pane}`,
            session,
            window,
            pane,
            command,
            title
          };
        });
    } catch (err) {
      console.warn('[tmux] listPanes failed', { err: String(err) });
      return [];
    }
  }

  async listJobsSummary(): Promise<string> {
    const panes = await this.listPanes();
    if (!panes.length) {
      return "No tmux panes found.";
    }

    return panes
      .map((p) => `- ${p.target} | cmd=${p.command} | title=${p.title || "n/a"}`)
      .join("\n");
  }

  async peekPane(target: string, lines = 200): Promise<string> {
    this.ensureValidTarget(target);
    const safeLines = Math.max(20, Math.min(lines, 1000));
    const { stdout } = await execFileAsync("tmux", [
      "capture-pane",
      "-p",
      "-t",
      target,
      "-S",
      `-${safeLines}`
    ]);
    return stdout.trim() || "<empty pane output>";
  }

  async sessionExists(target: string): Promise<boolean> {
    this.ensureValidTarget(target);
    const sessionName = target.split(":")[0];
    try {
      await execFileAsync("tmux", ["has-session", "-t", sessionName]);
      return true;
    } catch (err) {
      console.warn('[tmux] sessionExists/sendAndSubmit failed', { target, err: String(err) });
      return false;
    }
  }

  /**
   * S12: fail-safe existence for the reconciler decision (true | false | null).
   * true = live, false = provably gone, null = unknown (KEEP — never over-CONVERGE).
   * Boolean sessionExists collapses error→false and must not feed decideSessionReconcile alone.
   */
  async sessionExistsTriState(name: string): Promise<boolean | null> {
    try {
      this.ensureValidSessionName(name);
    } catch {
      return null;
    }
    try {
      await execFileAsync('tmux', ['has-session', '-t', name]);
      return true;
    } catch (err: any) {
      const msg = String(err?.stderr ?? err?.message ?? err);
      // S12-V3: ONLY explicit missing-session / no-server evidence → provably gone.
      // Generic exit code 1 (socket/permission/unrecognized) is unknown → null, never false.
      if (
        /no server running/i.test(msg) ||
        /can'?t find session/i.test(msg) ||
        /no such session/i.test(msg) ||
        /session not found/i.test(msg)
      ) {
        return false;
      }
      console.warn('[tmux] sessionExistsTriState probe unknown → null', { name, err: String(err) });
      return null;
    }
  }

  async sendCommand(
    target: string,
    command: string,
    pressEnter = true,
    skipSafetyCheck = false
  ): Promise<SendCommandResult> {
    this.ensureValidTarget(target);
    const trimmed = command.trim();
    if (!trimmed) {
      throw new Error("Command is required");
    }
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
      throw new Error("Command contains unsupported control characters");
    }

    // Safety omitted in this lift (trusted paths for master launch use skipSafetyCheck=true; higher layers use guardrails.checkCommand)
    // if (!skipSafetyCheck && this.safetyService) { ... }

    await execFileAsync("tmux", ["send-keys", "-l", "-t", target, "--", trimmed]);
    if (pressEnter) {
      await execFileAsync("tmux", ["send-keys", "-t", target, "C-m"]);
    }
    this.touchSession(target); // SL-R2/R4: active input → refresh last_used_at
    return {
      message: `Sent command to ${target}${pressEnter ? " and pressed Enter" : ""}: ${trimmed}`,
      blocked: false
    };
  }

  // Type literal (non-interpreted) text into the composer. Extracted so the submit-verify path can be
  // driven by tests independently of capturePane (StubTmux overrides this + sendEnter + sendKeys).
  async sendLiteralText(target: string, text: string): Promise<void> {
    await execFileAsync("tmux", ["send-keys", "-l", "-t", target, "--", text]);
  }

  // Send text literally then verify submission by a per-seat composer TRANSITION. Returns true only when
  // the post-send pane positively proves submission; blank/boot/auth/capture-failure frames stay
  // indeterminate and fail closed. Best-effort: never throws.
  //
  // F2 (opt-in, per-seat, master-safe): when `opts.readySignal` is supplied (the caller's provider
  // readyProbe glyph, e.g. '❯' / '›'), the seat must PRESENT that signal before we type — a send attempted
  // before the composer accepts input (empty first paint, codex launch echo, claude/grok auth/update/
  // startup) lacks it → NOT delivered instead of typing into the void (BUG-1 does not recur). Callers that
  // omit it (the master runtime feed, whose TUI does not surface ❯/› at feed time; legacy callers) keep the
  // exact original behavior. This carries per-seat composer-ready state into verification without shared
  // global state and without a heuristic that a different-TUI seat would fail.
  //
  // F1: the "still held?" check is `composerRegionHoldsText` — the composer region + OUR specific text only,
  // never free-form response wording — so a reply merely ending in "Not now" cannot be misread as un-submitted.
  async sendAndSubmit(target: string, text: string, opts?: { readySignal?: string; generationCountsAsSubmitted?: boolean }): Promise<boolean> {
    try {
      this.ensureValidTarget(target);
      const trimmed = text.trim();
      if (!trimmed) return false;

      // Distinctive chunks used to detect our message in the composer region.
      // head chunk: matches short messages on the composer line; tail chunk: matches LONG messages
      // whose head scrolled out of the visible composer block (codex multi-line composer).
      const chunk = trimmed.replace(/\s+/g, "").slice(0, 40);
      const tailChunk = trimmed.replace(/\s+/g, "").slice(-40);

      const fast = process.env.HELM_TEST_FAST_WD === '1';

      // F2 opt-in per-seat readiness gate. Uses the SAME signal the caller's readyProbe uses, so it never
      // misjudges a seat whose composer we don't otherwise model.
      const readySignal = opts?.readySignal;
      if (readySignal) {
        const READY_BACKOFF_MS = fast ? [1, 1, 1, 1] : [100, 250, 500, 1000, 1500];
        let ready = false;
        for (const waitMs of READY_BACKOFF_MS) {
          const pane = stripAnsiForMatch(await this.capturePane(target));
          if (pane.includes(readySignal)) { ready = true; break; }
          await setTimeoutPromise(waitMs);
        }
        if (!ready) return false; // composer never presented its ready signal → seat not accepting input
      }

      // Initial send: literal text, allow the TUI paste/composer to settle, then press Enter. These remain
      // separate overridable calls so tests can reproduce the real send-keys paste/submit race exactly.
      await this.sendLiteralText(target, trimmed);
      this.touchSession(target); // SL-R2/R4: chat/message submission → refresh last_used_at (THE active-use path)
      await setTimeoutPromise(fast ? 1 : 300);
      await this.sendEnter(target);

      // TRANSITION — our text must LEAVE the composer region. ROBUSTFIX v2 (live runs 76+78): codex can DROP
      // Enter on a pasted composer for a post-boot window (>6s), so retry Enter-only (never a re-paste —
      // single-clean-send preserved) on a BACKOFF totalling ~55s, stopping the moment the composer clears.
      // A codex/spark seat can echo the submitted turn under a ›/❯ transcript line while it generates.
      // isTextSubmitted accepts generation only when it is footer-scoped BELOW that payload-bearing line,
      // which proves it belongs to this turn; stale generation above a held composer remains held.
      const SUBMIT_BACKOFF_MS = fast ? [1, 1, 1, 1] : [1000, 2000, 4000, 8000, 15000, 25000];
      for (const waitMs of SUBMIT_BACKOFF_MS) {
        await setTimeoutPromise(waitMs);
        const pane = stripAnsiForMatch(await this.capturePane(target));
        const state = this.isTextSubmitted(pane, chunk, tailChunk);
        if (state === "submitted") return true;
        // Backward-compatible master/feed carve-out: ungated legacy callers historically accept an active
        // no-composer generation frame. Interactive seats always pass readySignal and therefore stay on the
        // fail-closed tri-state path above.
        if (state === "indeterminate" && !readySignal
          && /esc to interrupt|esc to cancel|⏹|Responding…|Generating…|Thinking…|Working…|thinking (?:with|·)/i.test(pane)) {
          return true;
        }
        // An indeterminate boot/capture frame gives us no safe target for Enter. Keep polling, but never
        // re-paste. Only a positively HELD composer receives a bounded Enter-only retry.
        if (state !== "held") continue;
        // The codex "Create a plan?" nudge SWALLOWS C-m; dismiss it with Esc (harmless) before re-pressing.
        if (/Create a plan\?[\s\S]{0,120}esc dismiss/i.test(pane)) {
          try { await this.sendKeys(target, 'Escape'); } catch {}
          await setTimeoutPromise(fast ? 1 : 300);
        }
        await this.sendEnter(target);
      }

      await setTimeoutPromise(fast ? 1 : 1500);
      const pane = stripAnsiForMatch(await this.capturePane(target));
      const state = this.isTextSubmitted(pane, chunk, tailChunk);
      if (state === "submitted") return true;
      return state === "indeterminate" && !readySignal
        && /esc to interrupt|esc to cancel|⏹|Responding…|Generating…|Thinking…|Working…|thinking (?:with|·)/i.test(pane);
    } catch (err) {
      console.warn('[tmux] sessionExists/sendAndSubmit failed', { target, err: String(err) });
      return false;
    }
  }

  // R8 (submit watchdog) — pure check: does this (already captured) pane show `text` still sitting
  // UN-submitted in the composer? Extracted around isTextSubmitted so the watchdog probes
  // (orchestrator-loop waitForCallback / planning first-callback wait) and unit tests share the
  // exact same heuristic as sendAndSubmit's own verification (head chunk + tail chunk +
  // paste/plan-nudge indicators, ANSI-stripped).
  paneHoldsUnsubmittedText(rawPane: string, text: string): boolean {
    const trimmed = (text ?? "").trim();
    if (!trimmed) return false;
    const chunk = trimmed.replace(/\s+/g, "").slice(0, 40);
    const tailChunk = trimmed.replace(/\s+/g, "").slice(-40);
    return this.isTextSubmitted(rawPane, chunk, tailChunk) === "held";
  }

  // R8 (submit watchdog) — live probe: capture the session's pane and report whether `text` is
  // still visible un-submitted in its composer. Best-effort: any error (session gone etc) → false.
  async composerHoldsText(target: string, text: string): Promise<boolean> {
    try {
      this.ensureValidTarget(target);
      const pane = await this.capturePane(target);
      return this.paneHoldsUnsubmittedText(pane, text);
    } catch (err) {
      console.warn('[tmux] composerHoldsText probe failed', { target, err: String(err) });
      return false;
    }
  }

  // MECHANISM-based, per-seat submit detection (F1/F2 redesign). The ONLY reliable signal is whether the
  // COMPOSER REGION — the ❯/› input line plus its multi-line input block — still holds OUR specific text.
  // It never inspects free-form RESPONSE text, so a reply that merely ENDS in "Not now" / "Press Enter to
  // confirm" cannot be misread as un-submitted (F1), and "no composer region present" means our text is
  // simply not held there (delivery is decided by a real held→cleared TRANSITION in sendAndSubmit, not by
  // guessing boot-vs-submitted from a single frame — F2). Returns true iff OUR text is still in the composer.
  composerRegionHoldsText(rawPane: string, chunk: string, tailChunk?: string): boolean {
    if (!chunk && !tailChunk) return false;
    const pane = stripAnsiForMatch(rawPane); // idempotent; defends direct callers passing -e output
    // A pasted blob is text held in the composer (not yet submitted).
    if (/\[Pasted Content|tab to queue/i.test(pane)) return true;
    // CC-CHAT-1 (codex 5.5): the "Create a plan?  …  esc dismiss" nudge only shows while the composer
    // HOLDS un-submitted multi-line text (below a bare ›, invisible to the composer-line scan). Held.
    if (/Create a plan\?[\s\S]{0,120}esc dismiss/i.test(pane)) return true;
    const lines = pane.replace(/\r\n/g, "\n").split("\n");
    let composerIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^[❯›]/u.test(lines[i].trimStart())) {
        composerIdx = i;
        break;
      }
    }
    if (composerIdx < 0) return false; // no composer region ⇒ our text is not held there
    const composerChunk = lines[composerIdx].replace(/\s+/g, "");
    if (chunk && composerChunk.includes(chunk)) return true;
    // Multi-line composer (codex): content renders on the lines BELOW a bare ❯/› marker. A long message
    // scrolls its head out of view — match the message TAIL against that below-marker block.
    if (tailChunk) {
      const below = lines.slice(composerIdx + 1).join("").replace(/\s+/g, "");
      if (below.includes(tailChunk)) return true;
    }
    return false;
  }

  // worker-dispatch-feed submit-proof (P1 FOOTER-SCOPED). A generation indicator only proves OUR brief was
  // submitted when it belongs to THIS turn — i.e. it renders in the live footer region STRICTLY BELOW the last
  // ›/❯ composer/transcript line. Callers gate this behind `composerRegionHoldsText` being TRUE, so that last
  // ›/❯ line is the one holding our just-typed brief (codex/spark echo the submitted turn back under a › line
  // the composer check misreads as "still held"); a generation marker BELOW it is this turn's active work.
  // A generation token sitting in STALE SCROLLBACK ABOVE a composer that STILL HOLDS our un-submitted brief is
  // an EARLIER completed turn and is NOT below the composer line ⇒ NOT counted — else a not-submitted brief is
  // falsely reported delivered (the P1 false-positive). Mirrors how the chat relay (paneIsGenerating) and the
  // master-feed footer-scope their generation check. Keys on the SAME indicators those two already trust — NOT
  // the composer glyph. Best-effort, pure over an already-captured pane (idempotent ANSI strip defends callers).
  submittedByGeneration(rawPane: string): boolean {
    const pane = stripAnsiForMatch(rawPane);
    const lines = pane.replace(/\r\n/g, "\n").split("\n");
    let composerIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^[❯›]/u.test(lines[i].trimStart())) { composerIdx = i; break; }
    }
    if (composerIdx < 0) return false; // no composer/transcript anchor → the composer-region check decides
    // Only the region STRICTLY BELOW the payload-bearing composer line is THIS turn's active footer. A stale
    // generation line ABOVE the held composer (composerIdx) is excluded by construction.
    const footer = lines.slice(composerIdx + 1).join("\n");
    return /esc to interrupt|esc to cancel|⏹|Responding…|Generating…|Thinking…|Working…|thinking (?:with|·)/i.test(footer);
  }

  // Tri-state submit proof. Absence of our text is not enough: a genuinely-cleared composer still renders
  // a ❯/› line, whereas blank/boot/update/auth/capture-failure frames render no composer and are therefore
  // indeterminate. A payload-bearing line followed by footer-scoped generation is positive proof that this
  // turn submitted even though the TUI still echoes our text under the composer glyph.
  private isTextSubmitted(rawPane: string, chunk: string, tailChunk?: string): TextSubmissionState {
    const pane = stripAnsiForMatch(rawPane);
    if (!pane.trim()) return "indeterminate";

    if (this.composerRegionHoldsText(pane, chunk, tailChunk)) {
      return this.submittedByGeneration(pane) ? "submitted" : "held";
    }

    const hasRenderedComposer = pane.replace(/\r\n/g, "\n").split("\n")
      .some((line) => /^[❯›]/u.test(line.trimStart()));
    return hasRenderedComposer ? "submitted" : "indeterminate";
  }

  async sendEnter(target: string): Promise<SendCommandResult> {
    this.ensureValidTarget(target);
    await execFileAsync("tmux", ["send-keys", "-t", target, "C-m"]);
    this.touchSession(target); // SL-R2/R4: active input → refresh last_used_at
    return {
      message: `Sent Enter to ${target}`,
      blocked: false
    };
  }

  /**
   * F3/R8 submit-watchdog primitive (G1: hoisted to TmuxService for reuse by chat-session-service
   * and real-transport without duplication). If `text` is still visibly held in the composer
   * (per the exact isTextSubmitted heuristic), dismiss any codex "Create a plan?" nudge then
   * press Enter once. Returns true iff a re-press action was performed. Best-effort, never throws.
   */
  async resubmitIfComposerHeld(target: string, text: string): Promise<boolean> {
    try {
      this.ensureValidTarget(target);
      const held = await this.composerHoldsText(target, text);
      if (!held) return false;
      const pane = stripAnsiForMatch(await this.capturePane(target, 60));
      if (/Create a plan\?[\s\S]{0,120}esc dismiss/i.test(pane)) {
        try { await this.sendKeys(target, 'Escape'); } catch {}
        await setTimeoutPromise(300);
      }
      await this.sendEnter(target);
      return true;
    } catch (err) {
      console.warn('[tmux] resubmitIfComposerHeld failed', { target, err: String(err) });
      return false;
    }
  }

  /**
   * B08 / F-03 AC9–11: create (or fail-closed replace) a named session.
   * - Provably gone → new-session under final name (no kill).
   * - Existence unknown → refuse (zero kill).
   * - Live same-name → eligibility gate, then stage-before-close replace:
   *   new-session under staging name → terminateSession(old) → rename → register(final).
   * Never raw kill-if-exists. Staging failure leaves the old lifecycle untouched (AC11 structural).
   */
  async createSession(name: string, cwd?: string, opts?: TmuxSessionCreateOpts): Promise<string> {
    this.ensureValidSessionName(name);
    // S05 / AC2 (F2): owner refusal MUST be pre-spawn. register()/onCreate runs AFTER new-session and is
    // try/caught — refusing there would leave a live untracked unreapable session. Check before ANY tmux cmd.
    assertValidSessionOwner(opts?.owner);

    const exists = await this.sessionExistsTriState(name);
    if (exists === null) {
      throw new SessionNameCollisionError(
        name,
        'exists_unknown',
        `session name collision refused (exists_unknown): cannot prove ${name} is gone`
      );
    }
    if (exists === true) {
      await this.createSessionReplacingLive(name, cwd, opts!);
      return `${name}:0.0`;
    }

    // Provably absent: create under the final name directly (no prior kill).
    await this.spawnTaggedSession(name, cwd);
    await this.publishCreatedSession(name, opts);
    return `${name}:0.0`;
  }

  /**
   * B08: live same-name replace — eligibility first (zero kill on refuse), then stage-before-close.
   * Eligible completed Helm: owner=helm + status=idle + @helm_child, closed via terminateSession CAS.
   * Reaped+live orphan (row already converged): physical close via noRegistryWrite after successful stage.
   */
  private async createSessionReplacingLive(
    name: string,
    cwd: string | undefined,
    opts: TmuxSessionCreateOpts
  ): Promise<void> {
    const row = this.lookupExistingSession(name);
    if (!row) {
      throw new SessionNameCollisionError(
        name,
        'unknown_owner',
        `session name collision refused (unknown_owner): no registry row for live ${name}`
      );
    }

    const owner = row.owner;
    if (owner === 'human') {
      throw new SessionNameCollisionError(
        name,
        'human',
        `session name collision refused (human): will not replace live human session ${name}`
      );
    }
    if (owner === 'legacy:unknown') {
      throw new SessionNameCollisionError(
        name,
        'legacy_unknown',
        `session name collision refused (legacy_unknown): will not replace live legacy session ${name}`
      );
    }
    if (owner !== 'helm') {
      throw new SessionNameCollisionError(
        name,
        'unknown_owner',
        `session name collision refused (unknown_owner): live ${name} has owner ${JSON.stringify(owner)}`
      );
    }

    const status = String(row.status || '');
    // AC9: live replace requires completion assertion (idle) or already-converged reaped orphan.
    // Active-without-completion is never eligible.
    if (status === 'active') {
      throw new SessionNameCollisionError(
        name,
        'unasserted',
        `session name collision refused (unasserted): live ${name} is active without completion`
      );
    }
    if (status !== 'idle' && status !== 'reaped') {
      throw new SessionNameCollisionError(
        name,
        'unasserted',
        `session name collision refused (unasserted): live ${name} has status ${JSON.stringify(status)}`
      );
    }

    // AC9: any live old target must carry positive @helm_child (untagged never killed via replace).
    const tagged = await this.sessionHasHelmChildTag(name);
    if (!tagged) {
      throw new SessionNameCollisionError(
        name,
        'untagged',
        `session name collision refused (untagged): live ${name} lacks @helm_child`
      );
    }

    // Capture old CAS token at decision boundary before any mutation (idle path only).
    // B08 fix1 C2: exactStatusOnly fences idle completion at the destructive CAS — an idle→active
    // flip during staging must not still claim/kill the old lifecycle.
    let oldToken: TmuxSessionStatusToken | undefined;
    if (status === 'idle') {
      try {
        oldToken = {
          id: row.id,
          name: row.name,
          owner: 'helm',
          expectedStatus: 'idle',
          generation: row.generation,
          exactStatusOnly: true,
        };
      } catch {
        throw new SessionNameCollisionError(
          name,
          'unasserted',
          `session name collision refused (unasserted): cannot build token for ${name}`
        );
      }
    }

    // Stage under a unique name FIRST so a create failure never touches the old lifecycle (AC11).
    // B08 fix1 C1 / AC19: staging (like every create path) requires a successful @helm_child tag —
    // incomplete stage must not close old.
    const stagingName = this.makeStagingSessionName(name);
    try {
      await this.spawnTaggedSession(stagingName, cwd);
    } catch (err) {
      // Staging failed (new-session or strict tag) — old session and registry must remain untouched.
      // Orphan staging teardown (if new-session succeeded) is handled inside spawnTaggedSession.
      throw err;
    }

    // Authorized close of the old lifecycle through terminateSession (AC10), not raw kill-session.
    let closed = false;
    try {
      if (status === 'idle' && oldToken) {
        closed = await this.terminateSession(name, { sessionToken: oldToken });
      } else {
        // reaped row already converged — physical cleanup only.
        closed = await this.terminateSession(name, { noRegistryWrite: true });
      }
    } catch (err) {
      await this.killSessionRaw(stagingName).catch(() => {});
      throw err;
    }
    if (!closed) {
      await this.killSessionRaw(stagingName).catch(() => {});
      throw new SessionNameCollisionError(
        name,
        'replace_refused',
        `session name collision refused (replace_refused): terminateSession did not close ${name}`
      );
    }

    // Publish under the FINAL name (registry row must not name the staging session).
    try {
      await execFileAsync('tmux', ['rename-session', '-t', stagingName, name]);
    } catch (err) {
      // Old is gone; staging may still exist — best-effort cleanup, then surface the failure.
      await this.killSessionRaw(stagingName).catch(() => {});
      throw err;
    }

    await this.publishCreatedSession(name, opts);
  }

  /** B08: lookup existing same-name registry row for replace eligibility (fail-closed if absent). */
  private lookupExistingSession(name: string): TmuxSessionLookupRow | null {
    const lookup = this.registryHook.onLookup;
    if (typeof lookup !== 'function') return null;
    try {
      const row = lookup.call(this.registryHook, name);
      if (!row || typeof row.id !== 'number' || !row.name) return null;
      return row;
    } catch (err) {
      console.warn('[tmux] registry onLookup failed → treating as unknown', { name, err: String(err) });
      return null;
    }
  }

  /** Unique staging name under ensureValidSessionName charset (no second session under final name). */
  private makeStagingSessionName(finalName: string): string {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const staging = `${finalName}-stg-${suffix}`;
    this.ensureValidSessionName(staging);
    return staging;
  }

  /**
   * ST-R1: new-session + @helm_child tag. No registry write (caller publishes under the final name).
   *
   * AC19 / F-07: @helm_child is mandatory on EVERY create path (fresh-create and staging replace
   * alike) — the janitor's ownership probe (sessionHasHelmChildTag) fail-safes untagged sessions to
   * "not ours, never reap", so a swallowed tag failure would leave a permanent unreapable orphan.
   * Any set-option failure tears down the just-created session and rethrows; callers must never
   * treat an incompletely-tagged session as a successful create.
   */
  private async spawnTaggedSession(sessionName: string, cwd?: string): Promise<void> {
    const args = ['new-session', '-d', '-s', sessionName];
    if (cwd) {
      args.push('-c', cwd);
    }
    await execFileAsync('tmux', args);

    try {
      await execFileAsync('tmux', ['set-option', '-t', sessionName, '@helm_child', '1']);
    } catch (err) {
      // Remove the orphan (tag incomplete); rollback failure must surface, never vanish (fix1).
      await this.rollbackOrphanSession(sessionName, err);
    }
  }

  /**
   * SL-R1 / A2 / S05 / B02: register under the FINAL session name and optionally fill sessionTokenOut.
   *
   * AC19 / F-07: registry/owner persistence is mandatory, not best-effort — a durable unowned active
   * row is exactly the state AC19 forbids. A throwing onCreate rejects the create: the just-created
   * tmux session (published under `name`) is torn down and the failure is rethrown so the caller never
   * treats this as a success.
   *
   * fix1: absence-of-throw is not proof of persistence either. `onCreate` is typed `token | void`, and
   * a hook (or the NOOP default on an unhooked TmuxService) that returns void without throwing produced
   * exactly the same fail-open result the redteam flagged — a live tagged session with no registry row.
   * A falsy return is now treated identically to a thrown error: reject + roll back.
   */
  private async publishCreatedSession(name: string, opts?: TmuxSessionCreateOpts): Promise<void> {
    let createdToken: TmuxSessionStatusToken | void = undefined;
    try {
      createdToken = this.registryHook.onCreate(name, opts);
    } catch (err) {
      console.warn('[tmux] registry onCreate failed — rejecting create (AC19 fail-closed)', { name, err: String(err) });
      await this.rollbackOrphanSession(name, err);
    }
    if (!createdToken) {
      console.warn('[tmux] registry onCreate returned no durable token — rejecting create (AC19 fail-closed)', { name });
      await this.rollbackOrphanSession(
        name,
        new Error(`registry onCreate returned no durable token for ${name} — owner persistence not acknowledged (AC19 fail-closed)`)
      );
    }
    if (opts?.sessionTokenOut) {
      opts.sessionTokenOut.token = createdToken as TmuxSessionStatusToken;
    }
  }

  /**
   * fix1 (AC19 / F-07): shared rollback for a failed post-create step (tag or registry persist). The
   * prior implementation swallowed a `kill-session` rollback failure (`.catch(() => {})`), which meant
   * a session that survived BOTH the original failure and the cleanup kill was reported only as the
   * original error — the live, untagged/unowned orphan itself was invisible to the caller.
   *
   * Kill success (or a kill failure where a follow-up tri-state probe PROVES the session is already
   * gone — e.g. a race where it died between the failed call and this check) rethrows only the
   * original cause. Any other outcome (kill failed AND the session is still live or unknown) throws an
   * AggregateError carrying both failures, so the rejection itself makes the surviving orphan visible
   * instead of reading as an ordinary create failure.
   */
  private async rollbackOrphanSession(sessionName: string, cause: unknown): Promise<never> {
    const causeErr = cause instanceof Error ? cause : new Error(String(cause));
    try {
      await this.killSessionRaw(sessionName);
    } catch (killErr) {
      const stillThere = await this.sessionExistsTriState(sessionName);
      if (stillThere === false) {
        throw causeErr;
      }
      throw new AggregateError(
        [causeErr, killErr instanceof Error ? killErr : new Error(String(killErr))],
        `rollback kill failed for ${sessionName} after create failure — session may still be LIVE and untagged/unowned (orig: ${causeErr.message})`
      );
    }
    throw causeErr;
  }

  // ST-R2: positive Helm-ownership probe. Returns true ONLY if the live session carries the
  // `@helm_child` user-option set to '1' (the marker createSession applies). On ANY error — session
  // gone, tmux failure, option absent — returns FALSE (fail-safe: unknown ownership = NOT ours = never
  // kill). The janitor gates its terminate on this so a non-Helm (or untagged) session can never be reaped.
  async sessionHasHelmChildTag(name: string): Promise<boolean> {
    try {
      this.ensureValidSessionName(name);
      const { stdout } = await execFileAsync('tmux', ['show-options', '-t', name, '-v', '@helm_child']);
      return stdout.trim() === '1';
    } catch (err) {
      console.warn('[tmux] sessionHasHelmChildTag probe failed → treating as NOT-Helm (fail-safe)', { name, err: String(err) });
      return false;
    }
  }

  /**
   * S08: fail-safe read of tmux `#{session_activity}`.
   * Returns null (unknown) on any error, missing session, or malformed output.
   * Unknown is intentionally safe-fail for the janitor (conservative over-reap behavior).
   */
  async sessionActivity(name: string): Promise<number | null> {
    try {
      this.ensureValidSessionName(name);
      const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '-t', name, '#{session_activity}']);
      const raw = (stdout ?? '').trim();
      if (!raw) return null;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0 || Number.isNaN(parsed)) return null;
      return parsed;
    } catch (err) {
      console.warn('[tmux] sessionActivity probe failed → treating as unknown', { name, err: String(err) });
      return null;
    }
  }

  /**
   * S08: fail-safe read of tmux `#{session_attached}`.
   * Returns null (unknown) on any error, missing session, or malformed output.
   * Unknown is intentionally safe-fail for the janitor (attached status avoids unsafe idle evidence).
   */
  async sessionAttached(name: string): Promise<boolean | null> {
    try {
      this.ensureValidSessionName(name);
      const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '-t', name, '#{session_attached}']);
      const raw = (stdout ?? '').trim();
      if (raw === '1') return true;
      if (raw === '0') return false;
      return null;
    } catch (err) {
      console.warn('[tmux] sessionAttached probe failed → treating as unknown', { name, err: String(err) });
      return null;
    }
  }

  async createPane(sessionTarget: string, cwd?: string): Promise<string> {
    // sessionTarget can be "session:window" or "session:window.pane"
    const args = ["split-window", "-t", sessionTarget];
    if (cwd) {
      args.push("-c", cwd);
    }
    await execFileAsync("tmux", args);

    // Get the new pane target
    const panes = await this.listPanes();
    const sessionName = sessionTarget.split(":")[0];
    const sessionPanes = panes.filter((p) => p.session === sessionName);
    const last = sessionPanes[sessionPanes.length - 1];
    return last?.target || sessionTarget;
  }

  /**
   * Destroy a tmux session, optionally gated by a decision-boundary CAS token.
   *
   * B02 C1 R4 ordering (CRITICAL):
   * - With `sessionToken`: registry claim (`onTerminate` / markReaped) runs **first**.
   *   Only if the claim applies (`true`) is `kill-session` issued. Stale token → **no kill**
   *   (same-name replacement B must not be physically destroyed by stale A cleanup).
   * - With `noRegistryWrite` or missing token: kill-only (no registry mutation).
   *
   * @returns true if kill-session was performed; false if aborted (stale CAS / refused).
   */
  async terminateSession(sessionName: string, opts?: TmuxTerminateOpts): Promise<boolean> {
    this.ensureValidSessionName(sessionName);
    const token = opts?.sessionToken;
    const killOnly = !!opts?.noRegistryWrite || !token;

    if (!killOnly && token) {
      // CAS claim before any destructive tmux action.
      let applied = false;
      try {
        applied = this.registryHook.onTerminate(sessionName, token) === true;
      } catch (err) {
        console.warn('[tmux] registry onTerminate failed — refusing kill', {
          sessionName,
          err: String(err),
        });
        return false;
      }
      if (!applied) {
        // Stale lifecycle token: do not kill the name (may now be replacement B).
        return false;
      }
    }

    await this.killSessionRaw(sessionName);
    // S09: drop prior pane snapshot so a recreated same-name session re-baselines (no stale delta).
    this.lastPaneSnapshots.delete(sessionName);
    return true;
  }

  /** Overridable for tests — production runs `tmux kill-session -t <name>`. */
  protected async killSessionRaw(sessionName: string): Promise<void> {
    await execFileAsync("tmux", ["kill-session", "-t", sessionName]);
  }

  async terminatePane(target: string): Promise<void> {
    this.ensureValidTarget(target);
    await execFileAsync("tmux", ["kill-pane", "-t", target]);
  }

  async capturePane(target: string, lines = 200): Promise<string> {
    this.ensureValidTarget(target);
    const safeLines = Math.max(20, Math.min(lines, 5000));
    try {
      const { stdout } = await execFileAsync("tmux", [
        "capture-pane",
        "-p",
        "-e",
        "-t",
        target,
        "-S",
        `-${safeLines}`
      ]);
      // Convert \n to \r\n for xterm.js
      const content = stdout.replace(/\n/g, "\r\n");
      // S09 / AC19: bump last_used_at only when agent output differs from prior snapshot.
      // Best-effort — never mask a successful capture if the registry hook throws.
      try { this.observeAgentOutput(target, content); } catch (err) {
        console.warn('[tmux] observeAgentOutput failed', { target, err: String(err) });
      }
      return content;
    } catch (err) {
      console.warn('[tmux] capturePane failed', { err: String(err) });
      return "";
    }
  }

  // Current working directory of a session's active pane. Used to resolve a coordinator's
  // relative run_dir (registered relative to ITS cwd, not ours). Returns null if unknown.
  async paneCurrentPath(session: string): Promise<string | null> {
    this.ensureValidTarget(session);
    try {
      const { stdout } = await execFileAsync("tmux", [
        "display-message",
        "-p",
        "-t",
        session,
        "#{pane_current_path}"
      ]);
      const dir = stdout.trim();
      return dir || null;
    } catch (err) {
      console.warn('[tmux] paneCurrentPath failed', { session, err: String(err) });
      return null;
    }
  }

  ensureValidTarget(target: string): void {
    const bareSession = /^[a-zA-Z0-9_.-]+$/.test(target);
    const paneTarget = /^[a-zA-Z0-9_.-]+:[0-9]+\.[0-9]+$/.test(target);
    if (!bareSession && !paneTarget) {
      throw new Error("Invalid tmux target. Use format session or session:window.pane");
    }
  }

  private ensureValidSessionName(name: string): void {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
      throw new Error("Invalid session name. Use alphanumeric, underscore, dot, or dash only.");
    }
  }

  // Added for P1-5b: pid-verify (list-panes -F #{pane_pid}) and exitSequence support
  async getPanePid(target: string): Promise<string | null> {
    this.ensureValidTarget(target);
    try {
      const { stdout } = await execFileAsync("tmux", ["list-panes", "-t", target, "-F", "#{pane_pid}"]);
      return stdout.trim() || null;
    } catch (err) {
      console.warn('[tmux] getPanePid failed', { target, err: String(err) });
      return null;
    }
  }

  async sendKeys(target: string, keys: string): Promise<SendCommandResult> {
    this.ensureValidTarget(target);
    await execFileAsync("tmux", ["send-keys", "-t", target, keys]);
    this.touchSession(target); // SL-R2/R4: active input → refresh last_used_at
    return {
      message: `Sent keys ${keys} to ${target}`,
      blocked: false
    };
  }

  async forceKillPane(target: string): Promise<void> {
    this.ensureValidTarget(target);
    await execFileAsync("tmux", ["respawn-pane", "-k", "-t", target]);
  }

  // B4 DSP1 helpers (small, surgical): ready probe + marker verify with exact bash fidelity (-J join + full ws-strip).
  // Used by DispatchService for ensure/reuse + 3-call hand-off confirmation. Defaults match worker + sh.
  async waitForReady(target: string, signal = '❯', timeoutMs = 30000): Promise<boolean> {
    this.ensureValidTarget(target);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const pane = await this.capturePane(target, 150);
      if (pane.includes(signal)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  async capturePaneForVerify(target: string, lines = 200): Promise<string> {
    this.ensureValidTarget(target);
    const safeLines = Math.max(20, Math.min(lines, 5000));
    try {
      const { stdout } = await execFileAsync("tmux", [
        "capture-pane",
        "-p",
        "-J", // join wrapped lines (bash -J) so marker not split
        "-e",
        "-t",
        target,
        "-S",
        `-${safeLines}`
      ]);
      return stdout;
    } catch (err) {
      console.warn('[tmux] capturePaneForVerify failed', { target, err: String(err) });
      return "";
    }
  }

  async verifyMarkerPresent(target: string, marker: string, linesBack = 200): Promise<boolean> {
    this.ensureValidTarget(target);
    const pane = await this.capturePaneForVerify(target, linesBack);
    // exact port of sh marker verify: full whitespace delete on both, then substring
    const paneNW = pane.replace(/\s+/g, "");
    const markNW = marker.replace(/\s+/g, "");
    return paneNW.includes(markNW);
  }

  async sendDispatchInstruction(target: string, payload: string, readySignal?: string): Promise<boolean> {
    this.ensureValidTarget(target);
    // delegate to robust submit (handles composer paste issues like sendAndSubmit).
    // F2: interactive worker SEAT — forward the provider ready glyph the dispatcher already readyProbed with,
    // so a seat that never reached its composer is not falsely marked delivered.
    // worker-dispatch-feed (2026-07-16): ALSO accept a live GENERATION indicator as submit-proof. DispatchService.start
    // has already waitForReady'd this SAME glyph immediately before this call, so the seat IS ready; once it accepts the
    // brief it starts GENERATING, and codex/spark echo the submitted brief back under a ›-prefixed transcript line that
    // composerRegionHoldsText misreads as "still held" → the false "feed-failed" that stalled the live cards2 loop.
    // Generation ⇒ delivered; a genuinely dead / never-accepting seat never generates → still returns false.
    return this.sendAndSubmit(target, payload, { readySignal, generationCountsAsSubmitted: true });
  }

  // B7 DSP7: /clear primitive (provider-specific). MUST VERIFY reset actually happened (capture prompt / confirm clean state).
  // codex/grok: TUI /clear (or fresh session equiv). claude: clear+rehydrate sequence.
  // Returns issued + verified (clean prompt present, no prior task residue). Used by loop between tasks.
  // Best-effort on send; verification is the guard (test both success and non-reset detection).
  async clearContext(target: string, provider: string = 'codex'): Promise<{ issued: boolean; verified: boolean; postCapture: string }> {
    this.ensureValidTarget(target);
    let issued = false;
    try {
      let cmd = '/clear';
      if (provider === 'claude') {
        // claude clear+rehydrate (per brief)
        cmd = 'clear';
      } else if (provider === 'grok' || provider === 'codex') {
        cmd = '/clear';
      }
      // F2: SEAT control command — gate on this provider's composer ready glyph so /clear is not falsely
      // marked issued into a not-ready seat.
      const submitOk = await this.sendAndSubmit(target, cmd, { readySignal: seatReadySignal(provider) });
      if (submitOk) issued = true;
      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      console.warn('[tmux] clearContext send failed (best effort)', { target, provider, err: String(err) });
    }
    const postCapture = await this.capturePane(target, 80);
    // VERIFY clean: ready prompt signal present AND no obvious prior context/task residue
    const hasReady = /❯|ready|Human:|^\s*>|^\s*❯/i.test(postCapture);
    const hasResidue = /batch-|thinking|previous|context|task|REPRO|working on/i.test(postCapture.slice(0, 300));
    const verified = issued && hasReady && !hasResidue;
    return { issued, verified, postCapture };
  }

  // A1: /compact primitive (provider-specific). Mirrors clearContext (B7 DSP7) but summarize-then-continue
  // instead of a hard reset. claude + codex + grok CLIs all ship a native /compact; only a genuinely
  // unknown/other provider gets a generic plain-language fallback instruction. Verify only that the pane
  // returned to a ready prompt — compact INTENTIONALLY keeps the summarized conversation, so residual
  // context/task words are EXPECTED (do NOT apply clearContext's !hasResidue term here). Longer settle
  // wait than /clear — real summarization is slower than a plain reset.
  async compactContext(target: string, provider: string = 'codex'): Promise<{ issued: boolean; verified: boolean; postCapture: string }> {
    this.ensureValidTarget(target);
    let issued = false;
    try {
      let cmd = '/compact';
      if (provider === 'claude' || provider === 'codex' || provider === 'grok') {
        // native /compact in all three CLIs (claude/codex/grok).
        cmd = '/compact';
      } else {
        // genuinely unknown/other provider — generic plain-language fallback instruction line.
        cmd = 'summarize the conversation so far into a compact form and continue';
      }
      // F2: SEAT control command — gate on this provider's composer ready glyph (undefined for an unknown
      // provider → ungated, original behavior).
      const submitOk = await this.sendAndSubmit(target, cmd, { readySignal: seatReadySignal(provider) });
      if (submitOk) issued = true;
      // Compaction does real summarization work — give the pane more time to settle than /clear before capture.
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      console.warn('[tmux] compactContext send failed (best effort)', { target, provider, err: String(err) });
    }
    const postCapture = await this.capturePane(target, 80);
    // VERIFY: ready prompt signal present after compaction. NO residue check — compact keeps the
    // (summarized) conversation, so prior context/task words remaining is expected, not a failure.
    const hasReady = /❯|ready|Human:|^\s*>|^\s*❯/i.test(postCapture);
    const verified = issued && hasReady;
    return { issued, verified, postCapture };
  }
}
