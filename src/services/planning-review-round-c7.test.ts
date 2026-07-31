process.env.USE_FAKE_TMUX = '1';

/**
 * C7 gate — reviewer first-callback / submit watchdog (AC15/AC23).
 * Scope: planning-review-round.ts only (the module C2 introduced, C3 hardened, C4 rounded, C5 made
 * fresh-seat, C6 added the revise actuator, C7 generalizes plancore's POCFIX20 waitForFirstCallback
 * to reviewer seats).
 *
 * The watchdog is ON BY DEFAULT in real mode: `!isFake && process.env.USE_FAKE_TMUX !== '1'` is the
 * SAME isFakeP convention planning-phase-service.ts already uses to skip its own plancore watchdog
 * (POCFIX20) under the fixture harness. Every existing C2-C6 fixture — INCLUDING
 * planning-review-round-c3.test.ts's real-mode ("isFake: false") direct-success case, which asserts
 * agreement with no reviewer callback ever seeded in cbPath — sets `process.env.USE_FAKE_TMUX = '1'`
 * at module load, so the watchdog stays inactive for all of them regardless of isFake; none of them
 * needed editing. `reviewerFirstCallbackTimeoutMs` (additive/optional) instead force-enables the
 * watchdog under the fixture harness (so THIS file can drive FakeTransport, which itself requires
 * USE_FAKE_TMUX='1' to construct) and/or overrides the bound used.
 *
 * Proves:
 * - a reviewer with no first callback returns the typed blocked result and never calls waitForAgreement
 *   (via the fixture-harness force-enable override);
 * - the same holds on the genuine production default-on path — USE_FAKE_TMUX temporarily unset and
 *   reviewerFirstCallbackTimeoutMs omitted — proving the watchdog is not merely test-only machinery;
 * - a session-gone reviewer (inspectSeat reports !sessionAlive) returns the typed blocked result,
 *   naming the stuck batch id, and never calls waitForAgreement;
 * - a composer-held reviewer seat (resubmitIfComposerHeld exposed by the transport) invokes that
 *   retry path repeatedly, but boundedly, and still resolves to the typed blocked result once the
 *   overall watchdog timeout elapses with no callback ever landing;
 * - a valid first callback lets the existing agreement path continue exactly as before (waitForAgreement
 *   is called, its result is returned unchanged).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { BriefWriterService } from './brief-writer-service.js';
import { runReviewRound, RunReviewRoundOptions } from './planning-review-round.js';

const VALID_PLAN_TASKS = [
  {
    id: 'C7-T01',
    batch: 'C7',
    title: 'Prove the reviewer first-callback watchdog lets a live seat through',
    req_refs: ['R-C7'],
    assignee: 'grok-4.5',
    validator_lane: 'L1',
    effort: 'high',
    type: 'feature',
    deps: [],
  },
];
const VALID_PLAN_MD = '# plan.md — C7 gate test\n```json\n' + JSON.stringify(VALID_PLAN_TASKS, null, 2) + '\n```\n';
const VALID_REQUIREMENTS_MD = '# Requirements\n\n- **R-C7** — reviewer first-callback watchdog proof\n';

describe('runReviewRound reviewer first-callback watchdog (C7, AC15/AC23)', () => {
  let runDir: string;
  let cbPath: string;
  let transport: FakeTransport;
  let briefWriter: BriefWriterService;
  let briefs: Map<string, string>;
  let partnerHandles: string[];
  let partnerRuntimeIds: (number | null)[];
  let waitForAgreementCalls: number;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-c7-first-callback-'));
    cbPath = path.join(runDir, 'callbacks.md');
    transport = new FakeTransport();
    briefWriter = new BriefWriterService();
    briefs = new Map();
    partnerHandles = [];
    partnerRuntimeIds = [];
    waitForAgreementCalls = 0;
    await fs.writeFile(path.join(runDir, 'plan.md'), VALID_PLAN_MD, 'utf8');
    await fs.writeFile(path.join(runDir, 'og-requirements.md'), VALID_REQUIREMENTS_MD, 'utf8');
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
      batchId: 'batch-C7',
      brainRole: 'plancore',
      partner: 'planner',
      effectiveProjectDir: '/home/agjrom/websites/Helm',
      cbPath,
      planMdPath: path.join(runDir, 'plan.md'),
      perRoundTimeoutMs: 4000,
      agreementFenceOffset: 0,
      // C3's artifact-publication gate and C7's first-callback watchdog are both real-mode only;
      // every test in this file drives the watchdog and must therefore be real-mode.
      isFake: false,
      reviewerFirstCallbackTimeoutMs: 500,
      partnerHandles,
      partnerRuntimeIds,
      ...overrides,
    };
  }

  it('a reviewer with no first callback returns the typed blocked result and never calls waitForAgreement', async () => {
    const result = await runReviewRound(baseOptions());

    expect(result.agreed).toBe(false);
    expect(result.roundsAttempted).toBe(1);
    expect(result.partnerBatchIds).toEqual(['batch-C7-partner']);
    expect(result.blockedReason).toMatch(/REVIEWER-NO-FIRST-CALLBACK/);
    expect(result.blockedReason).toMatch(/batch-C7-partner/);
    expect(result.blockedReason).toMatch(/no-first-callback/);
    expect(waitForAgreementCalls).toBe(0);
    expect(transport.spawnCalls).toHaveLength(1);
  });

  it('production default-on path (USE_FAKE_TMUX unset, reviewerFirstCallbackTimeoutMs omitted): no first callback still returns the typed blocked result and never calls waitForAgreement', async () => {
    // FakeTransport itself requires USE_FAKE_TMUX='1' to construct (see its constructor guard), so it
    // is already built (in beforeEach) BEFORE this test unsets the env var — only the watchdog's
    // runtime gate check (inside runReviewRound) observes the unset value. Restored in `finally` so it
    // cannot leak into any other test in this file or process.
    const previousUseFakeTmux = process.env.USE_FAKE_TMUX;
    delete process.env.USE_FAKE_TMUX;
    let result;
    try {
      result = await runReviewRound(baseOptions({ perRoundTimeoutMs: 400, reviewerFirstCallbackTimeoutMs: undefined }));
    } finally {
      process.env.USE_FAKE_TMUX = previousUseFakeTmux;
    }

    expect(result.agreed).toBe(false);
    expect(result.roundsAttempted).toBe(1);
    expect(result.partnerBatchIds).toEqual(['batch-C7-partner']);
    expect(result.blockedReason).toMatch(/REVIEWER-NO-FIRST-CALLBACK/);
    expect(result.blockedReason).toMatch(/batch-C7-partner/);
    expect(result.blockedReason).toMatch(/no-first-callback/);
    expect(waitForAgreementCalls).toBe(0);
    expect(transport.spawnCalls).toHaveLength(1);
  });

  it('a session-gone reviewer returns the typed blocked result naming the stuck batch id and never calls waitForAgreement', async () => {
    transport.queueSeatScript([{ sessionAlive: false, pane: '', composerHoldsBrief: false }]);

    const result = await runReviewRound(baseOptions());

    expect(result.agreed).toBe(false);
    expect(result.roundsAttempted).toBe(1);
    expect(result.partnerBatchIds).toEqual(['batch-C7-partner']);
    expect(result.blockedReason).toMatch(/REVIEWER-NO-FIRST-CALLBACK/);
    expect(result.blockedReason).toMatch(/batch-C7-partner/);
    expect(result.blockedReason).toMatch(/session-gone/);
    expect(waitForAgreementCalls).toBe(0);
    expect(transport.inspectCalls.length).toBeGreaterThan(0);
  });

  it('a composer-held reviewer seat invokes the bounded submit watchdog/retry path when the transport exposes it', async () => {
    const resubmitCalls: Array<{ handle: string; brief: string }> = [];
    (transport as unknown as { resubmitIfComposerHeld: (handle: string, brief: string) => Promise<boolean> }).resubmitIfComposerHeld =
      async (handle: string, brief: string) => {
        resubmitCalls.push({ handle, brief });
        return true; // composer never clears — proves the retry stays bounded by the overall watchdog timeout, not by a clear signal.
      };

    const result = await runReviewRound(baseOptions({ reviewerFirstCallbackTimeoutMs: 700 }));

    expect(result.agreed).toBe(false);
    expect(result.blockedReason).toMatch(/no-first-callback/);
    expect(result.blockedReason).toMatch(/batch-C7-partner/);
    expect(waitForAgreementCalls).toBe(0);
    // Invoked repeatedly (genuine retry, not a one-off) but bounded — the wait still resolved instead
    // of hanging forever on a perpetually-held composer.
    expect(resubmitCalls.length).toBeGreaterThanOrEqual(2);
    expect(resubmitCalls.length).toBeLessThanOrEqual(10);
    expect(resubmitCalls.every((c) => c.handle && c.brief)).toBe(true);
  });

  it('a valid first callback lets the existing agreement path continue unchanged', async () => {
    await fs.appendFile(cbPath, '[helm callback] planner batch-C7-partner STATUS: VERDICT-READY — CLEAN\n', 'utf8');

    const result = await runReviewRound(baseOptions());

    expect(result.agreed).toBe(true);
    expect(result.blockedReason).toBeUndefined();
    expect(result.partnerBatchIds).toEqual(['batch-C7-partner']);
    expect(waitForAgreementCalls).toBe(1);
    expect(transport.spawnCalls).toHaveLength(1);
  });
});
