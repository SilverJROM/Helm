/**
 * R6.24 planning regression-mode registry — the machine-readable place a slice
 * REGISTERS the failure mode it now guards against.
 *
 * Registration is spread across the slices that produce the proof (R2/R4/R6/R8/P2);
 * the enforced sweep (X1, `planning-regression-index.test.ts`) only READS this
 * registry and fails the suite on any mode that does not resolve to an ACTIVE
 * behavioral spec. A prose comment inside a spec is not a registration — an entry
 * here, pointing at a real on-disk spec whose named proving tests exist and are not
 * skipped, is.
 *
 * `resolveRegressionMode` is the resolution primitive X1 enforces with: it reads the
 * registered spec off disk and reports (a) whether it exists, (b) any skip/todo/only
 * marker that would silently disarm it, (c) any declared proving test that is missing.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Only `active` is registrable — a skeleton/pending entry is exactly what R6.24 forbids. */
export type RegressionModeState = 'active';

export interface RegressionModeEntry {
  /** Sweep-mode name as written in the plan row (e.g. `blind-draft-isolation`). */
  readonly mode: string;
  /** Slice that owns the registration (e.g. `R2`). */
  readonly slice: string;
  /** Requirement ids the mode guards. */
  readonly requirements: readonly string[];
  /** Repo-root-relative path to the active behavioral spec. */
  readonly spec: string;
  /** Exact `it(...)` titles inside `spec` that constitute the proof. */
  readonly provingTests: readonly string[];
  readonly state: RegressionModeState;
  readonly note: string;
}

export interface RegressionModeResolution {
  readonly mode: string;
  /** Absolute path the registered spec resolved to. */
  readonly specPath: string;
  readonly exists: boolean;
  /** Skip/todo/only markers found in the spec — any entry disarms the mode. */
  readonly markers: readonly string[];
  /** Declared proving tests not found in the spec. */
  readonly missingProvingTests: readonly string[];
}

/** Typed registration failure — refuse a malformed/duplicate entry at load, not at sweep time. */
export class RegressionModeRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegressionModeRegistrationError';
  }
}

const REGISTRY = new Map<string, RegressionModeEntry>();

