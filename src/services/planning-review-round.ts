import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type { ITransport } from './fake-transport.js';
import type { BriefWriterService } from './brief-writer-service.js';
import { validateExecutionPlan } from './execution-plan-parser.js';
import { readPlanRevision, type PlanRevision } from './plan-revision.js';
import { roleMatches } from './role-alias.js';
import { resolveAgentExecBaselineAllow } from '../security/landlock-sandbox.js';
import {
  composeSeatDraftReadAllow,
  publishDraft,
  type PublishedDraft,
  atomicWriteFile,
  candidatePlanPath,
  candidateReqPath,
  seatDraftDir,
} from './seat-draft-store.js';
import { designateRound2Proposer, formatProposerLog, rolesForRound, type RoundRoles } from './proposer-role.js';

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
    currentPlanPath?: string,
    /** P3 (R3.11/R3.14/R6.21): passed as `true` at this module's own call site below — production
     *  non-adaptive planning no longer requires brain PLAN-READY for agreement (P1 already retired
     *  plancore as a spawned/authoring seat, so nothing posts it). */
    signatureOnly?: boolean
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
 * - 'candidate-not-committed': R3 (R3.10) — the round-2 proposer never published a reconciled
 *   candidate within the round's timeout; the signer was never spawned.
 * - 'signer-no-response': R3 (R3.11) — the round-2 signer never posted SIGNED or OBJECTIONS.
 * - 'signer-objections': R3 (R3.11/R3.13) — the signer returned a bounded numbered objection list
 *   against the candidate. Not agreement, and distinct from silence: there IS a defect set to act on
 *   (R6 owns monotonicity across rounds; this is the per-round outcome when the cap is hit with
 *   objections still open, or when a single objections round ends the loop with no prior count).
 * - 'objection-not-monotone': R6 (R3.13) — round N+1's parsed defect count against the revised
 *   candidate was not strictly smaller than round N's. Typed BLOCK early without burning remaining
 *   round-cap budget (no further proposer/signer spawns).
 * - 'signature-mismatch': R3 (R3.11) — the signer posted SIGNED but its claimed `plan=<sha12>` did
 *   not equal the candidate's engine-recomputed CURRENT on-disk short12 (missing/malformed/stale
 *   claim). Fail-closed: never agreement.
 *
 * R7 (R3.15) does NOT introduce a new kind: cap exhaustion and monotone fail keep their existing
 * kinds (`signer-objections` / `round-cap-exhausted` / `objection-not-monotone` / …). The operator-
 * legible **final-positions diff** rides on `blockedReason` (and the durable
 * `nonConvergenceDiffPath` file), never as bare hash pairs alone.
 */
export type RoundBlockedReasonKind =
  | 'artifact-not-published'
  | 'reviewer-no-first-callback'
  | 'same-plan-broken'
  | 'round-cap-exhausted'
  | 'draft-not-submitted'
  | 'candidate-not-committed'
  | 'signer-no-response'
  | 'signer-objections'
  | 'objection-not-monotone'
  | 'signature-mismatch';

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
  /** R3 (R3.9-R3.11): set when this round loop actually ran the round-2 asymmetric proposer/signer
   *  exchange (see runProposerSignerRound) — the full typed outcome: D3 designation + rule log, which
   *  seat proposed vs signed, the shared candidate paths, the engine-recomputed candidate revision and
   *  the signer's decision. `agreed` above mirrors this result's `agreed` (signature on the candidate
   *  bytes is the only thing that agrees). Always undefined when the loop never reached round 2. */
  proposerSignerRound?: ProposerSignerRoundResult;
  /** R7 (R3.15): absolute path of the durable final-positions report written on cap exhaustion /
   *  monotone fail (and other terminal non-convergence of the proposer/signer exchange that has
   *  positions to compare). Undefined when no report was written. */
  nonConvergenceDiffPath?: string;
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
 * the round failed on a genuine same-plan-revision BROKEN vs. a round-cap/timeout with no BROKEN
 * evidence at all (C5/C4's existing bounded behaviour, left alone), this re-scans the SAME callbacks
 * window waitForAgreement just read, restricted to THIS round's own round-scoped partnerBatchIds (so
 * an earlier round's stale evidence can never be mistaken for this round's). Mirrors waitForAgreement's
 * own reversed/newest-line-wins-per-seat scan and B5's SHA binding (a BROKEN's plan= must equal the
 * CURRENT plan.md short12, not a superseded revision).
 *
 * R8 (R1.2/R3.10/R3.14/R6.20): this evidence no longer drives a mid-round plancore revise spawn — that
 * actuator is retired. It survives purely as C8's typed classification input: reconcile rounds (the
 * proposer/signer exchange) are the only revise path now, so a legacy-reviewer same-plan BROKEN just
 * distinguishes "there was concrete defect evidence against this exact plan revision" from a plain
 * timeout in the result the caller reads — never a trigger to spawn anything.
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
 * dedicated match instead of reusing parseRoundCallbackLine. This match is IDENTITY-ONLY: it says
 * "this line is a signature decision" and hands the rest of the line (group 3) to SIGNED_CLAIM_RE.
 * A malformed/missing claim still identifies the line, but yields no usable claim — R3.11 requires
 * that case to be treated as non-agreement (fail-closed), never ignored.
 */
const SIGNED_RE = /^\[(?:helm|projcore) callback\]\s+(\S+)\s+(\S+)\s+STATUS:\s+SIGNED\b(.*)$/;

