import fs from 'node:fs/promises';
import path from 'node:path';
import type { ITransport } from './fake-transport.js';
import type { BriefWriterService } from './brief-writer-service.js';
import { validateExecutionPlan } from './execution-plan-parser.js';
import { CANONICAL_CYCLE_ARTIFACTS } from './cycle-artifact-paths.js';
import { readPlanRevision } from './plan-revision.js';
import { roleMatches } from './role-alias.js';

/**
 * C2 (AC11 foundation): behaviour-preserving seam extracted from planning-phase-service.ts's
 * runPlanningPhase. Owns exactly two things, byte-identical to the pre-extraction inline code:
 * - the partner-spawn loop (brief + spawn + worker-runtime registration per configured seat)
 * - the single waitForAgreement call that follows it
 *
 * runPlanningPhase remains the owner of plancore spawn, canonical plan polling/read/ingest,
 * terminalization (reap-then-finalize) and the PlanningResult return shape. This module never
 * reads plan.md/og-requirements.md and never reaps/finalizes anything itself — waitForAgreement
 * and its parser helpers stay put in planning-phase-service.ts (B3/B4/B5's direct unit tests call
 * them there as private methods via an `any`-typed accessor), so this seam takes that gate as an
 * injected, already-bound callback rather than re-implementing or relocating it.
 */

export interface ConfiguredCoPlannerSeat {
  slot: number;
  provider: string;
  model: string;
  effort?: string;
  source?: string;
}

export interface RunReviewRoundOptions {
  transport: ITransport;
  briefWriter: BriefWriterService;
  /** Bound to the caller's artifacts.writeBrief(runDir, role, content). */
  writeBrief: (role: string, content: string) => Promise<void>;
  /** Bound to the caller's private registerWorkerRuntime(projectId, runId, ...). */
  registerWorkerRuntime: (
    role: string,
    correlationId: string,
    handle: string,
    provider?: string,
    model?: string
  ) => number | null;
  /** The caller's private waitForAgreement, bound (`this.waitForAgreement.bind(this)`) — untouched,
   *  still owned and tested directly on planning-phase-service.ts. */
  waitForAgreement: (
    cbPath: string,
    batchId: string,
    partnerRole: string,
    brainRole: string,
    timeoutMs: number,
    sinceOffset: number,
    partnerBatchIds: string[],
    planMdPathForRaceGuard?: string,
    currentPlanPath?: string
  ) => Promise<boolean>;

  runDir: string;
  batchId: string;
  brainRole: string;
  partner: 'planner' | 'deliberation';
  effectiveProjectDir: string;
  cbPath: string;
  planMdPath: string;
  /** C4 (AC10/AC3): PRIMARY per-round wait budget for a single `waitForAgreement` call — the caller
   *  (planning-phase-service.ts) no longer pre-multiplies this by roundCap. Real callers set this. */
  perRoundTimeoutMs?: number;
  /** LEGACY ALIAS (pre-C4), consulted only when perRoundTimeoutMs is omitted. Kept solely so the
   *  locked planning-review-round-c2.test.ts / -c3.test.ts fixtures (which set this field and not
   *  perRoundTimeoutMs) keep compiling and passing unmodified. New callers should set
   *  perRoundTimeoutMs, not this. */
  effectiveTimeoutMs?: number;
  /** C4 (AC10/AC3): integer count of agreement rounds this call may attempt, each independently
   *  bounded by the resolved per-round timeout above. Omitted/undefined => 1 round — the exact single-
   *  wait shape every existing C2/C3 direct fixture already exercises (none of them sets this). */
  roundCap?: number;
  /** C7 (AC15/AC23): override/force-enable for the reviewer first-callback watchdog
   *  (waitForReviewerFirstCallback below) — generalizes planning-phase-service.ts's plancore-only
   *  waitForFirstCallback (POCFIX20) to reviewer seats. The watchdog itself is ON BY DEFAULT in real
   *  mode (see the `!isFake && process.env.USE_FAKE_TMUX !== '1'` gate in the round loop below) — the
   *  SAME isFakeP convention planning-phase-service.ts already uses to skip its own plancore watchdog
   *  under the fixture harness. That is what keeps every existing C2-C6 caller/fixture byte-identical
   *  without needing this field: every one of those spec files sets `process.env.USE_FAKE_TMUX = '1'`
   *  at module load (including planning-review-round-c3.test.ts's real-mode/isFake:false
   *  direct-success test, which asserts agreement with no reviewer callback ever seeded in cbPath and
   *  cannot be edited), so the watchdog stays inactive for all of them regardless of isFake. This field
   *  is for two additive/optional purposes instead: (1) force-enabling the watchdog under the fixture
   *  harness (USE_FAKE_TMUX==='1') for C7's own dedicated tests, and (2) overriding the bound used —
   *  when omitted, the default-on production path uses the resolved per-round timeout directly; when
   *  set, the bound is min(this value, the resolved per-round timeout), so an override can never exceed
   *  the round's own timeout budget either. */
  reviewerFirstCallbackTimeoutMs?: number;
  agreementFenceOffset: number;
  isFake: boolean;

  panelSize?: number;
  coPlannerSeats?: ConfiguredCoPlannerSeat[];
  partnerModel?: string;
  partnerProvider?: string;
  /** C6 (AC11): model/provider for the engine-spawned plancore REVISE turn (see
   *  generatePlanRoundReviseBrief below). Additive/optional — omitted by every existing C2-C5
   *  caller/fixture, which never trigger the revise actuator. Real callers may bind these to the
   *  same brainRole model/provider used for the initial plancore spawn. */
  planningBrainModel?: string;
  planningBrainProvider?: string;
  projectId?: number;
  runId?: number;
  strictReadAllow?: string[];

