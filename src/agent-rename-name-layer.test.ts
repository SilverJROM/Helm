/**
 * NAME-LAYER agent rename (2026-07-16): north → discovery, projcore → plancore.
 * Stage 7 final state: the renamed agents resolve through the final plancore/ibrain role vocabulary,
 * the shared worker face remains intact, and the v87 name migration still preserves agent ids.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION } from './db/schema.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { workerFaceRole, normalizeRole, roleMatches, WORKER_FACE_ROLE } from './services/role-alias.js';

function tempDb(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dbPath: path.join(dir, `helm-${process.pid}.db`),
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

describe('name-layer agent rename and v90 role deletion', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  it('fresh DB seeds the renamed names; old agent names are gone', () => {
    const t = tempDb('helm-rename-fresh-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const db = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(db);
    const names = new Set(as.listAgents().map((a) => a.name));

    expect(names.has('discovery')).toBe(true);
    expect(names.has('plancore')).toBe(true);
    expect(names.has('north')).toBe(false);
    expect(names.has('projcore')).toBe(false);
    db.close();
  });

  it('plancore resolves canonically while both phase brains retain the shared helm_pm face', () => {
    const t = tempDb('helm-rename-role-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const db = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(db);

    const rd = as.listRoleDefaults().find((d) => d.role === 'plancore')!;
    expect(rd).toBeTruthy();
    expect(rd.agent.name).toBe('plancore');

    const resolved = as.resolveProjectRole(999999, 'plancore');
    expect(resolved).toBeTruthy();
    expect(resolved!.agent.name).toBe('plancore');

    expect(resolved!.agent.definition_md).toContain('# plancore — planning brain');
    expect(resolved!.agent.definition_md).not.toContain('escalation_authority: true');
    expect(as.listAgents().find((agent) => agent.name === 'ibrain')!.definition_md)
      .toContain('escalation_authority: true');

    expect(WORKER_FACE_ROLE.plancore).toBe('helm_pm');
    expect(WORKER_FACE_ROLE.ibrain).toBe('helm_pm');
    expect(workerFaceRole('plancore')).toBe('helm_pm');
    expect(workerFaceRole('ibrain')).toBe('helm_pm');
    expect(workerFaceRole('discovery')).toBe('discovery');
    expect(normalizeRole('helm_pm')).toBe('helm_pm');
    expect(roleMatches('plancore', 'helm_pm')).toBe(true);
    expect(roleMatches('ibrain', 'helm_pm')).toBe(true);
    expect(roleMatches('discovery', 'discovery')).toBe(true);
    expect(roleMatches('discovery', 'helm_pm')).toBe(false);
    db.close();
  });

  it('idempotent v87 migration renames existing DB rows and preserves the role_defaults binding (by id)', () => {
    const t = tempDb('helm-rename-mig-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    // Build a realistic pre-rename live DB: open fresh (schema complete), then roll the two agents back
    // to their OLD names and drop schema_version to 86, exactly as a live DB would look pre-migration.
    // Also bind the old-named planning agent into a project so we prove the Studio project-scoped
    // data path picks up the new name too (backfill covers ALL projects, not just one).
    const seed = new DatabaseService(t.dbPath);
    seed.raw.prepare("UPDATE agents SET name='projcore' WHERE name='plancore'").run();
    seed.raw.prepare("UPDATE agents SET name='north' WHERE name='discovery'").run();
    const preId = (seed.raw.prepare("SELECT id FROM agents WHERE name='projcore'").get() as { id: number }).id;
    const pid = (
      seed.raw.prepare('INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id').get('rename-proj', '/tmp/rename-proj') as { id: number }
    ).id;
    seed.raw.prepare('INSERT INTO project_agents (project_id, agent_id) VALUES (?, ?)').run(pid, preId);
    seed.raw.prepare('UPDATE schema_version SET version=86').run();
    const rdPre = seed.raw.prepare("SELECT agent_id FROM role_defaults WHERE role='plancore'").get() as { agent_id: number };
    expect(rdPre.agent_id).toBe(preId);
    seed.close();

    // Reopen → runs the v87 migration.
    const migrated = new DatabaseService(t.dbPath);
    expect((migrated.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(SCHEMA_VERSION);
    const as = new AgentAssignmentService(migrated);

    // Agent Studio data path (GET /api/agents → listAgents): zero north/projcore, has discovery/plancore.
    const studioNames = as.listAgents().map((a) => a.name);
    expect(studioNames).not.toContain('north');
    expect(studioNames).not.toContain('projcore');
    expect(studioNames).toContain('discovery');
    expect(studioNames).toContain('plancore');

    const byName = new Map(as.listAgents().map((a) => [a.name, a]));
    // agent_id unchanged → the plancore role default still binds to the SAME row.
    expect(byName.get('plancore')!.id).toBe(preId);
    const rdPost = as.listRoleDefaults().find((d) => d.role === 'plancore')!;
    expect(rdPost.agent.name).toBe('plancore');
    expect(rdPost.agent_id).toBe(preId);

    // Project-scoped Studio view (per-agent Identity/Models tabs read resolveProjectAgent) yields the new name.
    const eff = as.resolveProjectAgent(pid, preId)!;
    expect(eff.agent.name).toBe('plancore');
    // House scope is covered by the same global rename (agents table is not project-scoped): the canonical
    // house agents are untouched and still present.
    expect(studioNames).toContain('agent-master');
    migrated.close();

    // Idempotent: reopening again is a safe no-op (already at SCHEMA_VERSION, names stable).
    const again = new DatabaseService(t.dbPath);
    const asAgain = new AgentAssignmentService(again);
    const namesAgain = new Set(asAgain.listAgents().map((a) => a.name));
    expect(namesAgain.has('plancore')).toBe(true);
    expect(namesAgain.has('discovery')).toBe(true);
    expect(namesAgain.has('projcore')).toBe(false);
    again.close();
  });

  it('F4: a v86 DB holding BOTH name pairs fails the migration loudly WITHOUT advancing the version (no split)', () => {
    const t = tempDb('helm-rename-collide-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    // Build a pathological both-pairs DB: fresh (has discovery+plancore), then INSERT the OLD names too so
    // all four coexist, and drop the version to 86 so the v87 migration runs on the next open.
    const seed = new DatabaseService(t.dbPath);
    seed.raw.prepare(
      "INSERT INTO agents (name, provider, model, agent_type) VALUES ('north','claude','claude-opus-4-8','project')"
    ).run();
    seed.raw.prepare(
      "INSERT INTO agents (name, provider, model, agent_type) VALUES ('projcore','claude','claude-opus-4-8','project')"
    ).run();
    seed.raw.prepare('UPDATE schema_version SET version=86').run();
    seed.close();

    // Reopen → the v87 migration must throw (collision) and roll back.
    expect(() => new DatabaseService(t.dbPath)).toThrow(/collision/i);

    // Inspect via a raw connection: schema version is STILL 86 (rolled back, not advanced), and ALL FOUR
    // names remain present (no partial rename, no silent binding move).
    const raw = new Database(t.dbPath);
    try {
      expect((raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(86);
      const names = new Set(
        (raw.prepare('SELECT name FROM agents').all() as Array<{ name: string }>).map((r) => r.name)
      );
      expect(names.has('north')).toBe(true);
      expect(names.has('discovery')).toBe(true);
      expect(names.has('projcore')).toBe(true);
      expect(names.has('plancore')).toBe(true);
    } finally {
      raw.close();
    }
  });
});
