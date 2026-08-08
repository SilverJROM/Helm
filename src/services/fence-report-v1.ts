/**
 * fence-workflow-upgrade B1 — neutral fence-report-v1 runner/adapter (R6.1, R6.2, R6.3).
 *
 * Product surface for fence integration_cmd reports. Matches TILLER-USAGE.md §5.3 /
 * tiller_testexec.py: emit/parse {schema, collected, passed, failed[{id,kind}]};
 * only assert/fail prove absence; unknown kind demoted to infrastructure (fail-closed).
 *
 * Confirmed new build (R6.3): Helm's existing test gate is exit-code-only with no JSON
 * report convention. This module is the adapter boundary OPEN/CLOSE will consume.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const FENCE_REPORT_SCHEMA = 'fence-report-v1' as const;
export const FENCE_REPORT_NAME = 'fence-report-v1.json' as const;

/** Kinds that prove behaviour is genuinely absent (a named acceptance assertion ran and failed). */
export const PROVING_KINDS = ['assert', 'fail'] as const;

/**
 * Infrastructure kinds — red for the wrong reason (env/import/missing file/etc).
 * Never satisfy OPEN's proving-failure / absence gate.
 */
export const INFRA_KINDS = [
  'env',
  'syntax',
  'import',
  'not_found',
  'collect_error',
  'timeout',
  'error',
] as const;

export type FenceReportProvingKind = (typeof PROVING_KINDS)[number];
export type FenceReportInfraKind = (typeof INFRA_KINDS)[number];
export type FenceReportKind = FenceReportProvingKind | FenceReportInfraKind;

export const FENCE_REPORT_KINDS: readonly FenceReportKind[] = [...PROVING_KINDS, ...INFRA_KINDS];

const PROVING_SET = new Set<string>(PROVING_KINDS);
const INFRA_SET = new Set<string>(INFRA_KINDS);

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

export class FenceReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FenceReportError';
  }
}

export function isProvingKind(kind: string): kind is FenceReportProvingKind {
  return PROVING_SET.has(kind);
}

export function isInfraKind(kind: string): kind is FenceReportInfraKind {
  return INFRA_SET.has(kind);
}

export function isKnownFenceReportKind(kind: string): kind is FenceReportKind {
  return isProvingKind(kind) || isInfraKind(kind);
}

/**
 * Resolve where fence-report-v1.json lives for this process.
 * Order: FENCE_REPORT_PATH → run-dir/fence-report-v1.json → cwd.
 */
export function resolveFenceReportPath(opts?: {
  reportPath?: string | null;
  runDir?: string | null;
  repoRoot?: string | null;
}): string {
  const explicit = opts?.reportPath?.trim() || process.env.FENCE_REPORT_PATH?.trim();
  if (explicit) return explicit;

  const runDir =
    opts?.runDir?.trim() ||
    process.env.FENCE_RUN_DIR?.trim() ||
    process.env.TILLER_RUN_DIR?.trim() ||
    process.env.PROJCORE_RUN_DIR?.trim();
  if (runDir) return path.join(runDir, FENCE_REPORT_NAME);

  const repo = opts?.repoRoot?.trim() || process.cwd();
  return path.join(repo, FENCE_REPORT_NAME);
}

/** Candidate search paths (tiller load_report look order). */
export function fenceReportSearchPaths(opts?: {
  runDir?: string | null;
  repoRoot?: string | null;
}): string[] {
  const repo = opts?.repoRoot?.trim() || process.cwd();
  const runDir =
    opts?.runDir?.trim() ||
    process.env.FENCE_RUN_DIR?.trim() ||
    process.env.TILLER_RUN_DIR?.trim() ||
    process.env.PROJCORE_RUN_DIR?.trim() ||
    null;
  const out: string[] = [];
  if (runDir) out.push(path.join(runDir, FENCE_REPORT_NAME));
  out.push(path.join(repo, FENCE_REPORT_NAME));
  out.push(path.join(repo, '.tiller', FENCE_REPORT_NAME));
  return out;
}

