/**
 * B07c — R2.7 registry-edit fence:
 * project surfaces cannot edit house/registry agent definitions;
 * studio/house ops remain allowed. No re-open of B07b.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import {
  AgentAssignmentService,
  assertRegistryEditable,
} from './services/agent-assignment-service.js';
import { ProjectAgentService } from './services/project-agent-service.js';

const STUDIO = { surface: 'studio' as const };

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

const REGISTRY_DENY = /project surface cannot edit house\/registry agent definitions/i;

describe('B07c registry-edit fence', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  function setup() {
    const t = tempDbPath('helm-b07c-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    const pas = new ProjectAgentService(dbs, as);

    dbs.raw.prepare('INSERT INTO projects (name, directory) VALUES (?,?)').run('b07c-proj', '/tmp/b07c-proj');
    const pid = (dbs.raw.prepare("SELECT id FROM projects WHERE name='b07c-proj'").get() as any).id as number;

    const projectAgent = as.createAgent({
      name: `b07c-project-${Math.random().toString(36).slice(2, 8)}`,
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      kind: 'project',
      definition_md: '# project original',
    }, STUDIO);
    const houseAgent = as.createAgent({
      name: `b07c-house-${Math.random().toString(36).slice(2, 8)}`,
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      kind: 'house',
      definition_md: '# house original',
    }, STUDIO);

    return { dbs, as, pas, pid, projectAgent, houseAgent };
  }

  it('assertRegistryEditable: project surface denies house; studio allows; project-kind ok', () => {
    expect(() =>
      assertRegistryEditable({ id: 1, name: 'h', kind: 'house' }, 'project')
    ).toThrow(REGISTRY_DENY);
    expect(() =>
      assertRegistryEditable({ id: 1, name: 'h', agent_type: 'helm' }, 'project')
    ).toThrow(REGISTRY_DENY);
    expect(() =>
      assertRegistryEditable({ id: 1, name: 'h', kind: 'house' }, 'studio')
    ).not.toThrow();
    expect(() =>
      assertRegistryEditable({ id: 2, name: 'p', kind: 'project' }, 'project')
    ).not.toThrow();
  });

  it('updateAgent/deleteAgent/createAgent: project surface denies house; studio allows', () => {
    const { dbs, as, houseAgent, projectAgent } = setup();

    // Studio (default) can edit house registry defs
    const studioUpd = as.updateAgent(houseAgent.id, { definition_md: '# house studio edit' }, STUDIO);
    expect(studioUpd.definition_md).toBe('# house studio edit');
    expect(studioUpd.kind).toBe('house');

    // Project surface cannot edit house registry
    expect(() =>
      as.updateAgent(houseAgent.id, { definition_md: '# project write' }, { surface: 'project' })
    ).toThrow(REGISTRY_DENY);
    const afterDeny = as.getAgent(houseAgent.id);
    expect(afterDeny?.definition_md).toBe('# house studio edit');

    // Project surface cannot delete house
    expect(() => as.deleteAgent(houseAgent.id, { surface: 'project' })).toThrow(REGISTRY_DENY);
    expect(as.getAgent(houseAgent.id)).toBeTruthy();

    // Project surface cannot create house
    expect(() =>
      as.createAgent(
        {
          name: `b07c-house-create-${Math.random().toString(36).slice(2, 6)}`,
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          kind: 'house',
        },
        { surface: 'project' }
      )
    ).toThrow(REGISTRY_DENY);

    // Project surface cannot promote project → house
    expect(() =>
      as.updateAgent(projectAgent.id, { kind: 'house' }, { surface: 'project' })
    ).toThrow(REGISTRY_DENY);
    expect(as.getAgent(projectAgent.id)?.kind).toBe('project');

    // Prompt identity is Studio-only even for project-kind agents.
    expect(() => as.updateAgent(
      projectAgent.id,
      { definition_md: '# project surface attempt' },
      { surface: 'project' }
    )).toThrow(/Studio-authorized surface/i);
    expect(as.getAgent(projectAgent.id)?.definition_md).toBe('# project original');

    // Studio can still create house
    const h2 = as.createAgent({
      name: `b07c-house-ok-${Math.random().toString(36).slice(2, 6)}`,
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      kind: 'house',
    }, STUDIO);
    expect(h2.kind).toBe('house');
    as.deleteAgent(h2.id); // studio delete unbound house ok

    dbs.close();
  });

  it('setAgentEscalations: project surface denies house; studio allows', () => {
    const { dbs, as, houseAgent } = setup();
    const model = dbs.raw.prepare('SELECT id FROM models LIMIT 1').get() as { id: number } | undefined;
    expect(model?.id).toBeTruthy();

    // studio ok
    const esc = as.setAgentEscalations(houseAgent.id, [
      { position: 1, model_id: model!.id, trigger: 'on-fail' },
    ]);
    expect(esc.length).toBe(1);

    // project surface deny — no change to count when re-set fails
    expect(() =>
      as.setAgentEscalations(
        houseAgent.id,
        [{ position: 1, model_id: model!.id, trigger: 'on-fail' }],
        { surface: 'project' }
      )
    ).toThrow(REGISTRY_DENY);

    dbs.close();
  });

  it('project surface override on project-kind does not write agents.definition_md', () => {
    const { dbs, as, pas, pid, projectAgent } = setup();

    pas.addAgent(pid, projectAgent.id);
    const before = as.getAgent(projectAgent.id)!.definition_md;

    pas.applyAgentOverrides(pid, projectAgent.id, {
      definition_md_override: '# project override only',
    });

    const after = as.getAgent(projectAgent.id)!;
    expect(after.definition_md).toBe(before);
    const pa = dbs.raw
      .prepare('SELECT definition_md_override FROM project_agents WHERE project_id=? AND agent_id=?')
      .get(pid, projectAgent.id) as any;
    expect(pa.definition_md_override).toBe('# project override only');

    dbs.close();
  });

  it('project surface mutation denied for house on project_agents (legacy raw insert)', () => {
    const { dbs, as, pas, pid, houseAgent } = setup();

    // Bypass B07b addAgent fence with raw INSERT (legacy path)
    dbs.raw
      .prepare(
        'INSERT INTO project_agents (project_id, agent_id, model_id, use_dynamic, is_primary_driver) VALUES (?,?,NULL,0,0)'
      )
      .run(pid, houseAgent.id);

    const beforeDef = as.getAgent(houseAgent.id)!.definition_md;

    expect(() =>
      pas.applyAgentOverrides(pid, houseAgent.id, {
        definition_md_override: '# should not land',
      })
    ).toThrow(REGISTRY_DENY);

    expect(as.getAgent(houseAgent.id)!.definition_md).toBe(beforeDef);
    const pa = dbs.raw
      .prepare('SELECT definition_md_override FROM project_agents WHERE project_id=? AND agent_id=?')
      .get(pid, houseAgent.id) as any;
    expect(pa.definition_md_override == null || pa.definition_md_override === '').toBe(true);

    dbs.close();
  });

  it('studio house ops still work for seeded house stubs', () => {
    const { dbs, as } = setup();
    for (const name of ['agent-master', 'jkage', 'overseer']) {
      const a = as.listAgents().find((x) => x.name === name);
      expect(a, name).toBeTruthy();
      expect(a!.kind).toBe('house');
      const upd = as.updateAgent(a!.id, { definition_md: a!.definition_md }, STUDIO);
      expect(upd.kind).toBe('house');
      expect(() =>
        as.updateAgent(a!.id, { definition_md: a!.definition_md }, { surface: 'project' })
      ).toThrow(REGISTRY_DENY);
    }
    dbs.close();
  });
});
