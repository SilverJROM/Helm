import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { HelmIdentityService } from './helm-identity-service.js';

export const CUTOVER_READINESS_ENVELOPE = 'ovm-cutover-readiness/v1' as const;

const HEX64 = /^[a-f0-9]{64}$/i;
const SEMANTIC_KEY_SHAPE = /^\d+:.+:\d+:(register|complete)$/;
/** overmind_workflows.status values that mean the legacy run is still open (mirrors AGJAssist's schema). */
const OPEN_LEGACY_WORKFLOW_STATUSES = ['active', 'working', 'waiting_human', 'awaiting_decision', 'stuck', 'paused'];

/** Pre-cutover only: how a native project's directory_name reconciles against the legacy projects table. */
type LegacyProjectParity = 'matched' | 'missing' | 'mismatched' | 'ambiguous' | 'not-configured' | 'not-checked';

type RawDb = { prepare(sql: string): { all(...args: unknown[]): any[]; get(...args: unknown[]): any } };

export interface CutoverReadinessCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface CutoverReadinessArtifact {
  label: string;
  path: string;
  sha256: string;
}

export interface CutoverReadinessReport {
  envelope: typeof CUTOVER_READINESS_ENVELOPE;
  ready: boolean;
  observed_at: string;
  db_identities: {
    native_projects: Array<{ id: number; name: string; directory_name: string; status: string; active: number }>;
    native_active_owner: { id: number; telegram_id: number; username: string | null; display_name: string | null } | null;
  };
  checks: CutoverReadinessCheck[];
  artifacts: CutoverReadinessArtifact[];
  report_sha256: string;
}

export interface CutoverReadinessOptions {
  /** UI-proof artifacts (e.g. the O6.2 Tracking screenshots) that must exist and are sealed into the report. */
  uiEvidence?: Array<{ label: string; path: string }>;
  /** Injectable clock for observed_at; defaults to the real clock. Never affects report_sha256 (AC3). */
  now?: () => string;
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function contentHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * O7.1 — GATE-ATOMIC additive cutover-readiness checker. Read-only: it performs no cutover, no
 * deploy, and no mutation of any kind. Every refusal class (missing/duplicate/mismatched project
 * identity, owner conflict, malformed receipt, revision/status inconsistency, open legacy-only
 * active run, missing UI evidence) fails the gate closed (ready=false) rather than warn-and-pass.
 * `report_sha256` is computed over everything except `observed_at`, so a rerun against unchanged
 * state reproduces the identical seal (AC3) while still declaring its own observation time (AC2).
 */
export class OvmCutoverReadinessChecker {
  constructor(
    private readonly db: DatabaseService,
    private readonly identity: HelmIdentityService,
    /** Read-only legacy (AGJAssist) connection. This checker owns the ONLY native↔legacy comparison
     * (project-identity parity here + overmind_* open-run enumeration below); the runtime
     * HelmIdentityService is native-only and never touches it. */
    private readonly legacyDb?: RawDb
  ) {}

  /**
   * O7.2 — the native↔legacy directory_name parity check, driven directly from this checker's own
   * read-only legacy handle (relocated out of the now native-only HelmIdentityService). Native and
   * legacy numeric ids are unrelated, so the lookup is by directory_name only, never by id.
   */
  private legacyProjectParity(directoryName: string): LegacyProjectParity {
    if (!this.legacyDb) return 'not-configured';
    let matches: Array<{ id: number; directory_name: string }>;
    try {
      matches = this.legacyDb.prepare(
        "SELECT id, directory_name FROM projects WHERE directory_name = ? AND status = 'active' AND active = 1"
      ).all(directoryName) as Array<{ id: number; directory_name: string }>;
    } catch {
      return 'not-checked';
    }
    if (matches.length === 1 && matches[0].directory_name === directoryName) return 'matched';
    if (matches.length === 0) return 'missing';
    // Defend the boundary even if an adapter violates the exact-name query.
    if (matches.length === 1) return 'mismatched';
    return 'ambiguous';
  }

