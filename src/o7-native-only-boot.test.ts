import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config/config.js';
import { DatabaseService } from './db/database.js';
import { bootstrapNativeOwner } from './auth/owner-bootstrap.js';
import { HelmIdentityService } from './services/helm-identity-service.js';
import { MasterModelService } from './services/master-model-service.js';
import { MasterRuntimeService } from './services/master-runtime-service.js';
import { WorkerService } from './services/worker-service.js';
import { AgentEventsService } from './services/agent-events-service.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { ProviderResolverService } from './services/provider-resolver-service.js';
import { OvmCutoverReadinessChecker, verifyReportSeal } from './services/o7-ovm-cutover-readiness.js';
import { evaluateDryRunGate, checkActiveRunStopCondition } from './scripts/ovm-cutover.js';

const OWNER_TELEGRAM_ID = 7290;

function sourceOf(relPath: string): string {
  return fs.readFileSync(new URL(`./${relPath}`, import.meta.url), 'utf8');
}

describe('hybrid boundary — AGJAssist is human-auth only and runtime project identity remains native', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-o72-boot-'));
    const dbs = new DatabaseService(path.join(root, 'helm.db'));
    cleanups.push(() => {
      try { dbs.close(); } catch {}
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    });
    return dbs;
  }

  it('loads separate Helm-issuance and AGJ-verification secrets plus the readonly AGJ DB path', () => {
    const before = {
      db: process.env.AGJASSIST_DB_PATH,
      agjSecret: process.env.AGJASSIST_JWT_SECRET,
      helmSecret: process.env.JWT_SECRET,
    };
    process.env.AGJASSIST_DB_PATH = '/tmp/agjassist-auth-only.db';
    process.env.AGJASSIST_JWT_SECRET = 'agj-verification-secret';
    process.env.JWT_SECRET = 'helm-issuance-secret';
    try {
      const cfg = loadConfig();
      expect(cfg.agjAssistDbPath).toBe('/tmp/agjassist-auth-only.db');
      expect(cfg.agjAssistJwtSecret).toBe('agj-verification-secret');
      expect(cfg.jwtSecret).toBe('helm-issuance-secret');

      process.env.JWT_SECRET = 'same-secret';
      process.env.AGJASSIST_JWT_SECRET = 'same-secret';
      expect(() => loadConfig()).toThrow(/must be different/);
    } finally {
      if (before.db === undefined) delete process.env.AGJASSIST_DB_PATH;
      else process.env.AGJASSIST_DB_PATH = before.db;
      if (before.agjSecret === undefined) delete process.env.AGJASSIST_JWT_SECRET;
      else process.env.AGJASSIST_JWT_SECRET = before.agjSecret;
      if (before.helmSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = before.helmSecret;
    }
  });

  it('constructs the full launch-path identity chain with the native Helm DB only', () => {
    const dbs = setup();
    const identity = new HelmIdentityService(dbs);
    const masterModels = new MasterModelService(dbs, identity);
    const events = new AgentEventsService(dbs);
    const assignment = new AgentAssignmentService(dbs);
    const resolver = new ProviderResolverService();
    const tmux = {
      createSession: async () => {},
      sendCommand: async () => true,
      killSession: async () => {},
      sessionExists: async () => true,
      sessionHasHelmChildTag: async () => true,
    };

    expect(() => new MasterRuntimeService(dbs, events, tmux as any, resolver, masterModels, undefined, assignment, undefined, undefined, identity)).not.toThrow();
    expect(() => new WorkerService(dbs, events, tmux as any, resolver, assignment, undefined, undefined, identity)).not.toThrow();
  });

  it('allows the AGJ handle only in config/index/AuthService while forbidding it in native runtime services', () => {
    const files = [
      'services/master-model-service.ts',
      'services/master-runtime-service.ts',
      'services/worker-service.ts',
      'services/helm-identity-service.ts',
      'services/run-ingest-service.ts',
      'services/ovm-tracking-read-service.ts',
    ];
    for (const rel of files) {
      const source = sourceOf(rel);
      expect(source, `${rel} must not construct/hold the AGJ auth DB handle`).not.toMatch(/\bagjDb\b/);
      expect(source, `${rel} must not reference AGJASSIST_DB_PATH`).not.toContain('AGJASSIST_DB_PATH');
    }

    const indexSource = sourceOf('index.ts');
    expect(indexSource).toContain('new Database(config.agjAssistDbPath, { readonly: true, fileMustExist: true })');
    expect(indexSource).toContain('new HelmIdentityService(db)');
    expect(indexSource).not.toMatch(/new HelmIdentityService\([^)]*agjDb/);
    expect(indexSource).toContain('config.agjAssistJwtSecret');
  });

  it('keeps the project identity boundary native-only by construction', () => {
    const idSource = sourceOf('services/helm-identity-service.ts');
    expect(idSource, 'HelmIdentityService must not hold an external/legacy db handle').not.toMatch(/externalDb/);
    expect(idSource, 'HelmIdentityService must not carry an external projects-parity row type').not.toMatch(/ExternalProjectRow/);
    expect(idSource, 'HelmIdentityService must expose no external parity states').not.toMatch(/ProjectParity/);
    expect(HelmIdentityService.length, 'HelmIdentityService constructor must take a single (native db) argument').toBe(1);

    const cutoverSource = sourceOf('scripts/ovm-cutover.ts');
    expect(cutoverSource, 'ovm-cutover must construct HelmIdentityService with a single (native) argument')
      .not.toMatch(/new HelmIdentityService\([^)]*,[^)]*\)/);
  });

  it('resolves native projects and fails closed without consulting AGJ auth data', () => {
    const dbs = setup();
    dbs.raw.prepare('INSERT INTO projects (id, name, directory) VALUES (?, ?, ?)').run(5, 'Cards', '/work/cards');
    const identity = new HelmIdentityService(dbs);
    expect(identity.resolveProject(5)).toMatchObject({
      source: 'helm', state: 'resolved', readiness: true, project: { id: 5, directory_name: 'cards' },
    });
    expect(identity.resolveProject(999)).toMatchObject({ source: 'none', state: 'missing', project: null });
  });
});

