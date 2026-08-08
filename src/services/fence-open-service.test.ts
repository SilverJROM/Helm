/**
 * fence-workflow-upgrade B2 — OPEN FSM service (R2.1, R2.2).
 *
 * R2.1 proving failure required; env/import/not_found-only refused.
 * R2.2 failed ids + test hash recorded and inspectable after OPEN.
 * FSM: declared → opening (external cmd) → draining; baseline+state commit together.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../db/database.js';
import {
  FenceOpenError,
  getOpenBaseline,
  hashTestFile,
  openFence,
  parseOpenFailedIds,
} from './fence-open-service.js';
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
      .get(`fence-b2-${Date.now()}`, `/tmp/fence-b2-${Date.now()}`) as { id: number }
  ).id;
  const runId = (
    db.raw
      .prepare(
        "INSERT INTO runs (project_id, batch_id, north_star_ref, status, phase) VALUES (?, ?, ?, 'active', 'implementation') RETURNING id"
      )
      .get(projectId, 'B2', 'fence-open') as { id: number }
  ).id;
  return { projectId, runId };
}

function writeJourneyFile(repoRoot: string, rel = 'journeys/open-journey.ts'): string {
  const abs = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `// fence open journey fixture\nexport const mark = 'b2';\n`, 'utf8');
  return rel;
}

function insertDeclaredFence(
  db: DatabaseService,
  runId: number,
  opts: {
    fenceKey?: string;
    testPath: string;
    integrationCmd?: string;
    negativeControlCmd?: string | null;
  }
): number {
  const row = db.raw
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
      opts.integrationCmd ?? 'echo should-not-run',
      opts.negativeControlCmd === null
        ? ''
        : (opts.negativeControlCmd ?? 'FENCE_STUB=B2 true'),
      JSON.stringify(['R2.1', 'R2.2']),
      opts.testPath,
      'integration_test_agent'
    ) as { id: number };
  return row.id;
}

function injectReport(report: FenceReportV1): NonNullable<
  Parameters<typeof openFence>[1]['runCommand']
> {
  return () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-fence-b2-rep-'));
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

describe('B2 OPEN FSM service (R2.1, R2.2)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  // --- R2.1: proving failure required; infra-only refused -----------------------------------

  it('R2.1 declared→opening→draining on named assert proving failure', () => {
    const t = tempDir('helm-fence-b2-happy-');
    cleanups.push(t.cleanup);
    const dbPath = path.join(t.dir, 'helm.db');
    const db = new DatabaseService(dbPath);
    const { runId } = insertProjectRun(db);
    const testPath = writeJourneyFile(t.dir);
    const fenceId = insertDeclaredFence(db, runId, { testPath });

    const report = buildFenceReport({
      collected: ['R2.1', 'R2.2'],
      failed: [
        { id: 'R2.1', kind: 'assert' },
        { id: 'R2.2', kind: 'assert' },
      ],
    });
    const baseRun = injectReport(report);

    // Observe intermediate state: inject should see opening when command runs.
    let stateAtCmd: string | null = null;
    const result = openFence(db, {
      fenceId,
      cwd: t.dir,
      repoRoot: t.dir,
      runCommand: (opts) => {
        stateAtCmd = (
          db.raw.prepare('SELECT lifecycle_state FROM fences WHERE id = ?').get(fenceId) as {
            lifecycle_state: string;
          }
        ).lifecycle_state;
        return baseRun(opts);
      },
    });

    expect(stateAtCmd).toBe('opening');
    expect(result.ok).toBe(true);
    expect(result.lifecycle_state).toBe('draining');
    expect(result.open_failed_ids).toEqual(['R2.1', 'R2.2']);
    expect(result.open_test_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.open_test_hash).toBe(hashTestFile(path.join(t.dir, testPath)));
    expect(result.proving_reason).toMatch(/named assertion/);

    const row = db.raw
      .prepare(
        'SELECT lifecycle_state, open_failed_ids, open_test_hash, open_at FROM fences WHERE id = ?'
      )
      .get(fenceId) as {
      lifecycle_state: string;
      open_failed_ids: string;
      open_test_hash: string;
      open_at: string;
    };
    expect(row.lifecycle_state).toBe('draining');
    expect(parseOpenFailedIds(row.open_failed_ids)).toEqual(['R2.1', 'R2.2']);
    expect(row.open_test_hash).toBe(result.open_test_hash);
    expect(row.open_at).toBeTruthy();
    db.close();
  });

  it('R2.1 fail kind also proves absence (not only assert)', () => {
    const t = tempDir('helm-fence-b2-failkind-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId } = insertProjectRun(db);
    const testPath = writeJourneyFile(t.dir);
    const fenceId = insertDeclaredFence(db, runId, { testPath });
    const result = openFence(db, {
      fenceId,
      cwd: t.dir,
      repoRoot: t.dir,
      runCommand: injectReport(
        buildFenceReport({
          collected: ['R2.1'],
          failed: [{ id: 'R2.1', kind: 'fail' }],
        })
      ),
    });
    expect(result.ok).toBe(true);
    expect(result.open_failed_ids).toEqual(['R2.1']);
    db.close();
  });

  it.each([
    ['env'],
    ['import'],
    ['not_found'],
    ['syntax'],
    ['collect_error'],
    ['timeout'],
    ['error'],
  ] as const)('R2.1 refuses infrastructure-only red (kind=%s) and reverts to declared', (kind) => {
    const t = tempDir(`helm-fence-b2-infra-${kind}-`);
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId } = insertProjectRun(db);
    const testPath = writeJourneyFile(t.dir);
    const fenceId = insertDeclaredFence(db, runId, { testPath });
    try {
      openFence(db, {
        fenceId,
        cwd: t.dir,
        repoRoot: t.dir,
        runCommand: injectReport(
          buildFenceReport({
            collected: ['R2.1'],
            failed: [{ id: 'R2.1', kind }],
          })
        ),
      });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(FenceOpenError);
      expect((e as FenceOpenError).code).toBe('proving_refused');
      expect((e as FenceOpenError).message).toMatch(/OPEN refused/);
      expect((e as FenceOpenError).message).toMatch(/infrastructure|collected is empty|nothing failed/i);
    }

    const row = db.raw
      .prepare(
        'SELECT lifecycle_state, open_failed_ids, open_test_hash, open_at FROM fences WHERE id = ?'
      )
      .get(fenceId) as {
      lifecycle_state: string;
      open_failed_ids: string | null;
      open_test_hash: string | null;
      open_at: string | null;
    };
    // Refuse must not leave a partial baseline or stick in opening.
    expect(row.lifecycle_state).toBe('declared');
    expect(row.open_failed_ids).toBeNull();
    expect(row.open_test_hash).toBeNull();
    expect(row.open_at).toBeNull();
    db.close();
  });

  it('R2.1 refuses already-green journey (nothing failed)', () => {
    const t = tempDir('helm-fence-b2-green-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId } = insertProjectRun(db);
    const testPath = writeJourneyFile(t.dir);
    const fenceId = insertDeclaredFence(db, runId, { testPath });
    expect(() =>
      openFence(db, {
        fenceId,
        cwd: t.dir,
        repoRoot: t.dir,
        runCommand: injectReport(
          buildFenceReport({
            collected: ['R2.1', 'R2.2'],
            passed: ['R2.1', 'R2.2'],
            failed: [],
          })
        ),
      })
    ).toThrow(/nothing failed/);

    const state = (
      db.raw.prepare('SELECT lifecycle_state FROM fences WHERE id = ?').get(fenceId) as {
        lifecycle_state: string;
      }
    ).lifecycle_state;
    expect(state).toBe('declared');
    db.close();
  });

  it('R2.1 refuses missing report (runner error) and reverts opening→declared', () => {
    const t = tempDir('helm-fence-b2-norep-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId } = insertProjectRun(db);
    const testPath = writeJourneyFile(t.dir);
    const fenceId = insertDeclaredFence(db, runId, { testPath });

    expect(() =>
      openFence(db, {
        fenceId,
        cwd: t.dir,
        repoRoot: t.dir,
        runCommand: () => {
          throw new Error('no fence-report-v1.json produced');
        },
      })
    ).toThrow(/OPEN could not read a report/);

    const row = db.raw
      .prepare('SELECT lifecycle_state, open_failed_ids FROM fences WHERE id = ?')
      .get(fenceId) as { lifecycle_state: string; open_failed_ids: string | null };
    expect(row.lifecycle_state).toBe('declared');
    expect(row.open_failed_ids).toBeNull();
    db.close();
  });

  // --- R2.2: baseline inspectable ------------------------------------------------------------

  it('R2.2 open_failed_ids + open_test_hash are inspectable via getOpenBaseline / SQL', () => {
    const t = tempDir('helm-fence-b2-inspect-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId } = insertProjectRun(db);
    const testPath = writeJourneyFile(t.dir, 'src/services/fence-f2-open-drain.integration.test.ts');
    const fenceId = insertDeclaredFence(db, runId, { testPath, fenceKey: 'I2' });
    const expectedHash = hashTestFile(path.join(t.dir, testPath));

    openFence(db, {
      runId,
      fenceKey: 'I2',
      cwd: t.dir,
      repoRoot: t.dir,
      runCommand: injectReport(
        buildFenceReport({
          collected: ['R2.1', 'R2.2', 'R2.3'],
          failed: [
            { id: 'R2.1', kind: 'assert' },
            { id: 'R2.2', kind: 'assert' },
            { id: 'R2.3', kind: 'assert' },
          ],
        })
      ),
    });

    const baseline = getOpenBaseline(db, { runId, fenceKey: 'I2' });
    expect(baseline).not.toBeNull();
    expect(baseline!.has_baseline).toBe(true);
    expect(baseline!.lifecycle_state).toBe('draining');
    expect(baseline!.open_failed_ids).toEqual(['R2.1', 'R2.2', 'R2.3']);
    expect(baseline!.open_test_hash).toBe(expectedHash);
    expect(baseline!.open_at).toBeTruthy();

    // Direct SQL inspectability (Helm-native fence-open.<F>.marker equivalent).
    const sql = db.raw
      .prepare(
        `SELECT open_failed_ids, open_test_hash, open_at, lifecycle_state
         FROM fences WHERE run_id = ? AND fence_key = ?`
      )
      .get(runId, 'I2') as {
      open_failed_ids: string;
      open_test_hash: string;
      open_at: string;
      lifecycle_state: string;
    };
    expect(sql.lifecycle_state).toBe('draining');
    expect(JSON.parse(sql.open_failed_ids)).toEqual(['R2.1', 'R2.2', 'R2.3']);
    expect(sql.open_test_hash).toBe(expectedHash);
    expect(sql.open_at).toBeTruthy();
    // Hash format matches tiller file_hash / fence-open marker.
    expect(sql.open_test_hash).toBe(
      `sha256:${createHash('sha256').update(fs.readFileSync(path.join(t.dir, testPath))).digest('hex')}`
    );
    expect(fenceId).toBe(baseline!.fence_id);
    db.close();
  });

  // --- FSM + atomicity + edges ---------------------------------------------------------------

  it('baseline columns and draining state commit together (no partial OPEN)', () => {
    const t = tempDir('helm-fence-b2-atomic-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId } = insertProjectRun(db);
    const testPath = writeJourneyFile(t.dir);
    const fenceId = insertDeclaredFence(db, runId, { testPath });

    openFence(db, {
      fenceId,
      cwd: t.dir,
      repoRoot: t.dir,
      runCommand: injectReport(
        buildFenceReport({
          collected: ['R2.1'],
          failed: [{ id: 'R2.1', kind: 'assert' }],
        })
      ),
    });

    const row = db.raw
      .prepare(
        `SELECT lifecycle_state, open_failed_ids, open_test_hash, open_at
         FROM fences WHERE id = ?`
      )
      .get(fenceId) as {
      lifecycle_state: string;
      open_failed_ids: string | null;
      open_test_hash: string | null;
      open_at: string | null;
    };
    // All four must be present together — never draining without baseline, never baseline without draining.
    expect(row.lifecycle_state).toBe('draining');
    expect(row.open_failed_ids).toBeTruthy();
    expect(row.open_test_hash).toBeTruthy();
    expect(row.open_at).toBeTruthy();
    db.close();
  });

  it('refuses closed/plan_blocked/closing states', () => {
    const t = tempDir('helm-fence-b2-badstate-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId } = insertProjectRun(db);
    const testPath = writeJourneyFile(t.dir);
    const fenceId = insertDeclaredFence(db, runId, { testPath });

    for (const state of ['closed', 'plan_blocked', 'closing', 'repairing'] as const) {
      db.raw.prepare('UPDATE fences SET lifecycle_state = ? WHERE id = ?').run(state, fenceId);
      expect(() =>
        openFence(db, {
          fenceId,
          cwd: t.dir,
          repoRoot: t.dir,
          runCommand: injectReport(
            buildFenceReport({
              collected: ['R2.1'],
              failed: [{ id: 'R2.1', kind: 'assert' }],
            })
          ),
        })
      ).toThrow(/OPEN only from declared\|opening/);
    }
    db.close();
  });

  it('resumes from interrupted opening (re-runs probe, commits draining)', () => {
    const t = tempDir('helm-fence-b2-resume-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId } = insertProjectRun(db);
    const testPath = writeJourneyFile(t.dir);
    const fenceId = insertDeclaredFence(db, runId, { testPath });
    // Simulate crash after declared→opening, before baseline commit.
    db.raw
      .prepare("UPDATE fences SET lifecycle_state = 'opening' WHERE id = ?")
      .run(fenceId);

    const result = openFence(db, {
      fenceId,
      cwd: t.dir,
      repoRoot: t.dir,
      runCommand: injectReport(
        buildFenceReport({
          collected: ['R2.1'],
          failed: [{ id: 'R2.1', kind: 'assert' }],
        })
      ),
    });
    expect(result.lifecycle_state).toBe('draining');
    expect(getOpenBaseline(db, { fenceId })!.has_baseline).toBe(true);
    db.close();
  });

  it('idempotent when already draining with complete baseline', () => {
    const t = tempDir('helm-fence-b2-idem-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId } = insertProjectRun(db);
    const testPath = writeJourneyFile(t.dir);
    const fenceId = insertDeclaredFence(db, runId, { testPath });

    const first = openFence(db, {
      fenceId,
      cwd: t.dir,
      repoRoot: t.dir,
      runCommand: injectReport(
        buildFenceReport({
          collected: ['R2.1'],
          failed: [{ id: 'R2.1', kind: 'assert' }],
        })
      ),
    });
    let secondCalls = 0;
    const second = openFence(db, {
      fenceId,
      cwd: t.dir,
      repoRoot: t.dir,
      runCommand: () => {
        secondCalls += 1;
        throw new Error('must not re-run');
      },
    });
    expect(second.ok).toBe(true);
    expect(second.open_failed_ids).toEqual(first.open_failed_ids);
    expect(second.open_test_hash).toBe(first.open_test_hash);
    expect(secondCalls).toBe(0);
    db.close();
  });

  it('runs real external command via runFenceReportCommand (no inject)', () => {
    const t = tempDir('helm-fence-b2-realcmd-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId } = insertProjectRun(db);
    const testPath = writeJourneyFile(t.dir);
    const reportPath = path.join(t.dir, 'out-report.json');
    // integration_cmd writes a proving report then exits 1 — exit code alone is not the gate.
    const cmd = `printf '%s\\n' '{"schema":"fence-report-v1","collected":["R2.1"],"passed":[],"failed":[{"id":"R2.1","kind":"assert"}]}' > "$FENCE_REPORT_PATH"; exit 1`;
    const fenceId = insertDeclaredFence(db, runId, {
      testPath,
      integrationCmd: cmd,
    });

    const result = openFence(db, {
      fenceId,
      cwd: t.dir,
      repoRoot: t.dir,
      reportPath,
      timeoutMs: 10_000,
    });
    expect(result.ok).toBe(true);
    expect(result.open_failed_ids).toEqual(['R2.1']);
    expect(result.exitCode).toBe(1);
    expect(getOpenBaseline(db, { fenceId })!.has_baseline).toBe(true);
    db.close();
  });
});
