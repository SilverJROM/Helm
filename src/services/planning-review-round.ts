import fs from 'node:fs/promises';
import path from 'node:path';
import type { ITransport } from './fake-transport.js';
import type { BriefWriterService } from './brief-writer-service.js';
import { validateExecutionPlan } from './execution-plan-parser.js';
import { readPlanRevision, type PlanRevision } from './plan-revision.js';
import { roleMatches } from './role-alias.js';
import {
  composeSeatDraftReadAllow,
  publishDraft,
  type PublishedDraft,
  atomicWriteFile,
  candidatePlanPath,
  candidateReqPath,
} from './seat-draft-store.js';
import { designateRound2Proposer, formatProposerLog } from './proposer-role.js';

/**
 * C2 (AC11 foundation): behaviour-preserving seam extracted from planning-phase-service.ts's
 * runPlanningPhase. Owns exactly two things, byte-identical to the pre-extraction inline code:
 * - the partner-spawn loop (brief + spawn + worker-runtime registration per configured seat)
 * - the single waitForAgreement call that follows it
 *
 * runPlanningPhase remains the owner of plancore spawn, canonical plan polling/read/ingest,
 * terminalization (reap-then-finalize) and the PlanningResult return shape. This module never
 * reaps/finalizes anything itself — waitForAgreement and its parser helpers stay put in
 * planning-phase-service.ts (B3/B4/B5's direct unit tests call them there as private methods via an
 * `any`-typed accessor), so this seam takes that gate as an injected, already-bound callback rather
 * than re-implementing or relocating it.
 *
 * C3 re-scoped (R4.16): the pre-spawn publication gate checks seat-scoped drafts / candidates when
 * supplied — never pre-promotion canonical plan.md / og-requirements.md (engine promotes those at P2).
 */

export interface ConfiguredCoPlannerSeat {
  slot: number;
  provider: string;
  model: string;
  effort?: string;
  source?: string;
}

/**
 * C3 re-scoped (R4.16): one artifact the publication gate must verify before spawn.
 * Paths are seat-scoped drafts or shared candidates — never pre-promotion canonical
 * `plan.md` / `og-requirements.md` (those stay absent until P2 engine promotion).
 */
export interface PublicationArtifactSpec {
  /** Absolute path to the file that must exist. */
  path: string;
  /** Label for failure messages (e.g. "seat-a draft plan", "candidate plan"). */
  label: string;
  /**
   * When true, non-empty content must pass `validateExecutionPlan` (plan documents only —
   * requirements drafts stay existence + non-empty).
   */
  validateAsPlan?: boolean;
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

  /**
   * C3 re-scoped (R4.16): descriptors for the relevant seat-scoped draft or candidate the gate must
   * see before spawn (round-2+ / post-draft gates).
   * - omitted or empty: round-1 pre-spawn mode — only `runDir` must exist (plus optional
   *   `contextInputPaths` when provided); **never** requires canonical plan.md / og-requirements.md.
   * - non-empty: each artifact must exist and be non-empty; plan docs (`validateAsPlan`) must parse
   *   via `validateExecutionPlan`.
   * Real-mode only; `isFake` still exempts the entire gate (fixture harness).
   */
  publicationArtifacts?: PublicationArtifactSpec[];
  /**
   * Optional context inputs (north-star.md, conversation-log.md, decisions/) checked only in
   * round-1 pre-spawn mode when `publicationArtifacts` is empty/omitted.
   */
  contextInputPaths?: string[];
  /**
   * R2 (R2.5-R2.7, R6.20, R6.24): opt-in — when true, ROUND 1 spawns BOTH configured co-planner
   * seats as independent blind drafters (`purpose:'plan-draft'`, seat-scoped write targets composed
   * via seat-draft-store, D2 OS-enforced isolation allowlists) instead of the legacy diff-review
   * reviewer path, and waits for each seat's committed draft (a DRAFT-SUBMITTED callback, or the C7
   * first-callback watchdog plus an on-disk file commit) rather than the legacy verdict-grammar
   * `waitForAgreement`. The engine always recomputes each draft's hash from disk (D1) and never
   * trusts a callback's claimed sha. Additive/optional: every existing C2-C8 fixture/caller leaves
   * this unset and is byte-identical. When set, this function returns immediately once round 1's
   * drafts are collected (or timed out) — round 2+ asymmetric proposer/signer dynamics are R3's
   * scope, not this flag's.
   */
  blindDraftRound1?: boolean;

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
 * - 'artifact-not-published': C3's pre-spawn gate (R4.16) — relevant seat-scoped draft/candidate (or
 *   round-1 runDir/context inputs) not yet published; never "canonical plan.md missing" pre-P2.
 * - 'reviewer-no-first-callback': C7's watchdog — a spawned reviewer seat never posted anything to
 *   callbacks.md (or its session died) before the round's agreement wait would have started.
 * - 'same-plan-broken': C6/C8 — a reviewer returned BROKEN bound to the CURRENT plan.md revision.
 *   Drives the C6 revise actuator when a round remains to spend; when it does not (the round that
 *   exhausts roundCap), C8 still reports this as the cause instead of collapsing it into
 *   'round-cap-exhausted' below.
 * - 'round-cap-exhausted': no unanimous current-plan CLEAN and no same-plan BROKEN evidence at all —
 *   a genuine timeout/round-cap exit, C4/C5's pre-existing bounded behaviour.
 * - 'draft-not-submitted': R2 (R2.5-R2.7) — a round-1 blind-draft seat never committed its draft
 *   (neither a DRAFT-SUBMITTED callback nor an on-disk file commit) within the round's timeout.
 */