export function findFenceReportPath(opts?: {
  runDir?: string | null;
  repoRoot?: string | null;
  reportPath?: string | null;
}): string | null {
  // Explicit path (arg or env) is exclusive — never silently fall back to another file.
  // Missing explicit path is "no report", same as tiller looking and not finding.
  const explicit = opts?.reportPath?.trim() || process.env.FENCE_REPORT_PATH?.trim();
  if (explicit) {
    return fs.existsSync(explicit) ? explicit : null;
  }
  for (const p of fenceReportSearchPaths(opts)) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Normalize failed entries: lowercased kind; unknown kinds demoted to `error`.
 * Fail-closed: inventing a label must not satisfy a red-gate (R6.2).
 */
export function normalizeFailed(
  failed: unknown
): Array<{ id: string; kind: FenceReportKind }> {
  if (!Array.isArray(failed)) return [];
  const out: Array<{ id: string; kind: FenceReportKind }> = [];
  for (const item of failed) {
    if (typeof item === 'string') {
      const id = item.trim();
      if (id) out.push({ id, kind: 'error' });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const aid = String(rec.id ?? rec.nodeid ?? '').trim();
    if (!aid) continue;
    let kind = String(rec.kind ?? 'error').trim().toLowerCase();
    if (!isKnownFenceReportKind(kind)) {
      kind = 'error';
    }
    out.push({ id: aid, kind: kind as FenceReportKind });
  }
  return out;
}

/**
 * Parse + validate a raw value into FenceReportV1.
 * Throws FenceReportError with a precise reason on any structural defect.
 */
export function parseFenceReport(raw: unknown): FenceReportV1 {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FenceReportError(`${FENCE_REPORT_NAME} is not a JSON object`);
  }
  const rep = raw as Record<string, unknown>;
  if (rep.schema !== FENCE_REPORT_SCHEMA) {
    throw new FenceReportError(
      `${FENCE_REPORT_NAME} schema is ${JSON.stringify(rep.schema)}, expected ${JSON.stringify(FENCE_REPORT_SCHEMA)}`
    );
  }
  for (const k of ['collected', 'passed', 'failed'] as const) {
    if (!Array.isArray(rep[k])) {
      throw new FenceReportError(`${FENCE_REPORT_NAME} missing or non-list field: ${k}`);
    }
  }
  const failed = normalizeFailed(rep.failed);
  return {
    schema: FENCE_REPORT_SCHEMA,
    collected: (rep.collected as unknown[]).map((x) => String(x)),
    passed: (rep.passed as unknown[]).map((x) => String(x)),
    failed,
  };
}

export function parseFenceReportJson(text: string): FenceReportV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new FenceReportError(`${FENCE_REPORT_NAME} is not valid JSON: ${e}`);
  }
  return parseFenceReport(raw);
}

export function loadFenceReport(opts?: {
  reportPath?: string | null;
  runDir?: string | null;
  repoRoot?: string | null;
}): { report: FenceReportV1; path: string } {
  const p = findFenceReportPath(opts);
  if (!p) {
    throw new FenceReportError(
      `no ${FENCE_REPORT_NAME} produced (looked in run-dir, repo root, repo/.tiller)`
    );
  }
  let text: string;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw new FenceReportError(`failed to read ${p}: ${e}`);
  }
  return { report: parseFenceReportJson(text), path: p };
}

/** Build a well-formed report (R6.1 emit shape). Unknown failure kinds demoted. */
export function buildFenceReport(input: {
  collected: readonly string[];
  passed?: readonly string[];
  failed?: readonly { id: string; kind?: string }[] | readonly string[];
}): FenceReportV1 {
  return {
    schema: FENCE_REPORT_SCHEMA,
    collected: [...input.collected],
    passed: [...(input.passed ?? [])],
    failed: normalizeFailed(input.failed ?? []),
  };
}

/** Emit fence-report-v1.json to disk (R6.1). Returns absolute path written. */
export function emitFenceReport(
  report: FenceReportV1 | Parameters<typeof buildFenceReport>[0],
  reportPath = resolveFenceReportPath()
): string {
  const normalized =
    report && typeof report === 'object' && 'schema' in report && report.schema === FENCE_REPORT_SCHEMA
      ? parseFenceReport(report)
      : buildFenceReport(report as Parameters<typeof buildFenceReport>[0]);

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return reportPath;
}

/**
 * (ok, reason). ok=true iff at least one NAMED ACCEPTANCE ASSERTION failed with a proving kind.
 * R6.2 — only assert/fail prove absence; infra-only or empty collected refuse.
 */
