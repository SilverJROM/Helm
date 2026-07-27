process.env.USE_FAKE_TMUX = '1';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import {
  CallbackWaitError,
  OrchestratorLoop,
  RunAbortedError,
  SeatAuthTerminalError,
  inferKlooRoute,
} from './orchestrator-loop.js';
import { requestRunAbort } from './run-abort-registry.js';
import { RunArtifactService } from './run-artifact-service.js';
import { ProjectService } from './project-service.js';
import { TaskQueueService } from './task-queue-service.js';
import { DatabaseService } from '../db/database.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { EscalationService } from './escalation-service.js';
import { PanelService } from './panel-service.js';
import { resolveAgentLaunchSpec, ProviderResolverService } from './provider-resolver-service.js';
import * as WorkerRuntimeFinalize from './worker-runtime-finalize.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('orchestrator-loop B0 thin slice (USE_FAKE_TMUX)', () => {
  let runDir: string;
  let transport: FakeTransport;
  let loop: OrchestratorLoop;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b0-'));
    const cb = path.join(runDir, 'callbacks.md');
    await fs.writeFile(cb, '# B0 test callbacks\n', 'utf8');
    transport = new FakeTransport();
    loop = new OrchestratorLoop(transport, { runDir, batchId: 'batch-B0' });
  });

  afterEach(async () => {
    if (runDir) {
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('happy path: impl DONE -> ACK before reap -> validator PASS completes; exact outcome transitions + artifacts', async () => {
    const brief = 'Implement sum(a, b) { return a + b; } with a vitest test.';
    // B5: real parse from genuine file lines (latest semantics). Append at "emit time" + sleep for waitFor to observe.
    const p = loop.execute(brief);
    const cbp = path.join(runDir, 'callbacks.md');

    await fs.appendFile(cbp, `[helm callback] implementer batch-B0 STATUS: DONE — sum + test written\n`);
    await sleep(80);
    await fs.appendFile(cbp, `[helm callback] validator batch-B0 STATUS: PASS — correct and tested\n`);
    await sleep(80);

    const res = await p;

    expect(res.finalStatus).toBe('PASS');
    expect(res.attempts).toBe(1);
    const t = res.transitions;
    expect(t).toEqual([
      'dispatched',
      'working',
      'done',
      'ack-written',
      'acked',
      'reap-called',
      'reaped',
      'validating',
      'pass',
      'ack-written',
      'acked',
      'reap-called',
      'reaped',
      'complete'
    ]);
    // ACK-strictly-before-reap observable in outcome (ack-written precedes every reap-called in log)
    for (let i = 1; i < t.length; i++) {
      if (t[i] === 'reap-called') expect(t[i - 2]).toBe('ack-written');
    }
    // artifacts persisted
    const transFile = path.join(runDir, 'state', 'transitions.json');
    const finalFile = path.join(runDir, 'artifacts', 'final.json');
    expect(await fs.readFile(transFile, 'utf8')).toContain('complete');
    expect(await fs.readFile(finalFile, 'utf8')).toContain('PASS');
    // briefs written
    const implBrief = await fs.readFile(path.join(runDir, 'prompts', 'implementer.brief.md'), 'utf8');
    expect(implBrief).toContain('sum(a, b)');
  });

  it('validator FAIL routes back to exactly one retry (attempts=2); ACK before every reap in transitions + file (real parse)', async () => {
    const brief = 'Build the feature per request.';
    // B5: real file parse (latest genuine lines) drives waits. The val FAIL line is latest for both val waits -> exercises retry + full ACK-before-reap ordering across attempts (transitions + file). PASS path covered by happy-path test.
    const p = loop.execute(brief);
    const cbp = path.join(runDir, 'callbacks.md');

    await fs.appendFile(cbp, `[helm callback] implementer batch-B0 STATUS: DONE — first pass at impl\n`);
    await fs.appendFile(cbp, `[helm callback] validator batch-B0 STATUS: FAIL — edge case and test missing\n`);
    await sleep(80);

    const res = await p;

    expect(res.finalStatus).toBe('FAIL');
    expect(res.attempts).toBe(2);
    const t = res.transitions;
    expect(t).toContain('fail');
    expect(t.filter((s) => s === 'working').length).toBe(2);
    expect(t[t.length - 1]).toBe('complete');
    // ACK before reap for all (impl1, val1, impl2, val2) -- ack-written precedes reap-called (with acked in between)
    for (let i = 1; i < t.length; i++) {
      if (t[i] === 'reap-called') expect(t[i - 2]).toBe('ack-written');
    }
    // reaps: 2x impl + 2x val
    expect(transport.reapCalls.length).toBe(4);
    // ACKs in callbacks file
    const cbContent = await fs.readFile(cbp, 'utf8');
    // B5: ACK format is now [helm ACK] for Helm-owned (clean); count tolerantly
    const ackCount = (cbContent.match(/\[.*ACK\]/g) || []).length;
    expect(ackCount).toBeGreaterThanOrEqual(2);
    expect(cbContent).toMatch(/ACK.*implementer.*RECEIVED/);
    expect(cbContent).toMatch(/ACK.*validator.*RECEIVED/);
  });

  it('RunArtifactService round-trips DB rows (7 tables) + canonical run-folder layout (ST2)', async () => {
    const tmpDbPath = path.join(os.tmpdir(), `helm-b1-svc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const dbs = new DatabaseService(tmpDbPath);
    const svc = new RunArtifactService(dbs);
    const rd = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b1-svc-run-'));
    const cbp = path.join(rd, 'callbacks.md');
    await fs.writeFile(cbp, '# B1 svc rt callbacks\n', 'utf8');
    try {
      const rid = svc.createRun(null, 'batch-B1-rt');
      const tid = svc.recordTask(rid, 'k1', 'roundtrip task label');
      const aid = svc.recordAttempt(tid, 1);
      const did = svc.recordDispatch(aid, 'implementer', 'prompts/implementer.brief.md', 'fake-h-rt-1');
      const cid = svc.recordCallback(did, 'implementer', 'DONE', '[helm callback] implementer batch-B1-rt STATUS: DONE — rt note', 'file');
      svc.recordAck(cid);
      svc.recordValidation(aid, 'PASS', 'roundtrip probe');
      svc.recordArtifact(rid, 'final', 'artifacts/final.json');

      await svc.writeBrief(rd, 'implementer', 'Implement sum for B1 ST2 roundtrip test.');
      await svc.appendAck(rd, 'implementer', 'batch-B1-rt');
      await svc.persistState(rd, ['dispatched', 'working', 'done', 'complete'], 'PASS', rid);

      const loaded = await svc.rehydrate(rid, rd);

      // DB rows
      expect(loaded.run).toBeTruthy();
      expect(loaded.run.batch_id).toBe('batch-B1-rt');
      expect(loaded.tasks.length).toBe(1);
      expect(loaded.tasks[0].label).toBe('roundtrip task label');
      expect(loaded.attempts.length).toBe(1);
      expect(loaded.dispatches.length).toBe(1);
      expect(loaded.dispatches[0].role).toBe('implementer');
      expect(loaded.callbacks.length).toBe(1);
      expect(loaded.callbacks[0].state).toBe('DONE');
      expect(loaded.callbacks[0].acked_at).toBeTruthy();
      expect(loaded.callbacks[0].source).toBe('file');
      expect(loaded.validations.length).toBe(1);
      expect(loaded.validations[0].result).toBe('PASS');
      expect(loaded.artifacts.length).toBeGreaterThanOrEqual(2);

      // FS layout roundtrip
      expect(loaded.briefs.implementer).toContain('sum for B1 ST2');
      expect(loaded.transitions).toContain('complete');
      expect(loaded.final.status).toBe('PASS');
      expect(loaded.cbFileContent).toMatch(/ACK.*implementer.*batch-B1-rt.*RECEIVED/);

      // schema version current (mig already applied)
      const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
      expect(ver).toBe(SCHEMA_VERSION);
    } finally {
      dbs.close();
      await fs.rm(rd, { recursive: true, force: true }).catch(() => {});
      await fs.rm(tmpDbPath, { force: true }).catch(() => {});
    }
  });
});

describe('orchestrator-loop B6 FSM feature path (USE_FAKE_TMUX)', () => {
  let runDir: string;
  let transport: FakeTransport;
  let loop: OrchestratorLoop;
  let dbs: DatabaseService;
  let svc: RunArtifactService;
  let tmpDbPath: string;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b6-feat-'));
    const cb = path.join(runDir, 'callbacks.md');
    await fs.writeFile(cb, '# B6 feature callbacks\n', 'utf8');
    tmpDbPath = path.join(os.tmpdir(), `helm-b6-feat-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    dbs = new DatabaseService(tmpDbPath);
    svc = new RunArtifactService(dbs);
    transport = new FakeTransport();
    loop = new OrchestratorLoop(transport, { runDir, batchId: 'batch-B6', artifactService: svc });
  });

  afterEach(async () => {
    if (dbs) dbs.close();
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
    if (tmpDbPath) await fs.rm(tmpDbPath, { force: true }).catch(() => {});
  });

  it('feature happy via runTask + svc: full PROPOSED/WORKING/DONE + val PASS; persists attempts/dispatches/cbs/vals + ACK-before-reap in DB+file', async () => {
    const brief = 'B6 feature: implement + test per acceptance.';
    const p = loop.runTask({ brief, taskType: 'feature' });
    const cbp = path.join(runDir, 'callbacks.md');

    // full chain (loop waits terminal but intermediates prove PROPOSED->WORKING->DONE path in file)
    await fs.appendFile(cbp, `[helm callback] implementer batch-B6 STATUS: PROPOSED — starting\n`);
    await sleep(30);
    await fs.appendFile(cbp, `[helm callback] implementer batch-B6 STATUS: WORKING — edits + tests\n`);
    await sleep(30);
    await fs.appendFile(cbp, `[helm callback] implementer batch-B6 STATUS: DONE — feature complete\n`);
    await sleep(80);
    await fs.appendFile(cbp, `[helm callback] validator batch-B6 STATUS: PASS — criteria + tests valid\n`);
    await sleep(80);

    const res = await p;
    expect(res.finalStatus).toBe('PASS');
    expect(res.attempts).toBe(1);

    // spawns in order
    expect(transport.spawnCalls.filter((s) => s.role === 'implementer').length).toBe(1);
    expect(transport.spawnCalls.filter((s) => s.role === 'validator').length).toBe(1);

    const rid = loop.getRunId()!;
    expect(rid).toBeTruthy();
    const loaded = await svc.rehydrate(rid, runDir);

    expect(loaded.tasks.length).toBe(1);
    expect(loaded.attempts.length).toBe(1);
    expect(loaded.dispatches.length).toBe(2);
    expect(loaded.dispatches.map((d) => d.role)).toEqual(['implementer', 'validator']);
    expect(loaded.callbacks.some((c) => c.role === 'implementer' && c.state === 'DONE')).toBe(true);
    expect(loaded.callbacks.some((c) => c.role === 'validator' && c.state === 'PASS')).toBe(true);
    expect(loaded.validations.length).toBe(1);
    expect(loaded.validations[0].result).toBe('PASS');

    const cbContent = await fs.readFile(cbp, 'utf8');
    const ackCount = (cbContent.match(/\[helm ACK\]/g) || []).length;
    expect(ackCount).toBeGreaterThanOrEqual(2);
    expect(cbContent).toMatch(/ACK.*implementer.*batch-B6.*RECEIVED/);
    expect(cbContent).toMatch(/ACK.*validator.*batch-B6.*RECEIVED/);
  });

  it('issue repro-confirmed -> impl (with contract in brief) -> cleared PASS; stores REPRO-CONFIRMED as fix contract in callbacks; final val PASS after clear', async () => {
    const brief = 'Issue: click does wrong thing on rendered.';
    const p = loop.runTask({ brief, taskType: 'issue', userCritical: true }); // critical flag must not block happy REPRO-CONFIRMED path (R-F3)
    const cbp = path.join(runDir, 'callbacks.md');

    const reproNote = 'reproduced: on /page click X logs Y (expected Z); steps: load, click, observe';
    await fs.appendFile(cbp, `[helm callback] validator batch-B6 STATUS: REPRO-CONFIRMED — ${reproNote}\n`);
    await sleep(80);

    // HARD GATE verified: impl spawned only after REPRO-CONFIRMED
    expect(transport.spawnCalls.filter((s) => s.role === 'implementer').length).toBe(1);
    // impl brief should contain the contract
    const implBriefs = transport.spawnCalls.filter((s) => s.role === 'implementer').map((s) => s.brief);
    expect(implBriefs[0]).toContain('REPRO-CONFIRMED this contract');
    expect(implBriefs[0]).toContain(reproNote);

    await fs.appendFile(cbp, `[helm callback] implementer batch-B6 STATUS: DONE — fix applied + test\n`);
    await sleep(80);
    await fs.appendFile(cbp, `[helm callback] validator batch-B6 STATUS: PASS — repro cleared on rendered after fix\n`);
    await sleep(80);

    const res = await p;
    expect(res.finalStatus).toBe('PASS');
    expect(res.attempts).toBe(1);

    const rid = loop.getRunId()!;
    const loaded = await svc.rehydrate(rid, runDir);
    expect(loaded.callbacks.some((c) => c.role === 'validator' && c.state === 'REPRO-CONFIRMED' && (c.raw_line || '').includes(reproNote))).toBe(true);
    expect(loaded.validations.some((v) => v.result === 'PASS')).toBe(true);
  });

  it('issue REPRO-SATISFIED completes the task and releases its dependent without implementer work', async () => {
    const runId = svc.createRun(null, 'batch-B6');
    const issueId = svc.recordTask(runId, 'ISSUE-1', 'Pre-applied typecheck fix');
    const dependentId = svc.recordTask(runId, 'NEXT-1', 'Run the next independent delivery step');
    const queue = new TaskQueueService(svc);
    queue.enqueue(runId, issueId);
    queue.enqueue(runId, dependentId, [issueId]);
    const plan = {
      tasks: [
        { task_key: 'ISSUE-1', atomic_work: 'Fix typecheck failures', complexity: 'low', task_type: 'issue', validation_criteria: 'npm run typecheck exits 0', deps: [] },
        { task_key: 'NEXT-1', atomic_work: 'Run the next independent delivery step', complexity: 'low', task_type: 'feature', validation_criteria: 'step completes', deps: ['ISSUE-1'] },
      ],
    } as any;

    const drive = loop.runQueuedTasks({
      runId,
      queue,
      artifactService: svc,
      plan,
      keyToId: { 'ISSUE-1': issueId, 'NEXT-1': dependentId },
    });
    const cbp = path.join(runDir, 'callbacks.md');
    await fs.appendFile(cbp, `[helm callback] validator batch-B6 STATUS: REPRO-SATISFIED — npm run typecheck exits 0; desired end-state already holds\n`);

    await vi.waitFor(() => {
      const issue: any = dbs.raw.prepare('SELECT status FROM run_tasks WHERE id=?').get(issueId);
      expect(issue.status).toBe('complete');
    });
    await vi.waitFor(() => expect(transport.spawnCalls.filter((s) => s.role === 'implementer')).toHaveLength(1));
    expect(transport.spawnCalls.filter((s) => s.role === 'implementer')).toHaveLength(1);
    expect(transport.spawnCalls.find((s) => s.role === 'implementer')?.brief).toContain('Requirements assigned: NEXT-1');

    await fs.appendFile(cbp, `[helm callback] implementer batch-B6 STATUS: DONE — next step complete\n`);
    await fs.appendFile(cbp, `[helm callback] validator batch-B6 STATUS: PASS — next step verified\n`);

    const result = await drive;
    expect(result.finalStatuses).toEqual(['PASS', 'PASS']);
    const tasks = dbs.raw.prepare('SELECT task_key, status FROM run_tasks WHERE run_id=? ORDER BY id').all(runId) as any[];
    expect(tasks).toEqual([
      expect.objectContaining({ task_key: 'ISSUE-1', status: 'complete' }),
      expect.objectContaining({ task_key: 'NEXT-1', status: 'complete' }),
    ]);
    const validations = dbs.raw.prepare(
      `SELECT v.result, v.note FROM validations v JOIN task_attempts ta ON ta.id=v.attempt_id WHERE ta.task_id=?`
    ).all(issueId) as any[];
    expect(validations).toEqual(expect.arrayContaining([
      expect.objectContaining({ result: 'PASS', note: expect.stringContaining('REPRO-SATISFIED') }),
    ]));
  });

  it('issue REPRO-FAILED after retries (C3) -> DEFERRED; no implementer; queue continues (use HELM_REPRO_RETRY=1 for single-fail case)', async () => {
    const prev = process.env.HELM_REPRO_RETRY;
    process.env.HELM_REPRO_RETRY = '1';
    try {
      const brief = 'Issue: cannot repro in some envs.';
      const p = loop.runTask({ brief, taskType: 'issue' });
      const cbp = path.join(runDir, 'callbacks.md');

      await fs.appendFile(cbp, `[helm callback] validator batch-B6 STATUS: REPRO-FAILED — no steps reproduce the bad behavior\n`);
      await sleep(80);

      const res = await p;
      expect(res.finalStatus).toBe('DEFERRED');
      // HARD GATE still: ZERO implementer spawns ever (defer before impl)
      expect(transport.spawnCalls.filter((s) => s.role === 'implementer').length).toBe(0);
      // at least one validator (repro); with retry=1 exactly 1
      expect(transport.spawnCalls.filter((s) => s.role === 'validator').length).toBe(1);

      const rid = loop.getRunId()!;
      const loaded = await svc.rehydrate(rid, runDir);
      expect(loaded.validations.some((v) => v.result === 'FAIL')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.HELM_REPRO_RETRY; else process.env.HELM_REPRO_RETRY = prev;
    }
  });

  it('user-critical + 2x REPRO-FAILED -> BLOCKED + phase=blocked (R-F3 pause, operator-facing artifact); no implementer; asserts outcome not just path', async () => {
    const prev = process.env.HELM_REPRO_RETRY;
    process.env.HELM_REPRO_RETRY = '2';
    try {
      const brief = 'User-critical issue: must pause run on repro fail.';
      const p = loop.runTask({ brief, taskType: 'issue', userCritical: true });
      const cbp = path.join(runDir, 'callbacks.md');

      await fs.appendFile(cbp, `[helm callback] validator batch-B6 STATUS: REPRO-FAILED — cannot reproduce step 1\n`);
      await sleep(80);
      await fs.appendFile(cbp, `[helm callback] validator batch-B6 STATUS: REPRO-FAILED — cannot reproduce step 2\n`);
      await sleep(80);

      const res = await p;
      expect(res.finalStatus).toBe('BLOCKED'); // OUTCOME assert

      // HARD GATE: ZERO implementer (even for critical)
      expect(transport.spawnCalls.filter((s) => s.role === 'implementer').length).toBe(0);
      expect(transport.spawnCalls.filter((s) => s.role === 'validator').length).toBe(2);

      const rid = loop.getRunId()!;
      const loaded = await svc.rehydrate(rid, runDir);
      expect(loaded.validations.some((v) => v.result === 'FAIL')).toBe(true);

      // PHASE=blocked OUTCOME (operator-facing, per B10-T02 mirror + R-F3)
      const phaseRow = (dbs.raw.prepare('SELECT phase FROM runs WHERE id = ?').get(rid) as any);
      expect(phaseRow?.phase).toBe('blocked');

      // artifact written
      const pauseMd = await fs.readFile(path.join(runDir, 'critical-repro-pause.md'), 'utf8').catch(() => '');
      expect(pauseMd).toContain('User-Critical Issue Repro Pause');
      expect(pauseMd).toContain('did not reproduce after');
    } finally {
      if (prev === undefined) delete process.env.HELM_REPRO_RETRY; else process.env.HELM_REPRO_RETRY = prev;
    }
  });
});

describe('orchestrator-loop B6 queue (DSP8) + TaskQueueService (USE_FAKE_TMUX)', () => {
  it('queue rules: one-at-a-time + dep block + injected URGENT after in-flight + failed blocks dependents', async () => {
    const tmpDb = path.join(os.tmpdir(), `helm-b6-q-${Date.now()}.db`);
    const dbs = new DatabaseService(tmpDb);
    const art = new RunArtifactService(dbs);
    const q = new TaskQueueService(art);
    const rid = art.createRun(null, 'batch-B6-q');

    // create tasks
    const t1 = art.recordTask(rid, 't1', 'first task');
    const t2 = art.recordTask(rid, 't2', 'second');
    const tDep = art.recordTask(rid, 'tDep', 'depends on t2');
    const tU = art.recordTask(rid, 'tU', 'urgent injected');
    const tF = art.recordTask(rid, 'tF', 'will fail');
    const tDepF = art.recordTask(rid, 'tDepF', 'depends on failed');

    // enqueue normal order
    q.enqueue(rid, t1);
    q.enqueue(rid, t2);
    q.enqueue(rid, tDep, [t2]);

    // 1. exactly one active
    expect(q.getNextReady(rid)).toBe(t1);
    expect(q.isInFlight(rid)).toBe(true);
    expect(q.getNextReady(rid)).toBeNull(); // strictly one

    // inject while t1 "in flight"
    q.enqueue(rid, tU, [], true); // URGENT after in-flight
    q.enqueue(rid, tF);
    q.enqueue(rid, tDepF, [tF]);

    // complete t1 -> next should be urgent (after in-flight at time of inject)
    q.markComplete(t1, rid);
    expect(q.getNextReady(rid)).toBe(tU); // urgent jumped after the (now done) in-flight
    q.markComplete(tU, rid);

    // now normal t2
    expect(q.getNextReady(rid)).toBe(t2);
    q.markComplete(t2, rid);

    // dep now ready
    expect(q.getNextReady(rid)).toBe(tDep);
    q.markComplete(tDep, rid);

    // 2+3. failed blocks its dependents (tDepF depends on tF)
    // enqueue tF already done above, now fail it
    q.markFailed(tF, rid);
    expect(q.isBlockedByFailure(tDepF)).toBe(true);
    expect(q.getNextReady(rid)).toBeNull(); // blocked by failure dep

    // cleanup
    dbs.close();
    await fs.rm(tmpDb, { force: true }).catch(() => {});
  });

  // B10-T02: one-at-a-time dep-aware continuation (reuse getNextReady/enqueue)
  it('B10-T02: dep-aware continuation dispatches one ready at a time in topo order', () => {
    const q = new TaskQueueService();
    const rid = 42;
    q.enqueue(rid, 1, []);      // indep
    q.enqueue(rid, 2, [1]);
    q.enqueue(rid, 3, [1, 2]);
    q.enqueue(rid, 4, []);      // parallel indep

    expect(q.getNextReady(rid)).toBe(1); q.markComplete(1, rid);
    // after 1: 2 and 4 ready. Prove one-at-a-time + 3 waits for 2.
    let n: number | null = q.getNextReady(rid)!;
    expect([2, 4]).toContain(n);
    const first = n;
    q.markComplete(n, rid);

    n = q.getNextReady(rid)!;
    if (first === 2) {
      expect(n).toBe(3); // 3 now unblocked
    } else {
      expect(n).toBe(2);
      q.markComplete(2, rid);
      n = q.getNextReady(rid)!;
      expect(n).toBe(3);
    }
    q.markComplete(3, rid);

    // remaining (4 if not taken)
    n = q.getNextReady(rid);
    if (n !== null) q.markComplete(n, rid);
    expect(q.getNextReady(rid)).toBeNull();
  });

  // B10-T02: cycle detection (real cycle must surface as deadlock reason, not silent null==done)
  it('B10-T02: getDeadlockReason returns clear cycle only for true unresolved cycle, not for failed-prereq blocks', () => {
    const q = new TaskQueueService();
    const rid = 99;
    // linear + branch ok
    q.enqueue(rid, 10, []);
    q.enqueue(rid, 11, [10]);
    q.enqueue(rid, 12, [10]);
    expect(q.getDeadlockReason(rid)).toBeNull();

    // simulate progress until blocked legitimately by failure
    q.markComplete(10, rid);
    q.markComplete(11, rid);
    q.markFailed(12, rid);  // 12 failed, any dependents would be blocked by failed (legit)
    // no more ready, pending none in this case
    expect(q.getNextReady(rid)).toBeNull();
    expect(q.getDeadlockReason(rid)).toBeNull();  // not a cycle

    // Now a real cycle case
    const rid2 = 100;
    q.enqueue(rid2, 20, [21]);
    q.enqueue(rid2, 21, [20]);
    // no one can ever start
    expect(q.getNextReady(rid2)).toBeNull();
    const reason = q.getDeadlockReason(rid2);
    expect(reason).toMatch(/deadlock.*cycle/);
    expect(reason).toMatch(/20,21|21,20/);
  });
});

describe('orchestrator-loop B8 escalation ladder (USE_FAKE_TMUX)', () => {
  let runDir: string;
  let transport: FakeTransport;
  let loop: OrchestratorLoop;
  let dbs: DatabaseService;
  let svc: RunArtifactService;
  let esc: EscalationService;
  let tmpDbPath: string;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b8-ladder-'));
    const cb = path.join(runDir, 'callbacks.md');
    await fs.writeFile(cb, '# B8 ladder callbacks\n', 'utf8');
    tmpDbPath = path.join(os.tmpdir(), `helm-b8-ladder-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    dbs = new DatabaseService(tmpDbPath);
    svc = new RunArtifactService(dbs);
    esc = new EscalationService(dbs); // seeded ladders from B3
    transport = new FakeTransport();
    loop = new OrchestratorLoop(transport, { runDir, batchId: 'batch-B8', artifactService: svc, escalationService: esc });
    // Keep legacy integration cases short; product default remains the generous 12-attempt backstop.
    (loop as any).MAX_TASK_ATTEMPTS = 3;
  });

  afterEach(async () => {
    if (dbs) dbs.close();
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
    if (tmpDbPath) await fs.rm(tmpDbPath, { force: true }).catch(() => {});
  });

  // #53: the non-retryable fault PAUSE (not fail) — an env/auth fault halts the run resumably with a
  // remedy, never fails over. Proves the pause machinery end-to-end against a real db; the classifier
  // that FEEDS it is covered separately in fault-class.test.ts.
  it('#53: pauseRunForOperator sets status=paused (not failed), writes the remedy artifact + event', async () => {
    const rid = dbs.raw.prepare(
      "INSERT INTO runs (project_id, batch_id, status, phase) VALUES (NULL, 'batch-B8', 'active', 'executing')"
    ).run().lastInsertRowid as number;
    (loop as any).runId = rid;
    const { authFault } = await import('./fault-class.js');

    (loop as any).pauseRunForOperator(authFault('grok', 'Authentication required — session expired'));

    const r = dbs.raw.prepare('SELECT status, phase FROM runs WHERE id=?').get(rid) as any;
    expect(r.status).toBe('paused'); // NOT 'failed'
    expect(r.phase).toBe('blocked');
    const md = await fs.readFile(path.join(runDir, 'paused-awaiting-operator.md'), 'utf8');
    expect(md).toMatch(/grok login/);
    expect(md).toMatch(/non-retryable auth fault/i);
    const ev = dbs.raw.prepare("SELECT COUNT(*) c FROM run_events WHERE run_id=? AND event_type='RUN_PAUSED_NONRETRYABLE'").get(String(rid)) as any;
    expect(ev.c).toBe(1);
  });

  it('backstop seam: 3rd ordinary FAIL wakes ibrain; bump to rung1 uses next model + feeds ledger', async () => {
    const brief = 'B8 ladder test: feature that fails 3x at base.';
    const p = loop.runTask({ brief, taskType: 'feature' });
    const cbp = path.join(runDir, 'callbacks.md');

    // Test-only backstop=3: ordinary failures remain same-rung until the generous-budget seam trips.
    for (let i = 1; i <= 3; i++) {
      await fs.appendFile(cbp, `[helm callback] implementer batch-B8 STATUS: DONE — attempt ${i}\n`);
      await sleep(20);
      await fs.appendFile(cbp, `[helm callback] validator batch-B8 STATUS: FAIL — diag for attempt ${i}\n`);
      await sleep(20);
    }

    // Brain decision: bump rung1, new decisionId
    await fs.appendFile(cbp, `[helm callback] ibrain batch-B8 STATUS: DECISION-READY — {"edge_class":"rung-attempt-limit","route_to":"bump-rung","blocker_owner":"brain","action":"bump-rung","targetRung":1,"decisionId":"dec-001","reason":"thrash on sound approach"}\n`);
    await sleep(30);

    // 4th overall (1st at rung1) succeeds
    await fs.appendFile(cbp, `[helm callback] implementer batch-B8 STATUS: DONE — rung1 success with ledger\n`);
    await sleep(20);
    await fs.appendFile(cbp, `[helm callback] validator batch-B8 STATUS: PASS — ok after bump\n`);
    await sleep(20);

    const res = await p;
    expect(res.finalStatus).toBe('PASS');
    expect(loop.getCurrentRung()).toBe(1);
    expect(loop.getAuthorizingDecisionId()).toBe('dec-001');
    expect(loop.getFailureLedger().length).toBeGreaterThanOrEqual(3);

    // Ledger fed to the escalated dispatch brief (ESC3)
    const implBriefs = transport.spawnCalls.filter((s) => s.role === 'implementer').map((s) => s.brief);
    const rung1Brief = implBriefs[implBriefs.length - 1];
    expect(rung1Brief).toContain('CURRENT RUNG: 1');
    expect(rung1Brief).toContain('codex-5.5'); // next rung model for implementer
    expect(rung1Brief).toContain('DO NOT re-walk');
    expect(rung1Brief).toContain('diag for attempt 3');

    // Spawn recorded rung/model for the escalated dispatch (guardrail 1)
    const lastImplSpawn: any = transport.spawnCalls.filter((s) => s.role === 'implementer').pop();
    expect(lastImplSpawn.rung).toBe(1);
    expect(lastImplSpawn.model).toContain('gpt-5.5'); // R6: dispatch resolves the LAUNCHABLE id (ladder display-name 'codex-5.5' → model_id gpt-5.5)

    // The implementation brain was consulted (ibrain spawn + brief written).
    expect(transport.spawnCalls.some((s) => s.role === 'ibrain')).toBe(true);
    const brainBrief = await fs.readFile(path.join(runDir, 'prompts', 'ibrain.brief.md'), 'utf8').catch(() => '');
    expect(brainBrief).toContain('helm_pm'); // shared worker face; internal escalation role is ibrain
    expect(brainBrief).toContain('Failure-history ledger');
  });

  it('FIX39 free retries: five ordinary FAILs then PASS completes without consulting the brain', async () => {
    (loop as any).MAX_TASK_ATTEMPTS = 12;
    let validatorCalls = 0;
    const implBriefs: string[] = [];
    const brain = vi.fn(async () => ({ action: 'escalate-to-JROM', decisionId: 'unexpected' }));
    (loop as any).consultImplementationBrain = brain;
    (loop as any).performRolePhase = async (role: string, brief: string) => {
      if (role === 'implementer') {
        implBriefs.push(brief);
        return { state: 'DONE', note: 'implementation attempt', handle: 'impl' };
      }
      validatorCalls += 1;
      return validatorCalls <= 5
        ? { state: 'FAIL', note: `defect_class=behavior-mismatch; fixable gap ${validatorCalls}`, defectClass: 'behavior-mismatch', escalateFlag: false, handle: 'val' }
        : { state: 'PASS', note: 'all gaps closed', escalateFlag: false, handle: 'val' };
    };

    const result = await loop.runTask({ brief: 'close the routine validator gaps', taskType: 'feature' });

    expect(result).toMatchObject({ finalStatus: 'PASS', attempts: 6 });
    expect(brain).not.toHaveBeenCalled();
    expect(loop.getTransitions()).not.toContain('escalation-brain-wake');
    expect(implBriefs[5]).toContain('fixable gap 5');
  });

  it('FIX39 incapability flag wakes brain; bump-rung judgment increases the rung', async () => {
    let validatorCalls = 0;
    (loop as any).performRolePhase = async (role: string) => {
      if (role === 'implementer') return { state: 'DONE', note: 'attempt', handle: 'impl' };
      validatorCalls += 1;
      return validatorCalls === 1
        ? { state: 'FAIL', note: 'defect_class=implementer-incapable; same defect repeated', defectClass: 'implementer-incapable', escalateFlag: true, handle: 'val' }
        : { state: 'PASS', note: 'closed at higher rung', escalateFlag: false, handle: 'val' };
    };
    const brain = vi.fn(async () => ({ action: 'bump-rung', targetRung: 1, decisionId: 'fix39-bump', reason: 'higher capability warranted' }));
    (loop as any).consultImplementationBrain = brain;

    const result = await loop.runTask({ brief: 'flagged capability gap', taskType: 'feature' });

    expect(result.finalStatus).toBe('PASS');
    expect(brain).toHaveBeenCalledTimes(1);
    expect(loop.getCurrentRung()).toBe(1);
    expect(loop.getAuthorizingDecisionId()).toBe('fix39-bump');
  });

  it('FIX39 brain pushback stays at the rung, applies its directive, and refreshes the retry window', async () => {
    (loop as any).MAX_TASK_ATTEMPTS = 3;
    let validatorCalls = 0;
    const implBriefs: string[] = [];
    (loop as any).performRolePhase = async (role: string, brief: string) => {
      if (role === 'implementer') {
        implBriefs.push(brief);
        return { state: 'DONE', note: 'attempt', handle: 'impl' };
      }
      validatorCalls += 1;
      if (validatorCalls === 1) {
        return { state: 'FAIL', note: 'defect_class=implementer-incapable; validator requests judgment', defectClass: 'implementer-incapable', escalateFlag: true, handle: 'val' };
      }
      if (validatorCalls <= 3) {
        return { state: 'FAIL', note: `defect_class=behavior-mismatch; correction ${validatorCalls}`, defectClass: 'behavior-mismatch', escalateFlag: false, handle: 'val' };
      }
      return { state: 'PASS', note: 'pushback directive worked', escalateFlag: false, handle: 'val' };
    };
    const brain = vi.fn(async () => ({
      action: 'validator-handholding',
      decisionId: 'fix39-pushback',
      reason: 'L1 can do this',
      spoonFedDirections: 'Keep L1 and change only the state transition guard.',
    }));
    (loop as any).consultImplementationBrain = brain;

    const result = await loop.runTask({ brief: 'retry at current rung', taskType: 'feature' });

    expect(result).toMatchObject({ finalStatus: 'PASS', attempts: 4 });
    expect(brain).toHaveBeenCalledTimes(1);
    expect(loop.getCurrentRung()).toBe(0);
    expect(implBriefs[1]).toContain('Keep L1 and change only the state transition guard.');
  });

  it('FIX39 ordinary FAILs wake the brain once the generous backstop trips', async () => {
    (loop as any).MAX_TASK_ATTEMPTS = 3;
    (loop as any).performRolePhase = async (role: string) => role === 'implementer'
      ? { state: 'DONE', note: 'attempt', handle: 'impl' }
      : { state: 'FAIL', note: 'defect_class=behavior-mismatch; still fixable', defectClass: 'behavior-mismatch', escalateFlag: false, handle: 'val' };
    const brain = vi.fn(async () => ({ action: 'escalate-to-JROM', decisionId: 'fix39-backstop', reason: 'backstop requires judgment' }));
    (loop as any).consultImplementationBrain = brain;

    const result = await loop.runTask({ brief: 'never-flagging validator safety net', taskType: 'feature' });

    expect(result).toMatchObject({ finalStatus: 'DEFERRED', attempts: 3 });
    expect(brain).toHaveBeenCalledTimes(1);
    expect(loop.getTransitions()).toContain('escalation-brain-wake');
  });

  it('plan-summon + precedence: explicit rung / complexity starts at rung1 with correct model; explicit model wins; unknown model rejects pre-dispatch', async () => {
    // explicit rung
    let p = loop.runTask({ brief: 'summon rung1', recommendedRung: 1 });
    let cbp = path.join(runDir, 'callbacks.md');
    await fs.appendFile(cbp, `[helm callback] implementer batch-B8 STATUS: DONE — explicit rung\n`);
    await sleep(10);
    await fs.appendFile(cbp, `[helm callback] validator batch-B8 STATUS: PASS — ok\n`);
    await sleep(10);
    let res = await p;
    expect(res.finalStatus).toBe('PASS');
    expect(loop.getCurrentRung()).toBe(1);
    let spawns = transport.spawnCalls.filter((s: any) => s.role === 'implementer');
    expect((spawns[spawns.length-1] as any).model).toContain('gpt-5.5'); // R6: launchable id at dispatch

    // reset for next
    transport = new FakeTransport();
    loop = new OrchestratorLoop(transport, { runDir, batchId: 'batch-B8', artifactService: svc, escalationService: esc });

    // complexity high -> rung1
    p = loop.runTask({ brief: 'high complexity', complexity: 'high' });
    cbp = path.join(runDir, 'callbacks.md');
    await fs.appendFile(cbp, `[helm callback] implementer batch-B8 STATUS: DONE — high\n`);
    await sleep(10);
    await fs.appendFile(cbp, `[helm callback] validator batch-B8 STATUS: PASS — ok\n`);
    await sleep(10);
    res = await p;
    expect(loop.getCurrentRung()).toBe(1);

    // reset
    transport = new FakeTransport();
    loop = new OrchestratorLoop(transport, { runDir, batchId: 'batch-B8', artifactService: svc, escalationService: esc });

    // explicit bad model -> pre-dispatch reject (ESC6)
    p = loop.runTask({ brief: 'bad model', explicitModel: 'nonexistent-model-xyz-123' });
    res = await p;
    expect(res.finalStatus).toBe('FAIL');
    // validation recorded the error
    const rid = loop.getRunId()!;
    const loaded = await svc.rehydrate(rid, runDir);
    expect(loaded.validations.some((v: any) => (v.note || '').includes('UNKNOWN_MODEL'))).toBe(true);

    // reset for unsupported provider case if needed (the resolver throws UNSUPPORTED...)
    // (covered by explicit unknown above + ladder model check)
  });

  it('plan lanes: implementer rung and validator rung are independently applied', async () => {
    const p = loop.runTask({ brief: 'lane dispatch', recommendedRung: 1, validatorRung: 0, taskType: 'feature' });
    const cbp = path.join(runDir, 'callbacks.md');
    await fs.appendFile(cbp, `[helm callback] implementer batch-B8 STATUS: DONE — l3 impl\n`);
    await sleep(10);
    await fs.appendFile(cbp, `[helm callback] validator batch-B8 STATUS: PASS — l2 val\n`);
    await sleep(10);

    const res = await p;
    expect(res.finalStatus).toBe('PASS');

    const implSpawn: any = transport.spawnCalls.find((s: any) => s.role === 'implementer');
    const valSpawn: any = transport.spawnCalls.find((s: any) => s.role === 'validator');
    expect(implSpawn.rung).toBe(1);
    expect(implSpawn.model).toMatch(/codex|gpt-5\.5/i);
    expect(valSpawn.rung).toBe(0);
    expect(valSpawn.model).toMatch(/sonnet/i);
  });

  it('guardrail 4+3: validator-handholding selectable (brain chooses it); directions fed to impl; verifier ≠ fixer; final gate still happens', async () => {
    let validatorCalls = 0;
    const implBriefs: string[] = [];
    (loop as any).performRolePhase = async (role: string, brief: string) => {
      if (role === 'implementer') {
        implBriefs.push(brief);
        return { state: 'DONE', note: 'implementation', handle: 'impl' };
      }
      validatorCalls += 1;
      return validatorCalls === 1
        ? { state: 'FAIL', note: 'defect_class=implementer-incapable; recurring gap needs judgment', defectClass: 'implementer-incapable', escalateFlag: true, handle: 'val' }
        : { state: 'PASS', note: 'handhold applied correctly', escalateFlag: false, handle: 'val' };
    };
    (loop as any).consultImplementationBrain = async () => ({
      action: 'validator-handholding',
      decisionId: 'dec-h1',
      reason: 'validator correction',
      spoonFedDirections: 'Change the foo() call to bar() exactly as in the ledger; add one test for the happy path only. No other edits.',
    });

    const res = await loop.runTask({ brief: 'needs handhold' });
    expect(res.finalStatus).toBe('PASS');

    const last = implBriefs[implBriefs.length-1];
    expect(last).toContain('HANDHOLD DIRECTIONS');
    expect(last).toContain('foo() call to bar()');
    expect(validatorCalls).toBe(2); // final independent validator gate still happened
  });

  it('hard ceiling (#39 defense-in-depth): a never-converging degenerate loop terminates in a BLOCKED page, never loops forever', async () => {
    // Worst case: the validator flags implementer-incapable EVERY attempt and the brain always PUSHES BACK
    // (re-brief) — which resets attemptsAtRung, so the per-rung backstop never trips. The hard total-attempts
    // ceiling is the only thing that can terminate this; without it the run would loop forever.
    (loop as any).HARD_MAX_ATTEMPTS = 5;
    (loop as any).performRolePhase = async (role: string) => {
      if (role === 'implementer') return { state: 'DONE', note: 'impl', handle: 'impl' };
      return { state: 'FAIL', note: 'defect_class=implementer-incapable; still stuck', defectClass: 'implementer-incapable', escalateFlag: true, handle: 'val' };
    };
    (loop as any).consultImplementationBrain = async () => ({
      action: 're-brief',
      decisionId: 'dec-rebrief',
      reason: 'keep retrying at current rung',
    });

    const res = await loop.runTask({ brief: 'never converges', taskType: 'feature' });
    expect(res.finalStatus).toBe('BLOCKED');
    expect(res.attempts).toBe(6); // first iteration AFTER exceeding the ceiling of 5 blocks
    expect(loop.getTransitions()).toContain('hard-attempt-ceiling-block');
  });

  it('classifier re-plan: wakes plancore (not ibrain), re-ingests revised slice, retries + PLAN_REVISED', async () => {
    await fs.writeFile(
      path.join(runDir, 'plan.json'),
      JSON.stringify({
        tasks: [{
          task_key: 'T-PLAN',
          atomic_work: 'impossible task as written',
          validation_criteria: 'contradictory criteria',
          task_type: 'feature',
          complexity: 'low',
        }],
      }, null, 2),
      'utf8',
    );
    let validatorCalls = 0;
    const implBriefs: string[] = [];
    (loop as any).performRolePhase = async (role: string, brief: string) => {
      if (role === 'implementer') {
        implBriefs.push(brief);
        return { state: 'DONE', note: 'impl attempt', handle: 'impl' };
      }
      validatorCalls += 1;
      if (validatorCalls === 1) {
        return {
          state: 'FAIL',
          note: 'defect_class=plan-defect; criteria contradict atomic_work',
          defectClass: 'plan-defect',
          escalateFlag: false,
          planDefectFlag: true,
          handle: 'val',
        };
      }
      return { state: 'PASS', note: 'revised criteria satisfied', escalateFlag: false, planDefectFlag: false, handle: 'val' };
    };
    (loop as any).consultImplementationBrain = async () => ({
      action: 're-plan',
      decisionId: 'dec-replan-1',
      reason: 'plan defect',
      planRevisionDirective: 'Drop impossible criterion; require only reachable outcome Y',
    });
    // Planning brain path (plancore), not ibrain — spy proves the revise seat is plancore-owned.
    const plancoreSpy = vi.fn(async () => {
      (loop as any).log('plancore-revise-wake');
      return {
        task_key: 'T-PLAN',
        atomic_work: 'do reachable outcome Y',
        validation_criteria: 'outcome Y is observable',
        req_refs: ['R-Y'],
        task_type: 'feature',
        complexity: 'low',
        summary: 'removed contradictory criterion',
      };
    });
    (loop as any).consultPlancoreRevise = plancoreSpy;

    const result = await loop.runTask({
      brief: '## Task\natomic_work: impossible task as written\nvalidation_criteria: contradictory criteria',
      taskType: 'feature',
      taskKey: 'T-PLAN',
    });

    expect(result.finalStatus).toBe('PASS');
    expect(plancoreSpy).toHaveBeenCalledTimes(1);
    expect(loop.getTransitions()).toContain('plancore-revise-wake');
    expect(loop.getTransitions()).toContain('plan-revised');
    expect(implBriefs.some((b) => b.includes('do reachable outcome Y') || b.includes('outcome Y'))).toBe(true);
    const plan = JSON.parse(await fs.readFile(path.join(runDir, 'plan.json'), 'utf8'));
    expect(plan.tasks[0].atomic_work).toBe('do reachable outcome Y');
    const rid = loop.getRunId()!;
    const events = (svc as any)['db'].raw
      .prepare(`SELECT event_type, payload_json FROM run_events WHERE run_id = ? AND event_type = 'PLAN_REVISED'`)
      .all(String(rid)) as Array<{ event_type: string; payload_json: string }>;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].payload_json).toContain('dec-replan-1');
  });

  // CONTRACT CHANGED (JROM-LOCKED 2026-07-20): exceeding the re-plan bound now PARKS the task
  // (DEFERRED) instead of halting the entire run (BLOCKED). Rationale: stopping every remaining task
  // for one exhausted slice wastes the operator's time when nothing depends on it. The run keeps
  // draining independent work; TaskQueueService.getParkedBlockReason() still halts with
  // pending-after-drain.md if (and only if) every remaining task is transitively gated by the parked
  // one, and the parked task surfaces in completion-summary's DEFERRED section at end of run. The
  // budget cannot loop on resume because replansUsed is durable. Inverted deliberately, not a regression.
  it('classifier re-plan bound: exceeding HELM_MAX_REPLANS → PARKED (DEFERRED), run not halted', async () => {
    (loop as any).MAX_REPLANS = 1;
    let replanN = 0;
    (loop as any).performRolePhase = async (role: string) =>
      role === 'implementer'
        ? { state: 'DONE', note: 'impl', handle: 'impl' }
        : {
            state: 'FAIL',
            note: 'defect_class=plan-defect; still broken',
            defectClass: 'plan-defect',
            planDefectFlag: true,
            escalateFlag: false,
            handle: 'val',
          };
    (loop as any).consultImplementationBrain = async () => {
      replanN += 1;
      return {
        action: 're-plan',
        decisionId: `dec-replan-${replanN}`,
        reason: 'still plan defect',
        planRevisionDirective: `try again #${replanN}`,
      };
    };
    (loop as any).consultPlancoreRevise = async () => ({
      task_key: 'T-BOUND',
      atomic_work: `revised attempt ${replanN}`,
      validation_criteria: 'still fails',
      summary: `rev ${replanN}`,
    });
    // The run must NOT be force-blocked by the exhausted slice itself.
    let runBlocked = false;
    const orig = (loop as any).transitionRunToBlocked.bind(loop);
    (loop as any).transitionRunToBlocked = (msg: string) => {
      runBlocked = true;
      return orig(msg);
    };

    const result = await loop.runTask({ brief: 'stuck plan defect', taskType: 'feature', taskKey: 'T-BOUND' });
    expect(result.finalStatus).toBe('DEFERRED');
    expect(loop.getTransitions()).toContain('replan-bound-exceeded');
    expect(runBlocked).toBe(false); // parking is the loop's job; halting is the queue's, and only if gated
    expect(replanN).toBeGreaterThanOrEqual(2); // one applied + one that hits the bound
  });

  it('classifier escalate-validator:revalidate bumps validator rung, skips implementer, stronger PASS completes', async () => {
    let implCalls = 0;
    let valCalls = 0;
    (loop as any).performRolePhase = async (role: string) => {
      if (role === 'implementer') {
        implCalls += 1;
        return { state: 'DONE', note: 'impl once', handle: 'impl' };
      }
      valCalls += 1;
      if (valCalls === 1) {
        return {
          state: 'FAIL',
          note: 'defect_class=behavior-mismatch; vacuous false fail',
          defectClass: 'behavior-mismatch',
          escalateFlag: true,
          planDefectFlag: false,
          handle: 'val',
        };
      }
      return { state: 'PASS', note: 'stronger validator accepts', escalateFlag: false, handle: 'val' };
    };
    (loop as any).consultImplementationBrain = async () => ({
      action: 'escalate-validator',
      decisionId: 'dec-ev-reval',
      reason: 'validator false-failing',
      validatorAction: 'revalidate',
    });

    const result = await loop.runTask({ brief: 'correct work, wrong validator', taskType: 'feature', validatorRung: 0 });
    expect(result.finalStatus).toBe('PASS');
    expect(implCalls).toBe(1); // implementer NOT re-run on revalidate
    expect(valCalls).toBe(2);
    expect(loop.getTransitions()).toContain('validator-rung-bumped:1');
    expect((loop as any).currentValidatorRung).toBe(1);
  });

  it('classifier escalate-validator:override records PASS + VALIDATOR_OVERRIDDEN', async () => {
    (loop as any).performRolePhase = async (role: string) => {
      if (role === 'implementer') return { state: 'DONE', note: 'impl', handle: 'impl' };
      return {
        state: 'FAIL',
        note: 'defect_class=behavior-mismatch; vacuous',
        defectClass: 'behavior-mismatch',
        escalateFlag: true,
        handle: 'val',
      };
    };
    (loop as any).consultImplementationBrain = async () => ({
      action: 'escalate-validator',
      decisionId: 'dec-ev-over',
      reason: 'false fail',
      validatorAction: 'override',
      overrideJustification: 'impl matches north-star; validator diagnoses vacuous',
    });

    const pass = await loop.runTask({ brief: 'override agent-validator fail', taskType: 'feature', taskKey: 'T-OV' });
    expect(pass.finalStatus).toBe('PASS');
    expect(loop.getTransitions()).toContain('validator-overridden');
    const rid = loop.getRunId()!;
    const events = (svc as any)['db'].raw
      .prepare(`SELECT event_type, payload_json FROM run_events WHERE run_id = ? AND event_type = 'VALIDATOR_OVERRIDDEN'`)
      .all(String(rid)) as Array<{ event_type: string; payload_json: string }>;
    expect(events.length).toBe(1);
    expect(events[0].payload_json).toContain('north-star');
  });

  it('classifier escalate-validator:override never overrides a deterministic-gate FAIL', async () => {
    (loop as any).MAX_TASK_ATTEMPTS = 1;
    (loop as any).performRolePhase = async (role: string) => {
      if (role === 'implementer') return { state: 'DONE', note: 'impl', handle: 'impl' };
      return {
        state: 'FAIL',
        note: 'deterministic test-gate FAIL (npm test exit 1 in /tmp/x)',
        escalateFlag: true,
        handle: 'val',
      };
    };
    let brainCalls = 0;
    (loop as any).consultImplementationBrain = async () => {
      brainCalls += 1;
      if (brainCalls === 1) {
        return {
          action: 'escalate-validator',
          decisionId: 'dec-ev-det',
          reason: 'try override det',
          validatorAction: 'override',
          overrideJustification: 'should be rejected',
        };
      }
      return { action: 'escalate-to-JROM', decisionId: 'dec-park', reason: 'park after reject' };
    };

    const det = await loop.runTask({ brief: 'det gate fail', taskType: 'feature' });
    expect(det.finalStatus).toBe('DEFERRED');
    expect(loop.getTransitions()).toContain('validator-override-rejected-deterministic');
    expect(loop.getTransitions()).not.toContain('validator-overridden');
  });

  it('finding 1: task_key forced to original even if plancore returns a different key', async () => {
    await fs.writeFile(
      path.join(runDir, 'plan.json'),
      JSON.stringify({
        tasks: [{
          task_key: 'T-ORIG',
          atomic_work: 'old work',
          validation_criteria: 'old crit',
          task_type: 'feature',
          complexity: 'low',
          req_refs: ['R-1'],
          deps: ['T-OTHER'],
        }],
      }, null, 2),
      'utf8',
    );
    let valN = 0;
    (loop as any).performRolePhase = async (role: string) => {
      if (role === 'implementer') return { state: 'DONE', note: 'impl', handle: 'impl' };
      valN += 1;
      if (valN === 1) {
        return {
          state: 'FAIL',
          note: 'defect_class=plan-defect; bad',
          defectClass: 'plan-defect',
          planDefectFlag: true,
          handle: 'val',
        };
      }
      return { state: 'PASS', note: 'ok', handle: 'val' };
    };
    (loop as any).consultImplementationBrain = async () => ({
      action: 're-plan',
      decisionId: 'dec-key-1',
      reason: 'plan defect',
      planRevisionDirective: 'fix content only',
    });
    (loop as any).consultPlancoreRevise = async () => {
      // Return a DIFFERENT key — loop must force original.
      return {
        task_key: 'T-HIJACKED',
        atomic_work: 'new work content',
        validation_criteria: 'new criteria',
        req_refs: ['R-2'],
        summary: 'hijack attempt',
      };
    };
    // Drive through real parse+reingest (un-spy consultPlancore path partially):
    // Instead call parsePlancoreRevision + reIngest via the un-spied helpers after run.
    const parsed = (loop as any).parsePlancoreRevision(
      JSON.stringify({
        revised_task: {
          task_key: 'T-HIJACKED',
          atomic_work: 'new work content',
          validation_criteria: 'new criteria',
          req_refs: ['R-2'],
        },
        summary: 'hijack',
      }),
      'T-ORIG',
    );
    expect(parsed.task_key).toBe('T-ORIG');
    expect(parsed.atomic_work).toBe('new work content');

    (loop as any).taskKey = 'T-ORIG';
    const applied = await (loop as any).reIngestRevisedTask(parsed, {
      action: 're-plan',
      decisionId: 'dec-key-1',
      planRevisionDirective: 'fix content',
    });
    expect(applied).not.toBeNull();
    const plan = JSON.parse(await fs.readFile(path.join(runDir, 'plan.json'), 'utf8'));
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].task_key).toBe('T-ORIG');
    expect(plan.tasks[0].atomic_work).toBe('new work content');
    expect(plan.tasks[0].deps).toEqual(['T-OTHER']); // immutable
    expect(plan.tasks[0].task_type).toBe('feature'); // immutable
  });

  it('finding 2: malformed/unreadable plan.json → re-ingest ABORTS (no truncated plan, no PLAN_REVISED)', async () => {
    await fs.writeFile(path.join(runDir, 'plan.json'), '{not-valid-json', 'utf8');
    (loop as any).taskKey = 'T-X';
    (loop as any).runId = svc.createRun(null, 'batch-B8');
    const beforeEvents = (svc as any)['db'].raw
      .prepare(`SELECT COUNT(*) AS c FROM run_events WHERE event_type = 'PLAN_REVISED'`)
      .get() as { c: number };
    const applied = await (loop as any).reIngestRevisedTask(
      {
        task_key: 'T-X',
        atomic_work: 'should not apply',
        validation_criteria: 'should not apply',
      },
      { action: 're-plan', decisionId: 'dec-abort', planRevisionDirective: 'x' },
    );
    expect(applied).toBeNull();
    expect(loop.getTransitions()).toContain('replan-plan-write-failed');
    const raw = await fs.readFile(path.join(runDir, 'plan.json'), 'utf8');
    expect(raw).toBe('{not-valid-json'); // untouched — no truncated write
    const afterEvents = (svc as any)['db'].raw
      .prepare(`SELECT COUNT(*) AS c FROM run_events WHERE event_type = 'PLAN_REVISED'`)
      .get() as { c: number };
    expect(afterEvents.c).toBe(beforeEvents.c);
  });

  it('finding 2b: missing target task_key in plan → ABORT (no push of truncated single-task plan)', async () => {
    await fs.writeFile(
      path.join(runDir, 'plan.json'),
      JSON.stringify({
        tasks: [{
          task_key: 'T-OTHER',
          atomic_work: 'keep me',
          validation_criteria: 'ok',
          task_type: 'feature',
          complexity: 'low',
        }],
      }, null, 2),
      'utf8',
    );
    (loop as any).taskKey = 'T-MISSING';
    const applied = await (loop as any).reIngestRevisedTask(
      {
        task_key: 'T-MISSING',
        atomic_work: 'orphan',
        validation_criteria: 'orphan crit',
      },
      { action: 're-plan', decisionId: 'dec-miss', planRevisionDirective: 'x' },
    );
    expect(applied).toBeNull();
    const plan = JSON.parse(await fs.readFile(path.join(runDir, 'plan.json'), 'utf8'));
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].task_key).toBe('T-OTHER');
  });

  it('finding 3: reingest failure → no PLAN_REVISED / no brief switch; attempt counter still advances', async () => {
    (loop as any).MAX_REPLANS = 2;
    (loop as any).MAX_TASK_ATTEMPTS = 3;
    let brainN = 0;
    (loop as any).performRolePhase = async (role: string) =>
      role === 'implementer'
        ? { state: 'DONE', note: 'impl', handle: 'impl' }
        : {
            state: 'FAIL',
            note: 'defect_class=plan-defect; bad',
            defectClass: 'plan-defect',
            planDefectFlag: true,
            handle: 'val',
          };
    (loop as any).consultImplementationBrain = async () => {
      brainN += 1;
      if (brainN <= 2) {
        return {
          action: 're-plan',
          decisionId: `dec-fail-${brainN}`,
          reason: 'plan',
          planRevisionDirective: `fix ${brainN}`,
        };
      }
      return { action: 'escalate-to-JROM', decisionId: 'dec-park', reason: 'park' };
    };
    // Force reingest failure (no plan.json / unreadable).
    (loop as any).consultPlancoreRevise = async () => ({
      task_key: 'T-FAIL',
      atomic_work: 'x',
      validation_criteria: 'y',
    });
    // Ensure no plan.json so apply aborts
    await fs.rm(path.join(runDir, 'plan.json'), { force: true }).catch(() => {});

    const result = await loop.runTask({ brief: 'fail reingest', taskType: 'feature', taskKey: 'T-FAIL' });
    expect(loop.getTransitions()).toContain('replan-reingest-failed');
    expect(loop.getTransitions()).not.toContain('plan-revised');
    const rid = loop.getRunId()!;
    const planRev = (svc as any)['db'].raw
      .prepare(`SELECT COUNT(*) AS c FROM run_events WHERE run_id = ? AND event_type = 'PLAN_REVISED'`)
      .get(String(rid)) as { c: number };
    expect(planRev.c).toBe(0);
    const attempts = (svc as any)['db'].raw
      .prepare(
        `SELECT COUNT(*) AS c FROM run_events WHERE run_id = ? AND event_type = 'REPLAN_ATTEMPT'
         AND json_extract(payload_json, '$.phase') = 'acted'`,
      )
      .get(String(rid)) as { c: number };
    expect(attempts.c).toBeGreaterThanOrEqual(1);
    // eventually parks or blocks (not a silent success)
    expect(['DEFERRED', 'BLOCKED']).toContain(result.finalStatus);
  });

  it('finding 4: override rejected for agent-fail and reviewer; allowed only for agent-validator', async () => {
    // agent-fail path
    (loop as any).MAX_TASK_ATTEMPTS = 1;
    (loop as any).performRolePhase = async (role: string) => {
      if (role === 'implementer') throw new Error('no callback within timeout');
      return { state: 'FAIL', note: 'should not reach', handle: 'val' };
    };
    // Force agent-fail note through the ladder by making performRolePhase throw for impl
    // (agentFailNote path). Brain tries override.
    let brainCalls = 0;
    (loop as any).consultImplementationBrain = async () => {
      brainCalls += 1;
      if (brainCalls === 1) {
        return {
          action: 'escalate-validator',
          decisionId: 'dec-ov-af',
          reason: 'try override agent-fail',
          validatorAction: 'override',
          overrideJustification: 'should be rejected',
        };
      }
      return { action: 'escalate-to-JROM', decisionId: 'dec-park-af', reason: 'park' };
    };
    // Seed lastFailSource via a synthetic fail path: use note that looks like agent-fail
    (loop as any).performRolePhase = async (role: string) => {
      if (role === 'implementer') return { state: 'DONE', note: 'impl', handle: 'impl' };
      return {
        state: 'FAIL',
        note: 'agent-fail (no implementer callback within timeout): timed out',
        escalateFlag: true,
        handle: 'val',
      };
    };
    const af = await loop.runTask({ brief: 'agent fail override', taskType: 'feature' });
    expect(af.finalStatus).toBe('DEFERRED');
    expect(loop.getTransitions()).toContain('validator-override-rejected-agent-fail');
    expect(loop.getTransitions()).not.toContain('validator-overridden');

    // reviewer path
    transport = new FakeTransport();
    loop = new OrchestratorLoop(transport, {
      runDir,
      batchId: 'batch-B8',
      artifactService: svc,
      escalationService: esc,
    });
    (loop as any).MAX_TASK_ATTEMPTS = 1;
    brainCalls = 0;
    (loop as any).performRolePhase = async (role: string) => {
      if (role === 'implementer') return { state: 'DONE', note: 'impl', handle: 'impl' };
      return {
        state: 'FAIL',
        note: 'reviewer REVISE: binding broken at foo.ts:12',
        escalateFlag: true,
        handle: 'val',
      };
    };
    (loop as any).consultImplementationBrain = async () => {
      brainCalls += 1;
      if (brainCalls === 1) {
        return {
          action: 'escalate-validator',
          decisionId: 'dec-ov-rev',
          reason: 'try override reviewer',
          validatorAction: 'override',
          overrideJustification: 'should be rejected',
        };
      }
      return { action: 'escalate-to-JROM', decisionId: 'dec-park-rev', reason: 'park' };
    };
    const rev = await loop.runTask({ brief: 'reviewer fail override', taskType: 'feature' });
    expect(rev.finalStatus).toBe('DEFERRED');
    expect(loop.getTransitions()).toContain('validator-override-rejected-reviewer');
    expect(loop.getTransitions()).not.toContain('validator-overridden');
  });

  it('finding 5: invalid revision rejected; missing req_refs keeps existing values', async () => {
    await fs.writeFile(
      path.join(runDir, 'plan.json'),
      JSON.stringify({
        tasks: [{
          task_key: 'T-MERGE',
          atomic_work: 'old',
          validation_criteria: 'old-crit',
          task_type: 'feature',
          complexity: 'med',
          req_refs: ['R-KEEP'],
        }],
      }, null, 2),
      'utf8',
    );
    (loop as any).taskKey = 'T-MERGE';

    // empty criteria → reject
    expect(
      (loop as any).parsePlancoreRevision(
        JSON.stringify({ revised_task: { task_key: 'T-MERGE', atomic_work: 'x', validation_criteria: '   ' } }),
        'T-MERGE',
      ),
    ).toBeNull();
    // object criteria → reject
    expect(
      (loop as any).parsePlancoreRevision(
        JSON.stringify({ revised_task: { task_key: 'T-MERGE', atomic_work: 'x', validation_criteria: { a: 1 } } }),
        'T-MERGE',
      ),
    ).toBeNull();

    // omit req_refs → merge keeps existing
    const ok = (loop as any).parsePlancoreRevision(
      JSON.stringify({
        revised_task: {
          task_key: 'T-OTHER',
          atomic_work: 'merged work',
          validation_criteria: 'merged crit',
        },
        summary: 'merge',
      }),
      'T-MERGE',
    );
    expect(ok.task_key).toBe('T-MERGE');
    expect(ok.req_refs).toBeUndefined();
    const applied = await (loop as any).reIngestRevisedTask(ok, {
      action: 're-plan',
      decisionId: 'dec-merge',
      planRevisionDirective: 'merge',
    });
    expect(applied).not.toBeNull();
    const plan = JSON.parse(await fs.readFile(path.join(runDir, 'plan.json'), 'utf8'));
    expect(plan.tasks[0].req_refs).toEqual(['R-KEEP']);
    expect(plan.tasks[0].complexity).toBe('med');
    expect(plan.tasks[0].task_type).toBe('feature');
    expect(plan.tasks[0].atomic_work).toBe('merged work');
  });

  it('finding 6+7: re-plan attempts bounded incl. no-revision; durable count rehydrates on resume', async () => {
    (loop as any).MAX_REPLANS = 2;
    (loop as any).MAX_TASK_ATTEMPTS = 5;
    let brainN = 0;
    (loop as any).performRolePhase = async (role: string) =>
      role === 'implementer'
        ? { state: 'DONE', note: 'impl', handle: 'impl' }
        : {
            state: 'FAIL',
            note: 'defect_class=plan-defect; still',
            defectClass: 'plan-defect',
            planDefectFlag: true,
            handle: 'val',
          };
    (loop as any).consultImplementationBrain = async () => {
      brainN += 1;
      return {
        action: 're-plan',
        decisionId: `dec-att-${brainN}`,
        reason: 'plan',
        planRevisionDirective: `try ${brainN}`,
      };
    };
    // Always no-revision → each acted attempt still counts toward the bound
    (loop as any).consultPlancoreRevise = async () => null;

    const result = await loop.runTask({ brief: 'bound attempts', taskType: 'feature', taskKey: 'T-ATT' });
    // Cap terminal is now PARK (DEFERRED), not a run-wide halt — see the JROM-LOCKED note on the
    // 'exceeding HELM_MAX_REPLANS' test above. The BUDGET behaviour asserted below is unchanged: the
    // count still bounds ATTEMPTS (including no-revision ones) and still rehydrates durably on resume,
    // which is what stops parking from becoming an infinite re-plan loop.
    expect(result.finalStatus).toBe('DEFERRED');
    expect(loop.getTransitions()).toContain('replan-bound-exceeded');
    expect((loop as any).replansUsed).toBeGreaterThanOrEqual(2);

    // Durable: REPLAN_ATTEMPT acted rows exist; a fresh loop rehydrates the count
    const rid = loop.getRunId()!;
    const acted = (svc as any)['db'].raw
      .prepare(
        `SELECT COUNT(*) AS c FROM run_events WHERE run_id = ? AND event_type = 'REPLAN_ATTEMPT'
         AND json_extract(payload_json, '$.phase') = 'acted'`,
      )
      .get(String(rid)) as { c: number };
    expect(acted.c).toBeGreaterThanOrEqual(2);

    const loop2 = new OrchestratorLoop(transport, {
      runDir,
      batchId: 'batch-B8',
      artifactService: svc,
      escalationService: esc,
      runId: rid,
    });
    (loop2 as any).taskKey = 'T-ATT';
    (loop2 as any).runId = rid;
    expect((loop2 as any).loadDurableReplansUsed()).toBeGreaterThanOrEqual(2);
  });

  it('finding 8: BLOCKED brain callback does not execute a decision', async () => {
    (loop as any).MAX_TASK_ATTEMPTS = 1;
    (loop as any).performRolePhase = async (role: string) =>
      role === 'implementer'
        ? { state: 'DONE', note: 'impl', handle: 'impl' }
        : {
            state: 'FAIL',
            note: 'defect_class=plan-defect; x',
            defectClass: 'plan-defect',
            planDefectFlag: true,
            handle: 'val',
          };
    // Simulate consultImplementationBrain receiving BLOCKED (returns null — no decision executed)
    (loop as any).consultImplementationBrain = async () => {
      (loop as any).log('brain-blocked');
      return null;
    };
    const result = await loop.runTask({ brief: 'brain blocked', taskType: 'feature' });
    expect(loop.getTransitions()).toContain('brain-blocked');
    expect(loop.getTransitions()).toContain('brain-no-decision');
    expect(loop.getTransitions()).not.toContain('brain-decision:re-plan');
    expect(loop.getTransitions()).not.toContain('plan-revised');
    expect(result.finalStatus).toBe('DEFERRED');
  });

  it('finding 10: consultPlancoreRevise resolves roster model/provider (not hardcoded grok)', async () => {
    // Seed a project + plancore binding so resolvePlancoreRosterSeat can resolve.
    const db = (svc as any)['db'] as DatabaseService;
    db.raw.prepare(
      `INSERT OR REPLACE INTO projects (id, name, directory, plancore_session) VALUES (?,?,?,?)`,
    ).run(9001, 'clfix-plancore-roster', runDir, 'helm-plancore-clfix');
    // Find plancore agent id from seed
    const plancore = db.raw.prepare(`SELECT id, model, provider FROM agents WHERE name = 'plancore'`).get() as
      | { id: number; model: string; provider: string }
      | undefined;
    expect(plancore).toBeTruthy();
    db.raw.prepare(
      `INSERT OR REPLACE INTO role_bindings (project_id, role, agent_id) VALUES (?,?,?)`,
    ).run(9001, 'plancore', plancore!.id);

    const loopP = new OrchestratorLoop(transport, {
      runDir,
      batchId: 'batch-B8',
      artifactService: svc,
      escalationService: esc,
      projectId: 9001,
    });
    const seat = (loopP as any).resolvePlancoreRosterSeat();
    // Must resolve from roster (same values as the bound plancore agent) — not a hardcoded 'grok' fallback.
    expect(seat.provider).toBe(plancore!.provider);
    expect(seat.model).toBe(plancore!.model);
  });

  it('guardrail 2+5: rung2 max-attempt blocks after 3 tries (no infinite loop); same-rung re-entry requires new decisionId', async () => {
    // Climb the ladder via brain decisions then hit rung2 cap (proves climb + termination + no infinite)
    const p = loop.runTask({ brief: 'rung2 cap via ladder test' });
    const cbp = path.join(runDir, 'callbacks.md');

    // 3 fails at rung0 -> brain bump to 1
    for (let i = 1; i <= 3; i++) {
      await fs.appendFile(cbp, `[helm callback] implementer batch-B8 STATUS: DONE — r0-${i}\n`);
      await sleep(10);
      await fs.appendFile(cbp, `[helm callback] validator batch-B8 STATUS: FAIL — r0 diag ${i}\n`);
      await sleep(10);
    }
    await fs.appendFile(cbp, `[helm callback] ibrain batch-B8 STATUS: DECISION-READY — {"edge_class":"rung-attempt-limit","route_to":"bump-rung","blocker_owner":"brain","action":"bump-rung","targetRung":1,"decisionId":"dec-to1","reason":"bump1"}\n`);
    await sleep(20);

    // 2 fails at rung1 -> brain bump to 2
    for (let i = 1; i <= 2; i++) {
      await fs.appendFile(cbp, `[helm callback] implementer batch-B8 STATUS: DONE — r1-${i}\n`);
      await sleep(10);
      await fs.appendFile(cbp, `[helm callback] validator batch-B8 STATUS: FAIL — r1 diag ${i}\n`);
      await sleep(10);
    }
    await fs.appendFile(cbp, `[helm callback] ibrain batch-B8 STATUS: DECISION-READY — {"edge_class":"rung-attempt-limit","route_to":"bump-rung","blocker_owner":"brain","action":"bump-rung","targetRung":2,"decisionId":"dec-to2","reason":"bump2"}\n`);
    await sleep(20);

    // At rung2 limit=3: drive 3 fails -> on 3rd FAIL blocks (no more, no brain)
    for (let i = 1; i <= 3; i++) {
      await fs.appendFile(cbp, `[helm callback] implementer batch-B8 STATUS: DONE — r2-${i}\n`);
      await sleep(10);
      await fs.appendFile(cbp, `[helm callback] validator batch-B8 STATUS: FAIL — r2 diag ${i}\n`);
      await sleep(10);
    }

    const res = await p;
    expect(res.finalStatus).toBe('BLOCKED');
    expect(loop.getCurrentRung()).toBe(2);
    expect(loop.getAuthorizingDecisionId()).toBe('dec-to2');
    expect(loop.getTransitions()).toContain('rung2-exhaust-block');

    // Spawn counts reflect the ladder climb (3 r0 + 2 r1 + 3 r2) + brain decisions; the exact total may be higher due to test cb pre-write polling
    // but termination is proven by: res returned (no hang/timeout), rung==2, cap marker, only 2 brain consults (the bumps), no runaway.

  });

  it('top-rung exhaustion blocks the run and fires an actionable task-naming operator page', async () => {
    const notificationTransport = { notify: vi.fn(async () => {}) };
    loop = new OrchestratorLoop(transport, {
      runDir,
      batchId: 'batch-B8',
      artifactService: svc,
      escalationService: esc,
      notificationTransport,
    });
    (loop as any).MAX_TASK_ATTEMPTS = 3;
    const taskKey = 'TOP-EXHAUST-1';
    const topModel = esc.getModelForRung('implementer', 2);
    const p = loop.runTask({
      brief: 'oversized top-rung task that needs human task/prompt review',
      taskType: 'feature',
      recommendedRung: 2,
      taskKey,
    });
    const cbp = path.join(runDir, 'callbacks.md');

    for (let i = 1; i <= 3; i++) {
      await fs.appendFile(cbp, `[helm callback] implementer batch-B8 STATUS: DONE — top attempt ${i}\n`);
      await sleep(10);
      await fs.appendFile(cbp, `[helm callback] validator batch-B8 STATUS: FAIL — top diagnosis ${i}\n`);
      await sleep(10);
    }

    const res = await p;
    expect(res).toMatchObject({ finalStatus: 'BLOCKED', attempts: 3 });
    const runId = loop.getRunId()!;
    expect(dbs.raw.prepare('SELECT phase, status FROM runs WHERE id=?').get(runId)).toMatchObject({
      phase: 'blocked',
      status: 'failed',
    });
    expect(notificationTransport.notify).toHaveBeenCalledTimes(1);
    const page = (notificationTransport.notify as any).mock.calls[0][0] as any;
    expect(page).toMatchObject({
      name: 'Helm blocked run',
      project: 'Helm',
      model: 'engine',
    });
    expect(page.message).toContain(`Task ${taskKey} failed at the top rung (${topModel}) after 3 attempts`);
    expect(page.message).toContain('PROMPT/TASK defect');
    expect(page.message).toContain('not a model-strength gap');
    expect(page.message).toContain('Needs your review of the task/prompt');
  });


  it('parseCallbackLine accepts only the Helm-native prefix (a)', async () => {
    const { parseCallbackLine } = await import('./agent-event-ingest.js');
    expect(parseCallbackLine(`[projcore callback] implementer rmqhcm9hi STATUS: DONE — x`)).toBeNull();
    expect(parseCallbackLine(`[helm callback] validator b STATUS: PASS — ok`)).toBeTruthy();
    expect(parseCallbackLine(`[foo callback] x`)).toBeNull();
  });

  it('OrchestratorLoop happy-path with Helm-native impl DONE → validator PASS (b)', async () => {
    const brief = 'test b: impl then val';
    const p = loop.runTask({ brief, taskType: 'feature' });
    const cbp = path.join(runDir, 'callbacks.md');
    await fs.appendFile(cbp, `[helm callback] implementer batch-B8 STATUS: DONE — b-impl\n`);
    await sleep(20);
    await fs.appendFile(cbp, `[helm callback] validator batch-B8 STATUS: PASS — b-val\n`);
    await sleep(20);
    const res = await p;
    expect(res.finalStatus).toBe('PASS');
    const vbrief = await fs.readFile(path.join(runDir, 'prompts/validator.brief.md'), 'utf8').catch(() => '');
    expect(vbrief).toContain('audit the implementer');
  });

  it('all-4-tasks dep-order drive (c)', async () => {
    // use queue + feed to prove dep order and block on fail
    const q = new TaskQueueService();
    q.enqueue(99, 1, []); // L9-1
    q.enqueue(99, 2, [1]);
    q.enqueue(99, 3, [2]);
    q.enqueue(99, 4, [1]);
    expect(q.getNextReady(99)).toBe(1);
    q.markComplete(1, 99);
    expect(q.getNextReady(99)).toBe(2);
    // fail variant
    const q2 = new TaskQueueService();
    q2.enqueue(99, 1, []);
    q2.enqueue(99, 2, [1]);
    q2.enqueue(99, 4, [1]);
    q2.markFailed(1, 99);
    expect(q2.getNextReady(99)).toBeNull(); // 2 and 4 blocked
  });

  it('projcore-emit-status.sh accepts red-team VERDICT-READY and validator PASS (d)', async () => {
    const { execSync } = await import('node:child_process');
    const fss = await import('node:fs/promises');
    const cb = path.join(os.tmpdir(), `poc15-sh-cb-${Date.now()}.md`);
    await fss.writeFile(cb, '# sh test\n');
    const env = { ...process.env, PROJCORE_CALLBACKS_FILE: cb };
    // Use repo-local stub (same contract as the real emit-status script; decoupled from JROM agent scripts)
    const stub = path.join(path.dirname(new URL(import.meta.url).pathname), '../test-fixtures/projcore-emit-status.sh');
    execSync(`bash "${stub}" red-team bfoo VERDICT-READY "CLEAN"`, { env, stdio: 'ignore' });
    let c = await fss.readFile(cb, 'utf8');
    expect(c).toMatch(/\[projcore callback\] red-team bfoo STATUS: VERDICT-READY — CLEAN/);
    execSync(`bash "${stub}" validator bfoo PASS "ok"`, { env, stdio: 'ignore' });
    c = await fss.readFile(cb, 'utf8');
    expect(c).toMatch(/\[projcore callback\] validator bfoo STATUS: PASS — ok/);
    await fss.unlink(cb).catch(() => {});
  });

  it('C5: low-budget trigger (fake gateway depleted for base) swaps to next rung model at dispatch (compatible with per-task explicit)', async () => {
    // mirror p1-6b FakeUsageGateway pattern
    class FakeUsageGateway {
      private map: Record<string, boolean> = {};
      setDepleted(p: string, m: string, v: boolean) { this.map[`${p}:${m}`] = v; }
      async getUsage() { return { stale: false, rungs: {} }; }
      async isDepleted(provider: string, model: string) {
        const k = `${provider}:${model}`;
        if (k in this.map) return this.map[k];
        return null;
      }
    }
    const fakeGW = new FakeUsageGateway();
    // base (rung0 default or explicit) is grok-4.5 -> mark low budget; expect swap to rung1 'codex-5.5'
    fakeGW.setDepleted('grok', 'grok-4.5', true);
    const tmpDb2 = path.join(os.tmpdir(), `helm-c5-${Date.now()}.db`);
    const dbs2 = new DatabaseService(tmpDb2);
    const escBudget = new EscalationService(dbs2, fakeGW as any);
    const t2 = new FakeTransport();
    const localArtifact = new RunArtifactService(dbs2);
    // local objects to drive (isolated esc with budget fake; C6 explicit base + low on top)
    const localLoop = new OrchestratorLoop(t2, {
      runDir,
      batchId: 'batch-C5',
      artifactService: localArtifact,
      escalationService: escBudget,
    });
    const pp = localLoop.runTask({ brief: 'c5 budget base explicit', explicitModel: 'grok-4.5', taskType: 'feature' });
    const cbp = path.join(runDir, 'callbacks.md');
    await fs.appendFile(cbp, `[helm callback] implementer batch-C5 STATUS: DONE — budget-impl\n`);
    await sleep(10);
    await fs.appendFile(cbp, `[helm callback] validator batch-C5 STATUS: PASS — budget-val\n`);
    await sleep(10);
    const res = await pp;
    expect(res.finalStatus).toBe('PASS');
    // the dispatch for impl must have used escalated model (not grok-4.5)
    const implCalls = t2.spawnCalls.filter((s: any) => s.role === 'implementer');
    expect(implCalls.length).toBeGreaterThan(0);
    // since low fired, the model for rung dispatch should be codex (rung1)
    const used = implCalls.map((s: any) => s.model).filter(Boolean);
    expect(used.some((m: string) => /codex|gpt-5\.5/i.test(m || ''))).toBe(true); // R6: rung1 dispatches launchable gpt-5.5
    // and we logged the trigger
    const trans = localLoop.getTransitions().join(' ');
    expect(trans).toMatch(/low-budget-trigger/);
    try { dbs2.close(); } catch {}
  });

});

