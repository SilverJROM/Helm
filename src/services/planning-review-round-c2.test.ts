process.env.USE_FAKE_TMUX = '1';

/**
 * C2 gate — runReviewRound seam extraction (AC11 foundation).
 * Scope: planning-review-round.ts only (the new module C2 introduces).
 *
 * Proves the extraction is behavior-preserving:
 * - the partner-spawn loop still spawns the same configured seats and writes the same briefs
 *   (legacy correlation ids, brief-per-seat) as the pre-extraction inline code did;
 * - the agreement result is delegated straight back to the caller, with no canonical
 *   plan.md/og-requirements.md read inside this module (that stays owned by
 *   planning-phase-service.ts's runPlanningPhase);
 * - a non-agreement (BROKEN / round-cap-exhausted) result passes through unchanged, never a throw;
 * - a spawn that throws mid-loop still leaves every already-spawned seat's handle/runtime id visible
 *   in the caller-owned accumulators (A5/A6: no already-spawned seat may go unreaped/unfinalized).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { BriefWriterService } from './brief-writer-service.js';
import { runReviewRound, RunReviewRoundOptions } from './planning-review-round.js';

describe('runReviewRound (C2 seam extraction, AC11)', () => {
  let runDir: string;
  let transport: FakeTransport;
  let briefWriter: BriefWriterService;
  let briefs: Map<string, string>;
  let registeredSeats: Array<{ role: string; correlationId: string; handle: string; provider?: string; model?: string }>;
  let partnerHandles: string[];
  let partnerRuntimeIds: (number | null)[];

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-c2-review-round-'));
    transport = new FakeTransport();
    briefWriter = new BriefWriterService();
    briefs = new Map();
    registeredSeats = [];
    partnerHandles = [];
    partnerRuntimeIds = [];
  });

  afterEach(async () => {
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  function baseOptions(
    overrides: Partial<RunReviewRoundOptions> = {},
    waitResult = true
  ): RunReviewRoundOptions {
    return {
      transport,
      briefWriter,
      writeBrief: async (role, content) => { briefs.set(role, content); },
      registerWorkerRuntime: (role, correlationId, handle, provider, model) => {
        registeredSeats.push({ role, correlationId, handle, provider, model });
        return registeredSeats.length;
      },
      waitForAgreement: async () => waitResult,
      runDir,
      batchId: 'batch-C2',
      brainRole: 'plancore',
      partner: 'planner',
      effectiveProjectDir: '/home/agjrom/websites/Helm',
      cbPath: path.join(runDir, 'callbacks.md'),
      planMdPath: path.join(runDir, 'plan.md'),
      effectiveTimeoutMs: 4000,
      agreementFenceOffset: 0,
      isFake: true,
      partnerHandles,
      partnerRuntimeIds,
      ...overrides,
    };
  }

  it('spawns the configured partner seats with the legacy correlation ids and writes matching briefs', async () => {
    const result = await runReviewRound(baseOptions({
      coPlannerSeats: [
        { slot: 0, provider: 'grok', model: 'grok-4.5' },
        { slot: 1, provider: 'anthropic', model: 'claude-sonnet' },
      ],
    }));

    expect(result.partnerBatchIds).toEqual(['batch-C2-partner', 'batch-C2-partner-2']);
    expect(transport.spawnCalls).toHaveLength(2);
    expect(transport.spawnCalls[0]).toMatchObject({ role: 'planner', batchId: 'batch-C2-partner', provider: 'grok', model: 'grok-4.5' });
    expect(transport.spawnCalls[1]).toMatchObject({ role: 'planner', batchId: 'batch-C2-partner-2', provider: 'anthropic', model: 'claude-sonnet' });
    // Seat 0 keeps the legacy bare `planner` brief key; seat 1+ is numbered — same as pre-extraction.
    expect(briefs.has('planner')).toBe(true);
    expect(briefs.has('planner-2')).toBe(true);
    expect(registeredSeats.map((s) => s.correlationId)).toEqual(['batch-C2-partner', 'batch-C2-partner-2']);
    expect(partnerHandles).toHaveLength(2);
    expect(partnerRuntimeIds).toEqual([1, 2]);
  });

  it('delegates the agreement result back to the caller without any canonical plan.md/og-requirements.md read', async () => {
    // plan.md is deliberately never created in runDir. If this module tried to read/validate the
    // canonical plan itself (the job B6 reserves for runPlanningPhase after this call returns), that
    // read would throw ENOENT and this call would reject instead of resolving.
    const result = await runReviewRound(baseOptions({}, true));
    expect(result.agreed).toBe(true);
    await expect(fs.access(path.join(runDir, 'plan.md'))).rejects.toThrow();
    await expect(fs.access(path.join(runDir, 'og-requirements.md'))).rejects.toThrow();
  });

  it('passes through a non-agreement (BROKEN / round-cap-exhausted) result unchanged, without throwing', async () => {
    const result = await runReviewRound(baseOptions({}, false));
    expect(result.agreed).toBe(false);
    // Default panelSize (no coPlannerSeats) => exactly 1 partner, the legacy bare correlation id.
    expect(result.partnerBatchIds).toEqual(['batch-C2-partner']);
  });

  it('leaves already-spawned partner handles/runtime ids visible to the caller even when a later spawn throws', async () => {
    let call = 0;
    const originalSpawn = transport.spawn.bind(transport);
    (transport as unknown as { spawn: typeof transport.spawn }).spawn = async (params) => {
      call += 1;
      if (call === 2) throw new Error('spawn boom');
      return originalSpawn(params);
    };

    await expect(runReviewRound(baseOptions({
      coPlannerSeats: [
        { slot: 0, provider: 'grok', model: 'grok-4.5' },
        { slot: 1, provider: 'anthropic', model: 'claude-sonnet' },
        { slot: 2, provider: 'openai', model: 'gpt-5' },
      ],
    }))).rejects.toThrow('spawn boom');

    // Seat 0 spawned successfully before seat 1's spawn threw — its handle/runtime id must already be
    // captured in the caller-owned arrays (A5/A6: no already-spawned seat may go unreaped/unfinalized),
    // even though the throw propagates out of runReviewRound before it can return a result.
    expect(partnerHandles).toHaveLength(1);
    expect(partnerRuntimeIds).toHaveLength(1);
  });
});
