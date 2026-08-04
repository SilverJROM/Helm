process.env.USE_FAKE_TMUX = '1';

/**
 * C5 gate — fresh reviewer seats per round (AC11/AC13, keystone).
 * Scope: planning-review-round.ts only (the module C2 introduced, C3 hardened, C4 rounded, C5 makes
 * the round loop real).
 *
 * Proves each round now spawns its OWN fresh reviewer seats rather than reusing one spawn from
 * before the loop:
 * - roundCap=3 with non-agreement spawns exactly one fresh transport.spawn per round, each with a
 *   distinct round-scoped batch id (round 1 keeps the legacy id, rounds 2+ get a `-r{round}-` id
 *   that cannot collide with any prior round's);
 * - the prior round's reviewer handle is reaped strictly BEFORE the next round's spawn call, never
 *   after, and the FINAL round's handle is never reaped inside this module (that stays the caller's
 *   terminal-owner job);
 * - no handle is ever reused across a second transport.spawn call — the only way to hear from a seat
 *   again is a brand-new spawn, never a resend to an existing handle (this module's ITransport has no
 *   `send` method at all, so reuse could only ever manifest as a repeated handle);
 * - early agreement stops the loop without spawning a later round, while leaving both attempted
 *   rounds' handles/runtime ids visible in the caller-owned accumulators.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { BriefWriterService } from './brief-writer-service.js';
import { runReviewRound, RunReviewRoundOptions } from './planning-review-round.js';

describe('runReviewRound fresh reviewer seats per round (C5, AC11/AC13)', () => {
  let runDir: string;
  let transport: FakeTransport;
  let briefWriter: BriefWriterService;
  let briefs: Map<string, string>;
  let partnerHandles: string[];
  let partnerRuntimeIds: (number | null)[];
  let callOrder: string[];

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-c5-fresh-seats-'));
    transport = new FakeTransport();
    briefWriter = new BriefWriterService();
    briefs = new Map();
    partnerHandles = [];
    partnerRuntimeIds = [];
    callOrder = [];

    // Instrument spawn/reap with a shared call-order log so ordering assertions don't depend on
    // Date.now() (too coarse to reliably order same-tick calls). Behavior is delegated straight to
    // the underlying FakeTransport methods.
    const originalSpawn = transport.spawn.bind(transport);
    const originalReap = transport.reap.bind(transport);
    (transport as unknown as { spawn: typeof transport.spawn }).spawn = async (params) => {
      const spawned = await originalSpawn(params);
      callOrder.push(`spawn:${params.batchId}`);
      return spawned;
    };
    (transport as unknown as { reap: typeof transport.reap }).reap = async (handle, reason) => {
      await originalReap(handle, reason);
      callOrder.push(`reap:${handle}`);
    };
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
      waitForAgreement: async () => false,
      runDir,
      batchId: 'batch-C5',
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

  it('roundCap=3 with non-agreement spawns exactly one fresh seat per round with distinct round-scoped batch ids', async () => {
    const result = await runReviewRound(baseOptions({ roundCap: 3 }));

    expect(result.agreed).toBe(false);
    expect(result.roundsAttempted).toBe(3);
    expect(transport.spawnCalls).toHaveLength(3);
    expect(transport.spawnCalls.map((c) => c.batchId)).toEqual([
      'batch-C5-partner',
      'batch-C5-r2-partner',
      'batch-C5-r3-partner',
    ]);
    // Every round's batch id is unique — no collision between any pair of rounds.
    const ids = transport.spawnCalls.map((c) => c.batchId);
    expect(new Set(ids).size).toBe(ids.length);
    // Round 1 keeps the legacy brief key; rounds 2+ are round-scoped.
    expect(briefs.has('planner')).toBe(true);
    expect(briefs.has('planner-r2')).toBe(true);
    expect(briefs.has('planner-r3')).toBe(true);
  });

  it('reaps the prior round handle strictly before the next round spawns, and never reaps the final round', async () => {
    await runReviewRound(baseOptions({ roundCap: 3 }));

    // 3 spawns, 2 reaps (round 3's handle is left for the caller's terminal owner).
    expect(transport.spawnCalls).toHaveLength(3);
    expect(transport.reapCalls).toHaveLength(2);

    const round1Handle = partnerHandles[0];
    const round2Handle = partnerHandles[1];
    const round3Handle = partnerHandles[2];

    expect(callOrder).toEqual([
      `spawn:batch-C5-partner`,
      `reap:${round1Handle}`,
      `spawn:batch-C5-r2-partner`,
      `reap:${round2Handle}`,
      `spawn:batch-C5-r3-partner`,
    ]);
    // The final round's handle is never reaped inside runReviewRound.
    expect(transport.reapCalls.some((r) => r.handle === round3Handle)).toBe(false);
  });

  it('never reuses a handle across a second transport.spawn call — every round gets a brand-new seat', async () => {
    await runReviewRound(baseOptions({ roundCap: 3 }));

    expect(partnerHandles).toHaveLength(3);
    expect(new Set(partnerHandles).size).toBe(3);
    // ITransport has no `send` method; confirm this module never attempted to call one.
    expect((transport as unknown as { send?: unknown }).send).toBeUndefined();
  });

  it('an early agreement stops the loop without spawning a later round, leaving both attempted rounds visible to the caller', async () => {
    let call = 0;
    const result = await runReviewRound(baseOptions({
      roundCap: 3,
      waitForAgreement: async () => {
        call += 1;
        return call === 2; // agrees on round 2
      },
    }));

    expect(result.agreed).toBe(true);
    expect(result.roundsAttempted).toBe(2);
    expect(transport.spawnCalls).toHaveLength(2);
    expect(transport.spawnCalls.map((c) => c.batchId)).toEqual(['batch-C5-partner', 'batch-C5-r2-partner']);
    // Both rounds' seats stay visible in the caller-owned accumulators (A5/A6 visibility contract).
    expect(partnerHandles).toHaveLength(2);
    expect(partnerRuntimeIds).toHaveLength(2);
    // Only round 1 (the non-agreeing round) was reaped inside this function; round 2's live seat is
    // left for the caller's normal terminal-owner reap on a successful return.
    expect(transport.reapCalls).toHaveLength(1);
    expect(transport.reapCalls[0].handle).toBe(partnerHandles[0]);
  });

  it('a multi-seat panel gets round-scoped ids/brief keys for every seat, not just seat 0', async () => {
    let call = 0;
    await runReviewRound(baseOptions({
      roundCap: 2,
      coPlannerSeats: [
        { slot: 0, provider: 'grok', model: 'grok-4.5' },
        { slot: 1, provider: 'anthropic', model: 'claude-sonnet' },
      ],
      waitForAgreement: async () => {
        call += 1;
        return false;
      },
    }));

    expect(transport.spawnCalls).toHaveLength(4); // 2 seats x 2 rounds
    expect(transport.spawnCalls.map((c) => c.batchId)).toEqual([
      'batch-C5-partner',
      'batch-C5-partner-2',
      'batch-C5-r2-partner',
      'batch-C5-r2-partner-2',
    ]);
    expect(briefs.has('planner')).toBe(true);
    expect(briefs.has('planner-2')).toBe(true);
    expect(briefs.has('planner-r2')).toBe(true);
    expect(briefs.has('planner-r2-2')).toBe(true);
    // Round 1's two seats reaped before round 2 spawns; round 2's two seats left for the caller.
    expect(transport.reapCalls).toHaveLength(2);
  });

  it('roundCap omitted still performs exactly one round with the legacy id shape (C2/C3/C4 default preserved)', async () => {
    const result = await runReviewRound(baseOptions({
      waitForAgreement: async () => true,
    }));

    expect(result.agreed).toBe(true);
    expect(result.roundsAttempted).toBe(1);
    expect(transport.spawnCalls).toHaveLength(1);
    expect(transport.spawnCalls[0].batchId).toBe('batch-C5-partner');
    expect(transport.reapCalls).toHaveLength(0);
  });
});