/**
 * R5 (R6.21): the claim is usable ONLY when everything after `SIGNED` is EXACTLY the grammar's one
 * claim token — `plan=` + exactly 12 lowercase hex, anchored at BOTH ends. The end anchor is the
 * whole point: a bare `plan=([0-9a-f]{12})` with no trailing boundary captures the first 12 hex of
 * `plan=<current12>XYZ` (or of a longer hex run), so a malformed line whose claim merely STARTS with
 * the current short12 would agree — fail-OPEN, exactly what R6.21 forbids. Anything that is not the
 * bare token (fused prefix/suffix, a longer hex run, a second smuggled `plan=`, uppercase hex,
 * trailing prose) yields NO claim, which the caller resolves as non-agreement.
 */
const SIGNED_CLAIM_RE = /^\s+plan=([0-9a-f]{12})\s*$/;

/**
 * R3 (R3.11/R3.13): the plan-signature purpose's rejection grammar is
 * `STATUS: OBJECTIONS — n=<k>; 1. <defect> 2. <defect> ...`. The note (everything after the optional
 * separator) is captured verbatim; R6's `parseBoundedObjectionList` counts/validates the numbered
 * list for cross-round monotonicity.
 */
const OBJECTIONS_RE = /^\[(?:helm|projcore) callback\]\s+(\S+)\s+(\S+)\s+STATUS:\s+OBJECTIONS\b(?:\s*[\-—–:]?\s*(.*))?$/;

/** R6 (R3.13): hard upper bound on a single signer's numbered defect list. */
export const MAX_BOUNDED_OBJECTIONS = 20;

export type ParsedObjectionList =
  | { ok: true; declaredN: number; count: number; defects: string[] }
  | { ok: false; reason: string };

/**
 * R6 (R3.13): parse a signer's bounded numbered objection note
 * (`n=<k>; 1. <defect> 2. <defect> ...`). Fail-closed:
 * - missing/empty note, missing `n=<k>;` header, non-contiguous numbering, empty defect text,
 *   declared `n` outside 1..MAX_BOUNDED_OBJECTIONS, or declared `n` ≠ parsed item count →
 *   `{ ok: false }` — NEVER counted as zero objections (a zero would falsely look like progress).
 */
export function parseBoundedObjectionList(note: string | null | undefined): ParsedObjectionList {
  if (note == null || typeof note !== 'string' || note.trim() === '') {
    return { ok: false, reason: 'empty-objection-note' };
  }
  const trimmed = note.trim();
  const headerMatch = /^n\s*=\s*(\d+)\s*;\s*(.*)$/s.exec(trimmed);
  if (!headerMatch) {
    return { ok: false, reason: 'missing-n-header' };
  }
  const declaredN = Number(headerMatch[1]);
  if (!Number.isFinite(declaredN) || !Number.isInteger(declaredN) || declaredN < 1) {
    return { ok: false, reason: 'invalid-declared-n' };
  }
  if (declaredN > MAX_BOUNDED_OBJECTIONS) {
    return { ok: false, reason: `declared-n-exceeds-max-${MAX_BOUNDED_OBJECTIONS}` };
  }
  const body = headerMatch[2].trim();
  if (!body) {
    return { ok: false, reason: 'empty-defect-list' };
  }

  // Collect starts of "N. " items (number must be contiguous from 1).
  const itemStartRe = /(?:^|\s)(\d+)\.\s+/g;
  const starts: Array<{ n: number; textStart: number; matchStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = itemStartRe.exec(body)) !== null) {
    starts.push({
      n: Number(m[1]),
      textStart: m.index + m[0].length,
      matchStart: m.index,
    });
  }
  if (starts.length === 0) {
    return { ok: false, reason: 'no-numbered-items' };
  }

  const defects: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const expected = i + 1;
    if (starts[i].n !== expected) {
      return {
        ok: false,
        reason: `non-contiguous-numbering-expected-${expected}-got-${starts[i].n}`,
      };
    }
    const end = i + 1 < starts.length ? starts[i + 1].matchStart : body.length;
    const defectText = body.slice(starts[i].textStart, end).trim();
    if (!defectText) {
      return { ok: false, reason: `empty-defect-${expected}` };
    }
    defects.push(defectText);
  }

  if (defects.length !== declaredN) {
    return {
      ok: false,
      reason: `n-count-mismatch-declared-${declaredN}-parsed-${defects.length}`,
    };
  }

  return { ok: true, declaredN, count: defects.length, defects };
}

// ─── R7 (R3.15): non-convergence = visible final-positions diff (operator-legible, not bare hashes) ───

/** Cap on how many unified-diff lines ride inside blockedReason (full report is always on disk). */
export const NON_CONVERGENCE_DIFF_BLOCKED_REASON_MAX_LINES = 80;

/**
 * R7 (R3.15): durable final-positions report path under the run's planning-drafts dir.
 * Written on cap exhaustion / monotone fail (and other terminal non-convergence with positions).
 */
export function nonConvergenceDiffPath(runDir: string): string {
  return path.join(path.resolve(runDir), 'planning-drafts', 'non-convergence-diff.txt');
}

/**
 * R7 (R3.15): line-oriented unified-style diff (no external dep). Operator-legible comparison of
 * two text positions — never a bare hash pair. Identical inputs yield a short "identical" note.
 */
