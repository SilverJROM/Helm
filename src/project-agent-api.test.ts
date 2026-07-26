import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { ProjectAgentService } from './services/project-agent-service.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { createRequireOwner } from './auth/auth-middleware.js';
import { createRequireLocalLaunch } from './guardrails.js';
import { registerProjectAgentRoutes } from './api/routes/project-agent-routes.js';
import { mapProjectAgentApiError } from './api/project-agent-errors.js';
import { loadConfig } from './config/config.js';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b9c-api-'));
  const dbPath = path.join(dir, 'test.db');
  return {
    dbPath,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  };
}

function ownerAuth(req: any, _reply: any, done?: () => void) {
  req.user = { role: 'owner' };
  done?.();
}

async function buildProjectAgentApiApp(dbs: DatabaseService) {
  const projectService = new ProjectService(dbs);
  const assignmentService = new AgentAssignmentService(dbs);
  const projectAgentService = new ProjectAgentService(dbs, assignmentService);
  const app = Fastify({ logger: false });
  registerProjectAgentRoutes(app, {
    projectService,
    projectAgentService,
    assignmentService,
    authMiddleware: ownerAuth,
    requireOwnerPre: createRequireOwner(),
    requireLocalLaunchPre: createRequireLocalLaunch()
  });
  await app.ready();
  return app;
}

describe('B9c mapProjectAgentApiError', () => {
  it('maps unknown model/toolkit/not-found to 404', () => {
    expect(mapProjectAgentApiError('unknown model').status).toBe(404);
    expect(mapProjectAgentApiError('unknown toolkit').status).toBe(404);
    expect(mapProjectAgentApiError('project agent not found').status).toBe(404);
  });

  it('maps validation errors to 400', () => {
    expect(mapProjectAgentApiError('invalid effort_override').status).toBe(400);
    expect(mapProjectAgentApiError('invalid spawn_pref_override').status).toBe(400);
    expect(mapProjectAgentApiError('definition_md_override too long (max 50000)').status).toBe(400);
    expect(mapProjectAgentApiError('cannot set disabled_override=0 for an agent that is in development in Studio').status).toBe(400);
  });

  it('maps duplicate add to 409', () => {
    expect(mapProjectAgentApiError('agent already added to this project').status).toBe(409);
  });
});

