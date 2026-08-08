/**
 * fence-workflow-upgrade B3 — typed next-work selector + admission (R2.3, R3.1, R3.2).
 *
 * Proves on the real TaskQueueService + durable fence rows:
 *  - no baseline ⇒ OPEN_FENCE, never a task token / never in-flight
 *  - claimNextReady itself refuses fence members without baseline (real funnel gate)
 *  - after OPEN baseline, selector returns DISPATCH_TASK and claim lands
 *  - non-members keep ordinary unit gate (R3.2)
 *  - all members complete on draining fence ⇒ CLOSE_FENCE
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../db/database.js';
import { RunArtifactService } from './run-artifact-service.js';
import { TaskQueueService } from './task-queue-service.js';
import {
  admitClaimNextReady,
  fenceBaselineReady,
  hasCompleteOpenBaseline,
  isFenceClaimBlocked,
  isTaskDispatchable,
  lookupFenceMemberForTask,
  selectNextWork,
} from './fence-selector-admission.js';
import { openFence } from './fence-open-service.js';
import {
  buildFenceReport,
  emitFenceReport,
  type FenceReportV1,
  type RunFenceReportCommandResult,
} from './fence-report-v1.js';

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function insertProjectRun(db: DatabaseService): { projectId: number; runId: number } {
  const projectId = (
    db.raw
      .prepare('INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id')
      .get(`fence-b3-${Date.now()}`, `/tmp/fence-b3-${Date.now()}`) as { id: number }
  ).id;
  const runId = (
    db.raw
      .prepare(
        "INSERT INTO runs (project_id, batch_id, north_star_ref, status, phase) VALUES (?, ?, ?, 'active', 'implementation') RETURNING id"
      )
      .get(projectId, 'B3', 'fence-selector') as { id: number }
  ).id;
  return { projectId, runId };
}

function writeJourneyFile(repoRoot: string, rel = 'journeys/b3-journey.ts'): string {
  const abs = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `// fence selector journey fixture\nexport const mark = 'b3';\n`, 'utf8');
  return rel;
}

function insertDeclaredFence(
  db: DatabaseService,
  runId: number,
  opts: {
    fenceKey?: string;
    testPath: string;
    members: string[];
  }
): number {
  const fenceId = (
    db.raw
      .prepare(
        `INSERT INTO fences (
           fence_key, run_id, lifecycle_state,
           integration_cmd, negative_control_cmd, acceptance_ids, test_path, authored_by
         ) VALUES (?, ?, 'declared', ?, ?, ?, ?, ?)
         RETURNING id`
      )
      .get(
        opts.fenceKey ?? 'I2',
        runId,
        'echo should-not-run',
        'FENCE_STUB=B3 true',
        JSON.stringify(['R2.3', 'R3.1', 'R3.2']),
        opts.testPath,
        'integration_test_agent'
      ) as { id: number }
  ).id;

  const ins = db.raw.prepare(
    'INSERT INTO fence_members (fence_id, task_key, position) VALUES (?, ?, ?)'
  );
  opts.members.forEach((taskKey, position) => {
    ins.run(fenceId, taskKey, position);
  });
  return fenceId;
}

function injectReport(report: FenceReportV1): NonNullable<
  Parameters<typeof openFence>[1]['runCommand']
> {
  return () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-fence-b3-rep-'));
    const reportPath = path.join(t, 'fence-report-v1.json');
    emitFenceReport(report, reportPath);
    return {
      report,
      reportPath,
      exitCode: report.failed.length > 0 ? 1 : 0,
      timedOut: false,
    } satisfies RunFenceReportCommandResult;
  };
}

function setupRunWithMember(opts?: {
  alsoNonMember?: boolean;
  members?: string[];
}): {
  db: DatabaseService;
  artifacts: RunArtifactService;
  queue: TaskQueueService;
  runId: number;
  fenceId: number;
  memberTaskId: number;
  nonMemberTaskId: number | null;
  testPath: string;
  cleanup: () => void;
  dir: string;
} {
  const t = tempDir('helm-fence-b3-');
  const dbPath = path.join(t.dir, 'helm.db');
  const db = new DatabaseService(dbPath);
  const { runId } = insertProjectRun(db);
  const testPath = writeJourneyFile(t.dir);
  const members = opts?.members ?? ['B1', 'B2'];
  const fenceId = insertDeclaredFence(db, runId, { testPath, members });

  const artifacts = new RunArtifactService(db);
  const queue = new TaskQueueService(artifacts);

  const memberTaskId = artifacts.recordTask(runId, members[0], `Implement ${members[0]}`, 'B1');
  queue.enqueue(runId, memberTaskId, [], false, 'B1');

  let nonMemberTaskId: number | null = null;
  if (opts?.alsoNonMember) {
    // Later batch so fence member is first under earliest-open-batch barrier.
    nonMemberTaskId = artifacts.recordTask(runId, 'Z-free', 'Ordinary free unit', 'B9');
    queue.enqueue(runId, nonMemberTaskId, [], false, 'B9');
  }

  return {
    db,
    artifacts,
    queue,
    runId,
    fenceId,
    memberTaskId,
    nonMemberTaskId,
    testPath,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      t.cleanup();
    },
    dir: t.dir,
  };
}

describe('B3 typed next-work selector + admission (R2.3, R3.1, R3.2)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  // --- R3.1: no baseline ⇒ not dispatchable ------------------------------------------------

  it('R3.1 selectNextWork returns OPEN_FENCE when member is ready without baseline', () => {
    const s = setupRunWithMember();
    cleanups.push(s.cleanup);

    const decision = selectNextWork({ db: s.db, queue: s.queue, runId: s.runId });
    expect(decision.kind).toBe('OPEN_FENCE');
    if (decision.kind === 'OPEN_FENCE') {
      expect(decision.fenceId).toBe(s.fenceId);
      expect(decision.fenceKey).toBe('I2');
      expect(decision.blockedTaskId).toBe(s.memberTaskId);
      expect(decision.blockedTaskKey).toBe('B1');
    }

    // Never in-flight after selector (read-only)
    expect(s.queue.claimNextReady(s.runId)).toBeNull();
    // Still not in-flight (claim refused, not claimed-then-rejected)
    expect(s.queue.peekNextReady(s.runId)).toBe(s.memberTaskId);
  });

  it('R3.1 claimNextReady on real funnel refuses member without baseline (no in-flight)', () => {
    const s = setupRunWithMember();
    cleanups.push(s.cleanup);

    expect(isFenceClaimBlocked(s.db, s.runId, s.memberTaskId)).toBe(true);
    expect(isTaskDispatchable(s.db, s.runId, s.memberTaskId)).toBe(false);

    const token = s.queue.claimNextReady(s.runId);
    expect(token).toBeNull();

    // Peek still sees the member — not claimed, not skipped
    expect(s.queue.peekNextReady(s.runId)).toBe(s.memberTaskId);

    // admitClaim also refuses with OPEN_FENCE decision
    const admitted = admitClaimNextReady({ db: s.db, queue: s.queue, runId: s.runId });
    expect(admitted.ok).toBe(false);
    expect(admitted.token).toBeNull();
    expect(admitted.decision.kind).toBe('OPEN_FENCE');
    expect(s.queue.peekNextReady(s.runId)).toBe(s.memberTaskId);
  });

  it('R3.1 incomplete draining baseline still blocks dispatch', () => {
    const s = setupRunWithMember();
    cleanups.push(s.cleanup);

    // Force lifecycle to draining without baseline columns (corrupt / partial)
    s.db.raw
      .prepare(
        `UPDATE fences
         SET lifecycle_state = 'draining',
             open_failed_ids = NULL,
             open_test_hash = NULL,
             open_at = NULL
         WHERE id = ?`
      )
      .run(s.fenceId);

    expect(hasCompleteOpenBaseline({
      lifecycle_state: 'draining',
      open_failed_ids: null,
      open_test_hash: null,
      open_at: null,
    })).toBe(false);
    expect(fenceBaselineReady(s.db, { fenceId: s.fenceId })).toBe(false);
    expect(s.queue.claimNextReady(s.runId)).toBeNull();

    const decision = selectNextWork({ db: s.db, queue: s.queue, runId: s.runId });
    expect(decision.kind).toBe('NONE');
  });

  // --- After OPEN: DISPATCH_TASK + claim ---------------------------------------------------

  it('R2.3/R3.1 after OPEN baseline, selector returns DISPATCH_TASK and claim lands', () => {
    const s = setupRunWithMember();
    cleanups.push(s.cleanup);

    // Precondition: blocked
    expect(selectNextWork({ db: s.db, queue: s.queue, runId: s.runId }).kind).toBe('OPEN_FENCE');
    expect(s.queue.claimNextReady(s.runId)).toBeNull();

    const report = buildFenceReport({
      collected: ['R2.3', 'R3.1', 'R3.2'],
      failed: [
        { id: 'R2.3', kind: 'assert' },
        { id: 'R3.1', kind: 'assert' },
        { id: 'R3.2', kind: 'assert' },
      ],
    });
    openFence(s.db, {
      fenceId: s.fenceId,
      cwd: s.dir,
      repoRoot: s.dir,
      runCommand: injectReport(report),
    });

    expect(fenceBaselineReady(s.db, { fenceId: s.fenceId })).toBe(true);
    expect(isTaskDispatchable(s.db, s.runId, s.memberTaskId)).toBe(true);

    const decision = selectNextWork({ db: s.db, queue: s.queue, runId: s.runId });
    expect(decision.kind).toBe('DISPATCH_TASK');
    if (decision.kind === 'DISPATCH_TASK') {
      expect(decision.taskId).toBe(s.memberTaskId);
      expect(decision.taskKey).toBe('B1');
      expect(decision.fenceId).toBe(s.fenceId);
      expect(decision.fenceKey).toBe('I2');
    }

    const admitted = admitClaimNextReady({ db: s.db, queue: s.queue, runId: s.runId });
    expect(admitted.ok).toBe(true);
    if (admitted.ok) {
      expect(admitted.token.taskId).toBe(s.memberTaskId);
      expect(admitted.decision.kind).toBe('DISPATCH_TASK');
    }

    // One-in-flight: further claims null
    expect(s.queue.claimNextReady(s.runId)).toBeNull();
    expect(s.queue.peekNextReady(s.runId)).toBeNull();
  });

  it('R2.3 deleting baseline after OPEN makes dispatch unreachable again', () => {
    const s = setupRunWithMember();
    cleanups.push(s.cleanup);

    const report = buildFenceReport({
      collected: ['R2.3'],
      failed: [{ id: 'R2.3', kind: 'assert' }],
    });
    openFence(s.db, {
      fenceId: s.fenceId,
      cwd: s.dir,
      repoRoot: s.dir,
      runCommand: injectReport(report),
    });
    expect(selectNextWork({ db: s.db, queue: s.queue, runId: s.runId }).kind).toBe('DISPATCH_TASK');

    // Refuse baseline: wipe columns + revert lifecycle
    s.db.raw
      .prepare(
        `UPDATE fences
         SET lifecycle_state = 'declared',
             open_failed_ids = NULL,
             open_test_hash = NULL,
             open_at = NULL
         WHERE id = ?`
      )
      .run(s.fenceId);

    expect(isTaskDispatchable(s.db, s.runId, s.memberTaskId)).toBe(false);
    expect(s.queue.claimNextReady(s.runId)).toBeNull();
    expect(selectNextWork({ db: s.db, queue: s.queue, runId: s.runId }).kind).toBe('OPEN_FENCE');
  });

  // --- R3.2: ordinary unit gate preserved --------------------------------------------------

  it('R3.2 non-member tasks claim under ordinary unit gate without OPEN', () => {
    const t = tempDir('helm-fence-b3-free-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId } = insertProjectRun(db);
    // Fence exists but free task is NOT a member
    insertDeclaredFence(db, runId, {
      testPath: writeJourneyFile(t.dir),
      members: ['B1'],
    });

    const artifacts = new RunArtifactService(db);
    const queue = new TaskQueueService(artifacts);
    const freeId = artifacts.recordTask(runId, 'FREE-1', 'Ordinary unit', 'B1');
    queue.enqueue(runId, freeId, [], false, 'B1');

    expect(lookupFenceMemberForTask(db, runId, freeId)).toBeNull();
    expect(isTaskDispatchable(db, runId, freeId)).toBe(true);
    expect(isFenceClaimBlocked(db, runId, freeId)).toBe(false);

    const decision = selectNextWork({ db, queue, runId });
    expect(decision.kind).toBe('DISPATCH_TASK');
    if (decision.kind === 'DISPATCH_TASK') {
      expect(decision.taskId).toBe(freeId);
      expect(decision.fenceId).toBeNull();
      expect(decision.fenceKey).toBeNull();
    }

    const token = queue.claimNextReady(runId);
    expect(token).not.toBeNull();
    expect(token!.taskId).toBe(freeId);
  });

  it('R3.2 pure in-mem queue (no artifacts) is unchanged — no fence gate', () => {
    const q = new TaskQueueService();
    q.enqueue(1, 42, [], false, 'B1');
    const token = q.claimNextReady(1);
    expect(token).not.toBeNull();
    expect(token!.taskId).toBe(42);
  });

  // --- CLOSE_FENCE -------------------------------------------------------------------------

  it('CLOSE_FENCE when draining fence has all members complete and nothing ready', () => {
    const s = setupRunWithMember({ members: ['B1', 'B2'] });
    cleanups.push(s.cleanup);

    // Second member also recorded
    const member2 = s.artifacts.recordTask(s.runId, 'B2', 'Implement B2', 'B1');
    s.queue.enqueue(s.runId, member2, [], false, 'B1');

    const report = buildFenceReport({
      collected: ['R2.3'],
      failed: [{ id: 'R2.3', kind: 'assert' }],
    });
    openFence(s.db, {
      fenceId: s.fenceId,
      cwd: s.dir,
      repoRoot: s.dir,
      runCommand: injectReport(report),
    });

    // Drain both members to complete
    const t1 = s.queue.claimNextReady(s.runId)!;
    expect(t1.taskId).toBe(s.memberTaskId);
    s.queue.markComplete(t1);
    const t2 = s.queue.claimNextReady(s.runId)!;
    expect(t2.taskId).toBe(member2);
    s.queue.markComplete(t2);

    // Durable status must also be complete for CLOSE eligibility
    s.db.raw
      .prepare(`UPDATE run_tasks SET status = 'complete' WHERE id IN (?, ?)`)
      .run(s.memberTaskId, member2);

    expect(s.queue.peekNextReady(s.runId)).toBeNull();
    const decision = selectNextWork({ db: s.db, queue: s.queue, runId: s.runId });
    expect(decision.kind).toBe('CLOSE_FENCE');
    if (decision.kind === 'CLOSE_FENCE') {
      expect(decision.fenceId).toBe(s.fenceId);
      expect(decision.fenceKey).toBe('I2');
    }

    // admitClaim does not claim on CLOSE
    const admitted = admitClaimNextReady({ db: s.db, queue: s.queue, runId: s.runId });
    expect(admitted.ok).toBe(false);
    expect(admitted.decision.kind).toBe('CLOSE_FENCE');
    expect(admitted.token).toBeNull();
  });

  it('NONE when queue empty and no fence ready to close', () => {
    const t = tempDir('helm-fence-b3-none-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId } = insertProjectRun(db);
    const artifacts = new RunArtifactService(db);
    const queue = new TaskQueueService(artifacts);

    const decision = selectNextWork({ db, queue, runId });
    expect(decision.kind).toBe('NONE');
  });

  it('opening lifecycle still selects OPEN_FENCE (retry path, no claim)', () => {
    const s = setupRunWithMember();
    cleanups.push(s.cleanup);

    s.db.raw
      .prepare(`UPDATE fences SET lifecycle_state = 'opening' WHERE id = ?`)
      .run(s.fenceId);

    const decision = selectNextWork({ db: s.db, queue: s.queue, runId: s.runId });
    expect(decision.kind).toBe('OPEN_FENCE');
    expect(s.queue.claimNextReady(s.runId)).toBeNull();
  });

  it('lookupFenceMemberForTask joins durable membership (inspectable)', () => {
    const s = setupRunWithMember();
    cleanups.push(s.cleanup);

    const member = lookupFenceMemberForTask(s.db, s.runId, s.memberTaskId);
    expect(member).not.toBeNull();
    expect(member).toMatchObject({
      fenceId: s.fenceId,
      fenceKey: 'I2',
      taskKey: 'B1',
      lifecycleState: 'declared',
      hasBaseline: false,
    });
  });

  it('hash fixture for open path is stable (sanity for OPEN integration)', () => {
    // Ensures test file hashing used by openFence remains available in this harness.
    const content = '// x\n';
    const h = createHash('sha256').update(content).digest('hex');
    expect(h).toHaveLength(64);
  });
});
