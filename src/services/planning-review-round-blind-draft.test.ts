process.env.USE_FAKE_TMUX = '1';

/**
 * R2 gate — round 1 = dual blind draft, not review (R2.5-R2.7, R6.20, R6.24).
 * Scope: planning-review-round.ts only (C2 introduced this module; C3-C8 hardened the legacy
 * reviewer-round loop; R2 adds an additive, opt-in `blindDraftRound1` path that replaces round 1's
 * spawn+wait for callers that set it, leaving every existing C2-C8 fixture byte-identical).
 *
 * Registers regression mode `blind-draft-isolation` (R6.24) in the planning regression-mode registry
 * (`planning-regression-modes.ts`), pointing at this file as the active behavioral proof; X1 later
 * enforces the registry from the planning-regression-index sweep.
 *
 * Proves:
 * - round 1 spawns BOTH configured co-planner seats with purpose:'plan-draft' to seat-scoped draft
 *   paths (never canonical plan.md / og-requirements.md) — R2.5, R2.8;
 * - each seat's transport.spawn strictReadAllow is fenced to its OWN draft dir + context inputs and
 *   explicitly excludes every PEER seat's draft dir (D2, wired) — R2.6;
 * - a deployment-level strictReadAllow that would widen into the shared planning-drafts/ root is
 *   refused fail-closed (SeatDraftIsolationError) BEFORE any seat is spawned — R2.6;
 * - a genuine DRAFT-SUBMITTED callback is accepted, and the returned publication is the engine's own
 *   recomputed on-disk hash — a false `plan=<sha12>` claim in the callback is ignored (R2.7, D1);
 * - a seat that posts ANY callback (not a clean DRAFT-SUBMITTED parse) plus a committed draft file on
 *   disk is also accepted (the "or first-callback + file commit" fallback) — R2.5/R2.7;
 * - a seat that never posts anything and never commits a file times out into a typed
 *   `draft-not-submitted` block, and the legacy `waitForAgreement` is never invoked;
 * - the legacy first-callback watchdog (C7) still runs over draft seats when force-enabled, proving
 *   the extension is structural, not reimplemented;
 * - `agreed` stays false even when both drafts commit cleanly — a published draft is not agreement;
 * - every existing legacy caller (omits `blindDraftRound1`) is completely unaffected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { BriefWriterService } from './brief-writer-service.js';
import { runReviewRound, RunReviewRoundOptions } from './planning-review-round.js';
import {
  draftPlanPath,
  seatDraftDir,
  atomicWriteFile,
  SeatDraftIsolationError,
} from './seat-draft-store.js';
import {
  getRegressionMode,
  listRegressionModes,
  registerRegressionMode,
  resolveRegressionMode,
  RegressionModeRegistrationError,
} from './planning-regression-modes.js';

describe('runReviewRound blind draft round 1 (R2, R2.5-R2.7/R6.20/R6.24)', () => {
  let runDir: string;
  let cbPath: string;
  let transport: FakeTransport;
  let briefWriter: BriefWriterService;
  let briefs: Map<string, string>;
  let partnerHandles: string[];
  let partnerRuntimeIds: (number | null)[];
  let waitForAgreementCalls: number;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-r2-blind-draft-'));
    cbPath = path.join(runDir, 'callbacks.md');
    await fs.writeFile(cbPath, '', 'utf8');
    transport = new FakeTransport();
    briefWriter = new BriefWriterService();
    briefs = new Map();
    partnerHandles = [];
    partnerRuntimeIds = [];
    waitForAgreementCalls = 0;
  });

  afterEach(async () => {
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  function baseOptions(overrides: Partial<RunReviewRoundOptions> = {}): RunReviewRoundOptions {
    return {
      transport,
      briefWriter,
      writeBrief: async (role, content) => { briefs.set(role, content); },
      registerWorkerRuntime: () => partnerRuntimeIds.length + 1,
      waitForAgreement: async () => { waitForAgreementCalls += 1; return true; },
      runDir,
      batchId: 'batch-R2',
      brainRole: 'plancore',
      partner: 'planner',
      effectiveProjectDir: '/home/agjrom/websites/Helm',
      cbPath,
      planMdPath: path.join(runDir, 'plan.md'),
      perRoundTimeoutMs: 1000,
      agreementFenceOffset: 0,
      isFake: true,
      coPlannerSeats: [
        { slot: 0, provider: 'anthropic', model: 'claude-sonnet' },
        { slot: 1, provider: 'grok', model: 'grok-4.5' },
      ],
      partnerHandles,
      partnerRuntimeIds,
      ...overrides,
    };
  }

  it('spawns both configured co-planner seats with purpose plan-draft, to seat-scoped paths, never canonical', async () => {
    // Spawn-time wiring is what this test checks — no draft ever commits, so keep the (irrelevant)
    // wait bounded and short rather than burning the full default timeout.
    const result = await runReviewRound(baseOptions({ blindDraftRound1: true, perRoundTimeoutMs: 50 }));

    // Both seats spawned once each; fresh seats, no reuse (R6.20 — spawnRoundSeats unchanged shape).
    expect(transport.spawnCalls).toHaveLength(2);
    expect(transport.spawnCalls.map((c) => c.batchId)).toEqual(['batch-R2-partner', 'batch-R2-partner-2']);
    expect(new Set(partnerHandles).size).toBe(2);

    const briefA = briefs.get('planner')!;
    const briefB = briefs.get('planner-2')!;
    expect(briefA).toMatch(/Panel purpose: plan-draft/);
    expect(briefB).toMatch(/Panel purpose: plan-draft/);
    expect(briefA).toMatch(/seat-scoped paths/i);
    // Never the canonical paths, never the legacy diff-review verdict grammar.
    expect(briefA).not.toMatch(/CONVENE-RACE/);
    expect(briefA).toMatch(/Do \*\*not\*\* emit a panel verdict/);
    expect(briefA).toContain(seatDraftDir(runDir, 'partner'));
    expect(briefB).toContain(seatDraftDir(runDir, 'partner-2'));

    // R2.5: no write to canonical plan.md / og-requirements.md from this module.
    await expect(fs.access(path.join(runDir, 'plan.md'))).rejects.toThrow();
    await expect(fs.access(path.join(runDir, 'og-requirements.md'))).rejects.toThrow();

    // Draft-phase-only: never agreement.
    expect(result.agreed).toBe(false);
    expect(waitForAgreementCalls).toBe(0);
  });

  it('fences each seat strictReadAllow to its own draft dir + context inputs, excluding the peer draft dir (R2.6)', async () => {
    // Spawn-time wiring is what this test checks — keep the (irrelevant) wait bounded and short.
    await runReviewRound(baseOptions({ blindDraftRound1: true, perRoundTimeoutMs: 50 }));

    const seatAAllow = transport.spawnCalls[0].strictReadAllow!;
    const seatBAllow = transport.spawnCalls[1].strictReadAllow!;

    expect(seatAAllow).toContain(seatDraftDir(runDir, 'partner'));
    expect(seatAAllow).not.toContain(seatDraftDir(runDir, 'partner-2'));
    expect(seatBAllow).toContain(seatDraftDir(runDir, 'partner-2'));
    expect(seatBAllow).not.toContain(seatDraftDir(runDir, 'partner'));

    // Context inputs granted to both (read-only, shared).
    for (const allow of [seatAAllow, seatBAllow]) {
      expect(allow).toContain(path.resolve(runDir, 'north-star.md'));
      expect(allow).toContain(path.resolve(runDir, 'conversation-log.md'));
      expect(allow).toContain(path.resolve(runDir, 'decisions'));
    }
  });

  it('refuses fail-closed BEFORE any spawn when a deployment allow entry would widen into planning-drafts/ (R2.6)', async () => {
    await expect(
      runReviewRound(baseOptions({
        blindDraftRound1: true,
        strictReadAllow: [path.join(runDir, 'planning-drafts')],
      }))
    ).rejects.toThrow(SeatDraftIsolationError);

    expect(transport.spawnCalls).toHaveLength(0);
  });

  it('accepts a genuine DRAFT-SUBMITTED callback and recomputes the hash from disk, ignoring a false claim (R2.7/D1)', async () => {
    const realBytes = '# Draft plan A\n```json\n[]\n```\n';
    atomicWriteFile(draftPlanPath(runDir, 'partner'), realBytes);
    atomicWriteFile(draftPlanPath(runDir, 'partner-2'), '# Draft plan B\n```json\n[]\n```\n');
    const falseSha = 'aaaaaaaaaaaa'; // 12 hex chars — plausible-shaped but deliberately WRONG.
    await fs.appendFile(
      cbPath,
      `[helm callback] planner batch-R2-partner STATUS: DRAFT-SUBMITTED plan=${falseSha}\n` +
      `[helm callback] planner batch-R2-partner-2 STATUS: DRAFT-SUBMITTED plan=${falseSha}\n`,
      'utf8'
    );

    const result = await runReviewRound(baseOptions({ blindDraftRound1: true }));

    expect(result.agreed).toBe(false);
    expect(result.blockedReasonKind).toBeUndefined();
    expect(result.roundOneDraftPublications).toHaveLength(2);
    const seatAPub = result.roundOneDraftPublications!.find((p) => p.seatId === 'partner')!;
    expect(seatAPub.plan!.short12).not.toBe(falseSha);
    const { planRevision } = await import('./plan-revision.js');
    expect(seatAPub.plan!.short12).toBe(planRevision(realBytes).short12);
  });

  it('accepts a seat via the "first-callback + file commit" fallback when the terminal line is not a clean DRAFT-SUBMITTED parse', async () => {
    atomicWriteFile(draftPlanPath(runDir, 'partner'), '# Draft plan A\n```json\n[]\n```\n');
    atomicWriteFile(draftPlanPath(runDir, 'partner-2'), '# Draft plan B\n```json\n[]\n```\n');
    // Neither line parses as DRAFT-SUBMITTED — both fall through to the file-commit fallback.
    await fs.appendFile(
      cbPath,
      '[helm callback] planner batch-R2-partner STATUS: DRAFTING\n' +
      '[helm callback] planner batch-R2-partner-2 STATUS: DRAFTING\n',
      'utf8'
    );

    const result = await runReviewRound(baseOptions({ blindDraftRound1: true }));

    expect(result.blockedReasonKind).toBeUndefined();
    expect(result.roundOneDraftPublications).toHaveLength(2);
    expect(result.roundOneDraftPublications!.every((p) => p.plan !== null)).toBe(true);
  });

  it('times out into a typed draft-not-submitted block when a seat never posts and never commits, never calling waitForAgreement', async () => {
    // Only seat A commits; seat B stays silent with no file — bounded exit.
    atomicWriteFile(draftPlanPath(runDir, 'partner'), '# Draft plan A\n```json\n[]\n```\n');
    await fs.appendFile(cbPath, '[helm callback] planner batch-R2-partner STATUS: DRAFT-SUBMITTED plan=x\n', 'utf8');

    const result = await runReviewRound(baseOptions({ blindDraftRound1: true, perRoundTimeoutMs: 500 }));

    expect(result.agreed).toBe(false);
    expect(result.blockedReasonKind).toBe('draft-not-submitted');
    expect(result.blockedReason).toMatch(/DRAFT-NOT-SUBMITTED/);
    expect(result.blockedReason).toMatch(/batch-R2-partner-2/);
    expect(result.roundOneDraftPublications).toBeUndefined();
    expect(waitForAgreementCalls).toBe(0);
  });

  it('extends the C7 first-callback watchdog to draft seats when force-enabled under the fixture harness', async () => {
    // C3/C7 are real-mode-only gates (`!isFake`) — matches planning-review-round-c7.test.ts's own
    // convention: USE_FAKE_TMUX='1' (module top) lets FakeTransport construct, `isFake: false` here
    // activates the gates, and reviewerFirstCallbackTimeoutMs force-enables the watchdog despite
    // USE_FAKE_TMUX being set.
    transport.queueSeatScript([{ sessionAlive: false, pane: '', composerHoldsBrief: false }]);

    const result = await runReviewRound(baseOptions({
      blindDraftRound1: true,
      isFake: false,
      reviewerFirstCallbackTimeoutMs: 300,
    }));

    expect(result.agreed).toBe(false);
    expect(result.blockedReasonKind).toBe('reviewer-no-first-callback');
    expect(result.blockedReason).toMatch(/session-gone/);
    expect(waitForAgreementCalls).toBe(0);
  });

  it('leaves every existing legacy caller (blindDraftRound1 omitted) completely unaffected', async () => {
    await fs.appendFile(cbPath, '[helm callback] planner batch-R2-partner STATUS: VERDICT-READY — CLEAN\n', 'utf8');
    await fs.appendFile(cbPath, '[helm callback] planner batch-R2-partner-2 STATUS: VERDICT-READY — CLEAN\n', 'utf8');

    const result = await runReviewRound(baseOptions());

    expect(result.agreed).toBe(true);
    expect(waitForAgreementCalls).toBe(1);
    const briefA = briefs.get('planner')!;
    expect(briefA).toMatch(/Panel purpose: diff-review/);
    expect(briefA).not.toMatch(/plan-draft/);
  });
});

/**
 * R6.24 — the slice must REGISTER its sweep mode, not merely prove the behavior. These drive the
 * real registry module and the real on-disk resolution X1 will enforce with; nothing is stubbed.
 */
