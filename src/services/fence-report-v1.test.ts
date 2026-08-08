/**
 * fence-workflow-upgrade B1 — fence-report-v1 runner/adapter (R6.1, R6.2, R6.3).
 *
 * R6.1 emit/parse shape · R6.2 assert/fail-only prove absence + unknown kind fail-closed ·
 * R6.3 product adapter is new build (not exit-code-only wiring).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FENCE_REPORT_SCHEMA,
  FenceReportError,
  buildFenceReport,
  emitFenceReport,
  fingerprint,
  isProvingKind,
  loadFenceReport,
  normalizeFailed,
  parseFenceReport,
  parseFenceReportJson,
  provingFailure,
  runFenceReportCommand,
} from './fence-report-v1.js';

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('B1 fence-report-v1 adapter (R6.1, R6.2, R6.3)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  // --- R6.1: emit + parse structured report -------------------------------------------------

  it('R6.1 emit produces {schema, collected, passed, failed[{id,kind}]}', () => {
    const t = tempDir('helm-fence-b1-emit-');
    cleanups.push(t.cleanup);
    const reportPath = path.join(t.dir, 'fence-report-v1.json');

    const written = emitFenceReport(
      {
        collected: ['R6.1', 'R6.2', 'R6.3'],
        passed: [],
        failed: [
          { id: 'R6.1', kind: 'assert' },
          { id: 'R6.2', kind: 'assert' },
          { id: 'R6.3', kind: 'assert' },
        ],
      },
      reportPath
    );

    expect(written).toBe(reportPath);
    const disk = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    expect(disk.schema).toBe(FENCE_REPORT_SCHEMA);
    expect(disk.collected).toEqual(['R6.1', 'R6.2', 'R6.3']);
    expect(disk.passed).toEqual([]);
    expect(disk.failed).toEqual([
      { id: 'R6.1', kind: 'assert' },
      { id: 'R6.2', kind: 'assert' },
      { id: 'R6.3', kind: 'assert' },
    ]);
  });

  it('R6.1 parse accepts a valid report and rejects wrong schema / missing lists', () => {
    const ok = parseFenceReport({
      schema: 'fence-report-v1',
      collected: ['A'],
      passed: ['A'],
      failed: [],
    });
    expect(ok.schema).toBe('fence-report-v1');
    expect(ok.collected).toEqual(['A']);
    expect(ok.passed).toEqual(['A']);
    expect(ok.failed).toEqual([]);

    expect(() => parseFenceReport({ schema: 'other', collected: [], passed: [], failed: [] })).toThrow(
      FenceReportError
    );
    expect(() =>
      parseFenceReport({ schema: 'fence-report-v1', collected: 'nope', passed: [], failed: [] })
    ).toThrow(/missing or non-list field: collected/);
    expect(() => parseFenceReportJson('{not json')).toThrow(/not valid JSON/);
  });

  it('R6.1 loadFenceReport reads from path; missing report is a precise error', () => {
    const t = tempDir('helm-fence-b1-load-');
    cleanups.push(t.cleanup);
    const reportPath = path.join(t.dir, 'fence-report-v1.json');
    emitFenceReport(
      buildFenceReport({
        collected: ['X'],
        failed: [{ id: 'X', kind: 'assert' }],
      }),
      reportPath
    );

    const loaded = loadFenceReport({ reportPath });
    expect(loaded.path).toBe(reportPath);
    expect(loaded.report.collected).toEqual(['X']);
    expect(loaded.report.failed[0]).toEqual({ id: 'X', kind: 'assert' });

    const missing = path.join(t.dir, 'does-not-exist.json');
    expect(() => loadFenceReport({ reportPath: missing, repoRoot: t.dir })).toThrow(
      /no fence-report-v1\.json produced/
    );
  });

  // --- R6.2: only assert/fail prove absence; unknown kind fail-closed -----------------------

  it('R6.2 provingFailure accepts assert and fail kinds', () => {
    const assertRep = buildFenceReport({
      collected: ['R2.1'],
      failed: [{ id: 'R2.1', kind: 'assert' }],
    });
    expect(provingFailure(assertRep).ok).toBe(true);
    expect(isProvingKind('assert')).toBe(true);

    const failRep = buildFenceReport({
      collected: ['R2.1'],
      failed: [{ id: 'R2.1', kind: 'fail' }],
    });
    expect(provingFailure(failRep).ok).toBe(true);
    expect(isProvingKind('fail')).toBe(true);
  });

  it('R6.2 infrastructure-only failures never prove absence', () => {
    for (const kind of ['env', 'syntax', 'import', 'not_found', 'collect_error', 'timeout', 'error'] as const) {
      const rep = buildFenceReport({
        collected: ['R2.1'],
        failed: [{ id: 'R2.1', kind }],
      });
      const r = provingFailure(rep);
      expect(r.ok, `kind=${kind} must not prove absence`).toBe(false);
      expect(r.reason).toMatch(/infrastructure/i);
    }
  });

  it('R6.2 empty collected refuses (collection/env red, not absence)', () => {
    const r = provingFailure(
      buildFenceReport({
        collected: [],
        failed: [{ id: 'R2.1', kind: 'assert' }],
      })
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/collected is empty/);
  });

  it('R6.2 nothing failed refuses (already green / asserts nothing)', () => {
    const r = provingFailure(
      buildFenceReport({
        collected: ['R2.1'],
        passed: ['R2.1'],
        failed: [],
      })
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nothing failed/);
  });

  it('R6.2 unknown kind is demoted to error and fails closed for prove-absence', () => {
    const normalized = normalizeFailed([{ id: 'R2.1', kind: 'made_up_label' }]);
    expect(normalized).toEqual([{ id: 'R2.1', kind: 'error' }]);

    // Parse path also demotes (parser branch, not an assumption about well-formed input).
    const parsed = parseFenceReport({
      schema: 'fence-report-v1',
      collected: ['R2.1'],
      passed: [],
      failed: [{ id: 'R2.1', kind: 'totally_invented' }],
    });
    expect(parsed.failed[0].kind).toBe('error');
    expect(provingFailure(parsed).ok).toBe(false);
    expect(provingFailure(parsed).reason).toMatch(/infrastructure/);
  });

  it('R6.2 bare string failed entries are treated as infrastructure error', () => {
    const norm = normalizeFailed(['AC-1']);
    expect(norm).toEqual([{ id: 'AC-1', kind: 'error' }]);
    expect(
      provingFailure(
        buildFenceReport({ collected: ['AC-1'], failed: ['AC-1'] as unknown as { id: string; kind: string }[] })
      ).ok
    ).toBe(false);
  });

  // --- R6.3: new-build runner adapter (not exit-code-only) ----------------------------------

  it('R6.3 runner adapter loads the JSON report after a command (exit code alone is not the gate)', () => {
    const t = tempDir('helm-fence-b1-run-');
    cleanups.push(t.cleanup);
    const reportPath = path.join(t.dir, 'out-report.json');

    // Command exits 0 but writes a proving assert failure — adapter still surfaces the report.
    // Exit code is recorded; prove-absence is derived from the report, not rc.
    const greenRcCmd = `printf '%s\\n' '{"schema":"fence-report-v1","collected":["R6.1"],"passed":[],"failed":[{"id":"R6.1","kind":"assert"}]}' > "$FENCE_REPORT_PATH"`;
    const r0 = runFenceReportCommand({
      cmd: greenRcCmd,
      cwd: t.dir,
      reportPath,
      timeoutMs: 10_000,
    });
    expect(r0.exitCode).toBe(0);
    expect(r0.report.failed[0]).toEqual({ id: 'R6.1', kind: 'assert' });
    expect(provingFailure(r0.report).ok).toBe(true);

    // Command exits non-zero with only infra failure — report says no proving absence.
    const redInfraCmd = `printf '%s\\n' '{"schema":"fence-report-v1","collected":["R6.1"],"passed":[],"failed":[{"id":"R6.1","kind":"import"}]}' > "$FENCE_REPORT_PATH"; exit 1`;
    const r1 = runFenceReportCommand({
      cmd: redInfraCmd,
      cwd: t.dir,
      reportPath,
      timeoutMs: 10_000,
    });
    expect(r1.exitCode).not.toBe(0);
    expect(provingFailure(r1.report).ok).toBe(false);

    // fingerprint is stable over id+kind set (driver-owned routing key surface).
    const fp = fingerprint(r0.report);
    expect(fp).toMatch(/^fp1:[0-9a-f]{20}$/);
  });

  it('R6.3 product module path is the fence-report-v1 adapter surface', () => {
    // F2 journey gates on this path existing as product surface (not plan-time emit helper alone).
    const productPath = path.join(process.cwd(), 'src/services/fence-report-v1.ts');
    expect(fs.existsSync(productPath)).toBe(true);
    const src = fs.readFileSync(productPath, 'utf8');
    expect(src).toMatch(/provingFailure/);
    expect(src).toMatch(/PROVING_KINDS/);
    expect(src).toMatch(/emitFenceReport|parseFenceReport/);
  });
});
