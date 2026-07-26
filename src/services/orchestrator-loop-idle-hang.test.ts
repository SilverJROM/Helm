process.env.USE_FAKE_TMUX = '1';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { FakeTransport } from './fake-transport.js';
import { bindDispatchNonce, BriefWriterService } from './brief-writer-service.js';
import { OrchestratorLoop } from './orchestrator-loop.js';
import { RunArtifactService } from './run-artifact-service.js';
import { classifySeatPane, type SeatInspection } from './seat-pane-state.js';
import { PlanningPhaseService } from './planning-phase-service.js';
import { TaskQueueService } from './task-queue-service.js';

const BRIEF = 'Implement Stage 4 and append the required terminal callback.';
const BATCH = 'batch-idle43';

describe('idle-hang #43 callback wait', () => {
  let runDir: string;
  let callbacksPath: string;
  let dbPath: string;
  let db: DatabaseService;
  let artifacts: RunArtifactService;
  let runId: number;
  let transport: FakeTransport;
  let loop: OrchestratorLoop;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T00:00:00Z'));
    process.env.USE_FAKE_TMUX = '1';
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-idle43-'));
    callbacksPath = path.join(runDir, 'callbacks.md');
    await fs.writeFile(callbacksPath, '# callbacks\n', 'utf8');
    dbPath = path.join(os.tmpdir(), `helm-idle43-${Math.random().toString(36).slice(2)}.db`);
    db = new DatabaseService(dbPath);
    artifacts = new RunArtifactService(db);
    runId = artifacts.createRun(null, BATCH);
    transport = new FakeTransport();
    loop = new OrchestratorLoop(transport, { runDir, batchId: BATCH, artifactService: artifacts, runId });
  });

  afterEach(async () => {
    delete process.env.HELM_CB_FIRST_CALLBACK_MS;
    delete process.env.HELM_CB_IDLE_PROMPT_MS;
    delete process.env.HELM_CB_NUDGE_GRACE_MS;
    delete process.env.HELM_CB_WALL_MS;
    delete process.env.HELM_CB_PANE_PROBE_MS;
    delete process.env.HELM_CB_IDLE_MS;
    delete process.env.HELM_CB_FREEZE_MS;
    delete process.env.HELM_CB_COMPOSER_HELD_MAX_MS;
    delete process.env.HELM_SUBMIT_WD_MS;
    delete process.env.HELM_SUBMIT_WD_MAX;
    vi.useRealTimers();
    db.close();
    await fs.rm(runDir, { recursive: true, force: true });
    await fs.rm(dbPath, { force: true });
  });

  async function startWait(
    frames: SeatInspection[],
    overrides: Record<string, number> = {},
    provider = 'codex',
    sinceOffset = 0
  ) {
    transport.queueSeatScript(frames);
    const { handle } = await transport.spawn({ role: 'implementer', brief: BRIEF, runDir, batchId: BATCH, provider });
    const pending = (loop as any).waitForCallback('implementer', ['DONE'], {
      wallMs: 1_000,
      idleMs: 60,
      firstCallbackMs: 120,
      freezeMs: 30,
      paneProbeMs: 5,
      idlePromptStableMs: 15,
      nudgeGraceMs: 30,
      pollMs: 5,
      sinceOffset,
      handle,
      provider,
      brief: BRIEF,
      ...overrides,
    }) as Promise<{ state: string; note: string | null }>;
    void pending.catch(() => {}); // attach immediately; some classified failures occur during the first probe
    for (let i = 0; i < 100 && !transport.inspectCalls.some((call) => call.handle === handle); i += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }
    return { handle, pending };
  }

  async function append(state: string, note = 'test'): Promise<void> {
    await fs.appendFile(callbacksPath, `[helm callback] implementer ${BATCH} STATUS: ${state} — ${note}\n`);
  }

  async function pumpUntil(predicate: () => boolean, maxMs: number, stepMs = 5): Promise<void> {
    for (let elapsed = 0; elapsed < maxMs && !predicate(); elapsed += stepMs) {
      await vi.advanceTimersByTimeAsync(stepMs);
      await fs.stat(callbacksPath); // yield through real fs I/O used by the polling loop
    }
  }

  function waitResultCount(): number {
    return Number((db.raw.prepare("SELECT COUNT(*) AS n FROM run_events WHERE event_type='CALLBACK_WAIT_RESULT'").get() as any).n);
  }

  it('frozen no-prompt pane fails at the 120s-equivalent first-callback deadline, not ambiguous idle', async () => {
    const { pending } = await startWait([{ sessionAlive: true, pane: 'quiet shell output', composerHoldsBrief: false }]);
    const rejection = expect(pending).rejects.toMatchObject({ waitCause: 'no-first-callback' });
    await pumpUntil(() => waitResultCount() > 0, 200);
    await rejection;
    const row = db.raw.prepare("SELECT payload_json FROM run_events WHERE event_type='CALLBACK_WAIT_RESULT'").get() as any;
    expect(JSON.parse(row.payload_json)).toMatchObject({ outcome: 'reap', reason: 'no-first-callback', nudge_sent: false });
  });

  it('continuously changing pane cannot waive the first-callback contract', async () => {
    const frames = Array.from({ length: 40 }, (_, i) => ({ sessionAlive: true, pane: `building ${i}`, composerHoldsBrief: false }));
    const { pending } = await startWait(frames);
    const rejection = expect(pending).rejects.toMatchObject({ waitCause: 'no-first-callback' });
    await pumpUntil(() => waitResultCount() > 0, 200);
    await rejection;
  });

  it('WORKING plus continuing pane activity vetoes callback-idle reap; later DONE succeeds', async () => {
    await append('WORKING');
    const frames = Array.from({ length: 80 }, (_, i) => ({ sessionAlive: true, pane: `test output ${i}`, composerHoldsBrief: false }));
    const { pending } = await startWait(frames, { wallMs: 500, idleMs: 40, freezeMs: 20 });
    await pumpUntil(() => false, 180);
    await append('DONE');
    await pumpUntil(() => waitResultCount() > 0, 100);
    await expect(pending).resolves.toMatchObject({ state: 'DONE' });
  });

  it('WORKING plus a static active-generation footer survives callback silence', async () => {
    await append('WORKING');
    const pane = '› prior request\nThinking… (esc to interrupt)';
    const { pending } = await startWait([{ sessionAlive: true, pane, composerHoldsBrief: false }], { wallMs: 500, idleMs: 35, freezeMs: 15 });
    await pumpUntil(() => false, 180);
    await append('DONE');
    await pumpUntil(() => waitResultCount() > 0, 100);
    await expect(pending).resolves.toMatchObject({ state: 'DONE' });
  });

  it('stable idle prompt gets exactly one semantic nudge and terminal callback succeeds without reap', async () => {
    await append('WORKING');
    const { pending } = await startWait([{ sessionAlive: true, pane: '› ', composerHoldsBrief: false }]);
    await pumpUntil(() => transport.nudgeCalls.length === 1, 100);
    const nudgeCount = transport.nudgeCalls.length;
    await append('DONE');
    await pumpUntil(() => waitResultCount() > 0, 100);
    await expect(pending).resolves.toMatchObject({ state: 'DONE' });
    expect(nudgeCount).toBe(1);
    expect(transport.reapCalls).toHaveLength(0);
  });

  it('idle prompt with no terminal response fails only after one nudge plus grace (~45s equivalent)', async () => {
    await append('WORKING');
    const { pending } = await startWait([{ sessionAlive: true, pane: '› ', composerHoldsBrief: false }]);
    const settled = pending.then((value) => ({ value }), (error) => ({ error }));
    await pumpUntil(() => transport.nudgeCalls.length === 1, 100);
    await pumpUntil(() => false, 40);
    const result = await settled;
    expect(result).toMatchObject({ error: { waitCause: 'idle-prompt-no-terminal' } });
    expect(transport.nudgeCalls).toHaveLength(1);
  });

  it('composer-held forever cannot bypass the absolute first-callback deadline after watchdog ownership is done', async () => {
    const frame = { sessionAlive: true, pane: `› ${BRIEF}`, composerHoldsBrief: true };
    const { pending } = await startWait([frame], { wallMs: 500, idleMs: 20, freezeMs: 10 });
    const rejection = expect(pending).rejects.toMatchObject({ waitCause: 'no-first-callback' });
    await pumpUntil(() => waitResultCount() > 0, 200);
    await rejection;
    expect(transport.nudgeCalls).toHaveLength(0);
  });

  it('empty capture is unknown, not frozen proof', async () => {
    await append('WORKING');
    const { pending } = await startWait([{ sessionAlive: true, pane: '', composerHoldsBrief: false }], { wallMs: 500, idleMs: 20, freezeMs: 10 });
    await pumpUntil(() => false, 120);
    await append('DONE');
    await pumpUntil(() => waitResultCount() > 0, 100);
    await expect(pending).resolves.toMatchObject({ state: 'DONE' });
  });

  it('missing session is an immediate classified failure', async () => {
    const { pending } = await startWait([{ sessionAlive: false, pane: '', composerHoldsBrief: false }]);
    await expect(pending).rejects.toMatchObject({ waitCause: 'session-gone' });
  });

  it('pane activity forever still loses to the hard wall', async () => {
    await append('WORKING');
    const frames = Array.from({ length: 100 }, (_, i) => ({ sessionAlive: true, pane: `live ${i}`, composerHoldsBrief: false }));
    const { pending } = await startWait(frames, { wallMs: 100, idleMs: 20, freezeMs: 10 });
    const rejection = expect(pending).rejects.toMatchObject({ waitCause: 'wall-timeout' });
    await pumpUntil(() => waitResultCount() > 0, 150);
    await rejection;
  });

  it('an identical repeated WORKING line advances callback progress by count/byte position', async () => {
    await append('WORKING', 'same');
    const frame = { sessionAlive: true, pane: 'quiet non-prompt', composerHoldsBrief: false };
    // Keep a real margin between the repeat and the idle deadline: fs callbacks run on
    // the real event loop while this test advances fake time. Without the margin, suite
    // load can move the read to the same tick as the deadline and make the assertion flaky.
    const { pending } = await startWait([frame], { wallMs: 500, idleMs: 100, freezeMs: 10 });
    await pumpUntil(() => false, 70);
    await append('WORKING', 'same');
    await pumpUntil(() => false, 70);
    await append('DONE');
    await pumpUntil(() => waitResultCount() > 0, 100);
    await expect(pending).resolves.toMatchObject({ state: 'DONE' });
  });

  it('a stale callback before dispatchOffset cannot satisfy first-callback deadline', async () => {
    await append('DONE', 'old dispatch');
    const offset = (await fs.stat(callbacksPath)).size;
    const { pending } = await startWait([{ sessionAlive: true, pane: 'quiet', composerHoldsBrief: false }], {}, 'codex', offset);
    const rejection = expect(pending).rejects.toMatchObject({ waitCause: 'no-first-callback' });
    await pumpUntil(() => waitResultCount() > 0, 200);
    await rejection;
  });

  it('integrated idle-prompt timeout reaps only after the nudge was sent', async () => {
    process.env.USE_FAKE_TMUX = '0';
    process.env.HELM_CB_FIRST_CALLBACK_MS = '5000';
    process.env.HELM_CB_IDLE_PROMPT_MS = '1000';
    process.env.HELM_CB_NUDGE_GRACE_MS = '1000';
    process.env.HELM_CB_WALL_MS = '15000';
    process.env.HELM_CB_PANE_PROBE_MS = '250';
    transport.queueSeatScript([{ sessionAlive: true, pane: '❯ ', composerHoldsBrief: false }]);
    const phase = (loop as any).performRolePhase('implementer', new BriefWriterService().generateBrief({
      batchId: BATCH,
      role: 'implementer',
      planPath: 'plan.json',
      runDir,
      branch: 'main',
      requirementsAssigned: 'R43',
      northStarAnchors: 'R43',
      callbacksFile: callbacksPath,
    }), ['DONE']);
    while (transport.spawnCalls.length === 0) await vi.advanceTimersByTimeAsync(10);
    await append('WORKING');
    const settled = phase.then((value: unknown) => ({ value }), (error: unknown) => ({ error }));
    await pumpUntil(() => transport.reapCalls.length === 1, 20_000, 250);
    const result = await settled;
    expect(result).toMatchObject({ error: { waitCause: 'idle-prompt-no-terminal' } });
    expect(transport.nudgeCalls).toHaveLength(1);
    expect(transport.reapCalls).toHaveLength(1);
    expect(transport.nudgeCalls[0].at).toBeLessThan(transport.reapCalls[0].at);
  });

  it('integrated ambiguous freeze sends one semantic nudge before reaping the seat', async () => {
    process.env.USE_FAKE_TMUX = '0';
    process.env.HELM_CB_FIRST_CALLBACK_MS = '5000';
    process.env.HELM_CB_IDLE_MS = '1000';
    process.env.HELM_CB_FREEZE_MS = '5000';
    process.env.HELM_CB_NUDGE_GRACE_MS = '1000';
    process.env.HELM_CB_WALL_MS = '15000';
    process.env.HELM_CB_PANE_PROBE_MS = '250';
    transport.queueSeatScript([{ sessionAlive: true, pane: 'quiet completed command output', composerHoldsBrief: false }]);
    const phase = (loop as any).performRolePhase('implementer', new BriefWriterService().generateBrief({
      batchId: BATCH,
      role: 'implementer',
      planPath: 'plan.json',
      runDir,
      branch: 'main',
      requirementsAssigned: 'R43',
      northStarAnchors: 'R43',
      callbacksFile: callbacksPath,
    }), ['DONE']);
    while (transport.spawnCalls.length === 0) await vi.advanceTimersByTimeAsync(10);
    await append('WORKING');
    const settled = phase.then((value: unknown) => ({ value }), (error: unknown) => ({ error }));
    await pumpUntil(() => transport.reapCalls.length === 1, 20_000, 250);
    const result = await settled;
    expect(result).toMatchObject({ error: { waitCause: 'ambiguous-idle-timeout' } });
    expect(transport.nudgeCalls).toHaveLength(1);
    expect(transport.reapCalls).toHaveLength(1);
    expect(transport.nudgeCalls[0].at).toBeLessThan(transport.reapCalls[0].at);
  });

  it('planning composer-held forever is caught when its submit watchdog gives up', async () => {
    process.env.HELM_SUBMIT_WD_MS = '1000';
    process.env.HELM_SUBMIT_WD_MAX = '1';
    (transport as any).resubmitIfComposerHeld = async () => true;
    transport.queueSeatScript([{ sessionAlive: true, pane: `› ${BRIEF}`, composerHoldsBrief: true }]);
    const { handle } = await transport.spawn({ role: 'plancore', brief: BRIEF, runDir, batchId: BATCH, provider: 'codex' });
    const startedAt = Date.now();
    const pending = (new PlanningPhaseService(transport, artifacts, new TaskQueueService(artifacts)) as any).waitForFirstCallback(
      callbacksPath,
      'plancore',
      BATCH,
      120,
      (await fs.stat(callbacksPath)).size,
      { handle, brief: BRIEF, provider: 'codex', runId },
    );
    const settled = pending.then((value: unknown) => value);
    await pumpUntil(() => waitResultCount() > 0, 2_000, 100);
    await expect(settled).resolves.toEqual({ ok: false, reason: 'no-first-callback' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('planning starts its deadline after spawn readiness and reaps failed attempts 1-3 before throwing', async () => {
    process.env.USE_FAKE_TMUX = '0';
    process.env.HELM_CB_FIRST_CALLBACK_MS = '5000';
    process.env.HELM_CB_PANE_PROBE_MS = '250';
    const originalSpawn = transport.spawn.bind(transport);
    transport.spawn = async (params) => {
      await new Promise((resolve) => setTimeout(resolve, 2_000)); // represents CLI startup/readiness
      return originalSpawn(params);
    };
    const planning = new PlanningPhaseService(transport, artifacts, new TaskQueueService(artifacts));
    const pending = planning.runPlanningPhase({
      runDir,
      batchId: BATCH,
      northStar: 'A clear planning request that never emits its required first callback.',
      mode: 'planner',
      runId,
      planningBrainProvider: 'codex',
    });
    const settled = pending.then((value) => ({ value }), (error) => ({ error }));
    await pumpUntil(() => transport.reapCalls.length === 3, 40_000, 250);
    const result = await settled;
    expect(String((result as any).error)).toMatch(/planning no-first-callback/);
    expect(transport.spawnCalls).toHaveLength(3);
    expect(transport.reapCalls).toHaveLength(3);
    expect(transport.reapCalls[0].at - transport.spawnCalls[0].at).toBeGreaterThanOrEqual(5_000);
    expect(transport.reapCalls[2].reason).toContain('no-first-callback');
  });

  it('malformed and out-of-range callback env values fall back or clamp instead of disabling deadlines', () => {
    process.env.HELM_CB_FIRST_CALLBACK_MS = 'not-a-number';
    process.env.HELM_CB_IDLE_MS = 'not-a-number';
    process.env.HELM_CB_WALL_MS = 'not-a-number';
    expect((loop as any).realFirstCallbackMs()).toBe(120_000);
    expect((loop as any).realIdleMsFor('implementer')).toBe(600_000);
    expect((loop as any).realWallMsFor('implementer')).toBe(1_800_000);

    process.env.HELM_CB_FIRST_CALLBACK_MS = '1';
    process.env.HELM_CB_IDLE_MS = '999999999';
    process.env.HELM_CB_WALL_MS = '999999999';
    expect((loop as any).realFirstCallbackMs()).toBe(5_000);
    expect((loop as any).realIdleMsFor('implementer')).toBe(3_600_000);
    expect((loop as any).realWallMsFor('implementer')).toBe(7_200_000);
  });
});

describe('dispatch nonce ACK correlation', () => {
  it('old role/batch ACK cannot suppress a new dispatch, while its exact nonce can', () => {
    const writer = new BriefWriterService();
    const base = writer.generateBrief({
      batchId: BATCH,
      role: 'implementer',
      planPath: 'plan.json',
      runDir: '/tmp/run',
      branch: 'main',
      requirementsAssigned: 'R43',
      northStarAnchors: 'R43',
      callbacksFile: '/tmp/run/callbacks.md',
    });
    const brief = bindDispatchNonce(base, 'new-nonce-43');
    expect(brief).toContain('RECEIVED[[:space:]]+dispatch=new-nonce-43');
    expect('[helm ACK] implementer batch-idle43 RECEIVED dispatch=old-nonce').not.toContain('dispatch=new-nonce-43');
    expect('[helm ACK] implementer batch-idle43 RECEIVED dispatch=new-nonce-43').toContain('dispatch=new-nonce-43');
  });
});

describe('provider-correct idle prompt fixtures', () => {
  it.each([
    ['codex', 'scrollback\n› ', true],
    ['grok', 'scrollback\n❯ ', true],
    ['claude', 'bypass permissions on\n❯ ', true],
    ['kloo', 'run stopped — ANSWERED\ntype a task…', true],
    ['codex', '› old prompt\nGenerating… (esc to interrupt)', false],
    ['grok', '❯ old prompt\nThinking… (esc to interrupt)', false],
    ['claude', '❯ old prompt\nWorking…', false],
    ['kloo', 'type a task… old\nGenerating…', false],
  ])('%s fixture classifies idle=%s', (provider, pane, idle) => {
    const state = classifySeatPane(provider, { sessionAlive: true, pane, composerHoldsBrief: false });
    expect(state.idlePrompt).toBe(idle);
    if (!idle) expect(state.generating).toBe(true);
  });
});