export type RoundBlockedReasonKind =
  | 'artifact-not-published'
  | 'reviewer-no-first-callback'
  | 'same-plan-broken'
  | 'round-cap-exhausted'
  | 'draft-not-submitted';

export interface ReviewRoundResult {
  agreed: boolean;
  partnerBatchIds: string[];
  /** C3 (R4.16): set when the re-scoped artifact-publication gate refused to spawn (seat-scoped
   *  draft/candidate missing/empty/unparseable, or round-1 runDir/context missing). C4 (AC10/AC3):
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
  /** R2 (R2.5-R2.7, R6.24): set only when `blindDraftRound1` completed round 1 with every seat's draft
   *  committed — one entry per seat, engine-recomputed from disk (D1's publishDraft; never a trusted
   *  callback claim). `agreed` stays false alongside this (a published draft is not agreement); R3
   *  consumes this to designate the round-2 proposer/signer. Always undefined otherwise. */
  roundOneDraftPublications?: PublishedDraft[];
}

/**
 * C3 re-scoped (R4.16): engine-owned artifact-publication gate for **round-2+ / post-draft** paths.
 * Checks the **relevant seat-scoped draft or candidate** exists, is non-empty, and — when
 * `validateAsPlan` — parses via the SAME `validateExecutionPlan` pipeline ingestion trusts.
 *
 * **Never** requires canonical `plan.md` / `og-requirements.md` before P2 promotion (those paths stay
 * absent until the engine alone promotes a signed candidate). Callers pass seat-draft / candidate
 * paths via `publicationArtifacts`; do not point this at pre-promotion canonical paths.
 *
 * Real-mode only (`!isFake`): under the FAKE fixture harness there is no genuine publication race,
 * so this gate does not run and the C2 fixture suite (isFake: true throughout) is unaffected.
 */
async function checkArtifactsPublished(
  artifacts: PublicationArtifactSpec[]
): Promise<{ ready: true } | { ready: false; reason: string }> {
  const problems: string[] = [];

  for (const art of artifacts) {
    let markdown: string | null = null;
    try {
      markdown = await fs.readFile(art.path, 'utf8');
    } catch {
      problems.push(`${art.label} not yet published (${art.path})`);
      continue;
    }
    if (!markdown.trim()) {
      problems.push(`${art.label} is empty (${art.path})`);
      continue;
    }
    if (art.validateAsPlan) {
      const parsed = validateExecutionPlan(markdown);
      if (!parsed.ok) {
        problems.push(
          `${art.label} does not yet parse as a complete plan (${art.path}): ${parsed.errors.join('; ')}`
        );
      }
    }
  }

  if (problems.length === 0) return { ready: true };
  return {
    ready: false,
    reason:
      `ARTIFACT-NOT-PUBLISHED (C3/R4.16): ${problems.join('; ')} — co-planner drafts/candidates ` +
      `are authored asynchronously; absence/truncation this early is NOT-YET, never a defect. No seat ` +
      `spawned for this gate check yet.`,
  };
}

/**
 * C3 re-scoped (R4.16): round-1 pre-spawn gate — only that `runDir` exists (and optional context
 * inputs when provided). No seat-scoped draft, no candidate, and **never** canonical plan.md /
 * og-requirements.md (those do not exist until P2).
 */
