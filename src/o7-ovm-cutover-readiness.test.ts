import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from './db/database.js';
import { HelmIdentityService } from './services/helm-identity-service.js';
import {
  OvmCutoverReadinessChecker,
  cutoverReadinessExitCode,
  CUTOVER_READINESS_ENVELOPE,
} from './services/o7-ovm-cutover-readiness.js';

function tempDb(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dbPath: path.join(dir, 'helm.db'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function hash64(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

function countsOf(helm: DatabaseService) {
  const c = (table: string) => (helm.raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  return {
    projects: c('projects'),
    users: c('users'),
    runs: c('runs'),
    run_events: c('run_events'),
    run_ingest_receipts: c('run_ingest_receipts'),
  };
}

/**
 * One project (11/cards) with an active ingest run + a complete ingest run, one active native
 * owner, a matching legacy project row, and an open legacy overmind workflow reconciled by the
 * active native run — every refusal-class check passes. T2 mutates exactly one facet at a time.
 */
function setupCleanFixture(prefix: string) {
  const t = tempDb(prefix);
  const helm = new DatabaseService(t.dbPath);

  helm.raw.prepare('INSERT INTO projects (id, name, directory) VALUES (?, ?, ?)').run(11, 'Cards', '/work/cards');
  helm.raw.prepare(
    "INSERT INTO users (id, telegram_id, username, display_name, role) VALUES (?, ?, ?, ?, 'owner')"
  ).run(7, 700, 'owner', 'Owner');

  const run1 = helm.raw.prepare(
    `INSERT INTO runs (project_id, external_run_id, generation, source, status, phase, state_revision)
     VALUES (11, 'run-active', 0, 'ingest', 'active', 'executing', 0)`
  ).run();
  const run1Id = Number(run1.lastInsertRowid);
  helm.raw.prepare(`INSERT INTO run_events (run_id, event_type, payload_json) VALUES (?, 'REGISTERED', '{}')`).run(String(run1Id));
  helm.raw.prepare(
    `INSERT INTO run_ingest_receipts (run_id, event_id, semantic_key, payload_hash, response_json) VALUES (?, ?, ?, ?, ?)`
  ).run(run1Id, 'ev-active-register', '11:run-active:0:register', hash64('a'), JSON.stringify({ ok: true }));

  const run2 = helm.raw.prepare(
    `INSERT INTO runs (project_id, external_run_id, generation, source, status, phase, state_revision, terminal_seal_hash)
     VALUES (11, 'run-complete', 0, 'ingest', 'complete', 'complete', 1, ?)`
  ).run(hash64('seal'));
  const run2Id = Number(run2.lastInsertRowid);
  helm.raw.prepare(`INSERT INTO run_events (run_id, event_type, payload_json) VALUES (?, 'REGISTERED', '{}')`).run(String(run2Id));
  helm.raw.prepare(`INSERT INTO run_events (run_id, event_type, payload_json) VALUES (?, 'TERMINAL', '{}')`).run(String(run2Id));
  helm.raw.prepare(
    `INSERT INTO run_ingest_receipts (run_id, event_id, semantic_key, payload_hash, response_json) VALUES (?, ?, ?, ?, ?)`
  ).run(run2Id, 'ev-complete-register', '11:run-complete:0:register', hash64('b'), JSON.stringify({ ok: true }));
  helm.raw.prepare(
    `INSERT INTO run_ingest_receipts (run_id, event_id, semantic_key, payload_hash, response_json) VALUES (?, ?, ?, ?, ?)`
  ).run(run2Id, 'ev-complete-complete', '11:run-complete:0:complete', hash64('c'), JSON.stringify({ ok: true }));

  const legacy = new Database(':memory:');
  legacy.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY, directory_name TEXT, status TEXT, active INTEGER)');
  legacy.prepare('INSERT INTO projects (id, directory_name, status, active) VALUES (?, ?, ?, ?)').run(88, 'cards', 'active', 1);
  legacy.exec('CREATE TABLE overmind_projects (id INTEGER PRIMARY KEY, slug TEXT, app_path TEXT)');
  legacy.prepare('INSERT INTO overmind_projects (id, slug, app_path) VALUES (?, ?, ?)').run(5, 'HELM', '/home/agjrom/websites/cards/');
  legacy.exec('CREATE TABLE overmind_workflows (id INTEGER PRIMARY KEY, project_id INTEGER, status TEXT)');
  // Open legacy status, but reconciled: project 11 already has a native active run (run1).
  legacy.prepare('INSERT INTO overmind_workflows (id, project_id, status) VALUES (?, ?, ?)').run(1, 5, 'stuck');

  const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-o71-ui-'));
  const shot1 = path.join(uiDir, '01-tracking-desktop.png');
  const shot2 = path.join(uiDir, '02-tracking-mobile.png');
  fs.writeFileSync(shot1, 'fake-png-bytes-desktop');
  fs.writeFileSync(shot2, 'fake-png-bytes-mobile');
  const uiEvidence = [
    { label: 'tracking-desktop', path: shot1 },
    { label: 'tracking-mobile', path: shot2 },
  ];

  // O7.2: the runtime identity boundary is native-only; the legacy handle goes ONLY to the checker,
  // which owns the native↔legacy parity + open-run comparison.
  const identity = new HelmIdentityService(helm);
  const checker = new OvmCutoverReadinessChecker(helm, identity, legacy);

  return {
    helm, legacy, uiEvidence, checker, identity, run1Id, run2Id,
    cleanup: () => {
      legacy.close();
      helm.close();
      t.cleanup();
      fs.rmSync(uiDir, { recursive: true, force: true });
    },
  };
}

describe('O7.1 OvmCutoverReadinessChecker', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  it('T1 a clean fixture is ready with a stable seal across reruns, real artifacts, and zero mutation', () => {
    const f = setupCleanFixture('helm-o71-t1-');
    cleanups.push(f.cleanup);

    const before = countsOf(f.helm);
    const report1 = f.checker.check({ uiEvidence: f.uiEvidence, now: () => '2026-07-15T10:00:00.000Z' });
    const report2 = f.checker.check({ uiEvidence: f.uiEvidence, now: () => '2026-07-15T10:05:00.000Z' });
    const after = countsOf(f.helm);

    expect(after).toEqual(before);
    expect(report1.envelope).toBe(CUTOVER_READINESS_ENVELOPE);
    expect(report1.ready).toBe(true);
    expect(report2.ready).toBe(true);
    expect(cutoverReadinessExitCode(report1)).toBe(0);
    expect(report1.checks.every((c) => c.ok)).toBe(true);

    // AC3: rerun on unchanged state is semantically identical apart from the declared observation time.
    expect(report1.observed_at).toBe('2026-07-15T10:00:00.000Z');
    expect(report2.observed_at).toBe('2026-07-15T10:05:00.000Z');
    expect(report1.report_sha256).toBe(report2.report_sha256);
    expect(report1.report_sha256).toMatch(/^[a-f0-9]{64}$/);

    // AC2: DB identities, artifact hashes.
    expect(report1.db_identities.native_projects).toEqual([
      { id: 11, name: 'Cards', directory_name: 'cards', status: 'active', active: 1 },
    ]);
    expect(report1.db_identities.native_active_owner).toMatchObject({ id: 7, telegram_id: 700 });
    expect(report1.artifacts).toHaveLength(2);
    for (const artifact of report1.artifacts) {
      expect(artifact.sha256).toBe(hash64FileHex(artifact.path));
    }
  });

  it('T2 refusal: missing project identity fails closed with zero mutation', () => {
    const f = setupCleanFixture('helm-o71-t2-missing-');
    cleanups.push(f.cleanup);
    f.legacy.prepare('DELETE FROM projects WHERE directory_name = ?').run('cards');

    const before = countsOf(f.helm);
    const report = f.checker.check({ uiEvidence: f.uiEvidence });
    expect(countsOf(f.helm)).toEqual(before);

    expect(report.ready).toBe(false);
    expect(cutoverReadinessExitCode(report)).toBe(1);
    expect(report.checks.find((c) => c.id === 'project-identity:cards')).toMatchObject({ ok: false });
  });

  it('T2 refusal: duplicate/ambiguous external rows fail closed', () => {
    const f = setupCleanFixture('helm-o71-t2-dup-');
    cleanups.push(f.cleanup);
    f.legacy.prepare('INSERT INTO projects (id, directory_name, status, active) VALUES (?, ?, ?, ?)').run(89, 'cards', 'active', 1);

    const before = countsOf(f.helm);
    const report = f.checker.check({ uiEvidence: f.uiEvidence });
    expect(countsOf(f.helm)).toEqual(before);

    expect(report.ready).toBe(false);
    expect(report.checks.find((c) => c.id === 'project-identity:cards')).toMatchObject({ ok: false });
    expect(report.checks.find((c) => c.id === 'project-identity:cards')!.detail).toContain('ambiguous');
  });

  it('T2 refusal: mismatched legacy adapter response fails closed', () => {
    const f = setupCleanFixture('helm-o71-t2-mismatch-');
    cleanups.push(f.cleanup);
    // A broken legacy adapter whose projects query returns a single row whose directory_name does
    // NOT match the queried name — the defensive 'mismatched' parity branch. Overmind queries
    // return empty so open-run enumeration stays clean and only the parity guard trips.
    const mismatchedLegacy = {
      prepare: (sql: string) => ({
        all: (..._args: unknown[]) => (/FROM projects/i.test(sql) ? [{ id: 999, directory_name: 'NOT-cards' }] : []),
        get: () => undefined,
      }),
    };
    const identity = new HelmIdentityService(f.helm);
    const checker = new OvmCutoverReadinessChecker(f.helm, identity, mismatchedLegacy as any);

    const before = countsOf(f.helm);
    const report = checker.check({ uiEvidence: f.uiEvidence });
    expect(countsOf(f.helm)).toEqual(before);

    expect(report.ready).toBe(false);
    expect(report.checks.find((c) => c.id === 'project-identity:cards')!.detail).toContain('mismatched');
  });

  it('T2 refusal: owner conflict (zero active owners) fails closed for both owner checks', () => {
    const f = setupCleanFixture('helm-o71-t2-owner-');
    cleanups.push(f.cleanup);
    f.helm.raw.prepare('UPDATE users SET active = 0 WHERE id = 7').run();

    const before = countsOf(f.helm);
    const report = f.checker.check({ uiEvidence: f.uiEvidence });
    expect(countsOf(f.helm)).toEqual(before);

    expect(report.ready).toBe(false);
    expect(report.checks.find((c) => c.id === 'owner-cardinality')).toMatchObject({ ok: false, detail: 'active native owner count=0' });
    expect(report.checks.find((c) => c.id === 'native-auth')).toMatchObject({ ok: false });
    expect(report.db_identities.native_active_owner).toBeNull();
  });

  it('T2 refusal: a malformed ingest receipt fails closed', () => {
    const f = setupCleanFixture('helm-o71-t2-receipt-');
    cleanups.push(f.cleanup);
    f.helm.raw.prepare(
      `INSERT INTO run_ingest_receipts (run_id, event_id, semantic_key, payload_hash, response_json) VALUES (?, ?, ?, ?, ?)`
    ).run(f.run1Id, 'ev-malformed', '11:run-active:0:extra', 'not-a-hex-hash', '{"ok":true}');

    const before = countsOf(f.helm);
    const report = f.checker.check({ uiEvidence: f.uiEvidence });
    expect(countsOf(f.helm)).toEqual(before);

    expect(report.ready).toBe(false);
    const receiptCheck = report.checks.find((c) => c.id === 'ingest-receipt:ev-malformed');
    expect(receiptCheck).toMatchObject({ ok: false });
    expect(receiptCheck!.detail).toContain('payload_hash not 64-hex');
  });

  it('T2 refusal: revision/status inconsistency (complete run missing terminal seal + event) fails closed', () => {
    const f = setupCleanFixture('helm-o71-t2-revision-');
    cleanups.push(f.cleanup);
    const run3 = f.helm.raw.prepare(
      `INSERT INTO runs (project_id, external_run_id, generation, source, status, phase, state_revision)
       VALUES (11, 'run-broken', 0, 'ingest', 'complete', 'complete', 1)`
    ).run();
    f.helm.raw.prepare(`INSERT INTO run_events (run_id, event_type, payload_json) VALUES (?, 'REGISTERED', '{}')`)
      .run(String(Number(run3.lastInsertRowid)));

    const before = countsOf(f.helm);
    const report = f.checker.check({ uiEvidence: f.uiEvidence });
    expect(countsOf(f.helm)).toEqual(before);

    expect(report.ready).toBe(false);
    const runCheck = report.checks.find((c) => c.id === 'run-revision:11:run-broken:0');
    expect(runCheck).toMatchObject({ ok: false });
    expect(runCheck!.detail).toContain('TERMINAL events=0');
    expect(runCheck!.detail).toContain('missing terminal seal');
  });

  it('T2 refusal: an open legacy-only active run (no reconciling native run) fails closed', () => {
    const f = setupCleanFixture('helm-o71-t2-legacy-');
    cleanups.push(f.cleanup);
    f.helm.raw.prepare('INSERT INTO projects (id, name, directory) VALUES (?, ?, ?)').run(12, 'Solo', '/work/solo');
    f.legacy.prepare('INSERT INTO projects (id, directory_name, status, active) VALUES (?, ?, ?, ?)').run(90, 'solo', 'active', 1);
    f.legacy.prepare('INSERT INTO overmind_projects (id, slug, app_path) VALUES (?, ?, ?)').run(6, 'SOLO', '/work/solo');
    f.legacy.prepare('INSERT INTO overmind_workflows (id, project_id, status) VALUES (?, ?, ?)').run(2, 6, 'stuck');
    // Project 12 has zero native runs at all: nothing reconciles the open legacy workflow.

    const before = countsOf(f.helm);
    const report = f.checker.check({ uiEvidence: f.uiEvidence });
    expect(countsOf(f.helm)).toEqual(before);

    expect(report.ready).toBe(false);
    expect(report.checks.find((c) => c.id === 'project-identity:solo')).toMatchObject({ ok: true });
    const legacyCheck = report.checks.find((c) => c.id === 'legacy-open-run:solo');
    expect(legacyCheck).toMatchObject({ ok: false });
    expect(legacyCheck!.detail).toContain('open legacy-only active run');
  });

  it('T2 refusal: an open legacy workflow with NO native project (legacy-only) fails closed', () => {
    const f = setupCleanFixture('helm-o71-t2-legacyonly-');
    cleanups.push(f.cleanup);
    // An open legacy overmind workflow whose target directory has NO native project row at all.
    // The original scan iterated native projects and filtered legacy workflows to a matching
    // directory_name, so this workflow was never enumerated and the gate wrongly passed (ready=true).
    f.legacy.prepare('INSERT INTO overmind_projects (id, slug, app_path) VALUES (?, ?, ?)')
      .run(9, 'GHOST', '/home/agjrom/websites/legacy-only/');
    f.legacy.prepare('INSERT INTO overmind_workflows (id, project_id, status) VALUES (?, ?, ?)')
      .run(3, 9, 'stuck');

    const before = countsOf(f.helm);
    const report = f.checker.check({ uiEvidence: f.uiEvidence });
    expect(countsOf(f.helm)).toEqual(before); // read-only, zero mutation

    expect(report.ready).toBe(false);
    expect(cutoverReadinessExitCode(report)).toBe(1);
    // The legacy-only directory is now enumerated and fails closed.
    const legacyCheck = report.checks.find((c) => c.id === 'legacy-open-run:legacy-only');
    expect(legacyCheck).toMatchObject({ ok: false });
    expect(legacyCheck!.detail).toContain('open legacy-only active run');
    expect(legacyCheck!.detail).toContain('no native project');
    // The reconciled native directory (cards) still passes — only the legacy-only run trips the gate.
    expect(report.checks.find((c) => c.id === 'legacy-open-run:cards')).toMatchObject({ ok: true });
  });

  it('T2 refusal: missing UI (Tracking) evidence fails closed', () => {
    const f = setupCleanFixture('helm-o71-t2-ui-');
    cleanups.push(f.cleanup);

    const before = countsOf(f.helm);
    const reportMissingPath = f.checker.check({
      uiEvidence: [{ label: 'tracking-desktop', path: path.join(os.tmpdir(), 'does-not-exist-o71.png') }],
    });
    const reportNoEvidence = f.checker.check({ uiEvidence: [] });
    expect(countsOf(f.helm)).toEqual(before);

    expect(reportMissingPath.ready).toBe(false);
    expect(reportMissingPath.checks.find((c) => c.id === 'ui-evidence:tracking-desktop')).toMatchObject({ ok: false });
    expect(reportMissingPath.artifacts).toHaveLength(0);

    expect(reportNoEvidence.ready).toBe(false);
    expect(reportNoEvidence.checks.find((c) => c.id === 'ui-evidence')).toMatchObject({ ok: false });
  });

  it('T2 refusal: no legacy source configured cannot prove parity or no-legacy-only-run, fails closed', () => {
    const f = setupCleanFixture('helm-o71-t2-nolegacy-');
    cleanups.push(f.cleanup);
    const identity = new HelmIdentityService(f.helm); // no externalDb
    const checker = new OvmCutoverReadinessChecker(f.helm, identity); // no legacyDb

    const before = countsOf(f.helm);
    const report = checker.check({ uiEvidence: f.uiEvidence });
    expect(countsOf(f.helm)).toEqual(before);

    expect(report.ready).toBe(false);
    expect(report.checks.find((c) => c.id === 'project-identity:cards')).toMatchObject({ ok: false });
    expect(report.checks.find((c) => c.id === 'legacy-open-run')).toMatchObject({ ok: false });
  });
});

function hash64FileHex(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
