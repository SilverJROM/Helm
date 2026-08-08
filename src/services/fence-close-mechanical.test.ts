/**
 * fence-workflow-upgrade C2 — CLOSE mechanical transitions + negative control (R4.1, R4.3).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import {
  closeFenceMechanical,
  FenceCloseMechanicalError,
  type CloseFenceMechanicalParams,
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
      .get(`fence-c2-${Date.now()}`, `/tmp/fence-c2-${Date.now()}`) as { id: number }
  ).id;
  const runId = (
    db.raw
      .prepare(
        "INSERT INTO runs (project_id, batch_id, north_star_ref, status, phase) VALUES (?, ?, ?, 'active', 'implementation') RETURNING id"
      )
      .get(projectId, 'C2', 'fence-close-mechanical') as { id: number }
  ).id;
  return { projectId, runId };
}

function writeJourneyFile(repoRoot: string): string {
  const rel = 'journeys/close-mechanical.test.ts';
  const abs = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `// C2 fixture\nexport const ids = ['R4.1', 'R4.2', 'R4.3'];\n`, 'utf8');
  return rel;
}

function insertDrainingFence(
  db: DatabaseService,
  runId: number,
  opts: {
    testPath: string;
    openFailedIds?: string[];
    openTestHash?: string;
    negativeControlCmd?: string;
    state?: string;
  }
): number {
  const row = db.raw
    .prepare(
      `INSERT INTO fences (
         fence_key, run_id, lifecycle_state,
         integration_cmd, negative_control_cmd, acceptance_ids, test_path, authored_by,
         open_failed_ids, open_test_hash, open_at
       ) VALUES ('I3', ?, ?, 'run-close', ?, ?, ?, 'integration_test_agent', ?, ?, datetime('now'))
       RETURNING id`
    )
    .get(
      runId,
      opts.state ?? 'draining',
      opts.negativeControlCmd ?? 'run-negative-control',
      JSON.stringify(['R4.1', 'R4.2', 'R4.3']),
      opts.testPath,
      JSON.stringify(opts.openFailedIds ?? ['R4.1', 'R4.2']),
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

function scriptedRunner(
  db: DatabaseService,
  fenceId: number,
  reportsByCmd: Record<string, FenceReportV1>,
  statesAtCommand: string[]
): NonNullable<CloseFenceMechanicalParams['runCommand']> {
  return (opts) => {
    statesAtCommand.push(`${opts.cmd}:${stateOf(db, fenceId)}`);
    const report = reportsByCmd[opts.cmd];
    if (!report) throw new Error(`unexpected command: ${opts.cmd}`);
    const reportPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'helm-fence-c2-report-')),
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

describe('C2 closeFenceMechanical (R4.1, R4.3)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('moves draining→closing→closed after every OPEN-failed id passes and NC fails a different assertion', () => {
    const t = tempDir('helm-fence-c2-happy-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId } = insertProjectRun(db);
    const testPath = writeJourneyFile(t.dir);
    const fenceId = insertDrainingFence(db, runId, {
      testPath,
      openFailedIds: ['R4.1', 'R4.2'],
      openTestHash: hashTestFile(path.join(t.dir, testPath)),
    });

    const statesAtCommand: string[] = [];
    const result = closeFenceMechanical(db, {
      fenceId,
      cwd: t.dir,
      repoRoot: t.dir,
      runCommand: scriptedRunner(
        db,
        fenceId,
        {
          'run-close': buildFenceReport({
            collected: ['R4.1', 'R4.2', 'R4.3'],
            passed: ['R4.1', 'R4.2', 'R4.3'],
          }),
          'run-negative-control': buildFenceReport({
            collected: ['R4.1', 'R4.2', 'R4.3'],
            passed: ['R4.1', 'R4.2'],
            failed: [{ id: 'R4.3', kind: 'assert' }],
          }),
        },
        statesAtCommand
      ),
    });

    expect(result.ok).toBe(true);
    expect(result.close.open_failed_ids).toEqual(['R4.1', 'R4.2']);
    expect(result.close.close_passed_ids).toEqual(['R4.1', 'R4.2', 'R4.3']);
    expect(result.negative_control.different_failed_ids).toEqual(['R4.3']);
    expect(statesAtCommand).toEqual(['run-close:closing', 'run-negative-control:closing']);
    expect(stateOf(db, fenceId)).toBe('closed');
    expect(
      (
        db.raw
          .prepare(
            "SELECT COUNT(*) AS c FROM artifacts WHERE run_id = ? AND type IN ('fence-close-locked-test', 'fence-close-negative-control')"
          )
          .get(runId) as { c: number }
      ).c
    ).toBe(2);
    db.close();
  });

  it('refuses CLOSE when an OPEN-failed id is still failing at CLOSE', () => {
    const t = tempDir('helm-fence-c2-open-still-red-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId } = insertProjectRun(db);
    const testPath = writeJourneyFile(t.dir);
    const fenceId = insertDrainingFence(db, runId, {
      testPath,
      openFailedIds: ['R4.1', 'R4.2'],
      openTestHash: hashTestFile(path.join(t.dir, testPath)),
    });

    const statesAtCommand: string[] = [];
    expect(() =>
      closeFenceMechanical(db, {
        fenceId,
        cwd: t.dir,
        repoRoot: t.dir,
        runCommand: scriptedRunner(
          db,
          fenceId,
          {
            'run-close': buildFenceReport({
              collected: ['R4.1', 'R4.2', 'R4.3'],
              passed: ['R4.1', 'R4.3'],
              failed: [{ id: 'R4.2', kind: 'assert' }],
            }),
            'run-negative-control': buildFenceReport({
              collected: ['R4.1', 'R4.2', 'R4.3'],
              failed: [{ id: 'R4.3', kind: 'assert' }],
            }),
          },
          statesAtCommand
        ),
      })
    ).toThrowError(FenceCloseMechanicalError);

    expect(statesAtCommand).toEqual(['run-close:closing']);
    expect(stateOf(db, fenceId)).toBe('closing');
    db.close();
  });

  it('refuses CLOSE when negative_control_cmd stays green', () => {
    const t = tempDir('helm-fence-c2-nc-green-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId } = insertProjectRun(db);
    const testPath = writeJourneyFile(t.dir);
    const fenceId = insertDrainingFence(db, runId, {
      testPath,
      openFailedIds: ['R4.1', 'R4.2'],
      openTestHash: hashTestFile(path.join(t.dir, testPath)),
    });

    expect(() =>
      closeFenceMechanical(db, {
        fenceId,
        cwd: t.dir,
        repoRoot: t.dir,
        runCommand: scriptedRunner(
          db,
          fenceId,
          {
            'run-close': buildFenceReport({
              collected: ['R4.1', 'R4.2', 'R4.3'],
              passed: ['R4.1', 'R4.2', 'R4.3'],
            }),
            'run-negative-control': buildFenceReport({
              collected: ['R4.1', 'R4.2', 'R4.3'],
              passed: ['R4.1', 'R4.2', 'R4.3'],
            }),
          },
          []
        ),
      })
    ).toThrow(/negative_control_cmd did not produce/);

    expect(stateOf(db, fenceId)).toBe('closing');
    db.close();
  });

  it('refuses CLOSE when negative_control_cmd only fails an OPEN assertion id', () => {
    const t = tempDir('helm-fence-c2-nc-same-id-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId } = insertProjectRun(db);
    const testPath = writeJourneyFile(t.dir);
    const fenceId = insertDrainingFence(db, runId, {
      testPath,
      openFailedIds: ['R4.1', 'R4.2'],
      openTestHash: hashTestFile(path.join(t.dir, testPath)),
    });

    expect(() =>
      closeFenceMechanical(db, {
        fenceId,
        cwd: t.dir,
        repoRoot: t.dir,
        runCommand: scriptedRunner(
          db,
          fenceId,
          {
            'run-close': buildFenceReport({
              collected: ['R4.1', 'R4.2', 'R4.3'],
              passed: ['R4.1', 'R4.2', 'R4.3'],
            }),
            'run-negative-control': buildFenceReport({
              collected: ['R4.1', 'R4.2', 'R4.3'],
              passed: ['R4.2', 'R4.3'],
              failed: [{ id: 'R4.1', kind: 'assert' }],
            }),
          },
          []
        ),
      })
    ).toThrow(/failed only OPEN assertion/);

    expect(stateOf(db, fenceId)).toBe('closing');
    db.close();
  });
});
