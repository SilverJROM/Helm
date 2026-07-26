/**
 * O7.2 — RELEASE-ATOMIC OVM/coordinator-gateway cutover + rollback tool.
 *
 * BUILD-NOT-EXECUTE: this file and its `scripts/ovm-cutover.sh` wrapper implement the guarded
 * cutover Tiller was scoped to BUILD. Firing a real `--execute` (or `--rollback`) is a single
 * human-owned irreversible transition — never invoked by Tiller/CI. `--dry-run` performs every
 * verification below and mutates nothing (no file write, no process, no network call besides the
 * optional read-only post-check probe it only DESCRIBES).
 *
 * Gate, in order: (1) live readiness report must be `ready`, (2) its `report_sha256` must exactly
 * equal the operator-supplied `--expect-hash` (a stale/drifted report refuses — AC4), (3) an
 * interactive operator must type CONFIRM_PHRASE at the terminal. Any missing piece refuses.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import Database from 'better-sqlite3';
import { loadConfig } from '../config/config.js';
import { DatabaseService } from '../db/database.js';
import { HelmIdentityService } from '../services/helm-identity-service.js';
import {
  OvmCutoverReadinessChecker,
  verifyReportSeal,
  type CutoverReadinessReport,
} from '../services/o7-ovm-cutover-readiness.js';

export const CONFIRM_PHRASE = 'CONFIRM CUTOVER';

export interface CutoverOperation {
  id: string;
  description: string;
  /** The literal shell command a real --execute runs for this step, or null when the step is
   * performed in-process (backup/rollback-point) rather than shelled out. */
  command: string | null;
  configured: boolean;
}

export interface CutoverPlan {
  backupPath: string;
  rollbackPointPath: string;
  postCheckUrl: string;
  operations: CutoverOperation[];
}

export interface ActiveRunStopCheck {
  ok: boolean;
  activeNativeRuns: number;
  detail: string;
}

export interface RollbackPoint {
  envelope: 'ovm-cutover-rollback-point/v1';
  createdAt: string;
  backupPath: string;
  dbPath: string;
  gitSha: string;
  reportSha256: string;
}

export interface ParsedArgs {
  mode: 'dry-run' | 'execute' | 'rollback';
  expectHash: string | null;
  legacyDbPath: string | null;
  backupDir: string | null;
  postCheckUrl: string | null;
  rollbackPointPath: string | null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  let mode: ParsedArgs['mode'] | null = null;
  for (const raw of argv) {
    if (raw === '--dry-run') { mode = 'dry-run'; continue; }
    if (raw === '--execute') { mode = 'execute'; continue; }
    if (raw === '--rollback') { mode = 'rollback'; continue; }
    const eq = raw.indexOf('=');
    if (raw.startsWith('--') && eq > 0) {
      flags.set(raw.slice(2, eq), raw.slice(eq + 1));
    }
  }
  if (!mode) {
    throw new Error('one of --dry-run, --execute, --rollback is required');
  }
  return {
    mode,
    expectHash: flags.get('expect-hash') ?? null,
    legacyDbPath: flags.get('legacy-db') ?? process.env.OVM_LEGACY_DB_PATH ?? null,
    backupDir: flags.get('backup-dir') ?? null,
    postCheckUrl: flags.get('post-check-url') ?? null,
    rollbackPointPath: flags.get('rollback-point') ?? null,
  };
}