  /** Caller-owned accumulators (the SAME arrays the caller's one terminal owner already closes over),
   *  mutated in place rather than returned — so a spawn that throws mid-loop still leaves every
   *  already-spawned seat's handle/runtime id visible to that terminal owner (A5/A6: no exit path,
   *  including a thrown one, may skip reap-before-finalize for a seat this loop already spawned). */
  partnerHandles: string[];
  partnerRuntimeIds: (number | null)[];
}

/**
 * C8 (AC11/AC23): a typed, machine-checkable discriminator for WHY a round did not agree —
 * "typed round-loop results" replacing the anonymous boolean `waitForAgreement` returns internally.
 * Additive/optional alongside the pre-existing string `blockedReason` (kept for the human-readable
 * message every caller/log already reads); this field lets a consumer branch on the CAUSE without
 * parsing prose:
 * - 'artifact-not-published': C3's pre-spawn gate — the current attempt's plan.md/og-requirements.md
 *   were not yet published.
 * - 'reviewer-no-first-callback': C7's watchdog — a spawned reviewer seat never posted anything to
 *   callbacks.md (or its session died) before the round's agreement wait would have started.
 * - 'same-plan-broken': C6/C8 — a reviewer returned BROKEN bound to the CURRENT plan.md revision.
 *   Drives the C6 revise actuator when a round remains to spend; when it does not (the round that
 *   exhausts roundCap), C8 still reports this as the cause instead of collapsing it into
 *   'round-cap-exhausted' below.
 * - 'round-cap-exhausted': no unanimous current-plan CLEAN and no same-plan BROKEN evidence at all —
 *   a genuine timeout/round-cap exit, C4/C5's pre-existing bounded behaviour.
 */
export type RoundBlockedReasonKind =
  | 'artifact-not-published'
  | 'reviewer-no-first-callback'
  | 'same-plan-broken'
  | 'round-cap-exhausted';

export interface ReviewRoundResult {
  agreed: boolean;
  partnerBatchIds: string[];
  /** C3 (AC11/AC23): set when the artifact-publication gate below refused to spawn any reviewer
   *  because the current attempt's plan.md/og-requirements.md were not yet published. C4 (AC10/AC3):
   *  also set when the round loop exhausts roundCap without agreement. Additive/optional so the
   *  existing `const { agreed, partnerBatchIds } = await runReviewRound(...)` destructure in
   *  planning-phase-service.ts is unaffected. */
  blockedReason?: string;
  /** C8 (AC11/AC23): additive/optional typed companion to blockedReason above — see
   *  RoundBlockedReasonKind's doc comment. Always set alongside blockedReason when agreed is false;
   *  always undefined when agreed is true. */
  blockedReasonKind?: RoundBlockedReasonKind;
  /** C4 (AC10/AC3): number of agreement rounds actually attempted before returning. 0 when the C3
   *  artifact-publication gate blocked before any round ran; equal to the resolved roundCap on an
   *  exhausted non-agreement; less than roundCap when an earlier round agreed. */
  roundsAttempted?: number;
}

/**
 * C3 (AC11/AC23): engine-owned artifact-publication gate. The partner brief above already carries a
 * CONVENE-RACE FIX instruction telling every seat to wait-and-recheck rather than emit BROKEN on an
 * absent artifact — that fix relies on every seat's model honoring free-text instructions. This gate
 * removes the race structurally: the current attempt's canonical plan.md must exist, be non-empty and
 * parse (the SAME validateExecutionPlan pipeline ingestion trusts), and og-requirements.md must exist
 * and be non-empty, BEFORE this function ever writes a brief or calls transport.spawn.
 *
 * Real-mode only (`!isFake`): under the FAKE fixture harness, plan.md/og-requirements.md are
 * synthesized by the CALLER (runPlanningPhase) only AFTER the agreement gate resolves — see the
 * `isFake ? undefined : planMdPath` comment on currentPlanPath below, the same pre-existing convention.
 * There is no genuine publication race under the fixture harness, so this gate does not run there and
 * the C2 fixture suite (isFake: true throughout, never writes plan.md into runDir) is unaffected.
 */
async function checkArtifactsPublished(
  planMdPath: string,
  reqMdPath: string
): Promise<{ ready: true } | { ready: false; reason: string }> {
  const problems: string[] = [];

  let planMarkdown: string | null = null;
  try {
    planMarkdown = await fs.readFile(planMdPath, 'utf8');
  } catch {
    problems.push(`plan.md not yet published (${planMdPath})`);
  }
  if (planMarkdown !== null) {
    if (!planMarkdown.trim()) {
      problems.push(`plan.md is empty (${planMdPath})`);
    } else {
      const parsed = validateExecutionPlan(planMarkdown);
      if (!parsed.ok) {
        problems.push(`plan.md does not yet parse as a complete plan (${planMdPath}): ${parsed.errors.join('; ')}`);
      }
    }
  }

  let reqMarkdown: string | null = null;
  try {
    reqMarkdown = await fs.readFile(reqMdPath, 'utf8');
  } catch {
    problems.push(`og-requirements.md not yet published (${reqMdPath})`);
  }
  if (reqMarkdown !== null && !reqMarkdown.trim()) {
    problems.push(`og-requirements.md is empty (${reqMdPath})`);
  }

  if (problems.length === 0) return { ready: true };
  return {
    ready: false,
    reason:
      `ARTIFACT-NOT-PUBLISHED (C3/AC11/AC23): ${problems.join('; ')} — plancore authors these artifacts ` +
      `asynchronously; absence/truncation this early is NOT-YET, never a defect. No reviewer spawned for ` +
      `this attempt yet.`,
  };
}

