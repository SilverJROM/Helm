/**
 * B8a — opt-in project role roster override + unbind (AC-12, AC-12b).
 * Regression gate: no-override resolveProjectRole is byte-identical to today's team-binding path.
 * Backend only.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION } from './db/schema.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { TeamService } from './services/team-service.js';
import { ProjectService } from './services/project-service.js';

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

describe('B8a project role roster override (AC-12)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('fresh DB: SCHEMA_VERSION ≥97; project_role_roster_members table present empty', () => {
    const t = tempDbPath('helm-b8a-fresh-');
    cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(97);

    const createSql = (
      dbs.raw
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name='project_role_roster_members'`
        )
        .get() as any
    )?.sql as string;
    expect(createSql).toBeTruthy();
    expect(createSql).toMatch(/CHECK\(role IN \('deliberation','red-team'\)\)/);
    expect(createSql).toMatch(/UNIQUE\(project_id, role, position\)/);

    const count = (
      dbs.raw.prepare('SELECT COUNT(*) AS c FROM project_role_roster_members').get() as any
    ).c;
    expect(count).toBe(0);
    dbs.close();
  });

  it('v96→v97 migration: creates table; empty = no behavior change; idempotent re-open', () => {
    const t = tempDbPath('helm-b8a-mig-');
    cleanups.push(t.cleanup);

    // Minimal pre-v97 DB stamped at 96 without the new table
    const raw = new Database(t.dbPath);
    raw.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (96);
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        directory TEXT
      );
      CREATE TABLE models (
        id INTEGER PRIMARY KEY,
        name TEXT,
        provider TEXT,
        model_id TEXT,
        cli TEXT,
        slug TEXT,
        display_name TEXT
      );
      CREATE TABLE teams (
        id INTEGER PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL
      );
      CREATE TABLE team_members (
        id INTEGER PRIMARY KEY,
        team_id INTEGER NOT NULL,
        model_id INTEGER NOT NULL,
        lens TEXT,
        position INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE role_team_bindings (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        team_id INTEGER NOT NULL,
        UNIQUE(project_id, role)
      );
    `);
    raw.close();

    const dbs = new DatabaseService(t.dbPath);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(97);

    const tbl = dbs.raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='project_role_roster_members'`
      )
      .get();
    expect(tbl).toBeTruthy();
    expect(
      (dbs.raw.prepare('SELECT COUNT(*) AS c FROM project_role_roster_members').get() as any).c
    ).toBe(0);

    dbs.close();
    const dbs2 = new DatabaseService(t.dbPath);
    expect((dbs2.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
      SCHEMA_VERSION
    );
    dbs2.close();
  });

  it('REGRESSION: binding + NO override → resolveProjectRole is project-team-binding (byte-identical shape)', () => {
    const t = tempDbPath('helm-b8a-reg-');
    cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    const teams = new TeamService(dbs);
    const projects = new ProjectService(dbs);

    const models = dbs.raw
      .prepare('SELECT id, model_id, provider FROM models LIMIT 2')
      .all() as any[];
    expect(models.length).toBeGreaterThanOrEqual(2);

    // Ensure models valid for team membership
    for (const m of models) {
      dbs.raw.prepare("UPDATE models SET validation_status='valid' WHERE id=?").run(m.id);
    }

    const team = teams.createTeam({ name: `b8a-delib-${Date.now()}`, type: 'deliberation' });
    teams.addMember(team.id, { model_id: models[0].id, position: 0, lens: 'architect' });
    teams.addMember(team.id, { model_id: models[1].id, position: 1, lens: 'skeptic' });

    const proj = projects.createProject({
      name: `b8a-reg-${Date.now()}`,
      directory: `/tmp/b8a-reg-${Date.now()}`,
    });
    as.setProjectTeamBinding(proj.id, 'deliberation', team.id);

    // Zero override rows (default)
    expect(
      (
        dbs.raw
          .prepare(
            'SELECT COUNT(*) AS c FROM project_role_roster_members WHERE project_id=? AND role=?'
          )
          .get(proj.id, 'deliberation') as any
      ).c
    ).toBe(0);

    const res = as.resolveProjectRole(proj.id, 'deliberation');
    expect(res).toEqual({
      source: 'project-team-binding',
      team_id: team.id,
      roster: [
        {
          position: 0,
          lens: 'architect',
          model: models[0].model_id,
          provider: models[0].provider,
          model_id: models[0].id,
        },
        {
          position: 1,
          lens: 'skeptic',
          model: models[1].model_id,
          provider: models[1].provider,
          model_id: models[1].id,
        },
      ],
    });
    // No extra keys (byte-identical shape vs today)
    expect(Object.keys(res).sort()).toEqual(['roster', 'source', 'team_id'].sort());
    expect(res.roster[0]).not.toHaveProperty('source');

    // getEffectiveRoleRoster reports studio when no override
    const eff = as.getEffectiveRoleRoster(proj.id, 'deliberation');
    expect(eff.source).toBe('studio');
    expect(eff.team_id).toBe(team.id);
    expect(eff.members).toEqual(res.roster);

    dbs.close();
  });

  it('override present → resolveProjectRole returns project-roster-override (not team binding)', () => {
    const t = tempDbPath('helm-b8a-ov-');
    cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    const teams = new TeamService(dbs);
    const projects = new ProjectService(dbs);

    const models = dbs.raw
      .prepare('SELECT id, model_id, provider FROM models LIMIT 3')
      .all() as any[];
    expect(models.length).toBeGreaterThanOrEqual(3);
    for (const m of models) {
      dbs.raw.prepare("UPDATE models SET validation_status='valid' WHERE id=?").run(m.id);
    }

    const team = teams.createTeam({ name: `b8a-team-${Date.now()}`, type: 'deliberation' });
    teams.addMember(team.id, { model_id: models[0].id, position: 0 });
    teams.addMember(team.id, { model_id: models[1].id, position: 1 });

    const proj = projects.createProject({
      name: `b8a-ov-${Date.now()}`,
      directory: `/tmp/b8a-ov-${Date.now()}`,
    });
    as.setProjectTeamBinding(proj.id, 'deliberation', team.id);

    // Override with a different single model + lens
    const set = as.setProjectRoleRoster(proj.id, 'deliberation', [
      { model_id: models[2].id, lens: 'override-lens' },
    ]);
    expect(set.source).toBe('project');
    expect(set.members).toHaveLength(1);
    expect(set.members[0].model_id).toBe(models[2].id);
    expect(set.members[0].lens).toBe('override-lens');

    const res = as.resolveProjectRole(proj.id, 'deliberation');
    expect(res.source).toBe('project-roster-override');
    expect(res.team_id).toBeUndefined();
    expect(res.roster).toEqual([
      {
        position: 0,
        lens: 'override-lens',
        model: models[2].model_id,
        provider: models[2].provider,
        model_id: models[2].id,
      },
    ]);
    expect(Object.keys(res).sort()).toEqual(['roster', 'source'].sort());

    dbs.close();
  });

  it('setProjectRoleRoster full-replace; reset clears → resolver falls back to studio', () => {
    const t = tempDbPath('helm-b8a-set-');
    cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    const teams = new TeamService(dbs);
    const projects = new ProjectService(dbs);

    const models = dbs.raw
      .prepare('SELECT id, model_id, provider FROM models LIMIT 3')
      .all() as any[];
    expect(models.length).toBeGreaterThanOrEqual(3);
    for (const m of models) {
      dbs.raw.prepare("UPDATE models SET validation_status='valid' WHERE id=?").run(m.id);
    }

    const team = teams.createTeam({ name: `b8a-set-${Date.now()}`, type: 'red-team' });
    teams.addMember(team.id, { model_id: models[0].id, position: 0 });
    const proj = projects.createProject({
      name: `b8a-set-${Date.now()}`,
      directory: `/tmp/b8a-set-${Date.now()}`,
    });
    as.setProjectTeamBinding(proj.id, 'red-team', team.id);

    as.setProjectRoleRoster(proj.id, 'red-team', [
      { model_id: models[1].id, lens: 'a' },
      { model_id: models[2].id },
    ]);
    let res = as.resolveProjectRole(proj.id, 'red-team');
    expect(res.source).toBe('project-roster-override');
    expect(res.roster).toHaveLength(2);
    expect(res.roster[0].lens).toBe('a');
    expect(res.roster[1].lens).toBeNull();

    // Full replace shrinks roster
    as.setProjectRoleRoster(proj.id, 'red-team', [{ model_id: models[2].id, lens: 'only' }]);
    res = as.resolveProjectRole(proj.id, 'red-team');
    expect(res.roster).toHaveLength(1);
    expect(res.roster[0].model_id).toBe(models[2].id);

    // Reset → studio team binding path
    const afterReset = as.resetProjectRoleRoster(proj.id, 'red-team');
    expect(afterReset.source).toBe('studio');
    expect(afterReset.team_id).toBe(team.id);
    expect(afterReset.members[0].model_id).toBe(models[0].id);

    res = as.resolveProjectRole(proj.id, 'red-team');
    expect(res).toEqual({
      source: 'project-team-binding',
      team_id: team.id,
      roster: [
        {
          position: 0,
          lens: null,
          model: models[0].model_id,
          provider: models[0].provider,
          model_id: models[0].id,
        },
      ],
    });

    dbs.close();
  });

  it('unbindProjectTeam removes binding; after unbind + no override, resolve falls to base path', () => {
    const t = tempDbPath('helm-b8a-unbind-');
    cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    const teams = new TeamService(dbs);
    const projects = new ProjectService(dbs);

    const model = dbs.raw
      .prepare('SELECT id FROM models LIMIT 1')
      .get() as any;
    expect(model).toBeTruthy();
    dbs.raw.prepare("UPDATE models SET validation_status='valid' WHERE id=?").run(model.id);

    const team = teams.createTeam({ name: `b8a-ub-${Date.now()}`, type: 'deliberation' });
    teams.addMember(team.id, { model_id: model.id, position: 0 });
    const proj = projects.createProject({
      name: `b8a-ub-${Date.now()}`,
      directory: `/tmp/b8a-ub-${Date.now()}`,
    });
    as.setProjectTeamBinding(proj.id, 'deliberation', team.id);
    expect(as.listProjectTeamBindings(proj.id).some((b) => b.role === 'deliberation')).toBe(true);

    const bound = as.resolveProjectRole(proj.id, 'deliberation');
    expect(bound.source).toBe('project-team-binding');

    as.unbindProjectTeam(proj.id, 'deliberation');
    expect(as.listProjectTeamBindings(proj.id).some((b) => b.role === 'deliberation')).toBe(false);

    // No binding + no override → not team path; may be null or agent default if any
    const after = as.resolveProjectRole(proj.id, 'deliberation');
    if (after != null) {
      expect(after.source).not.toBe('project-team-binding');
      expect(after.source).not.toBe('project-roster-override');
    }

    dbs.close();
  });

  it('rejects invalid role and unknown model_id', () => {
    const t = tempDbPath('helm-b8a-val-');
    cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    const projects = new ProjectService(dbs);
    const proj = projects.createProject({
      name: `b8a-val-${Date.now()}`,
      directory: `/tmp/b8a-val-${Date.now()}`,
    });

    expect(() => as.getEffectiveRoleRoster(proj.id, 'implementer')).toThrow(
      /only deliberation\/red-team/
    );
    expect(() => as.setProjectRoleRoster(proj.id, 'planner', [{ model_id: 1 }])).toThrow();
    expect(() =>
      as.setProjectRoleRoster(proj.id, 'deliberation', [{ model_id: 99999999 }])
    ).toThrow(/unknown model_id/);
    expect(() => as.unbindProjectTeam(proj.id, 'implementer')).toThrow(
      /only deliberation\/red-team/
    );

    dbs.close();
  });
});
