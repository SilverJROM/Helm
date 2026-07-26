/**
 * B18 — R5.20–R5.21 Inheritance Studio→Project→Cycle.
 * Sparse project overrides for role_tiers + team_tiers; cycle inherits project effective.
 * No freeze (B19). R8: no plumbing/routing-config edits in this batch.
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
import { TeamService } from './services/team-service.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { InheritanceService } from './services/inheritance-service.js';

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

describe('B18 inheritance Studio→Project→Cycle (R5.20–R5.21)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('fresh DB lands SCHEMA_VERSION ≥70 with project override tables', () => {
    const t = tempDbPath('helm-b18-fresh-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(70);

    const tables = (
      dbs.raw
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table'
           AND name IN ('project_role_tiers','project_team_tiers','project_team_tier_models')`
        )
        .all() as any[]
    ).map((r) => r.name);
    expect(tables).toContain('project_role_tiers');
    expect(tables).toContain('project_team_tiers');
    expect(tables).toContain('project_team_tier_models');
    dbs.close();
  });

  it('v69→v70 migration creates project override tables', () => {
    const t = tempDbPath('helm-b18-mig-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const old = new Database(t.dbPath);
    old.exec(`
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
INSERT INTO schema_version (version) VALUES (69);
CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  directory TEXT NOT NULL
);
`);
    old.close();

    const dbs = new DatabaseService(t.dbPath);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    expect(ver).toBeGreaterThanOrEqual(70);

    const tables = (
      dbs.raw
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table'
           AND name IN ('project_role_tiers','project_team_tiers','project_team_tier_models')`
        )
        .all() as any[]
    ).map((r) => r.name);
    expect(tables).toContain('project_role_tiers');
    expect(tables).toContain('project_team_tiers');
    expect(tables).toContain('project_team_tier_models');
    dbs.close();
  });

  it('studio default: no project rows → project + cycle effective == studio (source studio)', async () => {
    const t = tempDbPath('helm-b18-default-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const projects = new ProjectService(dbs);
    const cycles = new CycleService(dbs, projects);
    const inherit = new InheritanceService(dbs);
    const roleTiers = new RoleTierService(dbs);
    const teamSvc = new TeamService(dbs);

    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b18-proj-'));
    cleanups.push(() => {
      try {
        fs.rmSync(projDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
    const project = projects.createProject({ name: 'b18-default', directory: projDir });
    const cycle = await cycles.createCycle(
      project.id,
      'C1',
      undefined,
      undefined,
      () => new Date('2026-07-10T12:00:00Z')
    );

    const studioRoles = roleTiers.listRoleTiers();
    const studioTeams = teamSvc.listTeamTiers();
    expect(studioRoles.length).toBeGreaterThan(0);
    expect(studioTeams.length).toBeGreaterThan(0);

    const projTopo = inherit.resolveForProject(project.id);
    const cycleTopo = cycles.getEffectiveTopology(cycle.id);

    expect(projTopo.role_tiers.every((r) => r.source === 'studio')).toBe(true);
    expect(projTopo.team_tiers.every((r) => r.source === 'studio')).toBe(true);
    expect(cycleTopo.cycle_id).toBe(cycle.id);
    expect(cycleTopo.project_id).toBe(project.id);

    for (const sr of studioRoles) {
      const er = projTopo.role_tiers.find((r) => r.role === sr.role && r.tier === sr.tier);
      expect(er, `${sr.role}/${sr.tier}`).toBeTruthy();
      expect(er!.primary_model_id).toBe(sr.primary_model_id);
      expect(er!.backup_model_id).toBe(sr.backup_model_id);
      expect(er!.source).toBe('studio');
    }

    // cycle equals project
    expect(cycleTopo.role_tiers).toEqual(projTopo.role_tiers);
    expect(cycleTopo.team_tiers).toEqual(projTopo.team_tiers);

    dbs.close();
  });

  it('project overrides Studio; cycle inherits project; clear reverts; live inherit for non-overridden seats', async () => {
    const t = tempDbPath('helm-b18-override-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const projects = new ProjectService(dbs);
    const cycles = new CycleService(dbs, projects);
    const inherit = new InheritanceService(dbs);
    const roleTiers = new RoleTierService(dbs);
    const models = new ModelService(dbs);
    const bySlug = modelIdsBySlug(models);

    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b18-ov-'));
    cleanups.push(() => {
      try {
        fs.rmSync(projDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
    const project = projects.createProject({ name: 'b18-override', directory: projDir });
    const cycle = await cycles.createCycle(
      project.id,
      'C-ov',
      undefined,
      undefined,
      () => new Date('2026-07-10T12:00:00Z')
    );

    const studioImplL2 = roleTiers.getRoleTier('implementer', 'L2');
    expect(studioImplL2).toBeTruthy();
    const studioL2Primary = studioImplL2!.primary_model_id;

    // Override implementer/L2 primary to grokcompose (different from studio default grok45)
    const overridePrimary = bySlug['grokcompose'] ?? bySlug['spark'] ?? bySlug['haiku'];
    expect(overridePrimary).toBeTruthy();
    expect(overridePrimary).not.toBe(studioL2Primary);

    const setRole = inherit.setProjectRoleTier(project.id, 'implementer', 'L2', {
      primary_model_id: overridePrimary,
      backup_model_id: studioImplL2!.backup_model_id,
    });
    expect(setRole.source).toBe('project');
    expect(setRole.primary_model_id).toBe(overridePrimary);

    // Larger red-team/standard roster (R5.21 example)
    const largerRoster = [
      bySlug['sonnet5'],
      bySlug['grok45'],
      bySlug['spark'],
      bySlug['haiku'],
      bySlug['opus4.8'],
    ].filter((id): id is number => id != null);
    expect(largerRoster.length).toBeGreaterThanOrEqual(3);

    const setTeam = inherit.setProjectTeamTierModels(
      project.id,
      'red-team',
      'standard',
      largerRoster
    );
    expect(setTeam.source).toBe('project');
    expect(setTeam.models.map((m) => m.model_id)).toEqual(largerRoster);

    const projTopo = inherit.resolveForProject(project.id);
    const cycleTopo = inherit.resolveForCycle(cycle.id);

    const implL2 = projTopo.role_tiers.find(
      (r) => r.role === 'implementer' && r.tier === 'L2'
    )!;
    expect(implL2.source).toBe('project');
    expect(implL2.primary_model_id).toBe(overridePrimary);

    // Untouched seat still studio
    const implL1 = projTopo.role_tiers.find(
      (r) => r.role === 'implementer' && r.tier === 'L1'
    )!;
    expect(implL1.source).toBe('studio');

    const rtStd = projTopo.team_tiers.find(
      (t) => t.team_type === 'red-team' && t.tier === 'standard'
    )!;
    expect(rtStd.source).toBe('project');
    expect(rtStd.models).toHaveLength(largerRoster.length);

    // Cycle inherits project (R5.21)
    expect(cycleTopo.role_tiers).toEqual(projTopo.role_tiers);
    expect(cycleTopo.team_tiers).toEqual(projTopo.team_tiers);
    expect(cycles.getEffectiveTopology(cycle.id).role_tiers).toEqual(projTopo.role_tiers);

    // Studio mutation of overridden seat does NOT flow through
    const studioL2Before = roleTiers.getRoleTier('implementer', 'L2')!;
    roleTiers.updateRoleTier('implementer', 'L2', {
      primary_model_id: bySlug['haiku'] ?? studioL2Before.primary_model_id,
    });
    const afterStudioChange = inherit.resolveForProject(project.id);
    const implL2After = afterStudioChange.role_tiers.find(
      (r) => r.role === 'implementer' && r.tier === 'L2'
    )!;
    expect(implL2After.source).toBe('project');
    expect(implL2After.primary_model_id).toBe(overridePrimary); // still project override

    // Studio mutation of inherited seat DOES flow through
    const l1Before = afterStudioChange.role_tiers.find(
      (r) => r.role === 'implementer' && r.tier === 'L1'
    )!;
    const newL1Primary = bySlug['spark'] ?? bySlug['haiku'];
    expect(newL1Primary).toBeTruthy();
    if (newL1Primary !== l1Before.primary_model_id) {
      roleTiers.updateRoleTier('implementer', 'L1', { primary_model_id: newL1Primary });
      const afterL1 = inherit.resolveForProject(project.id);
      const implL1After = afterL1.role_tiers.find(
        (r) => r.role === 'implementer' && r.tier === 'L1'
      )!;
      expect(implL1After.source).toBe('studio');
      expect(implL1After.primary_model_id).toBe(newL1Primary);
      const cycleL1 = inherit.resolveForCycle(cycle.id).role_tiers.find(
        (r) => r.role === 'implementer' && r.tier === 'L1'
      )!;
      expect(cycleL1.primary_model_id).toBe(newL1Primary);
    }

    // Clear override → re-inherit studio
    inherit.clearProjectRoleTier(project.id, 'implementer', 'L2');
    inherit.clearProjectTeamTier(project.id, 'red-team', 'standard');
    const cleared = inherit.resolveForProject(project.id);
    const implL2Cleared = cleared.role_tiers.find(
      (r) => r.role === 'implementer' && r.tier === 'L2'
    )!;
    expect(implL2Cleared.source).toBe('studio');
    // studio L2 was mutated to haiku above
    const studioL2Now = roleTiers.getRoleTier('implementer', 'L2')!;
    expect(implL2Cleared.primary_model_id).toBe(studioL2Now.primary_model_id);

    const rtStdCleared = cleared.team_tiers.find(
      (t) => t.team_type === 'red-team' && t.tier === 'standard'
    )!;
    expect(rtStdCleared.source).toBe('studio');

    dbs.close();
  });

  it('B13 backup_rule: composed project overrides rejected against project-effective peer', async () => {
    const t = tempDbPath('helm-b18-fix1-peer-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const projects = new ProjectService(dbs);
    const inherit = new InheritanceService(dbs);
    const roleTiers = new RoleTierService(dbs);
    const models = new ModelService(dbs);
    const bySlug = modelIdsBySlug(models);

    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b18-fix1-peer-proj-'));
    cleanups.push(() => {
      try {
        fs.rmSync(projDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
    const project = projects.createProject({ name: 'b18-fix1-peer', directory: projDir });

    const studioImpl = roleTiers.getRoleTier('implementer', 'L2')!;
    const studioVal = roleTiers.getRoleTier('validator', 'L2')!;
    // X must be distinct from studio impl backup and studio val primary so each write
    // would pass studio-only peer checks but fail once the other override exists.
    const X =
      bySlug['codex55'] ??
      bySlug['codex54'] ??
      bySlug['grokcompose'] ??
      bySlug['spark'];
    expect(X).toBeTruthy();
    expect(X).not.toBe(studioImpl.backup_model_id);
    expect(X).not.toBe(studioVal.primary_model_id);
    expect(X).not.toBe(studioVal.backup_model_id);

    // Order A: override val primary first, then impl backup → second must throw
    inherit.setProjectRoleTier(project.id, 'validator', 'L2', {
      primary_model_id: X,
    });
    expect(() =>
      inherit.setProjectRoleTier(project.id, 'implementer', 'L2', {
        backup_model_id: X,
      })
    ).toThrow(/role_tier invariant: backup must not equal/i);

    // Effective must not hold the illegal composition
    const afterA = inherit.resolveForProject(project.id);
    const implAfterA = afterA.role_tiers.find(
      (r) => r.role === 'implementer' && r.tier === 'L2'
    )!;
    expect(implAfterA.backup_model_id).not.toBe(X);
    expect(implAfterA.source).toBe('studio'); // impl write rejected; still studio

    // Reset project overrides; Order B: impl backup first, then val primary → throw
    inherit.clearProjectRoleTier(project.id, 'validator', 'L2');
    inherit.setProjectRoleTier(project.id, 'implementer', 'L2', {
      backup_model_id: X,
    });
    expect(() =>
      inherit.setProjectRoleTier(project.id, 'validator', 'L2', {
        primary_model_id: X,
      })
    ).toThrow(/role_tier invariant: backup must not equal/i);

    const afterB = inherit.resolveForProject(project.id);
    const valAfterB = afterB.role_tiers.find(
      (r) => r.role === 'validator' && r.tier === 'L2'
    )!;
    expect(valAfterB.primary_model_id).not.toBe(X);
    expect(valAfterB.source).toBe('studio');

    dbs.close();
  });

  it('explicit project null backup survives partial primary update', async () => {
    const t = tempDbPath('helm-b18-fix1-null-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const projects = new ProjectService(dbs);
    const inherit = new InheritanceService(dbs);
    const roleTiers = new RoleTierService(dbs);
    const models = new ModelService(dbs);
    const bySlug = modelIdsBySlug(models);

    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b18-fix1-null-proj-'));
    cleanups.push(() => {
      try {
        fs.rmSync(projDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
    const project = projects.createProject({ name: 'b18-fix1-null', directory: projDir });

    const studioImpl = roleTiers.getRoleTier('implementer', 'L2')!;
    expect(studioImpl.backup_model_id).not.toBeNull(); // studio has a backup to resurrect if broken

    const primaryA = bySlug['grok45'] ?? studioImpl.primary_model_id!;
    const primaryB =
      bySlug['grokcompose'] ??
      bySlug['spark'] ??
      bySlug['haiku'] ??
      primaryA;
    expect(primaryB).toBeTruthy();

    const setNull = inherit.setProjectRoleTier(project.id, 'implementer', 'L2', {
      primary_model_id: primaryA,
      backup_model_id: null,
    });
    expect(setNull.source).toBe('project');
    expect(setNull.backup_model_id).toBeNull();

    // Partial update: only primary changes; explicit null backup must round-trip
    const partial = inherit.setProjectRoleTier(project.id, 'implementer', 'L2', {
      primary_model_id: primaryB,
    });
    expect(partial.source).toBe('project');
    expect(partial.primary_model_id).toBe(primaryB);
    expect(partial.backup_model_id).toBeNull();
    expect(partial.backup_model_id).not.toBe(studioImpl.backup_model_id);

    const resolved = inherit.resolveForProject(project.id).role_tiers.find(
      (r) => r.role === 'implementer' && r.tier === 'L2'
    )!;
    expect(resolved.backup_model_id).toBeNull();
    expect(resolved.source).toBe('project');

    dbs.close();
  });
});
