/**
 * fence-workflow-upgrade B4 - production drainDispatch OPEN ordering (R2.3).
 *
 * Proves the real RunOrchestratorService.drainDispatch caller asks for OPEN_FENCE before
 * member dispatch, and that a refused OPEN baseline leaves member dispatch unreachable.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { RunArtifactService } from './run-artifact-service.js';
import { TaskQueueService } from './task-queue-service.js';
import { RunOrchestratorService } from './run-orchestrator-service.js';
import { FakeTransport } from './fake-transport.js';

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeJourneyFile(repoRoot: string, rel = 'journeys/b4-open-order.ts'): string {
  const abs = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `// B4 OPEN ordering journey fixture\nexport const mark = 'b4';\n`, 'utf8');
  return rel;
}

function writeFenceReporter(repoRoot: string, mode: 'proving-red' | 'already-green'): string {
  const scriptPath = path.join(repoRoot, `${mode}.cjs`);
  const failed =
    mode === 'proving-red'
      ? `[{ id: 'R2.3', kind: 'assert' }]`
      : `[]`;
  fs.writeFileSync(
    scriptPath,
    [
      `const fs = require('node:fs');`,
      `fs.appendFileSync(${JSON.stringify(path.join(repoRoot, 'events.log'))}, 'open\\n');`,
      `fs.writeFileSync(process.env.FENCE_REPORT_PATH, JSON.stringify({`,
      `  schema: 'fence-report-v1',`,
      `  collected: ['R2.3'],`,
      `  passed: ${mode === 'already-green' ? `['R2.3']` : `[]`},`,
      `  failed: ${failed},`,
      `}, null, 2));`,
      `process.exit(${mode === 'proving-red' ? '1' : '0'});`,
    ].join('\n'),
    'utf8'
  );
  return `node ${scriptPath}`;
}

function setup(mode: 'proving-red' | 'already-green') {
  const t = tempDir('helm-fence-b4-');
  const db = new DatabaseService(path.join(t.dir, 'helm.db'));
  const artifacts = new RunArtifactService(db);
  const queue = new TaskQueueService(artifacts);

  const projectId = (
    db.raw
      .prepare('INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id')
      .get(`fence-b4-${Date.now()}`, t.dir) as { id: number }
  ).id;
  const runId = artifacts.createRun(projectId, 'B4', path.join(t.dir, 'north-star.md'));
  db.raw.prepare("UPDATE runs SET status = 'active', phase = 'implementation' WHERE id = ?").run(runId);

  const testPath = writeJourneyFile(t.dir);
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
        'I2',
        runId,
        writeFenceReporter(t.dir, mode),
        'B4_NEGATIVE_CONTROL=1 true',
        JSON.stringify(['R2.3']),
        testPath,
        'integration_test_agent'
      ) as { id: number }
  ).id;
  db.raw
    .prepare('INSERT INTO fence_members (fence_id, task_key, position) VALUES (?, ?, 0)')
    .run(fenceId, 'B4-member');

  const taskId = artifacts.recordTask(runId, 'B4-member', 'Implement fenced member', 'B4');
  queue.enqueue(runId, taskId, [], false, 'B4');

  const parser = {
    async loadPlanFromRunDir() {
      return {
        tasks: [
          {
            task_key: 'B4-member',
            atomic_work: 'Implement fenced member',
            validation_criteria: 'R2.3 dispatch after OPEN baseline',
            task_type: 'feature',
            req_refs: ['R2.3'],
          },
        ],
      };
    },
  };

  const orchestrator = new RunOrchestratorService({
    artifacts,
    planning: {} as any,
    parser: parser as any,
    queue,
    transport: new FakeTransport(),
    projectService: {} as any,
    assignmentService: {} as any,
    notificationTransport: { notify() {} },
  });

  return {
    db,
    artifacts,
    queue,
    runId,
    runDir: t.dir,
    project: { id: projectId, name: 'fence-b4', directory: t.dir },
    orchestrator,
    taskId,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      t.cleanup();
    },
  };
}

describe('B4 drainDispatch OPEN ordering (R2.3)', () => {
  const cleanups: Array<() => void> = [];
  const oldSkipDeploy = process.env.HELM_SKIP_BATCH_DEPLOY;
  const oldNodeEnv = process.env.NODE_ENV;
  const oldUseFakeTmux = process.env.USE_FAKE_TMUX;

  afterEach(() => {
    process.env.HELM_SKIP_BATCH_DEPLOY = oldSkipDeploy;
    process.env.NODE_ENV = oldNodeEnv;
    process.env.USE_FAKE_TMUX = oldUseFakeTmux;
    while (cleanups.length) cleanups.pop()!();
  });

  it('opens the fence before the first member dispatch row', async () => {
    process.env.HELM_SKIP_BATCH_DEPLOY = '1';
    process.env.NODE_ENV = 'test';
    process.env.USE_FAKE_TMUX = '1';
    const s = setup('proving-red');
    cleanups.push(s.cleanup);

    const dispatchSawBaseline: boolean[] = [];
    const fakeLoop = {
      runTask: async (config: { preExistingTaskId?: number }) => {
        fs.appendFileSync(path.join(s.runDir, 'events.log'), 'dispatch\n');
        const baseline = s.db.raw
          .prepare('SELECT lifecycle_state, open_failed_ids, open_test_hash, open_at FROM fences WHERE run_id = ?')
          .get(s.runId) as {
          lifecycle_state: string;
          open_failed_ids: string | null;
          open_test_hash: string | null;
          open_at: string | null;
        };
        dispatchSawBaseline.push(
          baseline.lifecycle_state === 'draining' &&
            baseline.open_failed_ids === JSON.stringify(['R2.3']) &&
            !!baseline.open_test_hash &&
            !!baseline.open_at
        );
        const attemptId = s.artifacts.recordAttempt(config.preExistingTaskId!, 1);
        s.artifacts.recordDispatch(attemptId, 'implementer', 'prompts/b4.md', 'fake:b4');
        return { finalStatus: 'PASS' as const };
      },
    };

    await (s.orchestrator as any).drainDispatch(
      s.runId,
      s.runDir,
      'B4',
      s.project,
      fakeLoop,
      s.queue
    );

    expect(fs.readFileSync(path.join(s.runDir, 'events.log'), 'utf8').trim().split('\n')).toEqual([
      'open',
      'dispatch',
    ]);
    expect(dispatchSawBaseline).toEqual([true]);
    expect(
      s.db.raw.prepare('SELECT COUNT(*) AS n FROM dispatches').get() as { n: number }
    ).toEqual({ n: 1 });
  });

  it('does not dispatch a fence member when OPEN refuses the baseline', async () => {
    process.env.HELM_SKIP_BATCH_DEPLOY = '1';
    process.env.NODE_ENV = 'test';
    process.env.USE_FAKE_TMUX = '1';
    const s = setup('already-green');
    cleanups.push(s.cleanup);

    let dispatched = false;
    const fakeLoop = {
      runTask: async () => {
        dispatched = true;
        return { finalStatus: 'PASS' as const };
      },
    };

    await (s.orchestrator as any).drainDispatch(
      s.runId,
      s.runDir,
      'B4',
      s.project,
      fakeLoop,
      s.queue
    );

    expect(dispatched).toBe(false);
    expect(
      s.db.raw.prepare('SELECT COUNT(*) AS n FROM dispatches').get() as { n: number }
    ).toEqual({ n: 0 });
    expect(
      s.db.raw.prepare('SELECT phase, status FROM runs WHERE id = ?').get(s.runId)
    ).toMatchObject({ phase: 'blocked', status: 'failed' });
  });
});