/**
 * C6 (AC11): local duplicate of planning-phase-service.ts's private parseAgreementCallbackLine
 * (B3's fixed grammar — accepts `-`/`—`/`–`/`:` as the note separator, not just the pre-B3 `[—-]`).
 * That method is private to PlanningPhaseService and this module may not touch that file (locked
 * scope), so the grammar is duplicated here rather than imported. Keep this byte-identical to the
 * source of truth if that grammar ever changes.
 */
function parseRoundCallbackLine(
  line: string
): { role: string; batchId: string; state: string; note: string | null; planSha: string | null } | null {
  const match = /^\[(?:helm|projcore) callback\]\s+(\S+)\s+(\S+)\s+STATUS:\s+([A-Z-]+)(?:\s+[\-—–:]\s+(.+))?\s*$/.exec(line);
  if (!match) return null;
  const note = match[4] ?? null;
  const planShaMatch = note ? /\bplan=([0-9a-f]{12})\b/.exec(note) : null;
  return { role: match[1], batchId: match[2], state: match[3], note, planSha: planShaMatch ? planShaMatch[1] : null };
}

/**
 * C6 fix (AC11/B4 parity): identifies which seat a raw callback line belongs to WITHOUT requiring
 * the full STATUS/state/note grammar to parse — deliberately looser than parseRoundCallbackLine.
 * Used only to lock the newest-line-per-seat below; a line matching this can still fail the strict
 * parse (e.g. a truncated/corrupted mid-write) and must never be treated as evidence itself.
 */
const RAW_CALLBACK_IDENTITY_RE = /^\[(?:helm|projcore) callback\]\s+(\S+)\s+(\S+)/;

/**
 * C6 (AC11): after a round's waitForAgreement resolves false, this module has no verdict detail —
 * waitForAgreement (planning-phase-service.ts, untouched) returns only a boolean. To decide whether
 * the round failed on a genuine same-plan-revision BROKEN (revise-worthy) vs. a round-cap/timeout
 * with no BROKEN evidence at all (C5/C4's existing bounded behaviour, left alone), this re-scans the
 * SAME callbacks window waitForAgreement just read, restricted to THIS round's own round-scoped
 * partnerBatchIds (so an earlier round's stale evidence can never be mistaken for this round's).
 * Mirrors waitForAgreement's own reversed/newest-line-wins-per-seat scan and B5's SHA binding
 * (a BROKEN's plan= must equal the CURRENT plan.md short12, not a superseded revision).
 *
 * C6 fix-cycle: the initial cut locked a seat's "newest line" only once parseRoundCallbackLine had
 * ALREADY succeeded, so a newest line that failed that stricter parse (garbled/truncated mid-write)
 * was skipped WITHOUT locking the seat, letting the scan fall through to an older, parseable
 * same-SHA BROKEN for that same seat — a fail-open hole B4's own waitForAgreement does not have.
 * The lock now happens off the lenient RAW_CALLBACK_IDENTITY_RE match (seat identity only); the
 * strict parse + CLEAN/BROKEN/SHA checks still gate whether the newest line actually counts as
 * evidence, so a malformed newest line correctly excludes the seat instead of exposing older data.
 */
async function collectSameShaBrokenEvidence(
  cbPath: string,
  sinceOffset: number,
  partnerRole: string,
  partnerBatchIds: string[],
  currentShort12: string
): Promise<Array<{ batchId: string; note: string | null }>> {
  let raw: string;
  try {
    const buf = await fs.readFile(cbPath);
    raw = (sinceOffset > 0 ? buf.subarray(sinceOffset) : buf).toString('utf8');
  } catch {
    return [];
  }
  const lines = raw.split(/\r?\n/).reverse(); // newest first
  const seenNewest = new Set<string>();
  const sameShaBroken: Array<{ batchId: string; note: string | null }> = [];
  for (const line of lines) {
    const identity = RAW_CALLBACK_IDENTITY_RE.exec(line);
    if (!identity) continue;
    const [, rawRole, rawBatchId] = identity;
    if (
      seenNewest.has(rawBatchId) ||
      !partnerBatchIds.includes(rawBatchId) ||
      !roleMatches(partnerRole, rawRole)
    ) {
      continue;
    }
    // Lock this seat to its newest raw line, parseable or not — a malformed newest line must never
    // let an older, parseable BROKEN win (fail-closed, mirrors B4's seenNewestVerdict discipline).
    seenNewest.add(rawBatchId);
    const parsed = parseRoundCallbackLine(line);
    if (parsed && parsed.state === 'VERDICT-READY') {
      const verdictMatch = /^\s*(CLEAN|BROKEN)\b/i.exec(parsed.note || '');
      if (verdictMatch && verdictMatch[1].toUpperCase() === 'BROKEN' && parsed.planSha === currentShort12) {
        sameShaBroken.push({ batchId: rawBatchId, note: parsed.note });
      }
    }
    if (seenNewest.size === partnerBatchIds.length) break;
  }
  return sameShaBroken;
}

