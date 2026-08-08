/**
 * fence-workflow-upgrade C4 — CLOSE seat routing (R4.2, R4.4, R9.2).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import {
  closeFenceWithSeatRouting,
  type CloseFenceSeatRoutingParams,
} from './fence-close-mechanical.js';
import { hashTestFile } from './fence-open-service.js';
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
      .get(`fence-c4-${Date.now()}`, `/tmp/fence-c4-${Date.now()}`) as { id: number }
  ).id;
  const runId = (
    db.raw
      .prepare(
        "INSERT INTO runs (project_id, batch_id, north_star_ref, status, phase) VALUES (?, ?, ?, 'active', 'implementation') RETURNING id"
      )
      .get(projectId, 'C4', 'fence-close-seats') as { id: number }
  ).id;
  return { projectId, runId };
}

function writeJourneyFile(repoRoot: string): string {
  const rel = 'journeys/close-seats.test.ts';
  const abs = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `// C4 fixture\nexport const ids = ['R4.2', 'R4.4', 'R9.2'];\n`, 'utf8');
  return rel;
}

function insertDrainingFence(
  db: DatabaseService,
  runId: number,
  opts: {
    testPath: string;
    openFailedIds?: string[];
    openTestHash?: string;
  }
): number {
  const row = db.raw
    .prepare(
      `INSERT INTO fences (
         fence_key, run_id, lifecycle_state,
         integration_cmd, negative_control_cmd, acceptance_ids, test_path, authored_by,
         open_failed_ids, open_test_hash, open_at
       ) VALUES ('I3', ?, 'draining', 'run-close', 'run-negative-control', ?, ?, 'integration_test_agent', ?, ?, datetime('now'))
       RETURNING id`
    )
    .get(
      runId,
      JSON.stringify(['R4.2', 'R4.4', 'R9.2']),
      opts.testPath,
      JSON.stringify(opts.openFailedIds ?? ['R4.2']),
      opts.openTestHash
    ) as { id: number };
  return row.id;
}

function stateOf(db: DatabaseService, fenceId: number): string {
  return (
    db.raw.prepare('SELECT lifecycle_state FROM fences WHERE id = ?').get(fenceId) as {
      lifecycle_state: string;
    }
  ).lifecycle_state;
}

function compositionSessions(db: DatabaseService, fenceId: number): Array<{
  role: string;
  model: string;
  session_id: string;
  purpose: string;
}> {
  return db.raw
    .prepare(
      `SELECT role, model, session_id, purpose
       FROM fence_authoring_sessions
       WHERE fence_id = ?
       ORDER BY id`
    )
    .all(fenceId) as Array<{
    role: string;
    model: string;
    session_id: string;
    purpose: string;
  }>;
}

function artifactCount(db: DatabaseService, runId: number, type: string): number {
  return (
    db.raw
      .prepare('SELECT COUNT(*) AS c FROM artifacts WHERE run_id = ? AND type = ?')
      .get(runId, type) as { c: number }
  ).c;
}

function scriptedRunner(
  reportsByCmd: Record<string, FenceReportV1>,
  calls: string[]
): NonNullable<CloseFenceSeatRoutingParams['runCommand']> {
  return (opts) => {
    calls.push(opts.cmd);
    const report = reportsByCmd[opts.cmd];
    if (!report) throw new Error(`unexpected command: ${opts.cmd}`);
    const reportPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'helm-fence-c4-report-')),
      'fence-report-v1.json'
    );
    emitFenceReport(report, reportPath);
    return {
      report,
      reportPath,
      exitCode: report.failed.length > 0 ? 1 : 0,
      timedOut: false,
    } satisfies RunFenceReportCommandResult;
  };
}

describe('C4 closeFenceWithSeatRouting (R4.2, R4.4, R9.2)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('clean CLOSE advances closed without spending implementer, validator, or integration-test-agent seats', () => {
    const t = tempDir('helm-fence-c4-clean-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId } = insertProjectRun(db);
    const testPath = writeJourneyFile(t.dir);
    const fenceId = insertDrainingFence(db, runId, {
      testPath,
      openFailedIds: ['R4.2'],
      openTestHash: hashTestFile(path.join(t.dir, testPath)),
    });

    const calls: string[] = [];
    const result = closeFenceWithSeatRouting(db, {
      fenceId,
      cwd: t.dir,
      repoRoot: t.dir,
      runCommand: scriptedRunner(
        {
          'run-close': buildFenceReport({
            collected: ['R4.2', 'R4.4', 'R9.2'],
            passed: ['R4.2', 'R4.4', 'R9.2'],
          }),
          'run-negative-control': buildFenceReport({
            collected: ['R4.2', 'R4.4', 'R9.2'],
            passed: ['R4.2', 'R9.2'],
            failed: [{ id: 'R4.4', kind: 'assert' }],
          }),
        },
        calls
      ),
    });

    expect(result.status).toBe('closed');
    expect(result.clean).toBe(true);
    expect(result.seat_spend).toEqual({
      implementer: 0,
      validator: 0,
      integration_test_agent: 0,
    });
    expect(result.composition_judgment).toBeNull();
    expect(calls).toEqual(['run-close', 'run-negative-control']);
    expect(stateOf(db, fenceId)).toBe('closed');
    expect(compositionSessions(db, fenceId)).toEqual([]);
    expect(artifactCount(db, runId, 'fence-close-locked-test')).toBe(1);
    expect(artifactCount(db, runId, 'fence-close-negative-control')).toBe(1);
    db.close();
  });

  it('non-clean CLOSE routes composition judgment to integration_test_agent codex55, not validator', () => {
    const t = tempDir('helm-fence-c4-nonclean-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId } = insertProjectRun(db);
    const testPath = writeJourneyFile(t.dir);
    const fenceId = insertDrainingFence(db, runId, {
      testPath,
      openFailedIds: ['R4.2'],
      openTestHash: hashTestFile(path.join(t.dir, testPath)),
    });

    const calls: string[] = [];
    const result = closeFenceWithSeatRouting(db, {
      fenceId,
      cwd: t.dir,
      repoRoot: t.dir,
      compositionJudgmentSessionId: 'x-intagent-c4-close',
      implementerSessions: [
        { task_key: 'C1', session_id: 'x-impl-c1' },
        { task_key: 'C2', session_id: 'x-impl-c2' },
      ],
      candidateFailingUnits: ['C2'],
      runCommand: scriptedRunner(
        {
          'run-close': buildFenceReport({
            collected: ['R4.2', 'R4.4', 'R9.2'],
            passed: ['R9.2'],
            failed: [
              { id: 'R4.2', kind: 'assert' },
              { id: 'R4.4', kind: 'assert' },
            ],
          }),
          'run-negative-control': buildFenceReport({
            collected: ['R4.2', 'R4.4', 'R9.2'],
            failed: [{ id: 'R4.4', kind: 'assert' }],
          }),
        },
        calls
      ),
    });

    expect(result.status).toBe('composition_judgment_required');
    if (result.status !== 'composition_judgment_required') {
      throw new Error(`expected composition_judgment_required, got ${result.status}`);
    }
    expect(result.clean).toBe(false);
    expect(result.seat_spend).toEqual({
      implementer: 0,
      validator: 0,
      integration_test_agent: 1,
    });
    expect(result.non_clean_reason).toEqual({
      open_ids_still_failing: ['R4.2'],
      close_failed_ids: ['R4.2', 'R4.4'],
    });
    expect(result.composition_judgment.route).toEqual({
      role: 'integration_test_agent',
      model: 'codex55',
      purpose: 'composition_judgment',
      is_validator_ladder: false,
    });
    expect(result.composition_judgment.request).toMatchObject({
      schema: 'fence-composition-judgment-request-v1',
      fence_key: 'I3',
      run_id: runId,
      open_failed_ids: ['R4.2'],
      close_failed_ids: ['R4.2', 'R4.4'],
      close_passed_ids: ['R9.2'],
      report_path: expect.stringContaining('fence-report-v1.json'),
      candidate_failing_units: ['C2'],
    });
    expect(result.composition_judgment.request.seam_fingerprint).toMatch(/^fp1:[a-f0-9]{20}$/);
    expect(result.composition_judgment.session?.role).toBe('integration_test_agent');
    expect(result.composition_judgment.session?.model).toBe('codex55');
    expect(result.composition_judgment.session?.session_id).toBe('x-intagent-c4-close');
    expect(calls).toEqual(['run-close']);
    expect(stateOf(db, fenceId)).toBe('closing');
    expect(compositionSessions(db, fenceId)).toEqual([
      {
        role: 'integration_test_agent',
        model: 'codex55',
        session_id: 'x-intagent-c4-close',
        purpose: 'composition_judgment',
      },
    ]);
    expect(artifactCount(db, runId, 'fence-close-locked-test')).toBe(1);
    expect(artifactCount(db, runId, 'fence-close-negative-control')).toBe(0);
    db.close();
  });
});