export function unifiedLineDiff(
  aLabel: string,
  aText: string,
  bLabel: string,
  bText: string,
): string {
  const aLines = aText.replace(/\r\n/g, '\n').split('\n');
  const bLines = bText.replace(/\r\n/g, '\n').split('\n');
  // Drop a single trailing empty element produced by a final newline so "a\n" vs "a\n" is identical.
  if (aLines.length > 0 && aLines[aLines.length - 1] === '') aLines.pop();
  if (bLines.length > 0 && bLines[bLines.length - 1] === '') bLines.pop();

  const header = `--- ${aLabel}\n+++ ${bLabel}`;
  if (aLines.length === bLines.length && aLines.every((l, i) => l === bLines[i])) {
    return `${header}\n(identical — ${aLines.length} line(s))`;
  }

  // Classic LCS DP for small planning docs (plans are bounded; O(nm) is fine).
  const n = aLines.length;
  const m = bLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        aLines[i] === bLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  type Op = { kind: ' ' | '-' | '+'; line: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      ops.push({ kind: ' ', line: aLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: '-', line: aLines[i] });
      i++;
    } else {
      ops.push({ kind: '+', line: bLines[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: '-', line: aLines[i++] });
  }
  while (j < m) {
    ops.push({ kind: '+', line: bLines[j++] });
  }

  // Emit a single hunk spanning the whole file (plans are short; multi-hunk is not load-bearing).
  const body = ops.map((op) => `${op.kind}${op.line}`).join('\n');
  const removed = ops.filter((o) => o.kind === '-').length;
  const added = ops.filter((o) => o.kind === '+').length;
  return (
    `${header}\n` +
    `@@ final-positions -${n} +${m} (removed ${removed}, added ${added}) @@\n` +
    body
  );
}

export interface NonConvergenceDiffInput {
  runDir: string;
  cause: string;
  candidatePath: string;
  candidateShort12: string | null;
  /** Signer's last authored plan position (round-1 draft path for that seat). */
  otherLabel: string;
  otherPath: string;
  otherShort12: string | null;
  /** Final signer objections note, if any. */
  objectionsNote?: string | null;
}

export interface NonConvergenceDiffResult {
  /** Full durable report body (written to disk). */
  fullText: string;
  /** Absolute path written (or attempted). */
  path: string;
  /** Truncated form safe to append inside blockedReason. */
  summaryForBlockedReason: string;
}

function readTextOrNull(filePath: string): string | null {
  try {
    return fsSync.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * R7 (R3.15): build + persist the final-positions report (candidate vs signer's last draft +
 * remaining objections). Never reports bare hash pairs alone — hashes are metadata alongside
 * the textual/hunk body. Failures to read a side are stated in prose, not silently omitted.
 */
export function buildAndPersistNonConvergenceDiff(
  input: NonConvergenceDiffInput,
): NonConvergenceDiffResult {
  const outPath = nonConvergenceDiffPath(input.runDir);
  const candidateText = readTextOrNull(input.candidatePath);
  const otherText = readTextOrNull(input.otherPath);

  const candidateLabel =
    `final-candidate path=${input.candidatePath} sha12=${input.candidateShort12 ?? 'unreadable'}`;
  const otherLabel =
    `${input.otherLabel} path=${input.otherPath} sha12=${input.otherShort12 ?? 'unreadable'}`;

  let positionsSection: string;
  if (candidateText == null && otherText == null) {
    positionsSection =
      `--- ${candidateLabel}\n+++ ${otherLabel}\n` +
      `(both sides unreadable on disk — cannot render a line diff; this is still a visible non-convergence ` +
      `exit, not a silent pass. Hashes alone are never treated as an adequate operator report.)`;
  } else if (candidateText == null) {
    positionsSection =
      `--- ${candidateLabel}\n+++ ${otherLabel}\n` +
      `(final candidate unreadable on disk)\n` +
      `--- other side (full text) ---\n${otherText}`;
  } else if (otherText == null) {
    positionsSection =
      `--- ${candidateLabel}\n+++ ${otherLabel}\n` +
      `(other side unreadable on disk)\n` +
      `--- final candidate (full text) ---\n${candidateText}`;
  } else {
    positionsSection = unifiedLineDiff(candidateLabel, candidateText, otherLabel, otherText);
  }

  const objectionsSection =
    input.objectionsNote != null && String(input.objectionsNote).trim() !== ''
      ? `## Signer final objections\n${String(input.objectionsNote).trim()}`
      : `## Signer final objections\n(none captured)`;

  const fullText =
    `# Non-convergence final-positions report (R3.15 / R7)\n` +
    `cause: ${input.cause}\n` +
    `\n` +
    `## Textual diff — final candidate vs signer's last draft position\n` +
    `${positionsSection}\n` +
    `\n` +
    `${objectionsSection}\n`;

  try {
    fsSync.mkdirSync(path.dirname(outPath), { recursive: true });
    fsSync.writeFileSync(outPath, fullText, 'utf8');
  } catch {
    // Best-effort durable write — blockedReason still carries the summary even if disk fails.
  }

  const lines = fullText.split('\n');
  let summaryBody: string;
  if (lines.length <= NON_CONVERGENCE_DIFF_BLOCKED_REASON_MAX_LINES) {
    summaryBody = fullText.trimEnd();
  } else {
    summaryBody =
      lines.slice(0, NON_CONVERGENCE_DIFF_BLOCKED_REASON_MAX_LINES).join('\n') +
      `\n… [truncated; full report at ${outPath}]`;
  }

  const summaryForBlockedReason =
    `\n\nNON-CONVERGENCE-DIFF (R3.15): operator-legible final positions ` +
    `(not bare hash pairs) — full report: ${outPath}\n` +
    summaryBody;

  return { fullText, path: outPath, summaryForBlockedReason };
}

/**
 * R7 (R3.15): resolve the signer's last authored plan path from round-1 draft publications.
 * The signer never authors a competing document after round 1 (R3.10) — their last draft IS
 * their final position to compare against the reconciled candidate.
 */
function signerLastDraftFromRoundOne(
  drafts: PublishedDraft[] | undefined,
  signerSeatId: string,
): PublishedDraft | null {
  if (!drafts || drafts.length === 0) return null;
  return drafts.find((d) => d.seatId === signerSeatId) ?? null;
}

/**
 * R7 (R3.15): attach final-positions diff to a non-agreeing ReviewRoundResult that already has
 * a proposer/signer outcome with positions worth comparing. Mutates nothing; returns the fields
 * to spread onto the result.
 */
function nonConvergenceFieldsForPsResult(
  runDir: string,
  psResult: ProposerSignerRoundResult,
  roundOneDrafts: PublishedDraft[] | undefined,
  cause: string,
): Pick<ReviewRoundResult, 'nonConvergenceDiffPath'> & { blockedReasonSuffix: string } {
  const signerDraft = signerLastDraftFromRoundOne(roundOneDrafts, psResult.signerSeatId);
  const otherPath = signerDraft?.planPath ?? path.join(runDir, `(missing-draft-${psResult.signerSeatId})`);
  const built = buildAndPersistNonConvergenceDiff({
    runDir,
    cause,
    candidatePath: psResult.candidatePlanPath,
    candidateShort12: psResult.candidatePlan?.short12 ?? null,
    otherLabel: `signer-last-draft seat=${psResult.signerSeatId}`,
    otherPath,
    otherShort12: signerDraft?.plan?.short12 ?? null,
    objectionsNote: psResult.objections ?? null,
  });
  return {
    nonConvergenceDiffPath: built.path,
    blockedReasonSuffix: built.summaryForBlockedReason,
  };
}

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
 * R5 (R3.11/R3.14/R6.21): waits for the fresh-spawned signer seat to post its decision — SIGNED or a
 * bounded OBJECTIONS list — and, for a SIGNED line, resolves the agreement question in this SAME call.
 * This is the one place `agreed:true` is ever decided (R3.14): the signer's claimed `plan=<sha12>` is
 * checked against `readPlanRevision(candidatePlanFilePath)` recomputed HERE, at check time, never a
 * cached/trusted claim (B5's exact mechanism, re-pointed). A missing, malformed, or stale-relative-to-
 * current-candidate claim resolves `kind:'signed-mismatched'`, never agreement (R6.21, fail-closed).
 * No line in this grammar means "ready to use" — brain `PLAN-READY` is not part of this path at all.
 * Unlike draft/candidate commits there is no on-disk fallback: a signature decision is
 * callback-grammar-only, so a seat that never posts either line always resolves to a bounded timeout,
 * never a silent pass.
 */
export async function waitForCandidateSignature(
  cbPath: string,
  partnerRole: string,
  seat: RoundOneDraftSeat,
  candidatePlanFilePath: string,
  timeoutMs: number,
  sinceOffset: number,
  watchdogTransport: ReviewerWatchdogTransport
): Promise<
  | { ok: true; kind: 'signed-agreed'; candidatePlan: PlanRevision; claimedShort12: string }
  | { ok: true; kind: 'signed-mismatched'; candidatePlan: PlanRevision | null; claimedShort12: string | null }
  | { ok: true; kind: 'objections'; candidatePlan: PlanRevision | null; note: string | null }
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
        if (signedMatch) {
          const claimedShort12 = SIGNED_CLAIM_RE.exec(signedMatch[3] ?? '')?.[1] ?? null;
          const candidatePlan = readPlanRevision(candidatePlanFilePath);
          const agreed = !!candidatePlan && !!claimedShort12 && claimedShort12 === candidatePlan.short12;
          return agreed
            ? { ok: true, kind: 'signed-agreed', candidatePlan: candidatePlan!, claimedShort12: claimedShort12! }
            : { ok: true, kind: 'signed-mismatched', candidatePlan, claimedShort12 };
        }
        const objectionsMatch = OBJECTIONS_RE.exec(line);
        if (objectionsMatch) {
          return {
            ok: true, kind: 'objections',
            candidatePlan: readPlanRevision(candidatePlanFilePath),
            note: objectionsMatch[3] ?? null,
          };
        }
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
 * R4 (R3.12): a caller resolving round 3+ of the SAME exchange passes `rolesOverride` (the round
 * loop's own `rolesForRound` output) so the seat that actually proposes/signs alternates instead of
 * this function re-designating the same seat every round off the unchanged round-1 drafts; the base
 * D3 designation (`designatedSeatId`/`designationLog`) still always reflects round 2's rule, as R3
 * shipped it — `roundProposerSeatId`/`signerSeatId` are the per-round roles the caller should act on.
 * Objection-driven re-reconciliation (R6) is not this function's scope — every call still resolves
 * exactly one round's proposer/signer exchange.
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

  /** R4 (R3.12): who actually proposes/signs THIS round. Omitted (round 2's natural call) → D3's
   *  designateRound2Proposer decides, as R3 shipped it. Round 3+ callers pass the round loop's own
   *  `rolesForRound` output so the pen alternates instead of D3 re-designating the same seat every
   *  round off the same unchanged round-1 drafts. Never changes `hashMatch` / the base D3 designation
   *  audit trail (`designatedSeatId`/`designationLog` stay the round-2 designation, always) — only
   *  which seat is fresh-spawned as proposer vs signer for this specific round. */
  rolesOverride?: RoundRoles;

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
  /** D3's designateRound2Proposer output — always set, even on hashMatch (R3.9). This is the BASE
   *  round-2 designation and never changes across rounds; it is the audit anchor `rolesForRound`
   *  alternates from (R4/R3.12) — read `roundProposerSeatId` for who actually held the pen THIS
   *  round. */
  designatedSeatId: string;
  /** formatProposerLog's auditable line — always set (R3.9: call D3 designate + log the rule). Always
   *  describes the base round-2 designation above, even on a later, alternated round. */
  designationLog: string;
  /** R4 (R3.12): the seat that actually proposed THIS round — equals `designatedSeatId` on round 2 (no
   *  override) and alternates on round 3+ per the caller's `rolesOverride` (rolesForRound). */
  roundProposerSeatId: string;
  /** True only when a proposer seat was actually fresh-spawned (hash mismatch). */
  reconcileSpawned: boolean;
  proposerBatchId: string | null;
  /** R4 (R3.12): the seat that actually signed THIS round — alternates alongside roundProposerSeatId. */
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
    draftA, draftB, rolesOverride, perRoundTimeoutMs, agreementFenceOffset,
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

  // R4 (R3.12): rolesOverride (round 3+, from the round loop's rolesForRound) picks who ACTUALLY
  // proposes/signs this round; round 2's natural call (no override) leaves it as D3's designation.
  // Never re-derives from the drafts themselves — those are round-1's unchanged bytes, so re-running
  // designateRound2Proposer every round would just re-pick the same seat forever (R3.12's failure mode).
  const roundProposerSeatId = rolesOverride?.proposer ?? designatedSeatId;
  const designated = roundProposerSeatId === draftA.seatId ? draftA : draftB;
  const other = roundProposerSeatId === draftA.seatId ? draftB : draftA;
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
    const proposerSpec = seatSpecFor(roundProposerSeatId);
    const proposerBrief = briefWriter.generatePanelBrief({
      purpose: 'plan-reconcile',
      role: partner,
      batchId: proposerBatchId,
      seat: roundProposerSeatId,
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
      { batchId: proposerBatchId, brief: proposerBrief, handle: proposerSpawned.handle, seatId: roundProposerSeatId },
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
        agreed: false, hashMatch, designatedSeatId, designationLog, roundProposerSeatId, reconcileSpawned,
        proposerBatchId, signerSeatId: other.seatId, signerBatchId: null,
        candidatePlanPath: candidatePlanPathResolved, candidateReqPath: candidateReqPathResolved,
        candidatePlan: null,
        signerDecision: 'no-response',
        blockedReasonKind: 'candidate-not-committed',
        blockedReason:
          `CANDIDATE-NOT-COMMITTED (R3/R3.10): proposer seat ${roundProposerSeatId} (${proposerBatchId}) ` +
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

  // R5 (R3.11/R3.14/R6.21): waitForCandidateSignature is the ONE place agreed:true is ever decided —
  // it recomputes the candidate's current on-disk short12 itself and compares it to the signer's
  // claim before returning, so this call site never re-derives (or re-trusts) that comparison.
  const decision = await waitForCandidateSignature(
    cbPath, partner,
    { batchId: signerBatchId, brief: signerBrief, handle: signerSpawned.handle, seatId: signerSeatId },
    candidatePlanPathResolved,
    perRoundTimeoutMs, agreementFenceOffset,
    transport as ReviewerWatchdogTransport
  );
  await transport.reap(
    signerSpawned.handle,
    decision.ok ? 'signer-decision-received-reaped' : 'signer-no-response-reaped'
  );

  if (!decision.ok) {
    return {
      agreed: false, hashMatch, designatedSeatId, designationLog, roundProposerSeatId, reconcileSpawned,
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
      agreed: false, hashMatch, designatedSeatId, designationLog, roundProposerSeatId, reconcileSpawned,
      proposerBatchId, signerSeatId, signerBatchId,
      candidatePlanPath: candidatePlanPathResolved, candidateReqPath: candidateReqPathResolved,
      candidatePlan: decision.candidatePlan,
      signerDecision: 'objections',
      objections: decision.note,
    };
  }

  const agreed = decision.kind === 'signed-agreed';
  return {
    agreed, hashMatch, designatedSeatId, designationLog, roundProposerSeatId, reconcileSpawned,
    proposerBatchId, signerSeatId, signerBatchId,
    candidatePlanPath: candidatePlanPathResolved, candidateReqPath: candidateReqPathResolved,
    candidatePlan: decision.candidatePlan,
    signerDecision: decision.kind,
  };
}

/**
 * R3 (R3.9-R3.11): projects one round-2 proposer/signer outcome onto the round loop's own
 * ReviewRoundResult contract, so a caller that never knew about drafts/candidates still reads the
 * same `{ agreed, partnerBatchIds, blockedReason, blockedReasonKind, roundsAttempted }` shape.
 *
 * Every non-agreeing outcome gets a TYPED cause (never a bare boolean false): the proposer never
 * committed, the signer never answered, the signer objected, or the signer's claimed sha did not match
 * the candidate's engine-recomputed current bytes. The full typed result rides along on
 * `proposerSignerRound` for consumers that need the candidate paths / designation log (P2's promotion).
 *
 * R7 (R3.15): on terminal non-convergence that has positions to compare (objections / signature-
 * mismatch, and silence only when a candidate already sits on disk), `blockedReason` is extended
 * with an operator-legible final-positions diff (candidate vs signer's last draft + remaining
 * objections) — never bare hash pairs alone — and a durable report is written under
 * `planning-drafts/non-convergence-diff.txt`.
 */
function toReviewRoundResult(
  psResult: ProposerSignerRoundResult,
  roundOneBatchIds: string[],
  roundOneDraftPublications: PublishedDraft[],
  roundsAttempted: number,
  runDir: string,
): ReviewRoundResult {
  const partnerBatchIds = [
    ...roundOneBatchIds,
    ...(psResult.proposerBatchId ? [psResult.proposerBatchId] : []),
    ...(psResult.signerBatchId ? [psResult.signerBatchId] : []),
  ];
  const base = {
    partnerBatchIds,
    roundsAttempted,
    roundOneDraftPublications,
    proposerSignerRound: psResult,
  };

  if (psResult.agreed) return { agreed: true, ...base };

  // R7 (R3.15): attach final-positions diff whenever a candidate exists on disk (or we still have
  // draft positions to show against an unreadable candidate). candidate-not-committed has no
  // candidate yet — still report drafts vs empty candidate side so the operator sees something
  // other than two hex strings.
  const attachDiff =
    psResult.signerDecision === 'objections' ||
    psResult.signerDecision === 'signed-mismatched' ||
    psResult.blockedReasonKind === 'signer-no-response' ||
    psResult.blockedReasonKind === 'candidate-not-committed' ||
    !psResult.agreed;

  const attach = (kind: RoundBlockedReasonKind, reason: string): ReviewRoundResult => {
    if (!attachDiff) {
      return { agreed: false, ...base, blockedReasonKind: kind, blockedReason: reason };
    }
    const nc = nonConvergenceFieldsForPsResult(runDir, psResult, roundOneDraftPublications, kind);
    return {
      agreed: false,
      ...base,
      blockedReasonKind: kind,
      blockedReason: `${reason}${nc.blockedReasonSuffix}`,
      nonConvergenceDiffPath: nc.nonConvergenceDiffPath,
    };
  };

  // Bounded, already-typed blocks from the exchange itself (proposer/signer silence) pass through with
  // their own message; the two decision-shaped refusals are classified here.
  if (psResult.blockedReasonKind) {
    return attach(psResult.blockedReasonKind, psResult.blockedReason ?? psResult.blockedReasonKind);
  }

  if (psResult.signerDecision === 'objections') {
    return attach(
      'signer-objections',
      `SIGNER-OBJECTIONS (R3/R3.11): signer seat ${psResult.signerSeatId} (${psResult.signerBatchId}) ` +
        `refused to sign candidate ${psResult.candidatePlan?.short12 ?? 'unreadable'} ` +
        `(${psResult.candidatePlanPath}) with a bounded objection list — never agreement: ` +
        `${psResult.objections ?? '(no note captured)'}`,
    );
  }

  return attach(
    'signature-mismatch',
    `SIGNATURE-MISMATCH (R3/R3.11): signer seat ${psResult.signerSeatId} (${psResult.signerBatchId}) ` +
      `posted SIGNED, but its claimed plan sha did not equal the candidate's engine-recomputed current ` +
      `short12 ${psResult.candidatePlan?.short12 ?? '(candidate unreadable)'} (${psResult.candidatePlanPath}) — ` +
      `a missing, malformed, or stale claim is fail-closed, never a silent pass.`,
  );
}

export async function runReviewRound(options: RunReviewRoundOptions): Promise<ReviewRoundResult> {
  const {
    transport, briefWriter, writeBrief, registerWorkerRuntime, waitForAgreement,
    runDir, batchId, brainRole, partner, effectiveProjectDir, cbPath, planMdPath,
    perRoundTimeoutMs, effectiveTimeoutMs, roundCap, reviewerFirstCallbackTimeoutMs, agreementFenceOffset, isFake,
    panelSize, coPlannerSeats, partnerModel, partnerProvider,
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
        // R2.6 fix (found live, cycle 13 run 35, 2026-08-03 07:40 PHT): the Landlock sandbox
        // realpath()-resolves every strictReadAllow entry BEFORE the seat process starts, so this
        // seat's own draft dir must exist on disk before spawn — atomicWriteFile's mkdir (below, at
        // actual draft-publish time) runs far too late. Without this the sandbox fails closed with
        // "ro-allowlist entry does not resolve ... No such file or directory" and the seat never
        // launches at all.
        fsSync.mkdirSync(seatDraftDir(runDir, seatLabel), { recursive: true });
        seatStrictReadAllow = composeSeatDraftReadAllow({
          runDir,
          seatId: seatLabel,
          peerSeatIds: blindDraftSeatIds,
          contextInputs: [
            path.resolve(runDir, 'north-star.md'),
            path.resolve(runDir, 'conversation-log.md'),
            path.resolve(runDir, 'decisions'),
            // gpt-5.6-sol review (2026-08-03 08:2x PHT): the dispatch payload literally says "Read
            // <briefPath> and follow its instructions" (briefPath lives under runDir/prompts/), and
            // the brief separately tells the seat to grep callbacks.md for Helm's ACK — the strict
            // write exception on runDir does not imply read. Both read-only; never all of runDir
            // (the isolation guard correctly refuses that, since it would expose peer drafts).
            path.resolve(runDir, 'prompts'),
            path.resolve(cbPath),
          ],
          // R2.6 fix (found live, cycle 13 run 36, 2026-08-03 07:45 PHT): strict mode grants READ+EXEC
          // on ONLY the enumerated entries, nothing implicit — without the CLI's own binary + shared
          // libraries also allowlisted, execvp() fails closed the instant the sandbox restricts itself
          // ("Permission denied"), before the seat ever runs. `strictReadAllow` (this round's OUTER
          // opt-in B-ISO1 param) is empty for a normal deployment, since blind-draft is the first
          // caller that forces strict mode unconditionally — merge in the real exec baseline too.
          // Scoped to THIS seat's own provider (sol review) — a claude seat never needs read on
          // ~/.codex/auth.json or vice versa.
          deploymentAllow: [...resolveAgentExecBaselineAllow(seatProvider), ...(strictReadAllow ?? [])],
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
  // R3 (R3.9-R3.11): the round-1 blind drafts this loop already collected, carried into round 2 so the
  // asymmetric proposer/signer exchange below runs on the ENGINE'S OWN recomputed publications (D1) —
  // never a re-read of what a seat claimed. Undefined until round 1's draft phase resolves cleanly.
  let roundOneDrafts: PublishedDraft[] | undefined;
  // R4 (R3.12): round 2's own D3 designation, captured once so round 3+ can alternate FROM it
  // (rolesForRound) instead of re-designating off the same unchanged round-1 drafts every round.
  let round2ProposerSeatId: string | undefined;
  // R6 (R3.13): last proposer/signer round's parsed defect count (or 'unparseable'). Undefined until
  // the first objections outcome; used to enforce strict shrink on the next objections round.
  let previousObjectionCount: number | 'unparseable' | undefined;
  for (let round = 1; round <= resolvedRoundCap; round++) {
    roundsAttempted = round;
    if (round > 1) {
      for (const handle of priorRoundHandles) {
        await transport.reap(handle, 'round-non-agreement-reaped');
      }
      priorRoundHandles = [];
    }

    // R3 (R3.9-R3.11): round 2 of a blind-draft run is the ASYMMETRIC proposer/signer exchange — NOT
    // another reviewer round and NOT a second dual-authoring round. This is the R2→R3 handoff inside
    // the engine's own round loop (the only path a real planning run takes through this module), so
    // the resolver is reached by production control flow rather than by a standalone caller: round 1
    // published both drafts above, this loop reaped those seats just now (C5: a round can never
    // observe a still-alive prior-round seat), and runProposerSignerRound fresh-spawns exactly one
    // proposer (plan-reconcile, BOTH drafts) and one signer (plan-signature, ONLY the candidate).
    // R4 (R3.12): a non-agreeing round 2 does not return here anymore — with budget left, the loop
    // continues into round 3 (and beyond) of the SAME exchange, alternating the pen via rolesForRound
    // instead of D3 re-designating the same seat off the same unchanged round-1 drafts every round.
    // Round 2 itself is unchanged: no rolesOverride, D3's natural designation.
    // R6 (R3.13): when the signer objects, parse the bounded defect list and store its count; if this
    // is not the first objections round and the new count is not STRICTLY smaller than the previous,
    // typed-BLOCK early (`objection-not-monotone`) without spending remaining round-cap budget.
    if (roundOneDrafts) {
      const [draftA, draftB] = roundOneDrafts;
      const rolesOverride =
        round === 2 ? undefined : rolesForRound(round, round2ProposerSeatId!, draftA.seatId, draftB.seatId);
      const psResult = await runProposerSignerRound({
        transport, briefWriter, writeBrief, registerWorkerRuntime,
        runDir, batchId, round, partner, effectiveProjectDir, cbPath,
        draftA, draftB, rolesOverride,
        perRoundTimeoutMs: resolvedPerRoundTimeoutMs,
        agreementFenceOffset,
        coPlannerSeats, partnerModel, partnerProvider,
        projectId, runId, strictReadAllow,
        partnerHandles, partnerRuntimeIds,
      });
      if (round === 2) round2ProposerSeatId = psResult.designatedSeatId;
      if (psResult.agreed) {
        return toReviewRoundResult(psResult, partnerBatchIds, roundOneDrafts, round, runDir);
      }

      if (psResult.signerDecision === 'objections') {
        const parsed = parseBoundedObjectionList(psResult.objections);
        // Fail-closed: unparseable list is NEVER counted as zero (that would look like progress).
        const currentCount: number | 'unparseable' = parsed.ok ? parsed.count : 'unparseable';

        if (previousObjectionCount !== undefined) {
          const priorLabel =
            previousObjectionCount === 'unparseable' ? 'unparseable' : String(previousObjectionCount);
          const currentLabel =
            currentCount === 'unparseable' ? 'unparseable' : String(currentCount);
          const strictlySmaller =
            typeof previousObjectionCount === 'number' &&
            typeof currentCount === 'number' &&
            currentCount < previousObjectionCount;
          if (!strictlySmaller) {
            const partnerBatchIdsWithPs = [
              ...partnerBatchIds,
              ...(psResult.proposerBatchId ? [psResult.proposerBatchId] : []),
              ...(psResult.signerBatchId ? [psResult.signerBatchId] : []),
            ];
            const unspent = Math.max(0, resolvedRoundCap - round);
            // R7 (R3.15): monotone fail is a visible non-convergence with final-positions diff, not bare hashes.
            const nc = nonConvergenceFieldsForPsResult(
              runDir, psResult, roundOneDrafts, 'objection-not-monotone',
            );
            return {
              agreed: false,
              partnerBatchIds: partnerBatchIdsWithPs,
              roundsAttempted: round,
              roundOneDraftPublications: roundOneDrafts,
              proposerSignerRound: psResult,
              blockedReasonKind: 'objection-not-monotone',
              blockedReason:
                `OBJECTION-NOT-MONOTONE (R3.13/R6): round ${round} defect count (${currentLabel}) ` +
                `is not strictly smaller than prior objections count (${priorLabel}) against the ` +
                `revised candidate — typed BLOCK early; ${unspent} remaining round-cap slot(s) unspent ` +
                `(cap ${resolvedRoundCap}), never burned chasing a non-shrinking objection set.` +
                nc.blockedReasonSuffix,
              nonConvergenceDiffPath: nc.nonConvergenceDiffPath,
            };
          }
        }
        previousObjectionCount = currentCount;
      }

      if (round >= resolvedRoundCap) {
        return toReviewRoundResult(psResult, partnerBatchIds, roundOneDrafts, round, runDir);
      }
      // R4: budget remains — round (round + 1) alternates the pen over the SAME two round-1 drafts.
      continue;
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
    // only ever time out against it — resolve the draft-commit wait instead.
    if (blindDraftRound1 && round === 1) {
      const draftPhase = await resolveRoundOneDraftPhase(
        cbPath, partner, roundSeats, runDir, resolvedPerRoundTimeoutMs, agreementFenceOffset,
        transport as ReviewerWatchdogTransport, roundsAttempted
      );
      // R3 (R3.9-R3.11): hand the drafts to the NEXT loop iteration's asymmetric proposer/signer
      // exchange (top of the loop). Two conditions keep round 1 a terminal round exactly as R2 shipped
      // it, so no existing caller changes shape:
      // - a typed draft-phase block (draft-not-submitted) is final: there is nothing to reconcile;
      // - a caller with only ONE round of budget (the default roundCap) never starts a round-2
      //   exchange it cannot finish — it returns the publications, as R2's own callers/fixtures do.
      // The exchange itself is the two-seat asymmetric one (D3 designates between exactly two round-1
      // drafts); a panel configured with any other seat count still ends at the draft phase here
      // rather than silently picking two of N.
      if (!draftPhase.roundOneDraftPublications || draftPhase.roundOneDraftPublications.length !== 2) {
        return draftPhase;
      }
      if (round >= resolvedRoundCap) return draftPhase;
      roundOneDrafts = draftPhase.roundOneDraftPublications;
      partnerBatchIds = draftPhase.partnerBatchIds;
      continue;
    }

    // P3 (R3.11/R3.14/R6.21): signatureOnly:true unconditionally — P1 already retired plancore as a
    // spawned/authoring seat, so no production run (real OR fixture-driven) ever posts brain
    // PLAN-READY any more; requiring it here would deadlock every non-adaptive run. Unanimous CLEAN
    // bound to the CURRENT plan.md revision (B5, untouched above) is the only thing that still gates
    // agreement — a missing/malformed/stale plan= is still fail-closed, never agreement (R6.21).
    agreed = await waitForAgreement(
      cbPath, batchId, partner, brainRole, resolvedPerRoundTimeoutMs, agreementFenceOffset,
      partnerBatchIds, planMdPath, isFake ? undefined : planMdPath, true
    );
    if (agreed) break;

    // C8 (AC11/AC23): classify THIS round's non-agreement against the CURRENT plan.md bytes exactly
    // once, EVERY non-agreeing round. R8 (R1.2/R3.10/R3.14/R6.20) retired the mid-round plancore
    // revise actuator this scan used to gate: reconcile rounds (the proposer/signer exchange) are the
    // only revise path now, and no agent — including the retired plancore label — is ever spawned from
    // this classification. The scan survives purely as diagnostic input to the post-loop typed
    // `blockedReasonKind` below, so a same-current-plan BROKEN is still reported distinctly from a
    // plain round-cap/timeout with no BROKEN evidence at all (C5/C4's existing bounded behaviour,
    // otherwise unchanged: fresh reviewer seats simply respawn on the SAME plan next round).
    lastSamePlanBrokenEvidence = [];
    const currentRevision = readPlanRevision(planMdPath);
    if (currentRevision) {
      lastSamePlanBrokenEvidence = await collectSameShaBrokenEvidence(
        cbPath, agreementFenceOffset, partner, partnerBatchIds, currentRevision.short12
      );
    }
  }

  if (!agreed) {
    // C8 (AC11/AC23): a same-current-plan BROKEN on the round that actually ended the loop is a
    // distinct, typed cause — never the anonymous boolean-false ROUND-CAP-EXHAUSTED below. R8 retired
    // the mid-round revise actuator this evidence used to gate; it is now purely diagnostic — the
    // round-cap simply exhausted with no reconciliation attempted from this evidence.
    if (lastSamePlanBrokenEvidence.length > 0) {
      const defectBatchIds = lastSamePlanBrokenEvidence.map((d) => d.batchId).join(', ');
      return {
        agreed: false,
        partnerBatchIds,
        roundsAttempted,
        blockedReasonKind: 'same-plan-broken',
        blockedReason:
          `SAME-PLAN-BROKEN-NO-ROUNDS-LEFT (C8/AC11/AC23): round ${roundsAttempted} reviewer seat(s) ` +
          `[${defectBatchIds}] returned BROKEN against the CURRENT plan.md revision, and the round cap ` +
          `(${resolvedRoundCap}) exhausted with no further rounds to reconcile it — a same-current-plan ` +
          `BROKEN, not a generic non-convergence timeout.`,
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
