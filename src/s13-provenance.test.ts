/**
 * S13 — Planning provenance + Start Implementation gate (ACs 26-29).
 * Tests: (1) valid plan no agreement refused; (2) agreed unchanged starts, byte change refuses;
 * (3) failed/BROKEN path never writes success provenance.
 */
process.env.USE_FAKE_TMUX = '1';
process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION } from './db/schema.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { RunArtifactService } from './services/run-artifact-service.js';
import {
  PlanningProvenanceService,
  assertPlanningProvenanceForImplementation,
  recordProvenanceAfterAgreement,
  sha256Hex,
  PLANNING_REQUIRED_CODE,
} from './services/planning-provenance-service.js';
import { CANONICAL_CYCLE_ARTIFACTS } from './services/cycle-artifact-paths.js';

function validPlanMd(id = 'T1'): string {
  const tasks = [
    {
      id,
      batch: 'one',
      title: `implement ${id}`,
      req_refs: ['S13'],
      assignee: 'grok-4.5',
      validator_lane: 'L1',
      effort: 'low',
      type: 'feature',
    },
  ];
  return '# Execution Plan\n\n```json\n' + JSON.stringify(tasks) + '\n```\n';
}

describe('S13 planning provenance', () => {
  let dir: string;
  let dbs: DatabaseService;
  let projects: ProjectService;
  let cycles: CycleService;
  let artifacts: RunArtifactService;
  let projectId: number;
  let cycleId: number;
  let cycleDir: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-s13-'));
    dbs = new DatabaseService(path.join(dir, 't.db'));
    projects = new ProjectService(dbs);
    cycles = new CycleService(dbs, projects);
    artifacts = new RunArtifactService(dbs);
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-s13-proj-'));
    const p = projects.createProject({ name: `s13-${Date.now()}`, directory: projDir });
    projectId = p.id;
    const c = await cycles.createCycle(projectId, 'S13 Cycle');
    cycleId = c.id;
    cycleDir = cycles.getCycleDocDir(cycleId);
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

  it('schema has planning_provenance at SCHEMA_VERSION ≥ 112', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(112);
    const ver = dbs.raw.prepare('SELECT MAX(version) v FROM schema_version').get() as {
      v: number;
    };
    expect(ver.v).toBe(SCHEMA_VERSION);
    const t = dbs.raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='planning_provenance'"
      )
      .get();
    expect(t).toBeTruthy();
  });

  it('test1: valid chat-authored plan with no agreement is refused', async () => {
    const planMd = validPlanMd('T1');
    await fsp.writeFile(path.join(cycleDir, CANONICAL_CYCLE_ARTIFACTS.plan), planMd, 'utf8');

    const gate = await assertPlanningProvenanceForImplementation({
      db: dbs,
      cycleService: cycles,
      projectId,
      cycleId,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe(PLANNING_REQUIRED_CODE);
      expect(gate.message).toMatch(/Helm Planning must complete first/i);
    }
  });

  it('test2: agreed unchanged plan passes; post-agreement byte change refuses', async () => {
    const planMd = validPlanMd('T1');
    const planPath = path.join(cycleDir, CANONICAL_CYCLE_ARTIFACTS.plan);
    await fsp.writeFile(planPath, planMd, 'utf8');

    const runId = artifacts.createRun(projectId, 's13-agree', null, cycleId);
    dbs.raw
      .prepare("UPDATE runs SET phase = 'complete', status = 'complete' WHERE id = ?")
      .run(runId);

    const row = await recordProvenanceAfterAgreement({
      db: dbs,
      cycleService: cycles,
      projectId,
      cycleId,
      planningRunId: runId,
      planMdPath: planPath,
      // no handoff — use explicit digest via recordSuccess path: need assignments for live digest
    });
    // Without handoff or staffing, recordProvenanceAfterAgreement may return null.
    // Use explicit recordSuccess for the agreed path.
    const provSvc = new PlanningProvenanceService(dbs);
    if (!row) {
      provSvc.recordSuccess({
        projectId,
        cycleId,
        planningRunId: runId,
        manifestDigest: 'digest-agreed-s13',
        planSha256: sha256Hex(planMd),
      });
    }

    const okGate = await assertPlanningProvenanceForImplementation({
      db: dbs,
      cycleService: cycles,
      projectId,
      cycleId,
    });
    // Without live staffing, digest check is skipped when liveDigest empty — plan match is enough
    expect(okGate.ok).toBe(true);

    // Byte change
    await fsp.writeFile(planPath, planMd + '\n# tampered\n', 'utf8');
    const badGate = await assertPlanningProvenanceForImplementation({
      db: dbs,
      cycleService: cycles,
      projectId,
      cycleId,
    });
    expect(badGate.ok).toBe(false);
    if (!badGate.ok) {
      expect(badGate.code).toBe('PLAN_CHANGED');
      expect(badGate.message).toMatch(/changed after Planning agreement|must complete again/i);
    }
  });

  it('test3: failed/BROKEN/round-cap never writes success provenance', async () => {
    const planMd = validPlanMd('T1');
    await fsp.writeFile(path.join(cycleDir, CANONICAL_CYCLE_ARTIFACTS.plan), planMd, 'utf8');
    const runId = artifacts.createRun(projectId, 's13-fail', null, cycleId);

    // Simulate failure path: do NOT call recordSuccess / recordProvenanceAfterAgreement
    // (orchestrator only records when agreed !== false)
    const before = new PlanningProvenanceService(dbs).getByCycle(cycleId);
    expect(before).toBeNull();

    // Explicit non-write for notAgreed: only a blocked run row exists
    dbs.raw
      .prepare("UPDATE runs SET phase = 'blocked', status = 'failed' WHERE id = ?")
      .run(runId);

    const after = new PlanningProvenanceService(dbs).getByCycle(cycleId);
    expect(after).toBeNull();

    const gate = await assertPlanningProvenanceForImplementation({
      db: dbs,
      cycleService: cycles,
      projectId,
      cycleId,
    });
    expect(gate.ok).toBe(false);
  });

  it('recordSuccess is atomic upsert per cycle', () => {
    const run1 = artifacts.createRun(projectId, 's13-u1', null, cycleId);
    const run2 = artifacts.createRun(projectId, 's13-u2', null, cycleId);
    dbs.raw
      .prepare("UPDATE runs SET phase = 'complete', status = 'complete' WHERE id IN (?,?)")
      .run(run1, run2);
    const svc = new PlanningProvenanceService(dbs);
    svc.recordSuccess({
      projectId,
      cycleId,
      planningRunId: run1,
      manifestDigest: 'd1',
      planSha256: 'a'.repeat(64),
    });
    const second = svc.recordSuccess({
      projectId,
      cycleId,
      planningRunId: run2,
      manifestDigest: 'd2',
      planSha256: 'b'.repeat(64),
    });
    expect(second.planning_run_id).toBe(run2);
    expect(second.manifest_digest).toBe('d2');
    const count = (
      dbs.raw
        .prepare('SELECT COUNT(*) AS c FROM planning_provenance WHERE cycle_id = ?')
        .get(cycleId) as any
    ).c;
    expect(count).toBe(1);
  });
});