export function provingFailure(report: FenceReportV1): { ok: boolean; reason: string } {
  if (!report.collected || report.collected.length === 0) {
    return {
      ok: false,
      reason:
        'collected is empty — the test did not run; this is env/collection red, not absence of behaviour',
    };
  }
  const failed = normalizeFailed(report.failed);
  if (failed.length === 0) {
    return {
      ok: false,
      reason: 'nothing failed — the behaviour already exists, or the test asserts nothing',
    };
  }
  const proving = failed.filter((f) => isProvingKind(f.kind)).map((f) => f.id);
  if (proving.length === 0) {
    const kinds = sortedUnique(failed.map((f) => f.kind));
    return {
      ok: false,
      reason:
        `only infrastructure failures (${kinds.join(', ')}) — a missing file, bad import ` +
        `or absent fixture is red for the WRONG REASON and never proves absence`,
    };
  }
  return {
    ok: true,
    reason: `${proving.length} named assertion(s) failed: ${sortedUnique(proving).slice(0, 5).join(', ')}`,
  };
}

export function failedIds(report: FenceReportV1): string[] {
  return sortedUnique(normalizeFailed(report.failed).map((f) => f.id));
}

export function passedIds(report: FenceReportV1): string[] {
  return sortedUnique(report.passed.map(String));
}

/** Driver-owned fingerprint over failed assertion ids + kinds (routing key for later slices). */
export function fingerprint(report: FenceReportV1): string {
  const failed = normalizeFailed(report.failed);
  const ids = sortedUnique(failed.map((f) => f.id));
  const kinds = sortedUnique(failed.map((f) => f.kind));
  if (ids.length === 0) return '';
  const digest = createHash('sha256')
    .update(`${ids.join('|')}#${kinds.join('|')}`)
    .digest('hex')
    .slice(0, 20);
  return `fp1:${digest}`;
}

export interface RunFenceReportCommandResult {
  report: FenceReportV1;
  reportPath: string;
  exitCode: number;
  timedOut: boolean;
}

/**
 * Thin runner adapter: clear prior report, run integration_cmd via bash, load fence-report-v1.json.
 * Does not parse console output — report file is the only authority (R6.1 / R6.3).
 */
export function runFenceReportCommand(opts: {
  cmd: string;
  cwd?: string;
  runDir?: string | null;
  reportPath?: string | null;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): RunFenceReportCommandResult {
  const cwd = opts.cwd ?? process.cwd();
  const reportPath =
    opts.reportPath?.trim() ||
    process.env.FENCE_REPORT_PATH?.trim() ||
    resolveFenceReportPath({ runDir: opts.runDir, repoRoot: cwd });

  try {
    if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
  } catch {
    // best-effort clear; load will fail closed if stale/unreadable
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(opts.env ?? {}),
    FENCE_REPORT_PATH: reportPath,
  };

  let exitCode = 0;
  let timedOut = false;
  try {
    execFileSync('bash', ['-c', opts.cmd], {
      cwd,
      env,
      timeout: opts.timeoutMs ?? 1_800_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    exitCode = 0;
  } catch (e: unknown) {
    const err = e as { status?: number | null; signal?: string | null; killed?: boolean; code?: string };
    if (err.killed || err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM') {
      timedOut = true;
      throw new FenceReportError(
        `test command timed out after ${opts.timeoutMs ?? 1_800_000}ms`
      );
    }
    exitCode = typeof err.status === 'number' ? err.status : 1;
  }

  const loaded = loadFenceReport({
    reportPath,
    runDir: opts.runDir,
    repoRoot: cwd,
  });
  return {
    report: loaded.report,
    reportPath: loaded.path,
    exitCode,
    timedOut,
  };
}

/** In-memory recorder for journeys that emit reports after evaluation. */
export class FenceReportRecorder {
  private readonly outcomes = new Map<string, 'pass' | FenceReportKind>();

  constructor(private readonly acceptanceIds: readonly string[]) {}

  pass(id: string): void {
    this.assertKnown(id);
    this.outcomes.set(id, 'pass');
  }

  fail(id: string, kind: FenceReportKind | string = 'assert'): void {
    this.assertKnown(id);
    let k = String(kind).trim().toLowerCase();
    if (!isKnownFenceReportKind(k)) k = 'error';
    this.outcomes.set(id, k as FenceReportKind);
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
        failed.push({ id, kind: (outcome as FenceReportKind) ?? 'collect_error' });
      }
    }
    return { schema: FENCE_REPORT_SCHEMA, collected, passed, failed };
  }

  write(reportPath?: string): string {
    return emitFenceReport(this.toReport(), reportPath ?? resolveFenceReportPath());
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

function sortedUnique(xs: readonly string[]): string[] {
  return [...new Set(xs)].sort();
}
