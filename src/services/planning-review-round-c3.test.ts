process.env.USE_FAKE_TMUX = '1';

/**
 * C3 gate — artifact-publication check inside runReviewRound (AC11/AC23).
 * Scope: planning-review-round.ts only (the module C2 introduced, C3 hardens).
 *
 * Proves the structural fix for the convene race the partner brief text already works around by
 * instruction alone (CONVENE-RACE FIX comment in planning-review-round.ts):
 * - missing plan.md/og-requirements.md causes zero reviewer spawns;
 * - an empty or unparseable plan.md, or an empty og-requirements.md, causes zero reviewer spawns;
 * - once both artifacts are present, non-empty and parseable, the existing C2 spawn/wait behavior
 *   (partner briefs written, transport.spawn called, waitForAgreement delegated to) is unchanged;
 * - the gate is real-mode only (isFake: false) — the C2 fixture suite (isFake: true, no plan.md ever
 *   on disk in runDir) is unaffected, proven here by an explicit isFake:true pass-through case.
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
    id: 'C3-T01',
    batch: 'C3',
    title: 'Prove the publication gate lets a present, parseable plan through',
    req_refs: ['R-C3'],
    assignee: 'grok-4.5',
    validator_lane: 'L1',
    effort: 'high',
    type: 'feature',
    deps: [],
  },
];
const VALID_PLAN_MD = '# plan.md — C3 gate test\n```json\n' + JSON.stringify(VALID_PLAN_TASKS, null, 2) + '\n```\n';
const VALID_REQUIREMENTS_MD = '# Requirements\n\n- **R-C3** — publication gate proof\n';
const TRUNCATED_PLAN_MD = '# plan.md — cut off mid-write\n```json\n[{"id": "C3-T01", "title": "cut off mid-w';

describe('runReviewRound artifact-publication gate (C3, AC11/AC23)', () => {
  let runDir: string;
  let transport: FakeTransport;
  let briefWriter: BriefWriterService;
  let briefs: Map<string, string>;
  let registeredSeats: Array<{ role: string; correlationId: string; handle: string; provider?: string; model?: string }>;
  let partnerHandles: string[];
  let partnerRuntimeIds: (number | null)[];

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-c3-publication-gate-'));
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
      batchId: 'batch-C3',
      brainRole: 'plancore',
      partner: 'planner',
      effectiveProjectDir: '/home/agjrom/websites/Helm',
      cbPath: path.join(runDir, 'callbacks.md'),
      planMdPath: path.join(runDir, 'plan.md'),
      effectiveTimeoutMs: 4000,
      agreementFenceOffset: 0,
      // C3's gate is real-mode only; every test in this file except the explicit fixture-pass-through
      // one below exercises it with isFake: false, matching production (which is never isFake).
      isFake: false,
      partnerHandles,
      partnerRuntimeIds,
      ...overrides,
    };
  }

  it('blocks with zero reviewer spawns when plan.md and og-requirements.md are both missing', async () => {
    const result = await runReviewRound(baseOptions());

    expect(result.agreed).toBe(false);
    expect(result.partnerBatchIds).toEqual([]);
    expect(result.blockedReason).toMatch(/ARTIFACT-NOT-PUBLISHED/);
    expect(result.blockedReason).toMatch(/plan\.md not yet published/);
    expect(result.blockedReason).toMatch(/og-requirements\.md not yet published/);
    expect(transport.spawnCalls).toHaveLength(0);
    expect(briefs.size).toBe(0);
    expect(partnerHandles).toHaveLength(0);
    expect(partnerRuntimeIds).toHaveLength(0);
  });

  it('blocks with zero reviewer spawns when plan.md exists but is empty (mid-write truncation)', async () => {
    await fs.writeFile(path.join(runDir, 'plan.md'), '', 'utf8');
    await fs.writeFile(path.join(runDir, 'og-requirements.md'), VALID_REQUIREMENTS_MD, 'utf8');

    const result = await runReviewRound(baseOptions());

    expect(result.agreed).toBe(false);
    expect(result.blockedReason).toMatch(/plan\.md is empty/);
    expect(transport.spawnCalls).toHaveLength(0);
  });

  it('blocks with zero reviewer spawns when plan.md exists but does not parse (truncated fenced json)', async () => {
    await fs.writeFile(path.join(runDir, 'plan.md'), TRUNCATED_PLAN_MD, 'utf8');
    await fs.writeFile(path.join(runDir, 'og-requirements.md'), VALID_REQUIREMENTS_MD, 'utf8');

    const result = await runReviewRound(baseOptions());

    expect(result.agreed).toBe(false);
    expect(result.blockedReason).toMatch(/does not yet parse as a complete plan/);
    expect(transport.spawnCalls).toHaveLength(0);
  });

  it('blocks with zero reviewer spawns when og-requirements.md exists but is empty', async () => {
    await fs.writeFile(path.join(runDir, 'plan.md'), VALID_PLAN_MD, 'utf8');
    await fs.writeFile(path.join(runDir, 'og-requirements.md'), '   \n', 'utf8');

    const result = await runReviewRound(baseOptions());

    expect(result.agreed).toBe(false);
    expect(result.blockedReason).toMatch(/og-requirements\.md is empty/);
    expect(transport.spawnCalls).toHaveLength(0);
  });

  it('allows the existing C2 spawn/wait behavior once both artifacts are present, non-empty and parseable', async () => {
    await fs.writeFile(path.join(runDir, 'plan.md'), VALID_PLAN_MD, 'utf8');
    await fs.writeFile(path.join(runDir, 'og-requirements.md'), VALID_REQUIREMENTS_MD, 'utf8');

    const result = await runReviewRound(baseOptions({
      coPlannerSeats: [
        { slot: 0, provider: 'grok', model: 'grok-4.5' },
        { slot: 1, provider: 'anthropic', model: 'claude-sonnet' },
      ],
    }, true));

    expect(result.agreed).toBe(true);
    expect(result.blockedReason).toBeUndefined();
    expect(result.partnerBatchIds).toEqual(['batch-C3-partner', 'batch-C3-partner-2']);
    expect(transport.spawnCalls).toHaveLength(2);
    expect(briefs.has('planner')).toBe(true);
    expect(briefs.has('planner-2')).toBe(true);
    expect(partnerHandles).toHaveLength(2);
    expect(partnerRuntimeIds).toEqual([1, 2]);
  });

  it('never runs the gate under the fixture harness (isFake: true), preserving C2 behavior with no artifacts on disk', async () => {
    const result = await runReviewRound(baseOptions({ isFake: true }, true));

    expect(result.agreed).toBe(true);
    expect(result.blockedReason).toBeUndefined();
    expect(transport.spawnCalls).toHaveLength(1);
    await expect(fs.access(path.join(runDir, 'plan.md'))).rejects.toThrow();
    await expect(fs.access(path.join(runDir, 'og-requirements.md'))).rejects.toThrow();
  });
});
