/**
 * B19 — R5.22 Freeze complete. Cycle-start freeze store: composed project-effective topology,
 * fail-closed R3.16 revalidation (B18-fix1 carry-forward), immutability + writer exclusivity.
 * R8: no plumbing/routing-config edits in this batch.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION } from './db/schema.js';
import { ModelService } from './services/model-service.js';
import { RoleTierService } from './services/role-tier-service.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { InheritanceService } from './services/inheritance-service.js';
import { TopologyFreezeService } from './services/topology-freeze-service.js';

function tempDbPath(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, `helm-test-${process.pid}.db`);
  return {
    dbPath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

function modelIdsBySlug(ms: ModelService): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of ms.listModels()) {
    out[m.slug] = m.id;
  }
  return out;
}

/** Shared per-test rig: fresh DB + tmp project dir + the services under test. */
function setup(prefix: string) {
  const t = tempDbPath(prefix);
  process.env.HELM_DB_PATH = t.dbPath;
  const dbs = new DatabaseService(t.dbPath);
  const projects = new ProjectService(dbs);
  const cycles = new CycleService(dbs, projects);
  const inherit = new InheritanceService(dbs);
  const roleTiers = new RoleTierService(dbs);
  const models = new ModelService(dbs);
  const freezes = new TopologyFreezeService(dbs);
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}proj-`));
  return { t, dbs, projects, cycles, inherit, roleTiers, models, freezes, projDir, bySlug: modelIdsBySlug(models) };
}

describe('B19 freeze complete (R5.22)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('fresh DB lands SCHEMA_VERSION ≥71 with cycle_topology_freezes + immutability triggers', () => {
    const t = tempDbPath('helm-b19-fresh-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(71);

    const table = dbs.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='cycle_topology_freezes'`)
      .get();
    expect(table).toBeTruthy();

    const triggers = (
      dbs.raw
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='trigger'
           AND name IN ('trg_cycle_topology_freezes_no_update','trg_cycle_topology_freezes_no_delete')`
        )
        .all() as any[]
    ).map((r) => r.name);
    expect(triggers).toHaveLength(2);
    dbs.close();
  });

  it('v70→v71 migration creates cycle_topology_freezes', () => {
    const t = tempDbPath('helm-b19-mig-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const old = new Database(t.dbPath);
    old.exec(`
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
INSERT INTO schema_version (version) VALUES (70);
CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, directory TEXT NOT NULL);
CREATE TABLE cycles (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL);
`);
    old.close();

    const dbs = new DatabaseService(t.dbPath);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    expect(ver).toBeGreaterThanOrEqual(71);

    const table = dbs.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='cycle_topology_freezes'`)
      .get();
    expect(table).toBeTruthy();
    dbs.close();
  });

  it('cycle-start freeze stamps the project-effective topology at that instant', async () => {
    const { t, dbs, projects, cycles, inherit, roleTiers, projDir, bySlug } = setup('helm-b19-stamp-');
    cleanups.push(t.cleanup, () => fs.rmSync(projDir, { recursive: true, force: true }));

    const project = projects.createProject({ name: 'b19-stamp', directory: projDir });
    const cycle = await cycles.createCycle(project.id, 'C1', undefined, undefined, () => new Date('2026-07-10T12:00:00Z'));

    const studioImplL2 = roleTiers.getRoleTier('implementer', 'L2')!;
    const overridePrimary = bySlug['grokcompose'] ?? bySlug['spark'] ?? bySlug['haiku'];
    expect(overridePrimary).not.toBe(studioImplL2.primary_model_id);
    inherit.setProjectRoleTier(project.id, 'implementer', 'L2', { primary_model_id: overridePrimary });

    const preFreezeEffective = inherit.resolveForProject(project.id);

    cycles.setCyclePhase(cycle.id, 'implementation');

    const frozen = cycles.getEffectiveTopology(cycle.id);
    expect(frozen.role_tiers).toEqual(preFreezeEffective.role_tiers);
    expect(frozen.team_tiers).toEqual(preFreezeEffective.team_tiers);
    expect(frozen.cycle_id).toBe(cycle.id);

    dbs.close();
  });

  it('R5.22 proof: Studio edit after freeze does not change the running cycle; a new cycle sees it', async () => {
    const { t, dbs, projects, cycles, inherit, roleTiers, projDir, bySlug } = setup('helm-b19-proof-');
    cleanups.push(t.cleanup, () => fs.rmSync(projDir, { recursive: true, force: true }));

    const project = projects.createProject({ name: 'b19-proof', directory: projDir });
    const cycle = await cycles.createCycle(project.id, 'C1', undefined, undefined, () => new Date('2026-07-10T12:00:00Z'));

    const beforeStudioL1 = roleTiers.getRoleTier('implementer', 'L1')!;
    cycles.setCyclePhase(cycle.id, 'implementation');
    const frozenBefore = cycles.getEffectiveTopology(cycle.id);
    const frozenImplL1 = frozenBefore.role_tiers.find((r) => r.role === 'implementer' && r.tier === 'L1')!;
    expect(frozenImplL1.primary_model_id).toBe(beforeStudioL1.primary_model_id);

    // Change the Studio binding the running cycle inherited.
    const newPrimary = bySlug['spark'] ?? bySlug['haiku'];
    expect(newPrimary).toBeTruthy();
    if (newPrimary !== beforeStudioL1.primary_model_id) {
      roleTiers.updateRoleTier('implementer', 'L1', { primary_model_id: newPrimary });

      // Running cycle's stamp unchanged (R5.22 proof).
      const frozenAfter = cycles.getEffectiveTopology(cycle.id);
      const frozenImplL1After = frozenAfter.role_tiers.find((r) => r.role === 'implementer' && r.tier === 'L1')!;
      expect(frozenImplL1After.primary_model_id).toBe(beforeStudioL1.primary_model_id);

      // A fresh cycle in the same project sees the new Studio value (live, pre-freeze).
      const cycle2 = await cycles.createCycle(project.id, 'C2', undefined, undefined, () => new Date('2026-07-10T13:00:00Z'));
      const live = cycles.getEffectiveTopology(cycle2.id);
      const liveImplL1 = live.role_tiers.find((r) => r.role === 'implementer' && r.tier === 'L1')!;
      expect(liveImplL1.primary_model_id).toBe(newPrimary);
    }

    dbs.close();
  });

  it('freeze fails closed on an R3.16-violating composed topology and blocks the phase transition', async () => {
    const { t, dbs, projects, cycles, roleTiers, projDir, bySlug } = setup('helm-b19-failclosed-');
    cleanups.push(t.cleanup, () => fs.rmSync(projDir, { recursive: true, force: true }));

    const project = projects.createProject({ name: 'b19-failclosed', directory: projDir });
    const cycle = await cycles.createCycle(project.id, 'C1', undefined, undefined, () => new Date('2026-07-10T12:00:00Z'));

    // Simulate a pre-B19 bad state (legacy row, or a bug upstream of this batch) by writing the
    // colliding override directly with SQL, bypassing InheritanceService's own guards — freeze
    // must still catch it as the backstop.
    const studioVal = roleTiers.getRoleTier('validator', 'L2')!;
    dbs.raw
      .prepare(
        `INSERT INTO project_role_tiers (project_id, role, tier, primary_model_id, backup_model_id)
         VALUES (?, 'implementer', 'L2', NULL, ?)`
      )
      .run(project.id, studioVal.primary_model_id);

    expect(() => cycles.setCyclePhase(cycle.id, 'implementation')).toThrow(/role_tier invariant/i);

    const cycleRow = dbs.raw.prepare('SELECT phase FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(cycleRow.phase).toBe('discovery');

    const frozen = dbs.raw.prepare('SELECT 1 FROM cycle_topology_freezes WHERE cycle_id = ?').get(cycle.id);
    expect(frozen).toBeFalsy();

    dbs.close();
  });

  it('immutability: direct UPDATE/DELETE on cycle_topology_freezes throws', async () => {
    const { t, dbs, projects, cycles, projDir } = setup('helm-b19-immutable-');
    cleanups.push(t.cleanup, () => fs.rmSync(projDir, { recursive: true, force: true }));

    const project = projects.createProject({ name: 'b19-immutable', directory: projDir });
    const cycle = await cycles.createCycle(project.id, 'C1', undefined, undefined, () => new Date('2026-07-10T12:00:00Z'));
    cycles.setCyclePhase(cycle.id, 'implementation');

    expect(() =>
      dbs.raw.prepare(`UPDATE cycle_topology_freezes SET snapshot_json = '{}' WHERE cycle_id = ?`).run(cycle.id)
    ).toThrow(/immutable/i);
    expect(() =>
      dbs.raw.prepare(`DELETE FROM cycle_topology_freezes WHERE cycle_id = ?`).run(cycle.id)
    ).toThrow(/immutable/i);

    dbs.close();
  });

  it('writer exclusivity: freezing the same cycle twice throws CONFLICT', async () => {
    const { t, dbs, projects, cycles, freezes, projDir } = setup('helm-b19-exclusive-');
    cleanups.push(t.cleanup, () => fs.rmSync(projDir, { recursive: true, force: true }));

    const project = projects.createProject({ name: 'b19-exclusive', directory: projDir });
    const cycle = await cycles.createCycle(project.id, 'C1', undefined, undefined, () => new Date('2026-07-10T12:00:00Z'));
    cycles.setCyclePhase(cycle.id, 'implementation');

    expect(() => freezes.freezeForCycle(cycle.id)).toThrow(/already frozen/i);

    dbs.close();
  });

  it('gate-mode approveCycle also freezes (closes the raw-UPDATE bypass)', async () => {
    const { t, dbs, projects, cycles, projDir } = setup('helm-b19-gate-');
    cleanups.push(t.cleanup, () => fs.rmSync(projDir, { recursive: true, force: true }));

    const project = projects.createProject({ name: 'b19-gate', directory: projDir });
    projects.setAutonomyDefault(project.id, 'pause_after_planning');
    const cycle = await cycles.createCycle(project.id, 'C1', undefined, undefined, () => new Date('2026-07-10T12:00:00Z'));

    cycles.setCyclePhase(cycle.id, 'planning');
    cycles.finishPlanning(cycle.id);

    const beforeApprove = dbs.raw.prepare('SELECT 1 FROM cycle_topology_freezes WHERE cycle_id = ?').get(cycle.id);
    expect(beforeApprove).toBeFalsy();

    cycles.approveCycle(cycle.id);

    const afterApprove = dbs.raw.prepare('SELECT 1 FROM cycle_topology_freezes WHERE cycle_id = ?').get(cycle.id);
    expect(afterApprove).toBeTruthy();

    dbs.close();
  });

  it('B18-fix1 carry-forward: clearProjectRoleTier fails closed instead of resurrecting a colliding Studio value', async () => {
    // Exact shape from the validator's Finding 3 repro (B18-fix1-independent-validation.md):
    // studio impl/L2 backup = B, studio val/L2 primary = V. Override impl backup = X (legal, X≠V).
    // Override val primary = B (legal at write time: project-effective impl backup is X, not B).
    // Clearing the impl override reverts its backup to Studio's B — colliding with the still-
    // overridden val primary (also B). Old code silently resurrected the collision; must fail closed.
    const { t, dbs, projects, inherit, roleTiers, projDir, bySlug } = setup('helm-b19-clear-');
    cleanups.push(t.cleanup, () => fs.rmSync(projDir, { recursive: true, force: true }));

    const project = projects.createProject({ name: 'b19-clear', directory: projDir });

    const studioImpl = roleTiers.getRoleTier('implementer', 'L2')!;
    const studioVal = roleTiers.getRoleTier('validator', 'L2')!;
    const B = studioImpl.backup_model_id;
    expect(B).not.toBeNull();
    const X = bySlug['codex55'] ?? bySlug['codex54'] ?? bySlug['grokcompose'] ?? bySlug['spark'];
    expect(X).toBeTruthy();
    expect(X).not.toBe(B);
    expect(X).not.toBe(studioVal.primary_model_id);
    expect(X).not.toBe(studioVal.backup_model_id);

    inherit.setProjectRoleTier(project.id, 'implementer', 'L2', { backup_model_id: X });
    const setVal = inherit.setProjectRoleTier(project.id, 'validator', 'L2', { primary_model_id: B });
    expect(setVal.primary_model_id).toBe(B);

    // Pre-clear: composed effective is legal (impl backup=X, val primary=B, X≠B).
    const before = inherit.resolveForProject(project.id).role_tiers.find(
      (r) => r.role === 'implementer' && r.tier === 'L2'
    )!;
    expect(before.backup_model_id).toBe(X);

    // Clearing impl reverts its backup to Studio's B, colliding with val's still-overridden primary=B.
    expect(() => inherit.clearProjectRoleTier(project.id, 'implementer', 'L2')).toThrow(
      /role_tier invariant: backup must not equal/i
    );

    // Rolled back: impl override (backup=X) must still stand, not silently reverted to Studio.
    const after = inherit.resolveForProject(project.id).role_tiers.find(
      (r) => r.role === 'implementer' && r.tier === 'L2'
    )!;
    expect(after.source).toBe('project');
    expect(after.backup_model_id).toBe(X);

    dbs.close();
  });
});

