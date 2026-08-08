import fs from 'node:fs';
import path from 'node:path';

export const FENCE_REPORT_SCHEMA = 'fence-report-v1' as const;

export const FENCE_REPORT_KINDS = [
  'assert',
  'fail',
  'env',
  'syntax',
  'import',
  'not_found',
  'collect_error',
  'timeout',
  'error',
] as const;

export type FenceReportKind = (typeof FENCE_REPORT_KINDS)[number];

export interface FenceReportFailure {
  id: string;
  kind: FenceReportKind;
}

export interface FenceReportV1 {
  schema: typeof FENCE_REPORT_SCHEMA;
  collected: string[];
  passed: string[];
  failed: FenceReportFailure[];
}

export function resolveFenceReportPath(): string {
  const explicit = process.env.FENCE_REPORT_PATH?.trim();
  if (explicit) return explicit;

  const runDir =
    process.env.FENCE_RUN_DIR?.trim() ||
    process.env.TILLER_RUN_DIR?.trim() ||
    process.env.PROJCORE_RUN_DIR?.trim();
  if (runDir) return path.join(runDir, 'fence-report-v1.json');

  return path.join(process.cwd(), 'fence-report-v1.json');
}

export function writeFenceReport(report: FenceReportV1, reportPath = resolveFenceReportPath()): string {
  const normalized: FenceReportV1 = {
    schema: FENCE_REPORT_SCHEMA,
    collected: [...report.collected],
    passed: [...report.passed],
    failed: report.failed.map((f) => ({ id: f.id, kind: f.kind })),
  };

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return reportPath;
}

export class FenceReportRecorder {
  private readonly outcomes = new Map<string, 'pass' | FenceReportKind>();

  constructor(private readonly acceptanceIds: readonly string[]) {}

  pass(id: string): void {
    this.assertKnown(id);
    this.outcomes.set(id, 'pass');
  }

  fail(id: string, kind: FenceReportKind = 'assert'): void {
    this.assertKnown(id);
    this.outcomes.set(id, kind);
  }

  toReport(): FenceReportV1 {
    const collected = [...this.acceptanceIds];
    const passed: string[] = [];
    const failed: FenceReportFailure[] = [];

    for (const id of collected) {
      const outcome = this.outcomes.get(id);
      if (outcome === 'pass') {
        passed.push(id);
      } else {
        failed.push({ id, kind: outcome ?? 'collect_error' });
      }
    }

    return {
      schema: FENCE_REPORT_SCHEMA,
      collected,
      passed,
      failed,
    };
  }

  write(reportPath?: string): string {
    return writeFenceReport(this.toReport(), reportPath);
  }

  private assertKnown(id: string): void {
    if (!this.acceptanceIds.includes(id)) {
      throw new Error(`unknown fence acceptance id: ${id}`);
    }
  }
}

export function createFenceReportRecorder(acceptanceIds: readonly string[]): FenceReportRecorder {
  return new FenceReportRecorder(acceptanceIds);
}
