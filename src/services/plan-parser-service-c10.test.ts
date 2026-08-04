process.env.USE_FAKE_TMUX = '1';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PlanParserService, Plan } from './plan-parser-service.js';
import { RunArtifactService } from './run-artifact-service.js';
import { TaskQueueService } from './task-queue-service.js';
import { DatabaseService } from '../db/database.js';

// C10: transactional ingest. Prior to this slice, `ingestPlan` inserted `run_tasks` rows one at a
// time, then wrote the `artifacts` row, then enqueued — a failure partway through left durable
// orphan rows with no queue entry. This file proves: (1) normalize/validate happens fully before any
// DB write, (2) task rows + the artifact row + the queue admission land as one all-or-none unit —
// including the case where `queue.enqueue` itself is the thing that throws mid-loop, and (3) the
// success path is unaffected. It also covers the duplicate-artifact-row bug fixed alongside this
// (ingestExecutionPlan no longer writes the plan artifact twice).
describe('plan-parser-service (C10: transactional ingest)', () => {
  let tmpDb: string;
  let dbs: DatabaseService;
  let art: RunArtifactService;
  let parser: PlanParserService;
  let queue: TaskQueueService;
  let runDir: string;

  beforeEach(async () => {
    tmpDb = path.join(os.tmpdir(), `helm-c10-parser-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    dbs = new DatabaseService(tmpDb);
    art = new RunArtifactService(dbs);
    parser = new PlanParserService(art);
    queue = new TaskQueueService(art);
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-c10-plan-'));
  });

  afterEach(async () => {
    if (dbs) dbs.close();
    if (tmpDb) await fs.rm(tmpDb, { force: true }).catch(() => {});
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  const threeTaskPlan = (prefix: string): Plan => ({
    tasks: [
      { task_key: `${prefix}-1`, atomic_work: 'first task', complexity: 'low', task_type: 'feature', validation_criteria: 'ok', deps: [] },
      { task_key: `${prefix}-2`, atomic_work: 'second task', complexity: 'low', task_type: 'feature', validation_criteria: 'ok', deps: [`${prefix}-1`] },
      { task_key: `${prefix}-3`, atomic_work: 'third task', complexity: 'low', task_type: 'feature', validation_criteria: 'ok', deps: [`${prefix}-2`] },
    ],
  });

  it('success path: normal ingest persists tasks/deps/artifact metadata and enqueues in dep order', async () => {
    const plan = threeTaskPlan('SUC');
    const rid = art.createRun(null, 'batch-C10-success');

    const { createdTaskIds, keyToId } = await parser.ingestPlan(rid, plan, queue, runDir);
    expect(createdTaskIds.length).toBe(3);

    const tasks = dbs.raw.prepare('SELECT * FROM run_tasks WHERE run_id = ? ORDER BY id').all(rid) as any[];
    expect(tasks.length).toBe(3);
    expect(tasks.map((t) => t.task_key)).toEqual(['SUC-1', 'SUC-2', 'SUC-3']);

    const artifacts = dbs.raw.prepare(`SELECT * FROM artifacts WHERE run_id = ?`).all(rid) as any[];
    expect(artifacts.length).toBe(1);
    expect(artifacts[0].type).toBe('plan');
    expect(artifacts[0].path).toBe('plan.json');

    const raw = await fs.readFile(path.join(runDir, 'plan.json'), 'utf8');
    const loaded = JSON.parse(raw) as Plan;
    expect(loaded.tasks.length).toBe(3);

    // deps respected: SUC-1 first, then SUC-2, then SUC-3
    const first = queue.claimNextReady(rid)!;
    expect(first.taskId).toBe(keyToId['SUC-1']);
    queue.markComplete(first);
    const second = queue.claimNextReady(rid)!;
    expect(second.taskId).toBe(keyToId['SUC-2']);
    queue.markComplete(second);
    const third = queue.claimNextReady(rid)!;
    expect(third.taskId).toBe(keyToId['SUC-3']);
    queue.markComplete(third);
    expect(queue.claimNextReady(rid)).toBeNull();
  });

  it('rollback: an injected mid-ingest DB failure (recordTask throws on task 3) leaves zero run_tasks/artifacts rows and zero queue entries', async () => {
    const plan = threeTaskPlan('DBF');
    const rid = art.createRun(null, 'batch-C10-db-fail');

    const originalRecordTask = art.recordTask.bind(art);
    let calls = 0;
    vi.spyOn(art, 'recordTask').mockImplementation((...args: Parameters<typeof art.recordTask>) => {
      calls++;
      if (calls === 3) throw new Error('injected mid-ingest DB failure');
      return originalRecordTask(...args);
    });

    await expect(parser.ingestPlan(rid, plan, queue, runDir)).rejects.toThrow(/injected mid-ingest DB failure/);
    vi.restoreAllMocks();

    // DB side: nothing committed (the first two recordTask calls inside the same transaction as the
    // third were rolled back with it).
    const tasks = dbs.raw.prepare('SELECT * FROM run_tasks WHERE run_id = ?').all(rid) as any[];
    expect(tasks.length).toBe(0);
    const artifacts = dbs.raw.prepare(`SELECT * FROM artifacts WHERE run_id = ?`).all(rid) as any[];
    expect(artifacts.length).toBe(0);

    // queue side: recordTask threw before the enqueue loop ever ran, so there is nothing to compensate —
    // the run has zero queue entries.
    expect(queue.claimNextReady(rid)).toBeNull();
  });

  it('rollback: an injected mid-ingest QUEUE failure (enqueue throws on task 3) still leaves zero run_tasks/artifacts rows and zero queue entries (compensated via clearRun)', async () => {
    const plan = threeTaskPlan('QF');
    const rid = art.createRun(null, 'batch-C10-queue-fail');

    const originalEnqueue = queue.enqueue.bind(queue);
    let calls = 0;
    vi.spyOn(queue, 'enqueue').mockImplementation((...args: Parameters<typeof queue.enqueue>) => {
      calls++;
      if (calls === 3) throw new Error('injected mid-ingest queue failure');
      return originalEnqueue(...args);
    });

    await expect(parser.ingestPlan(rid, plan, queue, runDir)).rejects.toThrow(/injected mid-ingest queue failure/);
    vi.restoreAllMocks();

    // DB side: better-sqlite3 rolled back the transaction because the callback (which includes the
    // enqueue loop) threw — task rows created before the throw do NOT survive.
    const tasks = dbs.raw.prepare('SELECT * FROM run_tasks WHERE run_id = ?').all(rid) as any[];
    expect(tasks.length).toBe(0);
    const artifacts = dbs.raw.prepare(`SELECT * FROM artifacts WHERE run_id = ?`).all(rid) as any[];
    expect(artifacts.length).toBe(0);

    // queue side: the first two enqueue() calls DID mutate in-memory queue state before the throw;
    // the catch's queue.clearRun(runId) compensation must have wiped it back to nothing.
    expect(queue.claimNextReady(rid)).toBeNull();
  });

  it('ingestExecutionPlan no longer double-records the plan artifact (duplicate-write bug fixed alongside C10)', async () => {
    const md = `# plan.md\n\`\`\`json\n[{"id":"E1","batch":"B1","title":"exec task","req_refs":["R-1"],"assignee":"L1","validator_lane":"L1","effort":"low","type":"feature","deps":[]}]\n\`\`\`\n`;
    const rid = art.createRun(null, 'batch-C10-exec-dup');

    await parser.ingestExecutionPlan(rid, md, queue, runDir);

    const artifacts = dbs.raw.prepare(`SELECT * FROM artifacts WHERE run_id = ? AND type = 'plan'`).all(rid) as any[];
    expect(artifacts.length).toBe(1);
  });
});