describe('B19-fix1: cascade delete + walk-back re-entry', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('deleteProject succeeds when the project has a frozen cycle (F1 — FK CASCADE no longer blocked)', async () => {
    const { t, dbs, projects, cycles, projDir } = setup('helm-b19fix1-delete-');
    cleanups.push(t.cleanup, () => fs.rmSync(projDir, { recursive: true, force: true }));

    const project = projects.createProject({ name: 'b19fix1-delete', directory: projDir });
    const cycle = await cycles.createCycle(project.id, 'C1', undefined, undefined, () => new Date('2026-07-10T12:00:00Z'));
    cycles.setCyclePhase(cycle.id, 'implementation');

    const frozenBefore = dbs.raw.prepare('SELECT 1 FROM cycle_topology_freezes WHERE cycle_id = ?').get(cycle.id);
    expect(frozenBefore).toBeTruthy();

    expect(() => projects.deleteProject(project.id)).not.toThrow();

    const frozenAfter = dbs.raw.prepare('SELECT 1 FROM cycle_topology_freezes WHERE cycle_id = ?').get(cycle.id);
    expect(frozenAfter).toBeFalsy();
    const cycleAfter = dbs.raw.prepare('SELECT 1 FROM cycles WHERE id = ?').get(cycle.id);
    expect(cycleAfter).toBeFalsy();

    dbs.close();
  });

  it('a direct delete attempt while the parent cycle still exists still throws (immutability preserved)', async () => {
    const { t, dbs, projects, cycles, projDir } = setup('helm-b19fix1-direct-delete-');
    cleanups.push(t.cleanup, () => fs.rmSync(projDir, { recursive: true, force: true }));

    const project = projects.createProject({ name: 'b19fix1-direct-delete', directory: projDir });
    const cycle = await cycles.createCycle(project.id, 'C1', undefined, undefined, () => new Date('2026-07-10T12:00:00Z'));
    cycles.setCyclePhase(cycle.id, 'implementation');

    expect(() =>
      dbs.raw.prepare(`DELETE FROM cycle_topology_freezes WHERE cycle_id = ?`).run(cycle.id)
    ).toThrow(/immutable/i);

    dbs.close();
  });

  it('walk-back then re-enter implementation no-ops on the existing freeze instead of throwing CONFLICT (F2/F3)', async () => {
    const { t, dbs, projects, cycles, projDir } = setup('helm-b19fix1-walkback-');
    cleanups.push(t.cleanup, () => fs.rmSync(projDir, { recursive: true, force: true }));

    const project = projects.createProject({ name: 'b19fix1-walkback', directory: projDir });
    const cycle = await cycles.createCycle(project.id, 'C1', undefined, undefined, () => new Date('2026-07-10T12:00:00Z'));
    cycles.setCyclePhase(cycle.id, 'implementation');

    const original = dbs.raw
      .prepare('SELECT snapshot_json, frozen_at FROM cycle_topology_freezes WHERE cycle_id = ?')
      .get(cycle.id) as any;
    expect(original).toBeTruthy();

    // Walk back: phase forced directly to planning (simulating a coordinator/UI walk-back). The
    // freeze row is untouched (immutable) — only cycles.phase moves.
    dbs.raw.prepare(`UPDATE cycles SET phase = 'planning' WHERE id = ?`).run(cycle.id);

    // Re-enter implementation: previousPhase='planning' would (pre-fix1) fall outside
    // EXECUTION_PHASES and re-attempt freezeForCycle, throwing CONFLICT on the still-standing row.
    expect(() => cycles.setCyclePhase(cycle.id, 'implementation')).not.toThrow();

    const cycleRow = dbs.raw.prepare('SELECT phase FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(cycleRow.phase).toBe('implementation');

    // Freeze row is the original stamp, not re-frozen.
    const after = dbs.raw
      .prepare('SELECT snapshot_json, frozen_at FROM cycle_topology_freezes WHERE cycle_id = ?')
      .get(cycle.id) as any;
    expect(after.snapshot_json).toBe(original.snapshot_json);
    expect(after.frozen_at).toBe(original.frozen_at);

    dbs.close();
  });

  it('forward freeze still works: a fresh cycle freezes exactly once on first implementation entry', async () => {
    const { t, dbs, projects, cycles, projDir } = setup('helm-b19fix1-forward-');
    cleanups.push(t.cleanup, () => fs.rmSync(projDir, { recursive: true, force: true }));

    const project = projects.createProject({ name: 'b19fix1-forward', directory: projDir });
    const cycle = await cycles.createCycle(project.id, 'C1', undefined, undefined, () => new Date('2026-07-10T12:00:00Z'));

    const beforeFreeze = dbs.raw.prepare('SELECT 1 FROM cycle_topology_freezes WHERE cycle_id = ?').get(cycle.id);
    expect(beforeFreeze).toBeFalsy();

    cycles.setCyclePhase(cycle.id, 'implementation');

    const rows = dbs.raw.prepare('SELECT COUNT(*) AS c FROM cycle_topology_freezes WHERE cycle_id = ?').get(cycle.id) as any;
    expect(rows.c).toBe(1);

    dbs.close();
  });

  it('v71→v72 migration recreates the DELETE trigger keyed on the cascade-delete-allow flag', () => {
    const t = tempDbPath('helm-b19fix1-mig-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const old = new Database(t.dbPath);
    old.pragma('foreign_keys = ON');
    old.exec(`
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
INSERT INTO schema_version (version) VALUES (71);
CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, directory TEXT NOT NULL);
CREATE TABLE cycles (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE);
CREATE TABLE cycle_topology_freezes (
  id INTEGER PRIMARY KEY,
  cycle_id INTEGER NOT NULL UNIQUE REFERENCES cycles(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL,
  frozen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER trg_cycle_topology_freezes_no_delete
BEFORE DELETE ON cycle_topology_freezes
BEGIN
  SELECT RAISE(ABORT, 'topology freeze is immutable');
END;
`);
    old.close();

    const dbs = new DatabaseService(t.dbPath);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    expect(ver).toBeGreaterThanOrEqual(72);

    const trigSql = (
      dbs.raw
        .prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_cycle_topology_freezes_no_delete'`)
        .get() as any
    ).sql as string;
    expect(trigSql).toMatch(/_cascade_delete_allow/);

    dbs.close();
  });
});

describe('B19-fix2: phase-jump freeze + allow-flag durability', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('F3: a direct planning->final_tests jump (skipping implementation) still freezes', async () => {
    const { t, dbs, projects, cycles, projDir } = setup('helm-b19fix2-jump-');
    cleanups.push(t.cleanup, () => fs.rmSync(projDir, { recursive: true, force: true }));

    const project = projects.createProject({ name: 'b19fix2-jump', directory: projDir });
    const cycle = await cycles.createCycle(project.id, 'C1', undefined, undefined, () => new Date('2026-07-10T12:00:00Z'));

    cycles.setCyclePhase(cycle.id, 'planning');
    const beforeFreeze = dbs.raw.prepare('SELECT 1 FROM cycle_topology_freezes WHERE cycle_id = ?').get(cycle.id);
    expect(beforeFreeze).toBeFalsy();

    cycles.setCyclePhase(cycle.id, 'final_tests');

    const rows = dbs.raw.prepare('SELECT COUNT(*) AS c FROM cycle_topology_freezes WHERE cycle_id = ?').get(cycle.id) as any;
    expect(rows.c).toBe(1);

    dbs.close();
  });

  it('F5: withCascadeDeleteAllowed runs the flag set/clear inside one transaction (crash-durability proof)', () => {
    const t = tempDbPath('helm-b19fix2-txn-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);

    let sawInTransaction = false;
    dbs.withCascadeDeleteAllowed(() => {
      sawInTransaction = dbs.raw.inTransaction;
    });
    // Fails on the pre-fix implementation (three separate autocommit statements — inTransaction
    // is false inside fn), so this is a genuine mechanism proof, not a vacuous re-check.
    expect(sawInTransaction).toBe(true);

    // Flag row never outlives the call, same as before.
    const after = dbs.raw.prepare('SELECT COUNT(*) AS c FROM _cascade_delete_allow').get() as any;
    expect(after.c).toBe(0);

    dbs.close();
  });

  it('F5: a throw inside fn still rolls back and leaves the flag row absent', () => {
    const t = tempDbPath('helm-b19fix2-throw-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);

    expect(() =>
      dbs.withCascadeDeleteAllowed(() => {
        throw new Error('boom');
      })
    ).toThrow('boom');

    const after = dbs.raw.prepare('SELECT COUNT(*) AS c FROM _cascade_delete_allow').get() as any;
    expect(after.c).toBe(0);

    dbs.close();
  });
});
