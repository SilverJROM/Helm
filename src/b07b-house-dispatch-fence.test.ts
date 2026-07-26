/**
 * B07b — R2.7 house dispatch fence:
 * house-kind agents must NOT be assignable / dispatchable into a project run;
 * project-kind agents remain ok. No B07c registry-edit fence.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import {
  AgentAssignmentService,
  assertProjectRunDispatchable,
} from './services/agent-assignment-service.js';
import { ProjectAgentService } from './services/project-agent-service.js';

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

const HOUSE_DENY = /house-kind agent cannot be dispatched into a project run/i;

describe('B07b house dispatch fence', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  function setup() {
    const t = tempDbPath('helm-b07b-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    const pas = new ProjectAgentService(dbs, as);

    dbs.raw.prepare('INSERT INTO projects (name, directory) VALUES (?,?)').run('b07b-proj', '/tmp/b07b-proj');
    const pid = (dbs.raw.prepare("SELECT id FROM projects WHERE name='b07b-proj'").get() as any).id as number;

    const projectAgent = as.createAgent({
      name: `b07b-project-${Math.random().toString(36).slice(2, 8)}`,
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      kind: 'project',
    });
    const houseAgent = as.createAgent({
      name: `b07b-house-${Math.random().toString(36).slice(2, 8)}`,
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      kind: 'house',
    });

    return { dbs, as, pas, pid, projectAgent, houseAgent };
  }

  it('assertProjectRunDispatchable: house throws, project ok', () => {
    expect(() => assertProjectRunDispatchable({ id: 1, name: 'h', kind: 'house' })).toThrow(HOUSE_DENY);
    expect(() => assertProjectRunDispatchable({ id: 2, name: 'p', kind: 'project' })).not.toThrow();
    expect(() => assertProjectRunDispatchable({ id: 3, name: 'legacy', agent_type: 'helm' })).toThrow(HOUSE_DENY);
  });

  it('setProjectBinding / setRoleBindings: project-kind ok; house denied (no row written)', () => {
    const { dbs, as, pid, projectAgent, houseAgent } = setup();

    const ok = as.setProjectBinding(pid, 'implementer', projectAgent.id);
    expect(ok.agent_id).toBe(projectAgent.id);
    expect(ok.agent.kind).toBe('project');

    expect(() => as.setProjectBinding(pid, 'validator', houseAgent.id)).toThrow(HOUSE_DENY);
    const valBind = as.getProjectBinding(pid, 'validator');
    expect(valBind).toBeNull();

    expect(() => as.setRoleBindings(pid, 'panelist', [houseAgent.id])).toThrow(HOUSE_DENY);
    const panelRows = dbs.raw
      .prepare("SELECT COUNT(*) as c FROM role_bindings WHERE project_id=? AND role='panelist'")
      .get(pid) as any;
    expect(panelRows.c).toBe(0);

    // batch with mixed ids: house in list must reject entire write (no partial)
    expect(() => as.setRoleBindings(pid, 'red-team', [projectAgent.id, houseAgent.id])).toThrow(HOUSE_DENY);
    const redRows = dbs.raw
      .prepare("SELECT COUNT(*) as c FROM role_bindings WHERE project_id=? AND role='red-team'")
      .get(pid) as any;
    expect(redRows.c).toBe(0);

    dbs.close();
  });

  it('setRoleDefault: project-kind ok; house denied', () => {
    const { dbs, as, projectAgent, houseAgent } = setup();

    const def = as.setRoleDefault('implementer', projectAgent.id);
    expect(def.agent_id).toBe(projectAgent.id);
    expect(def.agent.kind).toBe('project');

    expect(() => as.setRoleDefault('validator', houseAgent.id)).toThrow(HOUSE_DENY);
    const valDef = as.listRoleDefaults().find((d) => d.role === 'validator');
    // either no default or not house
    if (valDef) expect(valDef.agent.kind).not.toBe('house');

    dbs.close();
  });

  it('ProjectAgentService.addAgent: project-kind ok; house denied', () => {
    const { dbs, pas, pid, projectAgent, houseAgent } = setup();

    pas.addAgent(pid, projectAgent.id);
    const row = dbs.raw
      .prepare('SELECT agent_id FROM project_agents WHERE project_id=? AND agent_id=?')
      .get(pid, projectAgent.id) as any;
    expect(row).toBeTruthy();

    expect(() => pas.addAgent(pid, houseAgent.id)).toThrow(HOUSE_DENY);
    const houseRow = dbs.raw
      .prepare('SELECT agent_id FROM project_agents WHERE project_id=? AND agent_id=?')
      .get(pid, houseAgent.id) as any;
    expect(houseRow).toBeFalsy();

    dbs.close();
  });

  it('resolveProjectRole: project binding dispatchable; house binding fail-closed at resolve', () => {
    const { dbs, as, pid, projectAgent, houseAgent } = setup();

    as.setProjectBinding(pid, 'implementer', projectAgent.id);
    const resolved = as.resolveProjectRole(pid, 'implementer');
    expect(resolved).toBeTruthy();
    expect(resolved.agent.kind).toBe('project');
    expect(resolved.agent.id).toBe(projectAgent.id);

    // Bypass setRoleBindings fence with raw INSERT to prove resolve-time fail-closed.
    dbs.raw
      .prepare("INSERT INTO role_bindings (project_id, role, agent_id) VALUES (?,?,?)")
      .run(pid, 'validator', houseAgent.id);
    expect(() => as.resolveProjectRole(pid, 'validator')).toThrow(HOUSE_DENY);

    dbs.close();
  });

  it('seeded house stubs (agent-master/jkage/overseer) cannot enter project run paths', () => {
    const { dbs, as, pas, pid } = setup();
    for (const name of ['agent-master', 'jkage', 'overseer']) {
      const a = as.listAgents().find((x) => x.name === name);
      expect(a, name).toBeTruthy();
      expect(a!.kind).toBe('house');
      expect(() => as.setProjectBinding(pid, 'implementer', a!.id)).toThrow(HOUSE_DENY);
      expect(() => pas.addAgent(pid, a!.id)).toThrow(HOUSE_DENY);
    }
    dbs.close();
  });

  it('addAllAgents: project-kind enters roster; house + seeded house stubs excluded', () => {
    const { dbs, as, pas, pid, projectAgent, houseAgent } = setup();

    pas.addAllAgents(pid);

    const rosterIds = (
      dbs.raw.prepare('SELECT agent_id FROM project_agents WHERE project_id=?').all(pid) as any[]
    ).map((r) => Number(r.agent_id));

    expect(rosterIds).toContain(projectAgent.id);
    expect(rosterIds).not.toContain(houseAgent.id);

    for (const name of ['agent-master', 'jkage', 'overseer']) {
      const a = as.listAgents().find((x) => x.name === name);
      expect(a, name).toBeTruthy();
      expect(a!.kind).toBe('house');
      expect(rosterIds).not.toContain(a!.id);
    }

    // Idempotent re-run still excludes house
    pas.addAllAgents(pid);
    const after = (
      dbs.raw.prepare('SELECT agent_id FROM project_agents WHERE project_id=?').all(pid) as any[]
    ).map((r) => Number(r.agent_id));
    expect(after).not.toContain(houseAgent.id);

    dbs.close();
  });

  it('resolveProjectRoleBindings: legacy house panelist binding fail-closed at resolve', () => {
    const { dbs, as, pid, projectAgent, houseAgent } = setup();

    // Project-kind panelist is fine
    as.setRoleBindings(pid, 'panelist', [projectAgent.id]);
    const ok = as.resolveProjectRoleBindings(pid, ['panelist']);
    expect(ok).toHaveLength(1);
    expect(ok[0].agent.kind).toBe('project');
    expect(ok[0].agent_id).toBe(projectAgent.id);

    // Clear and raw-insert house as panelist (legacy pre-B07b / helm backfill row)
    dbs.raw.prepare("DELETE FROM role_bindings WHERE project_id=? AND role='panelist'").run(pid);
    dbs.raw
      .prepare("INSERT INTO role_bindings (project_id, role, agent_id) VALUES (?,?,?)")
      .run(pid, 'panelist', houseAgent.id);

    expect(() => as.resolveProjectRoleBindings(pid, ['panelist'])).toThrow(HOUSE_DENY);
    // Multi-role resolve used by run-orchestrator red-team else branch also fails closed
    expect(() => as.resolveProjectRoleBindings(pid, ['red-team', 'panelist'])).toThrow(HOUSE_DENY);

    dbs.close();
  });
});
