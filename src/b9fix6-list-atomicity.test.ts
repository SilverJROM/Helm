import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import { DatabaseService } from './db/database.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { ProjectAgentService } from './services/project-agent-service.js';
import { ProjectService } from './services/project-service.js';
import { createRequireOwner } from './auth/auth-middleware.js';
import { createRequireLocalLaunch } from './guardrails.js';
import { registerProjectAgentRoutes } from './api/routes/project-agent-routes.js';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b9fix6-'));
  const dbPath = path.join(dir, 'test.db');
  return { dbPath, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function ownerAuth(req: any, _reply: any, done?: () => void) {
  req.user = { role: 'owner' };
  done?.();
}

describe('B9fix6 lean list + atomic PUT (G1/G2)', () => {
  let cleanup: () => void;
  let dbs: DatabaseService;
  let assignment: AgentAssignmentService;
  let pas: ProjectAgentService;
  let pid: number;
  let aid: number;
  let modelId: number;
  const studioDefinition = '# Studio persona\nSTUDIO-B9FIX6\n' + 'x'.repeat(40_000);
  const projectDefinition = '# Project persona\nPROJECT-B9FIX6\n' + 'y'.repeat(40_000);

  beforeEach(() => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    assignment = new AgentAssignmentService(dbs);
    pas = new ProjectAgentService(dbs, assignment);

    dbs.raw.prepare("INSERT INTO agents (name, provider, model, default_effort, definition_md) VALUES (?,?,?,?,?)")
      .run('b9fix6-agent', 'claude', 'claude-opus-4-8', 'medium', studioDefinition);
    dbs.raw.prepare("INSERT INTO models (name, provider, model_id, cli, slug, display_name, effort) VALUES (?,?,?,?,?,?,?)")
      .run('b9fix6-model', 'claude', 'claude-sonnet-4-6', 'claude', 'b9fix6-model', 'b9fix6-model', 'medium');
    aid = (dbs.raw.prepare("SELECT id FROM agents WHERE name='b9fix6-agent'").get() as any).id;
    modelId = (dbs.raw.prepare("SELECT id FROM models WHERE name='b9fix6-model'").get() as any).id;
    dbs.raw.prepare("INSERT INTO projects (name, directory) VALUES (?,?)").run('B9fix6-proj', '/tmp/b9fix6');
    pid = (dbs.raw.prepare("SELECT id FROM projects WHERE name='B9fix6-proj'").get() as any).id;
    pas.addAgent(pid, aid);
    pas.setScalarOverrides(pid, aid, { definition_md_override: projectDefinition });
  });

  afterEach(() => cleanup());

  it('G1: list response omits persona text and avoids per-row resolveProjectAgent', () => {
    const resolveSpy = vi.spyOn(assignment, 'resolveProjectAgent');
    let prepareCalls = 0;
    const origPrepare = dbs.prepare.bind(dbs);
    vi.spyOn(dbs, 'prepare').mockImplementation((sql: string) => {
      prepareCalls++;
      return origPrepare(sql);
    });

    const row = pas.listProjectAgents(pid)[0];
    const serialized = JSON.stringify(row);

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(prepareCalls).toBe(1);
    expect(serialized.includes(studioDefinition)).toBe(false);
    expect(serialized.includes(projectDefinition)).toBe(false);
    expect('definition_md' in row.effective).toBe(false);
    expect(row.has_persona_override).toBe(true);
    expect(row.effective.effort).toBe('medium');

    resolveSpy.mockRestore();
  });

  it('G1: detail endpoint returns full effective persona', () => {
    const effective = assignment.resolveProjectAgent(pid, aid);
    expect(effective?.definition_md).toBe(projectDefinition);
    expect((effective?.toolkits || []).length).toBeGreaterThanOrEqual(0);
  });

  it('G2: multi-field PUT rolls back when a later setter throws', () => {
    const before = dbs.raw.prepare('SELECT model_id, backup_model_id, effort_override FROM project_agents WHERE project_id = ? AND agent_id = ?')
      .get(pid, aid) as any;
    expect(before.model_id).toBeNull();

    expect(() => pas.applyAgentOverrides(pid, aid, {
      model_id: modelId,
      backup_model_id: 999_999
    })).toThrow(/unknown model/);

    const after = dbs.raw.prepare('SELECT model_id, backup_model_id, effort_override FROM project_agents WHERE project_id = ? AND agent_id = ?')
      .get(pid, aid) as any;
    expect(after.model_id).toBeNull();
    expect(after.backup_model_id).toBe(before.backup_model_id);
  });

  it('G2: multi-field PUT applies atomically on success', () => {
    pas.applyAgentOverrides(pid, aid, {
      model_id: modelId,
      effort_override: 'high',
      is_primary_driver: true
    });
    const row = dbs.raw.prepare('SELECT model_id, effort_override, is_primary_driver FROM project_agents WHERE project_id = ? AND agent_id = ?')
      .get(pid, aid) as any;
    expect(row.model_id).toBe(modelId);
    expect(row.effort_override).toBe('high');
    expect(row.is_primary_driver).toBe(1);
  });
});

describe('B9fix6 detail API route', () => {
  let cleanup: () => void;
  let app: Fastify.FastifyInstance;
  let pid: number;
  let aid: number;

  beforeEach(async () => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    const dbs = new DatabaseService(t.dbPath);
    const projectService = new ProjectService(dbs);
    const assignmentService = new AgentAssignmentService(dbs);
    const projectAgentService = new ProjectAgentService(dbs, assignmentService);

    dbs.raw.prepare("INSERT INTO agents (name, provider, model, default_effort, definition_md) VALUES (?,?,?,?,?)")
      .run('b9fix6-api-agent', 'claude', 'claude-opus-4-8', 'medium', '# Studio\nAPI');
    aid = (dbs.raw.prepare("SELECT id FROM agents WHERE name='b9fix6-api-agent'").get() as any).id;
    dbs.raw.prepare("INSERT INTO projects (name, directory) VALUES (?,?)").run('B9fix6-api', '/tmp/b9fix6-api');
    pid = (dbs.raw.prepare("SELECT id FROM projects WHERE name='B9fix6-api'").get() as any).id;
    projectAgentService.addAgent(pid, aid);

    app = Fastify({ logger: false });
    registerProjectAgentRoutes(app, {
      projectService,
      projectAgentService,
      assignmentService,
      authMiddleware: ownerAuth,
      requireOwnerPre: createRequireOwner(),
      requireLocalLaunchPre: createRequireLocalLaunch()
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    cleanup();
  });

  it('GET /api/projects/:id/agents/:agentId returns full effective', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/agents/${aid}`,
      remoteAddress: '127.0.0.1'
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().effective.definition_md).toBe('# Studio\nAPI');
    expect(res.json().effective.agent.name).toBe('b9fix6-api-agent');
  });
});