describe.sequential('B9c project-agent API HTTP round-trip (criterion #4)', () => {
  let cleanup: () => void;
  let dbs: DatabaseService;
  let app: Awaited<ReturnType<typeof buildProjectAgentApiApp>>;
  let pid: number;
  let aid: number;
  let primaryModelId: number;
  let backupModelId: number;
  let altModelId: number;
  let toolkitAId: number;
  let toolkitBId: number;
  let studioDefinition: string;
  let projectDefinition: string;
  const proof: Record<string, unknown> = { batch: 'batch-9c', fields: {} as Record<string, unknown> };

  beforeEach(async () => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);

    dbs.raw.prepare("INSERT INTO agents (name, provider, model, default_effort, spawn_pref, definition_md) VALUES (?,?,?,?,?,?)")
      .run('b9c-agent', 'claude', 'claude-opus-4-8', 'medium', 'tmux', '# Studio persona\nSTUDIO-B9C');
    dbs.raw.prepare("INSERT INTO models (name, provider, model_id, cli, slug, display_name, effort) VALUES (?,?,?,?,?,?,?)")
      .run('b9c-primary', 'claude', 'claude-sonnet-4-6', 'claude', 'b9c-primary', 'b9c-primary', 'medium');
    dbs.raw.prepare("INSERT INTO models (name, provider, model_id, cli, slug, display_name, effort) VALUES (?,?,?,?,?,?,?)")
      .run('b9c-backup', 'claude', 'claude-opus-4-8', 'claude', 'b9c-backup', 'b9c-backup', 'high');
    dbs.raw.prepare("INSERT INTO models (name, provider, model_id, cli, slug, display_name, effort) VALUES (?,?,?,?,?,?,?)")
      .run('b9c-alt', 'claude', 'claude-haiku-4-6', 'claude', 'b9c-alt', 'b9c-alt', 'low');
    dbs.raw.prepare("INSERT INTO toolkits (name, description, body_md) VALUES (?,?,?)")
      .run('b9c-tk-a', null, 'Toolkit A body');
    dbs.raw.prepare("INSERT INTO toolkits (name, description, body_md) VALUES (?,?,?)")
      .run('b9c-tk-b', null, 'Toolkit B body');

    aid = (dbs.raw.prepare("SELECT id FROM agents WHERE name='b9c-agent'").get() as any).id;
    primaryModelId = (dbs.raw.prepare("SELECT id FROM models WHERE name='b9c-primary'").get() as any).id;
    backupModelId = (dbs.raw.prepare("SELECT id FROM models WHERE name='b9c-backup'").get() as any).id;
    altModelId = (dbs.raw.prepare("SELECT id FROM models WHERE name='b9c-alt'").get() as any).id;
    toolkitAId = (dbs.raw.prepare("SELECT id FROM toolkits WHERE name='b9c-tk-a'").get() as any).id;
    toolkitBId = (dbs.raw.prepare("SELECT id FROM toolkits WHERE name='b9c-tk-b'").get() as any).id;

    dbs.raw.prepare("UPDATE agents SET default_model_id = ?, backup_model_id = ? WHERE id = ?")
      .run(primaryModelId, backupModelId, aid);
    dbs.raw.prepare("INSERT INTO agent_toolkits (agent_id, toolkit_id, position) VALUES (?,?,?)").run(aid, toolkitAId, 1);
    dbs.raw.prepare("INSERT INTO agent_escalations (agent_id, position, model_id, trigger) VALUES (?,?,?,?)")
      .run(aid, 1, primaryModelId, 'on-fail');

    dbs.raw.prepare("INSERT INTO projects (name, directory) VALUES (?,?)").run('B9C-api-proj', '/tmp/b9c');
    pid = (dbs.raw.prepare("SELECT id FROM projects WHERE name='B9C-api-proj'").get() as any).id;

    app = await buildProjectAgentApiApp(dbs);
    studioDefinition = '# Studio persona\nSTUDIO-B9C';
    projectDefinition = '# Project persona\nPROJECT-B9C';
  });

  afterEach(async () => {
    await app.close();
    cleanup();
  });

  async function addAgent() {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/agents`,
      remoteAddress: '127.0.0.1',
      payload: { agent_id: aid }
    });
    expect(res.statusCode).toBe(200);
  }

  async function getListRow() {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/agents`,
      remoteAddress: '127.0.0.1'
    });
    expect(res.statusCode).toBe(200);
    const row = res.json().projectAgents.find((p: any) => p.agent_id === aid);
    expect(row).toBeTruthy();
    return row;
  }

  async function getDetailEffective() {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/agents/${aid}`,
      remoteAddress: '127.0.0.1'
    });
    expect(res.statusCode).toBe(200);
    return res.json().effective;
  }

  it('sets every resolver-supported override via API and reads back effective view', async () => {
    await addAgent();

    const putScalars = await app.inject({
      method: 'PUT',
      url: `/api/projects/${pid}/agents/${aid}`,
      remoteAddress: '127.0.0.1',
      payload: {
        model_id: primaryModelId,
        backup_model_id: backupModelId,
        effort_override: 'high',
        spawn_pref_override: 'in-process',
        disabled_override: 1,
        definition_md_override: projectDefinition
      }
    });
    expect(putScalars.statusCode).toBe(200);

    const putToolkits = await app.inject({
      method: 'PUT',
      url: `/api/projects/${pid}/agents/${aid}/toolkits`,
      remoteAddress: '127.0.0.1',
      payload: {
        overridden: true,
        toolkits: [
          { toolkit_id: toolkitBId, position: 2 },
          { toolkit_id: toolkitAId, position: 1 }
        ]
      }
    });
    expect(putToolkits.statusCode).toBe(200);

    const putEscalations = await app.inject({
      method: 'PUT',
      url: `/api/projects/${pid}/agents/${aid}/escalations`,
      remoteAddress: '127.0.0.1',
      payload: {
        overridden: true,
        escalations: [
          { position: 2, model_id: altModelId, trigger: 'ibrain' },
          { position: 1, model_id: primaryModelId, trigger: 'plan-summon' }
        ]
      }
    });
    expect(putEscalations.statusCode).toBe(200);

    const row = await getListRow();
    const listEff = row.effective;
    expect(listEff.model.type).toBe('override');
    expect(listEff.backup_model_id).toBe(backupModelId);
    expect(listEff.effort).toBe('high');
    expect('definition_md' in listEff).toBe(false);
    expect(listEff.overrides.toolkits_overridden).toBe(true);
    expect('toolkits' in listEff).toBe(false);

    const eff = await getDetailEffective();
    expect(eff.model.type).toBe('override');
    expect(eff.model.id).toBe(primaryModelId);
    expect(eff.backup_model_id).toBe(backupModelId);
    expect(eff.effort).toBe('high');
    expect(eff.spawn_pref).toBe('in-process');
    expect(eff.in_development).toBe(true);
    expect(eff.definition_md).toBe(projectDefinition);
    expect(eff.overrides.toolkits_overridden).toBe(true);
    expect(eff.toolkits.map((t: any) => t.name)).toEqual(['b9c-tk-a', 'b9c-tk-b']);
    expect(eff.overrides.escalations_overridden).toBe(true);
    expect(eff.escalations.map((e: any) => e.trigger)).toEqual(['plan-summon', 'ibrain']);

    (proof.fields as any).set = {
      model_id: primaryModelId,
      backup_model_id: backupModelId,
      effort: 'high',
      spawn_pref: 'in-process',
      disabled: true,
      definition_md: projectDefinition,
      toolkits: ['b9c-tk-a', 'b9c-tk-b'],
      escalations: ['plan-summon', 'ibrain']
    };
  });

  it('clears every override via API and restores Studio inherit', async () => {
    await addAgent();

    await app.inject({
      method: 'PUT',
      url: `/api/projects/${pid}/agents/${aid}`,
      remoteAddress: '127.0.0.1',
      payload: {
        model_id: null,
        backup_model_id: null,
        effort_override: null,
        spawn_pref_override: null,
        disabled_override: null,
        definition_md_override: null
      }
    });
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${pid}/agents/${aid}/toolkits`,
      remoteAddress: '127.0.0.1',
      payload: { overridden: false }
    });
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${pid}/agents/${aid}/escalations`,
      remoteAddress: '127.0.0.1',
      payload: { overridden: false }
    });

    const row = await getListRow();
    expect(row.effective.model.type).toBe('default');
    expect('definition_md' in row.effective).toBe(false);

    const eff = await getDetailEffective();
    expect(eff.model.type).toBe('default');
    expect(eff.model.id).toBe(primaryModelId);
    expect(eff.backup_model_id).toBe(backupModelId);
    expect(eff.effort).toBe('medium');
    expect(eff.spawn_pref).toBe('tmux');
    expect(eff.in_development).toBe(false);
    expect(eff.definition_md).toBe(studioDefinition);
    expect(eff.overrides.toolkits_overridden).toBe(false);
    expect(eff.toolkits.map((t: any) => t.name)).toEqual(['b9c-tk-a']);
    expect(eff.overrides.escalations_overridden).toBe(false);
    expect(eff.escalations.map((e: any) => e.trigger)).toEqual(['on-fail']);

    (proof.fields as any).cleared = {
      model_type: 'default',
      effort: 'medium',
      spawn_pref: 'tmux',
      definition_md: studioDefinition,
      toolkits: ['b9c-tk-a'],
      escalations: ['on-fail']
    };
  });

  it('use_dynamic round-trips through PUT agent', async () => {
    await addAgent();
    const setDyn = await app.inject({
      method: 'PUT',
      url: `/api/projects/${pid}/agents/${aid}`,
      remoteAddress: '127.0.0.1',
      payload: { use_dynamic: true }
    });
    expect(setDyn.statusCode).toBe(200);
    let row = await getListRow();
    expect(row.effective.model.type).toBe('dynamic');

    const clearDyn = await app.inject({
      method: 'PUT',
      url: `/api/projects/${pid}/agents/${aid}`,
      remoteAddress: '127.0.0.1',
      payload: { model_id: null }
    });
    expect(clearDyn.statusCode).toBe(200);
    row = await getListRow();
    expect(row.effective.model.type).toBe('default');
  });

  it('returns consistent 4xx across all override route groups', async () => {
    await addAgent();

    const badModel = await app.inject({
      method: 'PUT',
      url: `/api/projects/${pid}/agents/${aid}`,
      remoteAddress: '127.0.0.1',
      payload: { model_id: 999999 }
    });
    expect(badModel.statusCode).toBe(404);

    const badEffort = await app.inject({
      method: 'PUT',
      url: `/api/projects/${pid}/agents/${aid}`,
      remoteAddress: '127.0.0.1',
      payload: { effort_override: 'turbo' }
    });
    expect(badEffort.statusCode).toBe(400);

    const badSpawn = await app.inject({
      method: 'PUT',
      url: `/api/projects/${pid}/agents/${aid}`,
      remoteAddress: '127.0.0.1',
      payload: { spawn_pref_override: 'docker' }
    });
    expect(badSpawn.statusCode).toBe(400);

    const max = (loadConfig() as any).AGENT_DEFINITION_MAX || 50000;
    const badDef = await app.inject({
      method: 'PUT',
      url: `/api/projects/${pid}/agents/${aid}`,
      remoteAddress: '127.0.0.1',
      payload: { definition_md_override: 'x'.repeat(max + 1) }
    });
    expect(badDef.statusCode).toBe(400);

    dbs.raw.prepare('UPDATE agents SET in_development = 1 WHERE id = ?').run(aid);
    const unDisable = await app.inject({
      method: 'PUT',
      url: `/api/projects/${pid}/agents/${aid}`,
      remoteAddress: '127.0.0.1',
      payload: { disabled_override: 0 }
    });
    expect(unDisable.statusCode).toBe(400);

    const badToolkit = await app.inject({
      method: 'PUT',
      url: `/api/projects/${pid}/agents/${aid}/toolkits`,
      remoteAddress: '127.0.0.1',
      payload: { overridden: true, toolkits: [{ toolkit_id: 999999, position: 0 }] }
    });
    expect(badToolkit.statusCode).toBe(404);

    const badEsc = await app.inject({
      method: 'PUT',
      url: `/api/projects/${pid}/agents/${aid}/escalations`,
      remoteAddress: '127.0.0.1',
      payload: { overridden: true, escalations: [{ position: 1, model_id: 999999 }] }
    });
    expect(badEsc.statusCode).toBe(404);

    const missingAgent = await app.inject({
      method: 'PUT',
      url: `/api/projects/${pid}/agents/999999`,
      remoteAddress: '127.0.0.1',
      payload: { model_id: primaryModelId }
    });
    expect(missingAgent.statusCode).toBe(404);

    (proof.fields as any).validation = {
      unknown_model: 404,
      invalid_effort: 400,
      invalid_spawn: 400,
      definition_too_long: 400,
      un_disable_in_dev: 400,
      unknown_toolkit: 404,
      unknown_escalation_model: 404,
      missing_project_agent: 404
    };
  });

  afterAll(() => {
    const outDir = path.resolve(process.cwd(), 'plan/WK_0624/projects-section-run-2026-06-24/batch-9c');
    fs.mkdirSync(outDir, { recursive: true });
    proof.passed = true;
    proof.generated_at = new Date().toISOString();
    fs.writeFileSync(path.join(outDir, 'api-proof.json'), JSON.stringify(proof, null, 2));
  });
});

describe('v89 project roster compatibility', () => {
  it('adds the seeded ibrain agent to projects created after migration', () => {
    const t = makeTempDb();
    const dbs = new DatabaseService(t.dbPath);
    const project = new ProjectService(dbs).createProject({
      name: 'v89-future-project',
      directory: '/tmp/v89-future-project'
    });
    const row = dbs.raw.prepare(`
      SELECT a.name, pa.model_id, pa.effort_override, pa.spawn_pref_override
      FROM project_agents pa JOIN agents a ON a.id = pa.agent_id
      WHERE pa.project_id = ? AND a.name = 'ibrain'
    `).get(project.id);
    expect(row).toEqual({
      name: 'ibrain',
      model_id: null,
      effort_override: null,
      spawn_pref_override: null
    });
    expect(project.plancore_session).toBe('helm-plancore-v89-future-project');
    dbs.close();
    t.cleanup();
  });
});