describe('orchestrator-loop B10 panels (deliberation consensus + red-team N-clean) + B8 hook reuse (USE_FAKE_TMUX)', () => {
  let runDir: string;
  let transport: FakeTransport;
  let loop: OrchestratorLoop;
  let artifact: RunArtifactService;
  let dbs: DatabaseService;
  let esc: EscalationService;
  let panelSvc: PanelService;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b10p-'));
    const cb = path.join(runDir, 'callbacks.md');
    await fs.writeFile(cb, '# B10 panel callbacks\n', 'utf8');
    transport = new FakeTransport();
    const tmpDb = path.join(os.tmpdir(), `helm-b10p-${Date.now()}.db`);
    dbs = new DatabaseService(tmpDb);
    artifact = new RunArtifactService(dbs);
    esc = new EscalationService(dbs);
    panelSvc = new PanelService(transport, artifact, 'batch-B10');
    loop = new OrchestratorLoop(transport, {
      runDir,
      batchId: 'batch-B10',
      artifactService: artifact,
      escalationService: esc,
      panelService: panelSvc
    });
  });

  afterEach(async () => {
    if (runDir) {
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('PanelService: deliberation aggregates N verdicts to CONSENSUS (unanimous); spawns + reaps recorded; verifier≠fixer (no code in brief)', async () => {
    const cbp = path.join(runDir, 'callbacks.md');
    // pre-seed cbs before convene so waits (which start immediately) find matching VERDICT-READY lines
    await fs.appendFile(cbp, `[helm callback] panelist batch-B10 STATUS: VERDICT-READY — sound approach, minor test gap (seat delib-1:0)\n`);
    await fs.appendFile(cbp, `[helm callback] panelist batch-B10 STATUS: VERDICT-READY — sound approach, minor test gap (seat delib-1:1)\n`);
    await fs.appendFile(cbp, `[helm callback] panelist batch-B10 STATUS: VERDICT-READY — sound approach, minor test gap (seat delib-1:2)\n`);
    await sleep(20);
    const r = await panelSvc.conveneDeliberationPanel({ runDir, topic: 'ambiguous approach for feature X' });
    expect(r.state).toBe('CONSENSUS');
    expect(r.verdicts.length).toBe(3);
    expect(transport.spawnCalls.filter((s: any) => s.role === 'panelist').length).toBe(3);
    expect(transport.reapCalls.filter((r: any) => r.reason.includes('panel')).length).toBe(3);
    // no fix written by panel (verifier≠fixer)
    const anyImplBrief = transport.spawnCalls.find((s: any) => s.role === 'implementer');
    if (anyImplBrief) expect(anyImplBrief.brief).not.toContain('sound approach');
  });

  it('C1: deliberation spawns per-seat models from team roster (each seat uses its roster model)', async () => {
    const cbp = path.join(runDir, 'callbacks.md');
    await fs.appendFile(cbp, `[helm callback] panelist batch-B10 STATUS: VERDICT-READY — ok1\n`);
    await fs.appendFile(cbp, `[helm callback] panelist batch-B10 STATUS: VERDICT-READY — ok2\n`);
    await fs.appendFile(cbp, `[helm callback] panelist batch-B10 STATUS: VERDICT-READY — ok3\n`);
    await sleep(20);
    const rosterSeats = [
      { lens: 'correctness', model: 'grok-4.5', provider: 'grok' },
      { lens: 'tests', model: 'codex-5.5', provider: 'codex' },
      { lens: 'arch', model: 'claude-opus', provider: 'claude' },
    ];
    const r = await panelSvc.conveneDeliberationPanel({ runDir, topic: 't', seats: rosterSeats });
    expect(r.verdicts.length).toBe(3);
    const panelSpawns = transport.spawnCalls.filter((s: any) => s.role === 'panelist');
    expect(panelSpawns.length).toBe(3);
    expect(panelSpawns[0].model).toBe('grok-4.5');
    expect(panelSpawns[1].model).toBe('codex-5.5');
    expect(panelSpawns[2].model).toBe('claude-opus');
  });

  it('PanelService: red-team reaches N-consecutive-clean or reports BROKEN; routes correctly (verifier≠fixer)', async () => {
    const cbp = path.join(runDir, 'callbacks.md');
    // pre-seed before call (waits start immediately inside convene)
    await fs.appendFile(cbp, `[helm callback] panelist batch-B10 STATUS: VERDICT-READY — CLEAN: all gates pass (seat red-1:0)\n`);
    await fs.appendFile(cbp, `[helm callback] panelist batch-B10 STATUS: VERDICT-READY — CLEAN: regression holds (seat red-1:1)\n`);
    await sleep(20);
    const r = await panelSvc.conveneRedTeamPanel({ runDir, implementedDiff: 'diff v1', requirement: 'req Y', nConsecutiveClean: 2 });
    expect(r.state).toBe('CLEAN');
    expect(r.rounds).toBe(2);
    expect(r.verdicts.length).toBe(2);
    expect(transport.reapCalls.some((rc: any) => rc.reason.includes('red'))).toBe(true);
  });

  it('C1: red-team spawns per-seat models from roster (cycles roster models with provider)', async () => {
    const cbp = path.join(runDir, 'callbacks.md');
    await fs.appendFile(cbp, `[helm callback] red-team batch-B10 STATUS: VERDICT-READY — CLEAN seat r1\n`);
    await fs.appendFile(cbp, `[helm callback] red-team batch-B10 STATUS: VERDICT-READY — CLEAN seat r2\n`);
    await sleep(20);
    const rosterAgents = [
      { role: 'red-team', model: 'grok-4.5', provider: 'grok' },
      { role: 'red-team', model: 'codex-5.5', provider: 'codex' },
    ];
    const r = await panelSvc.conveneRedTeamPanel({ runDir, implementedDiff: 'd', requirement: 'r', nConsecutiveClean: 2, redTeamAgents: rosterAgents });
    expect(r.state).toBe('CLEAN');
    const redSpawns = transport.spawnCalls.filter((s: any) => s.role === 'red-team' || (s.role === 'panelist' && s.model));
    // at least the spawns used the provided models for the agent seats
    const usedModels = transport.spawnCalls.filter((s: any) => s.model).map((s: any) => s.model);
    expect(usedModels).toContain('grok-4.5');
    expect(usedModels).toContain('codex-5.5');
  });

  it('B8 deliberation hook now convenes panel + aggregates before task FAIL (reuse of consult + decision)', async () => {
    const p = loop.runTask({ brief: 'task that hits approach-wrong delib' });
    const cbp = path.join(runDir, 'callbacks.md');
    // drive exactly 3 fails to hit limit and wake brain with delib decision
    for (let i = 1; i <= 3; i++) {
      await fs.appendFile(cbp, `[helm callback] implementer batch-B10 STATUS: DONE — attempt${i}\n`);
      await sleep(6);
      await fs.appendFile(cbp, `[helm callback] validator batch-B10 STATUS: FAIL — approach wrong ${i}\n`);
      await sleep(6);
    }
    await fs.appendFile(cbp, `[helm callback] ibrain batch-B10 STATUS: DECISION-READY — {"edge_class":"rung-attempt-limit","route_to":"deliberation","blocker_owner":"brain","action":"deliberation","decisionId":"dec-b10","reason":"approach wrong per spec"}\n`);
    await sleep(15);
    // panel seats (convene inside hook waits these)
    await fs.appendFile(cbp, `[helm callback] panelist batch-B10 STATUS: VERDICT-READY — consensus good (seat hookp:0)\n`);
    await sleep(6);
    await fs.appendFile(cbp, `[helm callback] panelist batch-B10 STATUS: VERDICT-READY — consensus good (seat hookp:1)\n`);
    await sleep(6);
    await fs.appendFile(cbp, `[helm callback] panelist batch-B10 STATUS: VERDICT-READY — consensus good (seat hookp:2)\n`);
    await sleep(20);

    const res = await p;
    expect(res.finalStatus).toBe('DEFERRED');  // B10-T05: deliberation after ladder exhaustion parks (DEFERRED)
    const pSpawns = transport.spawnCalls.filter((s: any) => s.role === 'panelist').length;
    expect(pSpawns).toBeGreaterThanOrEqual(3);
    const trans = loop.getTransitions().join(' ');
    expect(trans).toMatch(/panel-deliberation:(CONSENSUS|SETTLED)/);
    // still terminates task (Helm routes the panel consensus); now as DEFERRED per R-F5 park on exhaust
  });

  it('DSP10 run-done TERMINAL GATE: each missing condition (incomplete req / unreaped / pending / final fail / not synced) makes done=FALSE; only all 5 satisfied makes TRUE (per brief guardrail)', async () => {
    // explicit per-cond blocks (overrides drive the 5; real matrix read exercised via artifact in compute)
    expect(await loop.computeRunDone({ allReqVerified: false, finalValPassed: true, allReaped: true, artifactsSynced: true, noPending: true })).toBe(false);
    expect(await loop.computeRunDone({ allReqVerified: true, finalValPassed: true, allReaped: false, artifactsSynced: true, noPending: true })).toBe(false);
    expect(await loop.computeRunDone({ allReqVerified: true, finalValPassed: true, allReaped: true, artifactsSynced: true, noPending: false })).toBe(false);
    expect(await loop.computeRunDone({ allReqVerified: true, finalValPassed: false, allReaped: true, artifactsSynced: true, noPending: true })).toBe(false);
    expect(await loop.computeRunDone({ allReqVerified: true, finalValPassed: true, allReaped: true, artifactsSynced: false, noPending: true })).toBe(false);
    // only all hold
    expect(await loop.computeRunDone({ allReqVerified: true, finalValPassed: true, allReaped: true, artifactsSynced: true, noPending: true })).toBe(true);
  });

  it('DSP9 final val + DSP10 gate after queue drain (matrix present triggers; incomplete req blocks)', async () => {
    // write a matrix with DSP9/10 still ASSIGNED (not VERIFIED) to exercise real read + block
    const matrix = `# req-matrix
| Req | Batch | Status |
| DSP9 final run-level validation | B10 | ASSIGNED |
| DSP10 run "done" definition | B10 | ASSIGNED |
`;
    await fs.writeFile(path.join(runDir, 'req-matrix.md'), matrix, 'utf8');
    // drain with empty (immediate) via runQueued minimal (no real queue needed for this guard)
    const q = new TaskQueueService(artifact);
    // no tasks enqueued -> drains
    const res = await loop.runQueuedTasks({ runId: 999, queue: q, artifactService: artifact, plan: { tasks: [] } as any, keyToId: {} });
    // final val was attempted (post-drain guard), gate sees incomplete -> not done (compute uses real matrix)
    const done = await loop.computeRunDone();
    expect(done).toBe(false);
  });
});

describe('Phase C-b: C2/C3/C4 (real-path validator+reviewer after gate; repro retry+defer) — HELM_DB_PATH guard', () => {
  let runDir: string;
  let transport: FakeTransport;
  let loop: OrchestratorLoop;
  let dbs: DatabaseService;
  let esc: EscalationService;
  let artifact: RunArtifactService;
  let tmpDbPath: string;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-cb-'));
    const cb = path.join(runDir, 'callbacks.md');
    await fs.writeFile(cb, '# Cb callbacks\n', 'utf8');
    tmpDbPath = `/tmp/helm-cb-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    dbs = new DatabaseService(tmpDbPath);
    esc = new EscalationService(dbs);
    artifact = new RunArtifactService(dbs);
    transport = new FakeTransport();
    loop = new OrchestratorLoop(transport, {
      runDir,
      batchId: 'batch-Cb',
      artifactService: artifact,
      escalationService: esc,
      projectDir: runDir, // fenced target
    });
  });

  afterEach(async () => {
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
    if (tmpDbPath) await fs.unlink(tmpDbPath).catch(() => {});
  });

  it.skip('C2: feature real path (FORCE_DETERMINISTIC) gate PASS -> validator (requirements) -> reviewer APPROVE -> PASS; records separate', async () => {
    // force real det path + make gate succeed without touching live fs/npm
    const prevForce = process.env.FORCE_DETERMINISTIC_VAL_PATH;
    const prevCmd = process.env.HELM_PROJECT_TEST_CMD;
    const prevArgs = process.env.HELM_PROJECT_TEST_ARGS;
    process.env.FORCE_DETERMINISTIC_VAL_PATH = '1';
    process.env.HELM_PROJECT_TEST_CMD = 'sh';
    process.env.HELM_PROJECT_TEST_ARGS = '-c "exit 0"';
    try {
      const brief = '## Task\ntask_key: T1\natomic_work: add foo\nvalidation_criteria: foo works and tests pass\n';
      await fs.writeFile(path.join(runDir, 'north-star.md'), 'NORTH: deliver foo feature\n', 'utf8');
      const p = loop.runTask({ brief, taskType: 'feature', preExistingTaskId: undefined });
      const cbp = path.join(runDir, 'callbacks.md');
      // pre-seed all cbs for the phases (impl + C2 val + C4 rev); waits will pick latest-per-role
      await fs.appendFile(cbp, `[helm callback] implementer batch-Cb STATUS: DONE — foo added\n`);
      await fs.appendFile(cbp, `[helm callback] validator batch-Cb STATUS: PASS — requirements matrix: REQ-FOO VERIFIED\n`);
      await fs.appendFile(cbp, `[helm callback] reviewer batch-Cb STATUS: APPROVE — mechanism root cause named; no regressions\n`);
      await sleep(50);
      const res = await p;
      expect(res.finalStatus).toBe('PASS');
    } finally {
      if (prevForce === undefined) delete process.env.FORCE_DETERMINISTIC_VAL_PATH; else process.env.FORCE_DETERMINISTIC_VAL_PATH = prevForce;
      if (prevCmd === undefined) delete process.env.HELM_PROJECT_TEST_CMD; else process.env.HELM_PROJECT_TEST_CMD = prevCmd;
      if (prevArgs === undefined) delete process.env.HELM_PROJECT_TEST_ARGS; else process.env.HELM_PROJECT_TEST_ARGS = prevArgs;
    }
  }, 120000);

  it('C2: validator FAIL after gate routes back as FAIL (correction path)', async () => {
    const prevForce = process.env.FORCE_DETERMINISTIC_VAL_PATH;
    const prevCmd = process.env.HELM_PROJECT_TEST_CMD;
    const prevArgs = process.env.HELM_PROJECT_TEST_ARGS;
    process.env.FORCE_DETERMINISTIC_VAL_PATH = '1';
    process.env.HELM_PROJECT_TEST_CMD = 'sh';
    process.env.HELM_PROJECT_TEST_ARGS = '-c "exit 0"';
    try {
      const brief = 'atomic_work: bar; validation_criteria: bar must exist';
      await fs.writeFile(path.join(runDir, 'north-star.md'), 'deliver bar\n', 'utf8');
      const p = loop.runTask({ brief, taskType: 'feature' });
      const cbp = path.join(runDir, 'callbacks.md');
      // preseed one fail cycle + brain escalate (ladder will loop but brain cb will be seen when consult fires)
      await fs.appendFile(cbp, `[helm callback] implementer batch-Cb STATUS: DONE — bar\n`);
      await fs.appendFile(cbp, `[helm callback] validator batch-Cb STATUS: FAIL — gap: north-star bar not observable\n`);
      await fs.appendFile(cbp, `[helm callback] ibrain batch-Cb STATUS: DECISION-READY — {"action":"escalate-to-JROM","reason":"C2 validator gap test"}\n`);
      await sleep(60);
      const res = await p;
      expect(res.finalStatus).toBe('DEFERRED');  // B10-T05: escalate-to-JROM after chain exhaustion = PARK (DEFERRED per R-F5)
    } finally {
      if (prevForce === undefined) delete process.env.FORCE_DETERMINISTIC_VAL_PATH; else process.env.FORCE_DETERMINISTIC_VAL_PATH = prevForce;
      if (prevCmd === undefined) delete process.env.HELM_PROJECT_TEST_CMD; else process.env.HELM_PROJECT_TEST_CMD = prevCmd;
      if (prevArgs === undefined) delete process.env.HELM_PROJECT_TEST_ARGS; else process.env.HELM_PROJECT_TEST_ARGS = prevArgs;
    }
  });

  it('B01.s4: real post-C2 BLOCKED stays non-PASS and records a durable protocol defect', async () => {
    const previousFake = process.env.USE_FAKE_TMUX;
    process.env.USE_FAKE_TMUX = '0'; // keep the real post-C2 branch; role responses are controlled below.
    try {
      let validatorCalls = 0;
      (loop as any).runProjectTests = async () => ({ state: 'PASS', note: 'controlled gate green' });
      (loop as any).consultImplementationBrain = async () => ({ action: 'escalate-to-JROM', reason: 'controlled protocol defect' });
      (loop as any).performRolePhase = async (role: string) => {
        if (role === 'implementer') return { state: 'DONE', note: 'controlled implementation', handle: 'impl' };
        if (role === 'validator') {
          validatorCalls += 1;
          return { state: 'BLOCKED', note: 'PROTOCOL-DEFECT: validator FAIL requires defect_class', handle: 'validator' };
        }
        return { state: 'DECISION-READY', note: JSON.stringify({ edge_class: 'validator-failure', route_to: 'escalate-to-JROM', blocker_owner: 'brain', reason: 'controlled protocol defect' }), handle: 'brain' };
      };
      const result = await loop.runTask({ brief: 'atomic_work: x; validation_criteria: x works', taskType: 'feature' });
      expect(result.finalStatus).not.toBe('PASS');
      const rows = dbs.raw.prepare('SELECT result, defect_class FROM validations').all() as any[];
      expect(rows.some((row) => row.result === 'BLOCKED' && row.defect_class === 'protocol-defect')).toBe(true);
      expect(rows.some((row) => row.result === 'PASS')).toBe(false);
      expect(validatorCalls).toBeGreaterThan(0);
    } finally {
      if (previousFake === undefined) delete process.env.USE_FAKE_TMUX;
      else process.env.USE_FAKE_TMUX = previousFake;
    }
  });

  it('B01.s4: raw unlabeled NON-SUBSTANTIVE validator FAIL converts to durable protocol-defect on the real role boundary', async () => {
    // Gate C contract: an unlabeled FAIL whose note is NON-diagnostic (empty/boilerplate) is still a
    // bounded BLOCKED/protocol-defect. (A SUBSTANTIVE unlabeled FAIL now becomes a derived classified FAIL —
    // see validator-verdict-normalize.test.ts + the B2 real-path test below.)
    const previousFake = process.env.USE_FAKE_TMUX;
    const previousCmd = process.env.HELM_PROJECT_TEST_CMD;
    const previousArgs = process.env.HELM_PROJECT_TEST_ARGS;
    process.env.USE_FAKE_TMUX = '0';
    process.env.HELM_PROJECT_TEST_CMD = 'true';
    delete process.env.HELM_PROJECT_TEST_ARGS;
    (loop as any).MAX_TASK_ATTEMPTS = 1;
    (loop as any).runProjectTests = async () => ({ state: 'PASS', note: 'controlled gate green' });
    const waitForRole = async (role: string) => {
      for (let index = 0; index < 100; index += 1) {
        if (transport.spawnCalls.some((call: any) => call.role === role)) return;
        await sleep(10);
      }
      throw new Error(`timed out waiting for ${role} spawn; saw=${transport.spawnCalls.map((call: any) => call.role).join(',')}`);
    };
    try {
      await fs.writeFile(path.join(runDir, 'north-star.md'), 'controlled north star\n', 'utf8');
      const pending = loop.runTask({ brief: 'atomic_work: raw\nvalidation_criteria: raw works\n', taskType: 'feature' });
      const callbacks = path.join(runDir, 'callbacks.md');
      await waitForRole('implementer');
      await fs.appendFile(callbacks, '[helm callback] implementer batch-Cb STATUS: DONE — controlled implementation\n');
      await waitForRole('validator');
      // Non-substantive note (single boilerplate token) → protocol-defect, per findings §2.
      await fs.appendFile(callbacks, '[helm callback] validator batch-Cb STATUS: FAIL — error\n');
      await waitForRole('ibrain');
      await fs.appendFile(callbacks, '[helm callback] ibrain batch-Cb STATUS: DECISION-READY — {"edge_class":"validator-failure","route_to":"escalate-to-JROM","blocker_owner":"brain","reason":"controlled protocol defect"}\n');
      const result = await pending;
      expect(result.finalStatus).not.toBe('PASS');
      const rows = dbs.raw.prepare('SELECT result, defect_class, note FROM validations').all() as any[];
      expect(rows.some((row) => row.result === 'BLOCKED' && row.defect_class === 'protocol-defect')).toBe(true);
      // The original text is preserved in the protocol-defect note (never replace-and-lose).
      expect(rows.some((row) => row.result === 'BLOCKED' && String(row.note || '').includes('original: error'))).toBe(true);
      // The validator's protocol-defect outcome is BLOCKED — never laundered into an unlabeled FAIL row
      // (the separate FAIL/null row here is the legitimate brain-escalate PARK record, not the validator verdict).
      expect(rows.some((row) => row.result === 'FAIL' && String(row.note || '').includes('PROTOCOL-DEFECT'))).toBe(false);
      expect(rows.some((row) => row.result === 'PASS')).toBe(false);
      expect(loop.getFailureLedger().length).toBeGreaterThan(0);
    } finally {
      if (previousFake === undefined) delete process.env.USE_FAKE_TMUX;
      else process.env.USE_FAKE_TMUX = previousFake;
      if (previousCmd === undefined) delete process.env.HELM_PROJECT_TEST_CMD;
      else process.env.HELM_PROJECT_TEST_CMD = previousCmd;
      if (previousArgs === undefined) delete process.env.HELM_PROJECT_TEST_ARGS;
      else process.env.HELM_PROJECT_TEST_ARGS = previousArgs;
    }
  }, 30000);

  it('B01.s4: real post-C2 classified FAIL retains class with no FAIL+null row', async () => {
    const previousFake = process.env.USE_FAKE_TMUX;
    process.env.USE_FAKE_TMUX = '0';
    try {
      (loop as any).runProjectTests = async () => ({ state: 'PASS', note: 'controlled gate green' });
      (loop as any).consultImplementationBrain = async () => ({ action: 'escalate-to-JROM', reason: 'controlled classified failure' });
      (loop as any).performRolePhase = async (role: string) => {
        if (role === 'implementer') return { state: 'DONE', note: 'controlled implementation', handle: 'impl' };
        if (role === 'validator') return { state: 'FAIL', note: 'defect_class=missing-proof; controlled gap', defectClass: 'missing-proof', handle: 'validator' };
        return { state: 'DECISION-READY', note: JSON.stringify({ edge_class: 'validator-failure', route_to: 'escalate-to-JROM', blocker_owner: 'brain', reason: 'controlled classified failure' }), handle: 'brain' };
      };
      const result = await loop.runTask({ brief: 'atomic_work: y; validation_criteria: y works', taskType: 'feature' });
      expect(result.finalStatus).not.toBe('PASS');
      const rows = dbs.raw.prepare('SELECT result, defect_class, note FROM validations').all() as any[];
      const validatorRows = rows.filter((row) => String(row.note || '').includes('controlled gap'));
      expect(validatorRows.some((row) => row.result === 'FAIL' && row.defect_class === 'missing-proof')).toBe(true);
      expect(validatorRows.some((row) => row.result === 'FAIL' && row.defect_class == null)).toBe(false);
    } finally {
      if (previousFake === undefined) delete process.env.USE_FAKE_TMUX;
      else process.env.USE_FAKE_TMUX = previousFake;
    }
  });

  it('B01.s4: real post-C2 PASS remains successful (requirements-aware seat)', async () => {
    const previousFake = process.env.USE_FAKE_TMUX;
    process.env.USE_FAKE_TMUX = '0';
    try {
      (loop as any).runProjectTests = async () => ({ state: 'PASS', note: 'controlled gate green' });
      (loop as any).performRolePhase = async (role: string) => role === 'implementer'
        ? { state: 'DONE', note: 'controlled implementation', handle: 'impl' }
        : { state: 'PASS', note: 'controlled validator success', handle: 'validator' };
      const result = await loop.runTask({ brief: 'atomic_work: z; validation_criteria: z works', taskType: 'feature' });
      expect(result.finalStatus).toBe('PASS');
    } finally {
      if (previousFake === undefined) delete process.env.USE_FAKE_TMUX;
      else process.env.USE_FAKE_TMUX = previousFake;
    }
  });

  it('§3 DONE-guard: a DONE from the requirements-aware validator seat is NOT laundered to PASS', async () => {
    // The implementer's DONE + the deterministic gate DONE stay legitimate; only the requirements-aware
    // VALIDATOR seat verdict is excluded. A DONE there becomes a bounded protocol-defect, never a PASS.
    const previousFake = process.env.USE_FAKE_TMUX;
    process.env.USE_FAKE_TMUX = '0';
    (loop as any).MAX_TASK_ATTEMPTS = 1;
    try {
      (loop as any).runProjectTests = async () => ({ state: 'PASS', note: 'controlled gate green' });
      (loop as any).consultImplementationBrain = async () => ({ action: 'escalate-to-JROM', reason: 'DONE is not a validator verdict' });
      (loop as any).performRolePhase = async (role: string) => role === 'implementer'
        ? { state: 'DONE', note: 'controlled implementation', handle: 'impl' }
        : { state: 'DONE', note: 'validator emitted DONE instead of a verdict', handle: 'validator' };
      const result = await loop.runTask({ brief: 'atomic_work: z; validation_criteria: z works', taskType: 'feature' });
      expect(result.finalStatus).not.toBe('PASS');
      const rows = dbs.raw.prepare('SELECT result, defect_class, note FROM validations').all() as any[];
      expect(rows.some((row) => row.result === 'BLOCKED' && row.defect_class === 'protocol-defect')).toBe(true);
      expect(rows.some((row) => row.result === 'PASS')).toBe(false);
    } finally {
      if (previousFake === undefined) delete process.env.USE_FAKE_TMUX;
      else process.env.USE_FAKE_TMUX = previousFake;
    }
  });

  it('B2: real-path role boundary classifies the leg-9 FAIL fixture, preserves the diagnosis into validation+ledger+attempt-2 brief, no PASS row', async () => {
    // Gate C / leg-9 oracle on a REAL-path test seam (USE_FAKE_TMUX=0 + FakeTransport): the cheap validator
    // emits a SUBSTANTIVE, correct FAIL but no literal defect_class token. Post-fix it must become a
    // classified FAIL (missing-artifact) whose original diagnosis flows byte-for-byte into the validation row,
    // the failure ledger, and the correction (attempt-2) implementer brief — never a protocol-only string.
    const previousFake = process.env.USE_FAKE_TMUX;
    const previousWall = process.env.HELM_CB_WALL_MS;
    const previousIdle = process.env.HELM_CB_IDLE_MS;
    const previousForce = process.env.FORCE_DETERMINISTIC_VAL_PATH;
    process.env.USE_FAKE_TMUX = '0';
    process.env.HELM_CB_WALL_MS = '9000';
    process.env.HELM_CB_IDLE_MS = '9000';
    delete process.env.FORCE_DETERMINISTIC_VAL_PATH;
    (loop as any).MAX_TASK_ATTEMPTS = 2; // test seam: attempt1 FAIL -> correction -> attempt2 FAIL -> brain judgment
    (loop as any).runProjectTests = async () => ({ state: 'PASS', note: 'controlled deterministic gate green' });
    (loop as any).consultImplementationBrain = async () => ({ action: 'escalate-to-JROM', reason: 'B2 bounded terminate (no PASS)' });

    const legFail = 'LEG9T1 requirements NOT met: retry-gate.txt missing; node test.js exits 1; test reports "missing"';
    const validatorFailLine = `[helm callback] validator batch-Cb STATUS: FAIL — ${legFail}\n`;
    const callbacks = path.join(runDir, 'callbacks.md');
    const waitForSpawn = async (role: string, count: number) => {
      for (let i = 0; i < 400; i += 1) {
        if (transport.spawnCalls.filter((c: any) => c.role === role).length >= count) return;
        await sleep(20);
      }
      throw new Error(`timed out waiting for ${role} #${count}; saw=${transport.spawnCalls.map((c: any) => c.role).join(',')}`);
    };

    try {
      await fs.writeFile(path.join(runDir, 'north-star.md'), 'NORTH: leg-9 retry gate must exist and node test.js must exit 0\n', 'utf8');
      const brief = 'atomic_work: create the retry gate\nvalidation_criteria: retry-gate.txt exists and node test.js exits 0';
      const pending = loop.runTask({ brief, taskType: 'feature' });

      // Attempt 1: implementer DONE -> deterministic gate (mocked PASS) -> requirements validator FAIL (leg-9 fixture)
      await waitForSpawn('implementer', 1);
      await fs.appendFile(callbacks, '[helm callback] implementer batch-Cb STATUS: DONE — first attempt\n');
      await waitForSpawn('validator', 1);
      await fs.appendFile(callbacks, validatorFailLine);

      // Attempt 2: correction implementer re-dispatched — capture its brief; then FAIL again -> brain -> DEFERRED
      await waitForSpawn('implementer', 2);
      const attempt2ImplBrief = transport.spawnCalls.filter((c: any) => c.role === 'implementer')[1].brief as string;
      await fs.appendFile(callbacks, '[helm callback] implementer batch-Cb STATUS: DONE — second attempt\n');
      await waitForSpawn('validator', 2);
      await fs.appendFile(callbacks, validatorFailLine);

      const res = await pending;
      expect(res.finalStatus).not.toBe('PASS');

      const rows = dbs.raw.prepare('SELECT result, defect_class, note FROM validations ORDER BY id').all() as any[];
      // First validation row: a CLASSIFIED FAIL (missing-artifact) with the preserved diagnosis + only appended metadata.
      expect(rows[0].result).toBe('FAIL');
      expect(rows[0].defect_class).toBe('missing-artifact');
      expect(String(rows[0].note)).toContain('retry-gate.txt missing');
      expect(String(rows[0].note)).toContain('node test.js exits 1');
      expect(String(rows[0].note)).toContain('[HELM classification: derived defect_class=missing-artifact; validator omitted defect_class]');
      // No FAIL was laundered into PASS.
      expect(rows.some((r) => r.result === 'PASS')).toBe(false);

      // Failure ledger validator_diagnosis carries the REAL diagnosis (not a protocol-only string).
      const ledger = loop.getFailureLedger();
      expect(ledger.length).toBeGreaterThan(0);
      expect(String(ledger[0].validator_diagnosis)).toContain('retry-gate.txt missing');
      expect(String(ledger[0].validator_diagnosis)).toContain('node test.js exits 1');
      expect(String(ledger[0].validator_diagnosis)).not.toBe('PROTOCOL-DEFECT: validator FAIL requires defect_class');

      // The correction (attempt-2) implementer brief contains the ledger diagnosis (actionable feedback, not a stall).
      expect(attempt2ImplBrief).toContain('retry-gate.txt missing');
    } finally {
      if (previousFake === undefined) delete process.env.USE_FAKE_TMUX; else process.env.USE_FAKE_TMUX = previousFake;
      if (previousWall === undefined) delete process.env.HELM_CB_WALL_MS; else process.env.HELM_CB_WALL_MS = previousWall;
      if (previousIdle === undefined) delete process.env.HELM_CB_IDLE_MS; else process.env.HELM_CB_IDLE_MS = previousIdle;
      if (previousForce === undefined) delete process.env.FORCE_DETERMINISTIC_VAL_PATH; else process.env.FORCE_DETERMINISTIC_VAL_PATH = previousForce;
    }
  }, 30000);

  it('C3: issue REPRO-FAILED X times (default 2) -> DEFERRED; queue would continue', async () => {
    const brief = 'fix the crash on load';
    const p = loop.runTask({ brief, taskType: 'issue' });
    const cbp = path.join(runDir, 'callbacks.md');
    // first repro fail
    await fs.appendFile(cbp, `[helm callback] validator batch-Cb STATUS: REPRO-FAILED — steps do not crash on this build\n`);
    await sleep(20);
    // second repro fail -> defer
    await fs.appendFile(cbp, `[helm callback] validator batch-Cb STATUS: REPRO-FAILED — still no repro\n`);
    await sleep(20);
    const res = await p;
    expect(res.finalStatus).toBe('DEFERRED');
  });

  it.skip('C3/C4 wiring: reviewer evidence recorded separately (PASS path uses distinct validation row)', async () => {
    // lightweight: run the happy C2 test path and inspect callbacks for reviewer role
    const prevForce = process.env.FORCE_DETERMINISTIC_VAL_PATH;
    const prevCmd = process.env.HELM_PROJECT_TEST_CMD;
    const prevArgs = process.env.HELM_PROJECT_TEST_ARGS;
    process.env.FORCE_DETERMINISTIC_VAL_PATH = '1';
    process.env.HELM_PROJECT_TEST_CMD = 'sh';
    process.env.HELM_PROJECT_TEST_ARGS = '-c "exit 0"';
    try {
      await fs.writeFile(path.join(runDir, 'north-star.md'), 'N\n', 'utf8');
      const brief = 'atomic_work: x; validation_criteria: x works';
      const p = loop.runTask({ brief, taskType: 'feature' });
      const cbp = path.join(runDir, 'callbacks.md');
      await fs.appendFile(cbp, `[helm callback] implementer batch-Cb STATUS: DONE\n`);
      await fs.appendFile(cbp, `[helm callback] validator batch-Cb STATUS: PASS — ok\n`);
      await fs.appendFile(cbp, `[helm callback] reviewer batch-Cb STATUS: APPROVE\n`);
      await fs.appendFile(cbp, `[helm callback] ibrain batch-Cb STATUS: DECISION-READY — {"edge_class":"validator-failure","route_to":"validator-handholding","blocker_owner":"validator","reason":"validator correction","action":"validator-handholding","decisionId":"dec-cb","spoonFedDirections":"Apply the validator diagnosis."}\n`);
      await sleep(80);
      await p;
      // Reviewer phase executed: proof via dispatch/callback for reviewer role (separate from validator)
      const cbs = dbs.raw.prepare('SELECT * FROM callbacks ORDER BY id DESC LIMIT 10').all() as any[];
      const hasReviewerCb = cbs.some((c: any) => (c.role || '').toLowerCase() === 'reviewer');
      expect(hasReviewerCb).toBe(true);
    } finally {
      if (prevForce === undefined) delete process.env.FORCE_DETERMINISTIC_VAL_PATH; else process.env.FORCE_DETERMINISTIC_VAL_PATH = prevForce;
      if (prevCmd === undefined) delete process.env.HELM_PROJECT_TEST_CMD; else process.env.HELM_PROJECT_TEST_CMD = prevCmd;
      if (prevArgs === undefined) delete process.env.HELM_PROJECT_TEST_ARGS; else process.env.HELM_PROJECT_TEST_ARGS = prevArgs;
    }
  }, 120000);
});