describe('R6.24 sweep-mode registration — blind-draft-isolation (R2)', () => {
  const REPO_ROOT = process.cwd();
  let probeRoot: string | undefined;

  afterEach(async () => {
    if (probeRoot) {
      await fs.rm(probeRoot, { recursive: true, force: true }).catch(() => {});
      probeRoot = undefined;
    }
  });

  it('registers blind-draft-isolation as an active mode owned by R2, covering the R2 requirement set', () => {
    const entry = getRegressionMode('blind-draft-isolation');
    expect(entry).toBeDefined();
    expect(entry!.slice).toBe('R2');
    expect(entry!.state).toBe('active');
    expect(entry!.requirements).toEqual(
      expect.arrayContaining(['R2.5', 'R2.6', 'R2.7', 'R6.20', 'R6.24']),
    );
    expect(entry!.note.trim().length).toBeGreaterThan(0);
    // Discoverable by the sweep, which iterates the registry rather than a hand-kept list.
    expect(listRegressionModes().map((e) => e.mode)).toContain('blind-draft-isolation');
  });

  it('resolves to THIS spec on disk, with every proving test present and no disarming marker', () => {
    const entry = getRegressionMode('blind-draft-isolation')!;
    expect(entry.spec).toBe('src/services/planning-review-round-blind-draft.test.ts');

    const resolution = resolveRegressionMode('blind-draft-isolation', REPO_ROOT);
    expect(resolution.exists).toBe(true);
    expect(resolution.specPath).toBe(path.resolve(REPO_ROOT, entry.spec));
    // No it.skip/todo/only anywhere in the registered proof — a disarmed sweep is the R6.24 defect.
    expect(resolution.markers).toEqual([]);
    expect(resolution.missingProvingTests).toEqual([]);
    // The named proofs are the isolation behaviors this file actually asserts against runReviewRound.
    expect(entry.provingTests.length).toBeGreaterThanOrEqual(4);
  });

  it('reports a gutted proof as unresolved — the resolver reads the file, it does not rubber-stamp', async () => {
    probeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-r2-mode-probe-'));
    // Built by concatenation so this spec does not contain a literal disarming marker of its own.
    const skipMarker = ['it', '.skip('].join('');
    await fs.mkdir(path.join(probeRoot, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(probeRoot, 'src', 'probe.test.ts'),
      `${skipMarker}'sleeping proof', () => {});\n`,
      'utf8',
    );

    registerRegressionMode({
      mode: 'r2-probe-mode',
      slice: 'R2',
      requirements: ['R6.24'],
      spec: 'src/probe.test.ts',
      provingTests: ['a proof that no longer exists'],
      state: 'active',
      note: 'probe: resolver must surface skipped + missing proofs',
    });

    const resolution = resolveRegressionMode('r2-probe-mode', probeRoot);
    expect(resolution.exists).toBe(true);
    expect(resolution.markers).toContain('it.skip');
    expect(resolution.missingProvingTests).toEqual(['a proof that no longer exists']);

    // A spec that was deleted outright resolves as missing, not as silently passing.
    await fs.rm(path.join(probeRoot, 'src', 'probe.test.ts'));
    expect(resolveRegressionMode('r2-probe-mode', probeRoot).exists).toBe(false);
  });

  it('refuses a skeleton, duplicate, or malformed registration instead of degrading into an unenforced entry', () => {
    expect(() =>
      registerRegressionMode({
        mode: 'blind-draft-isolation',
        slice: 'R2',
        requirements: ['R6.24'],
        spec: 'src/services/planning-review-round-blind-draft.test.ts',
        provingTests: ['x'],
        state: 'active',
        note: 'duplicate',
      }),
    ).toThrow(RegressionModeRegistrationError);

    expect(() =>
      registerRegressionMode({
        mode: 'r2-skeleton-mode',
        slice: 'R2',
        requirements: ['R6.24'],
        spec: 'src/services/planning-review-round-blind-draft.test.ts',
        provingTests: ['x'],
        // A pending/skipped skeleton is exactly what R6.24 forbids.
        state: 'skipped' as unknown as 'active',
        note: 'skeleton',
      }),
    ).toThrow(RegressionModeRegistrationError);

    expect(() =>
      registerRegressionMode({
        mode: 'r2-no-proof-mode',
        slice: 'R2',
        requirements: ['R6.24'],
        spec: 'src/services/planning-review-round-blind-draft.test.ts',
        provingTests: [],
        state: 'active',
        note: 'no proving test named',
      }),
    ).toThrow(RegressionModeRegistrationError);

    expect(getRegressionMode('r2-skeleton-mode')).toBeUndefined();
    expect(getRegressionMode('r2-no-proof-mode')).toBeUndefined();
  });
});
