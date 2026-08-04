/**
 * S08 — Durable handoff/CAS store (migration + repo). Never opens data/helm.db.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION } from './db/schema.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { RunArtifactService } from './services/run-artifact-service.js';
import {
  DiscoveryHandoffConflictError,
  DiscoveryHandoffService,
  hashHandoffCredential,
  mintHandoffCredential,
} from './services/discovery-handoff-service.js';

describe('S08 discovery_handoffs store', () => {
  let dir: string;
  let dbPath: string;
  let dbs: DatabaseService;
  let projects: ProjectService;
  let cycles: CycleService;
  let artifacts: RunArtifactService;
  let handoffs: DiscoveryHandoffService;
  let projectId: number;
  let cycleId: number;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-s08-'));
    dbPath = path.join(dir, 't.db');
    dbs = new DatabaseService(dbPath);
    projects = new ProjectService(dbs);
    cycles = new CycleService(dbs, projects);
    artifacts = new RunArtifactService(dbs);
    handoffs = new DiscoveryHandoffService(dbs);

    const p = projects.createProject({
      name: `s08-${Date.now()}`,
      directory: fs.mkdtempSync(path.join(os.tmpdir(), 'helm-s08-proj-')),
    });
    projectId = p.id;
    const c = await cycles.createCycle(projectId, 'S08 Cycle');
    cycleId = c.id;
  });

  afterEach(() => {
    try {
      dbs.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('test1: fresh schema has discovery_handoffs; raw token never stored', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(111);
    const ver = dbs.raw.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number };
    expect(ver.v).toBe(SCHEMA_VERSION);

    const tables = dbs.raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='discovery_handoffs'"
      )
      .all() as any[];
    expect(tables.length).toBe(1);

    const raw = mintHandoffCredential();
    const row = handoffs.createPending({
      projectId,
      cycleId,
      chatSessionId: 'sid-abc',
      agentId: null,
      rawCredential: raw,
      callbackRole: 'discovery',
      callbackStatus: 'NORTH-STAR-READY',
      manifestJson: JSON.stringify({ seats: 2 }),
      manifestDigest: 'deadbeef',
    });

    expect(row.state).toBe('pending');
    expect(row.credential_hash).toBe(hashHandoffCredential(raw));
    expect(row.credential_hash).not.toBe(raw);
    expect(row.manifest_digest).toBe('deadbeef');
    expect(row.planning_run_id).toBeNull();

    const dump = JSON.stringify(dbs.raw.prepare('SELECT * FROM discovery_handoffs').all());
    expect(dump).not.toContain(raw);
    expect(dump).toContain(row.credential_hash);
  });

  it('test1b: upgrade path v110→v111 creates table (parity)', () => {
    dbs.close();
    const rawDb = new Database(dbPath);
    rawDb.exec('DROP TABLE IF EXISTS discovery_handoffs');
    rawDb.prepare('UPDATE schema_version SET version = 110').run();
    rawDb.close();

    const upgraded = new DatabaseService(dbPath);
    const ver = upgraded.raw.prepare('SELECT MAX(version) v FROM schema_version').get() as {
      v: number;
    };
    expect(ver.v).toBe(SCHEMA_VERSION);
    const t = upgraded.raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='discovery_handoffs'"
      )
      .get();
    expect(t).toBeTruthy();
    upgraded.close();
    dbs = new DatabaseService(dbPath);
  });

  it('test2: pending→starting→started once; duplicate CAS zero rows', () => {
    const raw = mintHandoffCredential();
    const row = handoffs.createPending({
      projectId,
      cycleId,
      rawCredential: raw,
      callbackRole: 'discovery',
      callbackStatus: 'NORTH-STAR-READY',
      manifestDigest: 'abc123',
    });

    expect(handoffs.casTransition(row.id, 'pending', 'starting')).toBe(1);
    expect(handoffs.casTransition(row.id, 'pending', 'starting')).toBe(0);

    const runId = artifacts.createRun(projectId, 's08-batch', null, cycleId);
    expect(
      handoffs.casTransition(row.id, 'starting', 'started', { planningRunId: runId })
    ).toBe(1);
    expect(
      handoffs.casTransition(row.id, 'starting', 'started', { planningRunId: runId })
    ).toBe(0);

    const final = handoffs.getById(row.id)!;
    expect(final.state).toBe('started');
    expect(final.planning_run_id).toBe(runId);

    expect(handoffs.consumeCredential(row.id, raw)).toBe(true);
    expect(handoffs.consumeCredential(row.id, raw)).toBe(false);
  });

  it('test3: decline/quarantine retain reason without run id; fresh pending after decline', () => {
    const raw = mintHandoffCredential();
    const pending = handoffs.createPending({
      projectId,
      cycleId,
      rawCredential: raw,
      callbackRole: 'discovery',
      callbackStatus: 'NORTH-STAR-READY',
    });

    expect(handoffs.decline(pending.id, 'Not yet')).toBe(1);
    const declined = handoffs.getById(pending.id)!;
    expect(declined.state).toBe('declined');
    expect(declined.reason).toBe('Not yet');
    expect(declined.planning_run_id).toBeNull();
    expect(handoffs.getLive(cycleId)).toBeNull();

    const pending2 = handoffs.createPending({
      projectId,
      cycleId,
      rawCredential: mintHandoffCredential(),
      callbackRole: 'discovery',
      callbackStatus: 'NORTH-STAR-READY',
    });
    expect(pending2.state).toBe('pending');
    expect(pending2.id).not.toBe(pending.id);

    handoffs.decline(pending2.id, 'replace for quarantine test');
    const q = handoffs.quarantine({
      projectId,
      cycleId,
      callbackRole: 'north',
      callbackStatus: 'HANDOFF',
      reason: 'out-of-contract role north/HANDOFF',
    });
    expect(q.state).toBe('quarantined');
    expect(q.reason).toMatch(/out-of-contract/);
    expect(q.planning_run_id).toBeNull();
    expect(handoffs.getLive(cycleId)).toBeNull();

    const pending3 = handoffs.createPending({
      projectId,
      cycleId,
      rawCredential: mintHandoffCredential(),
    });
    expect(pending3.state).toBe('pending');

    expect(() =>
      handoffs.createPending({
        projectId,
        cycleId,
        rawCredential: mintHandoffCredential(),
      })
    ).toThrow(DiscoveryHandoffConflictError);
  });
});