async function checkRound1PreSpawn(
  runDir: string,
  contextInputPaths?: string[]
): Promise<{ ready: true } | { ready: false; reason: string }> {
  const problems: string[] = [];

  try {
    const st = await fs.stat(runDir);
    if (!st.isDirectory()) {
      problems.push(`runDir is not a directory (${runDir})`);
    }
  } catch {
    problems.push(`runDir does not exist (${runDir})`);
  }

  if (Array.isArray(contextInputPaths)) {
    for (const p of contextInputPaths) {
      try {
        await fs.access(p);
      } catch {
        problems.push(`context input not yet available (${p})`);
      }
    }
  }

  if (problems.length === 0) return { ready: true };
  return {
    ready: false,
    reason:
      `ARTIFACT-NOT-PUBLISHED (C3/R4.16 round-1): ${problems.join('; ')} — round-1 pre-spawn requires ` +
      `runDir (+ optional context inputs) only; canonical plan.md/og-requirements.md are not gated here.`,
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

/**
 * R2 (R2.7): the plan-draft purpose's terminal grammar (brief-writer-service.ts's plan-draft body)
 * is `STATUS: DRAFT-SUBMITTED plan=<sha12>` — NO `[-—–:]` separator before the `plan=` claim, unlike
 * the legacy verdict grammar parseRoundCallbackLine expects. Reusing that stricter parser here would
 * silently fail to match the real brief output (it requires a separator before any trailing text), so
 * this is a dedicated, purpose-built match: state identity only. The `plan=<sha12>` claim itself is
 * intentionally never extracted — it is non-authoritative (D1); the engine always re-reads the
 * committed file instead.
 */
const DRAFT_SUBMITTED_RE = /^\[(?:helm|projcore) callback\]\s+(\S+)\s+(\S+)\s+STATUS:\s+DRAFT-SUBMITTED\b/;

/**
 * R2 (R2.5-R2.7): round-1 blind-draft seat identity — the same shape spawnRoundSeats' draft branch
 * pushes into resolveRoundOneDraftPhase below. `seatId` is the exact seat-draft-store id (matches
 * generatePanelBrief's `seat` param for purpose:'plan-draft'), reused to recompute the draft's
 * on-disk path/hash via publishDraft.
 */
interface RoundOneDraftSeat {
  batchId: string;
  brief: string;
  handle: string;
  seatId: string;
}

/**
 * R2 (R2.5-R2.7, R6.24): waits for ONE round-1 drafting seat to commit — extends C7's watchdog
 * (session-alive probe + bounded composer-held resubmit, both optional per ReviewerWatchdogTransport)
 * with the draft-specific acceptance grammar: "DRAFT-SUBMITTED (or first-callback + file commit)".
 * A parsed DRAFT-SUBMITTED line is the fast path; a seat that has posted ANY callback plus a
 * committed draft file also counts (the terminal line itself may be lost/malformed — the on-disk
 * bytes are the actual publication). Either way the returned publication is ALWAYS the engine's own
 * disk re-read via publishDraft (D1) — a callback's claimed sha is never trusted.
 */
async function waitForDraftCommit(
  cbPath: string,
  partnerRole: string,
  seat: RoundOneDraftSeat,
  runDir: string,
  timeoutMs: number,
  sinceOffset: number,
  watchdogTransport: ReviewerWatchdogTransport
): Promise<
  | { ok: true; publication: PublishedDraft }
  | { ok: false; reason: 'no-first-callback' | 'session-gone' | 'draft-not-committed' }
> {
  const start = Date.now();
  let presses = 0;
  let sawAnyCallback = false;
  for (;;) {
    try {
      const buf = await fs.readFile(cbPath);
      const window = (sinceOffset > 0 ? buf.subarray(sinceOffset) : buf).toString('utf8');
      for (const line of window.split(/\r?\n/)) {
        const identity = RAW_CALLBACK_IDENTITY_RE.exec(line);
        if (!identity || identity[2] !== seat.batchId || !roleMatches(partnerRole, identity[1])) continue;
        sawAnyCallback = true;
        if (DRAFT_SUBMITTED_RE.test(line)) {
          const publication = publishDraft(runDir, seat.seatId);
          if (publication.plan) return { ok: true, publication };
        }
      }
      if (sawAnyCallback) {
        const publication = publishDraft(runDir, seat.seatId);
        if (publication.plan) return { ok: true, publication };
      }
    } catch {}

    if (watchdogTransport.inspectSeat) {
      const inspection = await watchdogTransport.inspectSeat(seat.handle, seat.brief);
      if (!inspection.sessionAlive) return { ok: false, reason: 'session-gone' };
    }
    if (watchdogTransport.resubmitIfComposerHeld && presses < REVIEWER_FIRST_CALLBACK_MAX_PRESSES) {
      try {
        const pressed = await watchdogTransport.resubmitIfComposerHeld(seat.handle, seat.brief);
        if (pressed) presses += 1;
      } catch {
        // Best-effort nudge only — a probe error must never abort the bounded wait itself.
      }
    }

    if (Date.now() - start >= timeoutMs) {
      return { ok: false, reason: sawAnyCallback ? 'draft-not-committed' : 'no-first-callback' };
    }
    await new Promise((r) => setTimeout(r, REVIEWER_FIRST_CALLBACK_POLL_MS));
  }
}

/**
 * R2 (R2.5-R2.7, R6.24): resolves round 1 once every configured co-planner seat has been spawned as
 * a blind drafter. Never calls the legacy `waitForAgreement` — a `plan-draft` seat never emits panel
 * verdict grammar, so that wait would only ever time out. Returns a typed, bounded result either way:
 * every seat committed (drafts published, `agreed` still false — a draft is not agreement; R3 owns
 * what happens next) or at least one seat never committed (typed `draft-not-submitted` block).
 */
async function resolveRoundOneDraftPhase(
  cbPath: string,
  partnerRole: string,
  roundSeats: RoundOneDraftSeat[],
  runDir: string,
  timeoutMs: number,
  sinceOffset: number,
  watchdogTransport: ReviewerWatchdogTransport,
  roundsAttempted: number
): Promise<ReviewRoundResult> {
  const partnerBatchIds = roundSeats.map((seat) => seat.batchId);
  const outcomes = await Promise.all(
    roundSeats.map(async (seat) => ({
      seat,
      result: await waitForDraftCommit(cbPath, partnerRole, seat, runDir, timeoutMs, sinceOffset, watchdogTransport),
    }))
  );

  const stuck = outcomes.filter((o) => !o.result.ok);
  if (stuck.length > 0) {
    const stuckDescription = stuck
      .map((o) => `${o.seat.batchId} (${(o.result as { ok: false; reason: string }).reason})`)
      .join(', ');
    return {
      agreed: false,
      partnerBatchIds,
      roundsAttempted,
      blockedReasonKind: 'draft-not-submitted',
      blockedReason:
        `DRAFT-NOT-SUBMITTED (R2/R2.5-R2.7): round-1 blind-draft seat(s) [${stuckDescription}] never ` +
        `committed a draft within ~${timeoutMs}ms — bounded exit, never a silent pass; the engine ` +
        `recomputes hashes from disk (D1) and never trusts a callback's claimed sha.`,
    };
  }

  return {
    agreed: false,
    partnerBatchIds,
    roundsAttempted,
    roundOneDraftPublications: outcomes.map((o) => (o.result as { ok: true; publication: PublishedDraft }).publication),
  };
}

/**
 * R3 (R3.11): the plan-signature purpose's terminal grammar is `STATUS: SIGNED plan=<sha12>` — NO
 * `[-—–:]` separator before the `plan=` claim, the same reason DRAFT_SUBMITTED_RE above needed a
 * dedicated match instead of reusing parseRoundCallbackLine. The sha12 capture is OPTIONAL: a
 * malformed/missing claim still identifies the line as a signature decision, but yields no usable
 * claim — R3.11 requires that case to be treated as non-agreement (fail-closed), never ignored.
 */
const SIGNED_RE = /^\[(?:helm|projcore) callback\]\s+(\S+)\s+(\S+)\s+STATUS:\s+SIGNED\b(?:\s+plan=([0-9a-f]{12}))?/;

/**
 * R3 (R3.11/R3.13): the plan-signature purpose's rejection grammar is
 * `STATUS: OBJECTIONS — n=<k>; 1. <defect> 2. <defect> ...`. The note (everything after the optional
 * separator) is captured verbatim for the caller to surface/parse further — this module does not
 * itself count or validate the numbered list (that is R6's objection-monotonicity scope).
 */
const OBJECTIONS_RE = /^\[(?:helm|projcore) callback\]\s+(\S+)\s+(\S+)\s+STATUS:\s+OBJECTIONS\b(?:\s*[\-—–:]?\s*(.*))?$/;

/**
 * R3 (R3.10): the plan-reconcile purpose's terminal grammar is `STATUS: CANDIDATE-SUBMITTED
 * plan=<sha12>` — mirrors DRAFT_SUBMITTED_RE's identity-only match (the `plan=` claim is
 * non-authoritative; the engine always re-reads the committed candidate file instead, R2.7's
 * discipline re-pointed at the shared candidate path).
 */
const CANDIDATE_SUBMITTED_RE = /^\[(?:helm|projcore) callback\]\s+(\S+)\s+(\S+)\s+STATUS:\s+CANDIDATE-SUBMITTED\b/;

/**
 * R3 (R3.10): waits for the fresh-spawned proposer seat to commit ONE reconciled candidate —
 * extends the same C7 watchdog shape (session-alive probe + bounded composer-held resubmit) used by
 * waitForDraftCommit above, with the candidate-specific acceptance grammar: "CANDIDATE-SUBMITTED (or
 * first-callback + file commit)". The returned hash is ALWAYS the engine's own re-read of the shared
 * candidate path (never a trusted callback claim) — the proposer never writes canonical plan.md.
 */
async function waitForCandidateCommit(
  cbPath: string,
  partnerRole: string,
  seat: RoundOneDraftSeat,
  candidatePlanFilePath: string,
  timeoutMs: number,
  sinceOffset: number,
  watchdogTransport: ReviewerWatchdogTransport
): Promise<
  | { ok: true; candidatePlan: PlanRevision }
  | { ok: false; reason: 'no-first-callback' | 'session-gone' | 'candidate-not-committed' }
> {
  const start = Date.now();
  let presses = 0;
  let sawAnyCallback = false;
  for (;;) {
    try {
      const buf = await fs.readFile(cbPath);
      const window = (sinceOffset > 0 ? buf.subarray(sinceOffset) : buf).toString('utf8');
      for (const line of window.split(/\r?\n/)) {
        const identity = RAW_CALLBACK_IDENTITY_RE.exec(line);
        if (!identity || identity[2] !== seat.batchId || !roleMatches(partnerRole, identity[1])) continue;
        sawAnyCallback = true;
        if (CANDIDATE_SUBMITTED_RE.test(line)) {
          const candidatePlan = readPlanRevision(candidatePlanFilePath);
          if (candidatePlan) return { ok: true, candidatePlan };
        }
      }
      if (sawAnyCallback) {
        const candidatePlan = readPlanRevision(candidatePlanFilePath);
        if (candidatePlan) return { ok: true, candidatePlan };
      }
    } catch {}

    if (watchdogTransport.inspectSeat) {
      const inspection = await watchdogTransport.inspectSeat(seat.handle, seat.brief);
      if (!inspection.sessionAlive) return { ok: false, reason: 'session-gone' };
    }
    if (watchdogTransport.resubmitIfComposerHeld && presses < REVIEWER_FIRST_CALLBACK_MAX_PRESSES) {
      try {
        const pressed = await watchdogTransport.resubmitIfComposerHeld(seat.handle, seat.brief);
        if (pressed) presses += 1;
      } catch {
        // Best-effort nudge only — a probe error must never abort the bounded wait itself.
      }
    }

    if (Date.now() - start >= timeoutMs) {
      return { ok: false, reason: sawAnyCallback ? 'candidate-not-committed' : 'no-first-callback' };
    }
    await new Promise((r) => setTimeout(r, REVIEWER_FIRST_CALLBACK_POLL_MS));
  }
}

/**
 * R3 (R3.11): waits for the fresh-spawned signer seat to post its decision — SIGNED (with the sha12
 * it computed re-reading the candidate) or a bounded OBJECTIONS list. Unlike draft/candidate commits
 * there is no on-disk fallback: a signature decision is callback-grammar-only, so a seat that never
 * posts either line always resolves to a bounded timeout, never a silent pass.
 */
async function waitForSignerDecision(
  cbPath: string,
  partnerRole: string,
  seat: RoundOneDraftSeat,
  timeoutMs: number,
  sinceOffset: number,
  watchdogTransport: ReviewerWatchdogTransport
): Promise<
  | { ok: true; kind: 'signed'; claimedShort12: string | null }
  | { ok: true; kind: 'objections'; note: string | null }
  | { ok: false; reason: 'no-first-callback' | 'session-gone' }
> {
  const start = Date.now();
  let presses = 0;
  for (;;) {
    try {
      const buf = await fs.readFile(cbPath);
      const window = (sinceOffset > 0 ? buf.subarray(sinceOffset) : buf).toString('utf8');
      for (const line of window.split(/\r?\n/)) {
        const identity = RAW_CALLBACK_IDENTITY_RE.exec(line);
        if (!identity || identity[2] !== seat.batchId || !roleMatches(partnerRole, identity[1])) continue;
        const signedMatch = SIGNED_RE.exec(line);
        if (signedMatch) return { ok: true, kind: 'signed', claimedShort12: signedMatch[3] ?? null };
        const objectionsMatch = OBJECTIONS_RE.exec(line);
        if (objectionsMatch) return { ok: true, kind: 'objections', note: objectionsMatch[3] ?? null };
      }
    } catch {}

    if (watchdogTransport.inspectSeat) {
      const inspection = await watchdogTransport.inspectSeat(seat.handle, seat.brief);
      if (!inspection.sessionAlive) return { ok: false, reason: 'session-gone' };
    }
    if (watchdogTransport.resubmitIfComposerHeld && presses < REVIEWER_FIRST_CALLBACK_MAX_PRESSES) {
      try {
        const pressed = await watchdogTransport.resubmitIfComposerHeld(seat.handle, seat.brief);
        if (pressed) presses += 1;
      } catch {
        // Best-effort nudge only — a probe error must never abort the bounded wait itself.
      }
    }

    if (Date.now() - start >= timeoutMs) return { ok: false, reason: 'no-first-callback' };
    await new Promise((r) => setTimeout(r, REVIEWER_FIRST_CALLBACK_POLL_MS));
  }
}

/**
 * R3 (R3.9-R3.11): round-2 asymmetric proposer/signer divergence handling.
 *
 * Consumes the two round-1 draft publications R2's resolveRoundOneDraftPhase already collected
 * (engine-recomputed hashes, D1) and resolves ONE round-2 outcome:
 *
 * - Hash mismatch: D3's designateRound2Proposer (full sha256, never short12) picks a proposer; the
 *   rule + both full shas are logged via formatProposerLog (R3.9). The designated seat is
 *   fresh-spawned (C5/R6.20) with purpose plan-reconcile and BOTH round-1 draft paths; the other
 *   seat is fresh-spawned with purpose plan-signature and ONLY the resulting candidate (R3.10) —
 *   never a second competing draft, never both seats asked to author a new full document.
 * - Hash match: no model reconcile call — the engine copies the designated seat's already-identical
 *   committed bytes straight to the candidate path. A real signature round still runs regardless
 *   (R3.11's uniform promotion path is preferred over an unproven auto-agree shortcut).
 *
 * Agreement (R3.11) is B5's exact mechanism, re-pointed: the signer's claimed `plan=<sha12>` must
 * equal the candidate's CURRENT on-disk short12, recomputed by the engine at check time. A missing,
 * malformed, or stale claim is never agreement — fail-closed.
 *
 * Round-3+ alternation (rolesForRound, R4) and objection-driven re-reconciliation (R6) are not this
 * function's scope — it resolves exactly one round-2 proposer/signer exchange.
 */
export interface RunProposerSignerRoundOptions {
  transport: ITransport;
  briefWriter: BriefWriterService;
  writeBrief: (role: string, content: string) => Promise<void>;
  registerWorkerRuntime: (
    role: string,
    correlationId: string,
    handle: string,
    provider?: string,
    model?: string
  ) => number | null;

  runDir: string;
  batchId: string;
  /** Round number this call represents — R3's own scope is always round 2. */
  round: number;
  partner: 'planner' | 'deliberation';
  effectiveProjectDir: string;
  cbPath: string;

  /** The two round-1 draft publications (R2's resolveRoundOneDraftPhase output) — both `plan` fields
   *  must be non-null (both seats committed); this function is only ever called once that holds. */
  draftA: PublishedDraft;
  draftB: PublishedDraft;

  perRoundTimeoutMs: number;
  agreementFenceOffset: number;

  coPlannerSeats?: ConfiguredCoPlannerSeat[];
  partnerModel?: string;
  partnerProvider?: string;

  projectId?: number;
  runId?: number;
  strictReadAllow?: string[];

  /** Overrides for the shared candidate paths; default to seat-draft-store's composed paths. */
  candidatePlanPathOverride?: string;
  candidateReqPathOverride?: string;

  /** Caller-owned accumulators — same convention as RunReviewRoundOptions (A5/A6 safety net). */
  partnerHandles: string[];
  partnerRuntimeIds: (number | null)[];
}

export type SignerDecisionKind = 'signed-agreed' | 'signed-mismatched' | 'objections' | 'no-response';

export interface ProposerSignerRoundResult {
  agreed: boolean;
  /** True when round-1 drafts' engine-recomputed hashes were already equal (no reconcile spawned). */
  hashMatch: boolean;
  /** D3's designateRound2Proposer output — always set, even on hashMatch (R3.9). */
  designatedSeatId: string;
  /** formatProposerLog's auditable line — always set (R3.9: call D3 designate + log the rule). */
  designationLog: string;
  /** True only when a proposer seat was actually fresh-spawned (hash mismatch). */
  reconcileSpawned: boolean;
  proposerBatchId: string | null;
  signerSeatId: string;
  signerBatchId: string | null;
  candidatePlanPath: string;
  candidateReqPath: string;
  /** Engine-recomputed candidate hash at the last point it was read — never a trusted claim. */
  candidatePlan: PlanRevision | null;
  signerDecision: SignerDecisionKind;
  objections?: string | null;
  blockedReasonKind?: 'candidate-not-committed' | 'signer-no-response';
  blockedReason?: string;
}

/** Inverse of R2's blindDraftSeatIds label scheme ('partner', 'partner-2', ...) → coPlannerSeats index. */
function seatConfigIndex(seatId: string): number {
  if (seatId === 'partner') return 0;
  const m = /^partner-(\d+)$/.exec(seatId);
  return m ? Number(m[1]) - 1 : -1;
}

export async function runProposerSignerRound(
  options: RunProposerSignerRoundOptions
): Promise<ProposerSignerRoundResult> {
  const {
    transport, briefWriter, writeBrief, registerWorkerRuntime,
    runDir, batchId, round, partner, effectiveProjectDir, cbPath,
    draftA, draftB, perRoundTimeoutMs, agreementFenceOffset,
    coPlannerSeats, partnerModel, partnerProvider,
    projectId, runId, strictReadAllow,
    candidatePlanPathOverride, candidateReqPathOverride,
    partnerHandles, partnerRuntimeIds,
  } = options;

  if (!draftA.plan || !draftB.plan) {
    throw new Error(
      'runProposerSignerRound: both round-1 drafts must have a committed plan revision ' +
        '(R3.10 precondition — call only after resolveRoundOneDraftPhase reports every seat committed)'
    );
  }

  const candidatePlanPathResolved = candidatePlanPathOverride || candidatePlanPath(runDir);
  const candidateReqPathResolved = candidateReqPathOverride || candidateReqPath(runDir);

  // R3.9: deterministic, artifact-reproducible designation — full sha256, never short12.
  const designatedSeatId = designateRound2Proposer({
    seatA: draftA.seatId, shaA: draftA.plan.sha256,
    seatB: draftB.seatId, shaB: draftB.plan.sha256,
  });
  const designationLog = formatProposerLog({
    seatA: draftA.seatId, shaA: draftA.plan.sha256,
    seatB: draftB.seatId, shaB: draftB.plan.sha256,
    proposer: designatedSeatId,
  });

  const designated = designatedSeatId === draftA.seatId ? draftA : draftB;
  const other = designatedSeatId === draftA.seatId ? draftB : draftA;
  const hashMatch = draftA.plan.sha256 === draftB.plan.sha256;

  const roundSuffix = `-r${round}`;
  const configuredSeats = Array.isArray(coPlannerSeats) ? coPlannerSeats : [];
  const seatSpecFor = (seatId: string) => configuredSeats[seatConfigIndex(seatId)];

  let reconcileSpawned = false;
  let proposerBatchId: string | null = null;

  if (hashMatch) {
    // R3.11 preferred path: no model reconcile call — engine copies the already-identical bytes.
    const planBytes = await fs.readFile(designated.planPath);
    atomicWriteFile(candidatePlanPathResolved, planBytes);
    if (designated.req) {
      try {
        const reqBytes = await fs.readFile(designated.reqPath);
        atomicWriteFile(candidateReqPathResolved, reqBytes);
      } catch {
        // Best-effort — requirements-candidate copy is not load-bearing for the plan-hash agreement
        // check this function resolves (R3.9-R3.11 concern plan.md agreement, not og-requirements.md).
      }
    }
  } else {
    reconcileSpawned = true;
    proposerBatchId = `${batchId}${roundSuffix}-proposer`;
    const proposerSpec = seatSpecFor(designatedSeatId);
    const proposerBrief = briefWriter.generatePanelBrief({
      purpose: 'plan-reconcile',
      role: partner,
      batchId: proposerBatchId,
      seat: designatedSeatId,
      lens: 'reconcile round-1 drafts into one candidate',
      runDir,
      projectDir: effectiveProjectDir,
      callbacksFile: cbPath,
      roundDraftPlanPaths: [draftA.planPath, draftB.planPath],
      roundDraftReqPaths: [draftA.reqPath, draftB.reqPath],
      candidatePlanPath: candidatePlanPathResolved,
      candidateReqPath: candidateReqPathResolved,
    });
    await writeBrief(`${partner}${roundSuffix}-proposer`, proposerBrief);
    const proposerSpawned = await transport.spawn({
      role: partner,
      brief: proposerBrief,
      runDir,
      batchId: proposerBatchId,
      model: proposerSpec?.model ?? partnerModel,
      provider: proposerSpec?.provider ?? partnerProvider,
      ...(proposerSpec?.effort ? { effort: proposerSpec.effort } : {}),
      attemptId: 0,
      projectDir: effectiveProjectDir,
      projectId,
      runId,
      ...(strictReadAllow ? { strictReadAllow } : {}),
    });
    partnerRuntimeIds.push(
      registerWorkerRuntime(
        partner, proposerBatchId, proposerSpawned.handle,
        proposerSpec?.provider ?? partnerProvider, proposerSpec?.model ?? partnerModel
      )
    );
    partnerHandles.push(proposerSpawned.handle);

    const commitResult = await waitForCandidateCommit(
      cbPath, partner,
      { batchId: proposerBatchId, brief: proposerBrief, handle: proposerSpawned.handle, seatId: designatedSeatId },
      candidatePlanPathResolved,
      perRoundTimeoutMs, agreementFenceOffset,
      transport as ReviewerWatchdogTransport
    );
    await transport.reap(
      proposerSpawned.handle,
      commitResult.ok ? 'proposer-candidate-committed-reaped' : 'proposer-candidate-not-committed-reaped'
    );

    if (!commitResult.ok) {
      return {
        agreed: false, hashMatch, designatedSeatId, designationLog, reconcileSpawned,
        proposerBatchId, signerSeatId: other.seatId, signerBatchId: null,
        candidatePlanPath: candidatePlanPathResolved, candidateReqPath: candidateReqPathResolved,
        candidatePlan: null,
        signerDecision: 'no-response',
        blockedReasonKind: 'candidate-not-committed',
        blockedReason:
          `CANDIDATE-NOT-COMMITTED (R3/R3.10): proposer seat ${designatedSeatId} (${proposerBatchId}) ` +
          `never published a candidate within ~${perRoundTimeoutMs}ms (${commitResult.reason}) — ` +
          `bounded exit, never a silent pass; the signer was never spawned.`,
      };
    }
  }

  const signerSeatId = other.seatId;
  const signerBatchId = `${batchId}${roundSuffix}-signer`;
  const signerSpec = seatSpecFor(signerSeatId);
  const signerBrief = briefWriter.generatePanelBrief({
    purpose: 'plan-signature',
    role: partner,
    batchId: signerBatchId,
    seat: signerSeatId,
    lens: 'sign or object to the reconciled candidate',
    runDir,
    projectDir: effectiveProjectDir,
    callbacksFile: cbPath,
    candidatePlanPath: candidatePlanPathResolved,
    candidateReqPath: candidateReqPathResolved,
  });
  await writeBrief(`${partner}${roundSuffix}-signer`, signerBrief);
  const signerSpawned = await transport.spawn({
    role: partner,
    brief: signerBrief,
    runDir,
    batchId: signerBatchId,
    model: signerSpec?.model ?? partnerModel,
    provider: signerSpec?.provider ?? partnerProvider,
    ...(signerSpec?.effort ? { effort: signerSpec.effort } : {}),
    attemptId: 0,
    projectDir: effectiveProjectDir,
    projectId,
    runId,
    ...(strictReadAllow ? { strictReadAllow } : {}),
  });
  partnerRuntimeIds.push(
    registerWorkerRuntime(
      partner, signerBatchId, signerSpawned.handle,
      signerSpec?.provider ?? partnerProvider, signerSpec?.model ?? partnerModel
    )
  );
  partnerHandles.push(signerSpawned.handle);

  const decision = await waitForSignerDecision(
    cbPath, partner,
    { batchId: signerBatchId, brief: signerBrief, handle: signerSpawned.handle, seatId: signerSeatId },
    perRoundTimeoutMs, agreementFenceOffset,
    transport as ReviewerWatchdogTransport
  );
  await transport.reap(
    signerSpawned.handle,
    decision.ok ? 'signer-decision-received-reaped' : 'signer-no-response-reaped'
  );

  if (!decision.ok) {
    return {
      agreed: false, hashMatch, designatedSeatId, designationLog, reconcileSpawned,
      proposerBatchId, signerSeatId, signerBatchId,
      candidatePlanPath: candidatePlanPathResolved, candidateReqPath: candidateReqPathResolved,
      candidatePlan: readPlanRevision(candidatePlanPathResolved),
      signerDecision: 'no-response',
      blockedReasonKind: 'signer-no-response',
      blockedReason:
        `SIGNER-NO-RESPONSE (R3/R3.11): signer seat ${signerSeatId} (${signerBatchId}) never posted a ` +
        `SIGNED/OBJECTIONS decision within ~${perRoundTimeoutMs}ms (${decision.reason}) — bounded exit, ` +
        `never a silent pass.`,
    };
  }

  if (decision.kind === 'objections') {
    return {
      agreed: false, hashMatch, designatedSeatId, designationLog, reconcileSpawned,
      proposerBatchId, signerSeatId, signerBatchId,
      candidatePlanPath: candidatePlanPathResolved, candidateReqPath: candidateReqPathResolved,
      candidatePlan: readPlanRevision(candidatePlanPathResolved),
      signerDecision: 'objections',
      objections: decision.note,
    };
  }

  // decision.kind === 'signed' — R3.11: recompute the candidate's CURRENT bytes now; a missing,
  // malformed, or stale-relative-to-current claim is never treated as agreement (fail-closed).
  const currentCandidate = readPlanRevision(candidatePlanPathResolved);
  const agreed =
    !!currentCandidate && !!decision.claimedShort12 && decision.claimedShort12 === currentCandidate.short12;

  return {
    agreed, hashMatch, designatedSeatId, designationLog, reconcileSpawned,
    proposerBatchId, signerSeatId, signerBatchId,
    candidatePlanPath: candidatePlanPathResolved, candidateReqPath: candidateReqPathResolved,
    candidatePlan: currentCandidate,
    signerDecision: agreed ? 'signed-agreed' : 'signed-mismatched',
  };
}

export async function runReviewRound(options: RunReviewRoundOptions): Promise<ReviewRoundResult> {
  const {
    transport, briefWriter, writeBrief, registerWorkerRuntime, waitForAgreement,
    runDir, batchId, brainRole, partner, effectiveProjectDir, cbPath, planMdPath,
    perRoundTimeoutMs, effectiveTimeoutMs, roundCap, reviewerFirstCallbackTimeoutMs, agreementFenceOffset, isFake,
    panelSize, coPlannerSeats, partnerModel, partnerProvider,
    planningBrainModel, planningBrainProvider,
    projectId, runId, strictReadAllow,
    publicationArtifacts, contextInputPaths, blindDraftRound1,
    partnerHandles, partnerRuntimeIds,
  } = options;

  // C4 (AC10/AC3): perRoundTimeoutMs is the primary field; effectiveTimeoutMs is consulted only as
  // the legacy alias (see the field doc comments above) — every real/test caller sets exactly one.
  const resolvedPerRoundTimeoutMs = (perRoundTimeoutMs ?? effectiveTimeoutMs)!;
  const resolvedRoundCap = Math.max(1, Math.trunc(roundCap ?? 1) || 1);

  // C3 re-scoped (R4.16): structural artifact-publication gate — before ANY partner brief write or
  // spawn. Round-2+ / post-draft: relevant seat-scoped draft or candidate via publicationArtifacts.
  // Round-1 (empty/omitted): runDir + optional context only — never canonical plan.md/og-requirements.md
  // (those stay absent until P2 promotion). Real-mode only; fixture harness (isFake) is exempt.
  if (!isFake) {
    const artifacts = Array.isArray(publicationArtifacts) ? publicationArtifacts : [];
    const publication =
      artifacts.length > 0
        ? await checkArtifactsPublished(artifacts)
        : await checkRound1PreSpawn(runDir, contextInputPaths);
    if (!publication.ready) {
      return {
        agreed: false,
        partnerBatchIds: [],
        blockedReasonKind: 'artifact-not-published',
        blockedReason: publication.reason,
        roundsAttempted: 0,
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
  const spawnRoundSeats = async (round: number): Promise<RoundOneDraftSeat[]> => {
    const roundSeats: RoundOneDraftSeat[] = [];
    const roundSuffix = round === 1 ? '' : `-r${round}`;
    // R2 (R2.5-R2.8): round 1 = dual blind draft, not review, when the caller opts in. Every OTHER
    // round (and round 1 itself when the flag is unset) keeps the legacy diff-review spawn below
    // byte-identical.
    const isBlindDraftRound = !!blindDraftRound1 && round === 1;
    // R2 (R2.6): every round-1 drafting seat's own id, precomputed BEFORE any seat spawns so
    // composeSeatDraftReadAllow can fence off every PEER seat's dir up front (D2) — not built
    // incrementally as seats spawn one at a time below.
    const blindDraftSeatIds = isBlindDraftRound
      ? Array.from({ length: partnerCount }, (_, i) => (i === 0 ? 'partner' : `partner-${i + 1}`))
      : [];
    for (let i = 0; i < partnerCount; i++) {
      const seatIndexSuffix = i === 0 ? '' : `-${i + 1}`;
      const partnerBatchId = `${batchId}${roundSuffix}-partner${seatIndexSuffix}`;
      const seatLabel = `partner${roundSuffix}${seatIndexSuffix}`;
      const writeBriefKey = `${partner}${roundSuffix}${seatIndexSuffix}`;
      const seatSpec = useConfiguredSeats ? configuredSeats[i] : null;
      const seatModel = seatSpec?.model ?? partnerModel;
      const seatProvider = seatSpec?.provider ?? partnerProvider;
      const seatEffort = seatSpec?.effort;

      let partnerBrief: string;
      let seatStrictReadAllow: string[] | undefined = strictReadAllow;
      if (isBlindDraftRound) {
        // R2 (R2.5/R2.8): independent purpose:'plan-draft' seat — seat-scoped write targets are
        // composed by generatePanelBrief itself (seat-draft-store, D1) since draftPlanPath/
        // draftReqPath are omitted here; never canonical plan.md/og-requirements.md.
        partnerBrief = briefWriter.generatePanelBrief({
          purpose: 'plan-draft',
          role: partner,
          batchId: partnerBatchId,
          seat: seatLabel,
          lens: 'whole-plan blind draft',
          runDir,
          projectDir: effectiveProjectDir,
          callbacksFile: cbPath,
        });
        // R2 (R2.6): OS-enforced blind isolation (D2) — this seat's allowlist covers ONLY its own
        // draft dir plus the same context inputs generatePanelBrief just pointed it at (north-star.md
        // / conversation-log.md / decisions/, matching that call's own root-relative defaults); every
        // peer seat's dir is refused fail-closed (SeatDraftIsolationError) BEFORE this seat ever
        // spawns — not merely "the brief omits it."
        seatStrictReadAllow = composeSeatDraftReadAllow({
          runDir,
          seatId: seatLabel,
          peerSeatIds: blindDraftSeatIds,
          contextInputs: [
            path.resolve(runDir, 'north-star.md'),
            path.resolve(runDir, 'conversation-log.md'),
            path.resolve(runDir, 'decisions'),
          ],
          deploymentAllow: strictReadAllow,
        });
      } else {
        // B1: ROUND temporarily uses diff-review (empty implementedDiff) so current verdict
        // text survives until R2/B3 swaps this path to plan-draft / plan-signature.
        partnerBrief = briefWriter.generatePanelBrief({
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
      }
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
        ...(seatStrictReadAllow ? { strictReadAllow: seatStrictReadAllow } : {}),
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
      roundSeats.push({ batchId: partnerBatchId, brief: partnerBrief, handle: partnerSpawned.handle, seatId: seatLabel });
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

    // R2 (R2.5-R2.7, R6.24): round 1 = dual blind draft, not review, when the caller opts in. A
    // 'plan-draft' seat never emits panel verdict grammar, so the legacy waitForAgreement below would
    // only ever time out against it — resolve the draft-commit wait instead and return immediately.
    // Round 2+ asymmetric proposer/signer dynamics (R3) are not this flag's concern.
    if (blindDraftRound1 && round === 1) {
      return resolveRoundOneDraftPhase(
        cbPath, partner, roundSeats, runDir, resolvedPerRoundTimeoutMs, agreementFenceOffset,
        transport as ReviewerWatchdogTransport, roundsAttempted
      );
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
