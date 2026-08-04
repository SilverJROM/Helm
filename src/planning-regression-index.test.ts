/**
 * R6.24 planning regression sweep — not a skip skeleton.
 *
 * Every historical AC23 failure mode and every effort-new mode must resolve to at
 * least one **active** behavioral proof (a real on-disk `.test.ts` whose named
 * proving `it(...)` titles exist and are not disarmed by skip/todo/only). An
 * unresolved or skipped entry fails this suite.
 *
 * Spread registration of the five new modes is owned by R2/R4/R6/R8/P2 in
 * `services/planning-regression-modes.ts`. This file only ENFORCES:
 *   - historical seven → local index → disk resolution (import-path proofs)
 *   - registered five  → listRegressionModes / resolveRegressionMode
 *
 * Execution of the proofs themselves is the job of those named specs; the sweep
 * fails closed if any proof is missing, gutted, or disarmed so the suite cannot
 * stay green while a mode silently drops out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  listRegressionModes,
  resolveRegressionMode,
  type RegressionModeEntry,
} from './services/planning-regression-modes.js';

const REPO_ROOT = process.cwd();

/** Only active is allowed — a pending/skipped skeleton is the R6.24 defect. */
type SweepModeState = 'active';

interface SweepModeEntry {
  readonly mode: string;
  /** Owning slice or historical batch that landed the proof. */
  readonly slice: string;
  readonly requirements: readonly string[];
  /** Repo-root-relative path to the active behavioral spec. */
  readonly spec: string;
  /** Exact `it(...)` titles inside `spec` that constitute the proof. */
  readonly provingTests: readonly string[];
  readonly state: SweepModeState;
  readonly note: string;
}

interface SweepModeResolution {
  readonly mode: string;
  readonly specPath: string;
  readonly exists: boolean;
  readonly markers: readonly string[];
  readonly missingProvingTests: readonly string[];
}