/** Any of these in a registered spec means the "proof" can pass while running nothing. */
const DISARM_MARKER = /\b(?:it|test|describe)\.(?:skip|todo|only|skipIf|runIf)\s*\(/g;

/**
 * Register a regression mode. Called at module load by the owning slice — duplicate
 * or malformed entries throw rather than degrade into an unenforced skeleton.
 */
export function registerRegressionMode(entry: RegressionModeEntry): void {
  const { mode, slice, requirements, spec, provingTests, state, note } = entry;
  if (typeof mode !== 'string' || mode.trim() === '') {
    throw new RegressionModeRegistrationError('mode must be a non-empty string');
  }
  if (REGISTRY.has(mode)) {
    throw new RegressionModeRegistrationError(`regression mode "${mode}" is already registered`);
  }
  if (typeof slice !== 'string' || slice.trim() === '') {
    throw new RegressionModeRegistrationError(`mode "${mode}" must name its owning slice`);
  }
  if (!Array.isArray(requirements) || requirements.length === 0) {
    throw new RegressionModeRegistrationError(`mode "${mode}" must list >=1 requirement id`);
  }
  if (typeof spec !== 'string' || !spec.endsWith('.test.ts')) {
    throw new RegressionModeRegistrationError(
      `mode "${mode}" must point at a .test.ts spec (got ${JSON.stringify(spec)})`,
    );
  }
  if (path.isAbsolute(spec)) {
    throw new RegressionModeRegistrationError(`mode "${mode}" spec must be repo-root-relative`);
  }
  if (!Array.isArray(provingTests) || provingTests.length === 0) {
    throw new RegressionModeRegistrationError(`mode "${mode}" must name >=1 proving test title`);
  }
  if (state !== 'active') {
    throw new RegressionModeRegistrationError(
      `mode "${mode}" must be active — a skipped/pending skeleton is not a registration (R6.24)`,
    );
  }
  if (typeof note !== 'string' || note.trim() === '') {
    throw new RegressionModeRegistrationError(`mode "${mode}" must carry a non-empty note`);
  }
  REGISTRY.set(mode, entry);
}

export function getRegressionMode(mode: string): RegressionModeEntry | undefined {
  return REGISTRY.get(mode);
}

/** All registered modes, in registration order. */
export function listRegressionModes(): RegressionModeEntry[] {
  return [...REGISTRY.values()];
}

/**
 * Resolve a registered mode against the filesystem: does its spec exist, is it free of
 * disarming markers, and does every declared proving test still live in it? This is the
 * check X1's sweep enforces; a renamed or gutted proof surfaces here as a failure.
 */
export function resolveRegressionMode(
  mode: string,
  repoRoot: string = process.cwd(),
): RegressionModeResolution {
  const entry = REGISTRY.get(mode);
  if (!entry) {
    throw new RegressionModeRegistrationError(`regression mode "${mode}" is not registered`);
  }
  const specPath = path.resolve(repoRoot, entry.spec);
  let source: string;
  try {
    source = fs.readFileSync(specPath, 'utf8');
  } catch {
    return {
      mode,
      specPath,
      exists: false,
      markers: [],
      missingProvingTests: [...entry.provingTests],
    };
  }
  const markers = [...source.matchAll(DISARM_MARKER)].map((m) => m[0].replace(/\s*\($/, ''));
  const missingProvingTests = entry.provingTests.filter((title) => !source.includes(title));
  return { mode, specPath, exists: true, markers, missingProvingTests };
}

// ---------------------------------------------------------------------------
// Registrations (spread — each slice registers the mode it proves).
// ---------------------------------------------------------------------------

/**
 * R2 — round 1 is a dual BLIND draft: both co-planner seats draft to seat-scoped
 * paths under an OS-fenced per-seat read allowlist, neither can read the peer's
 * draft, nothing canonical is written, and the engine recomputes each draft hash
 * from disk instead of trusting the seat's callback claim.
 */
registerRegressionMode({
  mode: 'blind-draft-isolation',
  slice: 'R2',
  requirements: ['R2.5', 'R2.6', 'R2.7', 'R6.20', 'R6.24'],
  spec: 'src/services/planning-review-round-blind-draft.test.ts',
  provingTests: [
    'spawns both configured co-planner seats with purpose plan-draft, to seat-scoped paths, never canonical',
    'fences each seat strictReadAllow to its own draft dir + context inputs, excluding the peer draft dir (R2.6)',
    'refuses fail-closed BEFORE any spawn when a deployment allow entry would widen into planning-drafts/ (R2.6)',
    'accepts a genuine DRAFT-SUBMITTED callback and recomputes the hash from disk, ignoring a false claim (R2.7/D1)',
  ],
  state: 'active',
  note: 'Round-1 co-planners draft blind: per-seat strictReadAllow excludes peer draft dirs, widening into the shared planning-drafts/ root refuses before spawn, no canonical write, engine rehashes from disk.',
});

/**
 * R4 — round 3+ of a divergent proposer/signer exchange ALTERNATES the pen: the round loop's own
 * `rolesForRound` (D3) picks who proposes/signs each round, anchored on round 2's D3 designation,
 * instead of re-designating off the same unchanged round-1 drafts and letting one seat hold the pen
 * every round.
 */
registerRegressionMode({
  mode: 'proposer-signer-alternation',
  slice: 'R4',
  requirements: ['R3.12', 'R6.20', 'R6.24'],
  spec: 'src/services/planning-review-round-alternation.test.ts',
  provingTests: [
    'round-2 proposer = designate(round1); round-3 proposer = the other seat; round-4 = round-2s proposer again',
    'spawns the rolesOverride.proposer as proposer even though D3 would naturally designate the other seat',
  ],
  state: 'active',
  note: 'Round loop wires rolesForRound into every round 3+ of a proposer/signer exchange: round 2 = D3 designation, round 3 swaps to the other seat, round 4 swaps back — never one seat every round.',
});

/**
 * R6 — objection monotonicity: a signer's rejection carries a bounded numbered defect list;
 * round N+1's parsed count against the revised candidate must be strictly smaller than round N's,
 * or the run typed-BLOCKs early (`objection-not-monotone`) without burning remaining round-cap budget.
 */
registerRegressionMode({
  mode: 'objection-monotonicity',
  slice: 'R6',
  requirements: ['R3.13', 'R6.24'],
  spec: 'src/services/planning-review-round-objection-mono.test.ts',
  provingTests: [
    'blocks early with objection-not-monotone when round N+1 defect count is not strictly smaller',
    'does not spawn further proposer/signer rounds after a non-monotone objections outcome',
    'allows a strictly shrinking defect count to continue (and eventually agree)',
    'parseBoundedObjectionList: declared n must equal parsed item count (never counts mismatch as zero)',
  ],
  state: 'active',
  note: 'Signer OBJECTIONS notes are parsed as bounded numbered lists; a non-shrinking count across rounds typed-BLOCKs objection-not-monotone early without burning remaining cap.',
});

/**
 * R8 — proposer/signer role integrity: the engine retired its mid-round plancore whole-plan revise
 * actuator (generatePlanRoundReviseBrief + its spawn block). Reconcile rounds — the proposer/signer
 * exchange — are the ONLY revise path now; plancore never receives a model call from this module again,
 * regardless of same-current-plan BROKEN evidence or remaining round-cap budget.
 */
registerRegressionMode({
  mode: 'proposer-signer-role-integrity',
  slice: 'R8',
  requirements: ['R1.2', 'R3.10', 'R3.14', 'R6.20'],
  spec: 'src/services/planning-review-round-no-plancore-revise.test.ts',
  provingTests: [
    'planning-review-round.ts source has no generatePlanRoundReviseBrief method definition',
    'same-SHA BROKEN evidence with round budget remaining spawns no plancore/-revise seat',
    'role-integrity: brainRole (plancore) is never the role of any seat spawned across a same-plan-broken run',
  ],
  state: 'active',
  note: 'The mid-round plancore revise actuator is deleted outright: same-current-plan BROKEN evidence never spawns plancore/-revise anymore — only the proposer/signer co-planner exchange reconciles a divergent plan.',
});

/**
 * P2 — atomic candidate promotion: the engine, upon observing ROUND's agreed:true WITH a signed
 * candidate (proposerSignerRound.candidatePlanPath/candidateReqPath — R3.11/R3.14's ONE agreement
 * decision point), atomically copies those exact candidate bytes to canonical plan.md/
 * og-requirements.md under canonicalArtifactRoot — the engine's only path to writing those files.
 * B6 non-agreement discipline still holds for this path (agreed:false never promotes, even with a
 * candidate on disk), and the retired PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN failure is renamed to
 * the candidate/signature-shaped NO-AGREED-PLAN-CANDIDATE (R1.4).
 */
registerRegressionMode({
  mode: 'atomic-candidate-promotion',
  slice: 'P2',
  requirements: ['R1.4', 'R2.5', 'R3.14', 'R6.24'],
  spec: 'src/services/planning-phase-candidate-promote.test.ts',
  provingTests: [
    'copies the exact signed candidate bytes to canonical plan.md/og-requirements.md under canonicalArtifactRoot and ingests them, without polling',
    'overwrites a stale pre-existing canonical plan.md/og-requirements.md — the engine is the only writer of those paths (R2.5)',
    'B6 discipline holds for the new promotion path too: agreed:false never writes canonicalArtifactRoot, even with a candidate ready',
    'planning-phase-service.ts no longer contains PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN and throws NO-AGREED-PLAN-CANDIDATE instead',
  ],
  state: 'active',
  note: 'Promotion is a plain engine-side byte copy gated purely on ROUND returning agreed:true with a signed candidate — no agent status token is ever treated as "ready to use," and the renamed NO-AGREED-PLAN-CANDIDATE failure replaces the retired plancore-authorship-named one.',
});