/**
 * C6 (AC11): the revise actuator's brief. Deliberately a LOCAL function, not a new
 * BriefWriterService method (ownership constraint: C6 may not add to brief-writer-service.ts) —
 * it composes text via the already-public briefWriter.generateBrief(...), the same base every other
 * brief in this file/service builds on (generatePlanReviseBrief follows the
 * identical base+body-splice pattern; plancore authoring brief deleted in B4).
 */
function generatePlanRoundReviseBrief(
  briefWriter: BriefWriterService,
  params: {
    reviseBatchId: string;
    round: number;
    planMdPath: string;
    defects: Array<{ batchId: string; note: string | null }>;
    runDir: string;
    projectDir: string;
    callbacksFile: string;
  }
): string {
  const defectLines = params.defects.map((d, i) => `${i + 1}. [${d.batchId}] ${d.note || '(no note text)'}`);
  const defectSection = defectLines.join('\n') || '(no defect text captured — re-inspect the plan for the reported class of issue)';
  const base = briefWriter.generateBrief({
    batchId: params.reviseBatchId,
    role: 'plancore',
    planPath: params.planMdPath,
    runDir: params.runDir || '.',
    branch: 'main',
    requirementsAssigned: `PLAN-REVISE-ROUND:r${params.round}`,
    northStarAnchors: 'round-review same-plan-revision BROKEN aggregate',
    scope: `Revise the WHOLE plan.md at ${params.planMdPath} to resolve the reviewer-reported defects below for THIS SAME plan revision. Do NOT start a new plan from scratch; make the minimal correct fix. Re-write plan.md in place, then emit PLAN-READY.`,
    requirementsSection: defectSection,
    projectDir: params.projectDir,
    callbacksFile: params.callbacksFile,
    taskType: 'feature',
  });
  const body = `
You are **helm_pm** (plancore / planning brain) — engine-spawned mid-round to REVISE the CURRENT plan.md after round ${params.round}'s reviewer(s) returned BROKEN against this SAME plan revision. You are NOT the implementation brain (ibrain). Bounded surgical revision ONLY.

## Reviewer defects (same plan revision, round ${params.round})
${defectSection}

## Your job
Rewrite plan.md at ${params.planMdPath} to fix the reported defects. Keep every task not implicated by a defect unchanged — do NOT rewrite unrelated tasks and do NOT touch og-requirements.md. Verify the rewritten plan.md is non-empty and its fenced JSON parses before emitting PLAN-READY.

Emit EXACTLY:
[helm callback] helm_pm ${params.reviseBatchId} STATUS: PLAN-READY — plan.md revised for round ${params.round}

First tool call every reply: the callback STATUS line.
`;
  return base.replace('<!-- PROJCORE-STATUS-CONTRACT v2 -->', `<!-- PROJCORE-STATUS-CONTRACT v2 -->${body}`).trim();
}

/**
 * C6 (AC11): poll plan.md until its revision hash differs from the pre-revise short12, bounded by
 * timeoutMs. Returns true once a NEW revision is observed, false on timeout (still a bounded exit —
 * the caller reaps the revise seat and proceeds into the next round regardless, exactly like a
 * round-cap-exhausted non-agreement: never a silent/unbounded wait).
 */