/** Any of these in a proof means the "proof" can pass while running nothing. */
const DISARM_MARKER = /\b(?:it|test|describe)\.(?:skip|todo|only|skipIf|runIf)\s*\(/g;

/**
 * Historical seven (AC23), re-pointed where the plancore-orchestrator redesign
 * changed the mechanism. Names keep the AC23 surface for anti-recurrence; notes
 * record the re-point.
 */
const HISTORICAL_MODES: readonly SweepModeEntry[] = [
  {
    mode: 'convene-before-artifacts',
    slice: 'A0',
    requirements: ['R6.24'],
    spec: 'src/a0-convene-race-regression.test.ts',
    provingTests: [
      'BROKEN is non-dispositive while plan.md is absent — keeps waiting until outer timeout',
      'BROKEN is dispositive once plan.md exists and is non-empty — fail-fast restored',
      'source pin: planMdPathForRaceGuard appears exactly 3 times (8024452 survival)',
    ],
    state: 'active',
    note: 'A0 pin of 8024452: BROKEN is non-dispositive while plan.md is absent/empty and dispositive once non-empty; race-guard symbol survives at exactly 3 source sites.',
  },
  {
    mode: 'BROKEN->revise->CLEAN',
    slice: 'R3',
    requirements: ['R3.9', 'R3.10', 'R3.11', 'R6.20', 'R6.24'],
    spec: 'src/services/planning-review-round-proposer-signer.test.ts',
    provingTests: [
      'carries round-1 divergence into a real round-2 proposer/signer exchange and agrees on the signature (R3.9-R3.11)',
      'surfaces a signer objection list as a typed non-agreement, never as agreement',
    ],
    state: 'active',
    note: 'Re-pointed: historical BROKEN→revise→CLEAN is now BROKEN→reconcile→SIGNED — dual-draft divergence drives a proposer/signer exchange that agrees only on a matching SIGNED claim, never via a mid-round plancore revise.',
  },
  {
    mode: 'partner1 CLEAN + partner2 BROKEN',
    slice: 'R3',
    requirements: ['R3.10', 'R3.11', 'R6.24'],
    spec: 'src/services/planning-review-round-proposer-signer.test.ts',
    provingTests: [
      'R3.10: the proposer brief carries BOTH round-1 draft paths; the signer brief carries ONLY the candidate',
      'R3.11: a mismatched (stale) SIGNED claim is never treated as agreement',
    ],
    state: 'active',
    note: 'Re-pointed: partner1 CLEAN + partner2 BROKEN → dual-signer impossibility / dual-draft mismatch. Only one seat signs; the signer never dual-authors; a mismatched claim is never agreement.',
  },
  {
    mode: 'partner-2 silent until timeout',
    slice: 'C7',
    requirements: ['R6.20', 'R6.24'],
    spec: 'src/services/planning-review-round-c7.test.ts',
    provingTests: [
      'a reviewer with no first callback returns the typed blocked result and never calls waitForAgreement',
      'a session-gone reviewer returns the typed blocked result naming the stuck batch id and never calls waitForAgreement',
    ],
    state: 'active',
    note: 'C7 reviewer first-callback watchdog: a mute partner/reviewer seat returns a typed blocked result naming the stuck batch id; waitForAgreement is never called for that round.',
  },
  {
    mode: 'legacy path refuses when north-star exists',
    slice: 'S11',
    requirements: ['R6.24'],
    spec: 'src/s11-owner-bridge.test.ts',
    provingTests: [
      'test3: unauthenticated / callback-token / bodyless starter / changed manifest refused',
    ],
    state: 'active',
    note: 'When Discovery docs / a pending handoff exist, bodyless legacy Start Planning is refused (HANDOFF_CONFIRM_REQUIRED 409) — confirmed handoff only; no rediscovery interview on existing north-star.',
  },
  {
    mode: 'ibrain row count unchanged on planning block',
    slice: 'A1',
    requirements: ['R6.24'],
    spec: 'src/services/run-orchestrator-planning-terminal-a1.test.ts',
    provingTests: [
      'a planning-only failure (execution never started) does not call assertImplementationBrainComplete and synthesizes no ibrain row',
      'a planning-only detached failure (still starting, zero run_tasks) does not call assertImplementationBrainComplete and synthesizes no ibrain row',
    ],
    state: 'active',
    note: 'A1: a planning-only terminal/block never synthesizes a worker_runtimes ibrain row — row count stays zero when execution never started.',
  },
  {
    mode: 'stale-CLEAN rejected across revisions',
    slice: 'B5/R5',
    requirements: ['R6.21', 'R6.24'],
    spec: 'src/services/planning-phase-current-plan-sha-b5.test.ts',
    provingTests: [
      'seat A CLEAN on R1, plan.md changes to R2, seat B CLEAN on R2 — gate refuses (A never reviewed R2)',
      'CLEAN with missing or nonmatching plan= does not count as agreement',
    ],
    state: 'active',
    note: 'B5 current-plan SHA binding: a CLEAN bound to a superseded plan revision is never agreement. Companion R5/R6.21 SIGNED-stale proof lives under the same anti-stale requirement set via signature-gate.',
  },
];

/**
 * Effort-new mode names the registry must carry (registered by R2/R4/R6/R8/P2).
 * Plan row shorthand "alternation" maps to registry key `proposer-signer-alternation`.
 */
const REQUIRED_NEW_MODES: readonly string[] = [
  'blind-draft-isolation',
  'proposer-signer-role-integrity',
  'proposer-signer-alternation',
  'objection-monotonicity',
  'atomic-candidate-promotion',
];

/** Resolve a local (historical) sweep entry against the filesystem — same contract as resolveRegressionMode. */
function resolveSweepMode(entry: SweepModeEntry, repoRoot: string = REPO_ROOT): SweepModeResolution {
  const specPath = path.resolve(repoRoot, entry.spec);
  let source: string;
  try {
    source = fs.readFileSync(specPath, 'utf8');
  } catch {
    return {
      mode: entry.mode,
      specPath,
      exists: false,
      markers: [],
      missingProvingTests: [...entry.provingTests],
    };
  }
  const markers = [...source.matchAll(DISARM_MARKER)].map((m) => m[0].replace(/\s*\($/, ''));
  const missingProvingTests = entry.provingTests.filter((title) => !source.includes(title));
  return { mode: entry.mode, specPath, exists: true, markers, missingProvingTests };
}

/** Fail-closed assertion shared by historical and registered resolutions. */
function expectActiveResolution(
  mode: string,
  resolution: { exists: boolean; markers: readonly string[]; missingProvingTests: readonly string[] },
): void {
  expect(resolution.exists, `"${mode}" proof spec must exist on disk`).toBe(true);
  expect(
    resolution.markers,
    `"${mode}" proof must not be disarmed by skip/todo/only`,
  ).toEqual([]);
  expect(
    resolution.missingProvingTests,
    `"${mode}" must retain every named proving test`,
  ).toEqual([]);
}

describe('R6.24 planning-regression sweep — historical modes (active, not skeleton)', () => {
  it('indexes all seven historical AC23 failure modes as active proofs', () => {
    expect(HISTORICAL_MODES).toHaveLength(7);
    const modes = HISTORICAL_MODES.map((e) => e.mode);
    expect(new Set(modes).size).toBe(7);
    expect(modes).toEqual([
      'convene-before-artifacts',
      'BROKEN->revise->CLEAN',
      'partner1 CLEAN + partner2 BROKEN',
      'partner-2 silent until timeout',
      'legacy path refuses when north-star exists',
      'ibrain row count unchanged on planning block',
      'stale-CLEAN rejected across revisions',
    ]);
  });

  it('carries no skeleton entries — every historical mode is active with a non-empty note', () => {
    for (const entry of HISTORICAL_MODES) {
      expect(entry.state).toBe('active');
      expect(entry.note.length).toBeGreaterThan(0);
      expect(entry.note).not.toMatch(/TODO/i);
      expect(entry.provingTests.length).toBeGreaterThan(0);
      expect(entry.spec.endsWith('.test.ts')).toBe(true);
    }
  });

  for (const entry of HISTORICAL_MODES) {
    it(`"${entry.mode}" (${entry.slice}) resolves to an active, non-disarmed behavioral spec`, () => {
      const resolution = resolveSweepMode(entry);
      expectActiveResolution(entry.mode, resolution);
    });
  }

  it('stale-CLEAN/SIGNED companion: signature-gate still fails closed on a well-formed but STALE sha (R6.21)', () => {
    // The historical mode name is still "stale-CLEAN…"; the redesign extends the same
    // anti-stale contract to SIGNED claims. Pin the companion proof so a gutted R5
    // signature gate cannot leave the sweep half-green.
    const companion: SweepModeEntry = {
      mode: 'stale-SIGNED rejected across revisions',
      slice: 'R5',
      requirements: ['R6.21', 'R6.24'],
      spec: 'src/services/planning-review-round-signature-gate.test.ts',
      provingTests: [
        "R6.21: SIGNED with a well-formed but STALE sha (candidate rewritten since) is fail-closed",
        "R6.21: SIGNED with NO plan= field at all is fail-closed, never agreement",
      ],
      state: 'active',
      note: 'R5/R6.21 companion to B5 stale-CLEAN: a SIGNED claim bound to a superseded candidate is never agreement.',
    };
    expectActiveResolution(companion.mode, resolveSweepMode(companion));
  });
});

/**
 * R6.24 registered modes. Registration is spread across the producing slices
 * (R2/R4/R6/R8/P2) in `services/planning-regression-modes.ts`; the index only
 * READS that registry so a newly guarded failure mode lands here without a hand
 * edit. Fails on a mode whose spec is missing, disarmed, or whose named proofs
 * have been gutted.
 */
describe('R6.24 planning-regression sweep — registered new modes', () => {
  const registered = listRegressionModes();

  it('includes every effort-new mode required by the X1/R6.24 row', () => {
    const modes = registered.map((entry) => entry.mode);
    for (const required of REQUIRED_NEW_MODES) {
      expect(modes, `registered modes must include "${required}"`).toContain(required);
    }
  });

  it('carries no skeleton entries — every registered mode is active', () => {
    expect(registered.length).toBeGreaterThan(0);
    for (const entry of registered) {
      expect(entry.state).toBe('active');
      expect(entry.requirements.length).toBeGreaterThan(0);
      expect(entry.provingTests.length).toBeGreaterThan(0);
      expect(entry.note.length).toBeGreaterThan(0);
    }
  });

  for (const entry of registered) {
    it(`"${entry.mode}" (${entry.slice}) resolves to an active, non-disarmed behavioral spec`, () => {
      const resolution = resolveRegressionMode(entry.mode, REPO_ROOT);
      expectActiveResolution(entry.mode, resolution);
    });
  }

  it('blind-draft-isolation remains owned by R2 (registration ownership pin)', () => {
    const entry = registered.find((e) => e.mode === 'blind-draft-isolation');
    expect(entry).toBeDefined();
    expect(entry!.slice).toBe('R2');
  });
});

describe('R6.24 planning-regression sweep — suite integrity', () => {
  it('this index file itself has zero skip/todo/only disarm markers', () => {
    const selfPath = path.join(REPO_ROOT, 'src/planning-regression-index.test.ts');
    const source = fs.readFileSync(selfPath, 'utf8');
    const markers = [...source.matchAll(DISARM_MARKER)].map((m) => m[0].replace(/\s*\($/, ''));
    expect(markers).toEqual([]);
  });

  it('twelve named modes are covered (7 historical + 5 registered new)', () => {
    const historical = new Set(HISTORICAL_MODES.map((e) => e.mode));
    const registered = new Set(listRegressionModes().map((e) => e.mode));
    expect(historical.size).toBe(7);
    for (const m of REQUIRED_NEW_MODES) {
      expect(registered.has(m)).toBe(true);
    }
    // No accidental double-registration of a historical name into the product registry.
    for (const m of historical) {
      expect(registered.has(m)).toBe(false);
    }
  });

  it('every historical + registered proof path is importable (module resolves on disk)', () => {
    const paths = new Set<string>([
      ...HISTORICAL_MODES.map((e) => e.spec),
      ...listRegressionModes().map((e: RegressionModeEntry) => e.spec),
      'src/services/planning-review-round-signature-gate.test.ts',
    ]);
    for (const rel of paths) {
      const abs = path.resolve(REPO_ROOT, rel);
      expect(fs.existsSync(abs), `importable proof path missing: ${rel}`).toBe(true);
      // Specs are plain TS modules under src/ — a missing/empty file is not importable.
      expect(fs.statSync(abs).size).toBeGreaterThan(0);
    }
  });
});
