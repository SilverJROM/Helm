process.env.USE_FAKE_TMUX = '1';

/**
 * C4 gate — integer round cap inside runReviewRound (AC10/AC3).
 * Scope: planning-review-round.ts only (the module C2 introduced, C3 hardened, C4 rounds).
 *
 * Proves roundCap is now an INTEGER COUNT of agreement rounds, each independently bounded by
 * perRoundTimeoutMs — never one wait pre-multiplied by roundCap:
 * - roundCap=3 with an always-false waitForAgreement calls it exactly three times, each with the
 *   per-round timeout (not once with timeout*3);
 * - early agreement stops the loop without spending the remaining rounds;
 * - exhaustion returns non-agreement and exposes the exhausted round count + a typed blocked reason;
 * - roundCap omitted (the C2/C3 default) still performs exactly one round, so existing behavior for
 *   the spawn loop and the C3 artifact-publication gate is unchanged with the new parameters.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { BriefWriterService } from './brief-writer-service.js';
import { runReviewRound, RunReviewRoundOptions } from './planning-review-round.js';

describe('runReviewRound integer round cap (C4, AC10/AC3)', () => {
  let runDir: string;
  let transport: FakeTransport;
  let briefWriter: BriefWriterService;
  let partnerHandles: string[];
  let partnerRuntimeIds: (number | null)[];

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-c4-round-cap-'));
    transport = new FakeTransport();
    briefWriter = new BriefWriterService();
    partnerHandles = [];
    partnerRuntimeIds = [];
  });

  afterEach(async () => {
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  function baseOptions(overrides: Partial<RunReviewRoundOptions> = {}): RunReviewRoundOptions {
    return {
      transport,
      briefWriter,
      writeBrief: async () => {},
      registerWorkerRuntime: () => null,
      waitForAgreement: async () => false,
      runDir,
      batchId: 'batch-C4',
      brainRole: 'plancore',
      partner: 'planner',
      effectiveProjectDir: '/home/agjrom/websites/Helm',
      cbPath: path.join(runDir, 'callbacks.md'),
      planMdPath: path.join(runDir, 'plan.md'),
      perRoundTimeoutMs: 4000,
      agreementFenceOffset: 0,
      isFake: true,
      partnerHandles,
      partnerRuntimeIds,
      ...overrides,
    };
  }

  it('roundCap=3 calls waitForAgreement exactly three times with the per-round timeout, never once with timeout*3', async () => {
    const calls: number[] = [];
    const result = await runReviewRound(baseOptions({
      roundCap: 3,
      waitForAgreement: async (_cbPath, _batchId, _partnerRole, _brainRole, timeoutMs) => {
        calls.push(timeoutMs);
        return false;
      },
    }));

    expect(calls).toEqual([4000, 4000, 4000]);
    expect(result.agreed).toBe(false);
    expect(result.roundsAttempted).toBe(3);
  });

  it('stops the loop as soon as a round agrees, without spending the remaining rounds', async () => {
    let call = 0;
    const result = await runReviewRound(baseOptions({
      roundCap: 3,
      waitForAgreement: async () => {
        call += 1;
        return call === 2; // agrees on round 2
      },
    }));

    expect(call).toBe(2);
    expect(result.agreed).toBe(true);
    expect(result.roundsAttempted).toBe(2);
    expect(result.blockedReason).toBeUndefined();
  });

  it('exhaustion returns non-agreement and exposes the exhausted round count and a typed blocked reason', async () => {
    const result = await runReviewRound(baseOptions({
      roundCap: 3,
      waitForAgreement: async () => false,
    }));

    expect(result.agreed).toBe(false);
    expect(result.roundsAttempted).toBe(3);
    expect(result.blockedReason).toMatch(/ROUND-CAP-EXHAUSTED/);
    expect(result.blockedReason).toMatch(/within 3 round\(s\)/);
  });

  it('roundCap omitted performs exactly one round, preserving C2/C3 spawn/publication behavior with the new parameters', async () => {
    let call = 0;
    const result = await runReviewRound(baseOptions({
      coPlannerSeats: [{ slot: 0, provider: 'grok', model: 'grok-4.5' }],
      waitForAgreement: async () => {
        call += 1;
        return true;
      },
    }));

    expect(call).toBe(1);
    expect(result.agreed).toBe(true);
    expect(result.roundsAttempted).toBe(1);
    expect(transport.spawnCalls).toHaveLength(1);
    expect(partnerHandles).toHaveLength(1);
  });
});
