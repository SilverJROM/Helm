/**
 * fence-workflow-upgrade R4 — REPAIR routing (R5.4, R7.2).
 *
 * Covers: plan_defect / fault_class=plan skip implementer ladder; identical
 * driver-measured fingerprint twice → planner; missing verdict field fail-closed;
 * PLAN_SOUND requires what_validator_missed + units/tests or plan_level; bare
 * PLAN_SOUND refused (consumes a round); max 3 rounds incl PLAN_SOUND;
 * fingerprint history from append-only verdict/repair rows, never telemetry.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { beginFenceRepairRound } from './fence-repair-schema.js';
import { stampCompositionJudgment } from './fence-integration-agent-route.js';
import { persistFenceVerdict } from './fence-verdict.js';
import {
  countFenceRepairRounds,
  FENCE_PLAN_SOUND_EVENT_TYPE,
  FENCE_REPAIR_MAX_ROUNDS,
  loadFenceFingerprintHistory,
  parseRepairUnits,
  recordPlanSoundAttempt,
  routeFenceRepair,
  routeFenceRepairFromDb,
  validatePlanSound,
} from './fence-repair-routing.js';

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function insertProjectRun(db: DatabaseService): { projectId: number; runId: number } {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const projectId = (
    db.raw
      .prepare('INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id')
      .get(`fence-r4-${suffix}`, `/tmp/fence-r4-${suffix}`) as { id: number }
  ).id;
  const runId = (
    db.raw
      .prepare(
        "INSERT INTO runs (project_id, batch_id, north_star_ref, status, phase) VALUES (?, ?, ?, 'active', 'implementation') RETURNING id"
      )
      .get(projectId, 'R4', 'fence-repair-routing') as { id: number }
  ).id;
  return { projectId, runId };
}

function insertRepairFixture(db: DatabaseService): {
  runId: number;
  fenceId: number;
  taskIds: Record<string, number>;
} {
  const { runId } = insertProjectRun(db);
  const taskIds: Record<string, number> = {};
  for (const taskKey of ['A1', 'A2', 'A3']) {
    taskIds[taskKey] = Number(
      (
        db.raw
          .prepare(
            `INSERT INTO run_tasks (run_id, task_key, label, batch, status)
             VALUES (?, ?, ?, 'B1', 'complete') RETURNING id`
          )
          .get(runId, taskKey, `Task ${taskKey}`) as { id: number }
      ).id
    );
  }
  const fenceId = Number(
    (
      db.raw
        .prepare(
          `INSERT INTO fences (
             fence_key, run_id, lifecycle_state,
             integration_cmd, negative_control_cmd, acceptance_ids, test_path
           )
           VALUES ('I4', ?, 'closing', 'npm test', 'FENCE_STUB=R2 npm test', ?, ?)
           RETURNING id`
        )
        .get(
          runId,
          JSON.stringify(['R5.1', 'R5.4']),
          'src/services/fence-f4-repair.integration.test.ts'
        ) as { id: number }
    ).id
  );
  for (const [position, taskKey] of ['A1', 'A2', 'A3'].entries()) {
    db.raw
      .prepare('INSERT INTO fence_members (fence_id, task_key, position) VALUES (?, ?, ?)')
      .run(fenceId, taskKey, position);
  }
  return { runId, fenceId, taskIds };
}

function implVerdict(units: string[] = ['A1'], fingerprint = 'fp1:impl-a') {
  return stampCompositionJudgment(
    {
      fence: 'I4',
      verdict: 'FAIL',
      fault_class: 'implementation',
      failing_units: units,
      seam_fingerprint: fingerprint,
      plan_defect: false,
      note: 'localized composition failure',
    },
    'intagent-r4'
  );
}

function planVerdict(fingerprint = 'fp1:plan-a') {
  return stampCompositionJudgment(
    {
      fence: 'I4',
      verdict: 'FAIL',
      fault_class: 'plan',
      failing_units: [],
      seam_fingerprint: fingerprint,
      plan_defect: true,
      note: 'plan is broken at the seam',
    },
    'intagent-r4'
  );
}

describe('R4 fence-repair-routing pure rules (R5.4, R7.2)', () => {
  it('fault_class=plan / plan_defect skips the implementer ladder entirely', () => {
    const decision = routeFenceRepair({
      verdict: planVerdict(),
      fingerprintHistory: ['fp1:plan-a'],
      rounds: 0,
      fenceDeps: ['A1', 'A2', 'A3'],
    });
    expect(decision.action).toBe('RAISE');
    expect(decision.skip_ladder).toBe(true);
    expect(decision.plan_defect).toBe(true);
    expect(decision.fault_class).toBe('plan');
    expect(decision.units).toEqual([]);
  });

  it('identical driver-measured fingerprint twice routes to planner (same_seam)', () => {
    const decision = routeFenceRepair({
      verdict: implVerdict(['A1'], 'fp1:x'),
      fingerprintHistory: ['fp1:x', 'fp1:x'],
      rounds: 0,
      fenceDeps: ['A1', 'A2'],
    });
    expect(decision.action).toBe('RAISE');
    expect(decision.same_seam).toBe(true);
    expect(decision.skip_ladder).toBe(true);
    expect(decision.fault_class).toBe('plan');
    expect(decision.why).toMatch(/same seam failed twice/);
  });

  it('different consecutive fingerprints keep repairing (REQUEUE)', () => {
    const decision = routeFenceRepair({
      verdict: implVerdict(['A1'], 'fp1:y'),
      fingerprintHistory: ['fp1:x', 'fp1:y'],
      rounds: 0,
      fenceDeps: ['A1', 'A2'],
    });
    expect(decision.action).toBe('REQUEUE');
    expect(decision.skip_ladder).toBe(false);
    expect(decision.units).toEqual(['A1']);
    expect(decision.fault_class).toBe('implementation');
  });

  it('missing verdict fails closed — never "no defect"', () => {
    const decision = routeFenceRepair({
      verdict: null,
      fingerprintHistory: [],
      rounds: 0,
      fenceDeps: ['A1'],
    });
    expect(decision.action).toBe('RAISE');
    expect(decision.skip_ladder).toBe(true);
    expect(decision.plan_defect).toBe(true);
    expect(decision.why).toMatch(/no fence composition verdict/i);
  });

  it('missing required verdict field fails closed via C3 normalize (R7.2)', () => {
    const decision = routeFenceRepair({
      verdict: {
        // deliberately incomplete — no fault_class, no plan_defect, wrong schema
        fence: 'I4',
        verdict: 'FAIL',
        seam_fingerprint: 'fp1:missing-fields',
      },
      fingerprintHistory: ['fp1:missing-fields'],
      rounds: 0,
      fenceDeps: ['A1'],
    });
    expect(decision.action).toBe('RAISE');
    expect(decision.skip_ladder).toBe(true);
    expect(decision.plan_defect).toBe(true);
    expect(decision.fault_class).toBe('plan');
    expect(decision.verdict?.validation_errors?.length).toBeGreaterThan(0);
  });

  it('max 3 rounds incl PLAN_SOUND exhausts to planner', () => {
    expect(FENCE_REPAIR_MAX_ROUNDS).toBe(3);
    const decision = routeFenceRepair({
      verdict: implVerdict(['A2'], 'fp1:z'),
      fingerprintHistory: ['fp1:a', 'fp1:z'],
      rounds: 3,
      fenceDeps: ['A1', 'A2'],
    });
    expect(decision.action).toBe('RAISE');
    expect(decision.exhausted).toBe(true);
    expect(decision.skip_ladder).toBe(true);
    expect(decision.why).toMatch(/3 repair rounds exhausted/);
  });

  it('implementation with in-fence unit REQUEUEs on first round', () => {
    const decision = routeFenceRepair({
      verdict: implVerdict(['A1', 'A2'], 'fp1:first'),
      fingerprintHistory: ['fp1:first'],
      rounds: 0,
      fenceDeps: ['A1', 'A2', 'A3'],
    });
    expect(decision.action).toBe('REQUEUE');
    expect(decision.units).toEqual(['A1', 'A2']);
    expect(decision.skip_ladder).toBe(false);
  });

  it('naming a unit outside the fence fails closed (cannot route repair)', () => {
    const decision = routeFenceRepair({
      verdict: implVerdict(['U99'], 'fp1:out'),
      fingerprintHistory: ['fp1:out'],
      rounds: 0,
      fenceDeps: ['A1', 'A2'],
    });
    expect(decision.action).toBe('RAISE');
    expect(decision.skip_ladder).toBe(true);
    expect(decision.why).toMatch(/U99/);
    expect(decision.why).toMatch(/not contributors/);
  });

  it('parseRepairUnits accepts Tiller-style bracket lists', () => {
    expect(parseRepairUnits('[A1,A2]')).toEqual(['A1', 'A2']);
    expect(parseRepairUnits('A1 A2')).toEqual(['A1', 'A2']);
    expect(parseRepairUnits(['A1', 'A2'])).toEqual(['A1', 'A2']);
  });
});

describe('R4 PLAN_SOUND (R5.4)', () => {
  it('bare PLAN_SOUND is refused and consumes a round', () => {
    const r = validatePlanSound({ action: 'PLAN_SOUND' }, {});
    expect(r.ok).toBe(false);
    expect(r.accepted).toBe(false);
    expect(r.consumes_round).toBe(true);
    expect(r.error).toMatch(/what_validator_missed/);
  });

  it('PLAN_SOUND without what_validator_missed is refused', () => {
    const r = validatePlanSound(
      { action: 'PLAN_SOUND', units: 'A1' },
      { A1: { test_path: 't.ts' } }
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/what_validator_missed/);
  });

  it('PLAN_SOUND returning a unit with NO validator-authored test is refused', () => {
    const r = validatePlanSound(
      {
        action: 'PLAN_SOUND',
        what_validator_missed: 'validator misread the seam',
        units: 'A1',
      },
      {}
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/own success criterion/);
    expect(r.consumes_round).toBe(true);
  });

  it('PLAN_SOUND with validator-authored test is accepted and consumes a round', () => {
    const r = validatePlanSound(
      {
        action: 'PLAN_SOUND',
        what_validator_missed: 'validator missed the plan-level invariant',
        units: ['A1'],
      },
      { A1: { repair_test_path: 'src/services/a1-repair.test.ts', repair_test_hash: 'sha256:abc' } }
    );
    expect(r.ok).toBe(true);
    expect(r.accepted).toBe(true);
    expect(r.consumes_round).toBe(true);
    expect(r.units).toEqual(['A1']);
    expect(r.plan_level).toBe(false);
  });

  it('PLAN_SOUND declared plan-level owes no per-unit test', () => {
    const r = validatePlanSound(
      {
        action: 'PLAN_SOUND',
        what_validator_missed: 'composition is structural',
        plan_level_fingerprint: 'fp1:plan-level',
      },
      {}
    );
    expect(r.ok).toBe(true);
    expect(r.accepted).toBe(true);
    expect(r.plan_level).toBe(true);
    expect(r.consumes_round).toBe(true);
  });

  it('PLAN_SOUND with plan_level:true is accepted', () => {
    const r = validatePlanSound(
      {
        action: 'PLAN_SOUND',
        what_validator_missed: 'needs replan',
        plan_level: true,
      },
      {}
    );
    expect(r.ok).toBe(true);
    expect(r.plan_level).toBe(true);
  });

  it('non-PLAN_SOUND directions are untouched', () => {
    const r = validatePlanSound({ action: 'RETRY_WITH_DIRECTION' }, {});
    expect(r.ok).toBe(true);
    expect(r.accepted).toBe(false);
    expect(r.consumes_round).toBe(false);
  });
});

describe('R4 fingerprint history from append-only rows (never telemetry)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('loads history from fence_repair_rounds + composition verdict events only', () => {
    const { dir, cleanup } = tempDir('helm-fence-r4-hist-');
    cleanups.push(cleanup);
    const dbPath = path.join(dir, 'helm.db');
    const db = new DatabaseService(dbPath);
    cleanups.push(() => db.close());

    const { runId, fenceId } = insertRepairFixture(db);

    // Stage an implementation repair round with a driver-measured fingerprint.
    beginFenceRepairRound(db, {
      fenceId,
      faultClass: 'implementation',
      failingUnits: ['A1'],
      verdictFingerprint: 'fp1:round1',
    });

    // Persist a composition verdict (append-only run_event + artifact).
    persistFenceVerdict(db, {
      runId,
      batchId: 'R4',
      runDir: dir,
      verdict: implVerdict(['A2'], 'fp1:verdict2'),
    });

    // Poison a telemetry file that must NEVER be consulted for control state.
    const telemetryPath = path.join(dir, 'dispatch', 'telemetry.jsonl');
    fs.mkdirSync(path.dirname(telemetryPath), { recursive: true });
    fs.writeFileSync(
      telemetryPath,
      JSON.stringify({ seam_fingerprint: 'fp1:FROM-TELEMETRY-MUST-NOT-APPEAR' }) + '\n',
      'utf8'
    );

    const history = loadFenceFingerprintHistory(db, { fenceId });
    expect(history).toContain('fp1:round1');
    expect(history).toContain('fp1:verdict2');
    expect(history).not.toContain('fp1:FROM-TELEMETRY-MUST-NOT-APPEAR');

    // Even when a caller "helpfully" passes telemetryPath, routing ignores it.
    const decision = routeFenceRepairFromDb(db, {
      fenceId,
      verdict: implVerdict(['A1'], 'fp1:current'),
      currentFingerprint: 'fp1:current',
      telemetryPath,
    });
    expect(decision.fingerprint).not.toBe('fp1:FROM-TELEMETRY-MUST-NOT-APPEAR');
    // 1 impl round already staged → rounds >= 1; still under max.
    expect(decision.rounds).toBeGreaterThanOrEqual(1);
    expect(decision.action).toBe('REQUEUE');
  });

  it('same fingerprint twice via durable history triggers same_seam RAISE', () => {
    const { dir, cleanup } = tempDir('helm-fence-r4-same-');
    cleanups.push(cleanup);
    const dbPath = path.join(dir, 'helm.db');
    const db = new DatabaseService(dbPath);
    cleanups.push(() => db.close());

    const { runId, fenceId } = insertRepairFixture(db);

    beginFenceRepairRound(db, {
      fenceId,
      faultClass: 'implementation',
      failingUnits: ['A1'],
      verdictFingerprint: 'fp1:same',
    });
    persistFenceVerdict(db, {
      runId,
      batchId: 'R4',
      runDir: dir,
      verdict: implVerdict(['A1'], 'fp1:same'),
    });

    const history = loadFenceFingerprintHistory(db, { fenceId });
    // With round + matching verdict both measuring fp1:same, consecutive identical tails fire.
    expect(history.filter((h) => h === 'fp1:same').length).toBeGreaterThanOrEqual(2);

    const decision = routeFenceRepairFromDb(db, {
      fenceId,
      verdict: implVerdict(['A1'], 'fp1:same'),
      // no extra current — history already has the double
    });
    expect(decision.action).toBe('RAISE');
    expect(decision.same_seam).toBe(true);
    expect(decision.skip_ladder).toBe(true);
  });

  it('PLAN_SOUND attempts count toward the 3-round cap via append-only events', () => {
    const { dir, cleanup } = tempDir('helm-fence-r4-ps-');
    cleanups.push(cleanup);
    const dbPath = path.join(dir, 'helm.db');
    const db = new DatabaseService(dbPath);
    cleanups.push(() => db.close());

    const { runId, fenceId } = insertRepairFixture(db);
    const fenceKey = 'I4';

    // Three bare PLAN_SOUND attempts — each refused but each consumes a round.
    for (let i = 0; i < 3; i++) {
      const validation = validatePlanSound({ action: 'PLAN_SOUND' }, {});
      expect(validation.ok).toBe(false);
      expect(validation.consumes_round).toBe(true);
      recordPlanSoundAttempt(db, {
        runId,
        fence: fenceKey,
        direction: { action: 'PLAN_SOUND' },
        validation,
        batchId: 'R4',
      });
    }

    const rounds = countFenceRepairRounds(db, { fenceId });
    expect(rounds).toBe(3);

    // Event type is durable, not telemetry.
    const events = db.raw
      .prepare('SELECT event_type FROM run_events WHERE run_id = ? AND event_type = ?')
      .all(String(runId), FENCE_PLAN_SOUND_EVENT_TYPE) as Array<{ event_type: string }>;
    expect(events).toHaveLength(3);

    const decision = routeFenceRepairFromDb(db, {
      fenceId,
      verdict: implVerdict(['A1'], 'fp1:after-ps'),
      currentFingerprint: 'fp1:after-ps',
    });
    expect(decision.action).toBe('RAISE');
    expect(decision.exhausted).toBe(true);
    expect(decision.skip_ladder).toBe(true);
  });

  it('accepted plan-level PLAN_SOUND is recorded and counted', () => {
    const { dir, cleanup } = tempDir('helm-fence-r4-psok-');
    cleanups.push(cleanup);
    const dbPath = path.join(dir, 'helm.db');
    const db = new DatabaseService(dbPath);
    cleanups.push(() => db.close());

    const { runId, fenceId } = insertRepairFixture(db);
    const direction = {
      action: 'PLAN_SOUND',
      what_validator_missed: 'validator treated a plan defect as implementation',
      plan_level: true,
    };
    const validation = validatePlanSound(direction, {});
    expect(validation.accepted).toBe(true);

    const rec = recordPlanSoundAttempt(db, {
      runId,
      fence: 'I4',
      direction,
      validation,
    });
    expect(rec.rounds).toBe(1);
    expect(countFenceRepairRounds(db, { fenceId })).toBe(1);
  });
});
