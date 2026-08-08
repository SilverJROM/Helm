/**
 * fence-workflow-upgrade A3 — transactional plan-fence membership ingest (R1.1, R1.4).
 *
 * Covers:
 *  - plan fences → fences + fence_members rows (lifecycle declared)
 *  - ceiling 5 enforced at ingest (defense-in-depth)
 *  - inspectable SQL membership unit↔fence
 *  - transactional: failure rolls back partial fence writes
 *  - ingestExecutionPlan end-to-end path carries fences into SQL
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import {
  FENCE_MEMBER_CEILING,
  type FencePlanContract,
} from './fence-plan-contract.js';
import {
  ingestFenceMembership,
  queryFenceMembership,
  queryFencesForRun,
} from './fence-membership-ingest.js';
import { PlanParserService } from './plan-parser-service.js';
import { RunArtifactService } from './run-artifact-service.js';
import { TaskQueueService } from './task-queue-service.js';

function tempDbPath(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dbPath: path.join(dir, 'helm.db'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function insertProjectRun(db: DatabaseService): { projectId: number; runId: number } {
  const projectId = (
    db.raw
      .prepare('INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id')
      .get(`fence-a3-${Date.now()}`, `/tmp/fence-a3-${Date.now()}`) as { id: number }
  ).id;
  const runId = (
    db.raw
      .prepare(
        "INSERT INTO runs (project_id, batch_id, north_star_ref, status, phase) VALUES (?, ?, ?, 'active', 'implementation') RETURNING id"
      )
      .get(projectId, 'A3', 'fence-membership') as { id: number }
  ).id;
  return { projectId, runId };
}

const FENCE_I1: FencePlanContract = {
  fence_key: 'I1',
  integration_cmd:
    'npx vitest run src/services/fence-f1-contract.integration.test.ts --minWorkers=1 --maxWorkers=4',
  negative_control_cmd:
    'FENCE_STUB=A3 npx vitest run src/services/fence-f1-contract.integration.test.ts --minWorkers=1 --maxWorkers=4',
  acceptance_ids: ['R1.1', 'R1.2', 'R1.3', 'R1.4'],
  test_path: 'src/services/fence-f1-contract.integration.test.ts',
  authored_by: 'integration_test_agent',
  members: ['A1', 'A2', 'A3', 'A4'],
  label: 'F1 plan-contract membership',
};

const FENCE_I2: FencePlanContract = {
  fence_key: 'I2',
  integration_cmd:
    'npx vitest run src/services/fence-f2-open-drain.integration.test.ts --minWorkers=1 --maxWorkers=4',
  negative_control_cmd:
    'FENCE_STUB=B2 npx vitest run src/services/fence-f2-open-drain.integration.test.ts --minWorkers=1 --maxWorkers=4',
  acceptance_ids: ['R2.1', 'R2.2'],
  test_path: 'src/services/fence-f2-open-drain.integration.test.ts',
  authored_by: 'integration_test_agent',
  members: ['B1', 'B2'],
};

function taskRow(id: string, batch: string, title: string, deps: string[] = []) {
  return {
    id,
    batch,
    title,
    req_refs: ['R1.1'],
    assignee: 'L2',
    validator_lane: 'L3',
    effort: 'med',
    type: 'feature',
    deps,
  };
}

describe('A3 fence membership ingest (R1.1, R1.4)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('writes fences + fence_members for plan fences (lifecycle declared)', () => {
    const t = tempDbPath('helm-fence-a3-write-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(t.dbPath);
    const { runId } = insertProjectRun(db);

    const result = ingestFenceMembership(db, {
      runId,
      fences: [FENCE_I1, FENCE_I2],
    });

    expect(result.fenceIdsByKey.I1).toBeTypeOf('number');
    expect(result.fenceIdsByKey.I2).toBeTypeOf('number');
    expect(result.memberCount).toBe(6);

    const fences = queryFencesForRun(db, runId);
    expect(fences.map((f) => f.fence_key)).toEqual(['I1', 'I2']);
    expect(fences[0]).toMatchObject({
      fence_key: 'I1',
      run_id: runId,
      lifecycle_state: 'declared',
      integration_cmd: FENCE_I1.integration_cmd,
      negative_control_cmd: FENCE_I1.negative_control_cmd,
      test_path: FENCE_I1.test_path,
      authored_by: FENCE_I1.authored_by,
      label: FENCE_I1.label,
    });
    expect(JSON.parse(fences[0].acceptance_ids)).toEqual(FENCE_I1.acceptance_ids);

    // Direct SQL membership unit↔fence (R1.4 inspectable, not code-only)
    const sqlMembers = db.raw
      .prepare(
        `SELECT f.fence_key, m.task_key, m.position
         FROM fence_members m
         JOIN fences f ON f.id = m.fence_id
         WHERE f.run_id = ?
         ORDER BY f.fence_key, m.position`
      )
      .all(runId) as Array<{ fence_key: string; task_key: string; position: number }>;
    expect(sqlMembers).toEqual([
      { fence_key: 'I1', task_key: 'A1', position: 0 },
      { fence_key: 'I1', task_key: 'A2', position: 1 },
      { fence_key: 'I1', task_key: 'A3', position: 2 },
      { fence_key: 'I1', task_key: 'A4', position: 3 },
      { fence_key: 'I2', task_key: 'B1', position: 0 },
      { fence_key: 'I2', task_key: 'B2', position: 1 },
    ]);

    const viaHelper = queryFenceMembership(db, runId);
    expect(viaHelper.map((r) => `${r.fence_key}:${r.task_key}`)).toEqual([
      'I1:A1',
      'I1:A2',
      'I1:A3',
      'I1:A4',
      'I2:B1',
      'I2:B2',
    ]);
    expect(viaHelper.every((r) => r.lifecycle_state === 'declared')).toBe(true);

    db.close();
  });

  it(`refuses more than ${FENCE_MEMBER_CEILING} members at ingest (ceiling)`, () => {
    const t = tempDbPath('helm-fence-a3-ceil-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(t.dbPath);
    const { runId } = insertProjectRun(db);

    const over: FencePlanContract = {
      ...FENCE_I1,
      members: ['A1', 'A2', 'A3', 'A4', 'B1', 'X6'],
    };
    expect(() => ingestFenceMembership(db, { runId, fences: [over] })).toThrow(/ceiling/i);

    // No partial rows
    expect(queryFencesForRun(db, runId)).toEqual([]);
    expect(queryFenceMembership(db, runId)).toEqual([]);
    expect(
      (db.raw.prepare('SELECT COUNT(*) AS c FROM fences WHERE run_id = ?').get(runId) as { c: number }).c
    ).toBe(0);
    expect(
      (db.raw.prepare('SELECT COUNT(*) AS c FROM fence_members').get() as { c: number }).c
    ).toBe(0);

    db.close();
  });

  it('transactional: failure mid-batch rolls back all fence rows for the call', () => {
    const t = tempDbPath('helm-fence-a3-tx-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(t.dbPath);
    const { runId } = insertProjectRun(db);

    // First fence valid; second reuses the same fence_key → UNIQUE(run_id, fence_key) fails mid-tx.
    const dupKey: FencePlanContract = { ...FENCE_I2, fence_key: 'I1' };
    expect(() =>
      ingestFenceMembership(db, { runId, fences: [FENCE_I1, dupKey] })
    ).toThrow(/unique|constraint/i);

    expect(queryFencesForRun(db, runId)).toEqual([]);
    expect(queryFenceMembership(db, runId)).toEqual([]);
    expect(
      (db.raw.prepare('SELECT COUNT(*) AS c FROM fences WHERE run_id = ?').get(runId) as { c: number }).c
    ).toBe(0);

    db.close();
  });

  it('empty fences array is a no-op (legacy plans without fences)', () => {
    const t = tempDbPath('helm-fence-a3-empty-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(t.dbPath);
    const { runId } = insertProjectRun(db);

    const result = ingestFenceMembership(db, { runId, fences: [] });
    expect(result.fenceIdsByKey).toEqual({});
    expect(result.memberCount).toBe(0);
    expect(queryFencesForRun(db, runId)).toEqual([]);

    db.close();
  });

  it('ingestExecutionPlan carries plan fences into inspectable SQL membership', async () => {
    const t = tempDbPath('helm-fence-a3-e2e-');
    cleanups.push(t.cleanup);
    // Prefer HELM_DB_PATH when the focused test harness sets it (slice row).
    const dbPath = process.env.HELM_DB_PATH || t.dbPath;
    if (process.env.HELM_DB_PATH) {
      // still clean the temp dir we allocated unused
    }
    const db = new DatabaseService(dbPath);
    const art = new RunArtifactService(db);
    const parser = new PlanParserService(art);
    const queue = new TaskQueueService(art);
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-fence-a3-run-'));
    cleanups.push(() => fs.rmSync(runDir, { recursive: true, force: true }));

    const projectId = (
      db.raw
        .prepare('INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id')
        .get('fence-a3-e2e', runDir) as { id: number }
    ).id;
    const runId = art.createRun(projectId, 'batch-A3', 'fence-membership-ingest');

    const md = `# Execution Plan

\`\`\`json
${JSON.stringify(
  {
    tasks: [
      taskRow('A1', 'A', 'schema'),
      taskRow('A2', 'A', 'contract', ['A1']),
      taskRow('A3', 'A', 'membership', ['A2']),
      taskRow('A4', 'A', 'route', ['A3']),
      taskRow('B1', 'B', 'adapter', ['A1']),
    ],
    fences: {
      I1: {
        integration_cmd: FENCE_I1.integration_cmd,
        negative_control_cmd: FENCE_I1.negative_control_cmd,
        acceptance_ids: FENCE_I1.acceptance_ids,
        test_path: FENCE_I1.test_path,
        authored_by: FENCE_I1.authored_by,
        members: ['A1', 'A2', 'A3', 'A4'],
        label: FENCE_I1.label,
      },
      I2: {
        integration_cmd: FENCE_I2.integration_cmd,
        negative_control_cmd: FENCE_I2.negative_control_cmd,
        acceptance_ids: FENCE_I2.acceptance_ids,
        test_path: FENCE_I2.test_path,
        authored_by: FENCE_I2.authored_by,
        members: ['B1'],
      },
    },
  },
  null,
  2
)}
\`\`\`
`;

    const { createdTaskIds } = await parser.ingestExecutionPlan(runId, md, queue, runDir);
    expect(createdTaskIds.length).toBe(5);

    const membership = queryFenceMembership(db, runId);
    expect(membership.map((r) => `${r.fence_key}:${r.task_key}`)).toEqual([
      'I1:A1',
      'I1:A2',
      'I1:A3',
      'I1:A4',
      'I2:B1',
    ]);

    // unit → fence reverse lookup (inspectable SQL, R1.4)
    const fencesForA3 = db.raw
      .prepare(
        `SELECT f.fence_key
         FROM fence_members m
         JOIN fences f ON f.id = m.fence_id
         WHERE f.run_id = ? AND m.task_key = ?
         ORDER BY f.fence_key`
      )
      .all(runId, 'A3') as Array<{ fence_key: string }>;
    expect(fencesForA3).toEqual([{ fence_key: 'I1' }]);

    // plan.json snapshot preserves fences
    const planJson = JSON.parse(fs.readFileSync(path.join(runDir, 'plan.json'), 'utf8'));
    expect(Array.isArray(planJson.fences)).toBe(true);
    expect(planJson.fences.map((f: FencePlanContract) => f.fence_key).sort()).toEqual(['I1', 'I2']);

    db.close();
  });

  it('ingestExecutionPlan with legacy bare task array writes zero fence rows', async () => {
    const t = tempDbPath('helm-fence-a3-legacy-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(t.dbPath);
    const art = new RunArtifactService(db);
    const parser = new PlanParserService(art);
    const queue = new TaskQueueService(art);
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-fence-a3-legacy-run-'));
    cleanups.push(() => fs.rmSync(runDir, { recursive: true, force: true }));

    const projectId = (
      db.raw
        .prepare('INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id')
        .get('fence-a3-legacy', runDir) as { id: number }
    ).id;
    const runId = art.createRun(projectId, 'batch-legacy', null);

    const md = `# plan

\`\`\`json
${JSON.stringify([taskRow('T1', 'T', 'solo')], null, 2)}
\`\`\`
`;
    await parser.ingestExecutionPlan(runId, md, queue, runDir);
    expect(queryFencesForRun(db, runId)).toEqual([]);
    expect(queryFenceMembership(db, runId)).toEqual([]);

    db.close();
  });
});