async function waitForPlanRevisionChange(planMdPath: string, previousShort12: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    const current = readPlanRevision(planMdPath);
    if (current && current.short12 !== previousShort12) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * C7 (AC15/AC23): local reviewer-scoped analog of planning-phase-service.ts's private
 * waitForFirstCallback (POCFIX20/A11) — proves a just-spawned reviewer seat is alive and has posted
 * SOMETHING to callbacks.md before this module commits to the (much longer) agreement wait for that
 * round. That method stays owned by PlanningPhaseService for the plancore seat (locked scope, not
 * moved or edited here); this is a narrower, reviewer-scoped duplicate: identity match only, via
 * this module's own RAW_CALLBACK_IDENTITY_RE + roleMatches (no pane/idle-prompt classification, which
 * would expand scope beyond this row). The composer-held retry is opt-in — it only fires when the
 * transport actually exposes resubmitIfComposerHeld (accessed through the narrow local
 * ReviewerWatchdogTransport interface below, since ITransport does not declare it, mirroring the
 * `(this.transport as any).resubmitIfComposerHeld?.(...)` access pattern already used by
 * waitForFirstCallback), bounded to a handful of presses. A transport without inspectSeat/
 * resubmitIfComposerHeld (e.g. FakeTransport's default shape when a test does not stub the latter)
 * degrades to a plain bounded poll-then-timeout — never a thrown error, never an expanded surface.
 */
interface ReviewerWatchdogTransport {
  inspectSeat?(handle: string, brief: string, provider?: string): Promise<{ sessionAlive: boolean }>;
  resubmitIfComposerHeld?(handle: string, brief: string): Promise<boolean>;
}

const REVIEWER_FIRST_CALLBACK_POLL_MS = 200;
const REVIEWER_FIRST_CALLBACK_MAX_PRESSES = 5;

async function waitForReviewerFirstCallback(
  cbPath: string,
  partnerRole: string,
  batchId: string,
  timeoutMs: number,
  sinceOffset: number,
  watchdog: { handle: string; brief: string; transport: ReviewerWatchdogTransport }
): Promise<{ ok: true } | { ok: false; reason: 'no-first-callback' | 'session-gone' }> {
  const start = Date.now();
  let presses = 0;
  for (;;) {
    try {
      const buf = await fs.readFile(cbPath);
      const window = (sinceOffset > 0 ? buf.subarray(sinceOffset) : buf).toString('utf8');
      const matched = window.split(/\r?\n/).some((line) => {
        const identity = RAW_CALLBACK_IDENTITY_RE.exec(line);
        return !!identity && identity[2] === batchId && roleMatches(partnerRole, identity[1]);
      });
      if (matched) return { ok: true };
    } catch {}

    if (watchdog.transport.inspectSeat) {
      const inspection = await watchdog.transport.inspectSeat(watchdog.handle, watchdog.brief);
      if (!inspection.sessionAlive) return { ok: false, reason: 'session-gone' };
    }

    if (watchdog.transport.resubmitIfComposerHeld && presses < REVIEWER_FIRST_CALLBACK_MAX_PRESSES) {
      try {
        const pressed = await watchdog.transport.resubmitIfComposerHeld(watchdog.handle, watchdog.brief);
        if (pressed) presses += 1;
      } catch {
        // Best-effort nudge only — a probe error must never abort the bounded wait itself.
      }
    }

    if (Date.now() - start >= timeoutMs) return { ok: false, reason: 'no-first-callback' };
    await new Promise((r) => setTimeout(r, REVIEWER_FIRST_CALLBACK_POLL_MS));
  }
}

export async function runReviewRound(options: RunReviewRoundOptions): Promise<ReviewRoundResult> {
  const {
    transport, briefWriter, writeBrief, registerWorkerRuntime, waitForAgreement,
    runDir, batchId, brainRole, partner, effectiveProjectDir, cbPath, planMdPath,
    perRoundTimeoutMs, effectiveTimeoutMs, roundCap, reviewerFirstCallbackTimeoutMs, agreementFenceOffset, isFake,
    panelSize, coPlannerSeats, partnerModel, partnerProvider,
    planningBrainModel, planningBrainProvider,
    projectId, runId, strictReadAllow,
    partnerHandles, partnerRuntimeIds,
  } = options;

  // C4 (AC10/AC3): perRoundTimeoutMs is the primary field; effectiveTimeoutMs is consulted only as
  // the legacy alias (see the field doc comments above) — every real/test caller sets exactly one.
  const resolvedPerRoundTimeoutMs = (perRoundTimeoutMs ?? effectiveTimeoutMs)!;
  const resolvedRoundCap = Math.max(1, Math.trunc(roundCap ?? 1) || 1);

  // C3 (AC11/AC23): structural artifact-publication gate — before ANY partner brief write or spawn.
  // Real-mode only; see checkArtifactsPublished's doc comment for why the fixture harness is exempt.
  if (!isFake) {
    const reqMdPath = path.join(path.dirname(planMdPath), CANONICAL_CYCLE_ARTIFACTS.requirements);
    const publication = await checkArtifactsPublished(planMdPath, reqMdPath);
    if (!publication.ready) {
      return {
        agreed: false,
        partnerBatchIds: [],
        blockedReasonKind: 'artifact-not-published',
        blockedReason: publication.reason,
      };
    }
  }

  // A8 (R1.2): a planning run always convenes at least one partner — 'planner' selects a single
  // co-reviewer, 'deliberation' a cross-cutting review, but neither mode skips the partner (D1).
  // A10 (R1.3): the NUMBER of partners is per-project config (project.planning_panel_size, total
  // seats including plancore), not a guess from selectCoPlannerMode's north-star regex — that
  // function only ever chose the partner's review *lens* (planner vs deliberation), never seat count.
  // Default/undefined panelSize => 2 total seats (plancore + 1 partner), byte-identical to pre-A10
  // behavior and correlation-id-compatible with every existing fixture hardcoding `${batchId}-partner`.
  // S06: when coPlannerSeats is non-empty, partner count and per-seat model/provider/effort come
  // from the S05 manifest (ordered configured seats), not a repeated partnerModel. Seat COUNT never
  // changes round to round — only identity does — so this stays hoisted outside the round loop below.
  const configuredSeats = Array.isArray(coPlannerSeats) ? coPlannerSeats : [];
  const useConfiguredSeats = configuredSeats.length > 0;
  const resolvedPanelSize = Math.max(1, Math.trunc(panelSize ?? 2) || 2);
  const partnerCount = useConfiguredSeats
    ? configuredSeats.length
    : Math.max(0, resolvedPanelSize - 1);

  // C5 (AC11/AC13, keystone): spawns THIS round's reviewer seats and returns their batch ids. A
  // seat's turn ends the moment its round's waitForAgreement call resolves without agreement — there
  // is no transport.send, so a later round can never resume or reuse it; the only way to get a seat's
  // opinion again is a brand-new transport.spawn, which is exactly what this closure does, once per
  // round. Round 1 keeps the EXACT legacy correlation id / seat label / writeBrief key (no round
  // segment) so the default case never changes wire format for any existing consumer/fixture; rounds
  // 2+ insert a `-r{round}` segment so a later round's ids can never collide with an earlier round's.
  // real-transport.ts's brief-basename disambiguation (C1) already keys off this same `batchId`
  // string, so round-scoping it here also gives each round's seat its own on-disk prompts/*.brief.md
  // with zero transport-layer changes.
  // C7 (AC15/AC23): return type widened from string[] to carry each seat's brief text + handle
  // alongside its batch id — the first-callback watchdog below needs both (brief for the optional
  // resubmitIfComposerHeld nudge, handle for the optional inspectSeat session-alive probe). Purely a
  // local closure return shape; partnerBatchIds (below) is still derived as a plain string[] so every
  // existing consumer of that field (waitForAgreement call, blockedReason messages, ReviewRoundResult)
  // is unchanged.
  const spawnRoundSeats = async (round: number): Promise<Array<{ batchId: string; brief: string; handle: string }>> => {
    const roundSeats: Array<{ batchId: string; brief: string; handle: string }> = [];
    const roundSuffix = round === 1 ? '' : `-r${round}`;
    for (let i = 0; i < partnerCount; i++) {
      const seatIndexSuffix = i === 0 ? '' : `-${i + 1}`;
      const partnerBatchId = `${batchId}${roundSuffix}-partner${seatIndexSuffix}`;
      const seatLabel = `partner${roundSuffix}${seatIndexSuffix}`;
      const writeBriefKey = `${partner}${roundSuffix}${seatIndexSuffix}`;
      const seatSpec = useConfiguredSeats ? configuredSeats[i] : null;
      const seatModel = seatSpec?.model ?? partnerModel;
      const seatProvider = seatSpec?.provider ?? partnerProvider;
      const seatEffort = seatSpec?.effort;
      // B1: ROUND temporarily uses diff-review (empty implementedDiff) so current verdict
      // text survives until R2/B3 swaps this path to plan-draft / plan-signature.
      const partnerBrief = briefWriter.generatePanelBrief({
        purpose: 'diff-review',
        role: partner,
        batchId: partnerBatchId,
        seat: seatLabel,
        lens: 'plan atomicity, deps, fields, complexity/recommended_model, validation_criteria',
        // CONVENE-RACE FIX (run 31, cycle 13, 2026-07-30 04:45 PHT): partners are spawned HERE, while
        // plancore is still AUTHORING plan.md/og-requirements.md — they do not exist yet. Both seats
        // dutifully reported "plan.md and og-requirements.md absent" as BROKEN within ~60s; plancore
        // wrote the files a minute later and emitted PLAN-READY; waitForAgreement treats ANY BROKEN as
        // dispositive fail-fast (R1.4/N11), so the run was blocked before the plan had ever been read.
        // One partner literally wrote "Re-review after plan artifacts land" — it wanted to wait.
        // Absence of the artifacts is NOT-YET, never a negative verdict. Engine-side suppression alone
        // would deadlock (a seat that already emitted VERDICT-READY does not re-emit), so the wait must
        // live in the brief, before the seat ever forms a verdict.
        requirement:
          'FIRST: confirm the canonical plan.md AND og-requirements.md exist and are non-empty. ' +
          'plancore authors them AFTER you are spawned, so on your first look they are very likely ABSENT — ' +
          'that is expected and is NOT a finding. If either is missing, empty, or truncated mid-write: do NOT ' +
          'emit VERDICT-READY at all. Wait and re-check (re-read every ~15s, up to ~8 minutes). Emit a verdict ' +
          'ONLY once you have actually read a complete plan.md. Never return BROKEN because an artifact was ' +
          'absent — BROKEN is reserved for defects in a plan you have genuinely read. ' +
          'THEN: review canonical plan.md and north-star.md. Pressure-test atomicity, deps, fields, ' +
          'complexity/recommended_model, validation_criteria. Return agreement or concrete gaps.',
        projectDir: effectiveProjectDir,
        callbacksFile: cbPath,
      });
      await writeBrief(writeBriefKey, partnerBrief);
      const partnerSpawned = await transport.spawn({
        role: partner,
        brief: partnerBrief,
        runDir,
        batchId: partnerBatchId,
        model: seatModel,
        provider: seatProvider,
        ...(seatEffort ? { effort: seatEffort } : {}),
        attemptId: 0,
        projectDir: effectiveProjectDir,
        projectId,
        runId,
        ...(strictReadAllow ? { strictReadAllow } : {}),
      }); // B-ISO1 + A2: projectId/runId → helm_sessions via createSession
      // A1 (R4.16) + S06 AC25: record each partner seat with its exact identity. C5: these are the
      // SAME caller-owned arrays across every round (never reset here), so the caller's terminal
      // owner still sees every seat ever spawned, in every round, for its own reap-then-finalize pass
      // — finalization stays 100% caller-owned; this module only ever calls transport.reap (below).
      partnerRuntimeIds.push(
        registerWorkerRuntime(partner, partnerBatchId, partnerSpawned.handle, seatProvider, seatModel)
      );
      // A5: retain this partner's handle too — one entry per spawned partner, parallel to partnerRuntimeIds.
      partnerHandles.push(partnerSpawned.handle);
      roundSeats.push({ batchId: partnerBatchId, brief: partnerBrief, handle: partnerSpawned.handle });
    }
    return roundSeats;
  };

  // POCFIX8 (B): long timeout on real !USE_FAKE_TMUX (projcore needs minutes to think, write the
  // canonical docs, and emit PLAN-READY); fast 4s preserved under fixture.
  // A8 (R1.2): waitForAgreement requires BOTH the partner agreement signal AND projcore PLAN-READY in
  // every mode — 'planner' no longer fast-paths on PLAN-READY alone.
  // CONVENE-RACE safety net (see the partner-brief comment above). The brief is the primary fix; this
  // is the deterministic backstop for a seat that ignores it.
  // B5 (AC7/AC23): planMdPath is passed BOTH as the race-guard path param (BROKEN-vs-not-yet-written
  // guard, untouched) and as currentPlanPath (CLEAN-vs-current-bytes SHA binding) — two deliberately
  // separate parameters for two separate concerns on the same underlying file. currentPlanPath is
  // real-path-only (isFake ? undefined : planMdPath), matching planning-phase-service.ts's existing
  // isFake/!isFake convention: under the FAKE fixture harness plan.md is synthesized AFTER the gate, so
  // it is never yet on disk during this wait, and the pre-existing fixture suite drives CLEAN lines
  // with no `plan=` at all.
  // C4 (AC10/AC3): roundCap is now an INTEGER COUNT of agreement rounds, each independently bounded
  // by resolvedPerRoundTimeoutMs — the caller no longer pre-multiplies timeout*roundCap into one
  // scalar wait.
  // C5 (AC11/AC13, keystone): each round now spawns its OWN fresh seats via spawnRoundSeats(round)
  // above, instead of reusing one spawn from before the loop. `priorRoundHandles` holds exactly the
  // handles spawnRoundSeats pushed onto the caller-owned partnerHandles array during the PREVIOUS
  // iteration (captured via a before/after length delta, so this is correct for any partnerCount, not
  // just single-seat panels); on every iteration after the first, those handles are reaped BEFORE this
  // round's spawnRoundSeats call runs — so a round can never observe (or send to) a still-alive
  // prior-round seat. The final round's handles (whether it agreed or the loop exhausts) are
  // deliberately left unreaped here: that stays the caller's job via its existing terminal owner
  // (runPlanningTerminal in planning-phase-service.ts, untouched), which reaps+finalizes everything in
  // partnerHandles/partnerRuntimeIds regardless of how many rounds ran. transport.reap is idempotent
  // on an already-reaped handle, so that final caller-side pass double-reaping an already-reaped
  // handle from an earlier round (if this function ever did so) would be a safe no-op — it does not.
  let agreed = false;
  let roundsAttempted = 0;
  let partnerBatchIds: string[] = [];
  let priorRoundHandles: string[] = [];
  // C8 (AC11/AC23): the LAST attempted round's same-current-plan BROKEN evidence, re-set at the top of
  // every non-agreeing round's classification below (never accumulated across rounds — a round with no
  // evidence of its own must not inherit an earlier round's). Read only after the loop ends, so it
  // always reflects exactly the round that left the loop (the one `roundsAttempted` names). This is
  // what lets the final blockedReason distinguish a genuine same-plan BROKEN from a plain timeout
  // instead of both collapsing into the same anonymous ROUND-CAP-EXHAUSTED exit.
  let lastSamePlanBrokenEvidence: Array<{ batchId: string; note: string | null }> = [];
  for (let round = 1; round <= resolvedRoundCap; round++) {
    roundsAttempted = round;
    if (round > 1) {
      for (const handle of priorRoundHandles) {
        await transport.reap(handle, 'round-non-agreement-reaped');
      }
      priorRoundHandles = [];
    }
    const handleCountBeforeRound = partnerHandles.length;
    const roundSeats = await spawnRoundSeats(round);
    partnerBatchIds = roundSeats.map((seat) => seat.batchId);
    priorRoundHandles = partnerHandles.slice(handleCountBeforeRound);

    // C7 (AC15/AC23): reviewer first-callback watchdog — generalizes plancore's POCFIX20
    // waitForFirstCallback to reviewer seats. ON BY DEFAULT in real mode: `process.env.USE_FAKE_TMUX
    // !== '1'` is the SAME isFakeP convention planning-phase-service.ts already uses to skip its own
    // plancore watchdog under the fixture harness, which is what keeps every existing C2-C6
    // caller/fixture byte-identical (every one of those spec files sets USE_FAKE_TMUX='1' at module
    // load) without needing reviewerFirstCallbackTimeoutMs at all. That field instead force-enables the
    // watchdog under the fixture harness (for C7's own dedicated tests) and/or overrides the bound —
    // see its doc comment on RunReviewRoundOptions. Runs AFTER this round's seats are spawned and
    // BEFORE this round's waitForAgreement call, so a stuck seat is caught before the engine commits to
    // the much longer agreement wait — and, on failure, this round's waitForAgreement is never invoked.
    const reviewerFirstCallbackActive =
      !isFake && (process.env.USE_FAKE_TMUX !== '1' || reviewerFirstCallbackTimeoutMs != null);
    if (reviewerFirstCallbackActive) {
      const boundedFirstCallbackTimeoutMs = Math.min(
        reviewerFirstCallbackTimeoutMs ?? resolvedPerRoundTimeoutMs,
        resolvedPerRoundTimeoutMs
      );
      const firstCallbackOutcomes = await Promise.all(
        roundSeats.map(async (seat) => ({
          seat,
          result: await waitForReviewerFirstCallback(
            cbPath, partner, seat.batchId, boundedFirstCallbackTimeoutMs, agreementFenceOffset,
            { handle: seat.handle, brief: seat.brief, transport: transport as ReviewerWatchdogTransport }
          ),
        }))
      );
      const stuck = firstCallbackOutcomes.filter((o) => !o.result.ok);
      if (stuck.length > 0) {
        const stuckDescription = stuck
          .map((o) => `${o.seat.batchId} (${(o.result as { ok: false; reason: string }).reason})`)
          .join(', ');
        return {
          agreed: false,
          partnerBatchIds,
          roundsAttempted,
          blockedReasonKind: 'reviewer-no-first-callback',
          blockedReason:
            `REVIEWER-NO-FIRST-CALLBACK (C7/AC15/AC23): stuck reviewer seat(s) [${stuckDescription}] never posted a ` +
            `first callback to callbacks.md within ~${boundedFirstCallbackTimeoutMs}ms — bounded exit, never a ` +
            `silent agreement; waitForAgreement was not called for this round.`,
        };
      }
    }

    agreed = await waitForAgreement(
      cbPath, batchId, partner, brainRole, resolvedPerRoundTimeoutMs, agreementFenceOffset,
      partnerBatchIds, planMdPath, isFake ? undefined : planMdPath
    );
    if (agreed) break;

    // C8 (AC11/AC23): classify THIS round's non-agreement against the CURRENT plan.md bytes exactly
    // once, EVERY non-agreeing round — not only when `round < resolvedRoundCap` (C6's original gate).
    // C6 only ran this scan when a next round existed to spend on a revise turn, which meant a
    // same-current-plan BROKEN on the FINAL round left no trace: it fell straight through to the
    // generic ROUND-CAP-EXHAUSTED return below, indistinguishable from a round that timed out with no
    // BROKEN evidence at all. Hoisting the scan itself (not the revise SPAWN, which stays correctly
    // gated on remaining budget just below) lets the post-loop return classify the actual cause.
    lastSamePlanBrokenEvidence = [];
    const currentRevision = readPlanRevision(planMdPath);
    if (currentRevision) {
      lastSamePlanBrokenEvidence = await collectSameShaBrokenEvidence(
        cbPath, agreementFenceOffset, partner, partnerBatchIds, currentRevision.short12
      );
    }

    // C6 (AC11): the revise actuator. A round-cap-exhausted non-agreement with NO same-plan-revision
    // BROKEN evidence just falls through to the next loop iteration unchanged — C5/C4's existing
    // bounded behaviour (respawn fresh reviewers on the SAME plan) is preserved. Only when this
    // round's non-agreement was actually caused by a confirmed BROKEN against the CURRENT plan.md
    // bytes — and there is a next round left to spend — does this engine-spawn a fresh, uniquely
    // named plancore revision turn and wait for a genuinely new plan.md revision before letting the
    // loop's next iteration spawn C5's fresh reviewer seats.
    if (lastSamePlanBrokenEvidence.length > 0 && round < resolvedRoundCap) {
      const reviseBatchId = `${batchId}-r${round}-revise`;
      const reviseBrief = generatePlanRoundReviseBrief(briefWriter, {
        reviseBatchId,
        round,
        planMdPath,
        defects: lastSamePlanBrokenEvidence,
        runDir,
        projectDir: effectiveProjectDir,
        callbacksFile: cbPath,
      });
      await writeBrief(`${brainRole}-r${round}-revise`, reviseBrief);
      const reviseSpawned = await transport.spawn({
        role: brainRole,
        brief: reviseBrief,
        runDir,
        batchId: reviseBatchId,
        model: planningBrainModel,
        provider: planningBrainProvider,
        attemptId: 0,
        projectDir: effectiveProjectDir,
        projectId,
        runId,
        ...(strictReadAllow ? { strictReadAllow } : {}),
      });
      // C6: same caller-owned accumulators the reviewer seats use, so a throw mid-flow still
      // leaves this revision seat visible to the caller's terminal owner (A5/A6 safety net) —
      // it is ALSO explicitly reaped below once the hash wait resolves/times out, mirroring how
      // this loop already reaps prior-round reviewer handles. Belt and suspenders; no leak.
      partnerRuntimeIds.push(
        registerWorkerRuntime(brainRole, reviseBatchId, reviseSpawned.handle, planningBrainProvider, planningBrainModel)
      );
      partnerHandles.push(reviseSpawned.handle);
      // currentRevision is non-null here: lastSamePlanBrokenEvidence is only ever non-empty inside the
      // `if (currentRevision)` branch above.
      const revised = await waitForPlanRevisionChange(planMdPath, currentRevision!.short12, resolvedPerRoundTimeoutMs);
      await transport.reap(reviseSpawned.handle, revised ? 'revise-turn-plan-updated-reaped' : 'revise-turn-timeout-reaped');
    }
  }

  if (!agreed) {
    // C8 (AC11/AC23): a same-current-plan BROKEN on the round that actually ended the loop is a
    // distinct, typed cause — never the anonymous boolean-false ROUND-CAP-EXHAUSTED below, even when
    // (as on the final round) no budget remained to spend on a revise turn.
    if (lastSamePlanBrokenEvidence.length > 0) {
      const defectBatchIds = lastSamePlanBrokenEvidence.map((d) => d.batchId).join(', ');
      return {
        agreed: false,
        partnerBatchIds,
        roundsAttempted,
        blockedReasonKind: 'same-plan-broken',
        blockedReason:
          `SAME-PLAN-BROKEN-NO-ROUNDS-LEFT (C8/AC11/AC23): round ${roundsAttempted} reviewer seat(s) ` +
          `[${defectBatchIds}] returned BROKEN against the CURRENT plan.md revision, and no further round(s) ` +
          `remained (cap ${resolvedRoundCap}) to spawn a revise turn — a same-current-plan BROKEN, not a ` +
          `generic non-convergence timeout.`,
      };
    }
    return {
      agreed: false,
      partnerBatchIds,
      roundsAttempted,
      blockedReasonKind: 'round-cap-exhausted',
      blockedReason:
        `ROUND-CAP-EXHAUSTED (C4/AC10/AC3): no unanimous CLEAN verdict within ${resolvedRoundCap} round(s) ` +
        `(~${resolvedPerRoundTimeoutMs}ms/round budget); partner batch(es) [${partnerBatchIds.join(', ') || 'none configured'}] ` +
        `never confirmed agreement across ${roundsAttempted} attempted round(s) — bounded exit, never a silent pass.`,
    };
  }

  return { agreed, partnerBatchIds, roundsAttempted };
}