  check(options: CutoverReadinessOptions = {}): CutoverReadinessReport {
    const now = options.now ?? (() => new Date().toISOString());
    const checks: CutoverReadinessCheck[] = [];

    const nativeProjects = this.db.raw.prepare(
      `SELECT id, name, directory_name, status, active FROM projects WHERE status = 'active' AND active = 1 ORDER BY id`
    ).all() as Array<{ id: number; name: string; directory_name: string; status: string; active: number }>;

    if (nativeProjects.length === 0) {
      checks.push({ id: 'project-identity', ok: false, detail: 'no active native projects to verify' });
    }
    for (const project of nativeProjects) {
      // The native boundary must resolve it natively AND it must reconcile 1:1 against the legacy
      // projects table by directory_name (parity computed here, from this checker's legacy handle).
      const resolution = this.identity.resolveProject(project.id);
      const nativeResolved = resolution.state === 'resolved' && !!resolution.project;
      const parity = this.legacyProjectParity(project.directory_name);
      checks.push({
        id: `project-identity:${project.directory_name}`,
        ok: nativeResolved && parity === 'matched',
        detail: `directory_name=${project.directory_name} parity=${parity} state=${resolution.state}`,
      });
    }

    const ownerCount = (this.db.raw.prepare(
      `SELECT COUNT(*) AS c FROM users WHERE role = 'owner' AND active = 1`
    ).get() as { c: number }).c;
    checks.push({ id: 'owner-cardinality', ok: ownerCount === 1, detail: `active native owner count=${ownerCount}` });

    // Same resolver AuthService.issueOwnerToken/verifyToken rely on (O4.3) — proves the auth
    // boundary itself resolves, not just that the row count is correct.
    const ownerResolution = this.identity.resolveActiveOwner();
    const nativeAuthOk = ownerResolution.source === 'helm' && ownerResolution.state === 'resolved' && !!ownerResolution.user;
    checks.push({ id: 'native-auth', ok: nativeAuthOk, detail: `owner resolver source=${ownerResolution.source} state=${ownerResolution.state}` });

    const receipts = this.db.raw.prepare(
      `SELECT id, event_id, semantic_key, payload_hash, response_json FROM run_ingest_receipts ORDER BY id`
    ).all() as Array<{ id: number; event_id: string; semantic_key: string; payload_hash: string; response_json: string }>;
    for (const receipt of receipts) {
      const problems: string[] = [];
      if (!HEX64.test(receipt.payload_hash)) problems.push('payload_hash not 64-hex');
      if (!SEMANTIC_KEY_SHAPE.test(receipt.semantic_key)) problems.push('semantic_key malformed');
      try {
        const parsed = JSON.parse(receipt.response_json);
        if (!parsed || parsed.ok !== true) problems.push('response_json missing ok:true');
      } catch {
        problems.push('response_json not valid JSON');
      }
      checks.push({
        id: `ingest-receipt:${receipt.event_id}`,
        ok: problems.length === 0,
        detail: problems.length === 0 ? 'well-formed' : `malformed receipt: ${problems.join(', ')}`,
      });
    }

    const ingestRuns = this.db.raw.prepare(
      `SELECT id, project_id, external_run_id, generation, status, phase, state_revision, terminal_seal_hash
       FROM runs WHERE source = 'ingest' ORDER BY id`
    ).all() as Array<{
      id: number; project_id: number; external_run_id: string; generation: number;
      status: string; phase: string; state_revision: number; terminal_seal_hash: string | null;
    }>;
    for (const run of ingestRuns) {
      const eventCounts = this.db.raw.prepare(
        `SELECT event_type, COUNT(*) AS c FROM run_events WHERE run_id = ? GROUP BY event_type`
      ).all(String(run.id)) as Array<{ event_type: string; c: number }>;
      const counts = new Map(eventCounts.map((e) => [e.event_type, e.c]));
      const registered = counts.get('REGISTERED') ?? 0;
      const terminal = counts.get('TERMINAL') ?? 0;

      const problems: string[] = [];
      if (registered !== 1) problems.push(`REGISTERED events=${registered}`);
      if (run.status === 'active') {
        if (terminal !== 0) problems.push('active run already has a TERMINAL event');
        if (run.state_revision !== 0) problems.push(`active run state_revision=${run.state_revision}`);
      } else if (run.status === 'complete' || run.status === 'failed' || run.status === 'paused') {
        // #52: 'paused' is terminal-for-now (operator-recoverable). It carries a TERMINAL event like any
        // other halt, but — being resumable — it is not sealed, so the seal assertion applies only to
        // 'complete'.
        if (terminal !== 1) problems.push(`TERMINAL events=${terminal}`);
        if (run.state_revision < 1) problems.push(`terminal run state_revision=${run.state_revision}`);
        if (run.status === 'complete' && !run.terminal_seal_hash) problems.push('complete run missing terminal seal');
      } else {
        problems.push(`unexpected run status=${run.status}`);
      }
      checks.push({
        id: `run-revision:${run.project_id}:${run.external_run_id}:${run.generation}`,
        ok: problems.length === 0,
        detail: problems.length === 0 ? 'consistent' : problems.join('; '),
      });
    }

    if (!this.legacyDb) {
      checks.push({ id: 'legacy-open-run', ok: false, detail: 'no legacy workflow source configured; cannot prove no legacy-only active run' });
    } else {
      let openWorkflows: Array<{ status: string; app_path: string }> | null = null;
      try {
        openWorkflows = this.legacyDb.prepare(
          `SELECT ow.status AS status, op.app_path AS app_path
           FROM overmind_workflows ow JOIN overmind_projects op ON op.id = ow.project_id
           WHERE ow.status IN (${OPEN_LEGACY_WORKFLOW_STATUSES.map(() => '?').join(',')})
           ORDER BY op.app_path, ow.id`
        ).all(...OPEN_LEGACY_WORKFLOW_STATUSES);
      } catch {
        checks.push({ id: 'legacy-open-run', ok: false, detail: 'legacy workflow read error' });
      }

      if (openWorkflows) {
        // Enumerate EVERY open legacy workflow by its target directory — driven from the LEGACY side,
        // not by iterating native projects. A legacy-only open run (a directory with no native project
        // row at all) must fail the gate closed; scanning native projects alone silently ignored it.
        const openByDir = new Map<string, string[]>();
        for (const w of openWorkflows) {
          const dir = path.basename(w.app_path);
          const statuses = openByDir.get(dir) ?? [];
          statuses.push(w.status);
          openByDir.set(dir, statuses);
        }
        const nativeByDir = new Map(nativeProjects.map((p) => [p.directory_name, p]));

        for (const [dir, statuses] of openByDir) {
          const project = nativeByDir.get(dir);
          if (!project) {
            checks.push({
              id: `legacy-open-run:${dir}`,
              ok: false,
              detail: `open legacy-only active run: legacy status(es) [${statuses.join(',')}] for directory '${dir}' with no native project`,
            });
            continue;
          }
          const nativeActive = (this.db.raw.prepare(
            `SELECT COUNT(*) AS c FROM runs WHERE project_id = ? AND status = 'active'`
          ).get(project.id) as { c: number }).c;
          const ok = nativeActive > 0;
          checks.push({
            id: `legacy-open-run:${dir}`,
            ok,
            detail: ok
              ? `open legacy workflow(s) [${statuses.join(',')}] reconciled by ${nativeActive} native active run(s)`
              : `open legacy-only active run: legacy status(es) [${statuses.join(',')}] with zero native active runs`,
          });
        }

        // Native projects with no open legacy workflow at all are clean (positive evidence).
        for (const project of nativeProjects) {
          if (!openByDir.has(project.directory_name)) {
            checks.push({ id: `legacy-open-run:${project.directory_name}`, ok: true, detail: 'no open legacy workflow' });
          }
        }
      }
    }

    const artifacts: CutoverReadinessArtifact[] = [];
    const uiEvidence = options.uiEvidence ?? [];
    if (uiEvidence.length === 0) {
      checks.push({ id: 'ui-evidence', ok: false, detail: 'no Tracking UI evidence artifacts declared' });
    }
    for (const item of uiEvidence) {
      try {
        const stat = fs.statSync(item.path);
        if (!stat.isFile() || stat.size === 0) throw new Error('not a non-empty file');
        artifacts.push({ label: item.label, path: item.path, sha256: sha256File(item.path) });
        checks.push({ id: `ui-evidence:${item.label}`, ok: true, detail: `present, ${stat.size} bytes` });
      } catch (err: any) {
        checks.push({ id: `ui-evidence:${item.label}`, ok: false, detail: `missing UI evidence: ${err.message}` });
      }
    }

    const ready = checks.length > 0 && checks.every((c) => c.ok);
    const nativeActiveOwner = ownerResolution.user
      ? {
          id: ownerResolution.user.id,
          telegram_id: ownerResolution.user.telegramId,
          username: ownerResolution.user.username,
          display_name: ownerResolution.user.displayName,
        }
      : null;

    const sealedBody = {
      envelope: CUTOVER_READINESS_ENVELOPE,
      ready,
      db_identities: { native_projects: nativeProjects, native_active_owner: nativeActiveOwner },
      checks,
      artifacts,
    };
    return { ...sealedBody, observed_at: now(), report_sha256: contentHash(sealedBody) };
  }
}

/**
 * O7.2 — recompute the seal over a loaded report the exact same way `check()` sealed it (everything
 * except `observed_at`/`report_sha256` itself) and compare. The ONE way any consumer (e.g. the
 * cutover dry-run) may trust a report on disk instead of re-deriving the hash formula itself.
 */
export function verifyReportSeal(report: CutoverReadinessReport): boolean {
  const { observed_at, report_sha256, ...sealedBody } = report;
  return contentHash(sealedBody) === report_sha256;
}

/** Pure exit-code mapping for a future CLI/dry-run consumer (e.g. O7.2) — never calls process.exit itself. */
export function cutoverReadinessExitCode(report: CutoverReadinessReport): 0 | 1 {
  return report.ready ? 0 : 1;
}