describe('O7.2 AC3/AC4 — the dry-run cutover gate VERIFIES the report hash (mandatory, not optional)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  // A fully-ready readiness fixture: one active native project matched 1:1 against the legacy
  // projects table, exactly one active native owner, an (empty) legacy overmind schema, and real
  // UI evidence — so the REAL checker seals ready=true and we prove the gate against a LIVE report
  // (no report/gate is mocked; the code under test is exercised end-to-end).
  function readyFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-o72-gate-'));
    const db = new DatabaseService(path.join(root, 'helm.db'));
    bootstrapNativeOwner(db.raw, OWNER_TELEGRAM_ID);
    db.raw.prepare('INSERT INTO projects (id, name, directory) VALUES (?, ?, ?)').run(11, 'Cards', '/work/cards');

    const legacy = new Database(':memory:');
    legacy.exec("CREATE TABLE projects (id INTEGER PRIMARY KEY, directory_name TEXT, status TEXT, active INTEGER)");
    legacy.prepare("INSERT INTO projects (id, directory_name, status, active) VALUES (?, ?, 'active', 1)").run(88, 'cards');
    legacy.exec('CREATE TABLE overmind_projects (id INTEGER PRIMARY KEY, slug TEXT, app_path TEXT)');
    legacy.exec('CREATE TABLE overmind_workflows (id INTEGER PRIMARY KEY, project_id INTEGER, status TEXT)');

    const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-o72-gate-ui-'));
    const shot = path.join(uiDir, '01-tracking-desktop.png');
    fs.writeFileSync(shot, 'fake-png-bytes');
    const uiEvidence = [{ label: 'tracking-desktop', path: shot }];

    const identity = new HelmIdentityService(db);
    const checker = new OvmCutoverReadinessChecker(db, identity, legacy);
    cleanups.push(() => {
      try { db.close(); } catch {}
      try { legacy.close(); } catch {}
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(uiDir, { recursive: true, force: true }); } catch {}
    });
    const report = checker.check({ uiEvidence, now: () => '2026-07-15T12:00:00.000Z' });
    return { db, report };
  }

  const stopClear = { ok: true, activeNativeRuns: 0, detail: 'no active native runs — stop condition clear' };

  it('REFUSES a ready report when --expect-hash is absent (this is the exact "optional gate" defect, now closed)', () => {
    const { report } = readyFixture();
    expect(report.ready).toBe(true);
    const gate = evaluateDryRunGate({ report, sealOk: verifyReportSeal(report), expectHash: null, stop: stopClear });
    expect(gate.ok).toBe(false);
    expect(gate.refusals.join(' ')).toMatch(/--expect-hash/);
  });

  it('REFUSES a stale/mismatched --expect-hash even on a ready report', () => {
    const { report } = readyFixture();
    const gate = evaluateDryRunGate({ report, sealOk: verifyReportSeal(report), expectHash: '0'.repeat(64), stop: stopClear });
    expect(gate.ok).toBe(false);
    expect(gate.refusals.join(' ')).toMatch(/STALE/);
  });

  it('PASSES only on the EXACT live report hash, a self-consistent seal, a ready report, and a clear stop condition', () => {
    const { db, report } = readyFixture();
    // The live active-run stop condition, computed against the REAL db (no active runs seeded).
    const stop = checkActiveRunStopCondition(db);
    const gate = evaluateDryRunGate({ report, sealOk: verifyReportSeal(report), expectHash: report.report_sha256, stop });
    expect(gate).toEqual({ ok: true, refusals: [] });
  });

  it('never passes a not-ready report even with the exact live hash (a hash match alone is not enough)', () => {
    // No legacy handle → parity not-configured + legacy-open-run unprovable → ready=false.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-o72-gate-nr-'));
    const db = new DatabaseService(path.join(root, 'helm.db'));
    bootstrapNativeOwner(db.raw, OWNER_TELEGRAM_ID);
    db.raw.prepare('INSERT INTO projects (id, name, directory) VALUES (?, ?, ?)').run(11, 'Cards', '/work/cards');
    const checker = new OvmCutoverReadinessChecker(db, new HelmIdentityService(db));
    cleanups.push(() => { try { db.close(); } catch {}; try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
    const report = checker.check({ uiEvidence: [] });
    expect(report.ready).toBe(false);
    const gate = evaluateDryRunGate({ report, sealOk: verifyReportSeal(report), expectHash: report.report_sha256, stop: stopClear });
    expect(gate.ok).toBe(false);
    expect(gate.refusals.join(' ')).toMatch(/not ready/);
  });
});