export function gitHeadSha(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export function checkActiveRunStopCondition(db: DatabaseService): ActiveRunStopCheck {
  const row = db.raw.prepare("SELECT COUNT(*) AS c FROM runs WHERE status = 'active'").get() as { c: number };
  return {
    ok: row.c === 0,
    activeNativeRuns: row.c,
    detail: row.c === 0 ? 'no active native runs — stop condition clear' : `${row.c} active native run(s) block cutover`,
  };
}

/** Pure plan builder — never touches disk. The two hooks a real `--execute` shells out to are
 * sourced from operator env only; an unset hook is reported `configured: false`, never guessed. */
export function buildCutoverPlan(opts: { dbPath: string; backupDir: string; nowIso: string; postCheckUrl: string }): CutoverPlan {
  const stamp = opts.nowIso.replace(/[:.]/g, '-');
  const backupPath = path.join(opts.backupDir, `helm-pre-cutover-${stamp}.db`);
  const rollbackPointPath = path.join(opts.backupDir, `rollback-point-${stamp}.json`);
  const legacyStopCmd = process.env.OVM_CUTOVER_LEGACY_STOP_CMD || null;
  const gatewayFlipCmd = process.env.OVM_CUTOVER_GATEWAY_FLIP_CMD || null;
  return {
    backupPath,
    rollbackPointPath,
    postCheckUrl: opts.postCheckUrl,
    operations: [
      {
        id: 'backup-native-db',
        description: `hot-backup ${opts.dbPath} -> ${backupPath} (better-sqlite3 .backup(), no write lock held)`,
        command: null,
        configured: true,
      },
      {
        id: 'record-rollback-point',
        description: `write ${rollbackPointPath} {backupPath, gitSha, dbPath, reportSha256, createdAt}`,
        command: null,
        configured: true,
      },
      {
        id: 'stop-legacy-reporter',
        description: legacyStopCmd ? `run: ${legacyStopCmd}` : 'NOT CONFIGURED — set OVM_CUTOVER_LEGACY_STOP_CMD before --execute',
        command: legacyStopCmd,
        configured: !!legacyStopCmd,
      },
      {
        id: 'flip-coordinator-gateway',
        description: gatewayFlipCmd ? `run: ${gatewayFlipCmd}` : 'NOT CONFIGURED — set OVM_CUTOVER_GATEWAY_FLIP_CMD before --execute',
        command: gatewayFlipCmd,
        configured: !!gatewayFlipCmd,
      },
      {
        id: 'post-check-health',
        description: `GET ${opts.postCheckUrl} expect 200 (read-only probe, run only after the above land)`,
        command: null,
        configured: true,
      },
    ],
  };
}

function openLegacyDbReadOnly(legacyDbPath: string | null): Database.Database | undefined {
  if (!legacyDbPath) return undefined;
  if (!fs.existsSync(legacyDbPath)) return undefined;
  return new Database(legacyDbPath, { readonly: true });
}

export function buildReport(db: DatabaseService, legacyDb: Database.Database | undefined): CutoverReadinessReport {
  // Native-only identity boundary (O7.2): the legacy handle goes ONLY to the checker, which owns
  // the one-time native↔legacy parity + open-run comparison — never to the runtime identity service.
  const identity = new HelmIdentityService(db);
  const checker = new OvmCutoverReadinessChecker(db, identity, legacyDb);
  const uiEvidenceDir = process.env.OVM_CUTOVER_UI_EVIDENCE_DIR;
  const uiEvidence = uiEvidenceDir
    ? [
        { label: 'tracking-desktop', path: path.join(uiEvidenceDir, '01-tracking-desktop.png') },
        { label: 'tracking-mobile', path: path.join(uiEvidenceDir, '02-tracking-mobile.png') },
      ]
    : [];
  return checker.check({ uiEvidence });
}

function log(line: string): void {
  process.stdout.write(line + '\n');
}

async function performBackup(dbPath: string, backupPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  const db = new Database(dbPath, { readonly: true });
  try {
    await db.backup(backupPath);
  } finally {
    db.close();
  }
}

function writeRollbackPoint(point: RollbackPoint): void {
  fs.mkdirSync(path.dirname(point.backupPath), { recursive: true });
  fs.writeFileSync(rollbackPointPathFor(point), JSON.stringify(point, null, 2));
}

function rollbackPointPathFor(point: RollbackPoint): string {
  return point.backupPath.replace(/helm-pre-cutover-/, 'rollback-point-').replace(/\.db$/, '.json');
}

async function promptExact(question: string, expected: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return answer.trim() === expected;
}

export function restoreFromRollbackPoint(point: RollbackPoint): void {
  if (!fs.existsSync(point.backupPath)) {
    throw new Error(`rollback backup missing on disk: ${point.backupPath}`);
  }
  fs.copyFileSync(point.backupPath, point.dbPath);
}

export interface DryRunGateResult {
  ok: boolean;
  refusals: string[];
}

/**
 * O7.2 (AC3/AC4) — the dry-run cutover gate is the EXECUTE gate minus the human confirmation and
 * the mutation. It is MANDATORY, not optional: a real cutover is gated on the operator having
 * reviewed the exact O7.1 report, so the dry-run REQUIRES `--expect-hash` and REFUSES on an
 * absent/mismatched (stale) hash, a broken seal, a not-ready report, or a blocked active-run stop
 * condition. Passing this gate is the precondition a real `--execute` would then satisfy plus a
 * typed confirmation. Pure decision — logs/exit codes are the caller's.
 */
export function evaluateDryRunGate(input: {
  report: CutoverReadinessReport;
  sealOk: boolean;
  expectHash: string | null;
  stop: ActiveRunStopCheck;
}): DryRunGateResult {
  const refusals: string[] = [];
  if (!input.sealOk) {
    refusals.push('live report failed its own seal check — refusing to trust it');
  }
  if (!input.expectHash) {
    refusals.push('--expect-hash=<sha256> is required (the exact hash of the reviewed O7.1 report)');
  } else if (input.report.report_sha256 !== input.expectHash) {
    refusals.push('live report_sha256 does not match --expect-hash — the report is STALE (state drifted since review)');
  }
  if (!input.report.ready) {
    refusals.push(`readiness report is not ready (${input.report.checks.filter((c) => !c.ok).length} failing check(s))`);
  }
  if (!input.stop.ok) {
    refusals.push(input.stop.detail);
  }
  return { ok: refusals.length === 0, refusals };
}

async function runDryRun(args: ParsedArgs): Promise<number> {
  const config = loadConfig();
  const db = new DatabaseService(config.dbPath);
  let legacyDb: Database.Database | undefined;
  try {
    legacyDb = openLegacyDbReadOnly(args.legacyDbPath);
    const report = buildReport(db, legacyDb);
    const sealOk = verifyReportSeal(report);
    const stop = checkActiveRunStopCondition(db);

    log(`[dry-run] observed_at=${report.observed_at}`);
    log(`[dry-run] report_sha256=${report.report_sha256} seal_self_consistent=${sealOk}`);
    log(`[dry-run] ready=${report.ready} (${report.checks.filter((c) => !c.ok).length} failing check(s))`);
    for (const c of report.checks.filter((c) => !c.ok)) log(`[dry-run]   ✗ ${c.id}: ${c.detail}`);
    log(`[dry-run] active-run stop condition: ${stop.ok ? 'CLEAR' : 'BLOCKED'} — ${stop.detail}`);

    const backupDir = args.backupDir || path.join(path.dirname(path.resolve(config.dbPath)), 'backups');
    const postCheckUrl = args.postCheckUrl || `http://${config.host}:${config.port}/`;
    const plan = buildCutoverPlan({ dbPath: config.dbPath, backupDir, nowIso: report.observed_at, postCheckUrl });

    log('[dry-run] exact operations a real --execute would perform, in order:');
    for (const [i, op] of plan.operations.entries()) {
      log(`[dry-run]   ${i + 1}. ${op.id} — ${op.description} (configured=${op.configured})`);
    }
    log(`[dry-run] rollback point would be recorded at: ${plan.rollbackPointPath}`);
    log(`[dry-run] rollback restores via: cp ${plan.backupPath} ${config.dbPath}`);
    log('[dry-run] no service was restarted, no reporter was disabled, no file was written — verification only.');

    // The mandatory gate: the dry-run VERIFIES the exact reviewed report hash (a stale/absent hash
    // refuses), exactly as a real --execute would before it fires. Exit 0 only if the gate passes.
    const gate = evaluateDryRunGate({ report, sealOk, expectHash: args.expectHash, stop });
    if (gate.ok) {
      log('[dry-run] cutover gate: PASS — a real --execute would proceed to typed operator confirmation.');
    } else {
      log('[dry-run] cutover gate: REFUSE — a real --execute would NOT fire:');
      for (const r of gate.refusals) log(`[dry-run]   ✗ ${r}`);
      if (!args.expectHash) {
        log(`[dry-run] to gate a real cutover: review this report, then re-run with --expect-hash=${report.report_sha256}`);
      }
    }
    return gate.ok ? 0 : 1;
  } finally {
    legacyDb?.close();
    db.close();
  }
}

async function runExecute(args: ParsedArgs): Promise<number> {
  if (!args.expectHash) {
    log('[execute] REFUSED: --expect-hash=<sha256> is required (the exact hash of the reviewed O7.1 report).');
    return 1;
  }
  const config = loadConfig();
  const db = new DatabaseService(config.dbPath);
  let legacyDb: Database.Database | undefined;
  try {
    legacyDb = openLegacyDbReadOnly(args.legacyDbPath);
    const report = buildReport(db, legacyDb);

    if (!verifyReportSeal(report)) {
      log('[execute] REFUSED: live report failed its own seal check — refusing to trust it.');
      return 1;
    }
    if (report.report_sha256 !== args.expectHash) {
      log('[execute] REFUSED: live report_sha256 does not match --expect-hash — the report is STALE (state drifted since review).');
      return 1;
    }
    if (!report.ready) {
      log('[execute] REFUSED: live readiness report is not ready.');
      for (const c of report.checks.filter((c) => !c.ok)) log(`[execute]   ✗ ${c.id}: ${c.detail}`);
      return 1;
    }

    const stop = checkActiveRunStopCondition(db);
    if (!stop.ok) {
      log(`[execute] REFUSED: ${stop.detail}`);
      return 1;
    }

    const backupDir = args.backupDir || path.join(path.dirname(path.resolve(config.dbPath)), 'backups');
    const postCheckUrl = args.postCheckUrl || `http://${config.host}:${config.port}/`;
    const plan = buildCutoverPlan({ dbPath: config.dbPath, backupDir, nowIso: report.observed_at, postCheckUrl });
    const unconfigured = plan.operations.filter((o) => !o.configured);
    if (unconfigured.length > 0) {
      log('[execute] REFUSED: required operations are not configured:');
      for (const op of unconfigured) log(`[execute]   ✗ ${op.id}: ${op.description}`);
      return 1;
    }

    const confirmed = await promptExact(
      `About to fire an IRREVERSIBLE OVM cutover against ${config.dbPath}.\nType "${CONFIRM_PHRASE}" to proceed: `,
      CONFIRM_PHRASE
    );
    if (!confirmed) {
      log('[execute] REFUSED: confirmation phrase did not match — no human-owned go-ahead given.');
      return 1;
    }

    // From here on this is the single human-owned irreversible transition. Every step is logged.
    await performBackup(config.dbPath, plan.backupPath);
    log(`[execute] backup written: ${plan.backupPath}`);

    const rollbackPoint: RollbackPoint = {
      envelope: 'ovm-cutover-rollback-point/v1',
      createdAt: report.observed_at,
      backupPath: plan.backupPath,
      dbPath: path.resolve(config.dbPath),
      gitSha: gitHeadSha(),
      reportSha256: report.report_sha256,
    };
    writeRollbackPoint(rollbackPoint);
    log(`[execute] rollback point recorded: ${rollbackPointPathFor(rollbackPoint)}`);

    execSync(plan.operations.find((o) => o.id === 'stop-legacy-reporter')!.command!, { stdio: 'inherit' });
    log('[execute] legacy reporter stopped.');
    execSync(plan.operations.find((o) => o.id === 'flip-coordinator-gateway')!.command!, { stdio: 'inherit' });
    log('[execute] coordinator gateway flipped to native.');
    log('[execute] cutover complete. Run the post-check GET manually against: ' + plan.postCheckUrl);
    return 0;
  } finally {
    legacyDb?.close();
    db.close();
  }
}

async function runRollback(args: ParsedArgs): Promise<number> {
  if (!args.rollbackPointPath) {
    log('[rollback] REFUSED: --rollback-point=<path-to-rollback-point.json> is required.');
    return 1;
  }
  const point = JSON.parse(fs.readFileSync(args.rollbackPointPath, 'utf8')) as RollbackPoint;
  if (point.envelope !== 'ovm-cutover-rollback-point/v1') {
    log('[rollback] REFUSED: unrecognized rollback point envelope.');
    return 1;
  }
  const confirmed = await promptExact(
    `About to IRREVERSIBLY restore ${point.dbPath} from ${point.backupPath} (created ${point.createdAt}).\nType "${CONFIRM_PHRASE}" to proceed: `,
    CONFIRM_PHRASE
  );
  if (!confirmed) {
    log('[rollback] REFUSED: confirmation phrase did not match.');
    return 1;
  }
  restoreFromRollbackPoint(point);
  log(`[rollback] restored ${point.dbPath} from ${point.backupPath}.`);
  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const code = args.mode === 'dry-run' ? await runDryRun(args) : args.mode === 'execute' ? await runExecute(args) : await runRollback(args);
  process.exit(code);
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(String(err?.stack || err) + '\n');
    process.exit(1);
  });
}