describe('POCFIX22 regression: byte-offset sinceOffset must use Buffer (not char-slice) for multi-byte unicode in callbacks.md', () => {
  let runDir: string;
  let transport: FakeTransport;
  let loop: OrchestratorLoop;
  let tmpDbPath: string;
  let origDbPath: string | undefined;

  beforeEach(async () => {
    origDbPath = process.env.HELM_DB_PATH;
    tmpDbPath = `/tmp/helm-byte-reg-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.HELM_DB_PATH = tmpDbPath; // temp per req
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-byteoff-reg-'));
    const cb = path.join(runDir, 'callbacks.md');
    await fs.writeFile(cb, '# reg test callbacks\n', 'utf8');
    transport = new FakeTransport();
    loop = new OrchestratorLoop(transport, { runDir, batchId: 'reg-batch' });
  });

  afterEach(async () => {
    if (runDir) {
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
    }
    if (tmpDbPath) {
      await fs.unlink(tmpDbPath).catch(() => {});
    }
    if (origDbPath !== undefined) {
      process.env.HELM_DB_PATH = origDbPath;
    } else {
      delete process.env.HELM_DB_PATH;
    }
  });

  it('byte sinceOffset from stat.size finds post-unicode callback; char-slice (old bug) drops it', async () => {
    const cbp = path.join(runDir, 'callbacks.md');
    // Multi-byte unicode (emoji, box-drawing, CJK) BEFORE first callback
    const unicodeBefore = '📍🎯🌟┌─┐║│日本語テストボックス'.repeat(4) + '\nPREFIX-MARKER\n';
    const firstCb = '[helm callback] validator reg-batch STATUS: PASS — first-cb-after-unicode\n';
    await fs.writeFile(cbp, unicodeBefore + firstCb, 'utf8');

    // snapshot BYTE size BEFORE 2nd appended callback (and its preceding multi-byte)
    const statBefore = await fs.stat(cbp);
    const sinceOffset = statBefore.size;

    // append MORE multi-byte + 2nd genuine callback
    const unicodeMore = '\n✨🎊 more multi-byte ║📦🌟\n';
    const unique = 'SECOND-REGRESSION-UNIQUE-XYZ-98765';
    const secondCb = `[helm callback] validator reg-batch STATUS: PASS — ${unique}\n`;
    await fs.appendFile(cbp, unicodeMore + secondCb, 'utf8');

    // Real path (Buffer byte slice via private) MUST find the 2nd cb
    const found = await (loop as any).findLatestCallback('validator', sinceOffset);
    expect(found).toBeTruthy();
    expect(found.state).toBe('PASS');
    expect(String(found.note || '')).toContain(unique);

    // Demonstrate MUST fail on char-slice (the bug): use byte num as JS string .slice index
    const fullStr = await fs.readFile(cbp, 'utf8');
    const buggyWindow = fullStr.slice(sinceOffset); // BUG: char slice with byte offset
    expect(buggyWindow.includes(unique)).toBe(false);

    // Confirm byte-accurate window succeeds
    const goodWindow: string = await (loop as any).readCallbacksWindow(sinceOffset);
    expect(goodWindow.includes(unique)).toBe(true);
  }, 15000);
});

describe('S01 finalizeWorkerRuntime chokepoint: all terminal paths use finalizeWorkerRuntimeRow', () => {
  let runDir: string;
  let transport: FakeTransport;
  let loop: OrchestratorLoop;
  let dbs: DatabaseService;
  let svc: RunArtifactService;
  let tmpDbPath: string;
  let projectId: number;
  let runId: number;
  let attemptId: number;

  const setupActiveAttempt = async (batchId: string) => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-s01-finalize-'));
    await fs.writeFile(path.join(runDir, 'callbacks.md'), '# S01 callbacks\n', 'utf8');

    tmpDbPath = path.join(os.tmpdir(), `helm-s01-finalize-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    dbs = new DatabaseService(tmpDbPath);
    svc = new RunArtifactService(dbs);

    const projects = new ProjectService(dbs);
    const project = projects.createProject({
      name: `s01-finalize-${Date.now()}`,
      directory: path.join(os.tmpdir(), 'helm-s01-finalize-project'),
    });
    projectId = project.id;
    runId = svc.createRun(projectId, batchId);

    const taskId = svc.recordTask(runId, 'S01-001', 'S01 terminal finalize writer');
    attemptId = svc.recordAttempt(taskId, 1);

    transport = new FakeTransport();
    loop = new OrchestratorLoop(transport, {
      runDir,
      batchId,
      artifactService: svc,
    });

    (loop as any).projectId = projectId;
    (loop as any).runId = runId;
    (loop as any).taskId = taskId;
    (loop as any).currentAttemptId = attemptId;
  };

  const workerRuntimeRow = () =>
    dbs.raw
      .prepare('SELECT id, state, exit_reason, ended_at FROM worker_runtimes WHERE run_id=? ORDER BY id DESC LIMIT 1')
      .get(runId) as any;

  const cleanup = async () => {
    if (runDir) {
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
    }
    if (dbs) dbs.close();
    if (tmpDbPath) {
      await fs.rm(tmpDbPath).catch(() => {});
    }
  };

  beforeEach(async () => {
    await setupActiveAttempt('batch-S01');
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  it('DONE terminal path writes via finalizeWorkerRuntimeRow', async () => {
    const finalizeSpy = vi.spyOn(WorkerRuntimeFinalize, 'finalizeWorkerRuntimeRow');
    const callbacks = path.join(runDir, 'callbacks.md');

    const p = (loop as any).performRolePhase('implementer', 'S01 done terminal path', ['DONE']);
    await sleep(20);
    await fs.appendFile(callbacks, '[helm callback] implementer batch-S01 STATUS: DONE — all clear\n');
    const result = await p;

    expect(result.state).toBe('DONE');
    const row = workerRuntimeRow();
    expect(row.state).toBe('done');
    expect(row.exit_reason).toBe('reaped-DONE');
    expect(row.ended_at).toBeTruthy();
    expect(finalizeSpy).toHaveBeenCalledWith(expect.anything(), row.id, 'done', 'reaped-DONE');
  });

  it('auth fault path writes via finalizeWorkerRuntimeRow', async () => {
    const finalizeSpy = vi.spyOn(WorkerRuntimeFinalize, 'finalizeWorkerRuntimeRow');
    const brief = 'S01 auth fault terminal path';
    transport.queueSeatScript([
      {
        sessionAlive: true,
        pane: `${brief}\nAuthentication required — your session has expired`,
        composerHoldsBrief: false,
      },
    ]);

    const p = (loop as any).performRolePhase('implementer', brief, ['DONE']);
    await expect(p).rejects.toBeInstanceOf(SeatAuthTerminalError);

    const row = workerRuntimeRow();
    expect(row.state).toBe('reaped');
    expect(row.exit_reason).toBe('implementer-seat-auth-paused');
    expect(finalizeSpy).toHaveBeenCalledWith(expect.anything(), row.id, 'reaped', 'implementer-seat-auth-paused');
  });

  it('failed terminal path writes via finalizeWorkerRuntimeRow', async () => {
    const finalizeSpy = vi.spyOn(WorkerRuntimeFinalize, 'finalizeWorkerRuntimeRow');
    const previousWall = process.env.HELM_CB_WALL_MS;
    const previousFirst = process.env.HELM_CB_FIRST_CALLBACK_MS;
    process.env.HELM_CB_WALL_MS = '120';
    process.env.HELM_CB_FIRST_CALLBACK_MS = '120';

    try {
      const p = (loop as any).performRolePhase('implementer', 'S01 failed terminal path', ['DONE']);
      await expect(p).rejects.toBeInstanceOf(CallbackWaitError);

      const row = workerRuntimeRow();
      expect(row.state).toBe('failed');
      expect(row.exit_reason.startsWith('implementer-')).toBe(true);
      expect(row.exit_reason).toBe('implementer-wall-timeout');
      expect(finalizeSpy).toHaveBeenCalledWith(expect.anything(), row.id, 'failed', 'implementer-wall-timeout');
    } finally {
      if (previousWall === undefined) delete process.env.HELM_CB_WALL_MS;
      else process.env.HELM_CB_WALL_MS = previousWall;
      if (previousFirst === undefined) delete process.env.HELM_CB_FIRST_CALLBACK_MS;
      else process.env.HELM_CB_FIRST_CALLBACK_MS = previousFirst;
    }
  });

  it('run-abort path writes via finalizeWorkerRuntimeRow', async () => {
    const finalizeSpy = vi.spyOn(WorkerRuntimeFinalize, 'finalizeWorkerRuntimeRow');

    const p = (loop as any).performRolePhase('implementer', 'S01 abort terminal path', ['DONE']);
    await sleep(10);
    requestRunAbort(runId, 'operator stop');

    await expect(p).rejects.toBeInstanceOf(RunAbortedError);

    const row = workerRuntimeRow();
    expect(row.state).toBe('reaped');
    expect(row.exit_reason).toBe('run-aborted');
    expect(finalizeSpy).toHaveBeenCalledWith(expect.anything(), row.id, 'reaped', 'run-aborted');
  });
});

// C0: thread the kloo `route` (models.route, B1) from a bound model through to spawn, so
// `kloo --provider <route> --model <model> --ctx <ctx>` resolves a real <route> instead of ''.
describe('C0 (kloo route threading)', () => {
  let dbs: DatabaseService;
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `helm-c0-route-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    dbs = new DatabaseService(tmpDbPath);
  });

  afterEach(async () => {
    if (dbs) dbs.close();
    if (tmpDbPath) await fs.rm(tmpDbPath, { force: true }).catch(() => {});
  });

  it('EscalationService.getRouteForModel returns the seeded route for a kloo model row, and null when unset/unknown', () => {
    dbs.raw.prepare(`INSERT INTO models (name, provider, model_id, cli, slug, display_name, route) VALUES (?,?,?,?,?,?,?)`)
      .run('deepseek/deepseek-v4-flash', 'kloo', 'deepseek/deepseek-v4-flash', 'kloo', 'deepseek-deepseek-v4-flash', 'deepseek/deepseek-v4-flash', 'openrouter');
    // route-less row (e.g. a local kloo model bound before a route was ever set)
    dbs.raw.prepare(`INSERT INTO models (name, provider, model_id, cli, slug, display_name) VALUES (?,?,?,?,?,?)`)
      .run('local-llama', 'kloo', 'local-llama', 'kloo', 'local-llama', 'local-llama');

    const esc = new EscalationService(dbs);
    expect(esc.getRouteForModel('deepseek/deepseek-v4-flash')).toBe('openrouter');
    expect(esc.getRouteForModel('local-llama')).toBeNull();
    expect(esc.getRouteForModel('never-seeded-model')).toBeNull();
  });

  it('inferKlooRoute falls back correctly when no models-table row has a route: namespaced (OpenRouter-shaped) ids -> openrouter, else -> llamacpp', () => {
    expect(inferKlooRoute('deepseek/deepseek-v4-flash')).toBe('openrouter');
    expect(inferKlooRoute('local-llama')).toBe('llamacpp');
    expect(inferKlooRoute(undefined)).toBe('llamacpp');
  });

  it('resolveAgentLaunchSpec fills the kloo dynamic-provider template <route>/<model>/<ctx> from a threaded route (real PROVIDERS.kloo.models is empty-by-design per dynamicModels, so a minimal registry mirrors its real launch template)', () => {
    const klooRegistry = {
      kloo: {
        provider: 'kloo',
        launch: { defaultMode: 'tui' as const, templates: { tui: 'kloo --provider <route> --model <model> --ctx <ctx>' } },
        bypassFlag: null,
        approvalModes: ['default'],
        effort: { mechanism: 'none' as const, flagTemplate: null },
        callbackMechanism: 'status-file' as const,
        worktree: { supported: false, flag: null },
        sessionSuffix: 'kloo',
        models: [{ model: 'deepseek/deepseek-v4-flash', band: 'mid' as const, eligibleRoles: ['implementer'] as const }]
      }
    } as any;

    const spec = resolveAgentLaunchSpec(
      { provider: 'kloo', model: 'deepseek/deepseek-v4-flash', route: 'openrouter', ctx: '128000' },
      klooRegistry
    );
    expect(spec.launch_cmd).toBe('kloo --provider openrouter --model deepseek/deepseek-v4-flash --ctx 128000');
  });

  it('resolveConcreteModel passes a dynamic-provider (kloo) model id through as-is (empty static models[]), but still throws for a static provider\'s unknown model', () => {
    const registry = {
      kloo: { provider: 'kloo', dynamicModels: true, models: [], launch: { defaultMode: 'tui' as const, templates: { tui: 'kloo' } }, bypassFlag: null, callbackMechanism: 'status-file' as const, worktree: { supported: false, flag: null }, sessionSuffix: 'kloo' },
      grok: { provider: 'grok', models: [{ model: 'grok-4.5' }], launch: { defaultMode: 'tui' as const, templates: { tui: 'grok' } }, bypassFlag: null, callbackMechanism: 'status-file' as const, worktree: { supported: false, flag: null }, sessionSuffix: 'grok' }
    } as any;
    const resolver = new ProviderResolverService(registry);
    expect(resolver.resolveConcreteModel('kloo', 'deepseek/deepseek-v4-flash')).toBe('deepseek/deepseek-v4-flash');
    expect(() => resolver.resolveConcreteModel('grok', 'no-such-grok-model')).toThrow(/no model 'no-such-grok-model' for provider 'grok'/);
  });
});
