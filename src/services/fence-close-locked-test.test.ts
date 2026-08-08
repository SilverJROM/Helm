/**
 * fence-workflow-upgrade C1 — CLOSE locked-test assertion superset (R4.1).
 *
 * Covers D11 retry scope: fixed test_path/command identity, unchanged hash,
 * changed-hash superset, and drop/rename refusal.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { closeFenceLockedTest, FenceCloseLockedTestError } from './fence-close-locked-test.js';
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
      .get(`fence-c1-${Date.now()}`, `/tmp/fence-c1-${Date.now()}`) as { id: number }
  ).id;
  const runId = (
    db.raw
      .prepare(
        "INSERT INTO runs (project_id, batch_id, north_star_ref, status, phase) VALUES (?, ?, ?, 'active', 'implementation') RETURNING id"
      )
      .get(projectId, 'C1', 'fence-close-locked-test') as { id: number }
  ).id;
  return { projectId, runId };
}

function writeJourneyFile(repoRoot: string, body: string): string {
  const rel = 'journeys/close-journey.test.ts';
  const abs = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
  return rel;
}

function insertDrainingFence(
  db: DatabaseService,
  runId: number,
  opts: {
    testPath: string;
    integrationCmd?: string;
    openFailedIds?: string[];
    openTestHash?: string;
    state?: string;
  }
): number {
  const row = db.raw
    .prepare(
      `INSERT INTO fences (
         fence_key, run_id, lifecycle_state,
         integration_cmd, negative_control_cmd, acceptance_ids, test_path, authored_by,
         open_failed_ids, open_test_hash, open_at
       ) VALUES ('I3', ?, ?, ?, 'FENCE_STUB=C2 true', ?, ?, 'integration_test_agent', ?, ?, datetime('now'))
       RETURNING id`
    )
    .get(
      runId,
      opts.state ?? 'draining',
      opts.integrationCmd ?? 'npx vitest run journeys/close-journey.test.ts --minWorkers=1 --maxWorkers=4',
      JSON.stringify(['R4.1', 'R4.2', 'R4.3']),
      opts.testPath,
      JSON.stringify(opts.openFailedIds ?? ['R4.1', 'R4.2']),
      opts.openTestHash
    ) as { id: number };
  return row.id;
}

function injectReport(report: FenceReportV1): NonNullable<
  Parameters<typeof closeFenceLockedTest>[1]['runCommand']
> {
  return () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-fence-c1-rep-'));
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

describe('C1 closeFenceLockedTest (R4.1)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('accepts unchanged locked test hash and records a run artifact row', () => {
    const t = tempDir('helm-fence-c1-same-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId } = insertProjectRun(db);
    const testPath = writeJourneyFile(t.dir, `// C1 fixture\nexport const ids = ['R4.1', 'R4.2'];\n`);
    const openHash = hashTestFile(path.join(t.dir, testPath));
    const integrationCmd = 'npx vitest run journeys/close-journey.test.ts --minWorkers=1 --maxWorkers=4';
    const fenceId = insertDrainingFence(db, runId, {
      testPath,
      openTestHash: openHash,
      integrationCmd,
    });

    const report = buildFenceReport({
      collected: ['R4.1', 'R4.2'],
      passed: ['R4.1', 'R4.2'],
    });
    const result = closeFenceLockedTest(db, {
      fenceId,
      cwd: t.dir,
      repoRoot: t.dir,
      expectedIntegrationCmd: integrationCmd,
      runCommand: injectReport(report),
    });

    expect(result.unchanged_hash).toBe(true);
    expect(result.open_failed_ids).toEqual(['R4.1', 'R4.2']);
    expect(result.close_collected_ids).toEqual(['R4.1', 'R4.2']);

    const artifact = db.raw
      .prepare('SELECT run_id, type, path, sha FROM artifacts WHERE id = ?')
      .get(result.artifactId) as { run_id: number; type: string; path: string; sha: string };
    expect(artifact.run_id).toBe(runId);
    expect(artifact.type).toBe('fence-close-locked-test');
    expect(artifact.path).toContain('fence-report-v1.json');
    expect(artifact.sha).toBe(openHash);
    db.close();
  });

  it('accepts changed hash only when CLOSE collected ids retain every OPEN id and allows added asserts', () => {
    const t = tempDir('helm-fence-c1-superset-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId } = insertProjectRun(db);
    const testPath = writeJourneyFile(t.dir, `// original C1 fixture\n`);
    const openHash = hashTestFile(path.join(t.dir, testPath));
    const fenceId = insertDrainingFence(db, runId, {
      testPath,
      openTestHash: openHash,
      openFailedIds: ['R4.1', 'R4.2'],
    });
    fs.appendFileSync(path.join(t.dir, testPath), `export const added = 'R4.3';\n`, 'utf8');

    const report = buildFenceReport({
      collected: ['R4.1', 'R4.2', 'R4.3'],
      passed: ['R4.1', 'R4.2', 'R4.3'],
    });
    const result = closeFenceLockedTest(db, {
      fenceId,
      cwd: t.dir,
      repoRoot: t.dir,
      runCommand: injectReport(report),
    });

    expect(result.unchanged_hash).toBe(false);
    expect(result.close_collected_ids).toEqual(['R4.1', 'R4.2', 'R4.3']);
    expect(result.close_test_hash).not.toBe(openHash);
    expect(
      (db.raw
        .prepare("SELECT COUNT(*) AS c FROM artifacts WHERE run_id = ? AND type = 'fence-close-locked-test'")
        .get(runId) as { c: number }).c
    ).toBe(1);
    db.close();
  });

  it('refuses changed hash when an OPEN assertion id was dropped or renamed', () => {
    const t = tempDir('helm-fence-c1-drop-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId } = insertProjectRun(db);
    const testPath = writeJourneyFile(t.dir, `// original C1 fixture\n`);
    const openHash = hashTestFile(path.join(t.dir, testPath));
    const fenceId = insertDrainingFence(db, runId, {
      testPath,
      openTestHash: openHash,
      openFailedIds: ['R4.1', 'R4.2'],
    });
    fs.appendFileSync(path.join(t.dir, testPath), `export const renamed = 'R4.2b';\n`, 'utf8');

    expect(() =>
      closeFenceLockedTest(db, {
        fenceId,
        cwd: t.dir,
        repoRoot: t.dir,
        runCommand: injectReport(
          buildFenceReport({
            collected: ['R4.1', 'R4.2b', 'R4.3'],
            passed: ['R4.1', 'R4.2b', 'R4.3'],
          })
        ),
      })
    ).toThrowError(FenceCloseLockedTestError);
    expect(
      (db.raw
        .prepare("SELECT COUNT(*) AS c FROM artifacts WHERE run_id = ? AND type = 'fence-close-locked-test'")
        .get(runId) as { c: number }).c
    ).toBe(0);
    db.close();
  });

  it('refuses CLOSE when the stored command no longer matches the plan/Open identity snapshot', () => {
    const t = tempDir('helm-fence-c1-cmd-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId } = insertProjectRun(db);
    const testPath = writeJourneyFile(t.dir, `// C1 command fixture\n`);
    const expected = 'npx vitest run journeys/close-journey.test.ts --minWorkers=1 --maxWorkers=4';
    const fenceId = insertDrainingFence(db, runId, {
      testPath,
      openTestHash: hashTestFile(path.join(t.dir, testPath)),
      integrationCmd: 'npx vitest run journeys/renamed.test.ts --minWorkers=1 --maxWorkers=4',
    });

    expect(() =>
      closeFenceLockedTest(db, {
        fenceId,
        cwd: t.dir,
        repoRoot: t.dir,
        expectedIntegrationCmd: expected,
        runCommand: injectReport(buildFenceReport({ collected: ['R4.1', 'R4.2'] })),
      })
    ).toThrow(/integration_cmd changed/);
    db.close();
  });
});
